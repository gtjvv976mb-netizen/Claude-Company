import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../config.js";

/**
 * WHICH SQLITE FILE THIS PROCESS IS ALLOWED TO OPEN.
 *
 * CLAUDE_CO_DB has always let a test run against a throwaway file, and scripts/test-all.mjs
 * sets it for every test it spawns. The hole is the OTHER way a test runs: by hand, the way
 * each file's own header tells you to — `node test-cohort-cycles.mjs`. Nothing sets the
 * variable then, so the fallback hands the test the LIVE desk journal.
 *
 * That is not theoretical. On 2026-09-07 test-cohort-cycles.mjs was run directly during a
 * simulation session. Its reset() closes every live call and then runs
 * `DELETE FROM call_events; DELETE FROM deliveries; DELETE FROM calls; DELETE FROM cycles`,
 * and the sequence died on a FOREIGN KEY after the first two deletes had already applied:
 * call_events and deliveries were emptied and two live calls were closed with reason
 * test_reset. The file is in .gitignore and untracked, so there was no backup to restore.
 *
 * So a process whose entry script is named `test-*.mjs` may not open the live file by
 * accident. It gets a throwaway under the temp dir instead, the redirection is announced on
 * stderr, and CLAUDE_CO_DB is exported so every other opener in the process — and any child
 * it spawns — agrees on the same file. An explicit CLAUDE_CO_DB always wins, and nothing
 * about the desk, the office or the executor changes: none of them is named test-*.mjs.
 */
export function resolveDbFile() {
  if (process.env.CLAUDE_CO_DB) return process.env.CLAUDE_CO_DB;

  const entry = path.basename(String(process.argv[1] || ""));
  if (/^test-.*\.mjs$/.test(entry)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-standalone-test-"));
    const file = path.join(dir, "journal.sqlite");
    process.env.CLAUDE_CO_DB = file;      // children and later openers follow
    process.stderr.write(
      `db-file: ${entry} ran without CLAUDE_CO_DB — using a throwaway at ${file}. ` +
      "A test never gets the live desk journal; set CLAUDE_CO_DB to choose the file.\n");
    return file;
  }
  return path.join(ROOT, "claude-co.db");
}

/**
 * OPEN THE JOURNAL WITH DURABILITY SETTINGS THAT SURVIVE A REAL FSYNC.
 *
 * SQLite's defaults are `journal_mode=delete` + `synchronous=FULL`: every autocommit
 * write creates a rollback journal, fsyncs it, writes the page, fsyncs the database,
 * deletes the journal, and fsyncs the directory twice over. That is roughly three
 * barriers per statement.
 *
 * On macOS that is nearly free — APFS's fsync() hands the write to the buffer cache
 * and returns; only F_FULLFSYNC actually reaches the medium. On Linux it is a true
 * barrier, ~1-4ms on the Azure-backed SSDs GitHub's runners use. The desk's own
 * simulations commit about 74,000 autocommit writes (measured 2026-09-10:
 * 74,263 statement writes against just 315 explicit transactions), so the same run
 * that takes 31s on this Mac spends 200-900s in fsync alone on CI.
 *
 * That is not a hypothetical: test-quota-simulation.mjs and test-sim-c.mjs timed out
 * on the Pages build twice, and RAISING THE TIMEOUT (360s -> 900s) did not help,
 * because the cost is per-commit and not per-core. A Mac structurally cannot observe
 * this, which is why it survived local runs for so long.
 *
 * WAL removes the journal create/delete churn entirely, and under WAL `synchronous =
 * NORMAL` is the standard recommendation: commits append to the log and the fsync
 * happens at checkpoints instead of on every statement. It stays durable across an
 * application crash — only an OS-level or power crash can cost the most recent
 * commits, which for a research journal on an ephemeral Render disk is the right
 * trade. It also lets readers run concurrently with the writer, which the plain
 * rollback journal does not.
 *
 * NORMAL is only sound WITH WAL, so if WAL cannot be set — a filesystem with no
 * shared-memory support will refuse it — synchronous is left at the FULL default
 * rather than quietly weakened. Nothing here changes what is stored or asserted;
 * it changes only how often the process waits for the disk.
 */
export function openJournal(DatabaseSync, file = resolveDbFile()) {
  const db = new DatabaseSync(file);
  let mode = "";
  try {
    mode = String(db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode || "");
  } catch { mode = ""; }
  if (mode.toLowerCase() === "wal") {
    // Safe only because the log above is now the crash-recovery record.
    try { db.exec("PRAGMA synchronous = NORMAL"); } catch { /* keep the FULL default */ }
  }
  // WAL lets readers and the writer overlap, but a SECOND writer still gets SQLITE_BUSY,
  // and node:sqlite throws on it immediately instead of waiting. The desk API and the
  // scanner are separate processes over one file, so give a contended write a chance to
  // land rather than turning a millisecond of overlap into a thrown request.
  try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* older build: not fatal */ }
  return db;
}
