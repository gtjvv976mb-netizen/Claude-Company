/**
 * THE WATCHLIST — where a WATCH goes to live instead of to die.
 *
 * For the desk's whole life, "WATCH" was a verdict that terminated nowhere: the
 * PM wrote promotion triggers in prose, the report filed them, and no code ever
 * read them again. The building's first tenants waited under a desk whose most
 * common non-refusal outcome was a note to itself. houseCalls: 0.
 *
 * Now a WATCH is a standing order. The PM must state machine-checkable rules
 * (price above X, hourly buys at least Y, liquidity at least Z, for H hours);
 * a free deterministic checker re-reads the market every few minutes; and the
 * moment every rule holds, the token goes BACK through the full paid pipeline —
 * analysts, red team, risk, PM, compliance, CEO — with the watch's own context
 * attached. Promotion buys a re-examination, never a shortcut past the gauntlet.
 */
import db, { ensureColumn } from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { pairsFor, shapePair, consensus } from "./data/dexscreener.js";

db.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  category    TEXT,
  rules       TEXT NOT NULL,          -- JSON: {price_above_usd, buys_h1_at_least, liq_at_least_usd}
  note        TEXT,                   -- the PM's prose triggers, for humans
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'watching',  -- watching | promoted | expired | superseded
  held_count  INTEGER NOT NULL DEFAULT 0,        -- consecutive checks the rules have held
  last_checked INTEGER,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist(status, expires_at);
`);
// Production's table predates the debounce column; CREATE TABLE IF NOT EXISTS
// is not a migration.
ensureColumn("watchlist", "held_count", "INTEGER NOT NULL DEFAULT 0");

/** One live watch per mint: a fresh WATCH verdict replaces the old one. */
export function addWatch({ mint, symbol, category, rules, note }) {
  const hours = Math.min(72, Math.max(1, Number(rules?.hours) || 24));
  const clean = {
    price_above_usd: rules?.price_above_usd ?? null,
    buys_h1_at_least: rules?.buys_h1_at_least ?? null,
    liq_at_least_usd: rules?.liq_at_least_usd ?? null,
  };
  if (Object.values(clean).every((v) => v == null)) return { ok: false, error: "no checkable rule" };
  db.prepare("UPDATE watchlist SET status='superseded', resolved_at=? WHERE mint=? AND status='watching'")
    .run(Date.now(), mint);
  const r = db.prepare(`INSERT INTO watchlist (mint,symbol,category,rules,note,created_at,expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(mint, symbol ?? null, category ?? null, JSON.stringify(clean), note ?? null,
         Date.now(), Date.now() + hours * 3600e3);
  emit("watch:opened", { mint, symbol, rules: clean, hours });
  return { ok: true, id: r.lastInsertRowid };
}

export const watching = () =>
  db.prepare("SELECT * FROM watchlist WHERE status='watching' ORDER BY id").all();

/**
 * The free pass over the list. Reads the market once per watch, expires the
 * stale, and returns the rows whose every non-null rule now holds. Marking
 * happens HERE (promoted), so a crashed workup later never re-promotes in a
 * loop — the caller owns what to do with the promotion.
 */
export async function checkWatchlist() {
  const rows = watching();
  if (!rows.length) return { checked: 0, promoted: [] };
  const promoted = [];
  for (const w of rows) {
    if (Date.now() > w.expires_at) {
      db.prepare("UPDATE watchlist SET status='expired', resolved_at=? WHERE id=?").run(Date.now(), w.id);
      emit("watch:expired", { mint: w.mint, symbol: w.symbol });
      continue;
    }
    // Consensus pricing, not pairs[0] — a fake deep pool quoting 5,000x would
    // otherwise false-promote the watch and burn a paid workup every pass.
    let px = null, deep = null;
    try {
      const ps = await pairsFor(w.mint);
      const c = ps.ok ? consensus(ps.pairs) : null;
      if (c?.ok) { px = c; deep = shapePair(c.deepest); }
    } catch { /* an unreadable market never expires or promotes a watch */ }
    db.prepare("UPDATE watchlist SET last_checked=? WHERE id=?").run(Date.now(), w.id);
    if (!px || !deep) continue;

    const rules = JSON.parse(w.rules);
    const held =
      (rules.price_above_usd == null || (px.priceUsd ?? 0) > rules.price_above_usd) &&
      (rules.buys_h1_at_least == null || (deep.txns?.h1?.buys ?? 0) >= rules.buys_h1_at_least) &&
      (rules.liq_at_least_usd == null || (px.liquidityUsd ?? 0) >= rules.liq_at_least_usd);
    // The warp-id debounce: rules must hold on TWO consecutive checks before we
    // pay for a promotion — a single flash pattern is how false positives look.
    if (held) {
      const count = (w.held_count ?? 0) + 1;
      if (count >= 2) {
        db.prepare("UPDATE watchlist SET status='promoted', held_count=?, resolved_at=? WHERE id=?")
          .run(count, Date.now(), w.id);
        emit("watch:promoted", { mint: w.mint, symbol: w.symbol, rules,
          now: { priceUsd: px.priceUsd, buysH1: deep.txns?.h1?.buys ?? 0, liqUsd: px.liquidityUsd } });
        promoted.push({ ...w, rules });
      } else {
        db.prepare("UPDATE watchlist SET held_count=? WHERE id=?").run(count, w.id);
        emit("watch:holding", { mint: w.mint, symbol: w.symbol, consecutive: count });
      }
    } else if (w.held_count) {
      db.prepare("UPDATE watchlist SET held_count=0 WHERE id=?").run(w.id);
    }
  }
  return { checked: rows.length, promoted };
}
