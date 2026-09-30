import fs from "node:fs";
import path from "node:path";
import { resolveDbFile } from "./db-file.js";

/**
 * THE DISK THE DESK LIVES ON (2026-09-30).
 *
 * On 2026-09-29 the Render disk (1 GB) filled and the API went into a crash loop: every
 * write failed with SQLite "disk I/O error" (errcode 4874, SQLITE_IOERR_SHMSIZE — the WAL
 * index could not grow). The owner resized the disk to 5 GB, which buys time and says
 * nothing about WHAT filled it. So three things live here:
 *
 *   1. A report: the database file, its write-ahead log, the free space inside the file,
 *      the disk around it, and the biggest tables (hourly by estimated rows; by bytes only
 *      from the `storage` command). Aggregates only — table names and sizes, never a row.
 *      The first measurement by bytes (2026-09-30, 1.38 GB): decision_runs 882 MB (89,523
 *      rows), snapshots 258 MB (1.1M), forward_marks 78 MB, chronicle 71 MB.
 *   2. A checkpoint that folds the write-ahead log back into the database and truncates it.
 *      SQLite checkpoints on its own, but a busy reader can starve that, and a WAL that is
 *      never reset only grows. Once an hour it is reset on purpose.
 *   3. A warning in the log when the database nears the disk, so the next full disk is a
 *      log line hours ahead instead of a crash loop.
 *
 * One trim IS here, chosen after the report named the table (purgeCoverageJunk, below):
 * research attempts with no panel judgement in them, older than a day. Nothing else is
 * deleted. Row estimates come from the rowid range, so after a trim they overstate a
 * table's rows by the gaps it left; the byte walk (`node src/index.js storage`) is exact.
 */

/** Warn when the database and its log take this share of the disk, or free space is below it. */
export const STORAGE_WARN_FRAC = 0.8;

const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

/** The disk the file sits on: total and free bytes, or nulls where the platform cannot say. */
function diskOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
  } catch { return { totalBytes: null, freeBytes: null }; }
}

/**
 * What the database is made of, right now. `tables`:
 *   "rows"  (the hourly shift) — every table's row count ESTIMATED from its rowid range: two
 *           index probes per table, instant at any size. `bytes` is null.
 *   "bytes" — every page walked (dbstat) and every row counted. On the live 1.4 GB file this
 *           froze the API process for over a minute on 2026-09-30, so it is NEVER run inside the
 *           API: only by `node src/index.js storage`, its own process, from the Render shell.
 *   false   — file and disk sizes only.
 */
export function storageReport(db, { file = resolveDbFile(), tables = "rows", top = 15, clock = Date.now } = {}) {
  const pragma = (name) => { try { return Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]) || 0; } catch { return 0; } };
  const pageSize = pragma("page_size");
  const pageCount = pragma("page_count");
  const freelistPages = pragma("freelist_count");
  const dbBytes = size(file), walBytes = size(`${file}-wal`), shmBytes = size(`${file}-shm`);
  const disk = diskOf(path.dirname(path.resolve(file)));
  const usedBytes = dbBytes + walBytes + shmBytes;
  const out = {
    atMs: clock(),
    file: path.basename(file),
    dbBytes, walBytes, shmBytes, usedBytes,
    pageSize, pageCount, freelistPages,
    /* Pages freed by deletes stay in the file for reuse; the file only shrinks with VACUUM. */
    freeInFileBytes: freelistPages * pageSize,
    disk,
    diskUsedFrac: disk.totalBytes ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 1000) / 1000 : null,
    dbShareOfDisk: disk.totalBytes ? Math.round((usedBytes / disk.totalBytes) * 1000) / 1000 : null,
    tables: null,
  };
  if (tables === "rows") {
    try {
      const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      out.tables = names.map(({ name }) => {
        let n = null;
        try {
          const r = db.prepare(`SELECT MAX(rowid) - MIN(rowid) + 1 AS n FROM "${String(name).replace(/"/g, '""')}"`).get();
          n = r?.n == null ? 0 : Number(r.n);
        } catch { /* a WITHOUT ROWID table: no estimate */ }
        return { name: String(name), bytes: null, rows: Number.isFinite(n) ? n : null, rowsEstimated: true };
      }).sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1)).slice(0, top);
    } catch { out.tables = null; }
  } else if (tables === "bytes") {
    try {
      /* dbstat is compiled into node:sqlite; aggregate=TRUE is one row per table or index.
         Indexes are folded into the table they belong to, because that is what a trim frees. */
      const rows = db.prepare(`SELECT COALESCE(s.tbl_name, d.name) AS name, SUM(d.pgsize) AS bytes
        FROM dbstat AS d LEFT JOIN sqlite_schema AS s ON s.name = d.name
        WHERE d.aggregate = TRUE GROUP BY 1 ORDER BY 2 DESC`).all();
      out.tables = rows.slice(0, top).map((r) => {
        let n = null;
        try { n = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${String(r.name).replace(/"/g, '""')}"`).get()?.n); } catch { /* a system table */ }
        return { name: String(r.name), bytes: Number(r.bytes) || 0, rows: Number.isFinite(n) ? n : null };
      });
    } catch { out.tables = null; }
  }
  return out;
}

/** Fold the write-ahead log into the database and truncate it. busy=1 means a reader held it. */
export function checkpoint(db) {
  try {
    const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() ?? {};
    return { busy: Number(r.busy) || 0, logPages: Number(r.log) || 0, checkpointedPages: Number(r.checkpointed) || 0 };
  } catch (error) { return { error: String(error?.message ?? error) }; }
}

/** Should the log shout? When the database nears the disk, or the disk nears full. */
export function storageWarning(report, frac = STORAGE_WARN_FRAC) {
  const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
  const { disk } = report;
  if (!disk.totalBytes) return null;
  if (report.diskUsedFrac >= frac || report.dbShareOfDisk >= frac) {
    const big = (report.tables || []).slice(0, 3)
      .map((t) => (t.bytes != null ? `${t.name} ${gb(t.bytes)}` : `${t.name} ~${t.rows ?? "?"} rows`)).join(", ");
    return `disk ${Math.round(report.diskUsedFrac * 100)}% used (${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}); `
      + `database ${gb(report.dbBytes)} + log ${gb(report.walBytes)}${big ? `; biggest: ${big}` : ""}. `
      + "Trim a table or grow the disk before it fills — a full disk stops every write.";
  }
  return null;
}

/**
 * THE ONE TRIM (owner, 2026-09-30: "DO IT").
 *
 * An `insufficient_coverage` decision is a workup where fewer than three analyst seats
 * returned, so there is no panel judgement in it. Every measurement the desk makes already
 * excludes it (seat-alpha.js, the tutor's scoring arms), and it can never be published — a
 * call comes only from a decided run. Yet each one stores the whole evidence bundle, ~10 KB.
 * With the Anthropic key disabled (a 401 is not an out-of-credit refusal, so the cycle does
 * not halt), the research loop wrote ~19,000 of them a day, and they were most of the
 * 882 MB decision_runs had grown to.
 *
 * So: rows of that outcome, never published, older than `olderThanMs` (a day — the tutor
 * grades at six hours), are deleted with their forward marks and simulated outcome. Nothing
 * else is touched. The walk goes by primary key and reads only the columns stored before
 * the evidence (id, outcome, decided_at), in small batches with a yield between them, so
 * the API never waits on it the way it waited on the page walk. Freed pages stay in the file
 * and are reused by new rows; the file itself only shrinks with a VACUUM.
 */
export const COVERAGE_JUNK_OUTCOME = "insufficient_coverage";

export async function purgeCoverageJunk(db, { olderThanMs = 86_400_000, now = Date.now(), batch = 500,
  maxBatches = 400, yieldFn = () => new Promise((r) => setImmediate(r)) } = {}) {
  const cutoff = now - olderThanMs;
  const have = (t) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(t);
  if (!have("decision_runs")) return { scanned: 0, deleted: 0, batches: 0, reachedCutoff: false };
  const scan = db.prepare("SELECT id, outcome, decided_at FROM decision_runs WHERE id > ? ORDER BY id LIMIT ?");
  const delMarks = db.prepare("DELETE FROM forward_marks WHERE run_id = ?");
  const delSim = db.prepare("DELETE FROM simulated_outcomes WHERE run_id = ?");
  const delRun = db.prepare("DELETE FROM decision_runs WHERE id = ? AND outcome = ? AND published_call_id IS NULL");
  let after = 0, scanned = 0, deleted = 0, batches = 0, reachedCutoff = false;
  while (batches < maxBatches) {
    const rows = scan.all(after, batch);
    if (!rows.length) break;
    batches++;
    scanned += rows.length;
    after = rows[rows.length - 1].id;
    /* Ids are handed out in time order, so the first row newer than the cutoff ends the walk. */
    const stopAt = rows.findIndex((r) => Number(r.decided_at) >= cutoff);
    const due = (stopAt === -1 ? rows : rows.slice(0, stopAt)).filter((r) => r.outcome === COVERAGE_JUNK_OUTCOME);
    if (due.length) {
      db.exec("BEGIN");
      try {
        for (const r of due) {
          if (delRun.run(r.id, COVERAGE_JUNK_OUTCOME).changes) { delMarks.run(r.id); delSim.run(r.id); deleted++; }
        }
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
    }
    if (stopAt !== -1) { reachedCutoff = true; break; }
    await yieldFn();
  }
  return { scanned, deleted, batches, reachedCutoff };
}

/**
 * The hourly shift: trim, checkpoint, measure, warn. The last report is kept for the endpoint
 * so a public request never walks the file itself.
 */
export function startStorageCare(db, { log = console.log, everyMs = 3_600_000, firstAfterMs = 120_000, purge = {} } = {}) {
  let last = null, lastPurge = null, running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        lastPurge = { atMs: Date.now(), ...(await purgeCoverageJunk(db, purge)) };
        if (lastPurge.deleted) log(`[storage] removed ${lastPurge.deleted} insufficient_coverage decision(s) older than a day (${lastPurge.scanned} scanned)`);
      } catch (error) { lastPurge = { atMs: Date.now(), error: String(error?.message ?? error) }; log(`[storage] trim failed: ${lastPurge.error}`); }
      const cp = checkpoint(db);
      if (cp.error) log(`[storage] checkpoint failed: ${cp.error}`);
      else if (cp.busy) log(`[storage] checkpoint was blocked by a reader (${cp.logPages} log pages); next hour tries again`);
      last = { ...storageReport(db), purge: lastPurge };
      const warn = storageWarning(last);
      if (warn) log(`[storage] WARNING ${warn}`);
    } catch (error) { log(`[storage] ${error?.message ?? error}`); }
    finally { running = false; }
  };
  const first = setTimeout(() => { tick(); }, firstAfterMs);
  const timer = setInterval(() => { tick(); }, everyMs);
  first.unref?.(); timer.unref?.();
  current = {
    tick,
    /** The last hourly report; before the first one, a cheap report without the table walk. */
    report() { return last ?? storageReport(db, { tables: false }); },
    stop() { clearTimeout(first); clearInterval(timer); if (current === this) current = null; },
  };
  return current;
}

let current = null;

/** What GET /api/storage serves: the shift's last report, or a stat-only one when no shift runs. */
export function latestStorageReport(db) {
  return current ? current.report() : storageReport(db, { tables: false });
}
