import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAFFEINATE_PATH, batteryPowerIsOperational, ensureEntryPauseFile, ensureSleepAssertionFault,
  inspectOwnerControlFile, requireMacEntryPower, sleepAssertionRecordPath,
  sleepAssertionFaultPath, startMacSleepAssertion, verifyMacSleepAssertion,
} from "./sleep-assertion.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-sleep-assertion-"));
const lockFile = path.join(dir, "state.sqlite.lock");
const ownerPid = 4321;
const assertionPid = 8765;
const recordFile = sleepAssertionRecordPath(lockFile);
const faultFile = sleepAssertionFaultPath(lockFile);
const pauseFile = path.join(dir, "state.sqlite.pause-entries");
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
  assert.equal(batteryPowerIsOperational(verifyMacSleepAssertion({ ownerPid, lockFile,
    execFile: evidence({ ac: false, system: false }), killFn: () => {} })), true,
  "the exact caffeinate child retains its idle assertion while battery power degrades entry readiness");
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

  assert.deepEqual(inspectOwnerControlFile(pauseFile), {
    path: pauseFile, present: false, valid: true, reason: null,
  });
  const createdPause = ensureEntryPauseFile(pauseFile, { reason: "test battery transition" });
  assert.equal(createdPause.created, true);
  assert.equal(fs.lstatSync(pauseFile).mode & 0o777, 0o600);
  assert.equal(ensureEntryPauseFile(pauseFile).created, false,
    "a second atomic creator validates rather than replacing the published sentinel");
  assert.equal(inspectOwnerControlFile(pauseFile, {
    ownerUid: fs.lstatSync(pauseFile).uid + 1,
  }).valid, false, "a sentinel owned by another user cannot be certified");
  fs.chmodSync(pauseFile, 0o644);
  assert.equal(inspectOwnerControlFile(pauseFile).present, true);
  assert.equal(inspectOwnerControlFile(pauseFile).valid, false,
    "a public-mode sentinel is active but cannot be certified");
  assert.throws(() => ensureEntryPauseFile(pauseFile), /owner-only/);
  fs.unlinkSync(pauseFile);
  const danglingTarget = path.join(dir, "must-not-be-created");
  fs.symlinkSync(danglingTarget, pauseFile);
  const dangling = inspectOwnerControlFile(pauseFile);
  assert.equal(dangling.present, true, "a dangling symlink must fail closed as paused");
  assert.equal(dangling.valid, false);
  assert.throws(() => ensureEntryPauseFile(pauseFile), /safely opened/);
  assert.equal(fs.existsSync(danglingTarget), false, "pause publication never follows the symlink target");
  fs.unlinkSync(pauseFile);

  const writableParent = path.join(dir, "group-writable");
  fs.mkdirSync(writableParent, { mode: 0o700 });
  fs.chmodSync(writableParent, 0o770);
  assert.throws(() => ensureEntryPauseFile(path.join(writableParent, "pause")),
    /must not be writable by group or other/);
  const realParent = path.join(dir, "real-parent");
  const linkedParent = path.join(dir, "linked-parent");
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, linkedParent);
  assert.throws(() => ensureEntryPauseFile(path.join(linkedParent, "pause")),
    /non-symlink directory/);

  const raceFile = path.join(dir, "race.pause-entries");
  const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "sleep-assertion.mjs")).href;
  const raceSource = `import { ensureEntryPauseFile } from ${JSON.stringify(moduleUrl)};` +
    `ensureEntryPauseFile(${JSON.stringify(raceFile)}, { reason: "race" });`;
  const racer = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", raceSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([racer(), racer()]);
  assert.equal(inspectOwnerControlFile(raceFile).valid, true,
    "racing O_EXCL publishers converge on one valid sentinel");

  const createdFault = ensureSleepAssertionFault(lockFile, { reason: "synthetic pause failure" });
  assert.equal(createdFault.created, true);
  assert.equal(fs.lstatSync(faultFile).mode & 0o777, 0o600,
    "the canonical sleep fault latch is owner-only");
  assert.equal(ensureSleepAssertionFault(lockFile).created, false,
    "the fault latch is validated in place and never replaced");
  fs.unlinkSync(faultFile);

  const calls = [];
  class FakeChild extends EventEmitter {
    constructor() { super(); this.pid = assertionPid; }
    unref() { calls.push("unref"); }
    kill(signal) { calls.push(`kill:${signal}`); return true; }
  }
  const child = new FakeChild();
  const started = startMacSleepAssertion({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile,
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
  assert.equal(inspectOwnerControlFile(pauseFile).present, true,
    "an explicit supervisor stop publishes the entry pause");
  assert.equal(inspectOwnerControlFile(pauseFile).valid, true,
    "the explicit-stop pause is owner-only and valid");
  assert.equal(fs.existsSync(recordFile), false);
  assert.ok(calls.includes("kill:SIGTERM"));

  // Exercise the real Node lifecycle rather than only calling the returned stop
  // handle. launchd sees all of these as service exits, and none may erase the
  // crash witness before a durable pause (or fault latch) exists.
  const exitModuleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "sleep-assertion.mjs")).href;
  const runProcessExitScenario = async (name, action, {
    signalAfterReady = null, readyMarker = "READY", expectRetainedRecord = false,
  } = {}) => {
    const scenarioDir = path.join(dir, `process-exit-${name}`);
    fs.mkdirSync(scenarioDir, { mode: 0o700 });
    const scenarioLock = path.join(scenarioDir, "state.sqlite.lock");
    const scenarioPause = path.join(scenarioDir, "state.sqlite.pause-entries");
    const scenarioFault = sleepAssertionFaultPath(scenarioLock);
    const scenarioRecord = sleepAssertionRecordPath(scenarioLock);
    const source = `
      import fs from "node:fs";
      import { EventEmitter } from "node:events";
      import { startMacSleepAssertion, sleepAssertionFaultPath } from ${JSON.stringify(exitModuleUrl)};
      class AssertionChild extends EventEmitter {
        constructor() { super(); this.pid = process.pid + 100000; }
        unref() {}
        kill() { return true; }
      }
      const root = process.argv[1];
      const lockFile = root + "/state.sqlite.lock";
      const pauseEntriesFile = root + "/state.sqlite.pause-entries";
      const assertion = new AssertionChild();
      await startMacSleepAssertion({
        ownerPid: process.pid,
        lockFile,
        pauseEntriesFile,
        spawnFn: () => {
          queueMicrotask(() => assertion.emit("spawn"));
          return assertion;
        },
        verify: () => ({ ok: true, commandBound: true, powerSource: "ac",
          acPower: true, idleSystemSleep: true, systemSleep: true,
          assertionPid: assertion.pid }),
        setIntervalFn: () => ({ unref() {} }),
        clearIntervalFn: () => {},
      });
      process.stdout.write("READY\\n");
      ${action}
    `;
    const result = await new Promise((resolve, reject) => {
      const subprocess = spawn(process.execPath, ["--input-type=module", "-e", source,
        scenarioDir], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let signalled = false;
      subprocess.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (signalAfterReady && !signalled && stdout.includes(readyMarker)) {
          signalled = true;
          subprocess.kill(signalAfterReady);
        }
      });
      subprocess.stderr.on("data", (chunk) => { stderr += chunk; });
      subprocess.once("error", reject);
      subprocess.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.ok(result.code !== 0 || result.signal,
      `${name} subprocess must take a non-success runtime-exit path`);
    const observedPause = inspectOwnerControlFile(scenarioPause);
    const observedFault = inspectOwnerControlFile(scenarioFault);
    if (expectRetainedRecord) {
      assert.equal(fs.existsSync(scenarioRecord), true,
        `${name} must retain the assertion record when neither control can be published`);
      assert.equal(observedPause.present, true,
        `${name} test setup must leave the broken pause control present`);
      assert.equal(observedPause.valid, false);
      assert.equal(observedFault.present, true,
        `${name} test setup must leave the broken fault control present`);
      assert.equal(observedFault.valid, false);
    } else {
      assert.equal(observedPause.present, true,
        `${name} must publish an entry pause before removing its assertion record`);
      assert.equal(observedPause.valid, true,
        `${name} must durably pause entries before removing its assertion record`);
      assert.equal(observedFault.present, false,
        `${name} does not need a fault latch when pause publication succeeds`);
      assert.equal(fs.existsSync(scenarioRecord), false,
        `${name} may remove its assertion record only after the pause exists`);
    }
  };

  await runProcessExitScenario("explicit", "process.exit(73);");
  await runProcessExitScenario("sigterm", `
    process.on("SIGTERM", () => process.exit(143));
    process.stdout.write("ARMED\\n");
    setInterval(() => {}, 1000);
  `, { signalAfterReady: "SIGTERM", readyMarker: "ARMED" });
  await runProcessExitScenario("import-fatal", `
    await import("data:text/javascript,throw new Error('synthetic poller import failure')");
  `);
  await runProcessExitScenario("controls-broken", `
    fs.symlinkSync(root + "/missing-pause-target", pauseEntriesFile);
    fs.symlinkSync(root + "/missing-fault-target", sleepAssertionFaultPath(lockFile));
    process.exit(74);
  `, { expectRetainedRecord: true });

  const operationalAc = { ok: true, commandBound: true, powerSource: "ac",
    acPower: true, idleSystemSleep: true, systemSleep: true, assertionPid };
  const operationalBattery = { ok: false, commandBound: true, powerSource: "battery",
    acPower: false, idleSystemSleep: true, systemSleep: false, assertionPid,
    reason: "host is drawing battery power" };
  const brokenSystemAssertion = { ok: false, commandBound: true, powerSource: "ac",
    acPower: true, idleSystemSleep: true, systemSleep: false, assertionPid,
    reason: "caffeinate does not hold both required sleep assertions" };
  const makeController = async ({ initial, transitions = [] } = {}) => {
    try { fs.unlinkSync(recordFile); } catch {}
    try { fs.unlinkSync(pauseFile); } catch {}
    try { fs.unlinkSync(faultFile); } catch {}
    const controllerCalls = [];
    let intervalCallback = null;
    let index = 0;
    const controllerChild = new FakeChild();
    const handle = await startMacSleepAssertion({ ownerPid, lockFile, pauseEntriesFile: pauseFile,
      spawnFn: () => {
        queueMicrotask(() => controllerChild.emit("spawn"));
        return controllerChild;
      },
      verify: () => index === 0 ? initial : transitions[Math.min(index - 1, transitions.length - 1)],
      setIntervalFn: (callback) => {
        intervalCallback = () => { index++; callback(); };
        return { unref() {} };
      },
      clearIntervalFn: () => {},
      onDegraded: (reason) => controllerCalls.push(`degraded:${reason}`),
      onRestored: () => controllerCalls.push("restored"),
      onFailure: (reason) => {
        assert.equal(inspectOwnerControlFile(pauseFile).present, true,
          "a fatal assertion loss publishes the pause before failing the runner");
        controllerCalls.push(`failure:${reason}`);
      },
    });
    return { handle, interval: () => intervalCallback(), controllerCalls, controllerChild };
  };

  const batteryStartup = await makeController({ initial: operationalBattery });
  assert.equal(inspectOwnerControlFile(pauseFile).valid, true,
    "battery startup publishes an owner-only pause and keeps the runner alive");
  assert.deepEqual(batteryStartup.controllerCalls, ["degraded:host is drawing battery power"]);
  assert.equal(batteryStartup.controllerChild.listenerCount("exit") > 0, true);
  batteryStartup.handle.stop();

  const runtimeTransition = await makeController({ initial: operationalAc,
    transitions: [operationalBattery, operationalBattery, operationalAc] });
  assert.equal(fs.existsSync(pauseFile), false);
  runtimeTransition.interval();
  assert.equal(inspectOwnerControlFile(pauseFile).valid, true,
    "runtime AC loss atomically pauses entries without stopping the lock owner");
  runtimeTransition.interval();
  assert.equal(runtimeTransition.controllerCalls.filter((item) => item.startsWith("degraded:")).length, 1,
    "one battery episode is logged once");
  runtimeTransition.interval();
  assert.ok(runtimeTransition.controllerCalls.includes("restored"));
  assert.equal(inspectOwnerControlFile(pauseFile).present, true,
    "AC restoration never automatically removes the power-loss pause");
  runtimeTransition.handle.stop();

  const fatalTransition = await makeController({ initial: operationalAc,
    transitions: [brokenSystemAssertion] });
  fatalTransition.interval();
  assert.ok(fatalTransition.controllerCalls.some((item) => item.startsWith("failure:")),
    "loss of an AC system assertion remains fatal after entries are paused");
  fatalTransition.handle.stop();

  const identityTransition = await makeController({ initial: operationalAc,
    transitions: [{ ...operationalBattery, commandBound: false,
      reason: "caffeinate command is not bound to the journal-lock owner" }] });
  identityTransition.interval();
  assert.ok(identityTransition.controllerCalls.some((item) => item.startsWith("failure:")),
    "battery mode is tolerated only while the exact idle assertion identity remains valid");
  identityTransition.handle.stop();

  // Publication failure at startup must survive a subsequent healthy AC restart.
  // Repairing only the broken pause path is intentionally insufficient: the
  // canonical fault latch requires its own explicit operator review/removal.
  try { fs.unlinkSync(recordFile); } catch {}
  try { fs.unlinkSync(pauseFile); } catch {}
  try { fs.unlinkSync(faultFile); } catch {}
  fs.symlinkSync(path.join(dir, "missing-startup-pause-target"), pauseFile);
  const startupChild = new FakeChild();
  await assert.rejects(startMacSleepAssertion({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile,
    spawnFn: () => {
      queueMicrotask(() => startupChild.emit("error", new Error("synthetic spawn failure")));
      return startupChild;
    },
    verify: () => operationalAc,
  }), /sleep assertion fault was durably latched/);
  assert.equal(inspectOwnerControlFile(faultFile, {
    label: "sleep assertion fault latch",
  }).valid, true, "startup pause failure publishes the canonical durable fault latch");
  fs.unlinkSync(pauseFile); // operator repairs the pause path, but has not reviewed the fault.

  const restartChild = new FakeChild();
  const restarted = await startMacSleepAssertion({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile,
    spawnFn: () => {
      queueMicrotask(() => restartChild.emit("spawn"));
      return restartChild;
    },
    verify: () => operationalAc,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
    onFailure: (reason) => { throw new Error(reason); },
  });
  assert.equal(inspectOwnerControlFile(faultFile).present, true,
    "a healthy AC restart never automatically clears a prior pause-publication fault");
  assert.throws(() => requireMacEntryPower({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile, verify: () => operationalAc }),
  /explicit operator repair and review/,
  "the restarted entry boundary remains closed despite valid AC evidence");
  restarted.stop();
  assert.equal(inspectOwnerControlFile(faultFile).present, true,
    "normal supervisor cleanup does not clear the durable fault latch");
  fs.unlinkSync(faultFile); // synthetic explicit operator acknowledgement after repair/review.
  assert.equal(requireMacEntryPower({ ownerPid, lockFile, pauseEntriesFile: pauseFile,
    verify: () => operationalAc }).ok, true,
  "entries can be reconsidered only after explicit operator fault-latch removal");

  const exitPublicationFailure = await makeController({ initial: operationalAc });
  fs.symlinkSync(path.join(dir, "missing-exit-pause-target"), pauseFile);
  exitPublicationFailure.controllerChild.emit("exit", 1);
  assert.equal(inspectOwnerControlFile(faultFile).valid, true,
    "a child-exit pause failure is durably fault-latched before runner failure");
  exitPublicationFailure.handle.stop();

  const verificationPublicationFailure = await makeController({ initial: operationalAc,
    transitions: [brokenSystemAssertion] });
  fs.symlinkSync(path.join(dir, "missing-verification-pause-target"), pauseFile);
  verificationPublicationFailure.interval();
  assert.equal(inspectOwnerControlFile(faultFile).valid, true,
    "a fatal-verification pause failure is durably fault-latched before runner failure");
  verificationPublicationFailure.handle.stop();

  const totalPublicationFailure = await makeController({ initial: operationalAc,
    transitions: [brokenSystemAssertion] });
  fs.symlinkSync(path.join(dir, "missing-total-pause-target"), pauseFile);
  fs.symlinkSync(path.join(dir, "missing-total-fault-target"), faultFile);
  totalPublicationFailure.interval();
  totalPublicationFailure.handle.stop();
  assert.equal(fs.existsSync(recordFile), true,
    "if neither safety control can be published, supervisor cleanup retains the assertion record");
  // Use an impossible old owner for a deterministic restart probe; the record itself
  // remains otherwise structurally valid and owner-only.
  writeRecord({ ...validRecord, ownerPid: 999_999_999 });
  await assert.rejects(startMacSleepAssertion({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile,
    spawnFn: () => { throw new Error("restart must not spawn before preserving safety"); },
    verify: () => operationalAc,
  }), /fault could not be latched/,
  "restart cannot discard the retained record while both durable controls remain broken");
  assert.equal(fs.existsSync(recordFile), true,
    "the failed restart still preserves its third fail-closed witness");

  fs.unlinkSync(pauseFile);
  fs.unlinkSync(faultFile);
  const repairedRestartChild = new FakeChild();
  const repairedRestart = await startMacSleepAssertion({ ownerPid, lockFile,
    pauseEntriesFile: pauseFile,
    spawnFn: () => {
      queueMicrotask(() => repairedRestartChild.emit("spawn"));
      return repairedRestartChild;
    },
    verify: () => operationalAc,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
    onFailure: (reason) => { throw new Error(reason); },
  });
  assert.equal(inspectOwnerControlFile(pauseFile).valid, true,
    "after structural repair, the stale record is replaced only after a durable pause is published");
  repairedRestart.stop();

  try { fs.unlinkSync(pauseFile); } catch {}
  try { fs.unlinkSync(faultFile); } catch {}
  assert.equal(requireMacEntryPower({ ownerPid, lockFile, pauseEntriesFile: pauseFile,
    verify: () => operationalAc }).ok, true);
  assert.throws(() => requireMacEntryPower({ ownerPid, lockFile, pauseEntriesFile: pauseFile,
    verify: () => operationalBattery }), /entries were durably paused/);
  assert.equal(inspectOwnerControlFile(pauseFile).valid, true,
    "the synchronous entry power gate pauses before throwing");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nmacOS caffeinate assertion is bound to the exact lock owner and independently verifiable\n");
