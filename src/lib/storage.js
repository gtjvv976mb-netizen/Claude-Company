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
 *      the disk around it, and the biggest tables by bytes. Aggregates only — table names
 *      and sizes, never a row.
 *   2. A checkpoint that folds the write-ahead log back into the database and truncates it.
 *      SQLite checkpoints on its own, but a busy reader can starve that, and a WAL that is
 *      never reset only grows. Once an hour it is reset on purpose.
 *   3. A warning in the log when the database nears the disk, so the next full disk is a
 *      log line hours ahead instead of a crash loop.
 *
 * Deleting rows is NOT here: which table to trim is a decision for after the report has
 * said which one is big, not a guess made before it.
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
 * What the database is made of, right now. `tables: false` skips the per-table walk, which
 * reads every page of the file and is the only part that costs more than a stat.
 */
export function storageReport(db, { file = resolveDbFile(), tables = true, top = 15, clock = Date.now } = {}) {
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
  if (tables) {
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
    const big = (report.tables || []).slice(0, 3).map((t) => `${t.name} ${gb(t.bytes)}`).join(", ");
    return `disk ${Math.round(report.diskUsedFrac * 100)}% used (${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}); `
      + `database ${gb(report.dbBytes)} + log ${gb(report.walBytes)}${big ? `; biggest: ${big}` : ""}. `
      + "Trim a table or grow the disk before it fills — a full disk stops every write.";
  }
  return null;
}

/**
 * The hourly shift: checkpoint, measure, warn. The last report is kept for the endpoint so a
 * public request never walks the file itself.
 */
export function startStorageCare(db, { log = console.log, everyMs = 3_600_000, firstAfterMs = 120_000 } = {}) {
  let last = null;
  const tick = () => {
    try {
      const cp = checkpoint(db);
      if (cp.error) log(`[storage] checkpoint failed: ${cp.error}`);
      else if (cp.busy) log(`[storage] checkpoint was blocked by a reader (${cp.logPages} log pages); next hour tries again`);
      last = storageReport(db);
      const warn = storageWarning(last);
      if (warn) log(`[storage] WARNING ${warn}`);
    } catch (error) { log(`[storage] ${error?.message ?? error}`); }
  };
  const first = setTimeout(tick, firstAfterMs);
  const timer = setInterval(tick, everyMs);
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
