import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { emit, runContext } from "./bus.js";
import { CHARTER, cfg } from "../config.js";
import db, { ensureColumn } from "./store.js";
// No cycle: desk-policy reaches only store, bus and canonical, never back into llm.
import { withPolicy } from "../desk-policy.js";

db.exec(`
CREATE TABLE IF NOT EXISTS llm_spend (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  floor    INTEGER,
  floor_attributed INTEGER NOT NULL DEFAULT 0,
  evidence_scope TEXT NOT NULL DEFAULT 'unattributed',
  seat     TEXT, model TEXT, effort TEXT,
  in_tok   INTEGER, out_tok INTEGER, cached_tok INTEGER,
  usd      REAL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_ts ON llm_spend(ts);
`);

/**
 * WHERE THE MONEY ACTUALLY GOES, per seat.
 *
 * The desk records every model call's seat, model, effort and cost, and nothing has ever
 * read it back. "Make it cheaper" without this is guesswork — and guesswork here means
 * cutting the seat that is cheap and load-bearing while leaving the one that is 44% of
 * the bill untouched. Aggregate only: no prompt text, no evidence, no wallet.
 */
export function spendBySeat({ hours = 24 } = {}) {
  const since = Date.now() - Math.max(1, Number(hours) || 24) * 3600e3;
  const rows = db.prepare(`
    SELECT seat, model, effort,
           COUNT(*) AS calls,
           SUM(usd) AS usd,
           SUM(in_tok) AS inTok,
           SUM(out_tok) AS outTok,
           SUM(cached_tok) AS cachedTok
    FROM llm_spend WHERE ts >= ?
    GROUP BY seat, model, effort
    ORDER BY usd DESC`).all(since);
  const total = rows.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  const workups = db.prepare(
    "SELECT COUNT(DISTINCT ts / 600000) n FROM llm_spend WHERE ts >= ?").get(since)?.n ?? 0;
  return {
    hours, sinceMs: since,
    totalUsd: Number(total.toFixed(4)),
    seats: rows.map((r) => ({
      seat: r.seat, model: r.model, effort: r.effort,
      calls: r.calls,
      usd: Number((Number(r.usd) || 0).toFixed(4)),
      pctOfTotal: total > 0 ? Number(((Number(r.usd) || 0) / total * 100).toFixed(1)) : 0,
      usdPerCall: r.calls > 0 ? Number(((Number(r.usd) || 0) / r.calls).toFixed(4)) : 0,
      inTok: r.inTok, outTok: r.outTok, cachedTok: r.cachedTok,
      // A seat whose input dwarfs its output is paying to READ; one whose output
      // dominates is paying to THINK. They are cut in completely different ways.
      shape: (r.outTok || 0) > (r.inTok || 0) / 4 ? "thinking" : "reading",
    })),
    tenMinuteBuckets: workups,
  };
}

ensureColumn("llm_spend", "floor", "INTEGER");
// Existing nulls predate floor attribution and may contain tenant spend. Keep them out
// of house-only improvement evidence rather than laundering unknown provenance as HQ.
ensureColumn("llm_spend", "floor_attributed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("llm_spend", "evidence_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_spend_floor_ts
         ON llm_spend(floor_attributed,evidence_scope,floor,ts)`);

/** Billing failures are terminal for a cycle: retrying just burns time. */
export class OutOfCredit extends Error {}

/** The daily cap tripping is handled exactly like an empty balance — every existing
 * OutOfCredit path (halt the cycle, fail the floor run cleanly) already does the
 * right thing, so the brake subclasses it rather than inventing a parallel path. */
export class BudgetExhausted extends OutOfCredit {}

/**
 * THE RESERVE — the publishing lane cannot be starved by the scanning lanes.
 *
 * Measured on the live desk: 160 workups in a day, $20.15 of a $25 cap, and ZERO
 * calls. The cause was not strictness — `call:withheld` never fired once, meaning the
 * desk never reached its publish step at all. It was arithmetic. The fresh scan runs
 * every 5 minutes (288 chances a day to spend) while the full cycle — the ONLY lane
 * carrying the mandate hunt, and so the only lane that reliably publishes — runs four
 * times. The scanner ate the day's budget before the publisher could open its mouth:
 * 33 cycles ended on the budget and 24 halted outright, against 2 that genuinely
 * found nothing in the market.
 *
 * So the cap becomes two caps. Opportunistic lanes (the fresh scan, watch promotion)
 * may spend only up to their share; past that the money is RESERVED and only the
 * cycle may draw on it. A tenant's own floor run is never throttled — they paid
 * 250,000 $CLAUDECO for it, and taking payment for work we then refuse to do is not a
 * budget policy, it is a broken promise.
 */
export const OPPORTUNISTIC_SHARE = Math.min(0.95, Math.max(0.1,
  Number(process.env.DESK_OPPORTUNISTIC_SHARE || 0.55)));

/** Lanes that yield to the reserve. Everything else spends to the full cap. */
const OPPORTUNISTIC = new Set(["fresh", "promote"]);

/**
 * THE PACE — what actually makes a desk run around the clock.
 *
 * A daily cap alone does not produce a 24/7 desk, it produces a desk that works until
 * lunchtime. Left to itself the machine spends as fast as it can find candidates, so a
 * $40 day is gone in a few hours and the next eighteen are silent — which is precisely
 * what happened on the 30th: 163 workups, $22 by mid-afternoon, then nothing.
 *
 * So spending is paced by the HOUR as well as the day. The hourly allowance is the
 * daily cap divided across 24 hours and multiplied by a burst factor, so the desk can
 * still work a cluster of candidates when it finds one, but cannot eat tomorrow
 * morning's budget tonight. Running out of pace is not an error: the cycle ends
 * gracefully, the monitor keeps watching every open position for free, and the next
 * tick picks up where this one stopped.
 *
 * A tenant's paid floor run is exempt. They bought that work and it is not ours to
 * schedule.
 */
export const HOURLY_BURST = Math.max(1, Number(process.env.DESK_HOURLY_BURST || 3));

/** Throws before any tokens are spent if this lane's share of the last 24h is gone. */
export function assertDailyBudget(capUsd, { lane = "cycle" } = {}) {
  if (!capUsd || capUsd <= 0) return;
  const totalSpent = spendSince(Date.now() - 24 * 3600e3).usd;
  const spent = spendSince(Date.now() - 24 * 3600e3,
    { evidenceScope: "house", includeUnattributed: true }).usd;
  const yields = OPPORTUNISTIC.has(lane);
  if (totalSpent >= capUsd) {
    throw new BudgetExhausted(
      `daily provider budget spent: $${totalSpent.toFixed(2)} of $${capUsd} in 24h`);
  }

  // Pace first: it is the brake that keeps the desk alive at 3am, and it binds long
  // before the daily cap does. The tenant's own paid run never waits on it.
  if (lane !== "floor") {
    /* THE FLOOR UNDER THE PACE. A pace tighter than one cycle's own allowance is not
     * a pace, it is a deadlock: the cycle is cut off mid-hunt every single time and
     * can never reach its publish step. That is exactly what shipped — $5/hour
     * against a $10 cycle — and the desk went an hour without completing anything
     * while looking, from outside, like a quiet market.
     *
     * Read from the same env var penthouse.js reads rather than imported from it;
     * llm.js is below penthouse in the graph and must not reach back up. */
    const cycleBudget = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 4);
    const hourCap = Math.max((capUsd / 24) * HOURLY_BURST, cycleBudget * 1.25);
    const spentHour = spendSince(Date.now() - 3600e3,
      { evidenceScope: "house", includeUnattributed: true }).usd;
    if (spentHour >= hourCap) {
      emit("cycle:paced", { lane, spentHourUsd: spentHour, hourCapUsd: Number(hourCap.toFixed(2)),
        dayUsd: spent, capUsd });
      throw new BudgetExhausted(
        `hourly pace reached: $${spentHour.toFixed(2)} of $${hourCap.toFixed(2)} this hour ` +
        `— the desk paces $${capUsd} across the day so it is still working tonight; monitoring continues`);
    }
  }

  // Paid floor work skips pacing and the house reserve, but it cannot spend past the
  // provider-account hard ceiling. The caller's existing failure path handles refunding
  // a run that dies before a model is asked.
  if (lane === "floor") {
    return;
  }

  const laneCap = yields ? capUsd * OPPORTUNISTIC_SHARE : capUsd;
  if (spent >= laneCap) {
    emit("cycle:budget", { usedUsd: spent, capUsd, laneCap: Number(laneCap.toFixed(2)),
      lane, reserved: yields, window: "24h" });
    throw new BudgetExhausted(yields
      ? `the ${lane} lane has spent its share ($${spent.toFixed(2)} of $${laneCap.toFixed(2)}) — ` +
        `the rest of the $${capUsd} day is reserved for the cycle that publishes`
      : `daily budget spent: $${spent.toFixed(2)} of $${capUsd} in 24h — the desk pauses, monitoring continues`);
  }
}

const client = new Anthropic();

// Anthropic list price, USD per 1M tokens. Used only for the desk's own
// running cost meter — it is not billing.
const PRICE = {
  "claude-opus-5":   { in: 5.0,  out: 25.0 },
  "claude-fable-5":  { in: 10.0, out: 50.0 },
  "claude-sonnet-5": { in: 2.0,  out: 10.0 },
  "claude-haiku-4-5":{ in: 1.0,  out: 5.0  },
};

// Reservations use deliberately conservative rates, not the selected model's best
// case. This covers server-side fallback, cache-write premiums, and concurrent seats.
const PROVIDER_RESERVATION_PRICE = {
  // $20/MTok covers the most expensive configured model's 1-hour cache-write
  // rate. This checkout only requests 5-minute cache entries, but reservations
  // are a ceiling, not an estimate.
  anthropic: { in: 20, out: 50, search: 0.01, inputOverhead: 4096,
    serverToolContextTokens: 1_000_000, perSearchContextTokens: 40_000 },
  // Grok 4.6 doubles token rates above its long-context threshold.
  xai: { in: 4, out: 12, search: 0.005, inputOverhead: 2048,
    serverToolContextTokens: 500_000, perSearchContextTokens: 40_000 },
};
let reservedProviderUsd = 0;
let unpersistedProviderUsd = 0;

const rawProviderSpendUsd = (sinceMs) => Number(db.prepare(
  "SELECT COALESCE(SUM(usd),0) usd FROM llm_spend WHERE ts>=?").get(sinceMs)?.usd || 0) +
  unpersistedProviderUsd;

export function noteUnpersistedProviderSpend(usd) {
  unpersistedProviderUsd += Math.max(0, Number(usd) || 0);
}

/** Reserve a worst-case model call before it starts. The synchronous check/increment
 * makes parallel analyst launches atomic within the process, so five calls cannot all
 * observe the same last dollar and overshoot it together. */
export function reserveProviderBudget({ provider = "anthropic", maxTokens = 16000,
  maxSearches = 0, payload = "", capUsd = cfg.dailyBudgetUsd } = {}) {
  if (!(capUsd > 0)) return { usd: 0, release() {} };
  const price = PROVIDER_RESERVATION_PRICE[provider];
  if (!price) throw new Error(`unknown provider budget: ${provider}`);
  let serialized;
  try { serialized = typeof payload === "string" ? payload : JSON.stringify(payload); }
  catch { serialized = String(payload); }
  // One token can never contain less than one source byte, so bytes are a safe upper
  // bound on input tokens; fixed overhead covers request/tool framing not in payload.
  const requestInputCeiling = Buffer.byteLength(serialized || "", "utf8") + price.inputOverhead;
  /* Server-side search results are injected after the request leaves this process, so
   * payload bytes cannot reserve them. This used to reserve a COMPLETE model context —
   * a million tokens, $20.00 — for any call that enabled a tool, whatever it had asked
   * the tool to do. Measured: the narrative seat reserved $20.82 against a real cost of
   * $0.18, a hundred-fold, and on a $200 day a handful of concurrent seats could
   * exhaust the reservation pool and start refusing work the desk had the money for.
   * Those refusals surfaced as "fewer than three analysts returned" — a billing failure
   * wearing a research verdict, 2,532 times in seven days.
   *
   * A ceiling should be generous, not arbitrary. Each search a call is ALLOWED to make
   * can inject a bounded amount of context, so the reservation scales with the number
   * requested and is still capped by the full-context figure for anything unbounded. */
  const toolContextCeiling = maxSearches > 0
    ? Math.min(price.serverToolContextTokens,
      Math.max(price.perSearchContextTokens, maxSearches * price.perSearchContextTokens))
    : 0;
  const inputTokenCeiling = Math.max(requestInputCeiling, toolContextCeiling);
  const outputTokenCeiling = Math.max(1, Math.min(100_000, Number(maxTokens) || 16000));
  const searchCeiling = Math.max(0, Math.min(10_000, Number(maxSearches) || 0));
  const usd = inputTokenCeiling / 1e6 * price.in +
    outputTokenCeiling / 1e6 * price.out + searchCeiling * price.search;
  const spent = rawProviderSpendUsd(Date.now() - 24 * 3600e3);
  if (spent + reservedProviderUsd + usd > capUsd) {
    throw new BudgetExhausted(
      `metered provider ceiling: $${spent.toFixed(2)} spent + $${reservedProviderUsd.toFixed(2)} reserved; ` +
      `next call needs up to $${usd.toFixed(2)} of the $${capUsd.toFixed(2)} limit`);
  }
  reservedProviderUsd += usd;
  let released = false;
  return { usd, release() {
    if (released) return;
    released = true;
    reservedProviderUsd = Math.max(0, reservedProviderUsd - usd);
  } };
}

export async function withProviderBudget(options, fn) {
  const reservation = reserveProviderBudget(options);
  try { return await fn(); }
  finally { reservation.release(); }
}

export const spend = { usd: 0, calls: 0, inTok: 0, outTok: 0, cachedTok: 0 };

/** Cost one completed Anthropic response from provider-reported usage. Cache fields
 * are separate from input_tokens. Cache writes are charged at the maximum supported
 * 2x duration and reads at their documented 0.1x rate, so a future duration change
 * cannot make the local hard brake optimistic. */
export function anthropicUsageCost(requestedModel, message) {
  const model = message?.model || requestedModel;
  const p = PRICE[model] || { in: 10, out: 50 };
  const usage = message?.usage || {};
  const uncached = Math.max(0, Number(usage.input_tokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const searches = Math.max(0, Number(usage.server_tool_use?.web_search_requests) || 0);
  const usd = uncached / 1e6 * p.in + cacheWrite / 1e6 * p.in * 2 +
    cacheRead / 1e6 * p.in * 0.1 + output / 1e6 * p.out + searches * 0.01;
  return { model, uncached, cacheWrite, cacheRead, output, searches, usd };
}

export function meterAnthropicUsage(requestedModel, message, seat, effort) {
  const cost = anthropicUsageCost(requestedModel, message);
  const { model, uncached, cacheWrite, cacheRead, output, usd } = cost;
  const totalInput = uncached + cacheWrite + cacheRead;
  spend.usd += usd;
  spend.calls += 1;
  spend.inTok += totalInput;
  spend.outTok += output;
  spend.cachedTok += cacheRead;
  const context = runContext.getStore();
  const floor = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ??
    (floor == null || Number(floor) === 50 ? "house" : "tenant");
  try {
    db.prepare("INSERT INTO llm_spend (floor,floor_attributed,evidence_scope,seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,1,?,?,?,?,?,?,?,?,?)")
      .run(floor, evidenceScope, seat ?? null, model, effort ?? null,
        totalInput, output, cacheRead, usd, Date.now());
  } catch { noteUnpersistedProviderSpend(usd); } // preserve the brake even if the ledger is unavailable
  return cost;
}

/** What the desk has actually spent, from the database rather than a live process. */
export function spendSince(sinceMs, { evidenceScope, includeUnattributed = false } = {}) {
  const scoped = evidenceScope == null ? ""
    : includeUnattributed
      ? " AND ((floor_attributed=1 AND evidence_scope=?) OR floor_attributed=0)"
      : " AND floor_attributed=1 AND evidence_scope=?";
  const row = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(usd),0) usd,
    COALESCE(SUM(in_tok),0) inTok, COALESCE(SUM(out_tok),0) outTok
    FROM llm_spend WHERE ts >= ?${scoped}`)
    .get(...(evidenceScope == null ? [sinceMs ?? 0] : [sinceMs ?? 0, evidenceScope]));
  return { ...row, usd: Number(row.usd.toFixed(4)) };
}

export const SHARED_RULES = `
You are a specialist on an automated Solana research desk called Claude Company ("Claude Co").
You hold exactly one seat. Do that seat's job and no other seat's job.

${CHARTER}

Operating rules for your reply:
- You are given an EVIDENCE bundle fetched deterministically by code. Treat it as the
  only source of numeric fact. Do not state any number that is not derivable from it.
- If a datum you need is missing or null, say so, lower your confidence, and proceed.
  Never substitute a plausible-looking figure for a missing one.
- Each finding needs a source: an evidence key path (e.g. "pair.liquidityUsd"),
  a URL you actually read, or the literal string "inference" when it is your judgment.
- Be concrete and terse. A number with a source beats a paragraph of adjectives.
- You are producing research for a human who will decide. You never execute anything.

THIS DESK TRADES PUMP.FUN, AND IT TRADES A CLOCK.
Every coin sits in one of six market-cap bands, and the bundle states which in
\`band\`, with \`hold.holdMaxMs\` alongside it. That window is not advice: the position
is SOLD when it expires, whether or not the target printed. So a thesis has to be able
to happen inside it.

  nano  $5k-$20k    sold in 30 minutes      micro  $20k-$60k   sold within the hour
  low   $60k-$100k  sold within five hours  medium $100k-$500k sold within five hours
  high  $500k-$1m   sold within five hours  very high $1m-$10m sold within a day

Two consequences you are expected to reason with rather than around:
- "It needs a few days to play out" is a REFUSAL on a nano coin, not a caveat. Judge
  whether the move can happen in the window the coin actually has.
- On nano and micro the coin is minutes old by design. Youth is the ordinary condition
  here, not a reason to abstain. Say "the data is absent" when it is; do not say "too
  new to tell" about the population this desk exists to trade.
Costs are real and proportional at the bottom: pump.fun charges roughly 1.25% a side on
the small bands, so about 2.5% of a round trip is gone before slippage. A thesis worth
under a few percent is not a thesis.
`.trim();

export class Refusal extends Error {}

/**
 * One structured call to a seat. Returns the parsed object, validated against `schema`.
 * Throws after retries rather than returning a half-parsed shape — a seat that cannot
 * answer in contract is a seat that gets dropped, not one that gets guessed at.
 */
export async function ask({
  seat,
  model,
  effort = "high",
  schema,
  prompt,
  system,
  maxTokens,
  attempts = 3,
}) {
  // Thinking counts against max_tokens, so the deeper the effort the more headroom the
  // visible answer needs. 8000 flat starved the xhigh seats of any room to reply.
  maxTokens ??= effort === "max" ? 32000 : effort === "xhigh" ? 24000 : 16000;
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      emit("seat:thinking", { seat, model, effort, attempt: a });
      // Streaming, not parse(): the SDK refuses a non-streaming call at these token
      // budgets because it could exceed the HTTP timeout. finalMessage() gives the same
      // assembled response, and the schema check below is the authority on shape anyway.
      // The retier taught this the hard way, in production: `fallbacks` is an
      // Opus 5 / Fable 5 parameter — Sonnet rejects it with a 400 — and
      // `output_config.effort` errors on Haiku 4.5. Every capability gate here
      // exists because a live cycle hit the 400 for its absence.
      const opusTier = /opus-5|fable-5/.test(model);
      const haiku = /haiku/.test(model);
      const req = {
        model,
        max_tokens: maxTokens,
        system: [
          { type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } },
          /* THE SEAT'S STANDING ORDERS. Its charter is the constant its module ships;
             the orders below it are written by the coach from the desk's own graded
             results, between workups. Injected here, once, so every seat in the
             building learns the same way — and so a new seat cannot be added that
             quietly opts out of the feedback loop. Uncached deliberately: guidance
             changes far more often than a charter, and a stale cached copy would mean
             a seat working under orders that were reverted an hour ago. */
          ...(system ? [{ type: "text", text: withPolicy(seat, system) }] : []),
        ],
        messages: [{ role: "user", content: prompt }],
        output_config: haiku
          ? { format: betaZodOutputFormat(schema) }
          : { format: betaZodOutputFormat(schema), effort },
      };
      if (opusTier) {
        // Server-side fallback: if a safety classifier declines, the request is
        // routed to a comparable model instead of failing the whole cycle.
        req.betas = ["server-side-fallback-2026-07-01"];
        req.fallbacks = "default";
      }
      const res = await withProviderBudget({ provider: "anthropic", maxTokens, payload: req }, async () => {
        const stream = client.beta.messages.stream(req);
        const message = await stream.finalMessage();
        meterAnthropicUsage(model, message, seat, effort);
        return message;
      });

      if (res.stop_reason === "max_tokens") {
        throw new Error(`${seat}: ran out of tokens before answering (effort ${effort}, cap ${maxTokens})`);
      }
      if (res.stop_reason === "refusal") {
        throw new Refusal(`${seat}: refused (${res.stop_details?.category ?? "unknown"})`);
      }
      // The SDK's auto-parse leaves parsed_output null on this version even when the
      // model returned perfectly valid JSON, so fall back to validating the text block
      // against the same schema. Zod is the authority either way — a seat that cannot
      // answer in contract is dropped, never guessed at.
      let parsed = res.parsed_output ?? res.parsed ?? null;
      if (!parsed) {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!text) throw new Error(`${seat}: empty response`);
        const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        let raw;
        try { raw = JSON.parse(json); }
        catch { throw new Error(`${seat}: response was not JSON`); }
        const check = schema.safeParse(raw);
        if (!check.success) {
          throw new Error(`${seat}: response did not match contract — ${check.error.issues.slice(0, 2).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
        }
        parsed = check.data;
      }

      emit("seat:done", { seat, usd: spend.usd });
      return parsed;
    } catch (err) {
      lastErr = err;
      if (err instanceof Refusal) throw err;
      if (/credit balance is too low/i.test(String(err?.message))) {
        emit("desk:out_of_credit", { seat });
        throw new OutOfCredit("the Anthropic balance is empty — the desk cannot think");
      }
      const retryable =
        err?.status === 429 || err?.status >= 500 || err?.name === "APIConnectionError";
      emit("seat:retry", { seat, attempt: a, error: String(err?.message || err) });
      if (a === attempts || (!retryable && !/parse/.test(String(err?.message)))) break;
      await new Promise((r) => setTimeout(r, 800 * a * a));
    }
  }
  emit("seat:failed", { seat, error: String(lastErr?.message || lastErr) });
  throw lastErr;
}

/**
 * Two-step for the narrative seat: server-side web search cannot be combined with a
 * structured output format, so we search in one call and shape the result in a second.
 */
export async function askWithWeb({ seat, model, effort, schema, prompt, system, maxTokens = 16000 }) {
  emit("seat:searching", { seat, model });

  // Server-tool errors do NOT throw: they arrive as a result block whose content is an
  // error object instead of a list. Unchecked, a rate-limited search reads to the agent
  // as "no coverage exists" — which is exactly the absence-of-evidence mistake the
  // charter forbids. Retry, then say plainly that the tool failed.
  let research = null, searchError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const req = {
      model,
      max_tokens: maxTokens,
      system: SHARED_RULES + (system ? `\n\n${system}` : ""),
      // max_uses 4 fed ~41k tokens of raw results back through the loop per run;
      // two searches answer "is there a story and is it true" or nothing will.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      output_config: { effort },
      messages: [{ role: "user", content: prompt }],
    };
    research = await withProviderBudget({ provider: "anthropic", maxTokens,
      maxSearches: 2, payload: req }, async () => {
      const message = await client.messages.create(req);
      meterAnthropicUsage(model, message, seat, effort);
      return message;
    });

    const errs = research.content
      .filter((b) => b.type === "web_search_tool_result" && !Array.isArray(b.content))
      .map((b) => b.content?.error_code || "unknown");
    if (!errs.length) { searchError = null; break; }
    searchError = errs[0];
    emit("seat:retry", { seat, attempt, error: `web_search: ${searchError}` });
    if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt));
  }

  const notes = research.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cited = [];
  for (const block of research.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) cited.push(`${r.title ?? ""} — ${r.url}`);
    }
  }

  return ask({
    seat,
    model,
    effort: "low", // shaping already-gathered notes is mechanical
    schema,
    system,
    maxTokens,
    prompt:
      `Convert your own research notes into the required contract. Use ONLY what the notes support.\n\n` +
      (searchError
        ? `=== TOOL FAILURE ===\nThe web search tool failed with "${searchError}" on every attempt. You have read NOTHING external. ` +
          `Report this as missing data and carry it at zero weight in both directions — you have established neither the presence nor the absence of coverage.\n\n`
        : "") +
      `=== YOUR RESEARCH NOTES ===\n${notes}\n\n` +
      `=== SOURCES YOU ACTUALLY READ ===\n${cited.join("\n") || "(none returned)"}\n\n` +
      `=== ORIGINAL BRIEF ===\n${prompt}`,
  });
}
