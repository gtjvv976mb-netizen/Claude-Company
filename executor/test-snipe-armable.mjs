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
import { armabilityReport, assertArmable, snipeLaneConfig, SNIPE_OPERATOR_MAX } from "./snipe-lane.mjs";
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
ok("the lane as it ships today is refused, on two named items", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE });
  assert.equal(r.armable, false);
  assert.deepEqual([...r.blocking].sort(), ["daily_cap_is_charged", "venue_layout_is_proved"]);
  console.log(`        blocking: ${r.blocking.join(", ")}`);
});

ok("...and every item carries a detail a human can act on, not just a boolean", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE });
  for (const i of r.items) {
    assert.equal(typeof i.detail, "string");
    assert.ok(i.detail.length > 30, `${i.name} says only "${i.detail}"`);
  }
  assert.equal(r.items.length, 5, `${r.items.length} items — the checklist changed size`);
});

console.log("\nA DAILY CAP THAT CANNOT SEE THE SPEND IS NOT A DAILY CAP");
ok("chargeDailyCap off blocks arming, and the reason names the consequence", () => {
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PROVED });
  const item = itemOf(r, "daily_cap_is_charged");
  assert.equal(item.ok, false);
  assert.match(item.detail, /deployedTodaySol stays 0 and dailySolCap NEVER binds/);
  /* The default is not a mistake — it is right for a shadow book and wrong for a wallet. */
  assert.match(item.detail, /correct for a shadow book/);
});
ok("...and turning it on clears that item", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1" }), venue: PROVED });
  assert.equal(itemOf(r, "daily_cap_is_charged").ok, true);
});

console.log("\nTHE OWNER'S TWO DIALS, CHECKED AGAINST EACH OTHER");
ok("a 2x take at the canary passes and reports what it REALLY pays", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1" }), venue: PROVED });
  assert.match(itemOf(r, "take_is_fundable").detail, /2x take realizes 63\.64% at a 1\.2222x round trip/);
});

ok("RAISING THE SIZE BLOCKS ON THE STOP, because 0.20 was never a risk appetite", () => {
  /* This is the interaction the owner cannot be expected to spot: the size dial and the
     stop dial are coupled through the fee rail. 0.20 is the TIGHTEST stop a 0.005 SOL
     ticket can fund; at 0.4 SOL the tightest fundable is 0.99, so carrying 0.20 across is
     an 80% drawdown on a position eighty times larger — a default outliving its own
     arithmetic. Arming must not be possible without looking at it. */
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1",
      SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED });
  assert.equal(r.armable, false);
  assert.deepEqual(r.blocking, ["stop_is_fundable"]);
  assert.match(itemOf(r, "stop_is_fundable").detail, /80% drawdown before it speaks/);
  /* And at that size the SAME 2x take is worth far more, which is the other half. */
  assert.match(itemOf(r, "take_is_fundable").detail, /2x take realizes 99\.50% at a 1\.0025x round trip/);
  console.log(`        0.4 SOL: ${itemOf(r, "take_is_fundable").detail}`);
  console.log(`        0.4 SOL: ${itemOf(r, "stop_is_fundable").detail.slice(0, 104)}`);
});

ok("...and stating the stop explicitly for that size clears it", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1",
      SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED, stopExplicit: true });
  assert.equal(r.armable, true, `still blocking on ${r.blocking.join(", ")}`);
  console.log(`        armable at ${SNIPE_OPERATOR_MAX.maxSolPerTrade} SOL once the stop is stated`);
});

console.log("\nTHE LAYOUT IS THE ONE NOBODY CAN REASON THEIR WAY PAST");
ok("an unproved venue blocks, and the reason is the failure mode, not the rule", () => {
  const r = armabilityReport({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1" }), venue: PUMPFUN_VENUE });
  assert.match(itemOf(r, "venue_layout_is_proved").detail,
    /does not refuse, it signs and lands/);
});
ok("layoutVerified:true WITHOUT a proof object is not enough", () => {
  /* A boolean anyone can flip is not evidence. The proof object is what a reviewer reads. */
  const r = armabilityReport({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1" }),
    venue: { ...PUMPFUN_VENUE, layoutVerified: true } });
  assert.equal(itemOf(r, "venue_layout_is_proved").ok, false);
});

console.log("\nTHE REFUSAL NAMES EVERY UNMET ITEM, NOT THE FIRST");
ok("assertArmable throws listing all of them at once", () => {
  assert.throws(
    () => assertArmable({ cfg: snipeLaneConfig({ SNIPE_LANE: "observe" }), venue: PUMPFUN_VENUE }),
    (err) => err.clause === "not_armable"
      && /daily_cap_is_charged/.test(err.message)
      && /venue_layout_is_proved/.test(err.message),
    "a checklist that stops at the first failure makes arming an N-round guessing game");
});
ok("...and passes through when everything is met", () => {
  const r = assertArmable({
    cfg: snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1",
      SNIPE_MAX_SOL_PER_TRADE: "0.4" }),
    venue: PROVED, stopExplicit: true });
  assert.equal(r.armable, true);
});

console.log("\nTHE SIZE CEILING IS IN THE CHECKLIST TOO, NOT ONLY IN THE PARSER");
ok("a config built around the parser still fails the size item", () => {
  /* snipeLaneConfig refuses an over-ceiling size, but armabilityReport takes a cfg OBJECT
     and callers can build one by hand. Defence in depth: the checklist re-checks rather
     than trusting that every path came through the parser. */
  const overSize = SNIPE_OPERATOR_MAX.maxSolPerTrade + 1;
  const r = armabilityReport({
    cfg: { ...snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_CHARGE_DAILY_CAP: "1" }), maxSolPerTrade: overSize },
    venue: PROVED });
  assert.equal(itemOf(r, "size_within_operator_max").ok, false);
  assert.match(itemOf(r, "size_within_operator_max").detail, /operator maximum of 0\.4 SOL/);
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
