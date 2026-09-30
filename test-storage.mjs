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
import { storageReport, checkpoint, storageWarning, startStorageCare, latestStorageReport, purgeCoverageJunk,
  STORAGE_WARN_FRAC } from "./src/lib/storage.js";

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
await care.tick();
assert.ok(Array.isArray(latestStorageReport(db).tables), "after a shift the endpoint serves the full report");
care.stop();
assert.equal(latestStorageReport(db).tables, null, "a stopped shift hands back to the cheap report");

/* THE TRIM: only insufficient_coverage, only unpublished, only older than a day, with its
   forward marks and simulated outcome; everything else stays. */
db.exec(`CREATE TABLE decision_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT, decided_at INTEGER NOT NULL,
           record_json TEXT NOT NULL, published_call_id INTEGER);
         CREATE TABLE forward_marks (run_id INTEGER NOT NULL, horizon_min INTEGER NOT NULL, PRIMARY KEY (run_id, horizon_min));
         CREATE TABLE simulated_outcomes (run_id INTEGER PRIMARY KEY, data_status TEXT NOT NULL)`);
const NOW = 1_790_000_000_000, DAY = 86_400_000;
const addRun = (outcome, age, published = null) => {
  const id = Number(db.prepare("INSERT INTO decision_runs (outcome, decided_at, record_json, published_call_id) VALUES (?,?,?,?)")
    .run(outcome, NOW - age, "y".repeat(3000), published).lastInsertRowid);
  for (const h of [15, 60, 360]) db.prepare("INSERT INTO forward_marks VALUES (?,?)").run(id, h);
  db.prepare("INSERT INTO simulated_outcomes VALUES (?, 'pending')").run(id);
  return id;
};
const oldJunk = [];
for (let i = 0; i < 1_200; i++) oldJunk.push(addRun(i % 4 === 0 ? "screened_out" : "insufficient_coverage", 3 * DAY - i * 1000));
const keptDecided = addRun("decided", 2 * DAY);
const publishedJunk = addRun("insufficient_coverage", 2 * DAY, 7);
const freshJunk = addRun("insufficient_coverage", DAY / 2);
let yields = 0;
const p = await purgeCoverageJunk(db, { now: NOW, batch: 100, yieldFn: async () => { yields++; } });
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
assert.equal(p.deleted, 900, "every old insufficient_coverage row is removed");
assert.ok(p.reachedCutoff, "the walk stops at the first row younger than a day");
assert.ok(yields >= 10, "it yields between batches instead of holding the API");
assert.equal(count("SELECT COUNT(*) n FROM decision_runs WHERE outcome='screened_out'"), 300, "other outcomes are untouched");
assert.ok(count("SELECT COUNT(*) n FROM decision_runs WHERE id=?", keptDecided), "a decided run stays");
assert.ok(count("SELECT COUNT(*) n FROM decision_runs WHERE id=?", publishedJunk), "a published row is never deleted");
assert.ok(count("SELECT COUNT(*) n FROM decision_runs WHERE id=?", freshJunk), "a row under a day old stays");
assert.equal(count("SELECT COUNT(*) n FROM forward_marks WHERE run_id NOT IN (SELECT id FROM decision_runs)"), 0,
  "no forward mark is left without its decision");
assert.equal(count("SELECT COUNT(*) n FROM simulated_outcomes WHERE run_id NOT IN (SELECT id FROM decision_runs)"), 0,
  "no simulated outcome is left without its decision");
assert.equal((await purgeCoverageJunk(db, { now: NOW })).deleted, 0, "a second pass finds nothing");
assert.deepEqual(await purgeCoverageJunk(new DatabaseSync(":memory:"), { now: NOW }),
  { scanned: 0, deleted: 0, batches: 0, reachedCutoff: false }, "a database with no decisions table is left alone");
const src2 = fs.readFileSync(new URL("./src/lib/storage.js", import.meta.url), "utf8");
assert.match(src2, /SELECT id, outcome, decided_at FROM decision_runs WHERE id > \?/, "the walk goes by primary key and never reads the evidence column");

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS test-storage");
