import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const POSITION_FLAGS = ["callIdentityIncomplete", "accountingIncomplete", "balanceReconciliationRequired",
  "riskDataUnavailable", "exitExecutionRequired", "manualExitRequired"];

const TRADING_RUNTIME_FILES = Object.freeze([
  "poller.mjs", "journal.mjs", "jupiter.mjs", "balance-verification.mjs",
  "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs",
  "heartbeat-health.mjs", "sleep-assertion.mjs", "strategy.mjs", "trade-policy.mjs",
]);

/** A byte identity for exactly the modules loaded by the trading process. */
export function executorRuntimeFingerprint(executorDir) {
  const dir = path.resolve(executorDir);
  const hash = crypto.createHash("sha256");
  for (const name of TRADING_RUNTIME_FILES) {
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    hash.update(name).update("\0").update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 32);
}

/** Build the bounded, non-secret health facts sent after a completed poll cycle. */
export function executorHeartbeatHealth({
  entriesPaused = false, hardStop = false, blockingIntent = false, positions = [],
  lastTickCompletedAt = 0, lastFeedSuccessAt = 0, consecutiveFeedFailures = 0,
  consecutiveTickFailures = 0, feedRollback = false, executionReadiness = null,
  runtimeCommit = null, runtimeFingerprint = null,
} = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const blockedPositions = list.filter((position) =>
    POSITION_FLAGS.some((flag) => position?.[flag] === true)).length;
  const manualAction = list.some((position) => position?.manualExitRequired === true);
  const exitBlocked = list.some((position) => position?.exitExecutionRequired === true);
  let state = "healthy";
  if (hardStop || manualAction) state = "manual-action";
  else if (exitBlocked) state = "exits-blocked";
  else if (blockingIntent || blockedPositions || consecutiveFeedFailures || consecutiveTickFailures ||
      feedRollback || executionReadiness?.ready === false)
    state = "degraded";
  else if (entriesPaused) state = "entries-paused";
  return {
    state, entriesPaused: Boolean(entriesPaused), hardStop: Boolean(hardStop),
    blockingIntent: Boolean(blockingIntent), blockedPositions, manualAction, exitBlocked,
    lastTickCompletedAt: Number(lastTickCompletedAt) || 0,
    lastFeedSuccessAt: Number(lastFeedSuccessAt) || 0,
    consecutiveFeedFailures: Math.max(0, Number(consecutiveFeedFailures) || 0),
    consecutiveTickFailures: Math.max(0, Number(consecutiveTickFailures) || 0),
    feedRollback: Boolean(feedRollback),
    executionReadiness: executionReadiness && typeof executionReadiness === "object" ? {
      ready: executionReadiness.ready === true,
      lastSuccessAt: Number(executionReadiness.lastSuccessAt) || 0,
      observedAt: Number(executionReadiness.observedAt) || 0,
      route: executionReadiness.route === "wsol-usdc" ? "wsol-usdc" : null,
      providers: Number(executionReadiness.providers) === 2 ? 2 : 0,
    } : null,
    runtimeCommit: /^[0-9a-f]{7,40}$/i.test(String(runtimeCommit || ""))
      ? String(runtimeCommit).slice(0, 40).toLowerCase() : null,
    runtimeFingerprint: /^[0-9a-f]{32}$/i.test(String(runtimeFingerprint || ""))
      ? String(runtimeFingerprint).toLowerCase() : null,
  };
}
