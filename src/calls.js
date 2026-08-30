import db, { ensureColumn } from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";

/**
 * THE CALL SHEET — what the house team is actually doing.
 *
 * There is ONE trading team, in the penthouse. A floor is a seat that copies it, not a
 * separate team, so this costs the same whether one tenant is watching or fifty.
 *
 * A call is research plus an unsigned ticket. The desk never signs, never sends, never
 * holds a key. "Exit" here means the house has published an exit call — never that
 * anything was sold on anyone's behalf.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mint          TEXT NOT NULL,
  symbol        TEXT,
  category      TEXT,
  launchpad     TEXT,
  status        TEXT NOT NULL DEFAULT 'live',   -- live | closed
  conviction    REAL,
  entry_ref     REAL,          -- the mark when the call was published
  entry_lo      REAL,
  entry_hi      REAL,
  stop          REAL,
  target        REAL,
  thesis        TEXT,
  invalidation  TEXT,
  -- the chain facts as they stood at the call; an exit fires if any of them change
  flags_at_call TEXT,
  liq_at_call   REAL,
  rt_loss_at_call REAL,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER,
  close_reason  TEXT,
  close_mark    REAL,
  report_file   TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_calls_live_mint ON calls(mint) WHERE status='live';

-- Every exit trigger that fired, kept even when a higher-precedence one won, so the
-- record shows what the desk saw rather than only what it acted on.
CREATE TABLE IF NOT EXISTS call_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   INTEGER NOT NULL REFERENCES calls(id),
  kind      TEXT NOT NULL,
  detail    TEXT,
  mark      REAL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_events ON call_events(call_id, id DESC);
`);

ensureColumn("calls", "launchpad", "TEXT");
ensureColumn("calls", "image_url", "TEXT");
// Sea Otter: when the thesis last cleared the screen it was admitted on.
ensureColumn("calls", "last_verified_at", "INTEGER");
// The market cap AT THE CALL, so a tenant's sleeve filter (micro / low / mid) has a
// number to compare against. Without it every floor sees every call regardless of the
// end of the market it asked for.
ensureColumn("calls", "mcap_at_call", "REAL");

export function openCall(c) {
  // Every pump.fun-origin call carries the one invalidation the research pass
  // found casually decisive: the observed profitable snipers' exit rule was
  // "the creator sold". Tenants deserve the same tripwire in writing.
  if (c.mint?.endsWith("pump") && c.invalidation && !/deployer|creator/i.test(c.invalidation)) {
    c = { ...c, invalidation: c.invalidation.replace(/\.?\s*$/, "") + ". Thesis void if the deployer wallet sells." };
  }
  try {
    const info = db.prepare(`
      INSERT INTO calls (mint,symbol,category,launchpad,image_url,conviction,entry_ref,entry_lo,entry_hi,stop,target,
                         thesis,invalidation,flags_at_call,liq_at_call,rt_loss_at_call,mcap_at_call,opened_at,report_file,last_verified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.mint, c.symbol ?? null, c.category ?? null, c.launchpad ?? null, c.imageUrl ?? null, c.conviction ?? null,
      c.entryRef ?? null, c.entryLo ?? null, c.entryHi ?? null, c.stop ?? null, c.target ?? null,
      c.thesis ?? null, c.invalidation ?? null,
      c.flags == null ? null : JSON.stringify(c.flags), c.liqUsd ?? null, c.rtLossPct ?? null, c.mcapUsd ?? null,
      Date.now(), c.reportFile ?? null,
      Date.now());          // last_verified_at — clearing the gauntlet IS the first verification
    const call = getCall(info.lastInsertRowid);
    emit("call:open", { callId: call.id, mint: call.mint, symbol: call.symbol, category: call.category, launchpad: call.launchpad });
    return call;
  } catch (e) {
    // A live call on this mint already exists; the desk does not stack calls on one coin.
    if (/UNIQUE/i.test(String(e.message))) return null;
    throw e;
  }
}

export const getCall = (id) => db.prepare("SELECT * FROM calls WHERE id=?").get(id) || null;
export const liveCalls = () => db.prepare("SELECT * FROM calls WHERE status='live' ORDER BY id DESC").all();
export const recentCalls = (n = 30) => db.prepare("SELECT * FROM calls ORDER BY id DESC LIMIT ?").all(n);
export const liveCallFor = (mint) => db.prepare("SELECT * FROM calls WHERE mint=? AND status='live'").get(mint) || null;

export function noteEvent(callId, kind, detail, mark) {
  db.prepare("INSERT INTO call_events (call_id,kind,detail,mark,ts) VALUES (?,?,?,?,?)")
    .run(callId, kind, detail ?? null, mark ?? null, Date.now());
  emit("call:event", { callId, kind, detail });
}

export function closeCall(id, reason, mark) {
  const c = getCall(id);
  if (!c || c.status !== "live") return null;
  db.prepare("UPDATE calls SET status='closed', closed_at=?, close_reason=?, close_mark=? WHERE id=?")
    .run(Date.now(), reason, mark ?? null, id);
  noteEvent(id, "closed", reason, mark);
  const pnl = c.entry_ref && mark ? ((mark - c.entry_ref) / c.entry_ref) * 100 : null;
  emit("call:close", { callId: id, mint: c.mint, symbol: c.symbol, reason, mark, pnlPct: pnl });
  return getCall(id);
}

/**
 * The exit triggers, in precedence order. Chain facts fire on one observation because
 * they are facts, not prices; price-based triggers need confirmation so one thin print
 * cannot close a call.
 */
/** The call's best price since it opened, from the marks the monitor already
 * writes. The trailing rules ride this; it costs one indexed query. */
export function highWaterMark(callId) {
  const r = db.prepare("SELECT MAX(mark) hwm FROM call_events WHERE call_id=? AND mark IS NOT NULL").get(callId);
  return r?.hwm ?? null;
}

export function evaluateExit(call, now) {
  // "Unreadable" and "zero flags" are different facts. A call opened during an
  // RPC flake stores flags_at_call = null; comparing that as [] would report every
  // pre-existing authority as "appeared" on the first healthy read and fire a
  // spurious EXIT NOW on a sound thesis. Skip the comparison unless BOTH reads
  // are real. Corrupt JSON likewise disables this one trigger, not the monitor.
  let flagsAtCall = null;
  try { if (call.flags_at_call != null) flagsAtCall = new Set(JSON.parse(call.flags_at_call)); } catch {}
  const flagsNow = now.flags ?? [];
  const mark = now.mark ?? null;

  const newFlag = (flagsAtCall && now.flagsReadable !== false)
    ? flagsNow.find((f) => !flagsAtCall.has(f)) : null;
  if (newFlag) return { fire: true, code: "authority_appeared", urgency: "unconditional",
    detail: `a control appeared that was not there at the call: ${newFlag}`, pct: 100 };

  if (now.rtLossPct != null && now.rtLossPct > 12) return { fire: true, code: "cannot_exit", urgency: "unconditional",
    detail: `round trip is now ${now.rtLossPct.toFixed(1)}% — the position can no longer be left cleanly`, pct: 100 };

  if (call.liq_at_call && now.liqUsd != null && now.liqUsd < 0.6 * call.liq_at_call)
    return { fire: true, code: "liq_collapse", urgency: "unconditional",
      detail: `liquidity fell from $${Math.round(call.liq_at_call).toLocaleString()} to $${Math.round(now.liqUsd).toLocaleString()}`, pct: 100 };

  /* Exit geometry, from the one mechanism family with reproducible evidence
   * behind it (trend-following exits, B-grade across decades): the fixed stop is
   * a FLOOR that only ever tightens — never widens — and winners are ratcheted
   * rather than round-tripped.
   *   breakeven: once the call has been up 35%, it is not allowed to become a loss.
   *   trail:     once up 50%, a 28% retrace off the high-water mark ends it.
   * Both express through one effective stop so the precedence stays legible. */
  const hwm = Math.max(highWaterMark(call.id) ?? 0, mark ?? 0, call.entry_ref ?? 0);
  let stopEff = call.stop ?? null;
  let stopWhy = "the stop";
  if (call.entry_ref && hwm >= call.entry_ref * 1.35) {
    const be = call.entry_ref * 1.02;
    if (stopEff == null || be > stopEff) { stopEff = be; stopWhy = "breakeven ratchet (was up 35%+)"; }
  }
  if (call.entry_ref && hwm >= call.entry_ref * 1.5) {
    const trail = hwm * 0.72;
    if (stopEff == null || trail > stopEff) { stopEff = trail; stopWhy = `trail, 28% off the high of ${hwm}`; }
  }
  if (stopEff != null && mark != null && mark <= stopEff) {
    const code = stopWhy === "the stop" ? "stop_hit" : stopWhy.startsWith("breakeven") ? "breakeven" : "trail_stop";
    return { fire: true, code, urgency: "level",
      detail: `mark ${mark} at or below ${stopWhy} (${Number(stopEff.toPrecision(4))})`, pct: 100 };
  }

  /* SNIPE - HOLD - SELL. A hard multiple on the entry, taken in full.
   *
   * The desk and the executor must agree about when a trade is over, or the tenant's
   * bot sells at 2x while the call sheet still shows the position open — and the
   * graded record then describes a trade nobody made. This mirrors takeProfitX in
   * executor/strategy.mjs; change them together or not at all. */
  const tpX = Number(process.env.DESK_TAKE_PROFIT_X || 2);
  if (tpX > 0 && call.entry_ref > 0 && mark != null && mark >= call.entry_ref * tpX)
    return { fire: true, code: "take_profit", urgency: "level",
      detail: `${(mark / call.entry_ref).toFixed(2)}x — the ${tpX}x rule, sell it all`, pct: 100 };

  if (call.target && mark != null && mark >= call.target)
    return { fire: true, code: "target_hit", urgency: "level", detail: `mark ${mark} reached the target ${call.target}`, pct: 100 };

  /* Thesis expiry — the time barrier. A call is a claim about NOW; the research
   * pass found our geometry had a stop and a target but no clock, and time is
   * the dimension memecoins actually die along. Fast sleeves get 48h to work,
   * everything else a week; expiry is not failure, it is the thesis ageing out. */
  const ageMs = Date.now() - call.opened_at;
  const fast = call.category === "memecoin" || call.category === "unclear";
  if (ageMs > (fast ? 48 : 168) * 3600e3)
    return { fire: true, code: "thesis_expired", urgency: "normal",
      detail: `the thesis had ${fast ? 48 : 168}h to work and time has run out — exit at the market`, pct: 100 };

  /* Stagnation: a reflexive coin that has gone nowhere in a day is not a thesis
   * resting, it is dead momentum occupying risk budget. Slow sleeves are exempt. */
  const FAST = new Set(["memecoin", "unclear", "ai"]);
  if (FAST.has(call.category) && call.entry_ref && hwm < call.entry_ref * 1.15
      && (Date.now() - call.opened_at) / 3.6e6 > 24)
    return { fire: true, code: "stagnant", urgency: "level",
      detail: "24h without ever being up 15% — dead momentum, risk budget released", pct: 100 };

  const maxHold = (CATEGORY_RISK[call.category] ?? CATEGORY_RISK.unclear).maxHoldHours;
  const heldHours = (Date.now() - call.opened_at) / 3.6e6;
  if (heldHours > maxHold) return { fire: true, code: "expired", urgency: "level",
    detail: `held ${Math.round(heldHours)}h, past the ${maxHold}h horizon for a ${call.category}`, pct: 100 };

  return { fire: false };
}

export function stats() {
  const closed = db.prepare("SELECT entry_ref, close_mark, close_reason FROM calls WHERE status='closed' AND entry_ref IS NOT NULL AND close_mark IS NOT NULL").all();
  const pnls = closed.map((c) => ((c.close_mark - c.entry_ref) / c.entry_ref) * 100);
  const wins = pnls.filter((p) => p > 0).length;
  return {
    live: db.prepare("SELECT COUNT(*) n FROM calls WHERE status='live'").get().n,
    closed: closed.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    avgPnlPct: pnls.length ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)) : null,
  };
}
