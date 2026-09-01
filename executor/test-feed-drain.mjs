import assert from "node:assert/strict";
import fs from "node:fs";
import {
  advanceFrozenBatchCursor, authenticatedFeedCursorState, waitForRecoveryBudget,
} from "./feed-drain.mjs";

const first = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, type: "entry" }));
assert.equal(advanceFrozenBatchCursor(0, first), 50,
  "an unresolved intent must not pin the feed forever to its first LIMIT 50 window");
const second = Array.from({ length: 50 }, (_, index) => ({ id: index + 51,
  type: index === 49 ? "exit" : "entry" }));
assert.equal(advanceFrozenBatchCursor(50, second), 100,
  "the next batch, including a newer desk exit, becomes visible on the next poll");
assert.equal(advanceFrozenBatchCursor(100, []), 100);
assert.throws(() => advanceFrozenBatchCursor(5, [{ id: 6 }, { id: 6 }]), /strictly increasing/);
assert.throws(() => advanceFrozenBatchCursor(5, [{ id: 4 }]), /strictly increasing/);
assert.deepEqual(authenticatedFeedCursorState(100, 99), {
  rollback: true, cursor: 100, latestId: 99, lag: null,
}, "authenticated server rollback is not representable as zero/negative lag");
assert.deepEqual(authenticatedFeedCursorState(100, 103), {
  rollback: false, cursor: 100, latestId: 103, lag: 3,
});

let releaseBudget;
let cancelledTimer = false;
const wedgedRecoveries = [new Promise(() => {}), new Promise(() => {})];
const budgetResult = waitForRecoveryBudget(wedgedRecoveries[0], 1_000, {
  schedule(callback) { releaseBudget = callback; return 17; },
  cancel(timer) { assert.equal(timer, 17); cancelledTimer = true; },
});
releaseBudget();
assert.equal(await budgetResult, "budget-exhausted",
  "a wedged submitted intent must release the foreground before position safety");
assert.equal(cancelledTimer, true);
assert.equal(await waitForRecoveryBudget(Promise.resolve(), 1_000, {
  schedule() { return 18; }, cancel() {},
}), "completed");

const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
assert.match(poller, /deferDeskExitForEntry/,
  "an exit for a not-yet-accounted buy must be journaled before the cursor drains");
assert.match(poller, /consumeDeferredDeskExit: Boolean\(deferredExit\)/,
  "confirmed entry accounting must atomically consume its deferred exit");
assert.match(poller, /unsafeExitPrepass[\s\S]*cursor stays pinned/,
  "the cursor must not advance when an exit could not be durably represented");
assert.match(poller, /CRITICAL FEED ROLLBACK:[\s\S]*entries remain frozen; local position\/risk exits continue/,
  "a feed rollback must freeze entries without disabling local position exits");
assert.match(poller, /feedRollback: feedRollbackActive\(\)/,
  "feed rollback must be visible in the post-tick heartbeat");
assert.match(poller, /waitForRecoveryBudget\(pass,[\s\S]*Math\.min\(1_000/,
  "pending recoveries must not occupy more than one second before fresh risk evaluation");
assert.match(poller, /recoverPending\(options\)[\s\S]*maxIntents: 1/,
  "only one pending intent may be reconciled in each bounded recovery pass");

console.log("\nfrozen-exposure feed draining preserves exit visibility\n");
