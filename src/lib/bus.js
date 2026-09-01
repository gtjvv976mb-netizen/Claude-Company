import db, { ensureColumn } from "./store.js";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which floor is this work being done for? Carried in async context rather than threaded
 * through every emit() call in the pipeline, so the desk code stays unaware of tenancy
 * and one tenant's research can never be mislabelled as another's.
 */
export const runContext = new AsyncLocalStorage();
export const runFor = (floor, fn) => runContext.run({ floor }, fn);
export const runForEvidence = ({ floor = null, evidenceScope = "unattributed" }, fn) =>
  runContext.run({ floor, evidenceScope }, fn);

// The desk narrates itself. The office view subscribes to this and turns each
// event into a person walking somewhere and doing something.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

db.exec(`
CREATE TABLE IF NOT EXISTS chronicle (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  floor INTEGER,
  floor_attributed INTEGER NOT NULL DEFAULT 0,
  evidence_scope TEXT NOT NULL DEFAULT 'unattributed',
  type  TEXT NOT NULL,
  data  TEXT NOT NULL
);
-- Named _ts but keyed on id: every reader pages by id, so the name is a trap rather
-- than a bug. Left in place because dropping it would rewrite the table on boot.
CREATE INDEX IF NOT EXISTS idx_chronicle_ts ON chronicle(id DESC);
CREATE INDEX IF NOT EXISTS idx_chronicle_floor ON chronicle(floor, id DESC);
-- The diagnostics DO filter by (type, ts) — "why was nothing published", "how did
-- cycles end". Measured on a full 200,000-row chronicle those queries cost 37ms
-- scanning and 30ms with this index: worth having, but far too cheap to have been
-- behind any outage, which is the claim it was briefly asked to support.
CREATE INDEX IF NOT EXISTS idx_chronicle_type_ts ON chronicle(type, ts);
`);
ensureColumn("chronicle", "floor_attributed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("chronicle", "evidence_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_chronicle_provenance
         ON chronicle(floor_attributed,evidence_scope,type,ts)`);

const RING = [];
const RING_MAX = 400;

// A restart used to blank every room: the ring was memory, so the backlog a new
// viewer received was empty until something happened. The chronicle is the ring's
// durable twin — rehydrate the tail so the office wakes up remembering its morning.
//
// SUBSTANCE FIRST. The plain last-400 tail was ~90% world:* scenery (it fires ~10
// times a minute), so after every deploy the rooms "remembered" weather and forgot
// work — each restart visibly reset the tabs to a noise-dominated slice while the
// real history sat safe in the chronicle. Rehydrate the pipeline's events to near
// the full ring, with only a garnish of ambience so a fresh room still breathes.
try {
  const WORLD_SLOTS = 40;
  const substance = db.prepare(
    "SELECT id, data FROM chronicle WHERE type NOT LIKE 'world:%' ORDER BY id DESC LIMIT ?")
    .all(RING_MAX - WORLD_SLOTS);
  const ambience = db.prepare(
    "SELECT id, data FROM chronicle WHERE type LIKE 'world:%' ORDER BY id DESC LIMIT ?")
    .all(WORLD_SLOTS);
  const tail = [...substance, ...ambience].sort((x, y) => x.id - y.id);
  for (const row of tail) {
    try { RING.push(JSON.parse(row.data)); } catch {}
  }
} catch {}

/** The permanent record. Everything emit() ever said, queryable. */
export function chronicleRead({ floor = null, since = 0, before = 0, limit = 200, type = null, exclude = null } = {}) {
  limit = Math.min(500, Math.max(1, limit | 0));
  const conds = ["id > ?"]; const args = [since | 0];
  if (before > 0) { conds.push("id < ?"); args.push(before | 0); }
  if (exclude) { conds.push("type NOT LIKE ?"); args.push(String(exclude).slice(0, 40) + "%"); }
  if (floor != null) { conds.push("(floor IS NULL OR floor = ?)"); args.push(floor); }
  if (type) { conds.push("type LIKE ?"); args.push(String(type).slice(0, 40) + "%"); }
  const rows = db.prepare(
    `SELECT id, data FROM chronicle WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit);
  return rows.map((r) => { try { return { id: r.id, ...JSON.parse(r.data) }; } catch { return null; } })
    .filter(Boolean).reverse();
}

/** Two-tier retention. Ambience (world:*) is scenery and expires fast, or it would
 * drown the record — at ~10 events a minute it alone is ~14k rows a day. The
 * pipeline's history keeps the long horizon; that is the part that must survive
 * "no matter how long". */
export function chroniclePrune(keep = 200_000, keepWorld = 5_000) {
  try {
    db.prepare(`DELETE FROM chronicle WHERE type LIKE 'world:%' AND id <=
      (SELECT COALESCE(MAX(id),0) FROM chronicle WHERE type LIKE 'world:%') - ?`).run(keepWorld);
    db.prepare("DELETE FROM chronicle WHERE id <= (SELECT COALESCE(MAX(id),0) FROM chronicle) - ?").run(keep);
  } catch {}
}

export function emit(type, payload = {}) {
  const context = runContext.getStore();
  // Older floor-specific producers use floorNo while the room stream uses floor.
  // Canonicalize both before persistence/backlog filtering; otherwise a tenant fill,
  // result, or alert becomes a floorless house event visible to every room.
  const payloadFloor = Number.isInteger(payload?.floor) ? payload.floor
    : Number.isInteger(payload?.floorNo) ? payload.floorNo : null;
  // A destination-specific alert/fill/result may be emitted while a house publication
  // context is still alive, so its explicit floor outranks the producer's run context.
  // Generic stage events carry no floor and correctly inherit the run instead.
  const floor = payloadFloor ?? context?.floor ?? null;
  const evidenceScope = payloadFloor != null
    ? (Number(floor) === 50 ? "house" : "tenant")
    : context?.evidenceScope ?? (floor == null || Number(floor) === 50 ? "house" : "tenant");
  const { floor: _ignoredFloor, ...rest } = payload || {};
  const ev = { type, ts: Date.now(), ...rest, ...(floor != null ? { floor } : {}) };
  RING.push(ev);
  if (RING.length > RING_MAX) RING.shift();
  try {
    /* THE LIVE EVENT CARRIES ITS CHRONICLE ID. Without it a reconnecting client has
     * no way to tell what it already displayed: the gap-fill asked for everything
     * since its last CHRONICLE mark, which never advanced during live streaming, so
     * every reconnect re-appended hours of already-shown rows as if they were new.
     * The id is the shared key that makes the client's `e.id <= newestChron` skip
     * work. Stamped after the insert (that is when it exists) and before the stream
     * sees it. */
    const info = db.prepare(`INSERT INTO chronicle
      (ts,floor,floor_attributed,evidence_scope,type,data) VALUES (?,?,1,?,?,?)`)
      .run(ev.ts, ev.floor ?? null, evidenceScope, type, JSON.stringify(ev));
    ev.id = Number(info.lastInsertRowid);
  } catch {}                       // the record must never break the live stream
  bus.emit("event", ev);
  return ev;
}

export function backlog(floor = null) {
  // A room replays the house desk's recent work plus its own — which is what makes the
  // building feel alive to someone who just walked in, rather than empty until the next
  // event happens to fire.
  return floor == null ? RING.slice() : RING.filter((e) => e.floor == null || e.floor === floor);
}
