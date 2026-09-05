/**
 * desk-led-v4 (2026-09-05): the price-exit witness and the mark-failure witness are pure
 * classifiers now — they FLAG, they never sell. The poller no longer imports the selling
 * half at all (asserted at the bottom against the source). The helpers stay tested
 * because a legacy risk_exit latch persisted by an older journal can still carry a price
 * trigger, and validateExecutableExitOrder must keep refusing a stale one while letting
 * desk_exit and mirror_exit — the desk's determinations — through untouched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ExitTriggerNotMetError, clearExitMarkFailureWitness, clearMarkUnavailable, clearPriceExitWitness,
  confirmExitMarkFailureWitness, confirmPriceExitWitness, executableExitMark, noteMarkUnavailable,
  priceExitTrigger, validateExecutableExitOrder,
} from "./exit-trigger.mjs";

const position = { mint: "Mint", stop: 0.8, entry: 1, target: 1.9, takeProfitX: 2,
  qtyRaw: "1000", entryInputLamports: "5000000", solUsdAtEntry: 150 };
const stopDecision = { action: "sell", reason: "stop loss" };
const first = priceExitTrigger(position, stopDecision, 0.79, 150, 1_000);
assert.equal(confirmPriceExitWitness(position, first).confirmed, false);
assert.equal(position.pendingPriceExit.witnesses, 1);
const second = priceExitTrigger(position, stopDecision, 0.78, 150, 16_000);
const confirmed = confirmPriceExitWitness(position, second);
assert.equal(confirmed.confirmed, true);
assert.equal(confirmed.trigger.witnesses, 2);
assert.equal(position.pendingPriceExit, undefined);

const recovered = { ...position };
confirmPriceExitWitness(recovered, first);
const hold = confirmPriceExitWitness(recovered,
  priceExitTrigger(recovered, stopDecision, 0.79, 150, 90_000));
assert.equal(hold.confirmed, false, "non-consecutive observations restart the witness pair");
clearPriceExitWitness(recovered);
assert.equal(recovered.pendingPriceExit, undefined);

const markFailurePosition = {};
assert.equal(confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 1_000, reason: "inflated minimum failed simulation" }).confirmed, false);
const markFailureConfirmed = confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 16_000, reason: "order unavailable" });
assert.equal(markFailureConfirmed.confirmed, true);
assert.equal(markFailureConfirmed.trigger.kind, "risk-data");
assert.equal(markFailureConfirmed.trigger.witnesses, 2);
assert.equal(markFailurePosition.pendingExitMarkFailure, undefined);
confirmExitMarkFailureWitness(markFailurePosition, { observedAt: 1_000, reason: "first" });
assert.equal(confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 90_000, reason: "non-consecutive" }).confirmed, false);
clearExitMarkFailureWitness(markFailurePosition);
assert.equal(markFailurePosition.pendingExitMarkFailure, undefined);

// The order service may claim 9,000,000 lamports, but policy never sees that field:
// the chain simulation's 3,000,000-lamport delta is the mark and breaches the stop.
const manipulatedQuote = "9000000";
const simulatedActual = "3000000";
const chainMark = executableExitMark(position, simulatedActual, 150);
assert.equal(chainMark, 0.6);
assert.ok(chainMark < position.stop);
assert.notEqual(chainMark, Number(manipulatedQuote) / Number(position.entryInputLamports));

const stopIntent = { kind: "risk_exit", amountRaw: "1000", context: {
  position, trigger: confirmed.trigger,
} };
assert.ok(validateExecutableExitOrder(stopIntent,
  { outAmount: "3900000", otherAmountThreshold: "3800000" }, { nowMs: 20_000 }));
assert.throws(() => validateExecutableExitOrder(stopIntent,
  { outAmount: "4500000", otherAmountThreshold: "4300000" }, { nowMs: 20_000 }),
  (error) => error instanceof ExitTriggerNotMetError && error.code === "EXIT_TRIGGER_NOT_MET");

const targetTrigger = priceExitTrigger(position, { action: "sell", reason: "desk target hit" }, 1.95, 150, 30_000);
const targetIntent = { kind: "risk_exit", amountRaw: "1000", context: { position, trigger: targetTrigger } };
assert.ok(validateExecutableExitOrder(targetIntent,
  { outAmount: "10000000", otherAmountThreshold: "9600000" }, { nowMs: 31_000 }));
assert.throws(() => validateExecutableExitOrder(targetIntent,
  { outAmount: "10000000", otherAmountThreshold: "9000000" }, { nowMs: 31_000 }),
  /no longer confirms/);
assert.throws(() => validateExecutableExitOrder(stopIntent,
  { outAmount: "3900000", otherAmountThreshold: "3800000" }, { nowMs: 100_000 }),
  /trigger is stale/);
assert.equal(validateExecutableExitOrder({ kind: "desk_exit", context: { position } }, {}, {}), null);
// A mirror exit is the desk's determination evaluated by the bot: exempt the same way,
// even when a caller attaches a price trigger to it by mistake.
const mirrorVerdict = validateExecutableExitOrder(
  { kind: "mirror_exit", amountRaw: "1000", context: { position, trigger: confirmed.trigger } },
  { outAmount: "4500000", otherAmountThreshold: "4300000" }, { nowMs: 20_000 });
assert.equal(mirrorVerdict, null, `mirror_exit re-validation returned ${JSON.stringify(mirrorVerdict)}`);
console.log(`  mirror_exit exempt from trigger re-validation: ${mirrorVerdict}`);

// The mark-unavailable HEALTH flag: anchored on the first failure, cleared by a good mark.
const blind = {};
const firstOutage = noteMarkUnavailable(blind, { observedAt: 1_000, reason: "fetch failed", transient: true });
const laterOutage = noteMarkUnavailable(blind, { observedAt: 61_000, reason: "fetch failed", transient: true });
assert.equal(firstOutage, 0, `first outage age ${firstOutage}`);
assert.equal(laterOutage, 60_000, `outage age after 60s ${laterOutage}`);
assert.equal(blind.markUnavailableSince, 1_000, `markUnavailableSince ${blind.markUnavailableSince}`);
assert.equal(blind.markUnavailableTransient, true);
clearMarkUnavailable(blind);
assert.equal(blind.markUnavailableSince, undefined);
console.log(`  markUnavailableSince anchors on the first failure (age ${laterOutage}ms at t=61s) and clears on a good mark`);

// And the poller does not import the selling half any more.
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
for (const name of ["confirmPriceExitWitness", "priceExitTrigger", "confirmExitMarkFailureWitness"]) {
  assert.ok(!poller.includes(`${name}(`), `poller.mjs still calls ${name}`);
  console.log(`  poller.mjs never calls ${name}()`);
}

console.log("\nwitnesses flag and never sell; desk and mirror exits are executed without re-validation\n");
