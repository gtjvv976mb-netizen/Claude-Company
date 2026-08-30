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
import { spend } from "./llm.js";
import { emit } from "./bus.js";

const BASE = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
export const GROK_MODEL = process.env.DESK_MODEL_GROK || "grok-4.6";
export const hasGrok = () => !!process.env.XAI_API_KEY;

// $/M tokens (grok-4.6 list) + a flat estimate per x_search tool invocation.
const PRICE = { in: 2, out: 6, perSearch: 0.005 };

function meterGrok(seat, usage, searches = 0) {
  const i = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const o = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const usd = (i / 1e6) * PRICE.in + (o / 1e6) * PRICE.out + searches * PRICE.perSearch;
  spend.usd += usd; spend.calls += 1; spend.inTok += i; spend.outTok += o;
  try {
    db.prepare("INSERT INTO llm_spend (seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,?,?,?,?,?,?,?)")
      .run(seat, GROK_MODEL, null, i, o, 0, usd, Date.now());
  } catch {}
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

async function xai(path, body, timeoutMs = 90000) {
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
    if (!res.ok) return { ok: false, error: `xai ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally { clearTimeout(t); }
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
  });
  if (!r.ok) return r;
  meterGrok(seat, r.data?.usage);
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
export async function grokXRead({ symbol, mint, hook = "" }) {
  if (!hasGrok()) return { ok: false, error: "no key" };
  const from = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const r = await xai("/responses", {
    model: GROK_MODEL,
    tools: [{ type: "x_search", from_date: from }],
    input: [{
      role: "user",
      content:
        `Search X for the Solana token "${symbol}" (contract ${mint}). ${hook ? "Context: " + hook + ". " : ""}` +
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
  }, 120000);
  if (!r.ok) return r;
  // tool invocations are billed per call; count what the response reports, floor 1
  const searches = Math.max(1, (r.data?.output ?? []).filter((o) => /search/i.test(o?.type ?? "")).length);
  meterGrok("XRead", r.data?.usage, searches);
  const obj = parseLoose(responseText(r.data));
  if (!obj) return { ok: false, error: "x-read returned no parseable JSON" };
  const citations = (r.data?.citations ?? []).slice(0, 8);
  emit("seat:verdict", { seat: "XRead", symbol, detail: `${obj.verdict ?? "?"} · ${obj.mentions_level ?? "?"} attention, ${obj.velocity ?? "?"}` });
  return { ok: true, read: obj, citations };
}
