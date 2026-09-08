/**
 * THE FUNNEL — a standing population, and the clocks that keep it honest.
 *
 * The safety tests here are the ones that matter. A funnel is a machine for REUSING
 * work, and reused safety work is the exact thing that gets a desk rugged: the screen
 * that passed twenty minutes ago is a statement about a pool that no longer exists.
 * Every test below that starts "SAFETY" is checking that the funnel would rather do the
 * cheap work twice than trust it once too long.
 */
import { _reset, observe, decay, dueForScreen, recordScreen, dueForStudy, recordStudy,
         readyPool, census, retire, curveVelocity, TTL, RESTALE_MOVE_PCT } from "./src/funnel.js";
import { shapePair } from "./src/data/dexscreener.js";
import { asCandidate } from "./src/data/pumpfun-live.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const coin = (mint, { pad = "pump.fun", score = 50, mcap = 250_000, h1 = 0, cell = "low/memecoin" } = {}) => ({
  mint, score, launchpad: pad, cellKey: cell, band: cell.split("/")[0], coinType: cell.split("/")[1],
  // `liquidityUsd`, the field both shapers emit — re-anchored from the raw DexScreener
  // `liquidity.usd` this fixture used to carry, which nothing the desk hands observe() has.
  pair: { baseSymbol: mint, baseName: mint, marketCap: mcap, liquidityUsd: 30_000,
          volume: { h24: 50_000 }, priceChange: { h1 } },
});

// Reach into the row to age a timestamp, so the clocks can be tested without waiting.
const { DatabaseSync } = await import("node:sqlite");
const path = await import("node:path");
const { ROOT } = await import("./src/config.js");
const raw = new DatabaseSync(process.env.CLAUDE_CO_DB || path.default.join(ROOT, "claude-co.db"));
const age = (mint, col, ms) => raw.prepare(`UPDATE funnel SET ${col}=? WHERE mint=?`).run(Date.now() - ms, mint);

_reset();

console.log("\nA COIN LIVES IN THE FUNNEL AND IS PROMOTED THROUGH IT");
observe([coin("AAA"), coin("BBB"), coin("CCC")]);
ok("everything swept enters at watch", census().watch === 3, `${census().watch} at watch`);
ok("a second sweep refreshes rather than duplicates",
  observe([coin("AAA", { score: 80 })]).refreshed === 1 && census().total === 3,
  "the population persists across passes — that is the whole point");

ok("the screen queue offers the highest-ranked first", dueForScreen(1)[0].mint === "AAA", "score 80");
recordScreen("AAA", null);
recordScreen("BBB", "no_liquidity");
ok("a clean screen promotes to screened", census().screened === 1);
ok("a killed screen HOLDS the coin at watch, with its reason",
  census().watch === 2 && census().killedAtScreen === 1,
  "a kill is recorded so the desk does not pay to rediscover it");

recordStudy("AAA", { eligible: true, verdict: "PROPOSE", conviction: 0.7, thesis: "t" });
ok("an eligible verdict reaches ready", readyPool()[0]?.mint === "AAA");

console.log("\nTHE WARM BENCH IS THE REASON THE FUNNEL EXISTS");
ok("a researched name is waiting BEFORE a slot opens", readyPool().length === 1,
  "the old desk started a cold 4-minute sweep at this moment instead");

console.log("\nSAFETY: AN EXPIRED SCREEN DEMOTES, EVEN FROM READY");
age("AAA", "screened_at", TTL.screen + 1000);
const d = decay();
ok("the coin falls all the way back to watch", d.screenExpired === 1 && census().watch === 3,
  "not held, not grandfathered — safety facts are only as good as the clock");
ok("...and it is NOT in the ready pool any more", readyPool().length === 0,
  "a stale screen must never have money put behind it");

console.log("\nSAFETY: READY IS RE-CHECKED AGAINST THE CLOCK, NOT TRUSTED FROM THE COLUMN");
_reset();
observe([coin("DDD")]); recordScreen("DDD", null);
recordStudy("DDD", { eligible: true, verdict: "PROPOSE", conviction: 0.9, thesis: "t" });
age("DDD", "screened_at", TTL.screen + 1000);
ok("a row still WRITTEN ready is excluded once its screen is stale",
  raw.prepare("SELECT stage FROM funnel WHERE mint='DDD'").get().stage === "ready" && readyPool().length === 0,
  "decay has not run yet — the query defends itself, because this is what money follows");

console.log("\nA RE-PASSED SCREEN RESTORES A VERDICT THE DESK ALREADY PAID FOR");
/* The gap the suite missed: no test combined an EXPIRED SCREEN with a FRESH VERDICT.
 * On the live desk `studied` and `ready` sat at exactly 0 through 300+ workups — every
 * paid verdict thrown away the moment the free check timed out underneath it. The warm
 * bench, which is the entire reason to build a funnel, could never exist. */
_reset();
observe([coin("WARM")]); recordScreen("WARM", null);
recordStudy("WARM", { eligible: true, verdict: "PROPOSE", conviction: 0.8, thesis: "t" });
age("WARM", "screened_at", TTL.screen + 1000);
decay();
ok("the expired screen still demotes it all the way to watch", census().watch === 1);
ok("re-screening it clean puts it BACK on the bench", recordScreen("WARM", null) === "restored"
  && readyPool()[0]?.mint === "WARM",
  "safety was re-run this instant; only the judgement was inherited");

console.log("\nSAFETY: BUT A RE-SCREEN THAT KILLS OVERRIDES ANYTHING THE DESK PAID FOR");
_reset();
observe([coin("RUG")]); recordScreen("RUG", null);
recordStudy("RUG", { eligible: true, verdict: "PROPOSE", conviction: 0.95, thesis: "t" });
age("RUG", "screened_at", TTL.screen + 1000);
decay();
ok("a kill holds it at watch no matter how good the verdict was",
  recordScreen("RUG", "freeze_authority_live") === "held" && readyPool().length === 0,
  "the expensive opinion never outranks the free safety fact");

console.log("\n...AND A STALE VERDICT IS NOT RESTORED, ONLY A FRESH ONE");
_reset();
observe([coin("OLD2")]); recordScreen("OLD2", null);
recordStudy("OLD2", { eligible: true, verdict: "PROPOSE", conviction: 0.8, thesis: "t" });
age("OLD2", "screened_at", TTL.screen + 1000);
age("OLD2", "studied_at", TTL.study + 1000);
decay();
ok("an aged-out verdict re-screens only as far as screened",
  recordScreen("OLD2", null) === "promoted",
  "it must be paid for again — the restore inherits judgement, it does not revive it");

_reset();
observe([coin("RAN", { h1: 3 })]); recordScreen("RAN", null);
recordStudy("RAN", { eligible: true, verdict: "PROPOSE", conviction: 0.8, thesis: "t" });
observe([coin("RAN", { h1: 3 + RESTALE_MOVE_PCT + 5 })]);
age("RAN", "screened_at", TTL.screen + 1000);
decay();
ok("nor is one the price has run away from", recordScreen("RAN", null) === "promoted",
  "a coin 20%+ from where the desk judged it is a different question");

console.log("\nA VERDICT AGES OUT, BUT ONLY BACK TO SCREENED");
_reset();
observe([coin("EEE")]); recordScreen("EEE", null);
recordStudy("EEE", { eligible: true, verdict: "PROPOSE", conviction: 0.8, thesis: "t" });
age("EEE", "studied_at", TTL.study + 1000);
decay();
ok("stale conviction demotes one stage, not to the bottom", census().screened === 1,
  "the safety work still stands; only the judgement is old");

console.log("\nA PRICE MOVE EXPIRES A VERDICT THAT IS STILL INSIDE ITS TTL");
_reset();
observe([coin("FFF", { h1: 5 })]); recordScreen("FFF", null);
recordStudy("FFF", { eligible: true, verdict: "PROPOSE", conviction: 0.8, thesis: "t" });
observe([coin("FFF", { h1: 5 + RESTALE_MOVE_PCT + 1 })]);          // it ran
ok("the ready pool drops it immediately", readyPool().length === 0,
  `moved more than ${RESTALE_MOVE_PCT}% since the desk wrote its answer`);
ok("and decay demotes it to be re-studied", decay().movedOut === 1,
  "something happened; the written answer is to a question nobody is asking now");

console.log("\nA COIN THE DESK CAN NO LONGER SEE IS DROPPED OUTRIGHT");
_reset();
observe([coin("GGG")]);
age("GGG", "last_seen", TTL.unseen + 1000);
ok("gone from the sweep, gone from the funnel", decay().dropped === 1 && census().total === 0,
  "the one case where the desk has no way to re-check it");

console.log("\nPAID SEATS ARE SPENT FROM THE STANDING POOL, NOT A SINGLE SWEEP");
_reset();
observe([
  coin("OLD", { score: 90 }), coin("MID", { score: 70, cell: "micro/memecoin" }),
  coin("NEW", { score: 60, cell: "medium/utility" }),
]);
for (const m of ["OLD", "MID", "NEW"]) recordScreen(m, null);
age("OLD", "stage_since", 20 * 60_000);                    // entered twenty minutes ago
const study = dueForStudy(3);
ok("a name screened 20 minutes ago is still a candidate",
  study.some((r) => r.mint === "OLD"),
  "the old cycle forgot it and re-discovered it from scratch every pass");
ok("one per cell before doubling up", new Set(study.map((r) => r.cell_key)).size === 3);

console.log("\nTHE PAD QUOTA AND THE STALE-SCREEN BAR BOTH APPLY TO WHO GETS PAID FOR");
_reset();
observe([
  coin("P1", { pad: "pump.fun", score: 40 }), coin("P2", { pad: "pump.fun", score: 30, cell: "micro/memecoin" }),
  coin("M1", { pad: "meteora-dbc", score: 99 }), coin("M2", { pad: "bags.fm", score: 98, cell: "micro/memecoin" }),
]);
for (const m of ["P1", "P2", "M1", "M2"]) recordScreen(m, null);
const paid = dueForStudy(4);
ok("the whole workup budget is actually spent", paid.length === 4,
  `${paid.length} of 4 — a budget that comes back short is the desk under-spending its seats`);
ok("pump.fun is the majority of what gets paid for",
  paid.filter((r) => r.launchpad === "pump.fun").length >= 2,
  `${paid.filter((r) => r.launchpad === "pump.fun").length} of ${paid.length}, over higher-scoring rivals`);

age("P1", "screened_at", TTL.screen + 1000);
ok("a coin whose screen went stale is not offered for a PAID seat",
  !dueForStudy(4).some((r) => r.mint === "P1"),
  "the expensive gate never inherits an expired cheap one");

console.log("\nTHE CELL IS DERIVED FROM THE COIN, NOT TAKEN ON TRUST");
/* This is the test the suite owed. Every case above hands cellKey in by hand, which is
 * not how the desk calls it — nothing assigns a cell until the board is built much
 * further downstream. Against the live market every row stored band=null and the whole
 * spread collapsed to one nameless cell: 294 coins swept, "across 1 cells". Green the
 * entire time. */
_reset();
observe([
  { mint: "RAW1", score: 50, launchpad: "pump.fun",
    pair: { baseSymbol: "RAW1", baseName: "Dog Coin", marketCap: 250_000, websites: [] } },
  { mint: "RAW2", score: 40, launchpad: "pump.fun",
    pair: { baseSymbol: "RAW2", baseName: "Battle Quest Arena", marketCap: 40_000, websites: [] } },
]);
const rows = raw.prepare("SELECT mint, band, coin_type, cell_key FROM funnel ORDER BY mint").all();
ok("a coin observed with NO cell attached still lands in the right band",
  rows[0].band === "medium" && rows[1].band === "micro",
  `$250k -> ${rows[0].band}, $40k -> ${rows[1].band}`);
ok("...and is typed from what it says it is",
  rows[0].coin_type === "memecoin" && rows[1].coin_type === "web3_gaming",
  `${rows[0].coin_type}, ${rows[1].coin_type}`);
ok("so the board spread is real rather than one nameless cell",
  new Set(rows.map((r) => r.cell_key)).size === 2,
  "a fact computable from the coin belongs to the thing that stores it");
ok("and the census can publish the owner's board", census().board.length === 2,
  census().board.map((b) => `${b.band}/${b.coin_type}:${b.n}`).join(" "));

console.log("\nTHE CENSUS SHOWS THE SHAPE OF THE PIPE");
const c = census();
ok("every stage is counted", ["watch", "screened", "studied", "ready"].every((s) => s in c), JSON.stringify(
  { watch: c.watch, screened: c.screened, studied: c.studied, ready: c.ready }));
ok("and the clocks are published with it", c.ttlMinutes.screen === TTL.screen / 60_000,
  `screen ${c.ttlMinutes.screen}m · study ${c.ttlMinutes.study}m · unseen ${c.ttlMinutes.unseen}m`);

console.log("\nTHE LIQ COLUMN READS THE SHAPE BOTH SHAPERS ACTUALLY EMIT");
/* observe() read `pair.liquidity.usd`, the raw DexScreener spelling, while both shapers
 * pass on `liquidityUsd` — so the column was NULL on every row the funnel ever stored,
 * and green the whole time because no test read it back. Both fixtures here go through
 * the REAL shapers, so the column is checked against the shape the desk hands it. */
_reset();
const near = (a, b, tol = 1e-9) => a != null && Math.abs(a - b) <= tol;
const SOL = 1e9, M = 1e12;                                   // lamports; six-decimal base units per 1M tokens
const dsPair = shapePair({ dexId: "raydium", pairAddress: "p1", url: "u", chainId: "solana",
  baseToken: { symbol: "DSX", name: "Dex Coin" }, quoteToken: { symbol: "SOL" }, priceUsd: "0.01",
  liquidity: { usd: 42_500 }, marketCap: 250_000, fdv: 250_000, pairCreatedAt: Date.now() - 3.6e6,
  volume: { h24: 90_000 }, priceChange: { h1: 2 } });
const pfRow = (over = {}) => ({
  mint: "PFX", symbol: "PFX", name: "Pump Coin", creator: "C1",
  created_timestamp: Date.now() - 6 * 60_000, last_trade_timestamp: Date.now(),
  usd_market_cap: 30_000, total_supply: 1e15, complete: false,
  virtual_sol_reserves: 38 * SOL, virtual_token_reserves: 847.1 * M,
  real_sol_reserves: 8 * SOL, real_token_reserves: 567.2 * M,            // 8 SOL in, mid-curve
  reply_count: 12, ath_market_cap: 45_000, ath_market_cap_timestamp: Date.now() - 20 * 60_000,
  ...over });
const pf = (over) => ({ ...asCandidate(pfRow(over), { solUsd: 100 }), score: 50 });
observe([{ mint: "DSX", score: 50, launchpad: "raydium", pair: dsPair }, pf()]);
const liqOf = (m) => raw.prepare("SELECT liq FROM funnel WHERE mint=?").get(m).liq;
ok("a DexScreener pair's liquidity is stored, not NULL", liqOf("DSX") === 42_500,
  `liq = ${liqOf("DSX")} from liquidity.usd 42,500 via shapePair`);
ok("a pump.fun curve's is too", liqOf("PFX") === 1_600,
  `liq = ${liqOf("PFX")} — 8 SOL x $100, both sides of the book, via asCandidate`);

console.log("\nTHE CURVE, THE CROWD AND THE ATH DRAWDOWN REFRESH ON EVERY OBSERVE");
const curveRow = (m) => raw.prepare(
  "SELECT curve_sol, curve_sol_at, curve_sol_prev, curve_sol_prev_at, reply_count, ath_ratio FROM funnel WHERE mint=?").get(m);
let cr = curveRow("PFX");
ok("curve_sol is the real SOL reserve", cr.curve_sol === 8, `curve_sol = ${cr.curve_sol}`);
ok("reply_count is pump.fun's", cr.reply_count === 12, `reply_count = ${cr.reply_count}`);
ok("ath_ratio is cap over ATH", near(cr.ath_ratio, 30_000 / 45_000), `ath_ratio = ${cr.ath_ratio} ($30,000 / $45,000)`);
const dsRow = curveRow("DSX");
ok("a coin the launch feed never saw stores NULL here, not 0",
  dsRow.curve_sol === null && dsRow.reply_count === null && dsRow.ath_ratio === null,
  `curve_sol ${dsRow.curve_sol}, reply_count ${dsRow.reply_count}, ath_ratio ${dsRow.ath_ratio}`);
ok("one reading has no velocity", curveVelocity("PFX") === null, `curveVelocity = ${curveVelocity("PFX")}`);

// The next pass: 4.8 more SOL on the curve, the crowd grew, the cap slipped off its high.
observe([pf({ real_sol_reserves: 12.8 * SOL, virtual_sol_reserves: 42.8 * SOL, reply_count: 31, usd_market_cap: 27_000 })]);
cr = curveRow("PFX");
ok("curve_sol refreshes to the new reading", near(cr.curve_sol, 12.8), `curve_sol = ${cr.curve_sol}`);
ok("...and the reading before it is kept, not lost", cr.curve_sol_prev === 8, `curve_sol_prev = ${cr.curve_sol_prev}`);
ok("reply_count refreshes", cr.reply_count === 31, `reply_count = ${cr.reply_count}`);
ok("ath_ratio refreshes", near(cr.ath_ratio, 27_000 / 45_000), `ath_ratio = ${cr.ath_ratio} ($27,000 / $45,000)`);

console.log("\nTWO READINGS GIVE THE CURVE A VELOCITY FOR $0");
// Both readings landed inside one test tick; set the earlier one four minutes back, the
// way every clock in this file is aged, so the minutes are known rather than measured.
raw.prepare("UPDATE funnel SET curve_sol_prev_at = curve_sol_at - ? WHERE mint='PFX'").run(4 * 60_000);
let v = curveVelocity("PFX");
ok("velocity is (sol2 - sol1) / minutes", near(v, (12.8 - 8) / 4),
  `curveVelocity = ${v} SOL/min — (12.8 - 8) / 4 min; at that pace the 72.2 SOL still owed is ~${(72.2 / v).toFixed(0)} min out`);
observe([{ mint: "PFX", score: 50, launchpad: "pump.fun",
  pair: { baseSymbol: "PFX", marketCap: 27_000, liquidityUsd: 3_200 } }]);   // the keyword sweep, no `live`
cr = curveRow("PFX");
ok("a sweep-only re-observation keeps both readings and the velocity",
  near(cr.curve_sol, 12.8) && cr.curve_sol_prev === 8 && cr.reply_count === 31 && near(curveVelocity("PFX"), v),
  `curve_sol ${cr.curve_sol} / prev ${cr.curve_sol_prev}, reply_count ${cr.reply_count}, velocity ${curveVelocity("PFX")}`);
raw.prepare("UPDATE funnel SET curve_sol_prev_at = curve_sol_at WHERE mint='PFX'").run();
ok("two readings in the same instant are null, not infinity", curveVelocity("PFX") === null,
  `curveVelocity = ${curveVelocity("PFX")}`);
observe([pf({ real_sol_reserves: 10.4 * SOL, virtual_sol_reserves: 40.4 * SOL, reply_count: 33, usd_market_cap: 24_000 })]);
raw.prepare("UPDATE funnel SET curve_sol_prev_at = curve_sol_at - ? WHERE mint='PFX'").run(2 * 60_000);
v = curveVelocity("PFX");
ok("SOL leaving the curve reads negative", near(v, (10.4 - 12.8) / 2),
  `curveVelocity = ${v} SOL/min — (10.4 - 12.8) / 2 min`);
console.log("  stored row: " + JSON.stringify(raw.prepare(
  "SELECT mint, launchpad, liq, mcap, curve_sol, curve_sol_at, curve_sol_prev, curve_sol_prev_at, reply_count, ath_ratio, seen_count FROM funnel WHERE mint='PFX'").get()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
