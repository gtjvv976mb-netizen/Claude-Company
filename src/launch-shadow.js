import db from "./lib/store.js";
import { emit } from "./lib/bus.js";

/**
 * THE LAUNCH SHADOW LOG — validating three new rulers before any of them is trusted.
 *
 * No dev-holding, dev-sold or launch-share computation existed anywhere on this desk
 * (measured 2026-09-08: grep found none), and the one it had that looked at a launch —
 * serial_deployer — reads the creator's history rather than the launch itself. Now
 * data/solana.js reads the creator's own share of supply and whether their account was
 * emptied, and data/pumpfun-live.js reads what the first traded minute carried against
 * the curve's opening SOL (GoatPro: $6,189 on a ~$5k curve). Each is a plausible rug
 * signature. None has been measured against anything.
 *
 * A ruler is validated before it becomes one. The arccos ruler that called every walking
 * mount motionless, and the sample of 24 cards that certified a crop leaking on the 177
 * it never drew, are why: a number is not evidence until it has been run against a case
 * whose answer is already known. Here the known answer is the paid X read — the seat's
 * serial_rugger and manufactured+paid verdicts, the two arms desk.js already kills on —
 * so every PAID workup writes one row with the proxies beside that verdict, and the
 * scorecard reads precision and recall off the rows. A proxy is PROMOTABLE from evidence
 * to a kill only when its precision beats the stated bar over a stated sample; until then
 * it is a number on the bundle for a seat to weigh, and it kills nothing. The scorecard
 * decides nothing either: it reports, and the owner decides whether a promotable proxy
 * is wired as a gate (which would be a separate, registered change to GATE_CLASS).
 *
 * This costs nothing to keep: the read has already been paid for, and the row is the
 * only record of what the proxies said at the moment the verdict came back.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS launch_shadow (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  mint                 TEXT NOT NULL,
  symbol               TEXT,
  recorded_at          INTEGER NOT NULL,
  band                 TEXT,
  age_min              REAL,
  mcap_usd             REAL,
  -- the launch minute (pumpfun-live.momentumFrom)
  launch_vol_share     REAL,
  first_candle_vol_usd REAL,
  ms_after_create      INTEGER,
  curve_open_usd       REAL,
  -- the creator in the book (solana.topHolders)
  dev_pct_of_supply    REAL,
  dev_account_present  INTEGER,
  dev_sold_all         INTEGER,
  -- the deployer profile (pumpfun.deployerProfile)
  prior_launches       INTEGER,
  prior_graduated      INTEGER,
  prior_dead           INTEGER,
  -- the verdict the proxies are judged against (the paid X read)
  xread_verdict        TEXT,
  serial_rugger        INTEGER,
  paid_or_botted       INTEGER,
  dev_handle           TEXT
);
CREATE INDEX IF NOT EXISTS idx_launch_shadow_at ON launch_shadow(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_launch_shadow_mint ON launch_shadow(mint, recorded_at DESC);
`);

const bool = (v) => (v === true ? 1 : v === false ? 0 : null);
const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);

/**
 * One row per paid read: the proxies as they stood, beside the verdict. Called from
 * desk.js the moment the read is back, before anything acts on it. Never throws past its
 * caller's guard; a row that cannot be written is a row missing from a scorecard, not a
 * workup that failed.
 */
export function recordLaunchShadow(ev, read) {
  if (!ev?.mint || !read) return null;
  const h = ev.holders?.ok ? ev.holders : {};
  const m = ev.momentum ?? {};
  const d = ev.deployer?.ok ? ev.deployer : {};
  const row = {
    mint: ev.mint, symbol: ev.symbol ?? ev.pair?.baseSymbol ?? null, recorded_at: Date.now(),
    band: ev.band ?? null,
    age_min: ev.pair?.ageHours != null ? Number((ev.pair.ageHours * 60).toFixed(1)) : null,
    mcap_usd: num(ev.pair?.marketCap ?? ev.pair?.fdv),
    launch_vol_share: num(m.launchVolShare),
    first_candle_vol_usd: num(m.firstCandle?.volUsd),
    ms_after_create: num(m.firstCandle?.msAfterCreate),
    curve_open_usd: num(m.curveOpenUsd),
    dev_pct_of_supply: num(h.devPctOfSupply),
    dev_account_present: bool(h.devAccountPresent),
    dev_sold_all: bool(h.devSoldAll),
    prior_launches: num(d.priorLaunches),
    prior_graduated: num(d.graduated),
    prior_dead: num(d.dead),
    xread_verdict: read.verdict ?? null,
    serial_rugger: bool(read.serial_rugger),
    paid_or_botted: bool(read.paid_or_botted_signs),
    dev_handle: read.dev_handle ?? null,
  };
  db.prepare(`INSERT INTO launch_shadow (${Object.keys(row).join(",")})
              VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  emit("launch:shadow", { mint: row.mint, symbol: row.symbol, launchVolShare: row.launch_vol_share,
    devPctOfSupply: row.dev_pct_of_supply, devSoldAll: h.devSoldAll ?? null,
    verdict: row.xread_verdict, serialRugger: read.serial_rugger ?? null });
  return true;
}

/* THE BAR, STATED. A proxy earns a kill when four of five coins it flags are ones the
   paid read would have killed anyway — at that precision it saves the read's cost on
   the coins it catches and costs at most one wrongly-refused coin in five, against a
   desk whose refusals are graded by the shadow book. Two hundred rows is the sample the
   plan names (about two days of paid reads at the measured 110/day), and ten flagged
   rows is the floor under which precision is one lucky coin. None of these three numbers
   has been tuned on data — there is no data yet; that is what the log is for. */
export const PROMOTION_PRECISION_BAR = 0.8;
export const PROMOTION_MIN_ROWS = 200;
export const PROMOTION_MIN_FLAGGED = 10;

/** The rulers under test, each with the rule it flags on, in the row's own columns. */
export const PROXIES = Object.freeze({
  launch_share: {
    rule: "launchVolShare >= 1 (the launch minute moved more than the curve opened with)",
    measured: (r) => r.launch_vol_share != null,
    flags: (r) => r.launch_vol_share >= 1,
  },
  dev_holding: {
    rule: "devPctOfSupply >= 10",
    measured: (r) => r.dev_pct_of_supply != null,
    flags: (r) => r.dev_pct_of_supply >= 10,
  },
  dev_sold: {
    rule: "devSoldAll === true (funded then emptied inside 30 minutes)",
    measured: (r) => r.dev_sold_all != null,
    flags: (r) => r.dev_sold_all === 1,
  },
  deployer_profile: {
    rule: "priorLaunches >= 3 and none graduated (below the serial_deployer floor of 8)",
    measured: (r) => r.prior_launches != null && r.prior_graduated != null,
    flags: (r) => r.prior_launches >= 3 && r.prior_graduated === 0,
  },
});

/* The positive class: exactly the two arms desk.js ends a workup on. Anything else the
   read says — mixed, organic, no_signal, a manufactured story with no paid signs — is a
   negative for this purpose, because the proxy is being asked whether it can stand in
   for a KILL, not for an opinion. */
export const positiveVerdict = (r) =>
  r.serial_rugger === 1 || (r.xread_verdict === "manufactured" && r.paid_or_botted === 1);
const verdictKnown = (r) => r.xread_verdict != null || r.serial_rugger != null;

/**
 * Precision and recall of every proxy against the paid read, over the rows where the
 * proxy was actually measured and the read actually answered. Pure reporting.
 */
export function proxyScorecard({ sinceH = 24 * 30, bar = PROMOTION_PRECISION_BAR,
  minRows = PROMOTION_MIN_ROWS, minFlagged = PROMOTION_MIN_FLAGGED } = {}) {
  const rows = db.prepare("SELECT * FROM launch_shadow WHERE recorded_at > ? ORDER BY id")
    .all(Date.now() - sinceH * 3600e3).filter(verdictKnown);
  const positives = rows.filter(positiveVerdict).length;
  const proxies = {};
  for (const [name, p] of Object.entries(PROXIES)) {
    const measured = rows.filter(p.measured);
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of measured) {
      const flagged = p.flags(r), pos = positiveVerdict(r);
      if (flagged && pos) tp++; else if (flagged && !pos) fp++; else if (!flagged && pos) fn++; else tn++;
    }
    const flagged = tp + fp;
    const precision = flagged ? tp / flagged : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const enoughRows = measured.length >= minRows;
    const enoughFlags = flagged >= minFlagged;
    const promotable = enoughRows && enoughFlags && precision != null && precision >= bar;
    proxies[name] = {
      rule: p.rule, n: measured.length, flagged, tp, fp, fn, tn,
      precision: precision == null ? null : Number(precision.toFixed(3)),
      recall: recall == null ? null : Number(recall.toFixed(3)),
      promotable,
      why: promotable
        ? `precision ${precision.toFixed(3)} >= ${bar} over ${measured.length} rows (${flagged} flagged) — promotable to a kill, pending the owner`
        : !enoughRows ? `${measured.length} of ${minRows} rows measured — not enough sample to judge`
          : !enoughFlags ? `${flagged} of ${minFlagged} flagged rows — precision would be a handful of coins`
            : `precision ${precision.toFixed(3)} < ${bar} — evidence only; it kills nothing`,
    };
  }
  return { rows: rows.length, positives, bar, minRows, minFlagged, proxies };
}

/** Test seam. */
export function _reset() { db.exec("DELETE FROM launch_shadow"); }
