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
import { snipePolicy, freshSnipe, SNIPE_DEFAULTS, SNIPE_POLICY_VERSION } from "./snipe-policy.mjs";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };

const T0 = 1_700_000_000_000;
const open = (entry = 1.0) => freshSnipe({ entry, openedAt: T0, creator: "Dev111" });

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
  const r = drive(open(), [5.0, 1.0, 5.0]);
  assert.equal(r.position.high, 5.0, `high=${r.position.high}`);
  assert.ok(r.position.armedBreakeven && r.position.armedTrail,
    `breakeven=${r.position.armedBreakeven} trail=${r.position.armedTrail}`);
  console.log(`        marks 5.0, 1.0, 5.0 -> confirmed high ${r.position.high}, both armed`);
});
ok("a SINGLE observation still arms nothing, under this rule too", () => {
  /* The sloppy version of the argument above would justify arming on one print. It does
     not: one observation is not confirmation, and that is the whole incident. */
  const r = drive(open(), [1.0, 1.0, 9.0]);
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
  const r = drive(open(), [1.1, 1.4, 1.45, 1.6, 2.0]);
  assert.ok(r.position.armedBreakeven, "breakeven never armed on a real run");
  assert.ok(r.position.armedTrail, "trail never armed on a real run");
  console.log(`        confirmed high ${r.position.high.toFixed(2)} from a climb to 2.0`);
});
ok("the trail sells 25% below the confirmed high", () => {
  const r = drive(open(), [1.1, 1.4, 1.45, 1.6, 2.0]);
  const high = r.position.high;
  const d = snipePolicy({ position: r.position, mark: high * 0.74, nowMs: T0 + 9000 });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /trailing stop/);
  console.log(`        high ${high.toFixed(2)}, mark ${(high * 0.74).toFixed(2)} -> ${d.reason}`);
});
ok("the confirmed high never comes back down", () => {
  const r = drive(open(), [1.1, 1.4, 1.45, 1.6, 2.0]);
  const peak = r.position.high;
  const after = drive(r.position, [0.9, 0.9, 0.9]);
  assert.ok(after.position.high >= peak, `high fell from ${peak} to ${after.position.high}`);
});
ok("breakeven, once armed, sells at entry rather than riding back to the stop", () => {
  const r = drive(open(), [1.4, 1.4, 1.4]);
  assert.ok(r.position.armedBreakeven, "did not arm");
  const d = snipePolicy({ position: r.position, mark: 0.99, nowMs: T0 + 9000 });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.match(d.reason, /breakeven/);
});

/* ── 4. FAST TO EXIT ────────────────────────────────────────────────────────────────── */
console.log("\nTHE FAST HALF — NO CONFIRMATION REQUIRED TO LEAVE");
ok("the hard stop fires on a RAW mark, with no confirmation window at all", () => {
  const d = snipePolicy({ position: open(), mark: 0.5, nowMs: T0 + 1 });
  assert.equal(d.action, "sell", `${d.action}: ${d.reason}`);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /stop/);
  console.log(`        first ever print at 0.5x -> ${d.reason}`);
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
  const r = drive(open(), [2.0, 2.0, 2.0]);
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
