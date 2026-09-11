/* THE CHECKLIST THAT TURNS "ARMING" FROM A JUDGEMENT CALL INTO A FUNCTION.
 *
 * The lane is still refused execute at config parse and again at construction. What this
 * file tests is the checklist those refusals are standing in front of — written down and
 * executable NOW, rather than discovered one clause at a time on the day somebody unlocks
 * it at 2am because a launch looked good.
 *
 * Every item in it is a defect found by auditing the lane against one question: what
 * breaks the first time this holds a real bag? Every one of them costs nothing today,
 * which is exactly why none of them had been noticed.
 */
import assert from "node:assert/strict";
import { armabilityReport, assertArmable, snipeLaneConfig, effectiveLaneConfig,
  LANE_SIGNALS, SNIPE_OPERATOR_MAX } from "./snipe-lane.mjs";
import { PUMPFUN_VENUE } from "./snipe-venue-pumpfun.mjs";
import { SNIPE_DEFAULTS } from "./snipe-policy.mjs";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
const itemOf = (r, name) => r.items.find((i) => i.name === name);

/* A proved venue, for the cases that are about the OTHER items. Deliberately a fake:
   asserting against the real adapter's proof would make this file pass or fail on
   whether someone had verified pump.fun that week. */
const PROVED = { ...PUMPFUN_VENUE, layoutVerified: true, layoutProof: { provedBy: "a fixture, in this test only" } };

console.log("\nTHE SHIPPED CONFIGURATION IS NOT ARMABLE, AND SAYS WHY");
ok("the lane as it ships today is refused, on the one item nobody can reason past", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE });
  assert.equal(r.armable, false);
  assert.deepEqual([...r.blocking].sort(), ["exit_signals_are_wired", "venue_layout_is_proved"],
    "the shipped lane's blocking set changed — if an item was cleared, say so here");
  console.log(`        blocking: ${r.blocking.join(", ")}`);
});

ok("...and every item carries a detail a human can act on, not just a boolean", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE });
  for (const i of r.items) {
    assert.equal(typeof i.detail, "string");
    assert.ok(i.detail.length > 30, `${i.name} says only "${i.detail}"`);
  }
  assert.equal(r.items.length, 6, `${r.items.length} items — the checklist changed size`);
});

console.log("\nA DAILY CAP THAT CANNOT SEE THE SPEND IS NOT A DAILY CAP");
/* THIS STARTED AS A CHECKLIST ITEM AND BECAME A GUARANTEE, which is the better outcome.
 *
 * chargeDailyCap defaults false. That default is CORRECT for a shadow book — one that
 * silenced itself after two notices would measure nothing — and catastrophic for a lane
 * with a wallet, because deployedTodaySol then stays 0 for ever and dailySolCap never
 * binds, whatever it is set to. The first version of this file asserted that the flag
 * being off BLOCKED arming, i.e. that a person had to remember it.
 *
 * The one flag whose misconfiguration removes a money cap entirely should not be a flag.
 * effectiveLaneConfig() now forces it on for execute, so the mode decides and the operator
 * cannot set it wrong. These assertions moved from "the list catches it" to "it cannot
 * happen", and the last one is what fails if that forcing is ever removed. */
ok("an observe lane keeps the shadow-book default, so the book still measures", () => {
  assert.equal(effectiveLaneConfig({ lane: "observe", chargeDailyCap: false }).chargeDailyCap, false);
});
ok("an EXECUTING lane charges its daily cap however it was configured", () => {
  for (const stated of [false, undefined, null, 0, ""]) {
    assert.equal(effectiveLaneConfig({ lane: "execute", chargeDailyCap: stated }).chargeDailyCap, true,
      `an executing lane configured chargeDailyCap=${JSON.stringify(stated)} would spend with no daily cap`);
  }
});
ok("...so the checklist item passes by construction, and says which", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PROVED });
  const item = itemOf(r, "daily_cap_is_charged");
  assert.equal(item.ok, true);
  assert.match(item.detail, /the mode forces the charge on/);
});

console.log("\nTHE OWNER'S TWO DIALS, CHECKED AGAINST EACH OTHER");
ok("a 2x take at the canary passes and reports what it REALLY pays", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PROVED });
  assert.match(itemOf(r, "take_is_fundable").detail, /2x take realizes 63\.64% at a 1\.2222x round trip/);
});

ok("RAISING THE SIZE BLOCKS ON THE STOP, because 0.20 was never a risk appetite", () => {
  /* This is the interaction the owner cannot be expected to spot: the size dial and the
     stop dial are coupled through the fee rail. 0.20 is the TIGHTEST stop a 0.005 SOL
     ticket can fund; at 0.4 SOL the tightest fundable is 0.99, so carrying 0.20 across is
     an 80% drawdown on a position eighty times larger — a default outliving its own
     arithmetic. Arming must not be possible without looking at it. */
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED });
  assert.equal(r.armable, false);
  assert.ok(r.blocking.includes("stop_is_fundable"), `blocking ${r.blocking.join(", ")}`);
  assert.match(itemOf(r, "stop_is_fundable").detail, /80% drawdown before it speaks/);
  /* And at that size the SAME 2x take is worth far more, which is the other half. */
  assert.match(itemOf(r, "take_is_fundable").detail, /2x take realizes 99\.50% at a 1\.0025x round trip/);
  console.log(`        0.4 SOL: ${itemOf(r, "take_is_fundable").detail}`);
  console.log(`        0.4 SOL: ${itemOf(r, "stop_is_fundable").detail.slice(0, 104)}`);
});

ok("...and stating the stop explicitly clears THAT item, without clearing the rest", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED, stopExplicit: true });
  assert.deepEqual(r.blocking, ["exit_signals_are_wired"],
    `expected only the unwired-signal item to remain, got ${r.blocking.join(", ")}`);
  console.log(`        at ${SNIPE_OPERATOR_MAX.maxSolPerTrade} SOL the stop item clears once stated; ` +
    `${r.blocking.length} item(s) still blocking`);
});

console.log("\nTHE LAYOUT IS THE ONE NOBODY CAN REASON THEIR WAY PAST");
ok("an unproved venue blocks, and the reason is the failure mode, not the rule", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE });
  assert.match(itemOf(r, "venue_layout_is_proved").detail,
    /does not refuse, it signs and lands/);
});
ok("layoutVerified:true WITHOUT a proof object is not enough", () => {
  /* A boolean anyone can flip is not evidence. The proof object is what a reviewer reads. */
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }),
    venue: { ...PUMPFUN_VENUE, layoutVerified: true } });
  assert.equal(itemOf(r, "venue_layout_is_proved").ok, false);
});

console.log("\nTHE REFUSAL NAMES EVERY UNMET ITEM, NOT THE FIRST");
ok("assertArmable throws listing all of them at once", () => {
  /* Driven against a config with TWO unmet items on purpose. The shipped lane now blocks
     on one, and a test of "names every unmet item" that can only ever see one item is not
     testing the property — it is testing that a list of length one has length one. */
  const twoProblems = { ...snipeLaneConfig({ SNIPE_LANE: "observe" }),
    maxSolPerTrade: SNIPE_OPERATOR_MAX.maxSolPerTrade + 1 };
  assert.throws(
    () => assertArmable({ cfg: twoProblems, venue: PUMPFUN_VENUE }),
    (err) => err.clause === "not_armable"
      && /size_within_operator_max/.test(err.message)
      && /venue_layout_is_proved/.test(err.message)
      /* THREE, not two: raising the size past the ceiling also trips the stop, because
         stopFrac 0.20 is only fundable at the canary. That coupling is the feature, and
         a test written expecting two would have been quietly wrong about it. */
      && /stop_is_fundable/.test(err.message)
      && err.detail.blocking.length === 4,
    "a checklist that stops at the first failure makes arming an N-round guessing game");
});
ok("...and the dead-branch item is a REAL blocker, not a note", () => {
  /* creatorSold is the branch snipe-policy calls "the one signal a launch has that no
     later market does", and stepOne passes it a literal false. The policy is fine; the
     fact never arrives. A dead branch reads as a protection to whoever reviews the exits,
     so arming blocks on it rather than mentioning it. */
  assert.equal(LANE_SIGNALS.creatorSold, "unwired");
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED, stopExplicit: true });
  assert.equal(r.armable, false);
  assert.match(itemOf(r, "exit_signals_are_wired").detail, /creatorSold is a branch that cannot fire/);
  /* And every other signal IS wired, so this item is not a blanket "nothing works". */
  const wired = Object.entries(LANE_SIGNALS).filter(([, v]) => v === "wired").map(([k]) => k);
  assert.ok(wired.length >= 7, `only ${wired.length} signals wired: ${wired.join(", ")}`);
  console.log(`        ${wired.length} wired (${wired.join(", ")}), 1 unwired (creatorSold)`);
});

console.log("\nTHE SIZE CEILING IS IN THE CHECKLIST TOO, NOT ONLY IN THE PARSER");
ok("a config built around the parser still fails the size item", () => {
  /* snipeLaneConfig refuses an over-ceiling size, but armabilityReport takes a cfg OBJECT
     and callers can build one by hand. Defence in depth: the checklist re-checks rather
     than trusting that every path came through the parser. */
  const overSize = SNIPE_OPERATOR_MAX.maxSolPerTrade + 1;
  const r = armabilityReport({
    cfg: { ...snipeLaneConfig({ SNIPE_LANE: "observe" }), maxSolPerTrade: overSize },
    venue: PROVED });
  assert.equal(itemOf(r, "size_within_operator_max").ok, false);
  assert.match(itemOf(r, "size_within_operator_max").detail, /operator maximum of 0\.4 SOL/);
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
