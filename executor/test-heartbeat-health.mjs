import assert from "node:assert/strict";
import { executorHeartbeatHealth } from "./heartbeat-health.mjs";

assert.equal(executorHeartbeatHealth({ lastTickCompletedAt: 1, lastFeedSuccessAt: 1 }).state, "healthy");
assert.equal(executorHeartbeatHealth({ entriesPaused: true }).state, "entries-paused");
assert.equal(executorHeartbeatHealth({ blockingIntent: true }).state, "degraded");
assert.equal(executorHeartbeatHealth({ consecutiveFeedFailures: 2 }).state, "degraded");
assert.equal(executorHeartbeatHealth({ feedRollback: true }).state, "degraded");
const rollback = executorHeartbeatHealth({ feedRollback: true });
assert.equal(rollback.feedRollback, true);
const readiness = executorHeartbeatHealth({ executionReadiness: {
  ready: true, lastSuccessAt: 100, observedAt: 99, route: "wsol-usdc", providers: 2,
} });
assert.deepEqual(readiness.executionReadiness, {
  ready: true, lastSuccessAt: 100, observedAt: 99, route: "wsol-usdc", providers: 2,
});
assert.equal(executorHeartbeatHealth({ executionReadiness: { ready: false } }).state, "degraded");
assert.equal(executorHeartbeatHealth({ positions: [{ exitExecutionRequired: true }] }).state, "exits-blocked");
assert.equal(executorHeartbeatHealth({ positions: [{ manualExitRequired: true }] }).state, "manual-action");
assert.equal(executorHeartbeatHealth({ positions: [{ callIdentityIncomplete: true }] }).state, "degraded");
assert.equal(executorHeartbeatHealth({ hardStop: true }).state, "manual-action");
const bounded = executorHeartbeatHealth({ runtimeCommit: "A".repeat(40),
  runtimeFingerprint: "B".repeat(32), positions: [{}] });
assert.equal(bounded.runtimeCommit, "a".repeat(40));
assert.equal(bounded.runtimeFingerprint, "b".repeat(32));
assert.ok(!JSON.stringify(bounded).includes("secret"));

console.log("\npost-tick heartbeat distinguishes liveness from trading health\n");
