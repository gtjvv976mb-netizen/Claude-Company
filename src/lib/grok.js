/**
 * GROK — the xAI client, for the two jobs Grok is genuinely best at here:
 *
 *   1. THE X READ. Grok's x_search tool reads X natively — the one evidence
 *      source this desk could never reach: real cashtag velocity, whether
 *      distinct pre-existing voices or one pasted script carry a story, which
 *      event fired a naming race. One read per shortlisted candidate.
 *   2. THE TENANT'S MD BRAIN. A floor may hire Grok as its Managing Director:
 *      the PM seat of THAT floor's runs thinks on grok-4.6 instead of Claude.
 *      Every guard rail around the seat — screen, Pinocchio gate, red team,
 *      compliance, the no-keys wall — is ours and does not move.
 *
 * Everything here fails OPEN and quiet: no XAI_API_KEY, a changed response
 * shape, a refusal to emit JSON — all read as "no signal", never as a block.
 * Spend is metered into the same llm_spend ledger as every other seat, so the
 * daily brake sees Grok dollars too.
 */
import db from "./store.js";
import { acquireCredit, noteUnpersistedProviderSpend, spend, spendNow, withProviderBudget }
  from "./llm.js";
// Pure module: patterns only, no config or db, so no cycle back into the client.
import { isProviderCreditError } from "../provider-health.js";
import { emit, runContext } from "./bus.js";

const BASE = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
export const GROK_MODEL = process.env.DESK_MODEL_GROK || "grok-4.6";
export const hasGrok = () => !!process.env.XAI_API_KEY;

// $/M tokens (grok-4.6 list) + a flat estimate per x_search tool invocation.
const PRICE = { in: 2, out: 6, perSearch: 0.005 };

export function grokUsageCost(data, searches = 0) {
  const usage = data?.usage || {};
  const i = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const o = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const ticks = Number(usage?.cost_in_usd_ticks);
  // Current xAI responses report the exact all-in billed amount, including every
  // server-side tool turn. Keep the token estimate only for older response shapes.
  const usd = Number.isFinite(ticks) && ticks >= 0
    ? ticks / 10_000_000_000
    : (i / 1e6) * PRICE.in + (o / 1e6) * PRICE.out + searches * PRICE.perSearch;
  return { model: data?.model || GROK_MODEL, i, o, cached, usd,
    exact: Number.isFinite(ticks) && ticks >= 0 };
}

/* EXPORTED so a simulation can meter a synthetic read through the REAL cost path rather
 * than through a second copy of it. SIM B's grok stub returned $0 and the desk's largest
 * single line item (44.9% of a 7-day $386.91 bill, 1,170 reads at a $0.1484 mean) was
 * therefore absent from every cost number that run printed. Nothing else changed: the
 * live call site below is the same one it always was. */
export function meterGrokUsage(seat, data, searches = 0) {
  const { model, i, o, cached, usd } = grokUsageCost(data, searches);
  spend.usd += usd; spend.calls += 1; spend.inTok += i; spend.outTok += o;
  spend.cachedTok += cached;
  const context = runContext.getStore();
  const floor = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ??
    (floor == null || Number(floor) === 50 ? "house" : "tenant");
  try {
    db.prepare(`INSERT INTO llm_spend
      (floor,floor_attributed,evidence_scope,seat,model,effort,in_tok,out_tok,cached_tok,usd,ts)
      VALUES (?,1,?,?,?,?,?,?,?,?,?)`)
      .run(floor, evidenceScope, seat, model, null, i, o, cached, usd, spendNow());
  } catch { noteUnpersistedProviderSpend(usd); }
}

/** Pull the first JSON object out of model text, tolerant of fences and prose. */
export function parseLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  // walk to the matching close brace rather than trusting lastIndexOf
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** The text of a /v1/responses reply, wherever this month's shape put it. */
function responseText(r) {
  if (typeof r?.output_text === "string" && r.output_text) return r.output_text;
  const parts = [];
  for (const item of r?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  if (parts.length) return parts.join("\n");
  return r?.choices?.[0]?.message?.content ?? null;
}

async function xai(path, body, timeoutMs = 90000,
  { seat, maxTokens = 8000, maxSearches = 0, minSearches = 0 } = {}) {
  /* THE xAI BREAKER, and it must fail OPEN, not throw.
   *
   * When the xAI account is dry the API answers 403 "your team has used all available
   * credits", and every caller in this file has always turned that into { ok:false }:
   * a missing X read costs the desk a piece of evidence, never a cycle. That is the
   * contract this module documents at the top and it does not move for the breaker.
   * Throwing OutOfCredit here instead would let a dry xAI account halt cycles that a
   * FUNDED Anthropic account could still run — the exact cross-provider blackout the
   * 2026-09-05 incident produced by hand, when the operator topped up Anthropic while
   * xAI was the empty one. So the gate is refused in xAI's own idiom, and the message
   * is worded as its 403 so provider-health.js still classifies the outage correctly. */
  const gate = acquireCredit("xai", { seat });
  if (!gate.allowed) return { ok: false, error: gate.message };
  try {
    return await withProviderBudget({ provider: "xai", maxTokens, maxSearches, payload: body }, async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.XAI_API_KEY}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const error = `xai ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`;
          /* Only a credit refusal opens it. A 429, a 500 or an aborted fetch goes to
             failure(), which cannot open a closed breaker — those retry on their own
             and always have. */
          if (isProviderCreditError(error)) gate.refused(error);
          else gate.failure(new Error(error));
          return { ok: false, error };
        }
        const searches = Math.max(minSearches,
          (data?.output ?? []).filter((item) => /search/i.test(item?.type ?? "")).length);
        meterGrokUsage(seat, data, searches);
        gate.success();          // xAI billed us: the account is live, close the breaker
        return { ok: true, data };
      } catch (e) {
        gate.failure(e);
        return { ok: false, error: String(e.message || e) };
      } finally { clearTimeout(t); }
    });
  } catch (e) {
    /* reserveProviderBudget() refuses OUR OWN daily ceiling by throwing BudgetExhausted
       straight out of xai(), as it always has. Release the probe slot on the way past
       so a budget wall cannot strand the breaker half-open, and rethrow untouched. */
    gate.failure(e);
    throw e;
  }
}

/**
 * A structured Grok call: same contract as ask() — you get the parsed object —
 * but via prompt-described JSON, parsed defensively. `validate` (a zod schema)
 * gets the final say; a shape Grok cannot hold is an error the CALLER handles,
 * usually by falling back to the Claude seat.
 */
export async function grokAsk({ seat, system, prompt, shape, validate, maxTokens = 8000 }) {
  if (!hasGrok()) return { ok: false, error: "XAI_API_KEY not set" };
  const r = await xai("/chat/completions", {
    model: GROK_MODEL,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system + `\n\nAnswer with ONLY a JSON object of exactly this shape:\n${shape}` },
      { role: "user", content: prompt },
    ],
  }, 90000, { seat, maxTokens });
  if (!r.ok) return r;
  const obj = parseLoose(r.data?.choices?.[0]?.message?.content);
  if (!obj) return { ok: false, error: "grok returned no parseable JSON" };
  if (validate) {
    const v = validate.safeParse(obj);
    if (!v.success) return { ok: false, error: "grok JSON failed validation: " + v.error.issues?.[0]?.message };
    return { ok: true, out: v.data };
  }
  return { ok: true, out: obj };
}

/**
 * THE X READ — one live look at X for one token, through Grok's native search.
 * Returns deterministic-shaped evidence for the bundle; the seats do the
 * judging. Fails open: no key, no signal, no drama.
 */
/* ONE PAID READ PER COIN PER HALF HOUR. The read is about the coin's creator and its
 * attention — how old the account is, whether they have rugged before, whether the reach
 * is bought. None of that changes between two workups ten minutes apart, yet every
 * workup bought a fresh one: there was no cache anywhere on this path. Measured on
 * 2026-09-07: 319 same-mint re-starts in a day across the fresh, house, hunt and trend
 * lanes, each buying a ~$0.15 read whenever it cleared the free screen. Keyed on MINT and
 * not on hook: the hook is context text and the question is the same account. Failures
 * are never cached — a transient refusal must be retried, and the credit breaker already
 * stops a dead account from being hammered. Hits emit xread:cached rather than
 * seat:verdict so nothing that counts reads mistakes a replay for a purchase. */
/* 45 MINUTES, AND THE NUMBER IS NOT ARBITRARY: IT MUST OUTLIVE THE STUDY IT SUPPORTS.
 *
 * It was 30 while FUNNEL_STUDY_TTL_MIN is 40, so the cache expired TEN MINUTES BEFORE the
 * verdict it was backing. Every study that reached its own expiry therefore re-bought the
 * X read deterministically — at $0.156 a read and ~26 reads per published call, the
 * single dearest line on the desk paying twice for one question.
 *
 * The relationship, not the number, is the invariant: a read cached for less time than
 * the study it feeds guarantees a re-purchase at the boundary. test-xread-cache-ttl.mjs
 * asserts the ordering against the funnel's own TTL so the two cannot drift apart again,
 * which is the actual failure — they were set in different files by different reasoning
 * and nothing related them. */
const XREAD_CACHE_MS = Math.max(0, Number(process.env.DESK_XREAD_CACHE_MINUTES ?? 45)) * 60_000;
const XREAD_CACHE_MAX = 500;
const XREAD_CACHE = new Map();   // mint -> { at, read, citations }
export function xreadCacheGet(mint, now = Date.now()) {
  if (!XREAD_CACHE_MS || !mint) return null;
  const hit = XREAD_CACHE.get(mint);
  if (!hit) return null;
  if (now - hit.at > XREAD_CACHE_MS) { XREAD_CACHE.delete(mint); return null; }
  return hit;
}
export function xreadCachePut(mint, read, citations, now = Date.now()) {
  if (!XREAD_CACHE_MS || !mint || !read) return;
  XREAD_CACHE.delete(mint);                       // re-insert so eviction order is by recency
  XREAD_CACHE.set(mint, { at: now, read, citations: Array.isArray(citations) ? citations : [] });
  while (XREAD_CACHE.size > XREAD_CACHE_MAX) XREAD_CACHE.delete(XREAD_CACHE.keys().next().value);
}
export function xreadCacheReset() { XREAD_CACHE.clear(); }
export const XREAD_CACHE_TTL_MS = XREAD_CACHE_MS;

export async function grokXRead({ symbol, mint, hook = "", handle = null, lore = null }) {
  if (!hasGrok()) return { ok: false, error: "no key" };
  const cached = xreadCacheGet(mint);
  if (cached) {
    const ageMin = Math.round((Date.now() - cached.at) / 60000);
    emit("xread:cached", { mint, symbol, ageMin,
      detail: `${cached.read?.verdict ?? "?"} · ${cached.read?.mentions_level ?? "?"} attention, ${cached.read?.velocity ?? "?"} (read ${ageMin}m ago, not re-bought)` });
    return { ok: true, read: cached.read, citations: cached.citations, cached: true };
  }
  const r = await xai("/responses", {
    model: GROK_MODEL,
    max_output_tokens: 8000,
    /* TURNS ARE THE BILL. Measured on the live desk over 24 hours: 298 billed turns
     * across ~111 workups — 2.7 per read — and this seat alone was $55.85 of a $138.89
     * day, 40% of everything the desk spent. Each turn re-sends the accumulated
     * context, which is why the seat's token shape is "reading" rather than "thinking".
     * Its questions are bounded and about ONE account — how old, how many followers,
     * what did they launch before, are they paying for reach — and those are answered
     * in the first search or they are not in public at all. Two turns and twelve
     * searches keep the question and drop the wandering. */
    max_turns: Number(process.env.DESK_GROK_MAX_TURNS || 2),
    /* NO from_date. It was pinned to the last seven days, which made the question this
     * prompt itself calls the single most decisive fact available — has this creator
     * launched before, and what happened — unanswerable by construction: a rug from
     * last month sits outside the window. Recency belongs in the prose, where it
     * applies to the ATTENTION half only; a creator's record is history, and history is
     * old by definition. The trend scan below keeps its window, because a story that
     * broke last month is not a story that is breaking. */
    tools: [{ type: "x_search" }],
    input: [{
      role: "user",
      content:
        `Search X for the Solana token "${symbol}" (contract ${mint}). ${hook ? "Context: " + hook + ". " : ""}` +
        (handle ? `The launchpad lists ${handle} as the coin's own account — START THERE and read ` +
          `it directly rather than spending searches discovering who launched this. If it turns ` +
          `out not to be the creator's account, say so.\n` : "") +
        (lore ? `The launcher's own description, verbatim: "${lore}". Judge whether the story it ` +
          `claims is real, and whether anyone outside the coin is repeating it.\n` : "") +
        `Assess the ATTENTION, not the price.\n\n` +
        `THE CREATOR IS THE MAIN SUBJECT. Nearly every Solana memecoin is promoted by ` +
        `its own developer on X, so their account IS the primary evidence — more ` +
        `informative than the volume of chatter around the ticker. Find the account ` +
        `that launched or promotes this coin and read it like a record:\n` +
        `- How old is it and how many followers? A week-old account with 50k followers ` +
        `bought them.\n` +
        `- Does it post as a person with a history, or does it exist only to push tokens?\n` +
        `- HAVE THEY LAUNCHED BEFORE, and what happened? Prior tickers from the same ` +
        `account or person, and whether those ran, died quietly, or rugged. A creator ` +
        `who has rugged before is the most decisive fact available and it is usually ` +
        `sitting in public on their own timeline.\n` +
        `- Did they post the contract address themselves, and are they replying to ` +
        `holders now, or did they post once and go quiet?\n` +
        `- Are they PAYING for attention? One wording repeated across accounts with no ` +
        `shared community, sudden reply swarms, engagement pods. A coin that has to buy ` +
        `its attention does not have any.\n` +
        `- IS THIS A SERIAL RUGGER? This is the single most valuable thing you can find, ` +
        `and X is the only place it is visible. A rugger rotates WALLETS between launches ` +
        `— on-chain forensics loses them every time — but they keep the ACCOUNT, because ` +
        `the audience is the asset they cannot rebuild. So the pattern lives on their ` +
        `timeline: repeated launches, each hyped the same way, each followed by silence, ` +
        `angry replies, or the post being deleted. Search their handle alongside "rug", ` +
        `"scam" and "dev sold", and read what other people say happened. Two or more ` +
        `prior coins that died on this account is a pattern, not bad luck.\n` +
        `- A WIPED TIMELINE IS ITSELF EVIDENCE. An account that pushes tokens but whose ` +
        `history starts abruptly, or which has been renamed, has usually deleted a past ` +
        `worth deleting. Note it; do not assume what was in it.\n\n` +
        `THEN READ THE MOMENT. A memecoin is a bet that a piece of culture is about to ` +
        `matter more than it does right now, so the second question after "who is ` +
        `promoting this" is "is the thing it references real, is it big, and is it ` +
        `EARLY". Judge:\n` +
        `- IS THE STORY TRUE? A coin about an event that did not happen, a quote never ` +
        `said, or a person who is not involved has a thesis with nothing under it. ` +
        `Check the claim, do not repeat it.\n` +
        `- HOW BIG IS THE THING ITSELF? A niche in-joke and a story on every front page ` +
        `are different sizes of opportunity. Say which this is.\n` +
        `- WHERE IN THE ARC? The same true story is a different trade depending on ` +
        `whether it broke an hour ago or has been traded for a week. Being late to a real ` +
        `story still loses money.\n` +
        `- SEASON AND CALENDAR. Halloween, Christmas, an election, a sports final, a ` +
        `product launch, a court date. These have windows that OPEN and CLOSE on known ` +
        `dates — say whether this one is opening, peaking, or already closing, and name ` +
        `the date if there is one.\n` +
        `- WEATHER AND LIVE EVENTS. Hurricanes, eclipses, disasters and freak weather ` +
        `reliably spawn coins. If this rides one, is the event still unfolding or over? ` +
        `An event that has finished has no more surprise left in it.\n` +
        `- WHAT IS EMERGING RIGHT NOW. Independently of this coin: which memes, formats ` +
        `or themes are RISING on X today, and does this one belong to any of them? A coin ` +
        `at the front of a wave and a coin at the back look identical on a chart.\n\n` +
        `Then answer with ONLY a JSON object:\n` +
        `{"mentions_level":"none|low|building|hot",` +
        `"story_is_true":<true|false|null — is the referenced event/claim real and checkable>,` +
        `"truth_note":"what you actually verified, or why you could not",` +
        `"significance":"niche|notable|major|global",` +
        `"trend_name":"the meta or wave this belongs to, or null",` +
        `"trend_stage":"emerging|building|peaking|fading|none",` +
        `"seasonal_hook":"the season, holiday, event or date it rides, or null",` +
        `"season_window":"opening|peak|closing|none",` +
        `"live_event":"an unfolding event it rides (weather, disaster, sport), or null",` +
        `"event_still_unfolding":<true|false|null>,` +
        `"emerging_trends":["themes rising on X right now, whether or not this coin is in them"] (max 4),` +
        `"early_or_late":"early|on_time|late",` +
        `"velocity":"rising|flat|fading",` +
        `"distinct_voices":<true if several PRE-EXISTING accounts discuss it in their own words, false if one script is pasted everywhere>,` +
        `"dev_handle":"the creator/promoter X handle, or null if not found",` +
        `"dev_account_age":"e.g. '3 years', '6 days', or null",` +
        `"dev_followers":<number or null>,` +
        `"dev_looks_real":<true if a person with a history, false if a token-pushing shell, null if unknown>,` +
        `"dev_posted_ca":<true|false|null — did the creator post the contract address themselves>,` +
        `"dev_engaging_now":<true|false|null — actively replying to holders>,` +
        `"dev_prior_tokens":[{"ticker":"...","outcome":"ran|died|rugged|unknown"}] (max 4, only what you can source),` +
        `"dev_red_flags":["short, specific, sourced"],` +
        `"serial_rugger":<true|false|null — has THIS ACCOUNT launched coins that rugged, MORE THAN ONCE>,` +
        `"rug_evidence":"how you know: the tickers, the dates, the posts or the accusations you actually found — or null",` +
        `"deleted_history":<true|false|null — signs of wiped posts, a renamed handle, or a timeline that starts abruptly>,` +
        `"paid_promotion_signs":<true|false>,` +
        `"kol_posts":[{"handle":"...","gist":"..."}] (max 3, only genuinely notable accounts),` +
        `"lore_origin":"the traceable origin post/moment/person, or null",` +
        `"paid_or_botted_signs":<true|false>,` +
        `"verdict":"organic|mixed|manufactured|no_signal",` +
        `"summary":"two sentences a portfolio manager can use"}\n\n` +
        `Say null rather than guessing. An invented follower count or an imagined prior ` +
        `rug is worse than admitting you could not find the account.`,
    }],
  }, 120000, { seat: "XRead", maxTokens: 8000,
    maxSearches: Number(process.env.DESK_GROK_MAX_SEARCHES || 20), minSearches: 1 });
  if (!r.ok) return r;
  const obj = parseLoose(responseText(r.data));
  if (!obj) return { ok: false, error: "x-read returned no parseable JSON" };
  const citations = (r.data?.citations ?? []).slice(0, 8);
  emit("seat:verdict", { seat: "XRead", symbol, detail: `${obj.verdict ?? "?"} · ${obj.mentions_level ?? "?"} attention, ${obj.velocity ?? "?"}` });
  xreadCachePut(mint, obj, citations);
  return { ok: true, read: obj, citations };
}

/**
 * THE TREND SCAN — the desk's discovery running BACKWARDS.
 *
 * Every other lane starts on-chain: sweep the pairs that already exist, then ask Grok
 * whether the story behind one is real. That is structurally late. By the time a coin
 * carries enough volume and liquidity to surface on a pair feed, whatever made it
 * interesting happened hours ago and the desk is reading an echo.
 *
 * The documented Grok memecoin trade worked the other way round, and the mechanism is
 * worth stating plainly because the whole lane is built on it: a high-reach X event
 * fires with a NAMEABLE gap, dozens of coins launch racing to claim the name, one wins
 * the race and runs, and the rest go to zero. The tradeable fact is the RACE, and the
 * race is visible on X before it is visible on chain.
 *
 * So this asks Grok the opposite question: not "is this coin's story real" but "what
 * story is happening right now that coins will be launched for". The answer is a list
 * of themes and the terms to hunt them by — trends.js does the hunting.
 *
 * The hard part is EARLINESS, not detection. Anything already saturated is worthless
 * here: by then the winner has run and the desk would be buying the top. So the prompt
 * spends most of its weight on stage rather than on volume.
 */
export async function grokTrendScan({ limit = 14 } = {}) {
  if (!hasGrok()) return { ok: false, error: "no key" };
  const from = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  const r = await xai("/responses", {
    model: GROK_MODEL,
    max_output_tokens: 6000,
    // The same reasoning as the X read above: a trend either shows in the first passes
    // or it is not a trend yet. This lane runs every twelve minutes on its own clock.
    max_turns: Number(process.env.DESK_GROK_MAX_TURNS || 2),
    tools: [{ type: "x_search", from_date: from }],
    input: [{
      role: "user",
      content:
        `You are the scout for a Solana memecoin desk. Do NOT analyse any specific coin. ` +
        `Answer one question: WHAT IS HAPPENING ON X RIGHT NOW THAT PEOPLE WILL LAUNCH ` +
        `MEMECOINS FOR — in the next hours, not the last week?\n\n` +
        `Memecoins are launched for nameable things: a viral clip or phrase, a fresh ` +
        `meme format, a public figure doing something absurd, a breaking news moment ` +
        `with a funny angle, an in-joke escaping its community, a season or holiday ` +
        `arriving, a movement gathering a name. Search X broadly and read what is ` +
        `ACCELERATING.\n\n` +
        `EARLINESS IS THE ENTIRE VALUE. A trend everyone has already posted about is ` +
        `worthless to us — the coins for it launched hours ago and already ran. Prefer ` +
        `something climbing fast from a small base over something enormous and flat. Be ` +
        `honest in "stage": most of what you find will already be peaking, and saying ` +
        `so is more useful than dressing it up.\n\n` +
        `For each, give the exact words a launcher would put in a ticker or name — that ` +
        `is what we search the chain for. Short, literal, no hashtags.\n\n` +
        `Answer with ONLY JSON:\n` +
        `{"themes":[{` +
        `"theme":"short name for what is happening",` +
        `"what_happened":"one sentence, concrete and checkable",` +
        `"stage":"just_broke|building|peaking|over",` +
        `"reach":"niche|notable|mainstream",` +
        `"first_seen":"roughly when it started, or null",` +
        `"why_coinable":"why this specifically gets a token, not just posts",` +
        `"search_terms":["2-5 literal words or tickers a launcher would use"],` +
        `"source_handles":["accounts driving it, max 3"]` +
        `}] (max ${limit}, strongest first)}\n\n` +
        `An empty list is a valid and useful answer. Do not invent a trend to fill it — ` +
        `a fabricated theme sends the desk hunting coins that do not exist.`,
    }],
  }, 120000, { seat: "TrendScan", maxTokens: 6000,
    maxSearches: Number(process.env.DESK_GROK_MAX_SEARCHES || 20), minSearches: 1 });
  if (!r.ok) return r;
  const obj = parseLoose(responseText(r.data));
  const themes = Array.isArray(obj?.themes) ? obj.themes : [];
  emit("trend:scan", { found: themes.length,
    themes: themes.map((t) => `${t.theme} (${t.stage})`).slice(0, 6) });
  return { ok: true, themes, citations: (r.data?.citations ?? []).slice(0, 8) };
}
