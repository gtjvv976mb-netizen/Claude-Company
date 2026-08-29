import db from "./store.js";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which floor is this work being done for? Carried in async context rather than threaded
 * through every emit() call in the pipeline, so the desk code stays unaware of tenancy
 * and one tenant's research can never be mislabelled as another's.
 */
export const runContext = new AsyncLocalStorage();
export const runFor = (floor, fn) => runContext.run({ floor }, fn);

// The desk narrates itself. The office view subscribes to this and turns each
// event into a person walking somewhere and doing something.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

db.exec(`
CREATE TABLE IF NOT EXISTS chronicle (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  floor INTEGER,
  type  TEXT NOT NULL,
  data  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chronicle_ts ON chronicle(id DESC);
CREATE INDEX IF NOT EXISTS idx_chronicle_floor ON chronicle(floor, id DESC);
`);

const RING = [];
const RING_MAX = 400;

// A restart used to blank every room: the ring was memory, so the backlog a new
// viewer received was empty until something happened. The chronicle is the ring's
// durable twin — rehydrate the tail so the office wakes up remembering its morning.
try {
  const tail = db.prepare("SELECT data FROM chronicle ORDER BY id DESC LIMIT ?").all(RING_MAX);
  for (let i = tail.length - 1; i >= 0; i--) {
    try { RING.push(JSON.parse(tail[i].data)); } catch {}
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
  const floor = runContext.getStore()?.floor ?? null;
  const ev = { type, ts: Date.now(), ...(floor != null ? { floor } : {}), ...payload };
  RING.push(ev);
  if (RING.length > RING_MAX) RING.shift();
  try {
    db.prepare("INSERT INTO chronicle (ts, floor, type, data) VALUES (?,?,?,?)")
      .run(ev.ts, ev.floor ?? null, type, JSON.stringify(ev));
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
