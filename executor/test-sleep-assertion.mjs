import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAFFEINATE_PATH, sleepAssertionRecordPath, startMacSleepAssertion,
  verifyMacSleepAssertion,
} from "./sleep-assertion.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-sleep-assertion-"));
const lockFile = path.join(dir, "state.sqlite.lock");
const ownerPid = 4321;
const assertionPid = 8765;
const recordFile = sleepAssertionRecordPath(lockFile);
const writeRecord = (value, mode = 0o600) => {
  fs.writeFileSync(recordFile, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(recordFile, mode);
};
const validRecord = { version: 1, ownerPid, assertionPid, kind: "caffeinate-is-w" };
const evidence = ({ ac = true, idle = true, system = true, parent = ownerPid } = {}) =>
  (command, args) => {
    if (args.includes("-o")) return `${parent} ${CAFFEINATE_PATH} -i -s -w ${ownerPid}\n`;
    if (args[1] === "batt") return `Now drawing from '${ac ? "AC Power" : "Battery Power"}'\n`;
    return [
      idle ? `pid ${assertionPid}(caffeinate): PreventUserIdleSystemSleep named: caffeinate` : "",
      system ? `pid ${assertionPid}(caffeinate): PreventSystemSleep named: caffeinate` : "",
    ].join("\n");
  };

try {
  writeRecord(validRecord);
  const verified = verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence(), killFn: () => {} });
  assert.equal(verified.ok, true);
  assert.equal(verified.acPower, true);
  assert.equal(verified.idleSystemSleep, true);
  assert.equal(verified.systemSleep, true);

  assert.equal(verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence({ ac: false }), killFn: () => {} }).ok, false,
  "battery power cannot certify the AC-only system-sleep assertion");
  assert.equal(verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence({ system: false }), killFn: () => {} }).ok, false,
  "both the no-idle and system-sleep assertion must be present");
  assert.equal(verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence({ parent: ownerPid + 1 }), killFn: () => {} }).ok, false,
  "a caffeinate process not parented by the journal-lock owner is rejected");

  writeRecord(validRecord, 0o644);
  assert.match(verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence(), killFn: () => {} }).reason, /owner-only/);
  fs.unlinkSync(recordFile);

  const calls = [];
  class FakeChild extends EventEmitter {
    constructor() { super(); this.pid = assertionPid; }
    unref() { calls.push("unref"); }
    kill(signal) { calls.push(`kill:${signal}`); return true; }
  }
  const child = new FakeChild();
  const started = startMacSleepAssertion({ ownerPid, lockFile,
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    verify: () => ({ ok: true, acPower: true, idleSystemSleep: true,
      systemSleep: true, assertionPid }),
    intervalMs: 60_000,
    onFailure: (reason) => { throw new Error(reason); },
  });
  const handle = await started;
  assert.deepEqual(calls[0].args, ["-i", "-s", "-w", String(ownerPid)]);
  assert.equal(calls[0].options.shell, undefined, "caffeinate is never launched through a shell");
  assert.equal(JSON.parse(fs.readFileSync(recordFile, "utf8")).ownerPid, ownerPid);
  handle.stop();
  assert.equal(fs.existsSync(recordFile), false);
  assert.ok(calls.includes("kill:SIGTERM"));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nmacOS caffeinate assertion is bound to the exact lock owner and independently verifiable\n");
