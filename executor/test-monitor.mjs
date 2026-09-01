import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyProcessTopology, inspectExecutor, readExecutorEnv } from "./monitor.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const RUNTIME_FINGERPRINT = "b".repeat(32);
const WALLET = "PublicWallet111111111111111111111111111111";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wallste-monitor-"));
const makeDb = (file, { cursor = 12, positions = [], intents = [] } = {}) => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    CREATE TABLE positions(mint TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE intents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
  `);
  const meta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
  meta.run("cursor", JSON.stringify(cursor)); meta.run("primed", "true");
  meta.run("wallet", JSON.stringify(WALLET));
  meta.run("risk_state", JSON.stringify({ deployedTodaySol: 0, realizedTodaySol: 0, wins: 0, losses: 0 }));
  for (const row of positions) db.prepare("INSERT INTO positions VALUES(?,?,?)")
    .run(row.mint, JSON.stringify(row.data), row.updatedAt);
  for (const row of intents) db.prepare("INSERT INTO intents VALUES(?,?,?,?,?)")
    .run(row.id, row.kind, row.mint, row.state, row.updatedAt);
  db.close(); fs.chmodSync(file, 0o600);
};
const writeConfig = (dir) => {
  const file = path.join(dir, ".cc-executor.env");
  fs.writeFileSync(file, [
    "CC_API='https://example.invalid'", "CC_FLOOR=50", "CC_SECRET=TOP_SECRET_NEVER_PRINT",
    "EXECUTE=1", `STATE_DB=${path.join(dir, ".cc-executor.sqlite")}`,
    "SOLANA_RPC=https://primary.invalid/key/PRIMARY_SECRET",
    "SOLANA_RPC_SECONDARY=https://secondary.invalid/key/SECONDARY_SECRET",
    `EXECUTOR_SOURCE_COMMIT=${SOURCE_COMMIT}`,
  ].join("\n"), { mode: 0o600 });
  return file;
};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const processProbe = async () => ({ alive: true, commandMatches: true,
  cwdMatches: true, identityVerified: true, supervisor: "launchd" });
const runtimeFingerprintFn = () => RUNTIME_FINGERPRINT;
const oracleProbe = async () => ({ source: "pyth-sol-usd-shard0-v1", price: 102,
  publishTime: 999, confidencePct: 0.01, divergencePct: 0.1 });
const inspect = (options = {}) => inspectExecutor({ requireSleepAssertion: false, ...options });
const heartbeat = (now, extra = {}) => ({
  mode: "live", wallet: WALLET, cursor: 12, open: 0, seenAt: now - 1_000,
  health: {
    state: "healthy", lastTickCompletedAt: now - 1_000, lastFeedSuccessAt: now - 1_000,
    consecutiveFeedFailures: 0, consecutiveTickFailures: 0,
    runtimeCommit: SOURCE_COMMIT, runtimeFingerprint: RUNTIME_FINGERPRINT,
    feedRollback: false,
    executionReadiness: {
      ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "wsol-usdc", providers: 2,
    },
  },
  ...extra,
});

{
  const dir = "/private/tmp/Claude Company/executor";
  const runnerCommand = `/usr/local/bin/node ${dir}/launchd-runner.mjs run ` +
    `--env ${dir}/.cc-executor.env --poller ${dir}/poller.mjs ` +
    "--label com.claudeco.wallste";
  const manualRunner = classifyProcessTopology({ pid: 41, command: runnerCommand,
    cwd: dir, executorDir: dir, registeredLaunchdPid: null });
  const supervisedRunner = classifyProcessTopology({ pid: 41, command: runnerCommand,
    cwd: dir, executorDir: dir, registeredLaunchdPid: 41 });
  assert.equal(manualRunner.supervisor, "manual",
    "matching runner arguments alone cannot claim LaunchAgent supervision");
  assert.equal(supervisedRunner.supervisor, "launchd",
    "the exact registered LaunchAgent pid can prove supervision");
}

{
  const dir = tmp();
  const envFile = writeConfig(dir);
  assert.equal(readExecutorEnv(envFile).CC_SECRET, "TOP_SECRET_NEVER_PRINT");
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  const seen = [];
  const report = await inspect({
    executorDir: dir, environment: { CC_SECRET: "AMBIENT_WRONG", EXECUTE: "0" }, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer TOP_SECRET_NEVER_PRINT");
      seen.push(url);
      if (url.endsWith("/heartbeat")) return response({ heartbeat: heartbeat(1_000_000) });
      return response({ cluster: "mainnet-beta", latest_id: 12, events: [] });
    },
  });
  assert.equal(report.status, "healthy");
  assert.equal(report.mode, "live", "the protected service file overrides ambient shell configuration");
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.unpauseReadiness, "not-paused");
  assert.equal(report.feed.cursorLag, 0);
  assert.equal(seen.length, 2);
  assert.ok(!JSON.stringify(report).includes("TOP_SECRET_NEVER_PRINT"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe: async () => ({ alive: true, commandMatches: true,
      cwdMatches: false, identityVerified: false, supervisor: "launchd" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { cursor: 11, open: 1, health: {
          ...heartbeat(1_000_000).health, runtimeFingerprint: "c".repeat(32),
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.unpauseReadiness, "blocked");
  for (const code of ["process_identity_unverified", "heartbeat_runtime_mismatch",
    "heartbeat_cursor_mismatch", "heartbeat_open_mismatch"])
    assert.ok(report.issues.some((item) => item.code === code), `missing ${code}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe, requireSleepAssertion: true,
    sleepAssertionProbe: async () => ({ ok: true, assertionPid: 12345, acPower: true,
      idleSystemSleep: true, systemSleep: true }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "entries-paused");
  assert.equal(report.safeToUnpause, true,
    "a deliberate pause can be certified without reporting the trader as actively healthy");
  assert.equal(report.unpauseReadiness, "ready");
  assert.equal(report.process.supervisor, "launchd");
  assert.equal(report.sleepAssertion.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe: async () => ({ alive: true, commandMatches: true, cwdMatches: true,
      identityVerified: true, supervisor: "manual" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.process.supervisor, "manual");
  assert.ok(report.issues.some((item) => item.code === "supervisor_unverified"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe, requireSleepAssertion: true,
    sleepAssertionProbe: async () => ({ ok: false, reason: "caffeinate exited" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.sleepAssertion.ok, false);
  assert.ok(report.issues.some((item) => item.code === "sleep_assertion_missing"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 11, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.feed.ok, false);
  assert.equal(report.feed.cursorLag, -1);
  assert.ok(report.issues.some((item) => item.code === "feed_cursor_regression"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const now = 1_000_000;
  const cases = [
    [null, "execution_readiness_missing"],
    [{ ready: false, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "wsol-usdc", providers: 2 }, "execution_readiness_failed"],
    [{ ready: true, lastSuccessAt: now - 300_001, observedAt: now - 300_001,
      route: "wsol-usdc", providers: 2 }, "execution_readiness_stale"],
    [{ ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "unsafe-route", providers: 1 }, "execution_readiness_invalid"],
  ];
  for (const [executionReadiness, expectedCode] of cases) {
    const report = await inspect({
      executorDir: dir, environment: {}, now, processProbe, runtimeFingerprintFn, oracleProbe,
      fetchFn: async (url) => url.endsWith("/heartbeat")
        ? response({ heartbeat: heartbeat(now, { health: {
            ...heartbeat(now).health, state: "entries-paused", entriesPaused: true,
            executionReadiness,
          } }) })
        : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
    });
    assert.equal(report.safeToUnpause, false);
    assert.ok(report.issues.some((item) => item.code === expectedCode), `missing ${expectedCode}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const now = 1_000_000;
  const report = await inspect({
    executorDir: dir, environment: {}, now, processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(now, { health: {
          ...heartbeat(now).health, state: "entries-paused", entriesPaused: true,
          feedRollback: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.feed.cursorLag, 0);
  assert.equal(report.safeToUnpause, false);
  assert.ok(report.issues.some((item) => item.code === "executor_feed_rollback"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  const now = 2_000_000;
  makeDb(path.join(dir, ".cc-executor.sqlite"), {
    positions: [{ mint: "MintThatMustExit111111111111", updatedAt: now - 1_000,
      data: { manualExitRequired: true, manualExitReason: "synthetic impact breach" } }],
    intents: [{ id: "entry:50:danger", kind: "entry", mint: "DangerMint111111111111",
      state: "ambiguous", updatedAt: now - 600_000 }],
  });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), "99999999\n", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now,
    processProbe: async () => ({ alive: false, commandMatches: false, supervisor: null }),
    runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: { mode: "live", cursor: 12, open: 1, seenAt: now - 600_000 } })
      : response({ cluster: "mainnet-beta", latest_id: 14,
          events: [{ id: 13, ts: now - 120_000 }, { id: 14, ts: now - 110_000 }] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  for (const code of ["process_dead", "position_exit_blocked", "intent_ambiguous", "feed_cursor_lag", "heartbeat_stale"])
    assert.ok(report.issues.some((item) => item.code === code), `missing ${code}`);
  assert.ok(!JSON.stringify(report).includes("TOP_SECRET_NEVER_PRINT"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe, runtimeFingerprintFn,
    oracleProbe: async () => { throw new Error("https://primary.invalid/key/MUST_NOT_PRINT"); },
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  assert.ok(report.issues.some((item) => item.code === "sol_usd_oracle_unavailable"));
  assert.ok(!JSON.stringify(report).includes("MUST_NOT_PRINT"));
  assert.ok(!JSON.stringify(report).includes("PRIMARY_SECRET"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const file = path.join(dir, ".cc-executor.env");
  fs.writeFileSync(file,
    'CC_SECRET="back\\\\slash\\"quote\\$dollar\\`tick"\nCC_FLOOR="50"\n', { mode: 0o600 });
  const parsed = readExecutorEnv(file);
  assert.equal(parsed.CC_SECRET, 'back\\slash"quote$dollar`tick');
  assert.equal(parsed.CC_FLOOR, "50");
  fs.writeFileSync(file, 'CC_SECRET="unterminated\n', { mode: 0o600 });
  assert.throws(() => readExecutorEnv(file), /unterminated quoted value/);
  fs.writeFileSync(file, 'CC_SECRET="readable-by-group"\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readExecutorEnv(file), /accessible by group or other/);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n11 monitor scenarios passed\n");
