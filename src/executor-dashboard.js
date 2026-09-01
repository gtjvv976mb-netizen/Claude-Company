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

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const count = (value) => Math.min(1_000_000, Math.max(0, Math.floor(finite(value, 0))));

const timestamp = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const publicHeartbeat = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wallet = isAddress(value.wallet) ? value.wallet : null;
  const mode = value.mode === "live" || value.mode === "paper" ? value.mode : "unknown";
  const health = value.health && typeof value.health === "object" && !Array.isArray(value.health)
    ? value.health : null;
  return {
    mode,
    wallet,
    cursor: count(value.cursor),
    open: count(value.open),
    held: Array.isArray(value.held) ? value.held.slice(0, 20).map((holding) => ({
      mint: isAddress(holding?.mint) ? holding.mint : null,
      sol: Math.max(0, finite(holding?.sol, 0)),
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

const publicBalance = (wallet, result) => {
  if (!wallet) return {
    address: null, balanceSol: null, balanceLamports: null,
    state: "not-reported", source: null, observedAt: null,
  };
  const lamports = Number(result?.lamports);
  const sol = Number(result?.sol);
  const ok = result?.ok === true && Number.isSafeInteger(lamports) && lamports >= 0 &&
    Number.isFinite(sol) && sol >= 0;
  if (!ok) return {
    address: wallet, balanceSol: null, balanceLamports: null,
    state: "unavailable", source: "solana-confirmed-read", observedAt: null,
  };
  // The first live release can deploy at most 0.01 SOL in a rolling day. This label
  // is informational; it never changes or gates the executor's local policy.
  const state = sol === 0 ? "empty" : sol < 0.01 ? "below-daily-cap" : "funded";
  return {
    address: wallet, balanceSol: sol, balanceLamports: lamports,
    state, source: "solana-confirmed-read", observedAt: timestamp(result.observedAt) || null,
  };
};

export function buildExecutorDashboard({
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
  const wallet = publicBalance(pulse?.wallet ?? null, balanceResult);
  const readiness = pulse?.health?.executionReadiness;
  const readinessLastSuccessAt = timestamp(readiness?.lastSuccessAt);
  const readinessObservedAt = timestamp(readiness?.observedAt);
  const readinessFresh = readinessLastSuccessAt > 0 && readinessObservedAt > 0 &&
    readinessLastSuccessAt <= now + 60_000 && readinessObservedAt <= now + 60_000 &&
    now - readinessLastSuccessAt <= EXECUTOR_READINESS_STALE_MS &&
    now - readinessObservedAt <= EXECUTOR_READINESS_STALE_MS;

  return {
    floorNo: Number(floorNo),
    telemetry: {
      source: "self-reported-by-tenant-machine",
      connected,
      ageMs,
      staleAfterMs: EXECUTOR_HEARTBEAT_STALE_MS,
      heartbeat: pulse,
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
      executionReadinessReady: connected && readinessFresh &&
        readiness?.ready === true && readiness?.providers === 2,
      walletReported: connected && Boolean(wallet.address),
      walletFunded: connected && wallet.state === "funded",
    },
    boundary: {
      custody: "tenant-machine-only",
      remoteControl: false,
      browserSigning: false,
      balanceReadOnly: true,
    },
    releaseCaps: {
      maxSolPerTrade: 0.005,
      rolling24hDeploySol: 0.01,
      rolling24hLossSol: 0.01,
      maxOpenPositions: 4,
      scope: "first-live-release-hard-ceilings",
    },
  };
}
