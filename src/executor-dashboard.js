/**
 * WALL-ST-E DASHBOARD CONTRACT
 *
 * This module turns the local executor's outbound heartbeat and one read-only
 * public-chain balance lookup into a small UI payload. It deliberately contains no
 * command, signing, secret, RPC proxy, or cap-changing field: the website can observe
 * the tenant's machine, but it cannot operate it.
 */
import { isAddress } from "./lib/base58.js";

export const EXECUTOR_HEARTBEAT_STALE_MS = 150_000;
export const EXECUTOR_READINESS_STALE_MS = 5 * 60_000;
export const EXECUTOR_CANARY_DEFAULTS = Object.freeze({
  maxSolPerTrade: 0.005,
  rolling24hDeploySol: 0.01,
  rolling24hRealizedLossBrakeSol: 0.01,
  maxOpenPositions: 4,
});
export const EXECUTOR_OPERATOR_MAXIMA = Object.freeze({
  maxSolPerTrade: 0.05,
  rolling24hDeploySol: 0.5,
  rolling24hRealizedLossBrakeSol: 0.15,
  maxOpenPositions: 4,
});

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const count = (value) => Math.min(1_000_000, Math.max(0, Math.floor(finite(value, 0))));

const timestamp = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const publicReadiness = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amountLamports = Number(value.amountLamports);
  return {
    ready: value.ready === true,
    lastSuccessAt: timestamp(value.lastSuccessAt),
    observedAt: timestamp(value.observedAt),
    route: value.route === "wsol-usdc" ? "wsol-usdc" : null,
    providers: Number(value.providers) === 2 ? 2 : 0,
    amountLamports: Number.isSafeInteger(amountLamports) && amountLamports >= 1 &&
      amountLamports <= 50_000_000 ? amountLamports : 0,
  };
};

const publicCaps = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const caps = {
    maxSolPerTrade: finite(value.maxSolPerTrade),
    rolling24hDeploySol: finite(value.dailySolCap),
    rolling24hRealizedLossBrakeSol: finite(value.dailyLossLimitSol),
    maxOpenPositions: Number(value.maxOpenPositions),
  };
  if (!(caps.maxSolPerTrade >= 0.000001 &&
      caps.maxSolPerTrade <= EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade &&
      caps.rolling24hDeploySol >= 0.000001 &&
      caps.rolling24hDeploySol >= caps.maxSolPerTrade &&
      caps.rolling24hDeploySol <= EXECUTOR_OPERATOR_MAXIMA.rolling24hDeploySol &&
      caps.rolling24hRealizedLossBrakeSol >= 0.000001 &&
      caps.rolling24hRealizedLossBrakeSol <= EXECUTOR_OPERATOR_MAXIMA.rolling24hRealizedLossBrakeSol &&
      Number.isInteger(caps.maxOpenPositions) && caps.maxOpenPositions >= 1 &&
      caps.maxOpenPositions <= EXECUTOR_OPERATOR_MAXIMA.maxOpenPositions)) return null;
  return caps;
};

const publicHealth = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = ["healthy", "entries-paused", "degraded", "manual-action", "exits-blocked"]
    .includes(value.state) ? value.state : "degraded";
  return {
    state,
    entriesPaused: value.entriesPaused === true,
    hardStop: value.hardStop === true,
    blockingIntent: value.blockingIntent === true,
    blockedPositions: count(value.blockedPositions),
    manualAction: value.manualAction === true,
    exitBlocked: value.exitBlocked === true,
    feedRollback: value.feedRollback === true,
    lastTickCompletedAt: timestamp(value.lastTickCompletedAt),
    lastFeedSuccessAt: timestamp(value.lastFeedSuccessAt),
    consecutiveFeedFailures: count(value.consecutiveFeedFailures),
    consecutiveTickFailures: count(value.consecutiveTickFailures),
    executionReadiness: publicReadiness(value.executionReadiness),
    caps: publicCaps(value.caps),
    runtimeCommit: /^[0-9a-f]{7,40}$/i.test(String(value.runtimeCommit || ""))
      ? String(value.runtimeCommit).slice(0, 40).toLowerCase() : null,
    runtimeFingerprint: /^[0-9a-f]{32}$/i.test(String(value.runtimeFingerprint || ""))
      ? String(value.runtimeFingerprint).toLowerCase() : null,
  };
};

const publicHeartbeat = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wallet = isAddress(value.wallet) ? value.wallet : null;
  const mode = value.mode === "live" || value.mode === "paper" ? value.mode : "unknown";
  const health = publicHealth(value.health);
  return {
    mode,
    wallet,
    cursor: count(value.cursor),
    open: count(value.open),
    held: Array.isArray(value.held) ? value.held.slice(0, 20).map((holding) => ({
      mint: isAddress(holding?.mint) ? holding.mint : null,
      sol: Math.max(0, finite(holding?.sol, 0)),
      openedAt: timestamp(holding?.openedAt),
    })).filter((holding) => holding.mint) : [],
    health,
    ts: timestamp(value.ts),
    seenAt: timestamp(value.seenAt),
  };
};

const publicSettings = (settings = {}) => ({
  appetite: ["conservative", "balanced", "aggressive"].includes(settings.appetite)
    ? settings.appetite : "balanced",
  bankrollSol: Math.max(0, finite(settings.bankrollSol, 0)),
  instantDelivery: settings.instantDelivery === true,
  categories: Array.isArray(settings.categories)
    ? settings.categories.filter((value) => typeof value === "string").slice(0, 24) : [],
  launchpads: Array.isArray(settings.launchpads)
    ? settings.launchpads.filter((value) => typeof value === "string").slice(0, 24) : [],
  minLiquidityUsd: Math.max(0, finite(settings.minLiquidityUsd, 0)),
  takeProfitX: Math.max(0, finite(settings.takeProfitX, 0)),
  fixedSol: Math.max(0, finite(settings.fixedSol, 0)),
  marketCapTier: typeof settings.marketCapTier === "string"
    ? settings.marketCapTier.slice(0, 32) : "any",
  updatedAt: timestamp(settings.updatedAt),
});

const publicBalance = (wallet, result, requiredForReadinessSol = null) => {
  if (!wallet) return {
    address: null, balanceSol: null, balanceLamports: null,
    state: "not-reported", source: null, observedAt: null,
    requiredForReadinessSol: null,
  };
  const lamports = Number(result?.lamports);
  const sol = Number(result?.sol);
  const ok = result?.ok === true && Number.isSafeInteger(lamports) && lamports >= 0 &&
    Number.isFinite(sol) && sol >= 0;
  if (!ok) return {
    address: wallet, balanceSol: null, balanceLamports: null,
    state: "unavailable", source: "solana-confirmed-read", observedAt: null,
    requiredForReadinessSol,
  };
  const threshold = Number(requiredForReadinessSol);
  const state = sol === 0 ? "empty" : !(Number.isFinite(threshold) && threshold > 0)
    ? "active-caps-unavailable" : sol < threshold
      ? "below-readiness-reserve" : "ready-balance";
  return {
    address: wallet, balanceSol: sol, balanceLamports: lamports,
    state, source: "solana-confirmed-read", observedAt: timestamp(result.observedAt) || null,
    requiredForReadinessSol: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
  };
};

export function buildExecutorDashboard({
  heartbeatLog = [],
  floorNo,
  settings = {},
  heartbeat = null,
  balanceResult = null,
  nowMs = Date.now(),
} = {}) {
  const now = timestamp(nowMs) || Date.now();
  const pulse = publicHeartbeat(heartbeat);
  const ageMs = pulse?.seenAt ? Math.max(0, now - pulse.seenAt) : null;
  const connected = ageMs != null && ageMs <= EXECUTOR_HEARTBEAT_STALE_MS;
  const filters = publicSettings(settings);
  const activeCaps = pulse?.health?.caps ?? null;
  // Mirrors the no-sign readiness reserve: active trade + network-fee ceiling +
  // two-ATA rent ceiling + untouched SOL reserve. It is a display threshold only.
  const requiredForReadinessSol = activeCaps
    ? activeCaps.maxSolPerTrade + 0.0005 + 0.0042 + 0.01 : null;
  const wallet = publicBalance(pulse?.wallet ?? null, balanceResult, requiredForReadinessSol);
  const readiness = pulse?.health?.executionReadiness;
  const readinessLastSuccessAt = timestamp(readiness?.lastSuccessAt);
  const readinessObservedAt = timestamp(readiness?.observedAt);
  const readinessFresh = readinessLastSuccessAt > 0 && readinessObservedAt > 0 &&
    readinessLastSuccessAt <= now + 60_000 && readinessObservedAt <= now + 60_000 &&
    now - readinessLastSuccessAt <= EXECUTOR_READINESS_STALE_MS &&
    now - readinessObservedAt <= EXECUTOR_READINESS_STALE_MS;
  const readinessCoversActiveCap = Boolean(activeCaps && readiness &&
    readiness.amountLamports === Math.floor(activeCaps.maxSolPerTrade * 1_000_000_000));
  const executionReadinessReady = Boolean(readinessFresh && readiness?.ready === true &&
    readiness.route === "wsol-usdc" && readiness.providers === 2 && readinessCoversActiveCap);
  // The monitor treats every missing, stale, incomplete, or wrong-size live rehearsal
  // as critical. Preserve the poller's higher-severity states, but do not let the
  // human-facing status contradict that same evidence by displaying healthy/paused.
  const displayedPulse = pulse?.mode === "live" && pulse.health && !executionReadinessReady &&
    (pulse.health.state === "healthy" || pulse.health.state === "entries-paused")
    ? { ...pulse, health: { ...pulse.health, state: "degraded" } } : pulse;

  return {
    floorNo: Number(floorNo),
    telemetry: {
      source: "self-reported-by-tenant-machine",
      connected,
      // Oldest first, bounded: the WALL-ST-E tab had no history at all before this.
      history: Array.isArray(heartbeatLog) ? heartbeatLog.slice(-48).map((h) => ({
        seenAt: timestamp(h?.seenAt), mode: String(h?.mode ?? "").slice(0, 16),
        open: count(h?.open), state: h?.state == null ? null : String(h.state).slice(0, 32),
      })).filter((h) => h.seenAt) : [],
      ageMs,
      staleAfterMs: EXECUTOR_HEARTBEAT_STALE_MS,
      heartbeat: displayedPulse,
    },
    wallet,
    filters,
    activation: {
      feedCredentialReady: settings.feedCredentialReady === true,
      heartbeatSeen: Boolean(pulse),
      // A stale heartbeat is historical evidence, not present-tense readiness. Keep
      // its last-reported values visible for diagnosis, but never let them complete
      // an activation step or imply that the current process still owns this wallet.
      currentPaperMode: connected && pulse?.mode === "paper",
      currentLiveMode: connected && pulse?.mode === "live",
      executionReadinessReady: connected && executionReadinessReady,
      walletReported: connected && Boolean(wallet.address),
      walletFunded: connected && Boolean(activeCaps) && wallet.state === "ready-balance",
    },
    boundary: {
      custody: "tenant-machine-only",
      remoteControl: false,
      browserSigning: false,
      balanceReadOnly: true,
    },
    capPolicy: {
      active: activeCaps,
      activeFresh: connected && Boolean(activeCaps),
      canaryDefaults: EXECUTOR_CANARY_DEFAULTS,
      operatorMaxima: EXECUTOR_OPERATOR_MAXIMA,
      raisedCapsRequire: "local-versioned-wallet-and-values-acknowledgement",
      lossControl: "rolling-realized-loss-entry-brake-not-loss-guarantee",
    },
  };
}
