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
