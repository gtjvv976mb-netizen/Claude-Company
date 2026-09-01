/**
 * macOS AC sleep inhibition for the supervised WALL-ST-E process.
 *
 * The Node runner remains the journal-lock owner. A direct, shell-free caffeinate
 * child watches that exact pid while pmset proves both idle-system-sleep and
 * system-sleep assertions are active on AC power. A protected sidecar binds the two
 * pids so launch readiness and the independent monitor can verify the same identity.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";

export const CAFFEINATE_PATH = "/usr/bin/caffeinate";
export const PMSET_PATH = "/usr/bin/pmset";
export const PS_PATH = "/bin/ps";
const RECORD_VERSION = 1;

export const sleepAssertionRecordPath = (lockFile) => `${path.resolve(lockFile)}.sleep-assertion`;

const protectedRecord = (file) => {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("sleep assertion record is not a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("sleep assertion record is not owner-only");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("sleep assertion record has the wrong owner");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.version !== RECORD_VERSION || !Number.isInteger(value.ownerPid) || value.ownerPid <= 1 ||
      !Number.isInteger(value.assertionPid) || value.assertionPid <= 1 ||
      value.kind !== "caffeinate-is-w") throw new Error("sleep assertion record is invalid");
  return value;
};

const processAlive = (pid, killFn = process.kill.bind(process)) => {
  try { killFn(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

const commandIdentity = (output, { ownerPid, assertionPid, caffeinatePath }) => {
  const match = /^\s*(\d+)\s+([\s\S]+?)\s*$/.exec(String(output || ""));
  if (!match || Number(match[1]) !== ownerPid) return false;
  const tokens = match[2].split(/\s+/);
  return tokens.length === 5 && tokens[0] === caffeinatePath &&
    tokens[1] === "-i" && tokens[2] === "-s" && tokens[3] === "-w" &&
    tokens[4] === String(ownerPid) && assertionPid > 1;
};

/** Verify the protected record, exact parent/child command, AC source, and both IOPM assertions. */
export function verifyMacSleepAssertion({
  ownerPid, lockFile, caffeinatePath = CAFFEINATE_PATH, pmsetPath = PMSET_PATH,
  psPath = PS_PATH, execFile = execFileSync, killFn = process.kill.bind(process),
} = {}) {
  const result = { required: true, ok: false, assertionPid: null, acPower: false,
    idleSystemSleep: false, systemSleep: false, reason: "sleep assertion is unavailable" };
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !lockFile)
    return { ...result, reason: "sleep assertion owner identity is invalid" };
  let record;
  try { record = protectedRecord(sleepAssertionRecordPath(lockFile)); }
  catch (error) { return { ...result, reason: error.message }; }
  if (!record) return { ...result, reason: "sleep assertion record is missing" };
  result.assertionPid = record.assertionPid;
  if (record.ownerPid !== ownerPid)
    return { ...result, reason: "sleep assertion record belongs to a different lock owner" };
  if (!processAlive(record.assertionPid, killFn))
    return { ...result, reason: "caffeinate process is not alive" };
  try {
    const identity = execFile(psPath, ["-ww", "-p", String(record.assertionPid),
      "-o", "ppid=,command="], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (!commandIdentity(identity, { ownerPid, assertionPid: record.assertionPid, caffeinatePath }))
      return { ...result, reason: "caffeinate command is not bound to the journal-lock owner" };
    const battery = execFile(pmsetPath, ["-g", "batt"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    result.acPower = /Now drawing from ['\"]AC Power['\"]/i.test(battery);
    const assertions = execFile(pmsetPath, ["-g", "assertions"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const marker = new RegExp(`\\bpid\\s+${record.assertionPid}\\(caffeinate\\):`, "i");
    const owned = String(assertions).split(/\r?\n/).filter((line) => marker.test(line)).join("\n");
    result.idleSystemSleep = /PreventUserIdleSystemSleep/i.test(owned);
    result.systemSleep = /PreventSystemSleep/i.test(owned);
  } catch {
    return { ...result, reason: "macOS power assertion evidence could not be read" };
  }
  result.ok = result.acPower && result.idleSystemSleep && result.systemSleep;
  result.reason = result.ok ? null : !result.acPower ? "host is not drawing AC power"
    : "caffeinate does not hold both required sleep assertions";
  return result;
}

const writeRecord = (file, value) => {
  const parent = path.dirname(file);
  const temporary = `${file}.next-${process.pid}-${Date.now()}`;
  const bytes = `${JSON.stringify(value)}\n`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(temporary, 0o600);
  try {
    // link is an atomic no-replace publication on the same filesystem. A racing
    // supervisor cannot overwrite another process's assertion identity.
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const dir = fs.openSync(parent, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch {}
};

const unlinkMatchingRecord = (file, ownerPid, assertionPid) => {
  try {
    const record = protectedRecord(file);
    if (record?.ownerPid === ownerPid && record?.assertionPid === assertionPid) fs.unlinkSync(file);
  } catch {}
};

/** Start and continuously supervise the exact caffeinate assertion for this runner pid. */
export async function startMacSleepAssertion({
  ownerPid = process.pid, lockFile, caffeinatePath = CAFFEINATE_PATH,
  verify = verifyMacSleepAssertion, spawnFn = spawn, intervalMs = 15_000,
  onFailure = (reason) => {
    console.error(`WALL-ST-E launchd: macOS sleep assertion lost (${reason})`);
    process.exit(70);
  },
} = {}) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !lockFile)
    throw new Error("sleep assertion requires the exact runner pid and canonical lock");
  if (caffeinatePath !== CAFFEINATE_PATH)
    throw new Error("production sleep assertion must use /usr/bin/caffeinate");
  const recordFile = sleepAssertionRecordPath(lockFile);
  const prior = protectedRecord(recordFile);
  if (prior) {
    if (processAlive(prior.ownerPid)) throw new Error("another live sleep assertion record exists");
    fs.unlinkSync(recordFile);
  }

  const child = spawnFn(caffeinatePath, ["-i", "-s", "-w", String(ownerPid)], {
    stdio: "ignore", detached: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("caffeinate did not start in time")), 2_000);
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child.unref();
  writeRecord(recordFile, { version: RECORD_VERSION, ownerPid,
    assertionPid: child.pid, kind: "caffeinate-is-w" });

  let evidence = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    evidence = verify({ ownerPid, lockFile });
    if (evidence.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!evidence?.ok) {
    unlinkMatchingRecord(recordFile, ownerPid, child.pid);
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(evidence?.reason || "caffeinate assertion could not be verified");
  }

  let stopping = false;
  let failed = false;
  const failOnce = (reason) => {
    if (stopping || failed) return;
    failed = true;
    onFailure(reason);
  };
  child.once("exit", () => failOnce("caffeinate process exited"));
  const timer = setInterval(() => {
    const current = verify({ ownerPid, lockFile });
    if (!current.ok) failOnce(current.reason);
  }, Math.max(1_000, Number(intervalMs) || 15_000));
  timer.unref();

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    unlinkMatchingRecord(recordFile, ownerPid, child.pid);
    try { child.kill("SIGTERM"); } catch {}
  };
  process.once("exit", stop);
  return { assertionPid: child.pid, recordFile, evidence, stop };
}
