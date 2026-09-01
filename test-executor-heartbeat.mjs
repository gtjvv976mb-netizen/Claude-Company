import assert from "node:assert/strict";
import fs from "node:fs";
import db from "./src/lib/store.js";
import { executorHeartbeatPayload, sanitizeExecutorHealth } from "./src/office.js";
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

const source = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf("const hbMatch"), source.indexOf("RETIRED BROWSER RPC LANE"));
assert.match(route, /cryptoTimingEqual\(auth, secret\)/,
  "heartbeat GET and POST must remain behind the floor executor secret");
assert.match(route, /req\.method === "GET"/);
assert.match(route, /cache-control", "no-store"/);
assert.match(route, /req\.method !== "POST"/);

console.log("\nexecutor heartbeat readback is authenticated, read-only and secret-safe\n");
