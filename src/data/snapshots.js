/**
 * THE SNAPSHOT LEDGER — the market as this desk actually saw it, kept.
 *
 * The research pass found five separate high-grade mechanisms blocked on one
 * missing primitive: we consumed DexScreener's rolling deltas and threw the
 * history away. This table keeps a 5-minute observation per tracked mint —
 * price, liquidity, volume, participation — written by every sweep, pruned to
 * seven days. It is what makes possible:
 *   - the post-migration dead-zone ratio (price now vs price at first sighting;
 *     73% of graduates trade below 0.4x migration price within 20 minutes, so
 *     the first sighting is structurally near the worst entry),
 *   - the liquidity floor as a 24h MINIMUM rather than a snapshot rugs can
 *     pose for (median rug liquidity: $2,832),
 *   - realized-volatility sizing and trailing-return terms, later.
 */
import db from "../lib/store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  mint  TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  price REAL, liq REAL, vol24 REAL, buys INTEGER, sells INTEGER, fdv REAL,
  PRIMARY KEY (mint, ts)
);
CREATE INDEX IF NOT EXISTS idx_snap_mint ON snapshots(mint, ts);
`);

const ins = db.prepare(`INSERT OR IGNORE INTO snapshots (mint,ts,price,liq,vol24,buys,sells,fdv)
                        VALUES (?,?,?,?,?,?,?,?)`);

/** One row per coin per sweep. Cheap by design: ~350 rows every 5 minutes. */
export function record(universe) {
  const ts = Date.now();
  let n = 0;
  for (const c of universe) {
    const p = c.pair;
    if (!c.mint || !p) continue;
    ins.run(c.mint, ts, p.priceUsd ?? null, p.liquidityUsd ?? null, p.volume?.h24 ?? null,
      p.txns?.h24?.buys ?? null, p.txns?.h24?.sells ?? null, p.fdv ?? null);
    n++;
  }
  return n;
}

/** The earliest sighting at or after a moment — "what price did WE first see". */
export const firstSince = (mint, sinceTs) =>
  db.prepare("SELECT ts, price FROM snapshots WHERE mint=? AND ts>=? AND price IS NOT NULL ORDER BY ts LIMIT 1")
    .get(mint, sinceTs) ?? null;

/** The liquidity floor actually HELD over a window, and how well we observed it. */
export function liqOver(mint, sinceTs) {
  const r = db.prepare("SELECT MIN(liq) lo, COUNT(*) n FROM snapshots WHERE mint=? AND ts>=? AND liq IS NOT NULL")
    .get(mint, sinceTs);
  return { minLiq: r?.lo ?? null, observations: r?.n ?? 0 };
}

/** Keep the 5-minute series seven days; the daily story lives in the calls themselves. */
export const prune = () =>
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(Date.now() - 7 * 86400e3).changes;
