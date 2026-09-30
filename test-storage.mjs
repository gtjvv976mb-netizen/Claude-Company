/**
 * src/lib/storage.js: the disk report, the hourly WAL reset and the near-full warning.
 * Runs against its own throwaway database; the live journal is never opened.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openJournal } from "./src/lib/db-file.js";
import { storageReport, checkpoint, storageWarning, startStorageCare, latestStorageReport, STORAGE_WARN_FRAC } from "./src/lib/storage.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-storage-"));
const file = path.join(dir, "s.db");
const db = openJournal(DatabaseSync, file);
db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT); CREATE INDEX big_blob ON big(blob); CREATE TABLE small (id INTEGER PRIMARY KEY)");
const ins = db.prepare("INSERT INTO big (blob) VALUES (?)");
for (let i = 0; i < 2_000; i++) ins.run(`${i}-${"x".repeat(400)}`);
db.prepare("INSERT INTO small DEFAULT VALUES").run();

assert.equal(String(db.prepare("PRAGMA journal_size_limit").get().journal_size_limit), "67108864", "the WAL keeps at most 64 MB");

const est = storageReport(db, { file });
assert.equal(est.tables[0].name, "big", "the hourly report ranks tables by estimated rows");
assert.equal(est.tables[0].rows, 2_000, "the rowid range estimates the row count");
assert.equal(est.tables[0].bytes, null, "and walks no pages, so it has no byte counts");
assert.ok(est.tables.some((t) => t.name === "small" && t.rows === 1));
assert.ok(!est.tables.some((t) => t.name.startsWith("sqlite_")), "system tables are left out");
/* The hourly shift must stay cheap: no dbstat walk and no COUNT(*) in the "rows" path. */
const src = fs.readFileSync(new URL("./src/lib/storage.js", import.meta.url), "utf8");
const rowsPath = src.slice(src.indexOf('tables === "rows"'), src.indexOf('tables === "bytes"'));
assert.ok(rowsPath.length > 0 && !/dbstat|COUNT\(\*\)/.test(rowsPath), "the hourly path neither walks pages nor counts rows");
assert.ok(/storageReport\(db\)/.test(src) && !/tables: "bytes"/.test(src.slice(src.indexOf("export function startStorageCare"))),
  "the shift uses the default (rows) report, never the byte walk");

const r = storageReport(db, { file, tables: "bytes" });
assert.equal(r.file, "s.db", "the report names the file, not the path");
assert.ok(r.dbBytes > 0 && r.pageCount > 0 && r.pageSize > 0);
assert.ok(r.walBytes > 0, "writes are in the log before a checkpoint");
assert.equal(r.tables[0].name, "big", "the biggest table comes first");
assert.equal(r.tables[0].rows, 2_000, "with its row count");
assert.ok(!r.tables.some((t) => t.name === "big_blob"), "an index is counted in its table, not listed alone");
assert.ok(r.tables.some((t) => t.name === "small" && t.rows === 1));
assert.ok(r.disk.totalBytes > 0 && r.disk.freeBytes >= 0, "the disk around the file is measured");

const cp = checkpoint(db);
assert.equal(cp.busy, 0, "nothing holds the log");
assert.equal(fs.statSync(`${file}-wal`).size, 0, "a TRUNCATE checkpoint empties the log file");

db.exec("DELETE FROM big");
const after = storageReport(db, { file, tables: false });
assert.equal(after.tables, null, "the table walk is skippable");
assert.ok(after.freelistPages > 0 && after.freeInFileBytes === after.freelistPages * after.pageSize,
  "deleted rows show up as free space inside the file");

const disk = (usedFrac, share = 0.1) => ({ disk: { totalBytes: 5e9, freeBytes: 5e9 * (1 - usedFrac) }, diskUsedFrac: usedFrac,
  dbShareOfDisk: share, dbBytes: 1e9, walBytes: 1e6, tables: [{ name: "chronicle", bytes: 9e8 }] });
assert.equal(storageWarning(disk(0.5)), null, "half full is quiet");
assert.match(storageWarning(disk(STORAGE_WARN_FRAC)), /disk 80% used.*chronicle 0\.90 GB/, "80% full names the biggest table");
assert.match(storageWarning(disk(0.3, 0.85)) ?? "", /database/, "a database near the disk size warns too");
assert.equal(storageWarning({ disk: { totalBytes: null } }), null, "no disk figures, no warning");
assert.match(storageWarning({ ...disk(0.9), tables: [{ name: "decision_runs", bytes: null, rows: 89_523 }] }),
  /decision_runs ~89523 rows/, "an hourly (rows-only) report names the biggest table by rows");

assert.equal(latestStorageReport(db).tables, null, "with no shift running the endpoint does no table walk");
const logs = [];
const care = startStorageCare(db, { log: (m) => logs.push(m), firstAfterMs: 1e9, everyMs: 1e9 });
care.tick();
assert.ok(Array.isArray(latestStorageReport(db).tables), "after a shift the endpoint serves the full report");
care.stop();
assert.equal(latestStorageReport(db).tables, null, "a stopped shift hands back to the cheap report");

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS test-storage");
