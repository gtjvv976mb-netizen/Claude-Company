/* THE SNIPER'S EXIT, DRIVEN AGAINST SEQUENCES WHOSE ANSWER IS KNOWN.
 *
 * This policy is the only thing standing between a sniped position and holding it for
 * ever, because the desk-led executor holds unconditionally without a desk instruction
 * and a sniper has no desk. So it gets the treatment: the desk's OWN RECORDED INCIDENT
 * is a test case, both failure directions are asserted, and every assertion prints the
 * value it saw.
 *
 * The two properties that carry the whole design:
 *   BE SLOW TO ARM  — an irreversible arm reads a CONFIRMED mark, never a lone print.
 *   BE FAST TO EXIT — a sell reads the RAW mark, because a sell executes at a real
 *                     re-quoted price and being wrong costs a premature exit, not a loss.
 */
import assert from "node:assert/strict";
import { snipePolicy, freshSnipe, SNIPE_DEFAULTS, SNIPE_POLICY_VERSION,
  frictionX, tightestFundableStopFrac } from "./snipe-policy.mjs";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };

const T0 = 1_700_000_000_000;
/* Live fill economics, so every threshold in these tests is the real one:
   maxSolPerTrade 0.005 SOL, expectedNetworkFeeLamports 500_000 = 0.0005 SOL a leg. */
const LIVE = { sizeSol: 0.005, feeSolPerLeg: 0.0005 };
const FX = frictionX(LIVE);                       // 1.2222x
const open = (entry = 1.0) => freshSnipe({ entry, openedAt: T0, creator: "Dev111", ...LIVE });

/* THE TAKE, PARKED — for the cases that are about ARMING, not about exiting.
 *
 * takeAtEntryX arrived 2026-09-11 as the owner's upside dial, and it is a SELL branch in
 * the fast half: at the default of 2x, a sequence containing a 5.0 print now exits on the
 * first tick and never reaches the confirmation window these cases exist to exercise.
 * That is the take working correctly; it just makes it a poor instrument for studying the
 * median. So the confirmation cases below park it above every mark they use and say so,
 * rather than being quietly rewritten to marks that dodge it — and section 2b then
 * asserts the take DOES fire on those same sequences, so the interaction is recorded
 * instead of hidden. */
const NO_TAKE = { config: { takeAtEntryX: 1e9 } };

/** Feed a sequence of marks, returning every decision. */
function drive(pos, marks, { stepMs = 1000, ...rest } = {}) {
  const out = [];
  let p = pos;
  marks.forEach((m, i) => {
    const d = snipePolicy({ position: p, mark: m, nowMs: T0 + (i + 1) * stepMs, ...rest });
    out.push(d);
    p = d.position;
  });
  return { decisions: out, position: p, last: out[out.length - 1] };
}

/* ── 1. THE DESK'S RECORDED INCIDENT ────────────────────────────────────────────────── */
console.log("\nTHE INCIDENT THE TWO-WITNESS RULE WAS WRITTEN FOR");
/* Measured on the desk with its own policy: t1 a glitched quote at 1.9x on a position
   whose real price was 1.1x armed breakeven AND the trail; t2, an honest tick, then
   force-sold it as a "ratcheted stop". Neither may happen here. */
ok("a lone glitched print at 1.9x arms nothing", () => {
  const r = drive(open(), [1.1, 1.9, 1.1]);
  assert.equal(r.position.armedBreakeven, false,
    `armedBreakeven=${r.position.armedBreakeven} high=${r.position.high}`);
  assert.equal(r.position.armedTrail, false, `armedTrail=${r.position.armedTrail}`);
  console.log(`        marks 1.1, 1.9, 1.1 -> confirmed high ${r.position.high}, nothing armed`);
});
ok("...and the honest tick after it does NOT force a sale", () => {
  const r = drive(open(), [1.1, 1.9, 1.1]);
  assert.equal(r.last.action, "hold", `${r.last.action}: ${r.last.reason}`);
});

/* ── 2. THE FAILURE THE MEDIAN FIXES ────────────────────────────────────────────────── */
console.log("\nINTERLEAVED PRINTS — THE CASE CONSECUTIVE-CLEARING DROPS");
ok("two independent highs that are NOT adjacent still confirm", () => {
  /* 5.0, 1.0, 5.0 contains two independent observations of the same high. The desk's
     "two CONSECUTIVE clearing ticks" rejects this; a median does not. */
  const r = drive(open(), [5.0, 1.0, 5.0], NO_TAKE);
  assert.equal(r.position.high, 5.0, `high=${r.position.high}`);
  assert.ok(r.position.armedBreakeven && r.position.armedTrail,
    `breakeven=${r.position.armedBreakeven} trail=${r.position.armedTrail}`);
  console.log(`        marks 5.0, 1.0, 5.0 -> confirmed high ${r.position.high}, both armed`);
});
/* ── 2b. AND WITH THE TAKE IN PLACE, THOSE SAME SEQUENCES EXIT ─────────────────────── */
ok("the sequences parked above DO take profit when the dial is live — the interaction, recorded", () => {
  /* The mirror of NO_TAKE. If parking the take let a real behaviour go unasserted, this
     is where it would hide, so the same marks are driven with the DEFAULT dial. */
  for (const marks of [[5.0, 1.0, 5.0], [1.0, 1.0, 9.0], [1.1, 1.5, 1.7, 1.9, 2.2]]) {
    const r = drive(open(), marks);
    const first = r.decisions.find((d) => d.action === "sell");
    assert.ok(first, `${JSON.stringify(marks)} never exited under the default take`);
    assert.match(first.reason, /^take: 2x entry reached/,
      `${JSON.stringify(marks)} exited on "${first.reason}" rather than the take`);
    /* At the canary the round trip is 1.2222x, so the honest number is +63.64%, not +100%. */
    assert.match(first.reason, /realizes 63\.64%/,
      "the take must report what it REALIZES at this fill, not repeat the dial back");
  }
  const r = drive(open(), [1.1, 1.5, 1.7, 1.9, 2.2]);
  const at = r.decisions.findIndex((d) => d.action === "sell");
  console.log(`        1.1,1.5,1.7,1.9,2.2 -> take fires on mark ${[1.1, 1.5, 1.7, 1.9, 2.2][at]} (index ${at}), realizing 63.64% at a ${FX.toFixed(4)}x round trip`);
});

ok("a SINGLE observation still arms nothing, under this rule too", () => {
  /* The sloppy version of the argument above would justify arming on one print. It does
     not: one observation is not confirmation, and that is the whole incident. */
  const r = drive(open(), [1.0, 1.0, 9.0], NO_TAKE);
  assert.equal(r.position.armedBreakeven, false,
    `a lone 9.0 armed breakeven — high=${r.position.high}`);
  console.log(`        marks 1.0, 1.0, 9.0 -> confirmed high ${r.position.high}, nothing armed`);
});
ok("a position cannot arm on its first print, however good", () => {
  const d = snipePolicy({ position: open(), mark: 50, nowMs: T0 + 1 });
  assert.equal(d.position.armedBreakeven, false, "armed on the opening print");
  assert.equal(d.position.high, 0, `high=${d.position.high}`);
});

/* ── 3. A GENUINE RUN ───────────────────────────────────────────────────────────────── */
console.log("\nA GENUINE RUN ARMS, THEN TRAILS");
ok("a sustained climb confirms, arms breakeven then the trail", () => {
  const r = drive(open(), [1.1, 1.5, 1.7, 1.9, 2.2], NO_TAKE);
  assert.ok(r.position.armedBreakeven, "breakeven never armed on a real run");
  assert.ok(r.position.armedTrail, "trail never armed on a real run");
  console.log(`        confirmed high ${r.position.high.toFixed(2)} from a climb to 2.0`);
});
ok("the trail sells 25% below the confirmed high", () => {
  const r = drive(open(), [1.1, 1.5, 1.7, 1.9, 2.2], NO_TAKE);
  const high = r.position.high;
  const d = snipePolicy({ position: r.position, mark: high * 0.74, nowMs: T0 + 9000 });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /trailing stop/);
  console.log(`        high ${high.toFixed(2)}, mark ${(high * 0.74).toFixed(2)} -> ${d.reason}`);
});
ok("the confirmed high never comes back down", () => {
  const r = drive(open(), [1.1, 1.5, 1.7, 1.9, 2.2], NO_TAKE);
  const peak = r.position.high;
  const after = drive(r.position, [0.9, 0.9, 0.9]);
  assert.ok(after.position.high >= peak, `high fell from ${peak} to ${after.position.high}`);
});
ok("breakeven, once armed, sells at TRUE breakeven and not at entry", () => {
  /* A high of 1.5 arms breakeven (>= fx*1.15 = 1.406) but NOT the trail (fx*1.30 =
     1.589). That isolation is the point: at a higher confirmed high the trail sits
     tighter than friction and would fire first, which would test the wrong rule. */
  const r = drive(open(), [1.5, 1.5, 1.5]);
  assert.ok(r.position.armedBreakeven, `did not arm; high=${r.position.high}`);
  assert.equal(r.position.armedTrail, false,
    `the trail armed too at high=${r.position.high}; this case must isolate breakeven`);
  /* Just under friction must sell; just above it must not. Selling at 1.0x — the bug
     this replaced — would realise -18.18% at live size. */
  const below = snipePolicy({ position: r.position, mark: FX - 0.01, nowMs: T0 + 9000 });
  const above = snipePolicy({ position: r.position, mark: FX + 0.05, nowMs: T0 + 9000 });
  assert.equal(below.action, "sell", `${below.action}: ${below.reason}`);
  assert.match(below.reason, /breakeven/);
  assert.equal(above.action, "hold", `at ${(FX + 0.05).toFixed(3)}x it sold: ${above.reason}`);
  console.log(`        breakeven sells at ${FX.toFixed(4)}x, not 1.0x — 1.0x would realise -18.18%`);
});

/* ── 4. FAST TO EXIT ────────────────────────────────────────────────────────────────── */
console.log("\nTHE FAST HALF — NO CONFIRMATION REQUIRED TO LEAVE");
ok("the hard stop fires on a RAW mark, with no confirmation window at all", () => {
  const d = snipePolicy({ position: open(), mark: 0.15, nowMs: T0 + 1 });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /stop/);
  console.log(`        first ever print at 0.15x -> ${d.reason}`);
});
/* THE STOP IS A CATASTROPHE BACKSTOP, NOT A RISK CONTROL, and that is forced by the fee
   rail rather than chosen. minViableSolPerTrade caps fees at 25% of the STOP DISTANCE,
   so a tighter stop needs a BIGGER position — and the live cap is 0.005 SOL. Pinning it
   here means nobody can "tighten the stop to be safe" without the test showing them that
   the position stops being fundable. */
ok("the default stop is the tightest one the live cap can actually fund", () => {
  const tightest = tightestFundableStopFrac({ sizeSol: 0.005 });
  assert.ok(SNIPE_DEFAULTS.stopFrac >= tightest - 1e-9,
    `default stop ${SNIPE_DEFAULTS.stopFrac} is TIGHTER than the fundable floor ${tightest}`);
  console.log(`        live cap 0.005 SOL -> tightest fundable stop ${tightest.toFixed(2)}x, ` +
    `default ${SNIPE_DEFAULTS.stopFrac}x`);
});
ok("a 0.70x stop — the first version's default — is NOT fundable at the live cap", () => {
  const needed = (2 * 0.0005) / (0.25 * (1 - 0.70));
  assert.ok(needed > 0.005,
    `a 0.70x stop needs ${needed.toFixed(4)} SOL against a 0.005 cap`);
  console.log(`        a 0.70x stop needs ${needed.toFixed(4)} SOL — ${(needed / 0.005).toFixed(1)}x the live cap`);
});
ok("a fill so small the fee eats it has NO breakeven, and says so", () => {
  assert.equal(frictionX({ sizeSol: 0.0005, feeSolPerLeg: 0.0005 }), Infinity);
  assert.equal(frictionX({ sizeSol: 0.0001, feeSolPerLeg: 0.0005 }), Infinity);
  assert.equal(frictionX({ sizeSol: -1, feeSolPerLeg: 0.0005 }), null);
});
ok("a position with no fill economics falls back to live friction, never to 1.0x", () => {
  const bare = freshSnipe({ entry: 1, openedAt: T0 });
  const r = drive(bare, [1.5, 1.5, 1.5]);
  assert.match(r.last.reason, /breakeven is 1\.2222x/, r.last.reason);
  assert.ok(SNIPE_DEFAULTS.fallbackFrictionX > 1.2,
    `fallback ${SNIPE_DEFAULTS.fallbackFrictionX} — a fallback of 1.0 is the bug it exists to prevent`);
});
ok("the creator selling exits immediately — the one signal a launch has", () => {
  const d = snipePolicy({ position: open(), mark: 3.0, nowMs: T0 + 1, creatorSold: true });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /creator sold/);
  console.log(`        up 3x and the creator sells -> ${d.reason}`);
});
ok("a hostile chain fact exits on the FACT, not on the price", () => {
  const d = snipePolicy({ position: open(), mark: 10.0, nowMs: T0 + 1, rugFlag: true });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /chain fact/);
});
ok("a collapsed sell side is read as unsellable, above the ordinary stop", () => {
  const d = snipePolicy({ position: open(), mark: 0.05, nowMs: T0 + 1 });
  assert.equal(d.action, "sell");
  assert.match(d.reason, /pulled or unsellable/, d.reason);
});
ok("the time stop leaves a position that never did anything", () => {
  const d = snipePolicy({ position: open(), mark: 1.0, nowMs: T0 + SNIPE_DEFAULTS.timeStopMs });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /time stop/);
  console.log(`        ${d.reason}`);
});
ok("...and does not fire one tick early", () => {
  const d = snipePolicy({ position: open(), mark: 1.0, nowMs: T0 + SNIPE_DEFAULTS.timeStopMs - 1 });
  assert.equal(d.action, "hold", `${d.action}: ${d.reason}`);
});

/* ── 5. AN UNREADABLE PRICE IS NOT AN EXIT SIGNAL ───────────────────────────────────── */
console.log("\nAN UNREADABLE PRICE IS THE ABSENCE OF INFORMATION");
ok("a null or NaN mark neither sells nor enters the confirmation window", () => {
  const r = drive(open(), [1.4, 1.4]);
  const before = [...r.position.marks];
  for (const bad of [null, undefined, NaN, 0, -1, "1.5"]) {
    const d = snipePolicy({ position: r.position, mark: bad, nowMs: T0 + 5000 });
    assert.equal(d.action, "hold", `mark=${String(bad)} produced ${d.action}: ${d.reason}`);
    assert.deepEqual(d.position.marks, before, `mark=${String(bad)} corrupted the window`);
  }
  console.log(`        6 unusable marks: all hold, window unchanged at [${before}]`);
});
ok("a bad mark cannot drag the median down and un-arm a position", () => {
  const r = drive(open(), [2.0, 2.0, 2.0], NO_TAKE);
  assert.ok(r.position.armedTrail, "did not arm");
  const d = snipePolicy({ position: r.position, mark: NaN, nowMs: T0 + 9000 });
  assert.equal(d.position.high, r.position.high, `high moved to ${d.position.high}`);
  assert.ok(d.position.armedTrail, "un-armed by a bad mark");
});

/* ── 6. PURITY AND SEPARATION ───────────────────────────────────────────────────────── */
console.log("\nPURITY, AND THE DESK PATH LEFT ALONE");
ok("the input position is never mutated", () => {
  const p = open();
  const snapshot = JSON.stringify(p);
  snipePolicy({ position: p, mark: 5.0, nowMs: T0 + 1 });
  snipePolicy({ position: p, mark: 0.1, nowMs: T0 + 2 });
  assert.equal(JSON.stringify(p), snapshot, "snipePolicy mutated its argument");
});
ok("the same inputs always give the same decision — no clock, no randomness", () => {
  const p = open();
  const a = snipePolicy({ position: p, mark: 1.4, nowMs: T0 + 1 });
  const b = snipePolicy({ position: p, mark: 1.4, nowMs: T0 + 1 });
  assert.deepEqual(a, b);
});
ok("a position without an entry is refused rather than guessed at", () => {
  assert.throws(() => snipePolicy({ position: { entry: 0 }, mark: 1, nowMs: T0 }), /entry/);
  assert.throws(() => snipePolicy({ mark: 1, nowMs: T0 }), /entry/);
});
ok("every decision carries the policy version that made it", () => {
  const d = snipePolicy({ position: open(), mark: 1.0, nowMs: T0 + 1 });
  assert.equal(d.policyVersion, SNIPE_POLICY_VERSION);
  assert.equal(SNIPE_POLICY_VERSION, "snipe-v1");
});
ok("this module does not import the desk's exit policy — the two paths stay separate", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./snipe-policy.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /from\s+["']\.\/trade-policy\.mjs["']/,
    "the sniper must not share the desk's exit policy file");
  assert.doesNotMatch(code, /from\s+["']\.\/strategy\.mjs["']/);
  /* And it must reach nothing at all: no network, no disk, no clock. */
  assert.doesNotMatch(code, /require\(|fetch\(|Date\.now\(\)|node:fs|node:http/,
    "the exit determiner must be pure");
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
