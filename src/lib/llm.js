import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { emit } from "./bus.js";
import { CHARTER } from "../config.js";
import db from "./store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS llm_spend (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  seat     TEXT, model TEXT, effort TEXT,
  in_tok   INTEGER, out_tok INTEGER, cached_tok INTEGER,
  usd      REAL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_ts ON llm_spend(ts);
`);

/** Billing failures are terminal for a cycle: retrying just burns time. */
export class OutOfCredit extends Error {}

/** The daily cap tripping is handled exactly like an empty balance — every existing
 * OutOfCredit path (halt the cycle, fail the floor run cleanly) already does the
 * right thing, so the brake subclasses it rather than inventing a parallel path. */
export class BudgetExhausted extends OutOfCredit {}

/** Throws before any tokens are spent if the last 24h already cost the cap. */
export function assertDailyBudget(capUsd) {
  if (!capUsd || capUsd <= 0) return;
  const spent = spendSince(Date.now() - 24 * 3600e3).usd;
  if (spent >= capUsd) {
    emit("cycle:budget", { usedUsd: spent, capUsd, window: "24h" });
    throw new BudgetExhausted(
      `daily budget spent: $${spent.toFixed(2)} of $${capUsd} in 24h — the desk pauses, monitoring continues`);
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

export const spend = { usd: 0, calls: 0, inTok: 0, outTok: 0, cachedTok: 0 };

function meter(model, usage, seat, effort) {
  const p = PRICE[model] || PRICE["claude-opus-5"];
  const i = usage?.input_tokens ?? 0;
  const o = usage?.output_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  spend.usd += (i / 1e6) * p.in + (o / 1e6) * p.out;
  spend.calls += 1;
  spend.inTok += i;
  spend.outTok += o;
  spend.cachedTok += cached;
  const usd = (i / 1e6) * p.in + (o / 1e6) * p.out;
  try {
    db.prepare("INSERT INTO llm_spend (seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,?,?,?,?,?,?,?)")
      .run(seat ?? null, model, effort ?? null, i, o, cached, usd, Date.now());
  } catch {}   // metering must never break a run
}

/** What the desk has actually spent, from the database rather than a live process. */
export function spendSince(sinceMs) {
  const row = db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(usd),0) usd, COALESCE(SUM(in_tok),0) inTok, COALESCE(SUM(out_tok),0) outTok FROM llm_spend WHERE ts >= ?")
    .get(sinceMs ?? 0);
  return { ...row, usd: Number(row.usd.toFixed(4)) };
}

const SHARED_RULES = `
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
      const stream = client.beta.messages.stream({
        model,
        max_tokens: maxTokens,
        system: [
          { type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } },
          ...(system ? [{ type: "text", text: system }] : []),
        ],
        messages: [{ role: "user", content: prompt }],
        output_config: { format: betaZodOutputFormat(schema), effort },
        // Server-side fallback: if a safety classifier declines, the request is
        // routed to a comparable model instead of failing the whole cycle.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      const res = await stream.finalMessage();

      meter(model, res.usage, seat, effort);

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
    research = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: SHARED_RULES + (system ? `\n\n${system}` : ""),
      // max_uses 4 fed ~41k tokens of raw results back through the loop per run;
      // two searches answer "is there a story and is it true" or nothing will.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      output_config: { effort },
      messages: [{ role: "user", content: prompt }],
    });
    meter(model, research.usage, seat, effort);

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
