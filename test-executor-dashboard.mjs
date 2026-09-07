import assert from "node:assert/strict";
import fs from "node:fs";

if (!process.env.CLAUDE_CO_DB)
  throw new Error("test runner must provide CLAUDE_CO_DB");

const db = (await import("./src/lib/store.js")).default;
const { buildExecutorDashboard, EXECUTOR_CANARY_DEFAULTS, EXECUTOR_OPERATOR_MAXIMA,
  EXECUTOR_HEARTBEAT_STALE_MS, EXECUTOR_READINESS_STALE_MS } =
  await import("./src/executor-dashboard.js");
const { executorStatusPayload, floorFeedSettingsForViewer } = await import("./src/office.js");
const { settingsFor } = await import("./src/copy.js");
const { HQ_FLOOR } = await import("./src/tower.js");

const now = 1_800_000_000_000;
const wallet = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";
const mint = "So11111111111111111111111111111111111111112";

/* FIXTURES ARE DERIVED FROM THE DASHBOARD'S OWN CONSTANTS, NOT TYPED IN.
 *
 * The per-trade operator ceiling went 0.05 -> 0.1 -> 0.05 inside a week (the published
 * installer at claudedotcompany.com still serves 0.05, and executor/test-install.mjs
 * compares against it), and every hand-copied instance of that number in this file went
 * stale on each move — while the properties under test, "a rehearsal must cover the
 * ACTIVE cap" and "a wallet must clear the displayed reserve", never changed at all.
 * So the caps, rehearsal sizes and balances below are all built from the exported
 * policy. A heartbeat speaks the poller's field names and the dashboard exposes its
 * own, hence the translation. */
const LAMPORTS = 1_000_000_000;
const capsFor = (policy) => ({
  maxSolPerTrade: policy.maxSolPerTrade,
  dailySolCap: policy.rolling24hDeploySol,
  dailyLossLimitSol: policy.rolling24hRealizedLossBrakeSol,
  maxOpenPositions: policy.maxOpenPositions,
});
const CANARY_CAPS = capsFor(EXECUTOR_CANARY_DEFAULTS);
const OPERATOR_CAPS = capsFor(EXECUTOR_OPERATOR_MAXIMA);
const CANARY_LAMPORTS = Math.floor(CANARY_CAPS.maxSolPerTrade * LAMPORTS);

/* RE-ANCHORED 2026-09-07, when the per-trade operator maximum went 0.05 -> 0.4 SOL and
 * the daily deployment cap was effectively removed (0.5 -> 1000).
 *
 * The "raised executor" fixture below used to arm at the operator ceiling itself. It
 * cannot any more, and not because the property changed: buildExecutorDashboard only
 * compares a rehearsal against the active cap AFTER publicReadiness() has put the
 * reported size through a plausibility ceiling, and that ceiling did not move with the
 * caps. A 0.4 SOL rehearsal is sanitised to 0, which would quietly turn every
 * raised-executor case into a second copy of the mismatch case.
 *
 * So the fixture arms at the largest cap the dashboard can still match a rehearsal
 * against: the operator ceiling where it fits, the sanitiser's ceiling otherwise. Both
 * halves are read out of the shipped source rather than typed in, so whichever of the
 * two moves next, this follows it. (That the two now disagree is a finding about
 * src/executor-dashboard.js, not about this test — an executor armed at the real 0.4
 * ceiling can never display ready. Raising the sanitiser is a src change, so it is not
 * made here; the ruler assertions below fail loudly the day it happens.) */
const dashboardSource = fs.readFileSync(
  new URL("./src/executor-dashboard.js", import.meta.url), "utf8");
/* THE SANITISER IS DERIVED NOW, AND THIS ASSERTS THAT IT STAYS DERIVED.
   It was the literal 50_000_000 while the four declared ceilings moved to 0.4 SOL, so an
   executor armed at the real ceiling rehearsed at 400,000,000, was zeroed, and could
   never display ready — the src change this comment used to say was "not made here" has
   been made. The ruler used to regex the literal out of the source; a literal is exactly
   the shape that drifted, so the source is now checked for the DERIVATION instead, and
   the ceiling is computed the same way the dashboard computes it. */
assert.match(dashboardSource,
  /amountLamports\s*<=\s*Math\.floor\(EXECUTOR_OPERATOR_MAXIMA\.maxSolPerTrade\s*\*\s*1_000_000_000\)/,
  "the rehearsal-size sanitiser must derive its ceiling from EXECUTOR_OPERATOR_MAXIMA, not a literal — a literal is how it drifted to 0.05 while the ceiling was 0.4");
const REHEARSAL_LAMPORT_CEILING = Math.floor(EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade * LAMPORTS);
assert.ok(Number.isSafeInteger(REHEARSAL_LAMPORT_CEILING) && REHEARSAL_LAMPORT_CEILING > 0,
  `the dashboard's rehearsal-size sanitiser ceiling must be a positive lamport count, got ${REHEARSAL_LAMPORT_CEILING}`);
const RAISED_CAPS = { ...OPERATOR_CAPS, maxSolPerTrade:
  Math.min(OPERATOR_CAPS.maxSolPerTrade, REHEARSAL_LAMPORT_CEILING / LAMPORTS) };
const RAISED_LAMPORTS = Math.floor(RAISED_CAPS.maxSolPerTrade * LAMPORTS);
// Validate the ruler before trusting it: every wrong-size-rehearsal case below proves
// nothing whatsoever if the canary and the raised cap are the same size, and the raised
// cases prove nothing about a RAISE unless the fixture really does sit above the canary
// default and inside the operator maximum the dashboard enforces.
assert.notEqual(CANARY_LAMPORTS, RAISED_LAMPORTS,
  `the canary and raised-cap rehearsals must differ in size, both were ${RAISED_LAMPORTS}`);
assert.ok(RAISED_CAPS.maxSolPerTrade > CANARY_CAPS.maxSolPerTrade,
  `the raised fixture must sit above the canary default ${CANARY_CAPS.maxSolPerTrade}, is ${RAISED_CAPS.maxSolPerTrade}`);
assert.ok(RAISED_CAPS.maxSolPerTrade <= OPERATOR_CAPS.maxSolPerTrade,
  `the raised fixture must stay within the operator maximum ${OPERATOR_CAPS.maxSolPerTrade}, is ${RAISED_CAPS.maxSolPerTrade}`);
// The dashboard's displayed readiness reserve: active trade + network-fee ceiling +
// two-ATA rent ceiling + the untouched SOL reserve, summed in that order.
const reserveSol = (caps) => caps.maxSolPerTrade + 0.0005 + 0.0042 + 0.01;
const solBalance = (sol) => ({ ok: true, lamports: Math.round(sol * LAMPORTS), sol });
const aboveReserve = (caps) => solBalance(reserveSol(caps) + 0.001);
const belowReserve = (caps) => solBalance(reserveSol(caps) - 0.001);

const dashboard = buildExecutorDashboard({
  floorNo: 50,
  nowMs: now,
  heartbeat: {
    mode: "live", wallet, cursor: 12, open: 1,
    held: [{ mint, sol: 0.005 }, { mint: "not-an-address", sol: 999 }],
    health: { state: "entries-paused", entriesPaused: true, secret: "nested-must-not-cross",
      executionReadiness: { ready: true, providers: 2,
        lastSuccessAt: now - 20_000, observedAt: now - 20_000,
        route: "wsol-usdc", amountLamports: CANARY_LAMPORTS },
      caps: { ...CANARY_CAPS } },
    ts: now - 40_000, seenAt: now - 30_000,
    secret: "must-not-cross",
  },
  balanceResult: { ...aboveReserve(CANARY_CAPS), observedAt: now },
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
assert.equal(dashboard.capPolicy.active.maxSolPerTrade, EXECUTOR_CANARY_DEFAULTS.maxSolPerTrade);
assert.ok(!JSON.stringify(dashboard).includes("must-not-cross"));

const raisedPulse = {
  mode: "live", wallet, seenAt: now - 1_000,
  // An executor armed well above the canary default — at the largest per-trade cap the
  // dashboard is still able to match a rehearsal against (see RAISED_CAPS above).
  health: {
    state: "entries-paused", entriesPaused: true,
    caps: { ...RAISED_CAPS },
    executionReadiness: { ready: true, providers: 2, route: "wsol-usdc",
      // ...still carrying the SMALLER default-size rehearsal.
      lastSuccessAt: now - 1_000, observedAt: now - 1_000, amountLamports: CANARY_LAMPORTS },
  },
};
const raisedBalance = { ...aboveReserve(RAISED_CAPS), observedAt: now };
const raisedMismatch = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: raisedPulse,
  balanceResult: raisedBalance });
assert.equal(raisedMismatch.activation.executionReadinessReady, false,
  "a raised executor cannot inherit readiness from the smaller default rehearsal");
assert.equal(raisedMismatch.telemetry.heartbeat.health.state, "degraded",
  "a wrong-size live rehearsal cannot display entries-paused/healthy status");
const raisedReady = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { ...raisedPulse, health: { ...raisedPulse.health,
    executionReadiness: { ...raisedPulse.health.executionReadiness,
      amountLamports: RAISED_LAMPORTS } } },
  balanceResult: raisedBalance });
// The dashboard sanitises an implausible rehearsal size to 0, which would turn this
// whole case into a second copy of the mismatch case above without saying so. Prove the
// raised-cap-size rehearsal survived the sanitiser before reading its readiness verdict.
assert.equal(raisedReady.telemetry.heartbeat.health.executionReadiness.amountLamports,
  RAISED_LAMPORTS, "the raised-cap-size rehearsal must survive the dashboard's sanitiser");
assert.equal(raisedReady.activation.executionReadinessReady, true);
assert.equal(raisedReady.activation.walletFunded, true);
// Was the literal 0.0647 — that sum with a 0.05 per-trade cap. Only the three reserve
// components stay written out now, so a moved ceiling recalibrates this expectation
// instead of breaking a claim that is still true.
assert.ok(Math.abs(raisedReady.wallet.requiredForReadinessSol -
  reserveSol(RAISED_CAPS)) < 1e-12,
  `the displayed reserve must track the active cap, got ${raisedReady.wallet.requiredForReadinessSol} want ${reserveSol(RAISED_CAPS)}`);

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
    // Just under the dashboard's 0.000001 SOL dust floor for an active cap.
    health: { state: "healthy",
      caps: { ...CANARY_CAPS, maxSolPerTrade: 0.0000009 } } } });
assert.equal(capsBelowMinimum.capPolicy.active, null);
assert.equal(capsBelowMinimum.telemetry.heartbeat.health.state, "degraded");
const readinessMissing = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { ...CANARY_CAPS } } } });
assert.equal(readinessMissing.telemetry.heartbeat.health.state, "degraded",
  "a live heartbeat without readiness evidence cannot display healthy status");
const readinessStale = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { ...CANARY_CAPS },
    executionReadiness: { ready: true, providers: 2, route: "wsol-usdc",
      // One millisecond past the dashboard's own readiness-staleness horizon.
      lastSuccessAt: now - (EXECUTOR_READINESS_STALE_MS + 1),
      observedAt: now - (EXECUTOR_READINESS_STALE_MS + 1),
      amountLamports: CANARY_LAMPORTS } } } });
assert.equal(readinessStale.telemetry.heartbeat.health.state, "degraded",
  "stale live readiness cannot display healthy status");
const manualWithoutReadiness = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "manual-action", caps: { ...CANARY_CAPS } } } });
assert.equal(manualWithoutReadiness.telemetry.heartbeat.health.state, "manual-action",
  "missing readiness must not hide a higher-severity operator action state");

const stale = buildExecutorDashboard({
  floorNo: 50, nowMs: now,
  // A second past the dashboard's own heartbeat-staleness horizon.
  heartbeat: { mode: "paper", wallet, seenAt: now - (EXECUTOR_HEARTBEAT_STALE_MS + 1_000),
    health: { executionReadiness: { ready: true, providers: 2,
      lastSuccessAt: now - 20_000, observedAt: now - 20_000,
      route: "wsol-usdc", amountLamports: RAISED_LAMPORTS },
      // A rehearsal that MATCHES these caps, so staleness alone is what closes the
      // gates below. An over-ceiling size would be sanitised to 0 and the gates would
      // read false for the wrong reason.
      caps: { ...RAISED_CAPS } } },
  balanceResult: belowReserve(RAISED_CAPS),
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
      route: "wsol-usdc", providers: 2, amountLamports: CANARY_LAMPORTS,
    }, caps: { ...CANARY_CAPS } },
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
/* The expected numbers come from the dashboard's exported policy rather than being
 * typed out a second time: what this pins is that the two files AGREE, and a literal
 * here only re-states one side of that while going stale on every recalibration. The
 * trailing (?![0-9]) matters — without it `0.05` also matches a poller that says
 * 0.055. executor/test-operator-max-parity.mjs covers the other two copies of the
 * ceiling (launchd-runner.mjs and install.sh, which the published installer serves). */
const numberRe = (value) => `${String(value).replaceAll(".", "\\.")}(?![0-9])`;
for (const [key, value] of Object.entries({
  maxSolPerTrade: EXECUTOR_CANARY_DEFAULTS.maxSolPerTrade,
  dailySolCap: EXECUTOR_CANARY_DEFAULTS.rolling24hDeploySol,
  dailyLossLimitSol: EXECUTOR_CANARY_DEFAULTS.rolling24hRealizedLossBrakeSol,
  // A sentinel now, not a policy: risk decides how many memecoins run at once. The
  // executor's own default is deliberately NOT the dashboard's displayed 4, so this
  // single number is written out instead of derived.
  maxOpenPositions: 24,
})) {
  assert.match(pollerSource, new RegExp(`${key}:\\s*${numberRe(value)}`),
    `dashboard canary default ${key} must stay pinned to the executor's default`);
}
const operatorMaxDecl = /const OPERATOR_MAX = Object\.freeze\(\{[^}]*\}\)/.exec(pollerSource)?.[0];
assert.ok(operatorMaxDecl,
  "executor/poller.mjs must still declare OPERATOR_MAX as one frozen literal");
for (const [key, value] of Object.entries({
  maxSolPerTrade: EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade,
  dailySolCap: EXECUTOR_OPERATOR_MAXIMA.rolling24hDeploySol,
  dailyLossLimitSol: EXECUTOR_OPERATOR_MAXIMA.rolling24hRealizedLossBrakeSol,
})) {
  assert.match(operatorMaxDecl, new RegExp(`${key}:\\s*${numberRe(value)}`),
    `dashboard operator maximum ${key} must stay pinned to the executor policy`);
}
assert.match(pollerSource, /I acknowledge WALL-ST-E caps v2/);
assert.doesNotMatch(pollerSource, /I raise the live caps for/);

console.log("\nWALL-ST-E dashboard is owner-only, read-only, and secret-safe\n");
