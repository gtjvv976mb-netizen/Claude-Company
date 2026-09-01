import assert from "node:assert/strict";
import fs from "node:fs";

if (!process.env.CLAUDE_CO_DB)
  throw new Error("test runner must provide CLAUDE_CO_DB");

const db = (await import("./src/lib/store.js")).default;
const { buildExecutorDashboard, EXECUTOR_CANARY_DEFAULTS, EXECUTOR_OPERATOR_MAXIMA } =
  await import("./src/executor-dashboard.js");
const { executorStatusPayload, floorFeedSettingsForViewer } = await import("./src/office.js");
const { settingsFor } = await import("./src/copy.js");
const { HQ_FLOOR } = await import("./src/tower.js");

const now = 1_800_000_000_000;
const wallet = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";
const mint = "So11111111111111111111111111111111111111112";

const dashboard = buildExecutorDashboard({
  floorNo: 50,
  nowMs: now,
  heartbeat: {
    mode: "live", wallet, cursor: 12, open: 1,
    held: [{ mint, sol: 0.005 }, { mint: "not-an-address", sol: 999 }],
    health: { state: "entries-paused", entriesPaused: true, secret: "nested-must-not-cross",
      executionReadiness: { ready: true, providers: 2,
        lastSuccessAt: now - 20_000, observedAt: now - 20_000,
        route: "wsol-usdc", amountLamports: 5_000_000 },
      caps: { maxSolPerTrade: 0.005, dailySolCap: 0.01,
        dailyLossLimitSol: 0.01, maxOpenPositions: 4 } },
    ts: now - 40_000, seenAt: now - 30_000,
    secret: "must-not-cross",
  },
  balanceResult: { ok: true, lamports: 20_000_000, sol: 0.02, observedAt: now },
  settings: {
    feedCredentialReady: true, appetite: "aggressive", bankrollSol: 2,
    instantDelivery: true, categories: ["memecoin"], launchpads: ["pump.fun"],
    minLiquidityUsd: 25_000, takeProfitX: 2, fixedSol: 0.003,
    marketCapTier: "micro", updatedAt: now - 1_000,
    executorSecret: "must-not-cross",
  },
});

assert.equal(dashboard.telemetry.connected, true);
assert.equal(dashboard.telemetry.source, "self-reported-by-tenant-machine");
assert.equal(dashboard.telemetry.heartbeat.held.length, 1);
assert.equal(dashboard.wallet.state, "ready-balance");
assert.equal(dashboard.wallet.source, "solana-confirmed-read");
assert.equal(dashboard.activation.executionReadinessReady, true);
assert.equal(dashboard.activation.walletFunded, true);
assert.equal(dashboard.boundary.remoteControl, false);
assert.deepEqual(dashboard.capPolicy.canaryDefaults, EXECUTOR_CANARY_DEFAULTS);
assert.deepEqual(dashboard.capPolicy.operatorMaxima, EXECUTOR_OPERATOR_MAXIMA);
assert.equal(dashboard.capPolicy.active.maxSolPerTrade, 0.005);
assert.ok(!JSON.stringify(dashboard).includes("must-not-cross"));

const raisedPulse = {
  mode: "live", wallet, seenAt: now - 1_000,
  health: {
    state: "entries-paused", entriesPaused: true,
    caps: { maxSolPerTrade: 0.05, dailySolCap: 0.5,
      dailyLossLimitSol: 0.15, maxOpenPositions: 4 },
    executionReadiness: { ready: true, providers: 2, route: "wsol-usdc",
      lastSuccessAt: now - 1_000, observedAt: now - 1_000, amountLamports: 5_000_000 },
  },
};
const raisedMismatch = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: raisedPulse,
  balanceResult: { ok: true, lamports: 100_000_000, sol: 0.1, observedAt: now } });
assert.equal(raisedMismatch.activation.executionReadinessReady, false,
  "a raised executor cannot inherit readiness from the smaller default rehearsal");
assert.equal(raisedMismatch.telemetry.heartbeat.health.state, "degraded",
  "a wrong-size live rehearsal cannot display entries-paused/healthy status");
const raisedReady = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { ...raisedPulse, health: { ...raisedPulse.health,
    executionReadiness: { ...raisedPulse.health.executionReadiness, amountLamports: 50_000_000 } } },
  balanceResult: { ok: true, lamports: 100_000_000, sol: 0.1, observedAt: now } });
assert.equal(raisedReady.activation.executionReadinessReady, true);
assert.equal(raisedReady.activation.walletFunded, true);
assert.ok(Math.abs(raisedReady.wallet.requiredForReadinessSol - 0.0647) < 1e-12);

const capsMissing = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy" } },
  balanceResult: { ok: true, lamports: 1_000_000_000, sol: 1, observedAt: now } });
assert.equal(capsMissing.wallet.state, "active-caps-unavailable");
assert.equal(capsMissing.activation.walletFunded, false,
  "a positive balance cannot claim readiness until active caps are known");
assert.equal(capsMissing.telemetry.heartbeat.health.state, "degraded",
  "a live heartbeat without active-cap evidence cannot display healthy status");
const capsBelowMinimum = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxSolPerTrade: 0.0000009,
      dailySolCap: 0.01, dailyLossLimitSol: 0.01, maxOpenPositions: 4 } } } });
assert.equal(capsBelowMinimum.capPolicy.active, null);
assert.equal(capsBelowMinimum.telemetry.heartbeat.health.state, "degraded");
const readinessMissing = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxSolPerTrade: 0.005,
      dailySolCap: 0.01, dailyLossLimitSol: 0.01, maxOpenPositions: 4 } } } });
assert.equal(readinessMissing.telemetry.heartbeat.health.state, "degraded",
  "a live heartbeat without readiness evidence cannot display healthy status");
const readinessStale = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxSolPerTrade: 0.005,
      dailySolCap: 0.01, dailyLossLimitSol: 0.01, maxOpenPositions: 4 },
    executionReadiness: { ready: true, providers: 2, route: "wsol-usdc",
      lastSuccessAt: now - 300_001, observedAt: now - 300_001,
      amountLamports: 5_000_000 } } } });
assert.equal(readinessStale.telemetry.heartbeat.health.state, "degraded",
  "stale live readiness cannot display healthy status");
const manualWithoutReadiness = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "manual-action", caps: { maxSolPerTrade: 0.005,
      dailySolCap: 0.01, dailyLossLimitSol: 0.01, maxOpenPositions: 4 } } } });
assert.equal(manualWithoutReadiness.telemetry.heartbeat.health.state, "manual-action",
  "missing readiness must not hide a higher-severity operator action state");

const stale = buildExecutorDashboard({
  floorNo: 50, nowMs: now,
  heartbeat: { mode: "paper", wallet, seenAt: now - 151_000,
    health: { executionReadiness: { ready: true, providers: 2,
      lastSuccessAt: now - 20_000, observedAt: now - 20_000,
      route: "wsol-usdc", amountLamports: 50_000_000 },
      caps: { maxSolPerTrade: 0.05, dailySolCap: 0.5,
        dailyLossLimitSol: 0.15, maxOpenPositions: 4 } } },
  balanceResult: { ok: true, lamports: 20_000_000, sol: 0.02 },
});
assert.equal(stale.telemetry.connected, false);
assert.equal(stale.wallet.state, "below-readiness-reserve",
  "the historical wallet balance may remain visible for diagnosis");
assert.equal(stale.capPolicy.activeFresh, false);
for (const gate of ["currentPaperMode", "currentLiveMode", "executionReadinessReady",
  "walletReported", "walletFunded"]) {
  assert.equal(stale.activation[gate], false,
    `stale telemetry cannot complete the ${gate} activation gate`);
}

const privateSettings = {
  webhook_url: "https://hooks.example/private",
  executor_url: "https://executor.example/private",
  executor_secret: "feed-secret",
  executor_heartbeat: JSON.stringify({ wallet, held: [{ mint }] }),
  appetite: "aggressive",
};
const guestSettings = floorFeedSettingsForViewer(privateSettings);
assert.equal(guestSettings.webhook_url, "(set)");
assert.equal(guestSettings.executor_url, "(set)");
assert.equal(guestSettings.executor_secret, null);
assert.equal(guestSettings.executor_heartbeat, null,
  "a guest call-sheet response cannot bypass the owner-only executor status route");
assert.equal(guestSettings.appetite, "aggressive");
assert.deepEqual(floorFeedSettingsForViewer(privateSettings, { isOwner: true }), privateSettings,
  "the authenticated owner retains their private setup fields");

const secret = settingsFor(HQ_FLOOR).executor_secret;
db.prepare("UPDATE copy_settings SET appetite='aggressive', bankroll_sol=2, executor_heartbeat=? WHERE floor_no=?")
  .run(JSON.stringify({
    mode: "live", wallet, cursor: 42, open: 1, held: [{ mint, sol: 0.005 }],
    health: { state: "healthy", executionReadiness: {
      ready: true, lastSuccessAt: now - 1_000, observedAt: now - 2_000,
      route: "wsol-usdc", providers: 2, amountLamports: 5_000_000,
    }, caps: { maxSolPerTrade: 0.005, dailySolCap: 0.01,
      dailyLossLimitSol: 0.01, maxOpenPositions: 4 } },
    ts: now - 3_000, seenAt: now - 2_000,
  }), HQ_FLOOR);
let balanceReads = 0;
const payload = await executorStatusPayload(HQ_FLOOR, {
  nowMs: now,
  balanceReader: async (address) => {
    balanceReads++;
    assert.equal(address, wallet);
    return { ok: true, lamports: 20_000_000, sol: 0.02 };
  },
});
assert.equal(balanceReads, 1);
assert.equal(payload.wallet.balanceSol, 0.02);
assert.equal(payload.activation.currentLiveMode, true);
assert.ok(!JSON.stringify(payload).includes(secret));

const source = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const routeStart = source.indexOf("const executorStatusMatch");
const routeEnd = source.indexOf("RETIRED BROWSER RPC LANE");
const route = source.slice(routeStart, routeEnd);
assert.ok(routeStart > 0 && routeEnd > routeStart);
assert.match(route, /req\.method !== "GET"/);
assert.match(route, /!holdsFloor\(floorNo\)/);
assert.match(route, /executorStatusPayload\(floorNo\)/);
assert.doesNotMatch(route, /readBody|signTransaction|sendTransaction|executor_secret/);

const pollerSource = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
for (const [key, value] of Object.entries({
  maxSolPerTrade: 0.005,
  dailySolCap: 0.01,
  dailyLossLimitSol: 0.01,
  maxOpenPositions: 4,
})) {
  assert.match(pollerSource, new RegExp(`${key}:\\s*${String(value).replace(".", "\\.")}`),
    `dashboard canary default ${key} must stay pinned to the executor's default`);
}
for (const [key, value] of Object.entries({
  maxSolPerTrade: 0.05,
  dailySolCap: 0.5,
  dailyLossLimitSol: 0.15,
})) {
  assert.match(pollerSource, new RegExp(`OPERATOR_MAX[\\s\\S]*${key}:\\s*${String(value).replace(".", "\\.")}`),
    `dashboard operator maximum ${key} must stay pinned to the executor policy`);
}
assert.match(pollerSource, /I acknowledge WALL-ST-E caps v2/);
assert.doesNotMatch(pollerSource, /I raise the live caps for/);

console.log("\nWALL-ST-E dashboard is owner-only, read-only, and secret-safe\n");
