/* THE BACKTEST, DRIVEN AGAINST BOOKS WHOSE ANSWER IS ALREADY KNOWN.
 *
 * paper-trade.js is pointed at the question "should I keep funding this", so it gets the
 * same treatment as any other ruler on this desk: arithmetic checked against hand-computed
 * cases, and — the one that matters most — a LOSING book must be reported as losing, with
 * break-even refused rather than answered with a large number.
 *
 * The published record of backtests is the reason for the paranoia: a census of 19
 * closed-loop LLM trading studies found ONE modelling transaction costs and ONE
 * documenting survivorship. Every figure here is net of the measured round trip, and the
 * survivorship it cannot fix is stated in the caveats rather than hidden.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paper-"));
process.env.CLAUDE_CO_DB = path.join(tmp, "journal.sqlite");
process.env.NODE_ENV = "test";

await import("./src/calls.js");        // creates calls
await import("./src/lib/llm.js");      // creates llm_spend
const { paperTrade } = await import("./src/paper-trade.js");

const db = new DatabaseSync(process.env.CLAUDE_CO_DB);
let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
/* Returns are computed through divisions, so they land a few ulps off a round number.
   Comparing them exactly would fail on arithmetic that is correct. */
const near = (got, want, msg, tol = 1e-9) =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < tol, `${msg}: got ${got}, want ${want}`);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
let cid = 0;

/** One call: entry 100, closing at `closePct` above/below it, costing `rt`% round trip. */
function addCall({ closePct, rt = 1, day = 0, status = "closed" }) {
  cid++;
  const entry = 100;
  const close = entry * (1 + closePct / 100);
  db.prepare(
    `INSERT INTO calls (mint,symbol,status,entry_ref,stop,target,rt_loss_at_call,
                        opened_at,closed_at,close_mark,close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`mint${cid}`, `S${cid}`, status, entry, 90, 130, rt,
    T0 + day * DAY, status === "closed" ? T0 + day * DAY + 3600e3 : null,
    status === "closed" ? close : null, status === "closed" ? "target" : null);
}
const addSpend = (usd, day = 0) =>
  db.prepare("INSERT INTO llm_spend (seat,model,usd,ts) VALUES ('flow','m',?,?)")
    .run(usd, T0 + day * DAY + 60_000);

const wipe = () => db.exec("DELETE FROM calls; DELETE FROM llm_spend;");

/* ── 1. THE ARITHMETIC ──────────────────────────────────────────────────────────────── */
console.log("\nTHE ARITHMETIC, HAND-CHECKED");
wipe();
/* Four calls: +10, +10, -10, -10, each costing 1% round trip.
   net per call = +9, +9, -11, -11  ->  mean -1.0, win rate 50%. */
[10, 10, -10, -10].forEach((p, i) => addCall({ closePct: p, rt: 1, day: i }));
const four = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
ok("gross returns become net by subtracting the measured round trip", () => {
  near(four.perFilledCall.meanNetPct, -1, "meanNet of +9,+9,-11,-11");
  near(four.perFilledCall.meanRoundTripPct, 1, "meanRoundTrip");
});
ok("the win rate counts NET winners, not gross ones", () => {
  assert.equal(four.perFilledCall.winRatePct, 50, `winRate=${four.perFilledCall.winRatePct}`);
});
ok("best and worst are reported, so an average cannot hide the shape", () => {
  near(four.perFilledCall.bestPct, 9, "best");
  near(four.perFilledCall.worstPct, -11, "worst");
});

/* A round trip big enough to eat a winner — the case that makes cost modelling matter. */
wipe();
[3, 3, 3, 3].forEach((p, i) => addCall({ closePct: p, rt: 5, day: i }));
ok("a book of gross winners is reported as a LOSS once the round trip is charged", () => {
  const r = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  near(r.perFilledCall.meanNetPct, -2, "meanNet at a 5% round trip");
  assert.equal(r.perFilledCall.winRatePct, 0, `winRate=${r.perFilledCall.winRatePct}`);
  console.log("        +3% four times at a 5% round trip = -2% a call, 0% win rate");
});

/* ── 2. THE FILL RATE ───────────────────────────────────────────────────────────────── */
console.log("\nTHE FILL RATE — A CALL NOBODY GOT INTO EARNS NOTHING");
wipe();
[20, 20, 20, 20].forEach((p, i) => addCall({ closePct: p, rt: 1, day: i }));
ok("the edge per PUBLISHED call is the filled edge scaled by the fill rate", () => {
  const full = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  const real = paperTrade({ fillRate: 0.75, bootstrapSamples: 200 });
  near(full.edgePerPublishedCallPct, 19, "edge at full fill");
  near(real.edgePerPublishedCallPct, 14.25, "edge at 75% fill (19 * 0.75)");
  console.log(`        19% a filled call becomes ${real.edgePerPublishedCallPct}% a published one`);
});
ok("an impossible fill rate is refused rather than silently clamped", () => {
  assert.throws(() => paperTrade({ fillRate: 0 }), /fillRate/);
  assert.throws(() => paperTrade({ fillRate: 1.5 }), /fillRate/);
});

/* ── 3. THE QUESTION THAT ACTUALLY MATTERS ──────────────────────────────────────────── */
console.log("\nBREAK-EVEN AGAINST THE RESEARCH BILL");
wipe();
/* Ten calls at +11% gross, 1% round trip -> +10 net each, fill 1.0. $50 of research. */
for (let i = 0; i < 10; i++) addCall({ closePct: 11, rt: 1, day: i });
addSpend(50, 0);
ok("a winning book gives the exact size the trading side must run to cover research", () => {
  const r = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  assert.equal(r.research.usd, 50, `research=${r.research.usd}`);
  assert.ok(r.breakEven.possible, JSON.stringify(r.breakEven));
  /* 10 calls * 10% * size = $50  ->  size = $50 / 1.0 = $50 */
  near(r.breakEven.sizeUsdPerCall, 50, "break-even size", 1e-6);
  console.log(`        $50 research / (10% x 10 calls) = $${r.breakEven.sizeUsdPerCall} a call`);
});
ok("...and the size scales with the bill, not with wishful thinking", () => {
  addSpend(450, 1);                       // now $500 of research
  const r = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  assert.equal(r.research.usd, 500);
  near(r.breakEven.sizeUsdPerCall, 500, "break-even size at a $500 bill", 1e-6);
});

/* THE MOST IMPORTANT ASSERTION IN THE FILE. */
wipe();
for (let i = 0; i < 10; i++) addCall({ closePct: -5, rt: 1, day: i });
addSpend(600, 0);
ok("A LOSING BOOK REFUSES TO PRODUCE A BREAK-EVEN SIZE", () => {
  const r = paperTrade({ fillRate: 0.75, bootstrapSamples: 200 });
  assert.ok(r.edgePerPublishedCallPct < 0, `edge=${r.edgePerPublishedCallPct}`);
  assert.equal(r.breakEven.possible, false, JSON.stringify(r.breakEven));
  assert.match(r.breakEven.reason, /no position size/i);
  assert.equal(r.breakEven.sizeUsdPerCall, undefined,
    "a losing book must not be handed a number that looks like a plan");
  console.log(`        edge ${r.edgePerPublishedCallPct.toFixed(2)}% -> break-even refused`);
});
ok("...and a bigger size is shown making the loss bigger, not smaller", () => {
  const r = paperTrade({ fillRate: 0.75, bootstrapSamples: 200 });
  const [small, , large] = r.totals.atSizeUsd;
  assert.ok(large.netOfResearchUsd < small.netOfResearchUsd,
    `at $${small.sizeUsd}: ${small.netOfResearchUsd}, at $${large.sizeUsd}: ${large.netOfResearchUsd}`);
  console.log(`        $10/call -> $${small.netOfResearchUsd.toFixed(2)}, ` +
    `$1000/call -> $${large.netOfResearchUsd.toFixed(2)}`);
});

/* ── 4. POPULATION HYGIENE ──────────────────────────────────────────────────────────── */
console.log("\nWHAT MAY NOT ENTER THE BOOK");
wipe();
for (let i = 0; i < 6; i++) addCall({ closePct: 10, rt: 1, day: i });
addCall({ closePct: 0, status: "live", day: 7 });
addCall({ closePct: 0, status: "live", day: 8 });
ok("a call still live is counted and reported, never traded", () => {
  const r = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  assert.equal(r.population.traded, 6, `traded=${r.population.traded}`);
  assert.equal(r.population.stillLive, 2, `live=${r.population.stillLive}`);
});
ok("a call with no measured round trip is dropped and counted, not charged zero", () => {
  /* ORDER BY is load-bearing: a bare LIMIT 2 has no defined order and picked the two
     LIVE rows, which paperTrade excludes anyway — so the test passed vacuously with
     nothing dropped. An unordered LIMIT in a fixture is a silently meaningless test. */
  db.prepare("UPDATE calls SET rt_loss_at_call=NULL WHERE id IN " +
    "(SELECT id FROM calls WHERE status='closed' ORDER BY id LIMIT 2)").run();
  const excl = paperTrade({ fillRate: 1, costPolicy: "exclude", bootstrapSamples: 200 });
  const zero = paperTrade({ fillRate: 1, costPolicy: "zero", bootstrapSamples: 200 });
  assert.equal(excl.population.droppedNoCost, 2, `dropped=${excl.population.droppedNoCost}`);
  assert.equal(zero.population.traded, 6, `zero traded=${zero.population.traded}`);
  assert.ok(zero.perFilledCall.meanNetPct > excl.perFilledCall.meanNetPct,
    `zero=${zero.perFilledCall.meanNetPct} exclude=${excl.perFilledCall.meanNetPct} ` +
    "— charging nothing must flatter the book");
});
ok("an empty book returns nulls rather than inventing a verdict", () => {
  wipe();
  const r = paperTrade({ bootstrapSamples: 100 });
  assert.equal(r.population.traded, 0);
  assert.equal(r.edgePerPublishedCallPct, null);
  assert.equal(r.breakEven, null);
  assert.equal(r.totals, null);
});
ok("extra slippage is charged on top of the measured round trip", () => {
  wipe();
  for (let i = 0; i < 5; i++) addCall({ closePct: 10, rt: 1, day: i });
  const a = paperTrade({ fillRate: 1, bootstrapSamples: 200 });
  const b = paperTrade({ fillRate: 1, extraSlipPct: 3, bootstrapSamples: 200 });
  near(a.perFilledCall.meanNetPct - b.perFilledCall.meanNetPct, 3, "extra slippage charged");
});
ok("the caveats state the upper-bound and survivorship limits every time", () => {
  const r = paperTrade({ bootstrapSamples: 100 });
  assert.ok(r.caveats.some((c) => /UPPER BOUND/.test(c)), JSON.stringify(r.caveats));
  assert.ok(r.caveats.some((c) => /no close_mark/.test(c) || /stopped being quotable/.test(c)));
  assert.ok(r.caveats.some((c) => /not investment advice/i.test(c)));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n══ ${pass} passed, 0 failed ══`);
