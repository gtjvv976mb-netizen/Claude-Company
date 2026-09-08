/**
 * SIMULATION B — DOES THE DESK PUBLISH THREE CALLS PER CYCLE?
 *
 * ─── WHAT IS REAL AND WHAT IS STUBBED, BEFORE ANY NUMBER IS QUOTED ─────────────────
 * The seats are models and the Anthropic account is empty (verified 2026-09-07: HTTP
 * 400 "credit balance is too low"), so a full-fidelity cycle cannot be run today. This
 * file proves the largest honest subset: the REAL runPenthouseCycle, driven over a
 * synthetic market, with only the two things that cost money replaced.
 *
 *   REAL (this is what the claims rest on):
 *     runPenthouseCycle           the whole cycle body — sweep, rank, board, funnel,
 *                                 shortlist, bench, concurrency, cohort pick, the
 *                                 fallback walk, the hunt lane, cycle:short
 *     calls.js cohort ledger      beginCyclePass, settleCycles, pursuitOver, the gate,
 *                                 the 6h force-close, recordCyclePublish, shortfall
 *     config.js escalationPlan    the L0-L4 ladder and every floor it does not move
 *     desk.js workup              stage order, the X-read arms, seat collection,
 *                                 red-team bar, risk rails, CEO rails, compliance
 *     evidence.js screen()        the free safety screen, unmodified
 *     penthouse.js publishCall    cohortEligibility, the SAFETY floor, the quota bar
 *     mandate.js eligibility      tiers, publishability, the team's explicit no
 *     market.js rank/classify, categories board, dexscreener consensus/shapePair,
 *     jupiter roundTrip, funnel, snapshots, shadow book, llm.js cost metering and
 *     the per-cycle money brake.
 *
 *   STUBBED (synthetic, and no claim rests on these being right):
 *     lib/llm.js  ask/askWithWeb  seat verdicts, scripted per coin. Every stub answer
 *                                 is validated against the seat's own zod schema
 *                                 before it is returned, so an off-contract fixture
 *                                 fails loudly instead of flattering the pipeline.
 *     lib/grok.js grokXRead       the reputation read (serial_rugger / manufactured).
 *     lib/http.js getJson/readRpc the whole network: DexScreener, Jupiter, CoinGecko,
 *                                 pump.fun, the Solana RPC.
 *     data/solana.js              mintInfo / topHolders (crafting SPL account bytes
 *                                 proves nothing the screen does not already prove).
 *     report.js / order.js        the scribe — file writing only, kept out of the repo.
 *     globalThis.fetch            replaced with a throw, so any escape is loud.
 *
 * NOTHING here touches the live claude-co.db, the executor, or any wallet. The database
 * is a throwaway file under a temp dir and EXECUTE is 0 throughout.
 *
 *   node test-quota-simulation.mjs
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { cfg } from "./src/config.js";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quota-sim-"));

process.env.CLAUDE_CO_DB = path.join(TMP, "quota-sim.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sim-no-network";       // never used: ask() is stubbed
process.env.XAI_API_KEY = "";                            // grok is stubbed outright
process.env.DESK_PREPARE_TX = "0";
process.env.PENTHOUSE_WHALE_BUDGET_MS ??= "2000";
/* The money brakes. The PER-CYCLE brake is left at its shipped default so it still
   shapes how many workups a pass gets. The DAILY cap and hourly pace are widened for
   this run only: fifty cycles inside one wall-clock minute would trip the pace brake
   on cycle 3 and measure the brake instead of the quota. Called out in the report. */
process.env.DESK_DAILY_BUDGET_USD = "1000000";
process.env.PENTHOUSE_CYCLE_BUDGET_USD ??= "8";

/* ═══ THE STUB LAYER ══════════════════════════════════════════════════════════════ */

const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/lib/http.js"), "http"],
  [F("src/lib/llm.js"), "llm"],
  [F("src/lib/grok.js"), "grok"],
  [F("src/data/solana.js"), "solana"],
  [F("src/report.js"), "report"],
  [F("src/order.js"), "order"],
]);

const SOURCE = {
  http: `
    const S = () => globalThis.__SIM;
    export async function getJson(url, opts = {}) { return S().http.getJson(String(url), opts); }
    export async function rpc(ep, method, params) { return S().http.readRpc(method, params); }
    export async function readRpc(ep, method, params) { return S().http.readRpc(method, params); }
  `,
  llm: `
    import * as real from "${F("src/lib/llm.js")}?sim=real";
    export const { spend, spendSince, spendBySeat, spendByLane, openCreditBreakers,
      assertDailyBudget, meterAnthropicUsage, anthropicUsageCost, resetCreditBreakers,
      creditBreakerState, acquireCredit, noteCreditRefusal, noteCreditSuccess,
      reserveProviderBudget, withProviderBudget, noteUnpersistedProviderSpend,
      setCreditBreakerClock, SHARED_RULES, HOURLY_BURST, OPPORTUNISTIC_SHARE,
      CREDIT_BREAKER_COOLDOWN_MS, CREDIT_BREAKER_PROBE_LEASE_MS,
      CREDIT_BREAKER_STAND_DOWN_PROBES } = real;
    export const OutOfCredit = real.OutOfCredit;
    export const BudgetExhausted = real.BudgetExhausted;
    export const Refusal = real.Refusal;
    export async function ask(o) { return globalThis.__SIM.seats.ask(o, real); }
    export async function askWithWeb(o) { return globalThis.__SIM.seats.ask({ ...o, web: true }, real); }
  `,
  grok: `
    export const GROK_MODEL = "sim-grok";
    export const hasGrok = () => true;
    export const grokUsageCost = () => ({ usd: 0 });
    export function parseLoose(t) { try { return JSON.parse(t); } catch { return null; } }
    export async function grokAsk() { return { ok: false, error: "sim: grok seat disabled" }; }
    export async function grokXRead(o) { return globalThis.__SIM.seats.xread(o); }
    export async function grokTrendScan() { return { ok: false, error: "sim: no trend scan" }; }
  `,
  solana: `
    const S = () => globalThis.__SIM;
    export async function mintInfo(mint) { return S().chain.mintInfo(mint); }
    export async function topHolders(mint) { return S().chain.topHolders(mint); }
    export async function health() { return { ok: true, slot: 1 }; }
    export async function walletSolBalances() { return {}; }
    export async function walletSolBalance() { return null; }
  `,
  report: `
    export function writeReport(cycle, r) {
      globalThis.__SIM.counters.reports++;
      return "reports/sim/" + String(cycle) + "__" + (r?.symbol || "x") + ".md";
    }
  `,
  order: `
    export async function buildUnsignedSwap() { return { ok: false, error: "sim: disabled" }; }
    export async function writeOrderSlip(cycle, { ev, ceo, risk }) {
      globalThis.__SIM.counters.orderSlips++;
      const size = ceo?.order_size_usd ?? risk?.position_size_usd ?? 0;
      return { file: "reports/sim/order.md", links: { gmgn: "sim://gmgn" },
        tx: { ok: false, error: "sim" }, size };
    }
  `,
};

registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (String(r.url).includes("sim=real")) return r;
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?sim=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("sim=stub")) {
      const k = new URL(u).searchParams.get("k");
      return { format: "module", source: SOURCE[k], shortCircuit: true };
    }
    return next(url, ctx);
  },
});

/* Any escape from the stub layer is a network call, and this makes it loud rather than
   slow. Nothing in the cycle path should ever reach it. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  globalThis.__SIM.counters.escapedFetch.push(String(u));
  throw new Error(`SIM: a real network call escaped the stub layer: ${String(u).slice(0, 120)}`);
};
void realFetch;

/* ═══ THE SYNTHETIC MARKET ════════════════════════════════════════════════════════ */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIM = {
  counters: { reports: 0, orderSlips: 0, seatCalls: 0, escapedFetch: [], workups: 0, gathered: [] },
  market: new Map(),
  universe: [],
  log: [],
};
globalThis.__SIM = SIM;

const coinFor = (mint) => SIM.market.get(mint) || null;
/** Which coin is this seat being asked about? The earliest mint named in the prompt —
 *  earliest so the Best Pick seat names a candidate the caller actually listed first.
 *  Two seats (Execution, and any prompt that carries only the symbol) are identified by
 *  the fixture's unique symbol instead. A seat we cannot identify is a loud failure. */
const mintInPrompt = (text) => {
  let s = String(text || "");
  /* THE CEO'S PROMPT OPENS WITH THE FIRM'S RECORD TO DATE, which names every coin the
     desk has already published. Taking the first mint in that prompt answered the CEO
     seat about a coin from three cohorts ago. When the prompt marks its subject, read
     from the marker. */
  const marker = s.indexOf("=== TOKEN ===");
  if (marker >= 0) s = s.slice(marker);
  let best = null, at = Infinity;
  for (const m of SIM.market.keys()) {
    const i = s.indexOf(m);
    if (i >= 0 && i < at) { at = i; best = m; }
  }
  if (best) return best;
  const sym = s.match(/\bS\d{3,6}\b/);
  if (sym) for (const [m, c] of SIM.market) if (c.symbol === sym[0]) return m;
  return null;
};

SIM.http = {
  async getJson(url) {
    const u = String(url);
    if (u.includes("/latest/dex/search")) {
      // Every angle returns the same sweep; market.js dedupes by mint.
      return { ok: true, data: { pairs: SIM.universe.map((m) => coinFor(m)?.raw).filter(Boolean) } };
    }
    if (u.includes("/latest/dex/tokens/")) {
      const mint = u.split("/latest/dex/tokens/")[1].split(/[?#]/)[0];
      const c = coinFor(mint);
      if (!c) return { ok: false, error: "sim: unknown mint" };
      return { ok: true, data: { pairs: [c.raw] } };
    }
    if (u.includes("/orders/v1/solana/")) return { ok: true, data: { orders: [] } };
    if (u.includes("token-boosts") || u.includes("token-profiles")) return { ok: true, data: [] };
    if (u.includes("coingecko")) {
      // 31 daily closes, gently rising: a known, risk_on weather so nothing is grounded
      // for a reason that has nothing to do with the quota.
      const prices = Array.from({ length: 31 }, (_, i) => [i, 100 + i]);
      return { ok: true, data: { prices } };
    }
    if (u.includes("/price/v3")) {
      const ids = new URL(u).searchParams.get("ids") || "";
      const out = {};
      for (const m of ids.split(",")) {
        const c = coinFor(m);
        if (c) out[m] = { usdPrice: c.priceUsd };       // agrees with DexScreener: VERIFIED
      }
      return { ok: true, data: out };
    }
    if (u.includes("/swap/v1/quote")) {
      const q = new URL(u).searchParams;
      const inMint = q.get("inputMint"), outMint = q.get("outputMint");
      const amount = Number(q.get("amount"));
      const token = inMint === USDC ? outMint : inMint;
      const c = coinFor(token);
      if (!c) return { ok: false, error: "sim: unknown mint" };
      if (!c.quoteOk) return { ok: false, error: "HTTP 404" };   // no route: unverified_exit
      const out = inMint === USDC
        ? Math.round(amount * 1000)                    // buy leg
        : Math.round((amount / 1000) * 0.968);         // sell leg: ~3.2% round trip
      return { ok: true, data: { inAmount: String(amount), outAmount: String(out),
        priceImpactPct: "0.0012", routePlan: [{ swapInfo: { label: "SimSwap" } }] } };
    }
    if (u.includes("frontend-api-v3.pump.fun/coins?creator=")) {
      const creator = new URL(u).searchParams.get("creator");
      const priors = SIM.deployers.get(creator) || [];
      return { ok: true, data: priors };
    }
    if (u.includes("frontend-api-v3.pump.fun/coins/")) {
      const mint = u.split("/coins/")[1].split(/[?#]/)[0];
      const c = coinFor(mint);
      if (!c || !c.pumpCoin) return { ok: false, error: "sim: not a pump coin" };
      return { ok: true, data: c.pumpCoin };
    }
    if (u.includes("/callout/top/")) return { ok: true, data: [] };
    return { ok: false, error: `sim: unrouted ${u.slice(0, 80)}` };
  },
  async readRpc() { return { ok: false, error: "sim: RPC not served (whale flow is a nudge)" }; },
};
SIM.deployers = new Map();
SIM.fateByMint = new Map();

SIM.chain = {
  async mintInfo(mint) {
    const c = coinFor(mint);
    if (c) SIM.counters.gathered.push(c.plan.fate);
    return c?.mintAccount ?? { ok: false, error: "sim: no mint account" };
  },
  async topHolders(mint) { return coinFor(mint)?.holders ?? { ok: false, error: "sim: no holder read" }; },
};

/* ═══ THE SEATS ═══════════════════════════════════════════════════════════════════ */

/** Realistic token usage, so the REAL cost meter and the REAL per-cycle money brake
 *  both run. ~$0.035 a seat, ~$0.42 a workup — the measured live figure. */
const meterOne = (real, model, seat, effort) => {
  try {
    real.meterAnthropicUsage(model, { model, usage: {
      input_tokens: 5000, output_tokens: 400, cache_read_input_tokens: 3000,
    } }, seat, effort);
  } catch { /* metering must never fail a sim cycle */ }
};

const finding = (claim, value, source) => ({ claim, value: String(value), source });

function analystOut(plan, seat) {
  const kill = plan.fate === "analyst_kill" && seat === "Flow";
  return {
    headline: kill ? `${seat}: the tape is three wallets round-tripping` : `${seat}: readable and ordinary`,
    score: kill ? 4 : plan.analystScore ?? 62,
    confidence: 0.7,
    findings: [finding("liquidity read from the bundle", plan.liq ?? 0, "pairs.totalLiquidityUsd")],
    risks: ["the pool can be drained faster than a stop fills"],
    missing_data: [],
    kill,
    kill_reason: kill ? "the 24h tape is three wallets round-tripping the same size" : "",
  };
}

function redteamOut(plan, coin) {
  const refuted = plan.fate === "redteam_refuted";
  return {
    headline: refuted ? "the deployer's previous ticket is documented as a rug"
      : "thin holders and a story that is only two days old",
    bear_case: "the float is small enough that one seller ends this.",
    attacks: refuted ? [{
      target: "the PM's premise that this deployer is unknown",
      attack: "the same account shipped a ticket last month that went to zero in an hour",
      severity: "fatal",
      evidence: "a thread naming the prior ticker and the hour it went to zero",
      fact_code: "deployer_misconduct",
      evidence_path: "",
      observed_value: "prior ticker rugged",
      threshold_or_comparison: "any documented prior rug by the same account",
      source_url: coin.citation,
      verification_status: "verified",
    }] : [{
      target: "the narrative seat's read on reach",
      attack: "most of the reach is reply-farming",
      severity: "serious",
      evidence: "the replies repeat one script",
      fact_code: "fake_social_proof",
      evidence_path: "",
      observed_value: "reply farm",
      threshold_or_comparison: "organic replies",
      source_url: null,
      verification_status: "inference",
    }],
    unfalsifiable_claims: ["it could 10x"],
    what_would_change_my_mind: "a second, unrelated account of size posting it unprompted",
    verdict: refuted ? "refuted" : "wounded",
    confidence: 0.65,
  };
}

function riskOut(plan) {
  return {
    risk_tier: plan.riskTier ?? "quarter",
    size_rationale: "a wounded verdict and a thin book: a quarter of the unit.",
    stop_price: plan.stop,
    stop_rationale: "below the level the thesis needs to hold.",
    liquidity_adjusted: false,
    portfolio_notes: "one of several names of this shape.",
    confidence: 0.6,
  };
}

function pmOut(plan) {
  const decision = plan.pm;
  return {
    decision,
    conviction: plan.conviction,
    thesis: "real ignition on a coin small enough to re-rate inside the band's window.",
    invalidation: "the deployer's wallet sells, or the hourly buyers stop accelerating.",
    time_horizon: "inside this band's hold window",
    how_red_team_was_answered: decision === "PROPOSE"
      ? "the fatal attack was about reach, and the buy tape is independent of it." : "",
    key_disagreement: "flow liked the tape, forensics disliked the float.",
    watch_triggers: decision === "WATCH" ? ["a second hour of accelerating buys"] : [],
    watch_rules: decision === "WATCH"
      ? { price_above_usd: plan.price * 1.05, buys_h1_at_least: 80, liq_at_least_usd: null, hours: 6 }
      : null,
  };
}

function ticketOut(plan) {
  return {
    action: "BUY",
    entry_zone_low: Number((plan.price * 0.97).toFixed(12)),
    entry_zone_high: Number((plan.price * 1.03).toFixed(12)),
    entry_style: "market",
    slices: [{ pct_of_position: 100, trigger: "on publication" }],
    max_slippage_bps: 300,
    suggested_route: "SimSwap",
    stop_price: plan.stop,                    // must equal the risk seat's stop exactly
    take_profit: [{ price: Number((plan.price * 1.9).toFixed(12)), pct_to_sell: 60,
      rationale: "the band's first re-rate" }],
    execution_warnings: [],
  };
}

function ceoOut(plan) {
  const ruling = plan.ceo;
  return {
    ruling,
    one_line: ruling === "APPROVE" ? "Take it, small." : ruling === "HOLD" ? "Not yet." : "No.",
    reasoning: "the desk's record on this shape is mixed; the size reflects that.",
    order_size_usd: ruling === "DECLINE" ? 0 : 50,
    size_change_reason: "",
    conditions: [],
    questions_for_the_desk: [],
    confidence: 0.6,
  };
}

SIM.dryAccount = false;
SIM.seats = {
  async ask(o, real) {
    /* THE CONDITION THE DESK IS ACTUALLY IN TODAY: the provider refuses on credit. The
       REAL OutOfCredit class, so desk.js's instanceof and penthouse.js's halt path are
       the ones that run. */
    if (SIM.dryAccount) throw new real.OutOfCredit("the Anthropic balance is empty — the desk cannot think");
    SIM.counters.seatCalls++;
    meterOne(real, o.model || "claude-sonnet-5", o.seat, o.effort);
    const seat = o.seat;
    let out;
    if (seat === "Best Pick") {
      // Choose the first candidate mint the prompt actually names.
      const mint = mintInPrompt(o.prompt);
      const c = coinFor(mint);
      out = { pick_mint: mint, pick_symbol: c?.symbol ?? "?",
        why: "the freshest tape of the eligible field.", edge: "buyers accelerating against their own pace",
        runner_up_mint: null, why_not_runner_up: null, confidence: 0.6,
        expected_move: "50_to_100pct", worst_case: "the deployer sells into the first bid" };
      return o.schema.parse(out);
    }
    const mint = mintInPrompt(o.prompt);
    const coin = coinFor(mint);
    if (!coin) throw new Error(`SIM: seat ${seat} was asked about a coin the fixture does not know`);
    const plan = coin.plan;
    if (["Liquidity", "Flow", "Technical", "Forensics", "Narrative"].includes(seat)) out = analystOut(plan, seat);
    else if (seat === "Red Team") out = redteamOut(plan, coin);
    else if (seat === "Risk") out = riskOut(plan);
    else if (seat === "PM") out = pmOut(plan);
    else if (seat === "Execution") out = ticketOut(plan);
    else if (seat === "CEO") out = ceoOut(plan);
    else throw new Error(`SIM: no fixture for seat "${seat}"`);
    // The stub answers in the seat's OWN contract or the sim fails loudly.
    return o.schema.parse(out);
  },
  async xread({ mint }) {
    const coin = coinFor(mint);
    const plan = coin?.plan ?? {};
    const rugger = plan.fate === "rugger";
    const manufactured = plan.fate === "manufactured";
    return {
      ok: true,
      read: {
        verdict: manufactured ? "manufactured" : "organic",
        paid_or_botted_signs: manufactured,
        serial_rugger: rugger,
        rug_evidence: rugger ? "two prior tickets from this account went to zero inside an hour" : "",
        dev_handle: `@sim_${String(mint).slice(3, 9)}`,
        dev_account_age: "8 months",
        dev_followers: 4200,
        dev_looks_real: !manufactured,
        dev_prior_tokens: rugger ? ["PRIOR1", "PRIOR2"] : [],
        dev_posted_ca: true,
        dev_engaging_now: true,
        dev_red_flags: rugger ? ["prior rug"] : [],
        deleted_history: false,
        paid_promotion_signs: manufactured,
        summary: "sim reputation read",
      },
      citations: coin?.citation ? [{ url: coin.citation }] : [],
    };
  },
};

/* ═══ THE CANDIDATE POPULATION ════════════════════════════════════════════════════
 *
 * Shaped on the live board rather than on convenience: mostly rejects, a few marginal,
 * the occasional clean coin. The reject MIX is the desk's own re-counted census of its
 * last 100 kills (test-quota-escalation.mjs, 2026-09-07): ~60% safety mechanics
 * (post_migration_dump 15, serial_deployer 12, holder_concentration 6, mintable 6,
 * thin_liquidity 5, deployer_has_rugged 4, freezable/seizable/transfer_hook/
 * frozen_by_default/unverified_exit 3 each, wash_suspect 2) and ~21% the narrative
 * seat's "manufactured" judgment.
 *
 * Every one of those verdicts is produced by driving the REAL gate: a mintable coin
 * carries a live mint authority on its mint account and evidence.js/screen() is what
 * kills it. Nothing here labels a coin "rejected" and hands that label to the pipeline.
 */
const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
let mintSeq = 0;
/* THE FIRST VERSION OF THIS COLLIDED, AND THE COLLISION WAS INVISIBLE.
 *
 * It built 34 characters from `(n*7 + i*13 + i*i) % 58` — which repeats every 58 coins —
 * and made them unique only by appending String(n) at the END. The pump.fun branch then
 * did `slice(0, 39) + "pump"`, which truncated exactly that suffix. So pump mints
 * collided in batches, a later coin overwrote an earlier one in the fixture map, and the
 * audit that reads a published call's fate back by mint reported 41 "unsafe" publishes
 * that had never happened — while the independent flag and probe audits on the same 190
 * rows said the opposite. Two rulers disagreeing is what caught it; the fixture's ruler
 * was the broken one. The identity now leads with a base58 encoding of the sequence
 * number, so no suffix can ever be cut off it. */
function nextMint(pump) {
  const n = ++mintSeq;
  let tag = "", x = n;
  while (x > 0) { tag = B58[x % 58] + tag; x = Math.floor(x / 58); }
  /* PADDED WITH "0", WHICH IS NOT IN THE BASE58 ALPHABET. Padding with "1" (which IS)
     made base58 "1c" pad to "11111c" — the same six characters as base58 "c" — so coin
     2,902 silently overwrote coin 2 in the fixture map. That is the SECOND collision in
     this generator, and it is why the fixture-fate audit is cross-checked against the
     independent flag/probe audits rather than trusted on its own. */
  const body = "S1M" + tag.padStart(6, "0");                  // 9 chars, unique
  const filler = "QwErTyUiOpAsDfGhJkLzXcVbNm123456";
  return pump ? (body + filler).slice(0, 39) + "pump" : (body + filler).slice(0, 43);
}

/** The reject census, as weights. */
const REJECT_MIX = [
  ["post_migration_dump", 15], ["serial_deployer", 12], ["manufactured", 21],
  ["holder_concentration", 6], ["mintable", 6], ["thin", 5], ["rugger", 4],
  ["freezable", 3], ["seizable", 3], ["transfer_hook", 3], ["frozen_by_default", 3],
  ["unverified_exit", 3], ["wash_suspect", 2], ["unverified_mint", 2],
  ["unverified_holders", 2], ["analyst_kill", 4], ["redteam_refuted", 2],
  ["pm_pass", 4], ["ceo_decline", 3], ["too_new", 3], ["no_volume", 3],
];
const REJECT_TOTAL = REJECT_MIX.reduce((a, [, w]) => a + w, 0);

function pickReject(rnd) {
  let r = rnd() * REJECT_TOTAL;
  for (const [k, w] of REJECT_MIX) { r -= w; if (r <= 0) return k; }
  return "manufactured";
}

/** A deterministic PRNG so a surprising distribution can be reproduced exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const FLAG = {
  mintable: { flag: "mint_authority_live", detail: "supply can still be printed" },
  freezable: { flag: "freeze_authority_live", detail: "accounts can be frozen" },
  seizable: { flag: "ext_permanentDelegate", detail: "a delegate can move your tokens" },
  transfer_hook: { flag: "ext_transferHook", detail: "code runs on every transfer" },
  frozen_by_default: { flag: "ext_defaultAccountState", detail: "new accounts start frozen" },
};

/**
 * One coin, built so that the REAL gate for its fate is what fires.
 * `price`, `stop` and the plan travel together, so the Risk and Execution seats author
 * the same stop and compliance's stop_mismatch check is a real check rather than a
 * fixture coincidence.
 */
function makeCoin(fate, rnd) {
  const pump = fate === "serial_deployer" || rnd() < 0.6;
  const mint = nextMint(pump);
  const symbol = `S${String(mintSeq).padStart(3, "0")}`;
  const price = 0.001 * (0.5 + rnd());
  const mcap = 120_000 + Math.round(rnd() * 700_000);        // medium/high bands
  const fl = { liq: 8_000, vol: 8_000, txns: 40, ageH: 0.5 };
  let liq = 60_000 + Math.round(rnd() * 120_000);
  let vol24 = liq * (1.2 + rnd());
  let txns = 400 + Math.round(rnd() * 900);
  let ageHours = 60 + rnd() * 300;

  if (fate === "thin") liq = Math.round(fl.liq * 0.4);
  if (fate === "no_volume") vol24 = fl.vol * 0.3;
  if (fate === "too_new") ageHours = 0.1;
  /* Re-anchored 2026-09-08: the fate must actually exceed the CONFIGURED wash bar. It was
     a flat 55x, written when the bar was lower; the owner's screen now refuses above
     cfg.screen.maxVolToLiqRatio (250), so 55x passed both screens and, once step 14's
     bench replacement let these coins reach seats, the fixture's default clean verdicts
     published them and the NEVER audit failed for a fixture reason, not a desk one. */
  if (fate === "wash_suspect") { vol24 = liq * (cfg.screen.maxVolToLiqRatio * 1.2); txns = 8000; }
  // The dead-zone gate only looks at coins under 72h, so this fate has to be one.
  if (fate === "post_migration_dump") ageHours = 20;

  const buysH6 = 240, buysH1 = 90;                            // ignition, so rank scores it
  const raw = {
    chainId: "solana", dexId: pump ? "pumpswap" : "raydium",
    pairAddress: `pool${mint.slice(0, 8)}`, url: `https://sim/${mint}`,
    baseToken: { address: mint, symbol, name: `${symbol} sim coin`, decimals: 6 },
    quoteToken: { symbol: "SOL" },
    priceUsd: String(price),
    liquidity: { usd: liq },
    fdv: mcap, marketCap: mcap,
    pairCreatedAt: Date.now() - ageHours * 3.6e6,
    volume: { h24: vol24, h6: vol24 / 5, h1: vol24 / 24 },
    txns: { h24: { buys: Math.round(txns * 0.55), sells: Math.round(txns * 0.45) },
            h6: { buys: buysH6, sells: 180 }, h1: { buys: buysH1, sells: 60 } },
    priceChange: { m5: 1.4, h1: 5, h6: 14, h24: 22 },
    info: { imageUrl: null, socials: [{ type: "twitter", url: "https://x.com/sim" }],
            websites: [{ url: "https://sim.example" }] },
  };

  const flags = FLAG[fate] ? [FLAG[fate]] : [];
  const mintAccount = fate === "unverified_mint"
    ? { ok: false, error: "sim: RPC 429" }
    : { ok: true, supply: "1000000000000000", decimals: 6,
        mintAuthority: fate === "mintable" ? "SimMintAuth1111111111111111111111111111" : null,
        freezeAuthority: fate === "freezable" ? "SimFreeze111111111111111111111111111111" : null,
        extensions: [], flags };
  const holders = fate === "unverified_holders"
    ? { ok: false, error: "sim: getTokenLargestAccounts 429" }
    : { ok: true, top1Pct: fate === "holder_concentration" ? 63.4 : 6.2,
        top10Pct: fate === "holder_concentration" ? 88 : 31,
        bundleSuspect: false, accounts: [], excluded: [] };

  // The team's verdicts, per fate.
  const plan = {
    fate, price, liq,
    stop: Number((price * 0.8).toFixed(12)),
    riskTier: "quarter",
    pm: "PROPOSE", ceo: "APPROVE", conviction: 68, analystScore: 62,
  };
  if (fate === "pm_pass") { plan.pm = "PASS"; plan.conviction = 30; }
  else if (fate === "ceo_decline") { plan.ceo = "DECLINE"; plan.conviction = 58; }
  else if (fate === "watch_low") { plan.pm = "WATCH"; plan.ceo = "HOLD"; plan.conviction = 42; }
  else if (fate === "held_lowconv") { plan.ceo = "HOLD"; plan.conviction = 44; }
  else if (fate === "held") { plan.ceo = "HOLD"; plan.conviction = 61; }
  else if (fate === "redteam_refuted") { plan.pm = "WATCH"; plan.ceo = "HOLD"; plan.conviction = 55; }
  else if (fate === "clean") { plan.conviction = 66 + Math.round(rnd() * 14); }

  const coin = {
    mint, symbol, raw, priceUsd: price, mintAccount, holders, plan,
    quoteOk: fate !== "unverified_exit",
    citation: `https://x.com/sim_${mint.slice(3, 9)}/status/${1000 + mintSeq}`,
    pumpCoin: pump ? {
      mint, creator: fate === "serial_deployer" ? `SimFarm${mintSeq}` : `SimDev${mintSeq}`,
      created_timestamp: Date.now() - ageHours * 3.6e6, complete: true,
      usd_market_cap: mcap, reply_count: 40, twitter: "https://x.com/sim",
      description: "a sim coin", username: "simdev",
      bonding_curve: `curve${mintSeq}`, pool_address: `pool${mintSeq}`,
    } : null,
  };
  SIM.fateByMint.set(mint, fate);
  if (coin.pumpCoin) {
    const priors = fate === "serial_deployer"
      ? Array.from({ length: 12 }, (_, i) => ({ mint: `prior${mintSeq}_${i}`, complete: false, usd_market_cap: 900 }))
      : [{ mint: `prior${mintSeq}_0`, complete: true, usd_market_cap: 400_000 }];
    SIM.deployers.set(coin.pumpCoin.creator, [...priors, { mint, complete: true, usd_market_cap: mcap }]);
  }
  return coin;
}

/** Install a fresh universe for one sweep, and seed whatever the DB-backed gates need. */
function installUniverse(coins, db) {
  SIM.market = new Map(coins.map((c) => [c.mint, c]));
  // A collision here silently deletes a coin from the fixture and corrupts every
  // fate-keyed measurement downstream. It happened once; it fails loudly now.
  if (SIM.market.size !== coins.length)
    throw new Error(`SIM: mint collision — ${coins.length} coins, ${SIM.market.size} distinct mints`);
  SIM.universe = coins.map((c) => c.mint);
  const ins = db.prepare(`INSERT OR IGNORE INTO snapshots (mint,ts,price,liq,vol24,buys,sells,fdv)
                          VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of coins) {
    if (c.plan.fate !== "post_migration_dump") continue;
    // A first sighting an hour ago at 3x the current price — the graduate dead zone the
    // REAL screen measures out of the snapshot ledger.
    ins.run(c.mint, Date.now() - 3600e3, c.priceUsd * 3, c.plan.liq, 1000, 10, 10, 1e6);
  }
}

/* ═══ BOOT THE REAL DESK ══════════════════════════════════════════════════════════ */

const ph = await import("./src/penthouse.js");
const calls = await import("./src/calls.js");
const cfgmod = await import("./src/config.js");
const store = (await import("./src/lib/store.js"));
const db = store.default;
const bus = await import("./src/lib/bus.js");
const { spend } = await import("./src/lib/llm.js");

const { runPenthouseCycle, WORKUPS_PER_CYCLE } = ph;
const { openCycle, cycleStatus, cycleHistory, settleCycles, closeCall, liveCalls,
  cycleCalls, safetyFailures, beginCyclePass } = calls;
const { CYCLE, MAX_ESCALATION_LEVEL, escalationPlan } = cfgmod;

let pass = 0, fail = 0;
const DEFECTS = [];
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
/* A property the desk SHOULD have and does not. Recorded as a named defect rather than
   as a suite failure, so a regression (FAIL) stays distinguishable from a standing
   finding (DEFECT) — and so the finding cannot quietly disappear into a green run. */
const should = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
  : (DEFECTS.push({ n, d }), console.log(`  DEFECT ${n}${d ? "  — " + d : ""}`)); };

/* Every event the cycle emits, kept, so a claim can be checked against the tape rather
   than against a return value. */
const TAPE = [];
// One "event" channel carries everything the desk narrates; `type` is the kind.
bus.bus.setMaxListeners(200);
bus.bus.on("event", (ev) => TAPE.push({ kind: ev.type, ...ev }));
const since = () => TAPE.length;
const tapeFrom = (i) => TAPE.slice(i);

const resetBook = () => {
  for (const c of liveCalls()) closeCall(c.id, "sim reset", 1);
  settleCycles();
  /* Each scenario starts with no OPEN cohort: one left behind by the previous scenario
     would hand the next a pass count, and therefore a level, it did not ask for. The
     rows are retired rather than deleted — other tables reference calls, and a sim that
     rewrites history is a sim that can hide one. */
  db.prepare("UPDATE cycles SET closed_at=?, close_reason=? WHERE closed_at IS NULL")
    .run(Date.now(), "sim: scenario boundary");
};

/** One pass of the real cycle over a freshly installed population. */
async function cyclePass(coins) {
  installUniverse(coins, db);
  SIM.counters.gathered = [];
  const at = since();
  const r = await runPenthouseCycle({});
  return { r, events: tapeFrom(at) };
}

/** Build a population: `spec` maps a fate to a count; the rest are census rejects. */
function population(spec, total, seed) {
  const rnd = rng(seed);
  const coins = [];
  for (const [fate, n] of Object.entries(spec)) for (let i = 0; i < n; i++) coins.push(makeCoin(fate, rnd));
  while (coins.length < total) coins.push(makeCoin(pickReject(rnd), rnd));
  return coins;
}

console.log("\n══ SIMULATION B · the desk's quota machinery, driven for real ══");
console.log(`   db=${process.env.CLAUDE_CO_DB}`);
console.log(`   quota=${CYCLE.quota} maxLevel=${MAX_ESCALATION_LEVEL} cohortGate=${CYCLE.enabled}`);

/* ─── CLAIM 1 ─────────────────────────────────────────────────────────────────────
   A cycle reaches three when three publishable coins exist in its population. */
console.log("\nCLAIM 1 — three publishable coins in the population, and the cycle publishes three");
{
  resetBook();
  const coins = population({ clean: 4, held: 2 }, 40, 11);
  const { r, events } = await cyclePass(coins);
  const published = events.filter((e) => e.kind === "call:published");
  ok("the pass published three calls", r.opened === 3,
    `opened=${r.opened} want=${r.want} level=L${r.level} published=${r.published} workedUp=${r.workedUp} cost=$${r.costUsd}`);
  ok("the cohort ledger agrees with the calls table", r.published === 3,
    `cycles.published_count=${r.published}, calls in cycle=${cycleCalls(r.cycleId).length}`);
  ok("all three were published at L0 — no relaxation was needed",
    published.every((p) => p.level === 0), published.map((p) => `${p.symbol}:L${p.level}`).join(" "));
  ok("no shortfall was recorded", !events.some((e) => e.kind === "cycle:short"),
    `cycle:short events=${events.filter((e) => e.kind === "cycle:short").length}`);
  if (r.opened < 3) {
    const dec = events.filter((e) => e.kind === "cohort:declined");
    console.log("     declines:", [...new Set(dec.map((d) => String(d.reason).slice(0, 90)))].join("\n                ") || "(none)");
    console.log("     token:end:", [...new Set(events.filter((e) => e.kind === "token:end")
      .map((t) => `${t.outcome}:${String(t.detail ?? "").slice(0, 50)}`))].join(" | "));
    console.log("     errors:", [...new Set(events.filter((e) => e.kind === "cycle:error" || e.kind === "seat:failed")
      .map((e) => `${e.kind}:${String(e.error).slice(0, 160)}`))].join("\n              ") || "(none)");
    const hist = {};
    for (const f of SIM.counters.gathered) hist[f] = (hist[f] || 0) + 1;
    console.log("     fates gathered:", JSON.stringify(hist));
  }
}

/* ─── CLAIM 2 ─────────────────────────────────────────────────────────────────────
   With nothing publishable it escalates L0 -> L4, in order, one level per pass. */
console.log("\nCLAIM 2 — nothing publishable: the ladder climbs L0 to L4, one level per pass");
let ladderLevels = [];
let ladderCycleId = null;
{
  resetBook();
  const levels = [];
  const safetyByLevel = new Map();
  for (let p = 0; p < 6; p++) {
    // A population of nothing but SAFETY-failed coins, rebuilt each pass: this is also
    // the drive for CLAIM 4 — at least one safety-failing candidate at every level.
    /* The spec fills the whole population deliberately: a census filler could contribute
       a coin the ladder legitimately reaches (a "manufactured" narrative is publishable
       at L3), and this scenario is about a market with NOTHING in it. */
    const coins = population({
      mintable: 4, holder_concentration: 4, unverified_exit: 4, rugger: 4,
      analyst_kill: 4, serial_deployer: 4, post_migration_dump: 4, freezable: 4,
    }, 32, 100 + p);
    const { r, events } = await cyclePass(coins);
    if (p < 5) {
      levels.push(r.level);
      ladderCycleId = r.cycleId;
      const unsafe = events.filter((e) => e.kind === "call:withheld" && e.safety === true);
      safetyByLevel.set(r.level, unsafe);
    } else {
      ok("a sixth pass has opened a NEW cohort — there is no level five",
        r.cycleId !== ladderCycleId && r.level === 0,
        `cycleId ${ladderCycleId} -> ${r.cycleId}, level=L${r.level}`);
    }
  }
  ladderLevels = levels;
  ok("five passes climbed L0,L1,L2,L3,L4 in order", levels.join(",") === "0,1,2,3,4", `levels=${levels.join(",")}`);
  ok("every pass published nothing", cycleCalls(ladderCycleId).length === 0,
    `calls in the ladder cohort=${cycleCalls(ladderCycleId).length}`);

  console.log("\nCLAIM 4 — no level publishes a coin that failed a safety gate");
  for (const lvl of [0, 1, 2, 3, 4]) {
    const unsafe = safetyByLevel.get(lvl) ?? [];
    const gates = [...new Set(unsafe.map((u) => u.gate))].join(", ");
    ok(`L${lvl}: safety-failing candidates reached the publish gate and every one was refused`,
      unsafe.length > 0, `${unsafe.length} refusals at L${lvl} — gates: ${gates || "(none reached)"}`);
  }
}

/* ─── CLAIM 3 ─────────────────────────────────────────────────────────────────────
   At L4 exhausted it publishes what it found and records an honest shortfall. */
console.log("\nCLAIM 3 — L4 exhausted: publish what was found, record the shortfall, invent nothing");
{
  resetBook();
  let last = null, shortEvents = [];
  for (let p = 0; p < 5; p++) {
    /* ONE publishable coin in the cohort's whole life — offered on the first pass only.
       Every later pass is a market of safety kills, which is the condition the ladder
       exists for and the condition it must not talk itself past. */
    const coins = population(p === 0
      ? { held: 1, mintable: 7, rugger: 7, unverified_exit: 7, holder_concentration: 7, analyst_kill: 7 }
      : { mintable: 6, rugger: 6, unverified_exit: 6, holder_concentration: 6, analyst_kill: 6,
          serial_deployer: 6 }, 36, 200 + p);
    const { r, events } = await cyclePass(coins);
    last = r;
    shortEvents = shortEvents.concat(events.filter((e) => e.kind === "cycle:short"));
  }
  const st = cycleStatus();
  const cyc = st.open ? st : cycleHistory(1)[0];
  const publishedCount = last.cycleId ? cycleCalls(last.cycleId).length : 0;
  ok("the cohort reached L4 and stopped there", last.level === MAX_ESCALATION_LEVEL,
    `final pass level=L${last.level}`);
  ok("it published fewer than three and did not invent a call",
    publishedCount > 0 && publishedCount < CYCLE.quota,
    `published=${publishedCount} of quota ${CYCLE.quota}`);
  const exhausted = shortEvents.filter((e) => e.exhausted === true);
  ok("the shortfall is on the tape, flagged as ladder-exhausted",
    exhausted.length > 0, `cycle:short events=${shortEvents.length}, exhausted=${exhausted.length}, ` +
    `last: short=${shortEvents.at(-1)?.short} published=${shortEvents.at(-1)?.published}`);
  const recs = cycleCalls(last.cycleId);
  ok("every call it DID publish cleared the safety floor",
    recs.length > 0, `${recs.length} call(s): ${recs.map((c) => `${c.symbol}@L${c.escalation_level}`).join(", ")}`);
  // and the ledger's own shortfall flag, once the cohort closes
  for (const c of liveCalls()) closeCall(c.id, "sim: cohort closed", 1);
  settleCycles();
  const closed = cycleHistory(3).find((c) => c.id === last.cycleId);
  ok("the closed cohort row records shortfall=1", closed && closed.shortfall === 1,
    `row: published_count=${closed?.published_count} quota=${closed?.quota} shortfall=${closed?.shortfall} reason=${String(closed?.close_reason).slice(0, 60)}`);
}

/* ─── CLAIM 5 ─────────────────────────────────────────────────────────────────────
   The next cohort opens only when the previous one's calls have all closed, and the
   6h force-close releases a stuck one. */
console.log("\nCLAIM 5 — the cohort gate holds until its calls close, and the deadlock guard releases it");
{
  resetBook();
  const first = await cyclePass(population({ clean: 5 }, 32, 300));
  ok("a cohort published its three", first.r.opened === 3, `opened=${first.r.opened} cycleId=${first.r.cycleId}`);
  const cohortA = first.r.cycleId;
  const live = liveCalls().map((c) => c.id);

  const held = await cyclePass(population({ clean: 5 }, 32, 301));
  ok("the next pass stood down: the cohort's calls are still working",
    held.r.skipped === "cohort_open" && held.r.cycleId === cohortA,
    `skipped=${held.r.skipped} cycleId=${held.r.cycleId} waitingOn=[${(held.r.waitingOn || []).join(",")}]`);
  ok("...and it published nothing while standing down", held.r.opened === 0 && held.r.costUsd === 0,
    `opened=${held.r.opened} cost=$${held.r.costUsd}`);
  ok("...but it still warmed the free funnel rather than idling",
    held.r.warmed && held.r.warmed.swept > 0, JSON.stringify(held.r.warmed).slice(0, 90));

  closeCall(live[0], "sim: sold", 1.2);
  const stillHeld = await cyclePass(population({ clean: 5 }, 32, 302));
  ok("one call closed is not all of them — the gate is still shut",
    stillHeld.r.skipped === "cohort_open", `skipped=${stillHeld.r.skipped} waitingOn=[${(stillHeld.r.waitingOn || []).join(",")}]`);

  for (const id of live.slice(1)) closeCall(id, "sim: sold", 0.9);
  const next = await cyclePass(population({ clean: 5 }, 32, 303));
  ok("with every call closed, a NEW cohort opens at L0",
    next.r.cycleId !== cohortA && next.r.level === 0,
    `cohort ${cohortA} -> ${next.r.cycleId} at L${next.r.level}, opened=${next.r.opened}`);

  // THE DEADLOCK GUARD. One position that never closes must not stop the desk forever.
  const stuckCohort = next.r.cycleId;
  const stuck = liveCalls().map((c) => c.id);
  const blocked = await cyclePass(population({ clean: 5 }, 32, 304));
  ok("the new cohort now holds the gate in its turn", blocked.r.skipped === "cohort_open",
    `skipped=${blocked.r.skipped}`);
  db.prepare("UPDATE cycles SET opened_at=? WHERE id=?")
    .run(Date.now() - (CYCLE.maxAgeMs + 60_000), stuckCohort);
  const released = await cyclePass(population({ clean: 5 }, 32, 305));
  ok("past CYCLE_MAX_AGE_MS the stuck cohort is force-closed and the desk moves on",
    released.r.cycleId !== stuckCohort && released.r.skipped !== "cohort_open",
    `cohort ${stuckCohort} -> ${released.r.cycleId}, skipped=${released.r.skipped ?? "none"}`);
  const forced = cycleHistory(8).find((c) => c.id === stuckCohort);
  ok("...and the force-close is recorded with the calls it left live",
    forced?.forced_close === 1 && String(forced?.forced_open_ids || "").length > 2,
    `forced_close=${forced?.forced_close} still open=${forced?.forced_open_ids} reason=${String(forced?.close_reason).slice(0, 70)}`);
  const stillLive = liveCalls().map((c) => c.id);
  ok("the released calls are STILL LIVE and still monitored — they stopped holding the gate, not being positions",
    stuck.every((id) => stillLive.includes(id)),
    `stuck=[${stuck.join(",")}] live now=[${stillLive.join(",")}]`);
}

/* ─── CLAIM 6 ─────────────────────────────────────────────────────────────────────
   A cycle that published zero holds no gate. */
console.log("\nCLAIM 6 — a cycle that published nothing holds no gate at all");
{
  const closedLadder = TAPE.filter((e) => e.kind === "cycle:closed" && e.cycleId === ladderCycleId).at(-1);
  ok("the barren cohort of CLAIM 2 closed itself the moment its pursuit ended",
    !!closedLadder && closedLadder.published === 0 && closedLadder.forced === false,
    closedLadder ? `published=${closedLadder.published} forced=${closedLadder.forced} reason="${closedLadder.reason}"` : "no cycle:closed for it");
  ok("...for the stated reason that a cycle with no calls holds no gate",
    /published nothing/.test(String(closedLadder?.reason)), String(closedLadder?.reason));

  // And directly: an exhausted, empty cohort must not make the NEXT pass stand down.
  resetBook();
  let last = null;
  for (let p = 0; p < 5; p++) {
    last = (await cyclePass(population({ mintable: 8, rugger: 8, unverified_exit: 8, analyst_kill: 8 }, 32, 400 + p))).r;
  }
  const after = await cyclePass(population({ clean: 4 }, 32, 410));
  ok("the pass after an empty exhausted cohort runs immediately and can publish",
    after.r.skipped !== "cohort_open" && after.r.cycleId !== last.cycleId && after.r.opened > 0,
    `previous cohort ${last.cycleId} (published 0, L${last.level}) -> ${after.r.cycleId} opened=${after.r.opened}`);
}

/* ─── CLAIM 7 ─────────────────────────────────────────────────────────────────────
   THE CONDITION THE DESK IS IN RIGHT NOW. The account is empty. What does a pass that
   cannot think do to the ladder? */
console.log("\nCLAIM 7 — with the account empty, what does the ladder do? (the desk's condition today)");
{
  resetBook();
  SIM.dryAccount = true;
  const levels = [], halted = [];
  let cid = null;
  const spendBefore = spend.usd;
  for (let p = 0; p < 5; p++) {
    const { r, events } = await cyclePass(population({ clean: 6, held: 3 }, 36, 700 + p));
    levels.push(r.level); cid = r.cycleId ?? cid;
    halted.push(events.some((e) => e.kind === "cycle:halted"));
  }
  SIM.dryAccount = false;
  ok("every dry pass halted on credit, and not one seat was reached",
    halted.every(Boolean) && spend.usd === spendBefore,
    `halted=${halted.join(",")} model spend across all five passes=$${(spend.usd - spendBefore).toFixed(4)}`);
  should("a pass that could not think should not consume a rung of the ladder",
    levels.join(",") === "0,0,0,0,0",
    `levels reached with ZERO research done: ${levels.join(",")} — the ladder was burned by an outage, not by the market`);
  const short = TAPE.filter((e) => e.kind === "cycle:short" && e.cycleId === cid).at(-1);
  should("the shortfall it records should name the outage rather than the market",
    /credit|budget|provider|account/i.test(String(short?.note)),
    `cycle:short note = "${String(short?.note).slice(0, 130)}"`);
  // And the market it could not look at was FULL of publishable coins.
  const after = await cyclePass(population({ clean: 6, held: 3 }, 36, 799));
  ok("...and the very same market publishes three the moment the account is funded",
    after.r.opened === 3, `opened=${after.r.opened} at L${after.r.level} in a new cohort ${after.r.cycleId}`);
}

/* ═══ THE DISTRIBUTION ════════════════════════════════════════════════════════════
 *
 * "Without fail" is not a yes/no. The quota is a TARGET pursued up a ladder that never
 * crosses the safety floor, so what the owner needs is the RATE: how often three is
 * reached, at which level, and how often it falls short with the market's own shape as
 * the reason. Sixty cohorts, each run to completion (three published, or the ladder
 * exhausted at L4), over populations of five different qualities.
 */
/* ─── CLAIM 8 ────────────────────────────────────────────────────────────────────
   A paid-screen kill costs no slot (plan step 14, 2026-09-08). The mintable fate passes
   the FREE screen (pair metrics are clean) and dies at the PAID screen inside workup()
   before any seat is bought — 89 of 500 live workups (18%) ended that way, each one
   burning a slot. The real loop must now pull the next bench coin instead. */
console.log("\nCLAIM 8 — a coin the paid screen kills costs no slot: the bench fills it");
{
  resetBook();
  const coins = population({ clean: 3, mintable: 6, held: 4 }, 40, 14);
  const { r, events } = await cyclePass(coins);
  const replaced = events.filter((e) => e.kind === "cycle:replaced");
  const screened = replaced.filter((e) => e.reason === "screened_out");
  const ends = events.filter((e) => e.kind === "token:end");
  const free = new Set(["screened_out", "no_data", "error", "credit_outage", "workup_error"]);
  const paidEnds = ends.filter((e) => !free.has(e.outcome)).length;
  const screenedEnds = ends.filter((e) => e.outcome === "screened_out").length;
  ok("the paid screen killed coins in this pass (the fate reached the loop)", screenedEnds >= 1,
    `screened_out token:end=${screenedEnds} of ${ends.length}`);
  ok("each paid-screen kill pulled the next coin off the bench", screened.length >= 1 && r.replacedScreened === screened.length,
    `cycle:replaced reason=screened_out: ${screened.length} · r.replacedScreened=${r.replacedScreened} · all replaced=${replaced.length}`);
  ok("workedUp counts only workups that reached a seat — a $0 kill is not a workup", r.workedUp === paidEnds,
    `workedUp=${r.workedUp} paid token:end=${paidEnds} screened=${screenedEnds}`);
  ok("the queue stayed bounded: at most 2×workups replacements on a pass", replaced.length <= WORKUPS_PER_CYCLE * 2,
    `replaced=${replaced.length} workups=${WORKUPS_PER_CYCLE} cap=${WORKUPS_PER_CYCLE * 3}`);
  ok("the three clean coins still published", r.opened === 3, `opened=${r.opened} workedUp=${r.workedUp} cost=$${r.costUsd}`);
}

console.log("\n══ THE DISTRIBUTION · 60 cohorts run to completion ══");

const QUALITY = [
  // label,          weight, spec (the rest of the 36 is the measured reject census)
  ["barren", 8, { mintable: 6, rugger: 6, unverified_exit: 6, holder_concentration: 6,
                  analyst_kill: 6, serial_deployer: 6 }],
  ["poor", 30, {}],
  ["normal", 30, { clean: 1, watch_low: 1 }],
  ["good", 22, { clean: 3 }],
  ["rich", 10, { clean: 6, held: 2 }],
];
const QW = QUALITY.reduce((a, q) => a + q[1], 0);
const pickQuality = (rnd) => {
  let r = rnd() * QW;
  for (const q of QUALITY) { r -= q[1]; if (r <= 0) return q; }
  return QUALITY.at(-1);
};

const COHORTS = Number(process.env.SIM_COHORTS || 60);
const rows = [];
const rnd = rng(20260907);
resetBook();
const t0 = Date.now();
for (let n = 0; n < COHORTS; n++) {
  const [label, , spec] = pickQuality(rnd);
  let cycleId = null, passes = 0, maxLevel = 0, thirdAtLevel = null, publishedNow = 0;
  const perPass = [];
  const perPassCounts = [];
  for (let p = 0; p <= MAX_ESCALATION_LEVEL; p++) {
    const coins = population(spec, 36, 900_000 + n * 17 + p);
    const { r } = await cyclePass(coins);
    if (r.skipped) { perPass.push(`skip:${r.skipped}`); break; }
    passes++;
    cycleId = r.cycleId ?? cycleId;
    maxLevel = Math.max(maxLevel, r.level ?? 0);
    const before = publishedNow;
    publishedNow = cycleId ? cycleCalls(cycleId).length : 0;
    perPassCounts.push({ level: r.level, opened: publishedNow - before });
    perPass.push(`L${r.level}:+${publishedNow - before}`);
    if (thirdAtLevel == null && publishedNow >= CYCLE.quota) thirdAtLevel = r.level;
    if (publishedNow >= CYCLE.quota) break;
  }
  rows.push({ n, label, cycleId, passes, maxLevel, thirdAtLevel, perPassCounts,
    published: publishedNow, reached: publishedNow >= CYCLE.quota, perPass: perPass.join(" ") });
  // The bot works the cohort and sells it; the gate reopens.
  for (const c of liveCalls()) closeCall(c.id, "sim: the bot closed it", 1.05);
  settleCycles();
  resetBook();
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const reached = rows.filter((r) => r.reached);
const pct = (a, b) => b ? `${((a / b) * 100).toFixed(1)}%` : "n/a";

console.log(`\n  ${reached.length} of ${rows.length} cohorts reached the quota of ${CYCLE.quota}  (${pct(reached.length, rows.length)})   [${elapsed}s]`);

console.log("\n  WHERE THE THIRD CALL CAME FROM — the level the quota completed at");
for (const lvl of [0, 1, 2, 3, 4]) {
  const at = reached.filter((r) => r.thirdAtLevel === lvl);
  if (at.length) console.log(`    L${lvl} (${escalationLabel(lvl)}): ${String(at.length).padStart(3)}  ${pct(at.length, rows.length)} of all cohorts`);
}

console.log("\n  THE TWO READINGS OF \"THREE PER CYCLE\" — and they are very different numbers");
{
  const oneShot = rows.filter((r) => r.perPassCounts[0]?.opened >= CYCLE.quota).length;
  console.log(`    per COHORT  (three published before the ladder is exhausted): ${reached.length}/${rows.length}  ${pct(reached.length, rows.length)}`);
  console.log(`    per PASS    (three published by ONE run of runPenthouseCycle): ${oneShot}/${rows.length}  ${pct(oneShot, rows.length)}`);
  const allPasses = rows.flatMap((r) => r.perPassCounts);
  const hist = {};
  for (const p of allPasses) hist[p.opened] = (hist[p.opened] ?? 0) + 1;
  console.log(`    ${allPasses.length} passes ran in all; calls opened per pass: ` +
    Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}->${v}`).join("  "));
  const passHist = {};
  for (const r of rows) passHist[r.passes] = (passHist[r.passes] ?? 0) + 1;
  console.log(`    passes a cohort needed: ` +
    Object.entries(passHist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}->${v}`).join("  "));
}

console.log("\n  THE SHORTFALLS — by how far, and what the market had in it");
const short = rows.filter((r) => !r.reached);
const shortBy = {};
for (const r of short) shortBy[CYCLE.quota - r.published] = (shortBy[CYCLE.quota - r.published] ?? 0) + 1;
for (const [by, n] of Object.entries(shortBy).sort())
  console.log(`    short by ${by}: ${n} cohort(s)`);
console.log(`    every shortfall reached L${MAX_ESCALATION_LEVEL} first: ${short.every((r) => r.maxLevel === MAX_ESCALATION_LEVEL)}`);

console.log("\n  BY POPULATION QUALITY — the funnel's health, separated from the machinery's");
for (const [label] of QUALITY) {
  const g = rows.filter((r) => r.label === label);
  if (!g.length) continue;
  const got = g.filter((r) => r.reached);
  const avg = (g.reduce((a, r) => a + r.published, 0) / g.length).toFixed(2);
  const lvls = got.map((r) => r.thirdAtLevel);
  console.log(`    ${label.padEnd(7)} n=${String(g.length).padStart(2)}  reached 3: ${String(got.length).padStart(2)} (${pct(got.length, g.length)})  ` +
    `avg published ${avg}  levels used: ${lvls.length ? [...new Set(lvls)].sort().map((l) => "L" + l).join(",") : "—"}`);
}

function escalationLabel(l) {
  return ["normal", "widen", "conviction", "narrative", "band"][l] ?? "?";
}

/* ═══ THE INDEPENDENT AUDIT OF EVERY CALL THIS SIM PUBLISHED ══════════════════════
 * Not a restatement of the gate: this reads the CALLS TABLE the cycle actually wrote
 * and asks whether any published row carries a fact the safety floor forbids. */
console.log("\n══ AUDIT · every call published in this run, read back off the calls table ══");
{
  const all = db.prepare("SELECT * FROM calls").all();
  const flagged = all.filter((c) => {
    const f = c.flags_at_call ? JSON.parse(c.flags_at_call) : [];
    return f.some((x) => /mint_authority_live|freeze_authority_live|ext_/.test(String(x)));
  });
  ok(`no published call carries a honeypot flag (${all.length} calls)`, flagged.length === 0,
    flagged.length ? flagged.map((c) => `${c.symbol}:${c.flags_at_call}`).join(" ") : "0 of " + all.length);
  const unprobed = all.filter((c) => c.rt_loss_at_call == null);
  ok("every published call had a completed round-trip probe", unprobed.length === 0,
    unprobed.length ? unprobed.map((c) => c.symbol).join(" ") : `all ${all.length} carry a measured round trip`);
  const badStop = all.filter((c) => !(c.stop > 0) || !(c.entry_ref > 0) || c.stop >= c.entry_ref);
  ok("every published call has a usable stop below its entry", badStop.length === 0,
    badStop.length ? badStop.map((c) => `${c.symbol} stop=${c.stop} entry=${c.entry_ref}`).join(" ") : `all ${all.length} manageable`);
  const badLevel = all.filter((c) => c.escalation_level != null && (c.escalation_level < 0 || c.escalation_level > MAX_ESCALATION_LEVEL));
  ok(`no call was published above L${MAX_ESCALATION_LEVEL}`, badLevel.length === 0,
    `levels seen: ${[...new Set(all.map((c) => c.escalation_level))].sort().join(",")}`);
  ok("no real network call escaped the stub layer", SIM.counters.escapedFetch.length === 0,
    SIM.counters.escapedFetch.slice(0, 3).join(" ") || "0 escapes");
  /* THE STRONGEST CHECK AVAILABLE: tie every published row back to the fixture's own
     ground truth. The cycle never saw these labels; it derived its refusals from the
     evidence. If a coin the fixture made unsellable, printable, freezable, rugged or
     team-refused ever appears here, the safety floor leaked. */
  const NEVER = new Set(["mintable", "freezable", "seizable", "transfer_hook", "frozen_by_default",
    "holder_concentration", "unverified_exit", "unverified_mint", "unverified_holders",
    "serial_deployer", "post_migration_dump", "rugger", "analyst_kill", "redteam_refuted",
    "thin", "no_volume", "too_new", "wash_suspect", "pm_pass", "ceo_decline"]);
  const fates = {};
  for (const c of all) { const f = SIM.fateByMint.get(c.mint) ?? "?"; fates[f] = (fates[f] ?? 0) + 1; }
  const leaked = all.filter((c) => NEVER.has(SIM.fateByMint.get(c.mint)));
  ok("the fixture's own coin identities never collided",
    SIM.fateByMint.size === mintSeq, `${mintSeq} coins built, ${SIM.fateByMint.size} distinct mints`);

  ok("no coin the fixture made unsafe or team-refused was ever published",
    leaked.length === 0,
    leaked.length ? leaked.map((c) => `${c.symbol}=${SIM.fateByMint.get(c.mint)}@L${c.escalation_level}`).join(" ")
      : `published fates: ${Object.entries(fates).map(([k, v]) => `${k}:${v}`).join(" ")}`);

  // What the ladder actually WROTE onto a call, next to what it actually DID.
  const l1 = all.find((c) => c.escalation_level === 1);
  if (l1) {
    const note = db.prepare("SELECT detail FROM call_events WHERE call_id=? AND kind='escalation'").get(l1.id);
    console.log(`  the note stamped on an L1 call: ${String(note?.detail).slice(0, 150)}`);
  }
  const byLevel = {};
  for (const c of all) byLevel[c.escalation_level ?? "none"] = (byLevel[c.escalation_level ?? "none"] ?? 0) + 1;
  console.log(`  published calls by the level they were published at: ` +
    Object.entries(byLevel).sort().map(([k, v]) => `L${k}:${v} (${pct(v, all.length)})`).join("  "));

  /* THE LADDER'S OWN CLAIMS, CHECKED AGAINST THE CODE THAT READS THEM.
     The relaxations are stamped onto every published call as the desk's own account of
     what it did, so a plan field that no module reads is a false record on a live call.
     The field list is taken from the PLAN ITSELF rather than hard-coded here: the first
     version of this check named two fields it already knew about, which would have gone
     on passing if a third inert field were added tomorrow — and would have gone on
     FAILING if the two were removed rather than wired, which is how they were fixed. */
  const srcFiles = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f); else if (f.endsWith(".js")) srcFiles.push(f); } };
  walk(path.join(REPO, "src"));
  const readersOf = (field) => srcFiles.filter((f) =>
    !f.endsWith("config.js") && fs.readFileSync(f, "utf8").includes(field));
  /* `level`, `label` and `relaxations` are the record itself, not knobs. Everything else
     the plan sets is a promise about behaviour and must have a module that performs it —
     `minAgeFloorMultiplier` included: it is the always-1 invariant, and calls.js reads it. */
  const knobs = Object.keys(escalationPlan(MAX_ESCALATION_LEVEL))
    .filter((k) => !["level", "label", "relaxations"].includes(k));
  for (const field of knobs) {
    const readers = readersOf(field);
    console.log(`  escalationPlan.${field.padEnd(28)} read by: ${readers.length ? readers.map((f) => path.relative(REPO, f)).join(", ") : "*** NOTHING ***"}`);
  }
  const inert = knobs.filter((field) => readersOf(field).length === 0);
  should("every relaxation the ladder writes onto a call should be one the code performs",
    inert.length === 0,
    inert.length ? `${inert.join(", ")} are set by escalationPlan and read by nothing — ` +
      `the note stamped on a call published at that level describes work no module does`
      : `all ${knobs.length} plan knobs have a reader in src/`);
  console.log(`  seats asked: ${SIM.counters.seatCalls}  ·  metered spend: $${spend.usd.toFixed(2)}  ·  reports (stubbed): ${SIM.counters.reports}`);
}

if (DEFECTS.length) {
  console.log(`\n══ ${DEFECTS.length} STANDING DEFECT(S) — real behaviour, not a broken test ══`);
  for (const d of DEFECTS) console.log(`  · ${d.n}\n      ${d.d}`);
}
console.log(`\n══ ${pass} passed, ${fail} failed, ${DEFECTS.length} defect(s) ══`);
console.log(`   sandbox db: ${process.env.CLAUDE_CO_DB}`);
process.exit(fail ? 1 : 0);
