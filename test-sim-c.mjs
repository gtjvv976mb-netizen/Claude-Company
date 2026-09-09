/**
 * SIMULATION C — THREE CALLS PER COHORT, AND DOES THE BOT TAKE THEM?
 *
 * ─── WHY A THIRD SIMULATION EXISTS ────────────────────────────────────────────────
 * Six harnesses run before this one and none of them proves either of the owner's two
 * goals end to end:
 *
 *   SIM B (test-quota-simulation.mjs) drives the REAL cycle, but its positive rate is a
 *     fixture WEIGHT (a hand-written census), its seats cost a flat $0.035 with no tail,
 *     xAI is metered at $0, insufficient_coverage is never produced, and the bot leg is
 *     `closeCall(id, "sim: the bot closed it", 1.05)` — an assumption, not a bot.
 *   SIM A (executor/test-follow-through.mjs) drives the REAL poller, but paper mode
 *     returns at poller.mjs's ENTRY line, BEFORE the executable-cost gates that produced
 *     every live refusal, and its calls carry a hand-authored clean bracket.
 *
 * SIM C keeps everything SIM B proved real — runPenthouseCycle, the cohort ledger,
 * escalationPlan, evidence.js screen(), penthouse.js publishCall and its entry contract,
 * the funnel, and llm.js's own cost meter — and replaces the four things that made its
 * numbers unusable:
 *
 *   1. THE FATE WEIGHTS become a STAGE SAMPLER calibrated on measured data (below), so
 *      the publishable rate is a consequence of the desk's own attrition rather than of
 *      how many "clean" coins the fixture chose to put in the bag.
 *   2. THE FLAT SEAT COST becomes a per-(seat, model, effort) draw from the live
 *      llm_spend ROWS — quantile ladder, tails included — and the grok read is metered
 *      through grok.js's own meter instead of being worth $0.
 *   3. THE MONEY RAILS RUN FOR REAL on an injectable clock (llm.js setSpendClock).
 *   4. THE BOT LEG becomes the REAL executor/poller.mjs subprocess, run past the paper
 *      return through the executable-cost and executable-quote fences (PAPER_PREFLIGHT)
 *      against a local Jupiter server serving the measured live refusals.
 *
 * ─── A DEFECT IN SIM B, FOUND WHILE FORKING IT, THAT INVALIDATES ITS HEADLINE ──────
 * SIM B sets `process.env.DESK_DAILY_BUDGET_USD = "1000000"` in its module body to keep
 * the money brakes out of the measurement — but `import { cfg } from "./src/config.js"`
 * is a STATIC import at the top of the same file, so config.js has already read the
 * environment by the time that line runs. The widening is INERT. SIM B therefore ran on
 * the shipped $90 cap, whose hourly pace is max($90/24 x 3, $16 x 1.25) = $20, and its
 * own footer prints "metered spend: $20.05" — it spent the hour's allowance and every
 * later pass was refused by llm.js before a seat was asked.
 *
 * Measured, same file, 20 cohorts, the ONLY difference being where the variable is set:
 *
 *     as shipped (set in the module body, inert):   5 of 20 reached the quota   25.0%
 *     set in the real environment (cap widened):   20 of 20 reached the quota  100.0%
 *
 * So SIM B's distribution is a measurement of its own pace brake. This is exactly the
 * failure the desk's own rule warns about — validate the ruler before you trust it — and
 * it is why item 3 above is not optional: a simulation cannot both compress time and
 * leave a time-based rail switched on. SIM C moves the rails onto a clock it controls,
 * runs them at the plan's real values ($16 per pass, $200 per day, the hourly pace), and
 * reports the rail-stopped cohorts SEPARATELY from the market-limited ones.
 *
 * ─── WHAT IS MEASURED AND WHERE IT COMES FROM ─────────────────────────────────────
 * Everything the sampler and the cost model are calibrated on was fetched from the live
 * desk on 2026-09-09 through the read-only endpoints step 1 added — GET only, aggregate
 * only, no prompt text:
 *
 *   GET /api/decisions/histogram?hours=168   38,061 decision_runs rows and 3,644
 *                                            per-row llm_spend costs
 *   GET /api/spend/seats?hours=168           the per-seat token shape behind those costs
 *
 * The 7-day histogram is an OUTAGE window (86.9% of cycle rows are insufficient_coverage
 * and publishableFraction comes back {pmPositive: 0, published: 0, f: null} — the desk has
 * published nothing since the ledger was added), so the HEALTHY stage rates come from the
 * plan's own measured token:end window and the outage knob comes from the histogram. Both
 * regimes are run, and every rate this file assumes is printed beside what it produced.
 *
 * ─── WHAT IS STILL STUBBED, SO THAT NO CLAIM RESTS ON IT ──────────────────────────
 *   lib/llm.js ask/askWithWeb  seat verdicts. Every stub answer is parsed by the seat's
 *                              own zod schema, so an off-contract fixture fails loudly.
 *   lib/grok.js grokXRead      the read itself; its COST is metered for real.
 *   lib/http.js, data/solana.js  the whole network and the chain reads.
 *   the bot's custody fences    the two-RPC mint audit, the Pyth read, the simulation and
 *                              rent fences need a chain. The paper preflight runs the
 *                              COST and GEOMETRY fences and says so; it cannot speak for
 *                              the custody ones.
 *
 * Nothing here touches the live claude-co.db, the live backend, the executor's release,
 * its env or its sqlite. EXECUTE is 0 throughout and no key exists in this process.
 *
 *   node test-sim-c.mjs                       (SIM_C_COHORTS=1000 for the full run)
 */
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sim-c-"));

/* THE RAILS, SET BEFORE ANY src/ MODULE IS IMPORTED. config.js reads the environment at
   import time, and a static import would run before this block — the exact bug that made
   SIM B measure its own pace brake. Every src/ import in this file is therefore dynamic
   and appears BELOW this point. */
process.env.CLAUDE_CO_DB = path.join(TMP, "sim-c.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sim-no-network";
process.env.XAI_API_KEY = "";
process.env.DESK_PREPARE_TX = "0";
process.env.PENTHOUSE_WHALE_BUDGET_MS ??= "2000";
/* The plan's rails, at their real values. $200/day is the desk's live cap; the per-pass
   budget is config.js's own default and is left alone. */
process.env.DESK_DAILY_BUDGET_USD ??= "200";
process.env.DESK_MAX_OPEN_POSITIONS ??= "64";

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
    export const { spend, spendSince, spendBySeat, spendByLane, spendRows, openCreditBreakers,
      assertDailyBudget, meterAnthropicUsage, anthropicUsageCost, resetCreditBreakers,
      creditBreakerState, acquireCredit, noteCreditRefusal, noteCreditSuccess,
      reserveProviderBudget, withProviderBudget, noteUnpersistedProviderSpend,
      setCreditBreakerClock, setSpendClock, spendNow, SHARED_RULES, HOURLY_BURST,
      OPPORTUNISTIC_SHARE, CREDIT_BREAKER_COOLDOWN_MS, CREDIT_BREAKER_PROBE_LEASE_MS,
      CREDIT_BREAKER_STAND_DOWN_PROBES } = real;
    export const OutOfCredit = real.OutOfCredit;
    export const BudgetExhausted = real.BudgetExhausted;
    export const Refusal = real.Refusal;
    export async function ask(o) { return globalThis.__SIM.seats.ask(o, real); }
    export async function askWithWeb(o) { return globalThis.__SIM.seats.ask({ ...o, web: true }, real); }
  `,
  /* THE READ IS STUBBED; ITS BILL IS NOT. meterGrokUsage is grok.js's own meter, so the
     $0.1484-mean read lands in llm_spend through the same code the live desk uses and
     counts against the same rails. SIM B returned $0 here and left 44.9% of the live
     7-day bill out of every cost number it printed. */
  grok: `
    import * as realGrok from "${F("src/lib/grok.js")}?sim=real";
    export const GROK_MODEL = "grok-4.6";
    export const hasGrok = () => true;
    export const grokUsageCost = realGrok.grokUsageCost;
    export const meterGrokUsage = realGrok.meterGrokUsage;
    export function parseLoose(t) { try { return JSON.parse(t); } catch { return null; } }
    export async function grokAsk() { return { ok: false, error: "sim: grok seat disabled" }; }
    export async function grokXRead(o) { return globalThis.__SIM.seats.xread(o, realGrok); }
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

/* Any escape from the stub layer is a real network call. The bot leg needs a working
   fetch for its own loopback servers, so the guard records and refuses only the desk
   half's escapes and is lifted deliberately, once, when the office starts. */
const realFetch = globalThis.fetch;
let fetchSealed = true;
globalThis.fetch = async (u, init) => {
  if (!fetchSealed) return realFetch(u, init);
  globalThis.__SIM.counters.escapedFetch.push(String(u));
  throw new Error(`SIM: a real network call escaped the stub layer: ${String(u).slice(0, 120)}`);
};

/* ═══ THE MEASURED TABLES ═════════════════════════════════════════════════════════ */

/**
 * PER-(SEAT, MODEL, EFFORT) COST, FROM THE ROWS AND NOT FROM A MEAN.
 *
 * `q` is the quantile ladder [min, p10, p25, p50, p75, p90, p99, max] of the seat's own
 * live llm_spend rows over the 7 days to 2026-09-09; a draw interpolates between rungs,
 * so the tail is drawn as often as it happened. `inTok/outTok/cachedTok` are that seat's
 * mean token SHAPE over the same window (GET /api/spend/seats?hours=168): the shape sets
 * the mix, the draw sets the magnitude, and llm.js's own meter converts one into the
 * other, so the money is priced by the real pricing table and not by this file.
 *
 * Read the n column before trusting a row: CEO has ONE measured call.
 */
const SEAT_COST = new Map([
  ["XRead|grok-4.6|null", { n: 1170, q: [0.06659, 0.101324, 0.115089, 0.138865, 0.175259, 0.208417, 0.266022, 0.31552], inTok: 49094, outTok: 4646, cachedTok: 22512 }],
  ["Liquidity|claude-sonnet-5|medium", { n: 336, q: [0.019642, 0.021326, 0.022807, 0.026215, 0.037049, 0.039773, 0.047537, 0.050386], inTok: 7710, outTok: 1595, cachedTok: 2412 }],
  ["Technical|claude-sonnet-5|medium", { n: 310, q: [0.013731, 0.01548, 0.016526, 0.018854, 0.030314, 0.032553, 0.035644, 0.036964], inTok: 7895, outTok: 841, cachedTok: 2377 }],
  ["Flow|claude-sonnet-5|high", { n: 307, q: [0.036193, 0.043428, 0.048225, 0.054202, 0.063004, 0.072468, 0.083367, 0.08906], inTok: 8104, outTok: 4217, cachedTok: 2601 }],
  ["Forensics|claude-sonnet-5|high", { n: 286, q: [0.033193, 0.044331, 0.048758, 0.056854, 0.06575, 0.073053, 0.082314, 0.0852], inTok: 9097, outTok: 4326, cachedTok: 2916 }],
  ["Narrative|claude-sonnet-5|medium", { n: 280, q: [0.040928, 0.120719, 0.152454, 0.176688, 0.21311, 0.2511, 0.334067, 0.445328], inTok: 68107, outTok: 2975, cachedTok: 0 }],
  ["Narrative|claude-sonnet-5|low", { n: 272, q: [0.022227, 0.026887, 0.029213, 0.03246, 0.043368, 0.046298, 0.048644, 0.049094], inTok: 12788, outTok: 1107, cachedTok: 2246 }],
  ["Red Team|claude-opus-5|high", { n: 144, q: [0.214541, 0.26102, 0.29977, 0.334703, 0.373825, 0.412697, 0.459729, 0.47105], inTok: 15667, outTok: 10050, cachedTok: 1229 }],
  ["Risk|claude-sonnet-5|high", { n: 143, q: [0.045443, 0.052129, 0.057974, 0.063662, 0.068901, 0.073842, 0.085531, 0.094118], inTok: 19364, outTok: 2191, cachedTok: 994 }],
  ["PM|claude-opus-5|high", { n: 137, q: [0.11162, 0.135797, 0.150733, 0.17889, 0.186945, 0.19419, 0.210257, 0.21755], inTok: 22546, outTok: 1988, cachedTok: 1197 }],
  ["TrendScan|grok-4.6|null", { n: 122, q: [0.04788, 0.077666, 0.101282, 0.115058, 0.126221, 0.139197, 0.156109, 0.157216], inTok: 30961, outTok: 4642, cachedTok: 10431 }],
  ["Execution|claude-sonnet-5|medium", { n: 112, q: [0.015003, 0.031007, 0.041251, 0.045653, 0.050616, 0.055533, 0.063769, 0.068786], inTok: 7191, outTok: 2658, cachedTok: 819 }],
  ["Review|claude-sonnet-5|low", { n: 13, q: [0.014112, 0.014182, 0.014388, 0.0146, 0.015802, 0.015996, 0.016173, 0.016194], inTok: 3531, outTok: 201, cachedTok: 0 }],
  ["Best Pick|claude-opus-5|high", { n: 11, q: [0.06924, 0.071245, 0.0852, 0.089885, 0.097803, 0.102125, 0.102251, 0.102265], inTok: 7666, outTok: 1329, cachedTok: 0 }],
  ["CEO|claude-opus-5|xhigh", { n: 1, q: [0.13178, 0.13178, 0.13178, 0.13178, 0.13178, 0.13178, 0.13178, 0.13178], inTok: 15802, outTok: 1466, cachedTok: 0 }],
]);
const COST_QUANTILES = [0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.99, 1];
/* A seat with no row of its own is priced by the cheapest measured Sonnet seat rather
   than by a guess, and the fallback is counted so it can never be silently load-bearing. */
const COST_FALLBACK = SEAT_COST.get("Liquidity|claude-sonnet-5|medium");

/**
 * THE STAGE LADDER, per PAID workup (a coin that reached a seat).
 *
 * Healthy rates are the plan's measured token:end window: 100 buy the read -> 63 killed
 * by the read (59/94) -> 37 reach the trio -> 12 trio kills (34%) -> 25 reach the deep
 * pair -> 1 deep kill -> 24 reach Red Team, Risk and PM, of which 14.3 are PM-positive
 * (live decisions: 221 WATCH + 3 PROPOSE over 1,571 X reads).
 *
 * THE PLAN'S OWN STAGE TABLE DOES NOT ADD UP AND IS NOT USED AS WRITTEN: it says 24 coins
 * reach the decision seats and then lists "~6 refuted-declined, 4 PASS, 3 VETOED" (13)
 * alongside "15-16 PM-positive" (24 - 13 = 11, not 15.5). The three refusal classes are
 * therefore kept in their measured RATIO 6:4:3 and scaled to whatever is left once the
 * 14.3% headline is honoured. Live 7d confirms the shape of that ratio in the other
 * direction: VETOED 27, PASS 14+1, and the refuted arm short-circuits before it is filed.
 */
const STAGE = Object.freeze({
  xreadKill: 59 / 94,          // 0.6277
  trioKill: 12 / 35,           // 0.3429
  deepKill: 1 / 25,            // 0.04
  pmPositivePerPaid: 0.143,    // 224 PM-positive / 1,571 X reads
  refusalRatio: { redteam_refuted: 6, pm_pass: 4, ceo_decline: 3 },
  /* THE X READ'S TWO ARMS. serial_rugger is a FACT (SAFETY at every level);
     "manufactured" is the seat's opinion (JUDGMENT, waived at L3). 4:21 is the desk's
     own re-counted census of its last 100 kills. */
  xreadArms: { rugger: 4, manufactured: 21 },
  /* Which analyst does the killing, live 7d: flow 67, liquidity 1 in the trio;
     narrative 30, forensics 27 in the deep pair. */
  trioArms: { flow: 67, liquidity: 1 },
  deepArms: { narrative: 30, forensics: 27 },
});

/* INSUFFICIENT COVERAGE — "fewer than three analysts returned", which is what a billing
   refusal looks like from inside a workup (llm.js: 2,532 times in seven days). 0 in the
   healthy regime; the plan's outage figure is 302/500 = 0.604 and the live 7-day window
   is worse still — 32,427 of 32,830 paid workups, 98.8% — which is printed for scale but
   not used, because a regime that publishes nothing measures nothing. */
const P_COV = Object.freeze({ healthy: 0, outage: 0.604 });
const LIVE_7D_COVERAGE_FAILURE = 32_427 / 32_830;

/* CONVICTION, on the PM-positive rows: min 20, median 31, max 51 (the plan's measured
   triple). Drawn as a triangular distribution, and then judged by the REAL bar —
   CYCLE_MIN_CONVICTION 20 at L0/L1, the floor at L2+. The publishable fraction f is not
   imposed anywhere in this file: it is whatever publishCall does with these numbers, and
   it is printed. Step 1's ledger cannot supply a measured f — the live endpoint returns
   {pmPositive: 0, published: 0, f: null} because nothing has published since it shipped. */
const CONVICTION = Object.freeze({ min: 20, median: 31, max: 51 });

/* WATCH vs PROPOSE among PM-positive rows, live: 221 WATCH to 3 PROPOSE. */
const PM_POSITIVE_MIX = Object.freeze({ WATCH: 221, PROPOSE: 3 });

/* The share of gathered coins that die at the free screen before anything is bought.
   The plan's figure, and the one the bench-replacement loop (step 14) is sized for. */
const FREE_SCREEN_SHARE = 0.45;

/* The measured reject census, minus the fates the stage ladder now draws for itself.
   These are the coins the SAFETY floor has to refuse, and they are what keeps the
   fixture-fate NEVER audit at the bottom of this file a real test. */
const SCREEN_MIX = [
  ["post_migration_dump", 15], ["serial_deployer", 12], ["holder_concentration", 6],
  ["mintable", 6], ["thin", 5], ["freezable", 3], ["seizable", 3], ["transfer_hook", 3],
  ["frozen_by_default", 3], ["unverified_exit", 3], ["wash_suspect", 2],
  ["unverified_mint", 2], ["unverified_holders", 2], ["too_new", 3], ["no_volume", 3],
];

/* THE BOT'S MEASURED REFUSALS, as fixtures for the local Jupiter server. Every number is
   one the live bot actually printed or the operator measured:
     drift 26.04% and 8.20%   the executable-quote drift refusals of 2026-09-04/05
     RT 14% / impact 7%       the round-trip and price-impact refusals step 25 sizes to
     rent 3,742,803           a 3-ATA route under today's 4,200,000 gross cap
     rent 4,078,560           the measured 2-ATA buy, which passes
     2-hop routePlan          CONTRACT_MAX_HOPS is 1; the desk records it as a preference */
const BOT_FIXTURES = Object.freeze([
  { klass: "clean", rtPct: 1.0, impactPct: 0.5, driftPct: 0, rent: 4_078_560, hops: 1 },
  { klass: "round_trip_14pct", rtPct: 14, impactPct: 7, driftPct: 0, rent: 4_078_560, hops: 1 },
  { klass: "impact_7pct", rtPct: 2, impactPct: 7, driftPct: 0, rent: 4_078_560, hops: 1 },
  { klass: "drift_8_20pct", rtPct: 1.0, impactPct: 0.5, driftPct: 8.2, rent: 4_078_560, hops: 1 },
  { klass: "drift_26_04pct", rtPct: 1.0, impactPct: 0.5, driftPct: 26.04, rent: 4_078_560, hops: 1 },
  { klass: "rent_3_742_803", rtPct: 1.0, impactPct: 0.5, driftPct: 0, rent: 3_742_803, hops: 1 },
  { klass: "rent_over_cap", rtPct: 1.0, impactPct: 0.5, driftPct: 0, rent: 6_300_000, hops: 3 },
  { klass: "two_hop", rtPct: 1.0, impactPct: 0.5, driftPct: 0, rent: 4_078_560, hops: 2 },
]);

/* ═══ THE SYNTHETIC MARKET ════════════════════════════════════════════════════════ */

const SIM = {
  counters: { reports: 0, orderSlips: 0, seatCalls: 0, escapedFetch: [], costFallbacks: 0,
    coverageFailures: 0, grokReads: 0 },
  market: new Map(),
  universe: [],
  fateByMint: new Map(),
  deployers: new Map(),
  now: Date.now(),
  regime: "healthy",
};
globalThis.__SIM = SIM;

const coinFor = (mint) => SIM.market.get(mint) || null;
const mintInPrompt = (text) => {
  let s = String(text || "");
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

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
SIM.http = {
  async getJson(url) {
    const u = String(url);
    if (u.includes("/latest/dex/search"))
      return { ok: true, data: { pairs: SIM.universe.map((m) => coinFor(m)?.raw).filter(Boolean) } };
    if (u.includes("/latest/dex/tokens/")) {
      const mint = u.split("/latest/dex/tokens/")[1].split(/[?#]/)[0];
      const c = coinFor(mint);
      if (!c) return { ok: false, error: "sim: unknown mint" };
      return { ok: true, data: { pairs: [c.raw] } };
    }
    if (u.includes("/orders/v1/solana/")) return { ok: true, data: { orders: [] } };
    if (u.includes("token-boosts") || u.includes("token-profiles")) return { ok: true, data: [] };
    if (u.includes("coingecko")) {
      const prices = Array.from({ length: 31 }, (_, i) => [i, 100 + i]);
      return { ok: true, data: { prices } };
    }
    if (u.includes("/price/v3")) {
      const ids = new URL(u).searchParams.get("ids") || "";
      const out = {};
      for (const m of ids.split(",")) { const c = coinFor(m); if (c) out[m] = { usdPrice: c.priceUsd }; }
      return { ok: true, data: out };
    }
    if (u.includes("/swap/v1/quote")) {
      const q = new URL(u).searchParams;
      const inMint = q.get("inputMint"), outMint = q.get("outputMint");
      const amount = Number(q.get("amount"));
      const token = inMint === USDC ? outMint : inMint;
      const c = coinFor(token);
      if (!c) return { ok: false, error: "sim: unknown mint" };
      if (!c.quoteOk) return { ok: false, error: "HTTP 404" };
      const out = inMint === USDC ? Math.round(amount * 1000) : Math.round((amount / 1000) * 0.968);
      return { ok: true, data: { inAmount: String(amount), outAmount: String(out),
        priceImpactPct: "0.0012", routePlan: [{ swapInfo: { label: "SimSwap" } }] } };
    }
    if (u.includes("frontend-api-v3.pump.fun/coins?creator=")) {
      const creator = new URL(u).searchParams.get("creator");
      return { ok: true, data: SIM.deployers.get(creator) || [] };
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
SIM.chain = {
  async mintInfo(mint) { return coinFor(mint)?.mintAccount ?? { ok: false, error: "sim: no mint account" }; },
  async topHolders(mint) { return coinFor(mint)?.holders ?? { ok: false, error: "sim: no holder read" }; },
};

/* ═══ THE SEATS — REAL COST, SAMPLED VERDICT ══════════════════════════════════════ */

/** A deterministic PRNG so a surprising distribution can be reproduced exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const COST_RND = rng(90_909);

/** One draw off a seat's own quantile ladder, interpolating between rungs. */
function drawSeatUsd(seat, model, effort) {
  const key = `${seat}|${model}|${effort ?? "null"}`;
  let row = SEAT_COST.get(key);
  if (!row) {
    for (const [k, v] of SEAT_COST) if (k.startsWith(`${seat}|`)) { row = v; break; }
  }
  if (!row) { row = COST_FALLBACK; SIM.counters.costFallbacks++; }
  const u = COST_RND();
  let i = 0;
  while (i < COST_QUANTILES.length - 2 && u > COST_QUANTILES[i + 1]) i++;
  const lo = COST_QUANTILES[i], hi = COST_QUANTILES[i + 1];
  const t = hi > lo ? (u - lo) / (hi - lo) : 0;
  return { usd: row.q[i] + (row.q[i + 1] - row.q[i]) * t, row };
}

/**
 * Meter one seat call at a drawn cost, THROUGH llm.js's own meter.
 *
 * The draw is a dollar figure; the meter only speaks tokens. So the seat's measured token
 * SHAPE is scaled by whatever factor makes the real pricing table return the drawn
 * dollars — the cost model stays llm.js's, and the rails, the ledger row and the per-cycle
 * brake all see a number they computed themselves.
 */
function meterOne(real, model, seat, effort) {
  const { usd, row } = drawSeatUsd(seat, model, effort);
  const uncached = Math.max(1, row.inTok - row.cachedTok);
  const base = real.anthropicUsageCost(model, { model, usage: {
    input_tokens: uncached, output_tokens: Math.max(1, row.outTok),
    cache_read_input_tokens: row.cachedTok } }).usd;
  const k = base > 0 ? usd / base : 1;
  try {
    real.meterAnthropicUsage(model, { model, usage: {
      input_tokens: Math.round(uncached * k),
      output_tokens: Math.round(Math.max(1, row.outTok) * k),
      cache_read_input_tokens: Math.round(row.cachedTok * k),
    } }, seat, effort);
  } catch { /* metering must never fail a sim cycle */ }
  return usd;
}

const finding = (claim, value, source) => ({ claim, value: String(value), source });

function analystOut(plan, seat) {
  const kill = plan.killSeat === seat;
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

const riskOut = (plan) => ({
  risk_tier: plan.riskTier ?? "quarter",
  size_rationale: "a wounded verdict and a thin book: a quarter of the unit.",
  stop_price: plan.stop,
  stop_rationale: "below the level the thesis needs to hold.",
  liquidity_adjusted: false,
  portfolio_notes: "one of several names of this shape.",
  confidence: 0.6,
});

const pmOut = (plan) => ({
  decision: plan.pm,
  conviction: plan.conviction,
  thesis: "real ignition on a coin small enough to re-rate inside the band's window.",
  invalidation: "the deployer's wallet sells, or the hourly buyers stop accelerating.",
  time_horizon: "inside this band's hold window",
  how_red_team_was_answered: plan.pm === "PROPOSE"
    ? "the fatal attack was about reach, and the buy tape is independent of it." : "",
  key_disagreement: "flow liked the tape, forensics disliked the float.",
  watch_triggers: plan.pm === "WATCH" ? ["a second hour of accelerating buys"] : [],
  watch_rules: plan.pm === "WATCH"
    ? { price_above_usd: plan.price * 1.05, buys_h1_at_least: 80, liq_at_least_usd: null, hours: 6 }
    : null,
});

const ticketOut = (plan) => ({
  action: "BUY",
  entry_zone_low: Number((plan.price * 0.97).toFixed(12)),
  entry_zone_high: Number((plan.price * 1.03).toFixed(12)),
  entry_style: "market",
  slices: [{ pct_of_position: 100, trigger: "on publication" }],
  max_slippage_bps: 300,
  suggested_route: "SimSwap",
  stop_price: plan.stop,
  take_profit: [{ price: Number((plan.price * 1.9).toFixed(12)), pct_to_sell: 60,
    rationale: "the band's first re-rate" }],
  execution_warnings: [],
});

const ceoOut = (plan) => ({
  ruling: plan.ceo,
  one_line: plan.ceo === "APPROVE" ? "Take it, small." : plan.ceo === "HOLD" ? "Not yet." : "No.",
  reasoning: "the desk's record on this shape is mixed; the size reflects that.",
  order_size_usd: plan.ceo === "DECLINE" ? 0 : 50,
  size_change_reason: "",
  conditions: [],
  questions_for_the_desk: [],
  confidence: 0.6,
});

SIM.dryAccount = false;
SIM.seats = {
  async ask(o, real) {
    if (SIM.dryAccount) throw new real.OutOfCredit("the Anthropic balance is empty — the desk cannot think");
    SIM.counters.seatCalls++;
    const model = o.model || "claude-sonnet-5";
    meterOne(real, model, o.seat, o.effort);
    const seat = o.seat;
    if (seat === "Best Pick") {
      const mint = mintInPrompt(o.prompt);
      const c = coinFor(mint);
      return o.schema.parse({ pick_mint: mint, pick_symbol: c?.symbol ?? "?",
        why: "the freshest tape of the eligible field.", edge: "buyers accelerating against their own pace",
        runner_up_mint: null, why_not_runner_up: null, confidence: 0.6,
        expected_move: "50_to_100pct", worst_case: "the deployer sells into the first bid" });
    }
    const mint = mintInPrompt(o.prompt);
    const coin = coinFor(mint);
    if (!coin) throw new Error(`SIM: seat ${seat} was asked about a coin the fixture does not know`);
    const plan = coin.plan;
    /* THE COVERAGE FATE, AND A CORRECTION TO WHERE IT COMES FROM.
     *
     * llm.js's own comment says these rows are billing refusals — "a billing failure
     * wearing a research verdict, 2,532 times in seven days" — but that has not been true
     * since the OutOfCredit rethrow landed: BudgetExhausted EXTENDS OutOfCredit, desk.js's
     * collect() remembers any OutOfCredit and rethrows it, and the cycle HALTS instead of
     * returning insufficient_coverage. Throwing one here produced exactly that: 20 of 20
     * outage cohorts halted and not one insufficient_coverage row was written.
     *
     * So whatever is producing the live 32,427 rows is NOT classified as a credit error —
     * a transport failure, a 429, a truncated body. The fixture throws a plain Error for
     * that reason, which is what collect() files as a seat failure and what makes a
     * workup end with fewer than three analysts. The ANALYST seats fail; the decision
     * seats are never reached, so they need no arm. */
    if (plan.fate === "insufficient_coverage" &&
        ["Liquidity", "Flow", "Technical", "Forensics", "Narrative"].includes(seat)) {
      SIM.counters.coverageFailures++;
      throw new Error("provider returned HTTP 429 after 3 attempts");
    }
    let out;
    if (["Liquidity", "Flow", "Technical", "Forensics", "Narrative"].includes(seat)) out = analystOut(plan, seat);
    else if (seat === "Red Team") out = redteamOut(plan, coin);
    else if (seat === "Risk") out = riskOut(plan);
    else if (seat === "PM") out = pmOut(plan);
    else if (seat === "Execution") out = ticketOut(plan);
    else if (seat === "CEO") out = ceoOut(plan);
    else throw new Error(`SIM: no fixture for seat "${seat}"`);
    return o.schema.parse(out);
  },
  async xread({ mint }, realGrok) {
    const coin = coinFor(mint);
    const plan = coin?.plan ?? {};
    SIM.counters.grokReads++;
    /* THE READ IS FICTION; THE BILL IS THE LIVE ONE. cost_in_usd_ticks is xAI's own
       exact-billing field (grok.js grokUsageCost), so the drawn dollars go through the
       real meter untouched by any token estimate. */
    const { usd, row } = drawSeatUsd("XRead", "grok-4.6", null);
    try {
      realGrok.meterGrokUsage("XRead", { model: "grok-4.6", usage: {
        input_tokens: row.inTok, output_tokens: row.outTok,
        input_tokens_details: { cached_tokens: row.cachedTok },
        cost_in_usd_ticks: Math.round(usd * 10_000_000_000),
      } });
    } catch { /* metering must never fail a sim cycle */ }
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

/* ═══ THE STAGE SAMPLER ═══════════════════════════════════════════════════════════ */

const weighted = (rnd, table) => {
  const entries = Array.isArray(table) ? table : Object.entries(table);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries.at(-1)[0];
};

/** Triangular draw — the only shape a (min, median, max) triple determines. */
function triangular(rnd, { min, median, max }) {
  const c = (median - min) / (max - min);
  const u = rnd();
  return u < c ? min + Math.sqrt(u * (max - min) * (median - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - median));
}

/**
 * ONE PAID WORKUP'S FATE, drawn stage by stage in the order the desk buys them.
 *
 * The refusal classes at the decision seats are scaled to whatever survives the earlier
 * stages, so the PM-positive rate is the calibration target and everything else is the
 * residue — which is the only way to honour a headline (14.3%) and a ratio (6:4:3) that
 * the plan states side by side without them being consistent.
 */
function drawPaidFate(rnd, pCov, pmPositivePerPaid = STAGE.pmPositivePerPaid) {
  if (rnd() < pCov) return "insufficient_coverage";
  if (rnd() < STAGE.xreadKill) return weighted(rnd, STAGE.xreadArms);
  if (rnd() < STAGE.trioKill) return `trio_${weighted(rnd, STAGE.trioArms)}`;
  if (rnd() < STAGE.deepKill) return `deep_${weighted(rnd, STAGE.deepArms)}`;
  /* Reaching here is the share the plan calls 24 per 100. The PM-positive figure is a
     rate per PAID workup, so it is renormalised against the share that actually reaches
     the decision seats. The coverage knob is NOT in that renormalisation: a billing
     outage kills workups before any seat sees them, and the desk's judgment does not get
     better because its billing got worse — so the realised rate falls to
     0.143 x (1 - p_cov), which is what the calibration block asserts. */
  const reach = (1 - STAGE.xreadKill) * (1 - STAGE.trioKill) * (1 - STAGE.deepKill);
  const pPositive = Math.min(1, pmPositivePerPaid / reach);
  if (rnd() < pPositive) return "positive";
  return weighted(rnd, STAGE.refusalRatio);
}

/* ═══ THE CANDIDATE POPULATION ════════════════════════════════════════════════════ */

const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
let mintSeq = 0;
/* Leads with a base58 encoding of the sequence number and pads with "0", which is NOT in
   the alphabet — both collisions SIM B suffered (a truncated suffix, then a "1" pad that
   made "1c" and "c" the same six characters) are impossible by construction, and the
   audit at the bottom still cross-checks the count. */
function nextMint(pump) {
  const n = ++mintSeq;
  let tag = "", x = n;
  while (x > 0) { tag = B58[x % 58] + tag; x = Math.floor(x / 58); }
  const body = "S1M" + tag.padStart(6, "0");
  const filler = "QwErTyUiOpAsDfGhJkLzXcVbNm123456";
  return pump ? (body + filler).slice(0, 39) + "pump" : (body + filler).slice(0, 43);
}

const FLAG = {
  mintable: { flag: "mint_authority_live", detail: "supply can still be printed" },
  freezable: { flag: "freeze_authority_live", detail: "accounts can be frozen" },
  seizable: { flag: "ext_permanentDelegate", detail: "a delegate can move your tokens" },
  transfer_hook: { flag: "ext_transferHook", detail: "code runs on every transfer" },
  frozen_by_default: { flag: "ext_defaultAccountState", detail: "new accounts start frozen" },
};

/** The fates whose refusal must be produced by the REAL gate reading REAL evidence. */
const SCREEN_FATES = new Set(SCREEN_MIX.map(([k]) => k));

/**
 * One coin, built so the REAL gate for its drawn fate is what fires. A mintable coin
 * carries a live mint authority on its mint account and evidence.js/screen() kills it;
 * a "trio_flow" coin passes every deterministic gate and dies on the Flow seat's own
 * kill field. Nothing here hands the pipeline a label.
 */
function makeCoin(fate, rnd, cfg) {
  const pump = fate === "serial_deployer" || rnd() < 0.6;
  const mint = nextMint(pump);
  const symbol = `S${String(mintSeq).padStart(3, "0")}`;
  const price = 0.001 * (0.5 + rnd());
  const mcap = 120_000 + Math.round(rnd() * 700_000);
  const fl = { liq: 8_000, vol: 8_000 };
  let liq = 60_000 + Math.round(rnd() * 120_000);
  let vol24 = liq * (1.2 + rnd());
  let txns = 400 + Math.round(rnd() * 900);
  let ageHours = 60 + rnd() * 300;

  if (fate === "thin") liq = Math.round(fl.liq * 0.4);
  if (fate === "no_volume") vol24 = fl.vol * 0.3;
  if (fate === "too_new") ageHours = 0.1;
  if (fate === "wash_suspect") { vol24 = liq * (cfg.screen.maxVolToLiqRatio * 1.2); txns = 8000; }
  if (fate === "post_migration_dump") ageHours = 20;

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
            h6: { buys: 240, sells: 180 }, h1: { buys: 90, sells: 60 } },
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

  const plan = {
    fate, price, liq,
    stop: Number((price * 0.8).toFixed(12)),
    riskTier: "quarter",
    pm: "PROPOSE", ceo: "APPROVE", conviction: 68, analystScore: 62, killSeat: null,
  };
  if (fate === "positive") {
    plan.pm = weighted(rnd, PM_POSITIVE_MIX);
    plan.ceo = plan.pm === "PROPOSE" ? "APPROVE" : "HOLD";
    plan.conviction = Math.round(triangular(rnd, CONVICTION));
  } else if (fate === "pm_pass") { plan.pm = "PASS"; plan.conviction = 30; }
  else if (fate === "ceo_decline") { plan.ceo = "DECLINE"; plan.conviction = 58; }
  else if (fate === "redteam_refuted") { plan.pm = "WATCH"; plan.ceo = "HOLD"; plan.conviction = 55; }
  else if (fate.startsWith("trio_") || fate.startsWith("deep_")) {
    plan.killSeat = { trio_flow: "Flow", trio_liquidity: "Liquidity",
      deep_narrative: "Narrative", deep_forensics: "Forensics" }[fate];
  }

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

/* ═══ BOOT THE REAL DESK ══════════════════════════════════════════════════════════ */

const cfgmod = await import("./src/config.js");
const { cfg, CYCLE, MAX_ESCALATION_LEVEL } = cfgmod;
const ph = await import("./src/penthouse.js");
const calls = await import("./src/calls.js");
const store = await import("./src/lib/store.js");
const db = store.default;
const bus = await import("./src/lib/bus.js");
const llm = await import("./src/lib/llm.js");
const { spend, setSpendClock } = llm;
const { runPenthouseCycle, WORKUPS_PER_CYCLE } = ph;
const { cycleCalls, liveCalls, closeCall, settleCycles } = calls;

/* THE FLOOR THAT RECEIVES THE CALLS, INSTALLED BEFORE THE FIRST COHORT RUNS.
   publishCall broadcasts to every owned floor (penthouse.js), so a run with no owned
   floor never exercises delivery at all — and "deliverable" is one of the three numbers
   this file exists to report. One owned floor, its copy settings and its executor secret,
   exactly as the HQ is set up in life. */
const FLOOR = 50;
const SECRET = "sim-c-executor-secret-0123456789";
const copy = await import("./src/copy.js");
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run("SimC1111111111111111111111111111111111111111", "SIM C Capital", Date.now(), FLOOR);
copy.settingsFor(FLOOR);
db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=?").run(SECRET, FLOOR);

/* THE CLOCK THE MONEY RAILS RUN ON. Nothing else in the desk reads it: calls.js still
   stamps wall-clock times, so a cohort's own age and the 6h deadlock guard are unaffected
   and only llm.js's spend windows move. */
setSpendClock(() => SIM.now);

let pass = 0, fail = 0;
const DEFECTS = [];
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const should = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
  : (DEFECTS.push({ n, d }), console.log(`  DEFECT ${n}${d ? "  — " + d : ""}`)); };
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const money = (n) => `$${Number(n).toFixed(2)}`;
const quantile = (sorted, p) => {
  if (!sorted.length) return 0;
  const x = p * (sorted.length - 1), i = Math.floor(x), f = x - i;
  return i + 1 >= sorted.length ? sorted[i] : sorted[i] + (sorted[i + 1] - sorted[i]) * f;
};

/* Only the event kinds this file reads are kept: a thousand cohorts emit millions of
   events and a full tape is a memory leak wearing a record. */
const TAPE_KINDS = new Set(["cycle:end", "cycle:paced", "cycle:budget", "cycle:halted",
  "cycle:short", "call:published", "call:withheld"]);
const TAPE = [];
/* WHAT THE SAMPLER ACTUALLY PRODUCED, counted rather than stored: token:end fires once per
   gathered coin and there are millions of them in a full run. This is the ruler's own
   read-back — the sampler says what it intends, the desk says what it did, and the two are
   printed side by side. */
let OUTCOMES = {};
bus.bus.setMaxListeners(200);
bus.bus.on("event", (ev) => {
  if (ev.type === "token:end") OUTCOMES[ev.outcome] = (OUTCOMES[ev.outcome] ?? 0) + 1;
  if (TAPE_KINDS.has(ev.type)) TAPE.push({ kind: ev.type, ...ev });
});

const resetBook = () => {
  for (const c of liveCalls()) closeCall(c.id, "sim reset", 1);
  settleCycles();
  db.prepare("UPDATE cycles SET closed_at=?, close_reason=? WHERE closed_at IS NULL")
    .run(Date.now(), "sim: scenario boundary");
};

/** Build a population: FREE_SCREEN_SHARE from the safety census, the rest paid workups
 *  whose fate is drawn stage by stage. */
function population(total, seed, pCov, pmPositive) {
  const rnd = rng(seed);
  const coins = [];
  for (let i = 0; i < total; i++) {
    const fate = rnd() < FREE_SCREEN_SHARE
      ? weighted(rnd, SCREEN_MIX) : drawPaidFate(rnd, pCov, pmPositive);
    coins.push(makeCoin(fate, rnd, cfg));
  }
  return coins;
}

function installUniverse(coins) {
  SIM.market = new Map(coins.map((c) => [c.mint, c]));
  if (SIM.market.size !== coins.length)
    throw new Error(`SIM: mint collision — ${coins.length} coins, ${SIM.market.size} distinct mints`);
  SIM.universe = coins.map((c) => c.mint);
  const ins = db.prepare(`INSERT OR IGNORE INTO snapshots (mint,ts,price,liq,vol24,buys,sells,fdv)
                          VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of coins) {
    if (c.plan.fate !== "post_migration_dump") continue;
    ins.run(c.mint, Date.now() - 3600e3, c.priceUsd * 3, c.plan.liq, 1000, 10, 10, 1e6);
  }
}

/* HOW MUCH VIRTUAL TIME PASSES BETWEEN TWO PASSES — and why an hour.
 *
 * This is the one free parameter in the money half, so it is set where the plan's own two
 * numbers agree rather than by taste: a pass is funded to $16 and the day is capped at
 * $200, so 24 passes a day is the cadence at which the desk can spend its pass budget
 * without the day's cap refusing it. At 15 minutes (the first value tried) the desk wants
 * ~$720 a day, the hourly pace refuses three passes in four, and the distribution measures
 * the brake instead of the funnel — which is exactly the mistake SIM B made by accident.
 * The rails still run, and every rail stop is counted and reported separately. */
const PASS_PERIOD_MS = Number(process.env.SIM_C_PASS_PERIOD_MS || 60 * 60_000);

async function cyclePass(coins) {
  installUniverse(coins);
  const at = TAPE.length;
  const before = spend.usd;
  const r = await runPenthouseCycle({});
  SIM.now += PASS_PERIOD_MS;
  return { r, events: TAPE.slice(at), costUsd: spend.usd - before };
}

console.log("\n══ SIMULATION C · the desk's quota AND the bot's take rate, end to end ══");
console.log(`   db=${process.env.CLAUDE_CO_DB}`);
console.log(`   quota=${CYCLE.quota} maxLevel=${MAX_ESCALATION_LEVEL} workups/pass=${WORKUPS_PER_CYCLE} ` +
  `cycleBudget=$${process.env.PENTHOUSE_CYCLE_BUDGET_USD ?? cfgmod.CYCLE_BUDGET_DEFAULT_USD} ` +
  `dailyBudget=$${cfg.dailyBudgetUsd} hourlyPace=$${Math.max(cfg.dailyBudgetUsd / 24 * llm.HOURLY_BURST,
    Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || cfgmod.CYCLE_BUDGET_DEFAULT_USD) * 1.25).toFixed(2)}`);

/* ─── THE RULER, BEFORE ANYTHING IS RANKED ON IT ──────────────────────────────────
   A sampler is a measuring instrument, and an instrument is checked against a case whose
   answer is already known before it is used. 200,000 draws, both regimes. */
console.log("\nCALIBRATION — the sampler reproduces the rates it was calibrated on");
{
  for (const [label, pCov] of Object.entries(P_COV)) {
    const rnd = rng(4242);
    const N = 200_000;
    const hist = {};
    for (let i = 0; i < N; i++) { const f = drawPaidFate(rnd, pCov); hist[f] = (hist[f] ?? 0) + 1; }
    const positive = (hist.positive ?? 0) / N;
    const cov = (hist.insufficient_coverage ?? 0) / N;
    const want = STAGE.pmPositivePerPaid * (1 - pCov);
    ok(`${label}: PM-positive per paid workup is the calibration target`,
      Math.abs(positive - want) < 0.004,
      `sampled ${(positive * 100).toFixed(2)}% · target ${(want * 100).toFixed(2)}% ` +
      `(14.3% x (1 - p_cov ${pCov}))`);
    ok(`${label}: insufficient_coverage is the knob, exactly`,
      Math.abs(cov - pCov) < 0.004, `sampled ${(cov * 100).toFixed(2)}% · knob ${(pCov * 100).toFixed(1)}%`);
    const refused = ["redteam_refuted", "pm_pass", "ceo_decline"].map((k) => hist[k] ?? 0);
    console.log(`     ${label}: xread ${pct((hist.rugger ?? 0) + (hist.manufactured ?? 0), N)} · ` +
      `trio ${pct((hist.trio_flow ?? 0) + (hist.trio_liquidity ?? 0), N)} · ` +
      `deep ${pct((hist.deep_narrative ?? 0) + (hist.deep_forensics ?? 0), N)} · ` +
      `refuted/PASS/VETO ${refused.map((n) => pct(n, N)).join("/")} · positive ${pct(hist.positive ?? 0, N)}`);
  }
  console.log(`     the live 7-day window was worse than the outage knob: ` +
    `${(LIVE_7D_COVERAGE_FAILURE * 100).toFixed(1)}% of 32,830 paid workups ended insufficient_coverage`);
  const rnd = rng(77);
  const convs = Array.from({ length: 100_000 }, () => triangular(rnd, CONVICTION)).sort((a, b) => a - b);
  ok("conviction is drawn on the measured triple, and never below the bar's floor",
    convs[0] >= CONVICTION.min && convs.at(-1) <= CONVICTION.max,
    `min ${convs[0].toFixed(1)} p50 ${quantile(convs, 0.5).toFixed(1)} max ${convs.at(-1).toFixed(1)} ` +
    `(measured 20/31/51) · CYCLE_MIN_CONVICTION ${CYCLE.minConviction}`);
  const draws = Array.from({ length: 20_000 }, () => drawSeatUsd("XRead", "grok-4.6", null).usd).sort((a, b) => a - b);
  ok("the grok read is drawn from its own measured ladder, tail included",
    Math.abs(quantile(draws, 0.5) - 0.138865) < 0.006 && draws.at(-1) > 0.30,
    `p50 $${quantile(draws, 0.5).toFixed(4)} (measured $0.1389) · p90 $${quantile(draws, 0.9).toFixed(4)} ` +
    `(measured $0.2084) · max $${draws.at(-1).toFixed(4)} (measured $0.3155)`);
}

/* ═══ THE DISTRIBUTION ════════════════════════════════════════════════════════════ */

/* THE SUITE DEFAULT IS NOT THE PROOF. The plan asks for N >= 1000 cohorts per regime for
   the headline probabilities, which is about an hour of real cycles; the default here is
   sized to the deploy gate (three regimes plus the bot leg inside a couple of minutes) and
   the standard error at that N is printed with every headline so a small run cannot be
   quoted as a large one. Run the proof with SIM_C_COHORTS=1000. */
const COHORTS = Number(process.env.SIM_C_COHORTS || 25);
const POP = Number(process.env.SIM_C_POP || 80);

async function runRegime(label, pCov, seedBase, pmPositive = STAGE.pmPositivePerPaid) {
  const rows = [];
  OUTCOMES = {};
  resetBook();
  const t0 = Date.now();
  for (let n = 0; n < COHORTS; n++) {
    let cycleId = null, passes = 0, maxLevel = 0, thirdAtLevel = null, publishedNow = 0;
    let cost = 0, railStops = 0, workedUp = 0;
    const perPass = [];
    for (let p = 0; p <= MAX_ESCALATION_LEVEL; p++) {
      const coins = population(POP, seedBase + n * 37 + p, pCov, pmPositive);
      const { r, events, costUsd } = await cyclePass(coins);
      cost += costUsd;
      /* A RAIL STOP MEANS THE COHORT PASS WAS STOPPED, NOT THAT A SCANNING LANE YIELDED.
         The first version counted every cycle:paced / cycle:budget event, and the hunt
         and fresh lanes are OPPORTUNISTIC (llm.js OPPORTUNISTIC_SHARE): they are supposed
         to hit their reserved share and stand down, several times a day, while the cohort
         pass runs on untouched. Counting those made 186 of 250 outage cohorts look
         money-stopped when their own walk had not been. Only the "cycle" lane's own
         refusals, and a halt of the pass itself, count here. */
      railStops += events.filter((e) =>
        ((e.kind === "cycle:paced" || e.kind === "cycle:budget") && e.lane === "cycle") ||
        (e.kind === "cycle:halted" && e.reason === "daily_budget")).length;
      if (r.skipped) { perPass.push(`skip:${r.skipped}`); break; }
      passes++;
      workedUp += Number(r.workedUp) || 0;
      cycleId = r.cycleId ?? cycleId;
      maxLevel = Math.max(maxLevel, r.level ?? 0);
      const before = publishedNow;
      publishedNow = cycleId ? cycleCalls(cycleId).length : 0;
      perPass.push(`L${r.level}:+${publishedNow - before}`);
      if (thirdAtLevel == null && publishedNow >= CYCLE.quota) thirdAtLevel = r.level;
      if (publishedNow >= CYCLE.quota) break;
    }
    /* DELIVERABLE, off the desk's own deliveries table rather than off a claim: one row
       per call per owned floor, written by copy.broadcast inside publishCall. */
    const delivered = cycleId ? db.prepare(
      `SELECT COUNT(DISTINCT d.call_id) n FROM deliveries d JOIN calls c ON c.id = d.call_id
       WHERE d.floor_no = ? AND d.verdict = 'offered' AND c.cycle_id = ?`).get(FLOOR, cycleId).n : 0;
    rows.push({ n, cycleId, passes, maxLevel, thirdAtLevel, published: publishedNow, delivered,
      reached: publishedNow >= CYCLE.quota, cost, railStops, workedUp,
      perPass: perPass.join(" ") });
    for (const c of liveCalls()) closeCall(c.id, "sim: the cohort closed", 1.0);
    settleCycles();
    resetBook();
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const reached = rows.filter((r) => r.reached);
  const clean = rows.filter((r) => r.railStops === 0);
  const cleanReached = clean.filter((r) => r.reached);
  const costs = rows.map((r) => r.cost).sort((a, b) => a - b);
  const published = rows.reduce((a, r) => a + r.published, 0);
  const spentTotal = rows.reduce((a, r) => a + r.cost, 0);
  console.log(`\n  ${label.toUpperCase()} REGIME (p_cov ${pCov}, ` +
    `${(pmPositive * (1 - pCov) * 100).toFixed(2)}% PM-positive per paid workup) · ` +
    `${COHORTS} cohorts, ${POP} coins a pass  [${elapsed}s]`);
  console.log(`    P(published >= ${CYCLE.quota} per cohort) = ${pct(reached.length, rows.length)}  ` +
    `(${reached.length}/${rows.length})`);
  console.log(`    ...among cohorts NO rail ever stopped:      ${pct(cleanReached.length, clean.length)}  ` +
    `(${cleanReached.length}/${clean.length})   — the other ${rows.length - clean.length} met a money rail, not a market`);
  const byLevel = [0, 1, 2, 3, 4].map((l) => [l, reached.filter((r) => r.thirdAtLevel === l).length]);
  console.log(`    the level the third call completed at: ` +
    byLevel.filter(([, c]) => c).map(([l, c]) => `L${l}:${c} (${pct(c, rows.length)})`).join("  ") || "    (none reached)");
  const cum = [];
  for (const l of [0, 1, 2, 3, 4]) {
    const n = reached.filter((r) => r.thirdAtLevel <= l).length;
    cum.push(`by L${l} ${pct(n, rows.length)}`);
  }
  console.log(`    cumulative: ${cum.join("  ")}`);
  console.log(`    cost per cohort: p50 ${money(quantile(costs, 0.5))}  p90 ${money(quantile(costs, 0.9))}  ` +
    `max ${money(costs.at(-1))}  ·  total ${money(spentTotal)} for ${published} published calls ` +
    `= ${published ? money(spentTotal / published) : "n/a"} per published call`);
  const passHist = {};
  for (const r of rows) passHist[r.passes] = (passHist[r.passes] ?? 0) + 1;
  console.log(`    passes a cohort needed: ` +
    Object.entries(passHist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}->${v}`).join("  "));
  /* WHAT A PASS ACTUALLY BOUGHT. The ladder asks for 24 paid workups at L0 and 48 at L1+,
     but a pass is funded to $16 and a paid workup costs what the seat ladder above draws,
     so the BUDGET bounds the pass before the ladder's own multiplier does. */
  const totalPasses = rows.reduce((a, r) => a + r.passes, 0);
  const totalWorked = rows.reduce((a, r) => a + r.workedUp, 0);
  const budget = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || cfgmod.CYCLE_BUDGET_DEFAULT_USD);
  const perWorkup = totalWorked ? spentTotal / totalWorked : 0;
  console.log(`    paid workups a pass actually bought: ${(totalWorked / Math.max(1, totalPasses)).toFixed(1)} ` +
    `mean at ${money(perWorkup)} each (the ladder asks for ${WORKUPS_PER_CYCLE} at L0 and ` +
    `${WORKUPS_PER_CYCLE * 2} at L1+; $${budget} a pass buys ~${perWorkup > 0 ? Math.round(budget / perWorkup) : "?"})`);
  /* THE READ-BACK. `free` are the outcomes that cost nothing (the screen, a missing pair),
     so the denominator here is the PAID workups the sampler was calibrated per. */
  const outcomes = { ...OUTCOMES };
  const free = new Set(["screened_out", "no_data", "error", "credit_outage", "workup_error"]);
  const paidEnds = Object.entries(outcomes).filter(([k]) => !free.has(k))
    .reduce((a, [, n]) => a + n, 0);
  const covEnds = outcomes.insufficient_coverage ?? 0;
  const positiveEnds = (outcomes.WATCH ?? 0) + (outcomes.PROPOSE ?? 0) + (outcomes.APPROVED ?? 0);
  console.log(`    token:end, as the DESK recorded it: ` +
    Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  "));
  ok(`${label}: the desk's own token:end mix reproduces the sampler's coverage knob`,
    paidEnds === 0 || Math.abs(covEnds / paidEnds - pCov) < 0.08,
    `insufficient_coverage ${covEnds}/${paidEnds} paid ends = ${pct(covEnds, paidEnds)} · knob ${(pCov * 100).toFixed(1)}%`);
  /* THE RATE THE DESK REALISES IS NOT THE RATE THE SAMPLER DRAWS, and the gap is the
     desk's own doing: a pass is not only the cohort walk. The promotion lane re-examines
     coins the PM already WATCHED — a positive-fate coin by construction — through the
     whole gauntlet again, and the hunt lane and the fresh lane buy workups of their own.
     Every one of those emits its own token:end, so positives are counted more than once
     while the kills behind them are counted once. The plan's per-workup arithmetic reads
     this share as if it were the per-candidate rate; it is not, and the difference is
     printed rather than reconciled away. */
  const positiveShare = paidEnds ? positiveEnds / paidEnds : 0;
  const target = pmPositive * (1 - pCov);
  should(`${label}: the desk's realised PM-positive share is the rate the sampler drew`,
    Math.abs(positiveShare - target) < 0.03,
    `realised ${(positiveShare * 100).toFixed(2)}% of ${paidEnds} paid ends vs ` +
    `${(target * 100).toFixed(2)}% drawn per candidate — the surplus is the promotion, ` +
    `hunt and fresh lanes working up coins the cohort walk already judged`);
  const deliverable = rows.filter((r) => r.delivered >= CYCLE.quota).length;
  console.log(`    deliverable >= ${CYCLE.quota}: ${deliverable}/${rows.length} — every published call ` +
    `carried an 'offered' delivery row to the floor (${rows.reduce((a, r) => a + r.delivered, 0)} of ` +
    `${rows.reduce((a, r) => a + r.published, 0)} published)`);
  const byL = (l) => reached.filter((r) => r.thirdAtLevel <= l).length / rows.length;
  /* THE PLAN'S ARITHMETIC IS ABOUT THE FUNNEL, NOT THE BUDGET, so it is judged on the
     cohorts no money rail ever stopped — and the count of those is printed beside it, so
     a claim resting on two cohorts cannot pass unnoticed. */
  const byLClean = (l) => (clean.length
    ? cleanReached.filter((r) => r.thirdAtLevel <= l).length / clean.length : null);
  return { label, pCov, pmPositive, rows, reached, clean, cleanReached, costs, published,
    spentTotal, deliverable, byL, byLClean };
}

console.log("\n══ THE COHORT DISTRIBUTION · the real cycle, the real rails, an injected clock ══");
const HEALTHY = await runRegime("healthy", P_COV.healthy, 300_000);
const OUTAGE = await runRegime("outage", P_COV.outage, 700_000);
/* THE PLAN'S OWN "BLENDED" RATE — 19 positives over 500 workups, of which 302 ended
   insufficient_coverage. It is neither the healthy rate nor the outage knob but the
   average of a window that contained both, and the plan's headline arithmetic
   (P >= 0.95 by L3, 0.99 by L4) is stated against it, so it is run as its own regime
   rather than approximated by one of the other two. */
const BLENDED_RATE = 19 / 500;
const BLENDED = await runRegime("blended", 0, 1_100_000, BLENDED_RATE);

console.log("\nTHE PLAN'S OWN ARITHMETIC, CONFIRMED OR REFUTED");
should(`at the healthy 14.3% the quota is reached with P >= 0.99 by L1`,
  HEALTHY.byLClean(1) >= 0.99,
  `measured P(published >= ${CYCLE.quota} by L1) = ${((HEALTHY.byLClean(1) ?? 0) * 100).toFixed(1)}% ` +
  `over the ${HEALTHY.clean.length} rail-clean cohorts (all ${HEALTHY.rows.length}: ` +
  `${(HEALTHY.byL(1) * 100).toFixed(1)}%) — plan: 0.69 at L0 rising past 0.999 by L1; ` +
  `this run L0 ${((HEALTHY.byLClean(0) ?? 0) * 100).toFixed(1)}%`);
should(`at the blended ${(BLENDED_RATE * 100).toFixed(1)}% the quota is reached with P >= 0.95 by L3`,
  BLENDED.byLClean(3) >= 0.95,
  `measured P(published >= ${CYCLE.quota} by L3) = ${((BLENDED.byLClean(3) ?? 0) * 100).toFixed(1)}% ` +
  `over the ${BLENDED.clean.length} rail-clean cohorts (all ${BLENDED.rows.length}: ` +
  `${(BLENDED.byL(3) * 100).toFixed(1)}%) — plan: 0.95 by L3, 0.99 by L4; ` +
  `this run by L4 ${((BLENDED.byLClean(4) ?? 0) * 100).toFixed(1)}%`);
should("the outage regime is a market problem the ladder cannot solve, and says so",
  OUTAGE.rows.every((r) => r.reached || r.maxLevel === MAX_ESCALATION_LEVEL || r.railStops > 0),
  `${OUTAGE.reached.length}/${OUTAGE.rows.length} reached; ` +
  `${OUTAGE.rows.filter((r) => r.railStops > 0).length} met a money rail`);

/* ─── THE PUBLISHABLE FRACTION, MEASURED HERE BECAUSE IT CANNOT BE MEASURED LIVE ── */
console.log("\nTHE PUBLISHABLE FRACTION f — PM-positive rows that actually became calls");
{
  const hist = calls.publishabilityHistogram();
  const gates = Object.entries(hist.byGate ?? {}).sort((a, b) => b[1] - a[1]);
  const total = gates.reduce((a, [, n]) => a + n, 0);
  const publishedRows = hist.byGate?.published ?? 0;
  const f = total ? publishedRows / total : null;
  console.log(`    publishability ledger: ${gates.map(([g, n]) => `${g}:${n}`).join("  ") || "(empty)"}`);
  ok("the publishability ledger recorded a verdict for every PM-positive row",
    total > 0, `${total} rows · f = ${f == null ? "n/a" : f.toFixed(3)} (the plan held f = 0.7 as a hypothesis)`);
  console.log(`    live /api/decisions/histogram on 2026-09-09 returned {pmPositive: 0, published: 0, ` +
    `f: null} — the desk has published nothing since step 1's ledger shipped, so this is a ` +
    `PREDICTION from the measured conviction triple and the real bar, not a measurement.`);
}

/* ═══ THE AUDIT ═══════════════════════════════════════════════════════════════════ */

console.log("\n══ AUDIT · every call published in this run, read back off the calls table ══");
const NEVER = new Set(["mintable", "freezable", "seizable", "transfer_hook", "frozen_by_default",
  "holder_concentration", "unverified_exit", "unverified_mint", "unverified_holders",
  "serial_deployer", "post_migration_dump", "rugger", "thin", "no_volume", "too_new",
  "wash_suspect", "redteam_refuted", "pm_pass", "ceo_decline", "insufficient_coverage",
  "trio_flow", "trio_liquidity", "deep_narrative", "deep_forensics"]);
{
  const all = db.prepare("SELECT * FROM calls").all();
  const flagged = all.filter((c) => {
    const f = c.flags_at_call ? JSON.parse(c.flags_at_call) : [];
    return f.some((x) => /mint_authority_live|freeze_authority_live|ext_/.test(String(x)));
  });
  ok(`no published call carries a honeypot flag (${all.length} calls)`, flagged.length === 0,
    flagged.length ? flagged.map((c) => `${c.symbol}:${c.flags_at_call}`).join(" ") : `0 of ${all.length}`);
  const badStop = all.filter((c) => !(c.stop > 0) || !(c.entry_ref > 0) || c.stop >= c.entry_ref);
  ok("every published call has a usable stop below its entry", badStop.length === 0,
    badStop.length ? badStop.map((c) => `${c.symbol} stop=${c.stop} entry=${c.entry_ref}`).join(" ")
      : `all ${all.length} manageable`);
  const unprobed = all.filter((c) => c.rt_loss_at_call == null);
  ok("every published call had a completed round-trip probe", unprobed.length === 0,
    unprobed.length ? unprobed.map((c) => c.symbol).join(" ") : `all ${all.length} carry a measured round trip`);
  ok("no real network call escaped the stub layer during the desk half",
    SIM.counters.escapedFetch.length === 0,
    SIM.counters.escapedFetch.slice(0, 3).join(" ") || "0 escapes");
  ok("the fixture's own coin identities never collided",
    SIM.fateByMint.size === mintSeq, `${mintSeq} coins built, ${SIM.fateByMint.size} distinct mints`);
  const fates = {};
  for (const c of all) { const f = SIM.fateByMint.get(c.mint) ?? "?"; fates[f] = (fates[f] ?? 0) + 1; }
  const leaked = all.filter((c) => NEVER.has(SIM.fateByMint.get(c.mint)));
  ok("no coin the fixture made unsafe or team-refused was ever published",
    leaked.length === 0,
    leaked.length ? leaked.map((c) => `${c.symbol}=${SIM.fateByMint.get(c.mint)}@L${c.escalation_level}`).join(" ")
      : `published fates: ${Object.entries(fates).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  /* LANE CALLS, DRIVEN RATHER THAN COUNTED. The first version of this filtered the calls
     table for cycle_id IS NULL and asserted a property of the empty set — the cohort walk
     published no lane calls in this run, so it passed by saying nothing. A lane call is
     therefore MADE here, inside an open cohort, and the cohort's own count is read before
     and after: the fresh, promote and trend lanes publish with cycleId null (calls.js
     :132-135) and the owner has not reversed that, so a cohort that is short of quota
     stays short no matter how busy the lanes are. */
  {
    const openCyc = calls.openNewCycle({ quota: CYCLE.quota });
    const before = cycleCalls(openCyc.id).length;
    const lane = calls.openCall({
      mint: nextMint(false), symbol: "LANE1", category: "memecoin", launchpad: "pump.fun",
      conviction: 60, entryRef: 0.001, entryLo: 0.0009, entryHi: 0.0011,
      stop: 0.00075, target: 0.0015, thesis: "a lane call, published with no cohort",
      invalidation: "n/a", liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 250_000, cycleId: null,
    });
    const after = cycleCalls(openCyc.id).length;
    const status = calls.cycleStatus();
    ok("a call published with no cycle id does not count towards an OPEN cohort's quota",
      lane != null && lane.cycle_id == null && after === before &&
      (status?.published ?? 0) === before,
      `lane call ${lane?.id} (cycle_id=${lane?.cycle_id}) · cohort ${openCyc.id} calls ` +
      `${before} -> ${after}, published_count ${status?.published ?? "n/a"} of quota ${status?.quota}`);
    calls.closeCall(lane.id, "sim: lane call retired", 1);
    settleCycles();
  }
  const laneCalls = all.filter((c) => c.cycle_id == null);
  console.log(`  lane calls the cohort walk itself published: ${laneCalls.length} of ${all.length}`);
  ok("the cost model never fell back to a seat it had no measured row for",
    SIM.counters.costFallbacks === 0, `${SIM.counters.costFallbacks} fallback(s)`);
  console.log(`  seats asked: ${SIM.counters.seatCalls}  ·  grok reads metered: ${SIM.counters.grokReads}  ·  ` +
    `coverage failures produced: ${SIM.counters.coverageFailures}  ·  metered spend: ${money(spend.usd)}`);
  const bySeat = llm.spendBySeat({ hours: 24 * 365 });
  console.log(`  the bill this run, by seat: ` + bySeat.seats.slice(0, 6)
    .map((s) => `${s.seat} ${money(s.usd)} (${s.pctOfTotal}%, $${s.usdPerCall}/call)`).join("  ·  "));
  const grokShare = bySeat.seats.filter((s) => s.model === "grok-4.6").reduce((a, s) => a + s.usd, 0);
  ok("the reputation read is a real line item in this run, as it is in the live bill",
    grokShare > 0, `xAI ${money(grokShare)} of ${money(bySeat.totalUsd)} = ` +
    `${pct(grokShare, bySeat.totalUsd)} (live 7d: 44.9%) — SIM B metered it at $0`);
}

/* ─── THE PER-CYCLE BRAKE ─────────────────────────────────────────────────────────
   The plan's bound: a pass may overshoot CYCLE_BUDGET_USD by at most one survivor. */
console.log("\nTHE PER-PASS MONEY BRAKE — how far past its budget a pass ever ran");
{
  const budget = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || cfgmod.CYCLE_BUDGET_DEFAULT_USD);
  const ends = TAPE.filter((e) => e.kind === "cycle:end" && Number.isFinite(Number(e.spendUsd)))
    .map((e) => Number(e.spendUsd));
  const over = ends.filter((c) => c > budget);
  const worst = over.length ? Math.max(...over) : 0;
  should("no pass ever spent more than one survivor past its budget",
    over.length === 0 || worst - budget <= 1.0,
    over.length === 0
      ? `0 of ${ends.length} passes finished over $${budget}; the dearest was ${money(Math.max(0, ...ends))}`
      : `${over.length} of ${ends.length} passes finished over $${budget}; worst ${money(worst)} ` +
        `= ${money(worst - budget)} over (a fully-worked survivor is ~$1.0)`);
}

/* ═══ THE BOT LEG ═════════════════════════════════════════════════════════════════
 *
 * The desk half above is a distribution; this half is a wiring proof plus a per-class
 * measurement. The real executor/poller.mjs runs as a subprocess against the real office
 * and is driven PAST the paper return (PAPER_PREFLIGHT=1) into the executable-cost and
 * executable-quote fences, quoting against a local Jupiter server that serves the
 * measured live refusals. What it cannot do is run the CUSTODY fences — the two-RPC mint
 * audit, the Pyth read, the simulation and the on-chain rent facts need a chain — so the
 * take rate below is an upper bound on the geometry-and-cost half only, and says so.
 */
console.log("\n══ THE BOT LEG · the real poller, past the paper return, into the fences ══");

fetchSealed = false;                        // the loopback servers below are this file's own
setSpendClock(null);                        // wall clock again: the office and the bot use it

/* @solana/web3.js is installed under executor/, not at the root — the desk deliberately
   does not carry it (entry-contract.mjs says so). Resolved from the executor's own
   node_modules rather than added to the root, which would put a chain library in the
   dependency graph of every desk module for the sake of one test. */
const { Keypair } = createRequire(path.join(REPO, "executor/")) ("@solana/web3.js");
const { WSOL } = await import("./executor/jupiter.mjs");
const { MAX_ROUTE_HALVINGS } = await import("./executor/entry-sizing.mjs");
const { startOffice, executorFeedPayload } = await import("./src/office.js");
const { openCall, getCall, noteEvent, evaluateExit } = calls;
const { announceExit } = await import("./src/alerts.js");
const { bandForMarketCap } = await import("./src/bands.js");
const { ExecutionJournal } = await import("./executor/journal.mjs");
const { freshState } = await import("./executor/strategy.mjs");

const POLLER = path.join(REPO, "executor", "poller.mjs");
const wallet = Keypair.generate();
const keypairFile = path.join(TMP, "burner.json");
fs.writeFileSync(keypairFile, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
resetBook();

/* THE LOCAL JUPITER. One fixture per mint, keyed when the call is published: the same
   /order shape the real API returns, with the round trip, impact, drift, rent and hop
   count set to the measured refusal being reproduced. `driftPct` is expressed by moving
   the quoted output away from the mark the desk published, which is exactly what the
   live 8.20% and 26.04% refusals were. */
const FIXTURE_BY_MINT = new Map();
const ENTRY_PRICE = 0.001;
const PAPER_SOL_USD = 150;
const DECIMALS = 6;
/* THE CLIP THE FIXTURES ARE QUOTED AT. strategy.mjs DEFAULTS.fixedSol — the size the bot
   actually asks for, and the size every measured refusal was measured at. */
const FIXTURE_CLIP_SOL = 0.4;

/**
 * ONE QUOTE MODEL, USED BY THE HTTP SERVER AND BY THE BEFORE/AFTER MATRIX, so the two
 * measurements cannot drift apart.
 *
 * Round-trip loss and price impact are LINEAR IN SIZE here. They have to be a function of
 * size or the halving ladder is untestable — a constant 14% stays 14% at every rung and
 * the ladder measures nothing. Linear is the simplest monotone curve that reproduces the
 * plan's own fixture (14% at 0.4 SOL, ~6% at 0.2, ~3% at 0.1); a real AMM is convex, so
 * this is the conservative shape.
 *
 * The DRIFT moves the executable mark away from the one the desk published and moves the
 * reverse leg with it, so a coin that has re-priced does not also read as a coin with a
 * ruinous round trip. That separation is the point: they are different refusals.
 */
function fixtureQuote(fx, inputMint, inAmountRaw) {
  const mark = ENTRY_PRICE * (1 + fx.driftPct / 100);
  if (inputMint === WSOL) {
    const sol = Number(inAmountRaw) / 1e9;
    const scale = sol / FIXTURE_CLIP_SOL;
    return { outAmount: String(Math.max(1, Math.floor(sol * PAPER_SOL_USD / mark * 10 ** DECIMALS))),
      impactPct: fx.impactPct * scale, mark };
  }
  const tokens = Number(inAmountRaw) / 10 ** DECIMALS;
  const sol = tokens * mark / PAPER_SOL_USD;
  const scale = sol / FIXTURE_CLIP_SOL;
  return { outAmount: String(Math.max(1, Math.floor(sol * 1e9 * (1 - fx.rtPct * scale / 100)))),
    impactPct: fx.impactPct * scale, mark };
}

const jupiterStub = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.searchParams;
  const inputMint = p.get("inputMint"), outputMint = p.get("outputMint");
  const inAmount = String(p.get("amount"));
  const token = inputMint === WSOL ? outputMint : inputMint;
  const fx = FIXTURE_BY_MINT.get(token) ?? BOT_FIXTURES[0];
  const { outAmount, impactPct } = fixtureQuote(fx, inputMint, inAmount);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    mode: "manual", inputMint, outputMint, inAmount, outAmount,
    otherAmountThreshold: String(Math.max(1, Math.floor(Number(outAmount) * 0.97))),
    swapMode: "ExactIn", slippageBps: 300, priceImpact: impactPct,
    feeBps: 50, feeMint: WSOL, platformFee: { amount: "5", feeBps: 10, feeMint: WSOL },
    signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000,
    rentFeeLamports: fx.rent,
    routePlan: Array.from({ length: fx.hops }, (_, i) => ({ swapInfo: { label: `SimHop${i}` } })),
    router: "metis", transaction: Buffer.alloc(600).toString("base64"),
    lastValidBlockHeight: "900", requestId: "sim-c", taker: wallet.publicKey.toBase58(),
  }));
});
await new Promise((r) => jupiterStub.listen(0, "127.0.0.1", r));
const JUP_PORT = jupiterStub.address().port;

/* The bot's Jupiter base MUST be https:// — jupiter.mjs refuses anything else, and that
   fence is not weakened here. A preloaded module redirects that one host to the loopback
   server instead, so the poller runs with every boot fence intact. */
const REDIRECT = path.join(TMP, "jupiter-redirect.mjs");
fs.writeFileSync(REDIRECT, `
const HOST = "https://jupiter.sim-c.invalid";
const LOCAL = "http://127.0.0.1:${JUP_PORT}";
const real = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  return real(u.startsWith(HOST) ? LOCAL + u.slice(HOST.length) : u, init);
};
`);

const { server: office } = startOffice(0);
await once(office, "listening");
const API = `http://127.0.0.1:${office.address().port}`;

class Bot {
  constructor(stateDb, label) { this.stateDb = stateDb; this.label = label; this.child = null; this.out = ""; }
  async start(env = {}) {
    this.child = spawn(process.execPath, [POLLER], {
      cwd: TMP,
      env: {
        ...process.env,
        CC_API: API, CC_SECRET: SECRET, CC_FLOOR: String(FLOOR), EXECUTE: "0",
        PAPER_PREFLIGHT: "1",
        KEYPAIR: keypairFile, STATE_DB: this.stateDb, LOCK_FILE: `${this.stateDb}.lock`,
        PAUSE_ENTRIES_FILE: path.join(TMP, `pause-${this.label}`),
        HARD_STOP_FILE: path.join(TMP, `hard-stop-${this.label}`),
        POLL_MS: "1000", MARK_MS: "0", RECONCILE_MS: "0", MAX_CALL_AGE_MIN: "45",
        DESK_UNREACHABLE_MS: "3600000", DESK_SILENT_MS: "3600000",
        JUPITER_API_KEY: "sim-c-paper-key",
        JUPITER_API_BASE: "https://jupiter.sim-c.invalid/swap/v2",
        NODE_OPTIONS: `--import=${pathToFileURL(REDIRECT).href}`,
        DS_OFFLINE: "1", NODE_NO_WARNINGS: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (c) => {
      this.out += c.toString();
      try { fs.appendFileSync(path.join(TMP, `poller-${this.label}.log`), c.toString()); } catch {}
      if (process.env.SIM_C_VERBOSE === "1") process.stdout.write(c.toString().replace(/^/gm, `   ${this.label}| `));
    };
    this.child.stdout.on("data", take);
    this.child.stderr.on("data", take);
    if (!await this.waitFor(new RegExp(`up — floor ${FLOOR}`), 25_000))
      throw new Error(`poller ${this.label} never booted:\n${this.out.split("\n").slice(-20).join("\n")}`);
  }
  async waitFor(re, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (re.test(this.out)) return true; await new Promise((r) => setTimeout(r, 40)); }
    return false;
  }
  async stop() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await once(child, "exit"); clearTimeout(t);
    await new Promise((r) => setTimeout(r, 120));
  }
  tail(n = 14) { return this.out.split("\n").slice(-n).join("\n"); }
}

const BOT_DB = path.join(TMP, "bot.sqlite");
{
  const j = new ExecutionJournal(BOT_DB, { wallet: wallet.publicKey.toBase58() });
  /* Primed at the CURRENT latest id: the desk half above published hundreds of calls to
     this same floor, and a bot starting at 0 would replay every one of them. */
  j.saveRuntime({ cursor: executorFeedPayload(FLOOR, 0).latest_id, primed: true,
    state: freshState(Date.now()), positions: {} });
  j.close();
}
const bot = new Bot(BOT_DB, "sim-c");
await bot.start();

/* THE BAND SETS THE ZONE, AND THE ZONE IS A GATE. penthouse.js entryZonePct: nano +/-20%,
   micro +/-15%, everything else +/-10%. The fixtures are published in the MICRO band —
   the shape of coin the measured drift refusals came off — and one extra fixture repeats
   the 8.20% drift in the default band so the interaction between the two is a printed
   number rather than an assumption. */
const MICRO_MCAP = 35_000, DEFAULT_BAND_MCAP = 250_000;

/** Publish one real call carrying a fixture class, straight through openCall+broadcast. */
function publishFixtureCall(klass, i, { mcapUsd = MICRO_MCAP, suffix = "" } = {}) {
  const fx = BOT_FIXTURES.find((f) => f.klass === klass);
  const mint = Keypair.generate().publicKey.toBase58();
  FIXTURE_BY_MINT.set(mint, fx);
  const sym = `BC${String(i).padStart(2, "0")}`;
  const zone = ph.entryZoneAround(ENTRY_PRICE, bandForMarketCap(mcapUsd), null, ENTRY_PRICE);
  const call = openCall({
    mint, symbol: sym, category: "memecoin", launchpad: "pump.fun", conviction: 60,
    entryRef: ENTRY_PRICE, entryLo: zone.lo, entryHi: zone.hi,
    stop: ENTRY_PRICE * 0.75, target: ENTRY_PRICE * 1.5,
    thesis: `${sym} — ${klass}${suffix}`, invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd,
  });
  if (!call) throw new Error(`openCall refused ${sym}`);
  const res = copy.broadcast(call.id, [FLOOR]);
  if (res.offered !== 1) throw new Error(`${sym} was not offered: ${JSON.stringify(res)}`);
  return { call, klass, sym, fx, zone };
}

console.log("\nEVERY MEASURED REFUSAL, THROUGH THE REAL POLLER'S OWN FENCES");
console.log(`    published in the micro band (zone +/-${ph.entryZonePct("micro")}%), plus the 8.20% drift ` +
  `repeated in the default band (+/-${ph.entryZonePct("other")}%)`);
const botRows = [];
{
  let i = 0;
  const runs = [...BOT_FIXTURES.map((fx) => ({ fx, mcapUsd: MICRO_MCAP, label: fx.klass })),
    { fx: BOT_FIXTURES.find((f) => f.klass === "drift_8_20pct"), mcapUsd: DEFAULT_BAND_MCAP,
      label: "drift_8_20pct@10%zone" }];
  for (const { fx, mcapUsd, label } of runs) {
    const pubd = publishFixtureCall(fx.klass, ++i, { mcapUsd, suffix: ` (${label})` });
    const seen = await bot.waitFor(new RegExp(`PAPER PREFLIGHT ${pubd.sym} |SKIP ${pubd.sym}:`), 25_000);
    const line = new RegExp(`(?:PAPER PREFLIGHT|SKIP) ${pubd.sym}[^\\n]*`).exec(bot.out)?.[0] ?? "";
    const cleared = /PAPER PREFLIGHT \S+ — CLEARED/.test(line);
    const gate = /REFUSED \[(\w+)\]/.exec(line)?.[1] ?? (cleared ? "" : "no_line");
    botRows.push({ klass: label, sym: pubd.sym, cleared, gate, line, seen,
      counted: mcapUsd === MICRO_MCAP });
    console.log(`    ${label.padEnd(22)} ${cleared ? "TAKEN  " : "refused"}  ${line.slice(0, 145) || bot.tail(6)}`);
  }
}
ok("every published call reached the bot and was answered past the paper return",
  botRows.every((r) => r.seen && r.line), `${botRows.filter((r) => r.line).length} of ${botRows.length} answered`);
ok("the clean route is taken, and the seam really did run the fences",
  botRows.find((r) => r.klass === "clean")?.cleared === true,
  botRows.find((r) => r.klass === "clean")?.line ?? "no line");
ok("the round-trip and impact refusals are SIZED DOWN rather than thrown away (step 25)",
  botRows.find((r) => r.klass === "round_trip_14pct")?.cleared === true &&
  botRows.find((r) => r.klass === "impact_7pct")?.cleared === true && /SIZED /.test(bot.out),
  `${(/SIZED [^\n]*/.exec(bot.out) || ["no SIZED line"])[0].slice(0, 190)}`);
ok("the drift the owner raised the cap for is now inside it, and a 26% one is still refused",
  botRows.find((r) => r.klass === "drift_8_20pct")?.cleared === true &&
  botRows.find((r) => r.klass === "drift_26_04pct")?.cleared === false,
  `8.20% -> ${botRows.find((r) => r.klass === "drift_8_20pct")?.cleared ? "taken" : "refused"} · ` +
  `26.04% -> ${botRows.find((r) => r.klass === "drift_26_04pct")?.gate}`);
/* THE FINDING THE FIXTURE MATRIX EXISTS TO FIND. Raising maxEntryQuoteDriftPct to 15%
   does not by itself make an 8.20% drift takeable: the guard tests the WORST-CASE mark,
   which carries the 3% slippage floor (1/0.97 = +3.09% on every quote ever), against the
   AUTHORED ZONE — so at the default +/-10% band width the zone refuses it while the
   drift cap waves it through. It is takeable in micro and nano, where the band is wider.
   The zone width is the binding gate for drift, and it is a desk-side number. */
should("an 8.20% drift is takeable in EVERY band, not only the wide ones",
  botRows.find((r) => r.klass === "drift_8_20pct@10%zone")?.cleared === true,
  `micro (+/-15%): ${botRows.find((r) => r.klass === "drift_8_20pct")?.cleared ? "taken" : "refused"} · ` +
  `default (+/-10%): ${botRows.find((r) => r.klass === "drift_8_20pct@10%zone")?.gate} — ` +
  `the worst-case mark carries a +3.09% slippage floor, so 8.20% is tested as 11.55% ` +
  `against a 10% zone. The drift cap is not the binding gate; the band's zone width is.`);
ok("a rent quote over the gross cap is still refused, and the measured 3,742,803 is not",
  botRows.find((r) => r.klass === "rent_over_cap")?.cleared === false &&
  botRows.find((r) => r.klass === "rent_3_742_803")?.cleared === true,
  `over-cap -> ${botRows.find((r) => r.klass === "rent_over_cap")?.gate} · ` +
  `3,742,803 -> ${botRows.find((r) => r.klass === "rent_3_742_803")?.cleared ? "taken" : "refused"}`);

/* THE RULER, CHECKED AGAINST A KNOWN ANSWER. If the seam were inert the log would show
   "PAPER — no transaction signed" and every class would look identical. */
ok("CONTROL: the paper-preflight seam is what produced these lines, not the old paper return",
  !/PAPER — no transaction signed/.test(bot.out) && /PAPER PREFLIGHT/.test(bot.out),
  `PAPER PREFLIGHT lines=${(bot.out.match(/PAPER PREFLIGHT/g) || []).length} · ` +
  `old paper returns=${(bot.out.match(/PAPER — no transaction signed/g) || []).length}`);

/* ─── BEFORE AND AFTER, so each refusal class's contribution is a printed number ───
   The "before" is the same fixture put through the SAME real functions with the two
   knobs steps 23-26 moved put back where they were: the executable-quote drift cap at
   its old 5%, and the halving ladder disabled (a cost refusal thrown away whole). */
console.log("\nWHAT EACH BOT-SIDE STEP IS WORTH — the same fixtures, the old knobs");
{
  const { sizeEntryToRoute } = await import("./executor/entry-sizing.mjs");
  const { validateExecutableEntryOrder } = await import("./executor/entry-quote-guard.mjs");
  const { PYTH_SOL_USD_CACHE_SOURCE } = await import("./executor/sol-usd-oracle.mjs");
  const LAMPORTS = 1e9, STOP_RATIO = 0.75;
  const ZONE = ph.entryZoneAround(ENTRY_PRICE, "micro", null, ENTRY_PRICE);
  /* The SAME quote model the HTTP server serves, so the matrix and the subprocess cannot
     disagree about what a fixture costs; only the two knobs move between the columns. */
  const probeFor = (fx) => async (amountRaw) => {
    const forward = fixtureQuote(fx, WSOL, amountRaw);
    const reverse = fixtureQuote(fx, "token", forward.outAmount);
    const lossPct = (1 - Number(reverse.outAmount) / Number(amountRaw)) * 100;
    const refusals = [];
    if (lossPct > 12) refusals.push(`entry round-trip loss ${lossPct.toFixed(2)}% exceeds cap 12%`);
    if (forward.impactPct > 5) refusals.push(`price impact ${forward.impactPct.toFixed(2)}% exceeds cap 5%`);
    return { forward: { outAmount: forward.outAmount }, reverse: { outAmount: reverse.outAmount },
      lossPct, impactPct: forward.impactPct, cap: 12, impactCap: 5,
      ok: refusals.length === 0, refusal: refusals[0] ?? null };
  };
  const run = async (fx, { halvings, driftCap }) => {
    const sizing = await sizeEntryToRoute({
      probe: probeFor(fx), sol: FIXTURE_CLIP_SOL, lamportsPerSol: LAMPORTS, stopRatio: STOP_RATIO,
      expectedNetworkFeeLamports: 500_000, slippageBps: 300,
      minSizeFor: () => 0.02, maxHalvings: halvings,
    });
    if (!sizing.ok) return { taken: false, gate: "executable_cost" };
    if (fx.rent > 4_200_000) return { taken: false, gate: "order_envelope" };
    const amountRaw = String(sizing.amountRaw);
    const final = fixtureQuote(fx, WSOL, amountRaw);
    const observedAt = Date.now();
    try {
      validateExecutableEntryOrder({ kind: "entry", amountRaw,
        context: { event: { stop: ENTRY_PRICE * 0.75, target: ENTRY_PRICE * 1.5 },
          entryReference: { marketMark: ENTRY_PRICE, marketMarkAt: observedAt,
            entryLow: ZONE.lo, entryHigh: ZONE.hi },
          entryPreflight: { inputAmountRaw: amountRaw,
            forwardOutputRaw: String(sizing.preflight.forward.outAmount),
            reverseOutputRaw: String(sizing.preflight.reverse.outAmount),
            solUsd: PAPER_SOL_USD, solUsdSource: PYTH_SOL_USD_CACHE_SOURCE,
            solUsdPublishTime: Math.floor(observedAt / 1000) - 2, solUsdConfidencePct: 0.01,
            solUsdProviderDivergencePct: 0.01, tokenDecimals: DECIMALS, observedAt } } },
        { inAmount: amountRaw, outAmount: final.outAmount,
          otherAmountThreshold: String(Math.floor(Number(final.outAmount) * 0.97)) },
        { nowMs: Date.now(), maxEntryQuoteDriftPct: driftCap, maxEntryPreflightAgeMs: 90_000 });
      return { taken: true, gate: "", sol: sizing.sol };
    } catch (e) { return { taken: false, gate: "executable_quote", why: e.message }; }
  };
  const AFTER = { halvings: MAX_ROUTE_HALVINGS, driftCap: 15 };
  const BEFORE = { halvings: 0, driftCap: 5 };
  let before = 0, after = 0;
  console.log(`    ${"class".padEnd(18)} ${"before (halvings 0, drift cap 5%)".padEnd(36)} after (halvings ${MAX_ROUTE_HALVINGS}, drift cap 15%)`);
  for (const fx of BOT_FIXTURES) {
    const b = await run(fx, BEFORE), a = await run(fx, AFTER);
    if (b.taken) before++;
    if (a.taken) after++;
    console.log(`    ${fx.klass.padEnd(18)} ${(b.taken ? `TAKEN ${b.sol} SOL` : `refused [${b.gate}]`).padEnd(36)} ` +
      `${a.taken ? `TAKEN ${a.sol} SOL` : `refused [${a.gate}]`}`);
  }
  ok("the bot-side steps strictly increase the number of these fixtures it can take",
    after >= before, `before ${before}/${BOT_FIXTURES.length} → after ${after}/${BOT_FIXTURES.length}`);
  globalThis.__BOT_TAKE = { before: before / BOT_FIXTURES.length, after: after / BOT_FIXTURES.length };
}

/* ─── AND THE SELL LEG: the desk determines, the bot acts on the determination ──── */
console.log("\nTHE EXIT LEG — the desk's own evaluateExit, followed by the real bot");
{
  /* THE FEED IS PAGED, AND THE DESK HALF FILLED IT. Reading from cursor 0 returns the
     FIRST page — hundreds of cohort calls old — so the fixture's own event was not in it
     and this block died on `undefined.event_id` the first time the run was long enough to
     matter. Read from the cursor as it stood before this call was published, which is
     what the bot itself does. */
  const cursorBefore = executorFeedPayload(FLOOR, 0).latest_id;
  const pubd = publishFixtureCall("clean", 90);
  await bot.waitFor(new RegExp(`(PAPER PREFLIGHT|SKIP) ${pubd.sym}\\b`), 20_000);
  await bot.stop();
  const ev = executorFeedPayload(FLOOR, cursorBefore).events
    .find((e) => e.call_id === pubd.call.id && e.type === "entry");
  if (!ev) throw new Error(`SIM C: no entry event on the feed for ${pubd.sym} (call ${pubd.call.id})`);
  {
    const j = new ExecutionJournal(BOT_DB, { wallet: wallet.publicKey.toBase58() });
    const amountRaw = String(Math.floor(0.02 * 1e9));
    const spec = { id: `entry:${ev.event_id}`, kind: "entry", eventId: ev.event_id, feedId: ev.id,
      mint: ev.mint, inputMint: WSOL, outputMint: ev.mint, amountRaw,
      context: { wallet: wallet.publicKey.toBase58(), event: ev,
        plan: { action: "buy", sol: 0.02, f: 0.02 },
        takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
        positionConfig: { stopBufferPct: 0 },
        entryReference: { marketMark: ev.current_mark, marketMarkAt: ev.current_mark_at,
          entryLow: ev.entry_lo, entryHigh: ev.entry_hi,
          stopRatio: ev.stop / ev.current_mark, targetRatio: ev.target / ev.current_mark },
        entryPreflight: { inputAmountRaw: amountRaw, forwardOutputRaw: "1000000000",
          reverseOutputRaw: String(Math.floor(0.02 * 1e9 * 0.98)), roundTripLossPct: 2,
          solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
          solUsdPublishTime: Math.floor(Date.now() / 1000), solUsdConfidencePct: 0.01,
          solUsdProviderDivergencePct: 0.01, tokenDecimals: 6, observedAt: Date.now() },
        openedAtMs: pubd.call.opened_at, riskStateBefore: freshState(pubd.call.opened_at) } };
    j.ensureIntent(spec);
    const signature = "s".repeat(88);
    j.recordSigned(spec.id, { attempt: 1, requestId: `req-${spec.id}`,
      signedTx: Buffer.from("signed"), signature, blockhash: "sim-blockhash",
      lastValidBlockHeight: 999, quotedOutputRaw: "1000000000", minOutputRaw: "1000000000",
      order: { sim: true } });
    j.markConfirmed(spec.id, 1, { signature, totalInputAmount: amountRaw,
      totalOutputAmount: "1000000000", networkFeeLamports: "5000" },
      { status: "Success", code: 0, signature });
    j.close();
  }
  await bot.start();
  await new Promise((r) => setTimeout(r, 1_800));
  const call = getCall(pubd.call.id);
  noteEvent(call.id, "mark", null, call.stop * 0.9);
  const exit = evaluateExit(getCall(call.id), { mark: call.stop * 0.9, liqUsd: call.liq_at_call, flags: [] });
  const closed = exit.fire ? calls.closeCall(call.id, exit.code, call.stop * 0.9) : null;
  if (closed) announceExit(closed, exit).catch(() => {});
  const followed = await bot.waitFor(
    new RegExp(`PAPER EXIT ${pubd.sym} — desk exit \\(${exit.code}\\)`), 20_000);
  ok("the desk determined the exit and the real bot acted on that determination",
    exit.fire && exit.code === "stop_hit" && followed,
    `desk=${exit.code} bot followed=${followed}${followed ? "" : `\n${bot.tail(12)}`}`);
}
await bot.stop();

/* ═══ THE HEADLINE ════════════════════════════════════════════════════════════════ */

console.log("\n══ THE ANSWER TO BOTH QUESTIONS, WITH THE ARITHMETIC BESIDE IT ══");
{
  const take = globalThis.__BOT_TAKE;
  for (const R of [HEALTHY, BLENDED, OUTAGE]) {
    const p3 = R.reached.length / R.rows.length;
    const clean3 = R.clean.length ? R.cleanReached.length / R.clean.length : 0;
    /* P(taken == 3 AND exited == 3 | published >= 3). Every published call is delivered
       (deliverable is the desk's own stamp) and the bot decides on each independently, so
       the three-of-three probability is the per-call take rate cubed. THE CLASS MIX IS
       NOT MEASURED — nobody has counted how often a live call is a 26% drift rather than
       a clean route — so the take rate used here is the fixture matrix's own, over a
       UNIFORM mix of the eight measured refusal classes, and it is a proxy, not a rate. */
    console.log(`\n  ${R.label.toUpperCase()}  (p_cov ${R.pCov}, ` +
      `${(R.pmPositive * (1 - R.pCov) * 100).toFixed(2)}% PM-positive per paid workup)`);
    console.log(`    P(published >= 3)                    ${(p3 * 100).toFixed(1)}%   ` +
      `(${(clean3 * 100).toFixed(1)}% among cohorts no money rail stopped)`);
    const deliv = R.reached.length ? R.reached.filter((r) => r.delivered >= CYCLE.quota).length / R.reached.length : 0;
    console.log(`    P(deliverable >= 3 | published >= 3) ${(deliv * 100).toFixed(1)}%   ` +
      `— read off the deliveries table, not asserted`);
    console.log(`    P(taken == 3 AND exited == 3 | published >= 3)  ` +
      `before ${(take.before ** 3 * 100).toFixed(1)}%  →  after ${(take.after ** 3 * 100).toFixed(1)}%   ` +
      `(per-call ${(take.before * 100).toFixed(0)}% → ${(take.after * 100).toFixed(0)}%, uniform class mix, ` +
      `cost+geometry fences only)`);
    console.log(`    cost per cohort p50 ${money(quantile(R.costs, 0.5))} · p90 ${money(quantile(R.costs, 0.9))} ` +
      `· per published call ${R.published ? money(R.spentTotal / R.published) : "n/a"} ` +
      `· per TAKEN call ${R.published ? money(R.spentTotal / Math.max(1e-9, R.published * take.after)) : "n/a"}`);
    /* THE SMALLEST $X PER COHORT AT WHICH P(taken == 3) >= 0.95. Read off this run's own
       cost rows: the smallest budget under which at least 95% of the cohorts that reached
       three did so having spent no more than X, discounted by the take rate. */
    const spendOfReached = R.reached.map((r) => r.cost).sort((a, b) => a - b);
    const need = 0.95 / Math.max(1e-9, take.after ** 3);
    const x = need > 1
      ? null
      : quantile(spendOfReached, Math.min(1, need));
    console.log(`    smallest $X per cohort at which P(taken == 3) >= 0.95: ` +
      (x == null
        ? `UNREACHABLE at any budget — the per-call take rate ${(take.after * 100).toFixed(0)}% ` +
          `caps P(taken == 3) at ${(take.after ** 3 * 100).toFixed(1)}%`
        : `${money(x)}`));
  }
  console.log(`\n  All three regimes ran the REAL $${cfg.dailyBudgetUsd}/day, ` +
    `$${process.env.PENTHOUSE_CYCLE_BUDGET_USD ?? cfgmod.CYCLE_BUDGET_DEFAULT_USD}/pass and hourly-pace rails ` +
    `on an injected clock advancing ${PASS_PERIOD_MS / 60_000} minutes a pass.`);
  console.log(`  N = ${COHORTS} cohorts per regime (SIM_C_COHORTS; the plan asks for >= 1000 for the ` +
    `headline probabilities — at this N the standard error on a 0.95 estimate is ` +
    `${(Math.sqrt(0.95 * 0.05 / COHORTS) * 100).toFixed(1)} points).`);
}

/* ── the honest failure, reported rather than tuned away ── */
console.log("\n══ WHAT THIS RUN CANNOT SAY ══");
console.log("  · The bot leg runs the COST and GEOMETRY fences only. The two-RPC mint audit, the");
console.log("    Pyth read, the writable-account snapshot, the simulation and the on-chain rent");
console.log("    facts need a chain; the paper preflight prices its implied mark with a declared");
console.log("    constant and says so in poller.mjs. The take rate above is an upper bound.");
console.log("  · The class mix behind P(taken == 3) is UNIFORM over the eight measured refusal");
console.log("    classes because nobody has counted how often each occurs on a live call.");
console.log("  · THE WALLET RAIL DOES NOT BIND IN PAPER. poller.mjs reads the balance only under");
console.log("    EXECUTE, so spendableSol is null here and planEntry's fundability rails never");
console.log("    fire. The live burner holds 0.107 SOL and a 0.4 SOL trade needs ~0.42 with the");
console.log("    fee reserve, so the live take rate today is ZERO for a reason no fence in this");
console.log("    file can see: the bot cannot pay. Every take rate above assumes a funded wallet.");
console.log("  · f, the publishable fraction, is a prediction: the live ledger has 0 PM-positive");
console.log("    rows because the desk has published nothing since it shipped.");
console.log("  · The healthy stage rates come from the plan's token:end window, not from the");
console.log("    7-day histogram, which is 86.9% insufficient_coverage — an outage, not a desk.");

await new Promise((r) => office.close(r));
await new Promise((r) => jupiterStub.close(r));

if (DEFECTS.length) {
  console.log(`\n══ ${DEFECTS.length} STANDING DEFECT(S) — real behaviour, not a broken test ══`);
  for (const d of DEFECTS) console.log(`  · ${d.n}\n      ${d.d}`);
}
console.log(`\n══ ${pass} passed, ${fail} failed, ${DEFECTS.length} defect(s) ══`);
console.log(`   sandbox: ${TMP}`);
process.exit(fail ? 1 : 0);
