/* THE JOURNAL'S DURABILITY SETTINGS, EXECUTED — AND THE SAFETY RULE BEHIND THEM.
 *
 * SQLite's default `journal_mode=delete` + `synchronous=FULL` pays roughly three disk
 * barriers per autocommit write. The desk's simulations commit ~74,000 of them
 * (measured 2026-09-10: 74,263 statement writes against 315 explicit transactions),
 * which costs almost nothing on macOS — APFS's fsync() returns without reaching the
 * medium — and 1-4ms EACH on the Linux SSDs CI runs on. That difference timed out the
 * Pages build twice, and raising the timeout 360s -> 900s did not help, because the
 * cost is per-commit, not per-core.
 *
 * A Mac cannot observe the regression this guards, so the guard is on the MECHANISM:
 * the pragmas that are actually set, and the rule that `synchronous = NORMAL` is only
 * ever applied when WAL is genuinely in force. Nothing here asserts a duration. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openJournal } from "./src/lib/db-file.js";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-durability-"));

console.log("\nTHE REAL OPEN PATH");
const db = openJournal(DatabaseSync, path.join(tmp, "journal.sqlite"));

ok("the journal runs in WAL, so a commit appends instead of rebuilding a rollback file", () => {
  const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.equal(String(mode).toLowerCase(), "wal", `journal_mode = ${mode}`);
});

ok("synchronous is NORMAL (1) — the fsync moves to the checkpoint, not every statement", () => {
  const sync = db.prepare("PRAGMA synchronous").get().synchronous;
  assert.equal(sync, 1, `synchronous = ${sync} (want 1 = NORMAL; 2 = FULL is the default)`);
});

ok("a contended write waits instead of throwing SQLITE_BUSY immediately", () => {
  const ms = db.prepare("PRAGMA busy_timeout").get().timeout;
  assert.ok(ms >= 1000, `busy_timeout = ${ms}ms`);
});

ok("the database still reads back what it is told to store", () => {
  db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
  for (let i = 0; i < 200; i++) db.prepare("INSERT INTO t (k,v) VALUES (?,?)").run(`k${i}`, i);
  const n = db.prepare("SELECT COUNT(*) c FROM t").get().c;
  const sum = db.prepare("SELECT SUM(v) s FROM t").get().s;
  assert.equal(n, 200, `rows = ${n}`);
  assert.equal(sum, 19900, `sum = ${sum}`);
});

/* THE SAFETY RULE. `synchronous = NORMAL` is sound ONLY because the write-ahead log is
 * the crash-recovery record. On a filesystem that refuses WAL (no shared-memory support)
 * the pragma must NOT be applied, or the journal would be left less durable than SQLite's
 * own default with nothing standing in for it. */
console.log("\nWHEN WAL IS REFUSED");
const madeFake = (reportedMode) => {
  const calls = [];
  class Fake {
    prepare(sql) {
      calls.push(sql);
      return { get: () => (/journal_mode/i.test(sql) ? { journal_mode: reportedMode } : {}) };
    }
    exec(sql) { calls.push(sql); }
  }
  return { Fake, calls };
};

ok("a filesystem that refuses WAL keeps synchronous at the FULL default", () => {
  const { Fake, calls } = madeFake("delete");
  openJournal(Fake, path.join(tmp, "refused.sqlite"));
  const weakened = calls.filter((s) => /synchronous/i.test(s));
  assert.equal(weakened.length, 0, `synchronous was set anyway: ${JSON.stringify(weakened)}`);
});

ok("a filesystem that ACCEPTS WAL does get the NORMAL setting", () => {
  const { Fake, calls } = madeFake("wal");
  openJournal(Fake, path.join(tmp, "accepted.sqlite"));
  const set = calls.filter((s) => /synchronous\s*=\s*NORMAL/i.test(s));
  assert.equal(set.length, 1, `synchronous=NORMAL applied ${set.length} time(s)`);
});

ok("a build too old to know either pragma still yields a usable database", () => {
  class Ancient {
    prepare() { throw new Error("no such pragma"); }
    exec() { throw new Error("no such pragma"); }
  }
  const out = openJournal(Ancient, path.join(tmp, "ancient.sqlite"));
  assert.ok(out instanceof Ancient, "openJournal must return the connection regardless");
});

/* THE OPEN SITES THEMSELVES. Both desk journals must come through the helper — a future
 * edit that goes back to `new DatabaseSync(resolveDbFile())` would silently restore the
 * per-statement fsync and nothing else in the suite would notice. */
console.log("\nEVERY DESK JOURNAL OPENS THROUGH THE HELPER");
for (const rel of ["src/lib/store.js", "src/funnel.js"]) {
  ok(`${rel} opens through openJournal, not a bare DatabaseSync`, () => {
    const src = fs.readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
    assert.match(src, /openJournal\(DatabaseSync\)/, `${rel} must call openJournal(DatabaseSync)`);
    assert.doesNotMatch(src, /new DatabaseSync\(resolveDbFile\(\)\)/,
      `${rel} still opens the journal directly`);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n══ ${pass} passed, 0 failed ══`);
