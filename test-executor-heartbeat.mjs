
/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE. scripts/test-all.mjs points
   CLAUDE_CO_DB at a throwaway file, but running this file on its own falls back to
   ./claude-co.db (src/lib/store.js) — and the resets in these tests DELETE FROM calls,
   deliveries and call_events. On 2026-09-07 that emptied three tables of the local dev
   database, which is gitignored and had no backup. The runner's value still wins; this
   only covers the unguarded direct run. */
import os from "node:os";
import path from "node:path";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-executor-heartbeat-" + process.pid + ".db");
import assert from "node:assert/strict";
import fs from "node:fs";
import db from "./src/lib/store.js";
import { executorHeartbeatPayload, sanitizeExecutorHealth, sanitizeExecutorLedger, sanitizeExecutorReporting,
  sanitizeExecutorHeld, sanitizeExecutorClosed } from "./src/office.js";
import { settingsFor } from "./src/copy.js";
import { HQ_FLOOR } from "./src/tower.js";

const secret = settingsFor(HQ_FLOOR).executor_secret;
const pulse = { mode: "live", wallet: "PublicWalletOnly", cursor: 42, open: 1,
  held: [{ mint: "MintPublic", sol: 0.005 }], ts: Date.now(), seenAt: Date.now() };
db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
  .run(JSON.stringify(pulse), HQ_FLOOR);

const payload = executorHeartbeatPayload(HQ_FLOOR);
assert.deepEqual(payload, { heartbeat: pulse });
assert.ok(!JSON.stringify(payload).includes(secret));
assert.deepEqual(executorHeartbeatPayload(49), { heartbeat: null });
const health = sanitizeExecutorHealth({ state: "manual-action", hardStop: true,
  blockedPositions: 4.9, consecutiveFeedFailures: 2, runtimeCommit: "A".repeat(40),
  runtimeFingerprint: "B".repeat(32),
  secret: "must-not-cross" });
assert.equal(health.state, "manual-action");
assert.equal(health.blockedPositions, 4);
assert.equal(health.runtimeCommit, "a".repeat(40));
assert.equal(health.runtimeFingerprint, "b".repeat(32));
assert.ok(!JSON.stringify(health).includes("must-not-cross"));

const now = Date.now();
const ready = sanitizeExecutorHealth({ state: "entries-paused", feedRollback: false,
  executionReadiness: { ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
    route: "wsol-usdc", providers: 2, amountLamports: 50_000_000,
    secret: "readiness-secret-must-not-cross" },
  caps: { maxSolPerTrade: 0.05, dailySolCap: 0.5,
    dailyLossLimitSol: 0.15, maxOpenPositions: 4, secret: "cap-secret-must-not-cross" } });
assert.equal(ready.state, "entries-paused");
assert.equal(ready.feedRollback, false);
assert.deepEqual(ready.executionReadiness, {
  ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
  route: "wsol-usdc", providers: 2, amountLamports: 50_000_000, lastError: null,
});
assert.deepEqual(ready.caps, {
  maxSolPerTrade: 0.05, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4,
});
assert.ok(!JSON.stringify(ready).includes("readiness-secret-must-not-cross"));
assert.ok(!JSON.stringify(ready).includes("cap-secret-must-not-cross"));

const rollback = sanitizeExecutorHealth({ state: "healthy", feedRollback: true,
  executionReadiness: ready.executionReadiness });
assert.equal(rollback.feedRollback, true);
assert.equal(rollback.state, "degraded", "a feed rollback cannot persist as healthy");

const failedReadiness = sanitizeExecutorHealth({ state: "healthy", feedRollback: false,
  executionReadiness: { ...ready.executionReadiness, ready: false } });
assert.equal(failedReadiness.executionReadiness.ready, false);
assert.equal(failedReadiness.state, "degraded",
  "a failed execution probe cannot persist as healthy");

const malformed = sanitizeExecutorHealth({ state: "healthy", feedRollback: "false",
  executionReadiness: { ready: true, lastSuccessAt: String(now), observedAt: now,
    route: { secret: "nested-route-secret" }, providers: "2",
    amountLamports: "5000000", endpoint: "https://rpc.invalid/private" },
  caps: { maxSolPerTrade: "0.005", dailySolCap: 0.01,
    dailyLossLimitSol: 0.01, maxOpenPositions: 4 } });
assert.equal(malformed.feedRollback, false, "only a literal boolean is retained");
assert.deepEqual(malformed.executionReadiness, {
  ready: false, lastSuccessAt: 0, observedAt: now, route: null, providers: 0,
  amountLamports: 0, lastError: null,
});

/* THE REASON IS SANITISED LIKE EVERYTHING ELSE ON THIS SURFACE. It exists so an
   operator with both RPCs green can see why the rehearsal did not pass instead of a
   bare "0 / 2" — but it arrives from a tenant machine, so it is a bounded string or it
   is nothing, and control bytes never survive it. */
const reasoned = sanitizeExecutorHealth({ state: "degraded",
  executionReadiness: { ready: false, lastSuccessAt: 0, observedAt: now,
    route: "wsol-usdc", providers: 0, amountLamports: 5_000_000,
    lastError: "execution-readiness wallet reserve is insufficient\u0000 on one or both RPC providers" } });
assert.match(reasoned.executionReadiness.lastError, /wallet reserve is insufficient/);
assert.ok(!/\u0000/.test(reasoned.executionReadiness.lastError), "control bytes are stripped");
assert.equal(sanitizeExecutorHealth({ executionReadiness: { ready: false,
  lastError: { nested: "readiness-secret-must-not-cross" } } }).executionReadiness.lastError, null);
assert.equal(sanitizeExecutorHealth({ executionReadiness: { ready: false,
  lastError: "y".repeat(900) } }).executionReadiness.lastError.length, 300);
assert.equal(malformed.caps, null);
assert.equal(malformed.state, "degraded",
  "malformed rollback/readiness evidence fails status closed");
assert.ok(!JSON.stringify(malformed).includes("nested-route-secret"));
assert.ok(!JSON.stringify(malformed).includes("rpc.invalid"));

const subminimumCaps = sanitizeExecutorHealth({ state: "healthy", caps: {
  maxSolPerTrade: 0.0000009, dailySolCap: 0.01,
  dailyLossLimitSol: 0.01, maxOpenPositions: 4,
} });
assert.equal(subminimumCaps.caps, null);
assert.equal(subminimumCaps.state, "degraded",
  "cap telemetry below the runtime minimum cannot persist as healthy");

const nonObjectReadiness = sanitizeExecutorHealth({ state: "healthy",
  executionReadiness: "secret-bearing-invalid-readiness" });
assert.equal(nonObjectReadiness.executionReadiness, null);
assert.equal(nonObjectReadiness.state, "degraded");
assert.ok(!JSON.stringify(nonObjectReadiness).includes("secret-bearing"));

/* THE BOT'S OWN LEDGER RIDES THE HEARTBEAT. The board's P&L tile read the desk's paper
   record — a chain scan of the floor OWNER's wallet, never the burner — so it never saw
   a bot trade. The journal's totals come up in the pulse now, bounded, and anything
   that is not a finite SOL figure, a count or a timestamp is dropped. */
const ledger = sanitizeExecutorLedger({ realizedSol: -0.0123456789, deployedSol: 1.5, feesSol: 0.002,
  deployments: 4.7, exits: 2, firstAt: 1_700_000_000_000, lastAt: 1_700_000_500_000,
  realized24hSol: 0.01, deployed24hSol: 0.4, openSol: 0.4, asOf: 1_700_000_600_000,
  secret: "ledger-secret-must-not-cross" });
assert.equal(ledger.realizedSol, -0.012345679, "realized is rounded to lamports, not truncated");
assert.equal(ledger.deployedSol, 1.5);
assert.equal(ledger.deployments, 4);
assert.equal(ledger.exits, 2);
assert.equal(ledger.openSol, 0.4);
assert.ok(!JSON.stringify(ledger).includes("ledger-secret"));
assert.equal(sanitizeExecutorLedger({ realizedSol: "NaN", deployedSol: 1 }), null, "a ledger without a finite realized figure is no ledger");
assert.equal(sanitizeExecutorLedger({ realizedSol: 1e9, deployedSol: 1 }), null, "an absurd figure is refused, not displayed");
assert.equal(sanitizeExecutorLedger("string"), null);
const reporting = sanitizeExecutorReporting({ fillsOwed: 3, lastError: "fill HTTP 404" + "x".repeat(400), lastErrorAt: 1_700_000_000_000, lastReportedAt: null });
assert.equal(reporting.fillsOwed, 3);
assert.equal(reporting.lastError.length, 200, "the bot's error text is capped");
assert.equal(reporting.lastReportedAt, null);
assert.deepEqual(sanitizeExecutorReporting({}), { fillsOwed: 0, lastReportedAt: null, lastError: null, lastErrorAt: null });

/* THE BOOK ITSELF: every open position with its levels, every recent close with its
   result. Bounded, and a row without a mint or a close without a result is dropped. */
const held = sanitizeExecutorHeld([{ mint: "MintPublic", sol: 0.248, openedAt: 1_789_251_886_063, symbol: "EMBER", callId: 60,
  costSol: 0.2485, stop: 0.8012, target: 1.4719, high: 1, holdMaxMs: 86_400_000,
  deskEntryRef: 0.02405, deskStop: 0.01927, deskTarget: 0.0354, secret: "held-secret" },
  { mint: "", sol: 1 }, { mint: "NoLevels", sol: -5, stop: "x", target: 0 }]);
assert.equal(held.length, 2, "a row without a mint is dropped, a row without levels is kept");
assert.deepEqual(held[0], { mint: "MintPublic", sol: 0.248, openedAt: 1_789_251_886_063, symbol: "EMBER", callId: 60,
  costSol: 0.2485, stop: 0.8012, target: 1.4719, high: 1, holdMaxMs: 86_400_000,
  deskEntryRef: 0.02405, deskStop: 0.01927, deskTarget: 0.0354 });
assert.deepEqual(held[1], { mint: "NoLevels", sol: 0, openedAt: 0, symbol: null, callId: null, costSol: null,
  stop: null, target: null, high: null, holdMaxMs: null, deskEntryRef: null, deskStop: null, deskTarget: null });
assert.ok(!JSON.stringify(held).includes("held-secret"));
const closed = sanitizeExecutorClosed([
  { mint: "SoldMint", symbol: "LOTTO", callId: 997, closedAt: 1_789_255_648_000, openedAt: 1_789_251_886_063,
    solIn: 0.1547, solOut: 0.1312, realizedSol: -0.0235, fraction: 1, reason: "mirror: desk stop", kind: "mirror_exit", reported: true },
  { mint: "NoResult", closedAt: 1, solIn: 1, solOut: 1 },
  { mint: "NoTime", realizedSol: 0.1 },
]);
assert.equal(closed.length, 1, "a close without a result or a time is not a close");
assert.deepEqual(closed[0], { mint: "SoldMint", symbol: "LOTTO", callId: 997, closedAt: 1_789_255_648_000, openedAt: 1_789_251_886_063,
  solIn: 0.1547, solOut: 0.1312, realizedSol: -0.0235, fraction: 1, reason: "mirror: desk stop", kind: "mirror_exit", reported: true });
assert.deepEqual(sanitizeExecutorClosed("nope"), []);

const source = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf("const hbMatch"), source.indexOf("RETIRED BROWSER RPC LANE"));
assert.match(route, /cryptoTimingEqual\(auth, secret\)/,
  "heartbeat GET and POST must remain behind the floor executor secret");
assert.match(route, /req\.method === "GET"/);
assert.match(route, /cache-control", "no-store"/);
assert.match(route, /req\.method !== "POST"/);
assert.match(route, /health: sanitizeExecutorHealth\(body\.health\)/,
  "the authenticated heartbeat route must persist only sanitized health evidence");
assert.match(route, /ledger: sanitizeExecutorLedger\(body\.ledger\)/,
  "the heartbeat route must persist the bot's ledger only through its sanitizer");
assert.match(route, /reporting: sanitizeExecutorReporting\(body\.reporting\)/,
  "the heartbeat route must persist the fill-report queue only through its sanitizer");
/* And the board reads them from the status payload, by these names. */
const viewer = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
assert.match(viewer, /exec\.telemetry\?\.heartbeat\?\.ledger/, "the Overview's P&L tile must read the bot's ledger from the status payload");
assert.match(viewer, /ledger\.realizedSol/, "the P&L tile must show realized SOL from the ledger");
assert.match(viewer, /reporting\.fillsOwed > 0/, "the board must say when fill reports are owed");
assert.match(viewer, /From your bot's own journal/, "the tile must say where the number comes from");
/* And the book — positions and closes — is rendered on BOTH the Overview and the tab,
   outside the detailed-view fold. */
assert.equal((viewer.match(/^\s*renderBotBook\(el, /gm) || []).length, 2, "the book renders on the Overview and on the WALL-ST-E tab");
assert.match(viewer, /Open positions · /, "the open positions card is titled");
assert.match(viewer, /Closed trades · /, "the closed trades card is titled");
assert.match(viewer, /not on the desk/, "a close the desk has not recorded is marked as such, not hidden");
assert.match(route, /held: sanitizeExecutorHeld\(body\.held\)/, "held positions persist only through their sanitizer");
assert.match(route, /closed: sanitizeExecutorClosed\(body\.closed\)/, "closes persist only through their sanitizer");

console.log("\nexecutor heartbeat readback is authenticated, read-only and secret-safe\n");
