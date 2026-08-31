import db, { ensureColumn } from "./lib/store.js";
import { cfg } from "./config.js";
import { leaveOneOut } from "./agents/composite.js";
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "../executor/trade-policy.mjs";
export { POLICY_VERSION } from "../executor/trade-policy.mjs";

export const EVALUATION_VERSION = "2026-08-31.2";
export const PROMPT_VERSION = "desk-2026-08-31";
export const HORIZONS_MIN = [15, 60, 360, 1440, 2880];

db.exec(`
CREATE TABLE IF NOT EXISTS decision_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key            TEXT NOT NULL UNIQUE,
  cycle              TEXT NOT NULL,
  mint               TEXT NOT NULL,
  symbol             TEXT,
  run_kind           TEXT NOT NULL DEFAULT 'workup',
  decided_at         INTEGER NOT NULL,
  entry_price        REAL,
  round_trip_cost_pct REAL,
  size_usd           REAL,
  outcome            TEXT,
  final_decision     TEXT,
  binding_gate       TEXT,
  raw_redteam        TEXT,
  effective_redteam  TEXT,
  redteam_binding    INTEGER NOT NULL DEFAULT 0,
  evaluation_version TEXT NOT NULL,
  policy_version     TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  models_json        TEXT NOT NULL,
  config_json        TEXT NOT NULL,
  weights_json       TEXT NOT NULL,
  attribution_json   TEXT,
  record_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_runs_mint ON decision_runs(mint, decided_at);

CREATE TABLE IF NOT EXISTS forward_marks (
  run_id          INTEGER NOT NULL REFERENCES decision_runs(id),
  horizon_min     INTEGER NOT NULL,
  due_at          INTEGER NOT NULL,
  observed_at     INTEGER,
  price_mid       REAL,
  liquidity_usd   REAL,
  mark_method     TEXT,
  gross_return_pct REAL,
  net_return_pct  REAL,
  mae_pct         REAL,
  mfe_pct         REAL,
  data_status     TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (run_id, horizon_min)
);
CREATE INDEX IF NOT EXISTS idx_forward_marks_due ON forward_marks(data_status, due_at);

CREATE TABLE IF NOT EXISTS simulated_outcomes (
  run_id          INTEGER PRIMARY KEY REFERENCES decision_runs(id),
  policy_version  TEXT NOT NULL,
  observed_at     INTEGER,
  exit_price      REAL,
  exit_reason     TEXT,
  gross_return_pct REAL,
  net_return_pct  REAL,
  pnl_usd         REAL,
  mae_pct         REAL,
  mfe_pct         REAL,
  data_status     TEXT NOT NULL
);
`);

// These are cheap forward-only migrations if an evaluation database was created by
// an earlier pre-release build.
ensureColumn("decision_runs", "run_kind", "TEXT NOT NULL DEFAULT 'workup'");
ensureColumn("decision_runs", "prompt_version", `TEXT NOT NULL DEFAULT '${PROMPT_VERSION}'`);
ensureColumn("decision_runs", "models_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("decision_runs", "config_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("forward_marks", "liquidity_usd", "REAL");
ensureColumn("forward_marks", "mark_method", "TEXT");

const recordedConfig = () => ({
  equityUsd: cfg.equityUsd,
  maxRiskPct: cfg.maxRiskPct,
  maxBookRiskPct: cfg.maxBookRiskPct,
  targetSizeUsd: cfg.targetSizeUsd,
  maxRoundTripSlippagePct: cfg.maxRoundTripSlippagePct,
  screen: cfg.screen,
});

function gateFor(rec) {
  if (!rec) return "missing_record";
  if (rec.outcome === "no_data" || rec.outcome === "screened_out" || rec.outcome === "insufficient_coverage") return rec.outcome;
  if (rec.outcome === "killed") return `analyst:${rec.killedBy || "unknown"}`;
  if (rec.compliance?.pass === false) return "compliance";
  if (rec.redteam?.verdict === "refuted" && rec.pm?.decision !== "PROPOSE") return "redteam";
  if (rec.pm?.decision === "PASS") return "pm";
  if (rec.finalDecision === "DECLINED") return "ceo";
  return rec.finalDecision || rec.pm?.decision || rec.outcome || "unknown";
}

/** Immutable signal-level journal. One research run remains one observation no matter
 * how many tenants later copy it. */
export function recordDecision(cycle, rec, now = Date.now()) {
  if (!rec?.mint) return null;
  const runKey = `${cycle}:${rec.mint}`;
  const rawRt = rec.redteamRaw?.verdict ?? rec.redteam?.downgraded_from ?? rec.redteam?.verdict ?? null;
  const effectiveRt = rec.redteam?.verdict ?? null;
  const gate = gateFor(rec);
  const attr = leaveOneOut(rec.analysts || {});
  const info = db.prepare(`INSERT OR IGNORE INTO decision_runs
    (run_key,cycle,mint,symbol,run_kind,decided_at,entry_price,round_trip_cost_pct,size_usd,outcome,
     final_decision,binding_gate,raw_redteam,effective_redteam,redteam_binding,
     evaluation_version,policy_version,prompt_version,models_json,config_json,
     weights_json,attribution_json,record_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runKey, cycle, rec.mint, rec.symbol ?? rec.ev?.symbol ?? null,
      rec.runKind ?? rec.hook ?? "workup", now,
      rec.ev?.pair?.priceUsd ?? null, rec.ev?.exitProbe?.roundTripLossPct ?? null,
      rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd ?? null,
      rec.outcome ?? null, rec.finalDecision ?? null, gate, rawRt, effectiveRt,
      gate === "redteam" ? 1 : 0, EVALUATION_VERSION, POLICY_VERSION, PROMPT_VERSION,
      JSON.stringify(cfg.models), JSON.stringify(recordedConfig()),
      JSON.stringify(cfg.weights), JSON.stringify(attr), JSON.stringify(rec));
  const row = db.prepare("SELECT id, entry_price FROM decision_runs WHERE run_key=?").get(runKey);
  if (!row) return null;
  for (const h of HORIZONS_MIN) {
    db.prepare(`INSERT OR IGNORE INTO forward_marks (run_id,horizon_min,due_at)
                VALUES (?,?,?)`).run(row.id, h, now + h * 60000);
  }
  return row.id;
}

/** Called by each free market sweep. A mark is never allowed to precede its horizon. */
export function refreshForwardMarks(universe, now = Date.now()) {
  const byMint = new Map((universe || []).map((c) => [c.mint, c]));
  const due = db.prepare(`SELECT m.*, r.mint, r.entry_price, r.round_trip_cost_pct, r.decided_at
                          FROM forward_marks m JOIN decision_runs r ON r.id=m.run_id
                          WHERE m.data_status='pending' AND m.due_at<=?
                          ORDER BY m.due_at LIMIT 500`).all(now);
  let marked = 0, unavailable = 0;
  for (const m of due) {
    const market = byMint.get(m.mint);
    const px = market?.pair?.priceUsd ?? null;
    if (!(px > 0) || !(m.entry_price > 0)) {
      const grace = Math.max(30, Math.min(360, m.horizon_min)) * 60000;
      if (now < m.due_at + grace) continue;
      db.prepare(`UPDATE forward_marks SET observed_at=?,data_status='unavailable'
                  WHERE run_id=? AND horizon_min=? AND data_status='pending'`)
        .run(now, m.run_id, m.horizon_min);
      unavailable++;
      continue;
    }
    const gross = ((px - m.entry_price) / m.entry_price) * 100;
    const net = gross - Math.max(0, Number(m.round_trip_cost_pct) || 0);
    let lo = null, hi = null;
    try {
      const range = db.prepare(`SELECT MIN(price) lo, MAX(price) hi FROM snapshots
                                WHERE mint=? AND ts>=? AND ts<=? AND price>0`)
        .get(m.mint, m.decided_at, now);
      lo = range?.lo; hi = range?.hi;
    } catch {}
    const mae = lo > 0 ? ((lo - m.entry_price) / m.entry_price) * 100 : null;
    const mfe = hi > 0 ? ((hi - m.entry_price) / m.entry_price) * 100 : null;
    const liq = market?.pairs?.totalLiquidityUsd ?? market?.pair?.liquidityUsd ?? null;
    db.prepare(`UPDATE forward_marks SET observed_at=?,price_mid=?,liquidity_usd=?,mark_method=?,
                gross_return_pct=?,net_return_pct=?,mae_pct=?,mfe_pct=?,data_status='observed'
                WHERE run_id=? AND horizon_min=? AND data_status='pending'`)
      .run(now, px, liq, "midpoint_less_entry_roundtrip_cost", gross, net, mae, mfe,
        m.run_id, m.horizon_min);
    marked++;
  }
  return { due: due.length, marked, unavailable, replay: refreshSimulatedOutcomes(now) };
}

/** Replay the exact versioned server/executor policy over observations that arrived
 * after the decision. This grades refusals as counterfactuals in the same units as
 * approvals and never manufactures an exit when the token disappeared. */
export function refreshSimulatedOutcomes(now = Date.now()) {
  const pending = db.prepare(`SELECT r.* FROM decision_runs r
    LEFT JOIN simulated_outcomes o ON o.run_id=r.id
    WHERE o.run_id IS NULL ORDER BY r.id LIMIT 500`).all();
  const insert = db.prepare(`INSERT OR IGNORE INTO simulated_outcomes
    (run_id,policy_version,observed_at,exit_price,exit_reason,gross_return_pct,
     net_return_pct,pnl_usd,mae_pct,mfe_pct,data_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let observed = 0, unavailable = 0, waiting = 0;

  for (const run of pending) {
    if (!(run.entry_price > 0)) {
      insert.run(run.id, POLICY_VERSION, now, null, "no entry mark", null, null, null, null, null, "unavailable");
      unavailable++;
      continue;
    }
    let rec = null;
    try { rec = JSON.parse(run.record_json); } catch {}
    const stop = Number(rec?.ticket?.stop_price ?? rec?.risk?.stop_price);
    const target = Number(rec?.ticket?.take_profit?.[0]?.price);
    if (!(stop > 0) || stop >= run.entry_price) {
      insert.run(run.id, POLICY_VERSION, now, null, "no replayable stop", null, null, null, null, null, "unmanageable");
      unavailable++;
      continue;
    }
    let points = [];
    try {
      points = db.prepare(`SELECT ts,price FROM snapshots
        WHERE mint=? AND ts>=? AND price>0 ORDER BY ts`).all(run.mint, run.decided_at);
    } catch { /* the snapshot module may not have initialized yet */ }
    if (!points.length) {
      if (now >= run.decided_at + (POLICY_DEFAULTS.maxAgeHours + 6) * 3600e3) {
        insert.run(run.id, POLICY_VERSION, now, null, "no post-decision observations",
          null, null, null, null, null, "unavailable");
        unavailable++;
      } else waiting++;
      continue;
    }

    let position = { entry: run.entry_price, stop, target: target > 0 ? target : null,
      high: run.entry_price, openedAtMs: run.decided_at };
    let lo = run.entry_price, hi = run.entry_price, outcome = null;
    for (const point of points) {
      lo = Math.min(lo, point.price); hi = Math.max(hi, point.price);
      const d = pricePolicy({ position, mark: point.price, nowMs: point.ts });
      position = d.position;
      if (d.action === "sell") { outcome = { ...d, point }; break; }
    }
    if (!outcome) {
      const last = points[points.length - 1];
      if (now >= run.decided_at + (POLICY_DEFAULTS.maxAgeHours + 6) * 3600e3 &&
          last.ts < run.decided_at + POLICY_DEFAULTS.maxAgeHours * 3600e3) {
        insert.run(run.id, POLICY_VERSION, now, null, "observations ended before policy expiry",
          null, null, null,
          ((lo - run.entry_price) / run.entry_price) * 100,
          ((hi - run.entry_price) / run.entry_price) * 100, "unavailable");
        unavailable++;
      } else waiting++;
      continue;
    }

    const gross = ((outcome.point.price - run.entry_price) / run.entry_price) * 100;
    const net = gross - Math.max(0, Number(run.round_trip_cost_pct) || 0);
    const pnl = Number(run.size_usd) > 0 ? Number(run.size_usd) * net / 100 : null;
    insert.run(run.id, POLICY_VERSION, outcome.point.ts, outcome.point.price, outcome.reason,
      gross, net, pnl,
      ((lo - run.entry_price) / run.entry_price) * 100,
      ((hi - run.entry_price) / run.entry_price) * 100, "observed");
    observed++;
  }
  return { pending: pending.length, observed, unavailable, waiting };
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function evaluationSummary({ horizonMin = 1440, minSignals = 100 } = {}) {
  const rows = db.prepare(`SELECT r.*,m.net_return_pct,m.mae_pct,m.mfe_pct
                           FROM decision_runs r JOIN forward_marks m ON m.run_id=r.id
                           WHERE m.horizon_min=? AND m.data_status='observed'`)
    .all(horizonMin);
  const returns = rows.map((r) => r.net_return_pct).filter(Number.isFinite);
  const avg = mean(returns);
  const variance = returns.length > 1
    ? returns.reduce((s, x) => s + (x - avg) ** 2, 0) / (returns.length - 1) : null;
  const se = variance != null ? Math.sqrt(variance / returns.length) : null;
  const expectancyLow95 = se != null ? avg - 1.96 * se : null;
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const grossWins = wins.reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
  const rtRows = rows.filter((r) => r.redteam_binding);
  const prevented = rtRows.reduce((s, r) => s + Math.max(0, -r.net_return_pct), 0);
  const killed = rtRows.reduce((s, r) => s + Math.max(0, r.net_return_pct), 0);
  const replayRows = db.prepare(`SELECT r.redteam_binding,o.net_return_pct,o.mae_pct,o.mfe_pct
    FROM simulated_outcomes o JOIN decision_runs r ON r.id=o.run_id
    WHERE o.data_status='observed' AND o.policy_version=?`).all(POLICY_VERSION);
  const replayReturns = replayRows.map((r) => r.net_return_pct).filter(Number.isFinite);
  const replayRt = replayRows.filter((r) => r.redteam_binding);
  const replayPrevented = replayRt.reduce((s, r) => s + Math.max(0, -r.net_return_pct), 0);
  const replayKilled = replayRt.reduce((s, r) => s + Math.max(0, r.net_return_pct), 0);

  return {
    horizonMin, signals: returns.length, wins: wins.length, losses: losses.length,
    hitRatePct: returns.length ? Number((wins.length / returns.length * 100).toFixed(1)) : null,
    expectancyPct: avg == null ? null : Number(avg.toFixed(2)),
    expectancyLow95Pct: expectancyLow95 == null ? null : Number(expectancyLow95.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    avgWinPct: mean(wins) == null ? null : Number(mean(wins).toFixed(2)),
    avgLossPct: mean(losses) == null ? null : Number(mean(losses).toFixed(2)),
    avgMaePct: mean(rows.map((r) => r.mae_pct).filter(Number.isFinite)),
    avgMfePct: mean(rows.map((r) => r.mfe_pct).filter(Number.isFinite)),
    redTeam: { bindingSignals: rtRows.length, lossesPreventedPct: Number(prevented.toFixed(2)),
      winnersKilledPct: Number(killed.toFixed(2)), valuePct: Number((prevented - killed).toFixed(2)) },
    policyReplay: {
      version: POLICY_VERSION,
      signals: replayReturns.length,
      expectancyPct: mean(replayReturns) == null ? null : Number(mean(replayReturns).toFixed(2)),
      avgMaePct: mean(replayRows.map((r) => r.mae_pct).filter(Number.isFinite)),
      avgMfePct: mean(replayRows.map((r) => r.mfe_pct).filter(Number.isFinite)),
      redTeam: { bindingSignals: replayRt.length,
        lossesPreventedPct: Number(replayPrevented.toFixed(2)),
        winnersKilledPct: Number(replayKilled.toFixed(2)),
        valuePct: Number((replayPrevented - replayKilled).toFixed(2)) },
    },
    edgeClaimable: returns.length >= minSignals && expectancyLow95 != null && expectancyLow95 > 0,
    edgeNote: returns.length < minSignals
      ? `${returns.length}/${minSignals} untouched signals — no edge may be claimed`
      : expectancyLow95 > 0 ? "95% lower confidence bound on net expectancy is above zero"
      : "net expectancy has not cleared zero at 95% confidence",
  };
}
