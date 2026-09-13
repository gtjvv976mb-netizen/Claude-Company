import assert from "node:assert/strict";
import { executorHeartbeatHealth, HEARTBEAT_CAP_BOUNDS } from "./heartbeat-health.mjs";

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
/* A bot armed at the operator maximum is HEALTHY, and its caps are reported. Until
   2026-09-13 the bounds here were the 0.05/0.5/0.15 canary ceilings, so a bot armed at
   0.4 SOL per trade reported caps: null and state "degraded" on every pulse while it
   was trading normally. */
const armedAtMax = executorHeartbeatHealth({ caps: {
  maxSolPerTrade: HEARTBEAT_CAP_BOUNDS.maxSolPerTrade, dailySolCap: HEARTBEAT_CAP_BOUNDS.dailySolCap,
  dailyLossLimitSol: HEARTBEAT_CAP_BOUNDS.dailyLossLimitSol, maxOpenPositions: 4,
} });
assert.equal(armedAtMax.state, "healthy", `armed at the operator maximum reads ${armedAtMax.state}`);
assert.equal(armedAtMax.caps.maxSolPerTrade, HEARTBEAT_CAP_BOUNDS.maxSolPerTrade);
const armedAboveCanary = executorHeartbeatHealth({ caps: {
  maxSolPerTrade: 0.4, dailySolCap: 1, dailyLossLimitSol: 0.4, maxOpenPositions: 4,
} });
assert.equal(armedAboveCanary.state, "healthy", "0.4 SOL per trade is within the operator maximum and must not read as degraded");
assert.deepEqual(armedAboveCanary.caps, { maxSolPerTrade: 0.4, dailySolCap: 1, dailyLossLimitSol: 0.4, maxOpenPositions: 4 });
const invalidCaps = executorHeartbeatHealth({ caps: {
  maxSolPerTrade: HEARTBEAT_CAP_BOUNDS.maxSolPerTrade + 0.000001, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4,
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

/* desk-led-v4: the desk-unreachability clock, the mirror flag and the count of positions
 * whose valuation is blind ride on the heartbeat as FACTS. None of them is a rein. */
const mirrored = executorHeartbeatHealth({ lastTickCompletedAt: 1, lastFeedSuccessAt: 1,
  deskUnreachableSince: 1_700_000_000_000, mirrorActive: true,
  positions: [{ markUnavailableSince: 5 }, {}] });
assert.equal(mirrored.deskUnreachableSince, 1_700_000_000_000, `deskUnreachableSince ${mirrored.deskUnreachableSince}`);
assert.equal(mirrored.mirrorActive, true, `mirrorActive ${mirrored.mirrorActive}`);
assert.equal(mirrored.markUnavailable, 1, `markUnavailable ${mirrored.markUnavailable}`);
assert.equal(mirrored.state, "degraded", `state while mirroring: ${mirrored.state}`);
const quiet = executorHeartbeatHealth({ lastTickCompletedAt: 1, lastFeedSuccessAt: 1 });
assert.equal(quiet.deskUnreachableSince, 0, `deskUnreachableSince when reachable: ${quiet.deskUnreachableSince}`);
assert.equal(quiet.mirrorActive, false);
assert.equal(quiet.markUnavailable, 0);
assert.equal(executorHeartbeatHealth({ deskUnreachableSince: "soon" }).deskUnreachableSince, 0,
  "a non-numeric clock is reported as 0, never as garbage");
console.log(`  mirror heartbeat: state=${mirrored.state} deskUnreachableSince=${mirrored.deskUnreachableSince} markUnavailable=${mirrored.markUnavailable}`);

console.log("\npost-tick heartbeat distinguishes liveness from trading health\n");
