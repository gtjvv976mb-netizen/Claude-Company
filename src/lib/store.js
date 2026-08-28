import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ROOT } from "../config.js";

// CLAUDE_CO_DB lets tests run against a throwaway file instead of the live journal.
const db = new DatabaseSync(process.env.CLAUDE_CO_DB || path.join(ROOT, "claude-co.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS seen (
  mint TEXT PRIMARY KEY, symbol TEXT, first_seen INTEGER, last_seen INTEGER, looks INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cycle TEXT, mint TEXT, symbol TEXT, seat TEXT,
  verdict TEXT, score REAL, confidence REAL, killed INTEGER, reason TEXT, json TEXT, ts INTEGER
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cycle TEXT, mint TEXT, symbol TEXT, ts INTEGER,
  decision TEXT, conviction REAL, thesis TEXT, invalidation TEXT,
  entry_lo REAL, entry_hi REAL, stop REAL, size_usd REAL, risk_usd REAL,
  ticket TEXT, status TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER, ts INTEGER, price REAL,
  pnl_pct REAL, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_verdicts_mint ON verdicts(mint);
CREATE INDEX IF NOT EXISTS idx_proposals_mint ON proposals(mint);
`);

export function touchSeen(mint, symbol) {
  const now = Date.now();
  const row = db.prepare("SELECT mint, looks FROM seen WHERE mint=?").get(mint);
  if (row) db.prepare("UPDATE seen SET last_seen=?, looks=looks+1, symbol=? WHERE mint=?").run(now, symbol, mint);
  else db.prepare("INSERT INTO seen (mint,symbol,first_seen,last_seen,looks) VALUES (?,?,?,?,1)").run(mint, symbol, now, now);
}

/** Was this mint killed recently, and why? Stops the desk paying to rediscover trash. */
export function recentKill(mint, withinMs = 12 * 3600 * 1000) {
  const row = db.prepare(
    "SELECT seat, reason, ts FROM verdicts WHERE mint=? AND killed=1 AND ts > ? ORDER BY ts DESC LIMIT 1"
  ).get(mint, Date.now() - withinMs);
  return row || null;
}

export function recordVerdict(cycle, mint, symbol, seat, v) {
  db.prepare(
    `INSERT INTO verdicts (cycle,mint,symbol,seat,verdict,score,confidence,killed,reason,json,ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    cycle, mint, symbol, seat,
    v.verdict ?? null, v.score ?? null, v.confidence ?? null,
    v.kill ? 1 : 0, v.kill_reason ?? null, JSON.stringify(v), Date.now()
  );
}

export function recordProposal(cycle, c, pm, risk, ticket) {
  const info = db.prepare(
    `INSERT INTO proposals (cycle,mint,symbol,ts,decision,conviction,thesis,invalidation,
       entry_lo,entry_hi,stop,size_usd,risk_usd,ticket)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    cycle, c.mint, c.symbol, Date.now(), pm.decision, pm.conviction, pm.thesis, pm.invalidation,
    ticket?.entry_zone_low ?? null, ticket?.entry_zone_high ?? null, ticket?.stop_price ?? null,
    risk?.position_size_usd ?? null, risk?.max_loss_usd ?? null, JSON.stringify(ticket ?? {})
  );
  return info.lastInsertRowid;
}

export function openProposals() {
  return db.prepare("SELECT * FROM proposals WHERE status='open' ORDER BY ts DESC").all();
}

export function ledger(limit = 50) {
  return db.prepare("SELECT * FROM proposals ORDER BY ts DESC LIMIT ?").all(limit);
}

export function stats() {
  const p = db.prepare("SELECT COUNT(*) n FROM proposals").get().n;
  const byDecision = db.prepare("SELECT decision, COUNT(*) n FROM proposals GROUP BY decision").all();
  const kills = db.prepare("SELECT seat, COUNT(*) n FROM verdicts WHERE killed=1 GROUP BY seat ORDER BY n DESC").all();
  const looked = db.prepare("SELECT COUNT(*) n FROM seen").get().n;
  return { proposals: p, byDecision, kills, tokensSeen: looked };
}

/**
 * CREATE TABLE IF NOT EXISTS is not a migration. On a database that already has the
 * table, a changed schema is silently ignored and the new column simply is not there —
 * which reads at runtime as `undefined`, not as an error. Production databases are
 * always the old shape, so every added column needs this.
 */
export function ensureColumn(table, column, decl, backfillFrom = null) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.length || cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  if (backfillFrom && cols.includes(backfillFrom)) {
    db.exec(`UPDATE ${table} SET ${column} = ${backfillFrom} WHERE ${column} IS NULL`);
  }
  return true;
}

export default db;
