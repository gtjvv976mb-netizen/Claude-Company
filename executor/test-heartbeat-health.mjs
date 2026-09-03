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
  amountLamports: 50_000_000,
}, caps: {
  maxSolPerTrade: 0.05, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4,
} });
assert.deepEqual(readiness.executionReadiness, {
  ready: true, lastSuccessAt: 100, observedAt: 99, route: "wsol-usdc", providers: 2,
  amountLamports: 50_000_000, lastError: null,
});

/* WHY IT IS NOT READY TRAVELS WITH THE FACT THAT IT IS NOT.
 * The probe's failure path was an empty catch, so a bot with both RPCs green reported
 * "providers 0" and nothing else — an operator could not tell whether the probe had run
 * at all, and went to the source to find out. The reason rides on the heartbeat now. */
const refused = executorHeartbeatHealth({ executionReadiness: {
  ready: false, lastSuccessAt: 0, observedAt: 99, route: "wsol-usdc", providers: 0,
  amountLamports: 5_000_000,
  lastError: "execution-readiness wallet reserve is insufficient on one or both RPC providers",
} });
assert.match(refused.executionReadiness.lastError, /wallet reserve is insufficient/);
assert.equal(refused.executionReadiness.providers, 0);
// Bounded, and never a non-string: this is a self-reported field from a tenant machine.
assert.equal(executorHeartbeatHealth({ executionReadiness: {
  ready: false, lastError: { evil: true } } }).executionReadiness.lastError, null);
assert.equal(executorHeartbeatHealth({ executionReadiness: {
  ready: false, lastError: "x".repeat(900) } }).executionReadiness.lastError.length, 300);
assert.deepEqual(readiness.caps, {
  maxSolPerTrade: 0.05, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4,
});
const invalidCaps = executorHeartbeatHealth({ caps: {
  maxSolPerTrade: 0.050001, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4,
} });
assert.equal(invalidCaps.caps, null);
assert.equal(invalidCaps.state, "degraded",
  "supplied invalid cap evidence cannot be erased while health remains healthy");
const subminimumCaps = executorHeartbeatHealth({ caps: {
  maxSolPerTrade: 0.0000009, dailySolCap: 0.01,
  dailyLossLimitSol: 0.01, maxOpenPositions: 4,
} });
assert.equal(subminimumCaps.caps, null);
assert.equal(subminimumCaps.state, "degraded");
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
