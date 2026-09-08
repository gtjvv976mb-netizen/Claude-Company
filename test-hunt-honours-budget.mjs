/**
 * THE HUNT IS INSIDE THE CAP NOW — and a survivor reserves what a survivor costs.
 *
 * Two defects, one file.
 *
 *   1. THE HUNT SPENT OUTSIDE THE BUDGET. The shortlist walk ran CONCURRENCY workers
 *      against the per-cycle cap; the mandate hunt underneath it was a plain serial
 *      `for` that read neither the cap nor `stopped`. A pass already cut off at its
 *      budget went straight on buying workups — cycle 19 spent $21.68 against an $8
 *      cap and published nothing.
 *
 *   2. THE FLAT RESERVATION UNDER-RESERVED THE COINS THAT COST MONEY. $0.42 is the mean
 *      over ALL workups and ~93% of them die free at the paid screen; a coin that
 *      reaches the analysts buys the whole seat stack, ~$1.30. Reserving the mean for it
 *      let three workers commit four workups against a cap sized for two.
 *
 * So both lanes run through makeWorkupPool(), and desk.js's own `stage: "analysis"`
 * event raises that coin's reservation to a survivor's cost the moment it is known to be
 * one. What is proven here is the REAL pool and, in part two, the REAL runPenthouseCycle
 * over a synthetic market with only the network and the workup itself replaced.
 *
 *   node test-hunt-honours-budget.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE — this file publishes calls and meters
   spend. Own temp file, always: unlike the other tests it does not defer to the
   runner's CLAUDE_CO_DB, because the stub layer below would otherwise write synthetic
   coins into whatever database the runner happened to point at. */
const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-budget-"));
process.env.CLAUDE_CO_DB = path.join(TMP, "hunt-budget.db");
process.env.EXECUTE = "0";
process.env.DESK_PREPARE_TX = "0";
process.env.ANTHROPIC_API_KEY = "hb-no-network";      // never used: the workup is stubbed
process.env.XAI_API_KEY = "";
process.env.DESK_DAILY_BUDGET_USD = "1000000";        // the DAILY brake is not under test
process.env.PENTHOUSE_WHALE_BUDGET_MS = "1";          // whale flow is a nudge; skip it
/* THE NUMBERS UNDER TEST. A $2 cap and a $0.90 workup, so the cap binds after two or
   three of them and the arithmetic is checkable by hand. */
const CAP = 2;
const WORKUP_USD = 0.9;
process.env.PENTHOUSE_CYCLE_BUDGET_USD = String(CAP);
process.env.PENTHOUSE_WORKUP_CONCURRENCY = "2";

const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/lib/http.js"), "http"],
  [F("src/desk.js"), "desk"],
]);
const SOURCE = {
  http: `
    export async function getJson(url, opts = {}) { return globalThis.__HB.getJson(String(url), opts); }
    export async function rpc() { return { ok: false, error: "stub: no RPC" }; }
    export async function readRpc() { return { ok: false, error: "stub: no RPC" }; }
  `,
  /* Only workup() is replaced. It is the one thing in the cycle that costs money, and
     the whole question here is how many of them a pass is allowed to buy. */
  desk: `
    export const CHEAP_SEATS = Object.freeze(["liquidity", "flow"]);
    export async function runCycle() { return null; }
    export async function workup(cycle, mint, hook, opts) {
      return globalThis.__HB.workup(cycle, mint, hook, opts);
    }
  `,
};
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?hb=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("hb=stub")) {
      const k = new URL(u).searchParams.get("k");
      return { format: "module", source: SOURCE[k], shortCircuit: true };
    }
    return next(url, ctx);
  },
});
// Any escape from the stub layer is a real network call. Loud, not slow.
globalThis.fetch = async (u) => { throw new Error(`a real network call escaped: ${String(u).slice(0, 90)}`); };

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const usd = (n) => `$${Number(n).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══ THE SYNTHETIC MARKET ═══════════════════════════════════════════════════════════
   Shaped so the REAL free screen (wouldSurviveScreen) passes it and the REAL rank()
   scores it above zero — nothing here labels a coin "good" and hands that label to the
   pipeline. Fourteen of them, all pump.fun, so the hunt has a long ranked list to walk
   and can be seen to stop on the cap rather than on an exhausted market. */
const COINS = 14;
const mintFor = (i) =>
  ("HB" + String(i).padStart(4, "0") + "QwErTyUiOpAsDfGhJkLzXcVbNm123456789").slice(0, 39) + "pump";
const pairFor = (i) => {
  const mint = mintFor(i);
  const liq = 80_000 + i * 1_000;
  return {
    chainId: "solana", dexId: "pumpswap", pairAddress: `pool${i}`, url: `https://hb/${i}`,
    baseToken: { address: mint, symbol: `HB${String(i).padStart(2, "0")}`, name: `HB${i} coin`, decimals: 6 },
    quoteToken: { symbol: "SOL" },
    priceUsd: String(0.001 + i * 1e-5),
    liquidity: { usd: liq },
    fdv: 300_000, marketCap: 300_000,
    pairCreatedAt: Date.now() - (100 + i) * 3.6e6,
    volume: { h24: liq * 1.5, h6: liq * 0.3, h1: liq * 0.06 },
    txns: { h24: { buys: 600 - i, sells: 400 }, h6: { buys: 240, sells: 180 }, h1: { buys: 90, sells: 60 } },
    priceChange: { m5: 1.2, h1: 5, h6: 14, h24: 22 },
    info: { socials: [{ type: "twitter", url: "https://x.com/hb" }], websites: [{ url: "https://hb.example" }] },
  };
};
const PAIRS = Array.from({ length: COINS }, (_, i) => pairFor(i));

const HB = {
  workups: [],                       // { mint, lane } in start order
  running: { "house scan": 0, "the mandate": 0 },
  peak: { "house scan": 0, "the mandate": 0 },
  async getJson(url) {
    if (url.includes("/latest/dex/search")) return { ok: true, data: { pairs: PAIRS } };
    // Everything else — pump.fun's listing, CoinGecko, Jupiter — declines, and every
    // consumer of those degrades on purpose (unknown weather grounds nobody).
    return { ok: false, error: `stub: unrouted ${url.slice(0, 60)}` };
  },
  async workup(cycle, mint, hook) { return HB.doWorkup(cycle, mint, hook); },
};
globalThis.__HB = HB;

/* ═══ BOOT THE REAL DESK ═════════════════════════════════════════════════════════════ */
const ph = await import("./src/penthouse.js");
const llm = await import("./src/lib/llm.js");
const cfgmod = await import("./src/config.js");
const busmod = await import("./src/lib/bus.js");
const store = await import("./src/lib/store.js");
const db = store.default;
const { emit, bus } = busmod;
bus.setMaxListeners(200);

const TAPE = [];
bus.on("event", (ev) => TAPE.push(ev));
const since = () => TAPE.length;
const tapeFrom = (i) => TAPE.slice(i);

/** Charge the REAL cost meter exactly $0.90: 180,000 input tokens of claude-opus-5 at
 *  $5/MTok. The metered figure is what the pool reads, so the money in this test is the
 *  desk's own accounting rather than a counter the test keeps for itself. */
const chargeOneWorkup = () => {
  llm.meterAnthropicUsage("claude-opus-5",
    { model: "claude-opus-5", usage: { input_tokens: 180_000, output_tokens: 0 } }, "hb-stub", "low");
};
{
  const before = llm.spend.usd;
  chargeOneWorkup();
  const charged = llm.spend.usd - before;
  console.log(`\nTHE FIXTURE'S ARITHMETIC — cap ${usd(CAP)}, one workup ${usd(charged)}, ` +
    `typical reservation ${usd(ph.TYPICAL_WORKUP_USD)}, survivor reservation ${usd(ph.SURVIVOR_WORKUP_USD)}`);
  ok("the stubbed workup charges the real meter exactly $0.90",
    Math.abs(charged - WORKUP_USD) < 1e-9, `${usd(charged)} through meterAnthropicUsage`);
  db.prepare("DELETE FROM llm_spend").run();
  llm.spend.usd = 0; llm.spend.calls = 0;
}

/* ═══ PART 1 — THE POOL ITSELF ═══════════════════════════════════════════════════════
   The real makeWorkupPool, driven with a scripted workup so every reservation can be
   read at the moment it changes. The `stage: "analysis"` event is emitted on the REAL
   bus by the scripted study, exactly as desk.js emits it. */
async function drivePool({ concurrency, survivorUsd, coins = 12 }) {
  let used = 0, stopped = null, running = 0, peak = 0, cursor = 0;
  const steps = [];
  const pool = ph.makeWorkupPool({
    concurrency, budgetUsd: CAP,
    usedUsd: () => used,
    typicalUsd: ph.TYPICAL_WORKUP_USD,
    survivorUsd,
    isStopped: () => stopped,
    stop: (r) => { stopped = r; },
  });
  const queue = Array.from({ length: coins }, (_, i) => ({ mint: `HBPOOL${i}` }));
  const note = (at, mint) => steps.push({ at, mint,
    usedUsd: Number(used.toFixed(2)), reservedUsd: Number(pool.reservedUsd().toFixed(2)) });
  await pool.run({
    take: () => (cursor < queue.length ? queue[cursor++] : null),
    study: async (c) => {
      running++; peak = Math.max(peak, running);
      note("started", c.mint);
      await sleep(5);
      emit("stage", { stage: "analysis", mint: c.mint });   // desk.js's own event
      note("reached the analysts", c.mint);
      await sleep(5);
      used += WORKUP_USD; running--;
      note("charged", c.mint);
    },
  });
  return { used, stopped, peak, steps, studied: steps.filter((s) => s.at === "charged").length };
}

console.log("\nPART 1 — THE POOL: what a coin reserves, and when");
const bumped = await drivePool({ concurrency: 3, survivorUsd: ph.SURVIVOR_WORKUP_USD });
for (const s of bumped.steps)
  console.log(`    ${s.mint} ${s.at.padEnd(20)} used ${usd(s.usedUsd)}  reserved ${usd(s.reservedUsd)}`);
const firstStart = bumped.steps.find((s) => s.at === "started");
const lastStart = [...bumped.steps].reverse().find((s) => s.at === "started");
const firstAnalysis = bumped.steps.find((s) => s.at === "reached the analysts");
ok("a workup reserves the TYPICAL cost the moment it starts",
  Math.abs(firstStart.reservedUsd - ph.TYPICAL_WORKUP_USD) < 1e-9,
  `reserved ${usd(firstStart.reservedUsd)} of a ${usd(CAP)} cap`);
/* The pool's reservation is a SUM over everything in flight, so the bump is read as the
   delta across the one event that caused it. Exactly survivor minus typical. */
const bump = firstAnalysis.reservedUsd - lastStart.reservedUsd;
ok("and exactly a SURVIVOR's cost once that coin reaches the analysts",
  Math.abs(bump - (ph.SURVIVOR_WORKUP_USD - ph.TYPICAL_WORKUP_USD)) < 1e-9,
  `${usd(lastStart.reservedUsd)} -> ${usd(firstAnalysis.reservedUsd)} on one stage event ` +
  `= +${usd(bump)}, which is ${usd(ph.SURVIVOR_WORKUP_USD)} - ${usd(ph.TYPICAL_WORKUP_USD)}`);
ok("three workers really did run at once", bumped.peak === 3, `peak ${bumped.peak}`);
ok("the cap stopped the pool", Boolean(bumped.stopped), String(bumped.stopped));
const bumpedOver = bumped.used - CAP;
ok("and the overshoot is at most ONE SURVIVOR",
  bumpedOver <= ph.SURVIVOR_WORKUP_USD + 1e-9,
  `spent ${usd(bumped.used)} against ${usd(CAP)} = ${usd(bumpedOver)} over, one survivor is ${usd(ph.SURVIVOR_WORKUP_USD)}`);

/* THE REGRESSION THIS HALF EXISTS FOR: the same run with the reservation left flat at
   the mean, which is what shipped before. */
const flat = await drivePool({ concurrency: 3, survivorUsd: ph.TYPICAL_WORKUP_USD });
const flatOver = flat.used - CAP;
ok("without the bump the same pool buys MORE than the cap allows",
  flat.used > bumped.used,
  `flat ${usd(flat.used)} (${flat.studied} workups) vs bumped ${usd(bumped.used)} (${bumped.studied} workups)`);
ok("...and that overshoot is bigger than one survivor — the defect, measured",
  flatOver > ph.SURVIVOR_WORKUP_USD, `${usd(flatOver)} over the ${usd(CAP)} cap`);

/* ═══ PART 2 — THE REAL CYCLE ════════════════════════════════════════════════════════ */
console.log("\nPART 2 — THE REAL CYCLE: the hunt spends inside the same cap");
const laneOf = (hook) => (String(hook).startsWith("the mandate") ? "the mandate" : "house scan");
HB.doWorkup = async (cycle, mint, hook) => {
  const lane = laneOf(hook);
  HB.running[lane]++; HB.peak[lane] = Math.max(HB.peak[lane], HB.running[lane]);
  HB.workups.push({ mint, lane });
  await sleep(4);
  // desk.js emits this the moment the cheap gates are behind the coin and the seat
  // stack is about to be bought. The pool listens for it.
  emit("stage", { stage: "analysis", mint, symbol: mint.slice(0, 6) });
  await sleep(4);
  chargeOneWorkup();
  HB.running[lane]--;
  /* A verdict the team declines: the PM passed on a named flaw. It is PAID for and
     REAL to the cycle (it counts as a workup and goes to publishCall), and mandate.js
     refuses to publish it — which keeps `opened` at zero so the hunt has to keep
     hunting, which is the lane under test. */
  return { mint, symbol: mint.slice(0, 6), outcome: "decided", finalDecision: "DECLINED",
    pm: { decision: "PASS", conviction: 21, thesis: "not this one", invalidation: "n/a" },
    redteam: { verdict: "wounded" }, compliance: { pass: true, violations: [] },
    ev: { symbol: mint.slice(0, 6), pair: { priceUsd: 0.001 } } };
};

const at = since();
const r = await ph.runPenthouseCycle({ workups: 1 });
const events = tapeFrom(at);
const kinds = events.map((e) => e.type);
const huntStarts = events.filter((e) => e.type === "cycle:hunting").length;
const budgetEv = events.find((e) => e.type === "cycle:budget");
const bumpEvs = events.filter((e) => e.type === "cycle:reserved_up");
const houseWorkups = HB.workups.filter((w) => w.lane === "house scan").length;
const huntWorkups = HB.workups.filter((w) => w.lane === "the mandate").length;

console.log(`    ranked ${r.ranked} coins · shortlist workups ${houseWorkups} · hunt workups ${huntWorkups}`);
console.log(`    spent ${usd(r.costUsd)} against a ${usd(CAP)} cap · stopped: ${r.stopped}`);
if (budgetEv) console.log(`    cycle:budget  used ${usd(budgetEv.usedUsd)}  reserved ${usd(budgetEv.reservedUsd)}  inFlight ${budgetEv.inFlight}`);
for (const b of bumpEvs) console.log(`    cycle:reserved_up ${b.mint.slice(0, 8)}  ${usd(b.fromUsd)} -> ${usd(b.toUsd)}  reserved ${usd(b.reservedUsd)}`);

ok("the pass reached the mandate hunt", huntStarts > 0 && huntWorkups > 0,
  `${huntStarts} candidates hunted, ${huntWorkups} paid`);
ok("THE HUNT RAN THROUGH THE WORKER POOL, not one coin at a time",
  HB.peak["the mandate"] === 2,
  `peak ${HB.peak["the mandate"]} concurrent hunt workups at PENTHOUSE_WORKUP_CONCURRENCY=2`);
ok("the cap fired and cycle:budget was emitted", Boolean(budgetEv),
  budgetEv ? `used ${usd(budgetEv.usedUsd)} + reserved ${usd(budgetEv.reservedUsd)} >= ${usd(CAP)}` : "no cycle:budget");
ok("`stopped` came back on the cycle's own result", /budget/.test(String(r.stopped)), String(r.stopped));
ok("the reservation bumped to a survivor's cost inside the real cycle too",
  bumpEvs.length > 0 && bumpEvs.every((b) => b.toUsd === ph.SURVIVOR_WORKUP_USD),
  `${bumpEvs.length} bumps to ${usd(ph.SURVIVOR_WORKUP_USD)}`);
const over = r.costUsd - CAP;
ok("the whole pass — shortlist AND hunt — overshot by at most one survivor",
  over <= ph.SURVIVOR_WORKUP_USD + 1e-9,
  `spent ${usd(r.costUsd)}, cap ${usd(CAP)}, over by ${usd(over)} (one survivor = ${usd(ph.SURVIVOR_WORKUP_USD)})`);
/* THE DEFECT ITSELF: an unbounded hunt would have walked the whole ranked list. */
ok("the hunt stopped on the CAP, not on an exhausted market",
  huntStarts < r.ranked - houseWorkups,
  `${huntStarts} of ${r.ranked - houseWorkups} huntable coins were reached`);
ok("nothing was published — the team's PASS is refused at every level",
  r.opened === 0, `opened ${r.opened}, workedUp ${r.workedUp}`);
ok("the cycle still ended cleanly", kinds.includes("cycle:end"),
  `${kinds.filter((k) => k === "cycle:end").length} cycle:end`);

/* ═══ PART 3 — ONE DEFAULT FOR THE CYCLE BUDGET ══════════════════════════════════════ */
console.log("\nPART 3 — PENTHOUSE_CYCLE_BUDGET_USD has ONE default");
const D = cfgmod.CYCLE_BUDGET_DEFAULT_USD;
console.log(`    config.js CYCLE_BUDGET_DEFAULT_USD = ${usd(D)}  (penthouse.js was 8, llm.js was 4)`);
ok("the shipped default is $16", D === 16, usd(D));
const src = {
  penthouse: fs.readFileSync(path.join(REPO, "src/penthouse.js"), "utf8"),
  llm: fs.readFileSync(path.join(REPO, "src/lib/llm.js"), "utf8"),
  evaluation: fs.readFileSync(path.join(REPO, "src/evaluation.js"), "utf8"),
};
/* A literal fallback is how the two drifted apart in the first place, so the property
   is checked on the SOURCE: every reader of this env var falls back to the one const. */
const literalFallbacks = [];
for (const [name, text] of Object.entries(src))
  for (const m of text.matchAll(/PENTHOUSE_CYCLE_BUDGET_USD\s*\|\|\s*([A-Za-z0-9_]+)/g))
    if (/^[0-9]/.test(m[1])) literalFallbacks.push(`${name}: ${m[1]}`);
ok("no module falls back to a numeric literal of its own",
  literalFallbacks.length === 0, literalFallbacks.join(", ") || "penthouse.js, llm.js and evaluation.js all read CYCLE_BUDGET_DEFAULT_USD");
ok("penthouse.js resolves the cap through the shared default",
  /PENTHOUSE_CYCLE_BUDGET_USD \|\| CYCLE_BUDGET_DEFAULT_USD/.test(src.penthouse));
ok("llm.js's hourly floor reads the same default",
  /PENTHOUSE_CYCLE_BUDGET_USD \|\| CYCLE_BUDGET_DEFAULT_USD/.test(src.llm));
ok("the env var still wins over it (this whole file runs at the pinned $2)",
  ph.CYCLE_BUDGET_USD === CAP, `PENTHOUSE_CYCLE_BUDGET_USD=${process.env.PENTHOUSE_CYCLE_BUDGET_USD} -> ${usd(ph.CYCLE_BUDGET_USD)}`);

/* THE FLOOR THE DEFAULT SETS, measured through the real brake. A pace tighter than one
   cycle's own allowance is a deadlock — the cycle is cut off mid-hunt every time — so
   the hourly cap is max(daily/24 x burst, cycleBudget x 1.25). At a $40 daily cap the
   old llm.js default of 4 made that floor $5, and a $16 cycle could never complete. */
const pinned = process.env.PENTHOUSE_CYCLE_BUDGET_USD;
delete process.env.PENTHOUSE_CYCLE_BUDGET_USD;         // exercise the DEFAULT path
db.prepare("DELETE FROM llm_spend").run();
const spendThisHour = (u) => {
  db.prepare("DELETE FROM llm_spend").run();
  db.prepare("INSERT INTO llm_spend (ts,seat,model,usd,in_tok,out_tok) VALUES (?,?,?,?,?,?)")
    .run(Date.now() - 60_000, "hb", "claude-opus-5", u, 0, 0);
};
const allowed = (cap) => {
  try { llm.assertDailyBudget(cap, { lane: "cycle" }); return true; }
  catch (e) { if (e instanceof llm.BudgetExhausted) return false; throw e; }
};
const floorAt = (cap) => Math.max((cap / 24) * llm.HOURLY_BURST, D * 1.25);
console.log(`    hourly floor at a $40 cap: ${usd(floorAt(40))} (it was ${usd(Math.max((40 / 24) * llm.HOURLY_BURST, 4 * 1.25))} when llm.js defaulted to 4)`);
console.log(`    hourly floor at the live $200 cap: ${usd(floorAt(200))} = max(200/24x3, 16x1.25)`);
ok("at the live $200 cap the pace allows $25/h", Math.abs(floorAt(200) - 25) < 1e-9, usd(floorAt(200)));
spendThisHour(6);
ok("a $40-cap desk may still spend $6 in an hour — one cycle fits inside the pace",
  allowed(40), `floor ${usd(floorAt(40))}; under the old llm.js default of 4 it was $5 and this was refused`);
spendThisHour(21);
ok("...and the pace still bites above the floor", !allowed(40), `$21 spent against ${usd(floorAt(40))}`);
process.env.PENTHOUSE_CYCLE_BUDGET_USD = pinned;

/* ═══ PART 4 — THE DEFAULTS THE OWNER MAY WANT BACK ══════════════════════════════════ */
console.log("\nPART 4 — the raised defaults, and the env var that reverts each");
console.log(`    WORKUPS_DEFAULT ${cfgmod.WORKUPS_DEFAULT} (PENTHOUSE_WORKUPS, was 8) · ` +
  `CYCLE_BUDGET_DEFAULT_USD ${usd(cfgmod.CYCLE_BUDGET_DEFAULT_USD)} (PENTHOUSE_CYCLE_BUDGET_USD, was 8) · ` +
  `HUNT_BUDGET_DEFAULT_MS ${cfgmod.HUNT_BUDGET_DEFAULT_MS} (PENTHOUSE_HUNT_BUDGET_MS, was 240000)`);
ok("workups per cycle is 24 at L0", cfgmod.WORKUPS_DEFAULT === 24, String(cfgmod.WORKUPS_DEFAULT));
ok("...and 48 at L1+, because the ladder doubles it",
  cfgmod.WORKUPS_DEFAULT * cfgmod.escalationPlan(1).workupMultiplier === 48,
  `${cfgmod.WORKUPS_DEFAULT} x ${cfgmod.escalationPlan(1).workupMultiplier}`);
/* THE PLAN ASKED FOR ">= 3 full 8.6-minute workups" AND 900s IS NOT THAT SERIALLY —
   three in a row is 25.8 minutes. It is that in WALL CLOCK, because the hunt now runs
   CONCURRENCY of them at once: 900s / 8.6min = 1.7 rounds x 3 workers ~ 5 workups,
   against the old 240s, which expired inside the FIRST one. That is the honest claim
   and it is the one asserted. */
const roundsOf86 = cfgmod.HUNT_BUDGET_DEFAULT_MS / (8.6 * 60_000);
const workersDefault = Math.max(1, Math.min(6, Number(process.env.PENTHOUSE_WORKUP_CONCURRENCY || 3)));
ok("the hunt's clock buys at least three workups at the measured 8.6-minute median",
  cfgmod.HUNT_BUDGET_DEFAULT_MS === 900_000 && roundsOf86 * workersDefault >= 3,
  `${cfgmod.HUNT_BUDGET_DEFAULT_MS / 1000}s = ${roundsOf86.toFixed(1)} rounds x ${workersDefault} workers ` +
  `= ${(roundsOf86 * workersDefault).toFixed(1)} workups; the old 240s bought ${(240_000 / (8.6 * 60_000) * workersDefault).toFixed(1)}`);
/* Every raised default has to be revertible without a code change, because the owner
   may want any of them back. */
for (const [envVar, mod] of [["PENTHOUSE_WORKUPS", "penthouse"], ["PENTHOUSE_CYCLE_BUDGET_USD", "penthouse"],
  ["PENTHOUSE_HUNT_BUDGET_MS", "penthouse"], ["PENTHOUSE_SURVIVOR_WORKUP_USD", "penthouse"]])
  ok(`${envVar} still overrides it`, src[mod].includes(`process.env.${envVar} ||`));

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
