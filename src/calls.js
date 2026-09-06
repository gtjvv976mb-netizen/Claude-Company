import db, { ensureColumn } from "./lib/store.js";
import { holdWindowFor } from "./categories.js";
import { emit } from "./lib/bus.js";
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "../executor/trade-policy.mjs";
import { CYCLE, MAX_ESCALATION_LEVEL } from "./config.js";

/**
 * THE CALL SHEET — what the house team is actually doing.
 *
 * The penthouse publishes the shared house sheet once, and deterministic floor filters
 * copy it without another model bill. A paid tenant workup can also publish a scoped call
 * to its source floor; source_floor/source_scope preserve which path produced each row.
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
  source_floor  INTEGER,
  source_scope  TEXT NOT NULL DEFAULT 'unattributed',
  source_attributed INTEGER NOT NULL DEFAULT 0,
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
// A close print is provisional until one confirming read agrees with it (subTickMarks).
ensureColumn("calls", "close_confirmed", "INTEGER");
// Sea Otter: when the thesis last cleared the screen it was admitted on.
ensureColumn("calls", "last_verified_at", "INTEGER");
// The market cap AT THE CALL, so a tenant's sleeve filter (micro / low / mid) has a
// number to compare against. Without it every floor sees every call regardless of the
// end of the market it asked for.
ensureColumn("calls", "mcap_at_call", "REAL");
// The team-authored size and loss budget must survive publication. Without these,
// every floor discarded Risk and CEO's work and independently invented a fresh size.
ensureColumn("calls", "desk_size_usd", "REAL");
ensureColumn("calls", "desk_risk_usd", "REAL");
ensureColumn("calls", "desk_equity_usd", "REAL");
ensureColumn("calls", "policy_version", "TEXT");
/* THE HOLD WINDOW THE BAND DESERVES. A call is an instruction to buy AND to sell, and
   until now only the buy carried a number: every position sat under one 12-hour age
   exit whatever it was. A $9k coin resolves inside half an hour and a $5m coin needs
   most of a day, so the window travels with the call (categories.js) and the bot sells
   on it. NULL on a legacy row and on any call whose market cap was unreadable — the
   bot then falls back to its own configured age exit, exactly as before. */
ensureColumn("calls", "hold_min_ms", "INTEGER");
ensureColumn("calls", "hold_max_ms", "INTEGER");
ensureColumn("calls", "hold_band", "TEXT");
// Historical calls were not stamped at publication, so NULL cannot safely be called
// house evidence. Only new, explicitly attributed rows enter improvement scorecards.
ensureColumn("calls", "source_floor", "INTEGER");
ensureColumn("calls", "source_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
ensureColumn("calls", "source_attributed", "INTEGER NOT NULL DEFAULT 0");
/* THE COHORT. Which cycle published this call, and how far down the escalation ladder
   the desk had to reach to publish it. NULL on every legacy row and on any lane that
   publishes outside a cycle — a NULL escalation_level is "not published under a quota",
   which is NOT the same fact as L0 and must never be rendered as one. */
ensureColumn("calls", "cycle_id", "INTEGER");
ensureColumn("calls", "escalation_level", "INTEGER");
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_cycle ON calls(cycle_id, status)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_provenance
         ON calls(source_attributed,source_scope,opened_at,closed_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_closed_provenance
         ON calls(source_attributed,source_scope,closed_at)`);

export function openCall(c) {
  const hold = holdWindowFor(c.mcapUsd ?? null);
  // Every pump.fun-origin call carries the one invalidation the research pass
  // found casually decisive: the observed profitable snipers' exit rule was
  // "the creator sold". Tenants deserve the same tripwire in writing.
  if (c.mint?.endsWith("pump") && c.invalidation && !/deployer|creator/i.test(c.invalidation)) {
    c = { ...c, invalidation: c.invalidation.replace(/\.?\s*$/, "") + ". Thesis void if the deployer wallet sells." };
  }
  try {
    const info = db.prepare(`
      INSERT INTO calls (mint,symbol,category,launchpad,source_floor,source_scope,source_attributed,image_url,conviction,entry_ref,entry_lo,entry_hi,stop,target,
                         thesis,invalidation,flags_at_call,liq_at_call,rt_loss_at_call,mcap_at_call,
                         desk_size_usd,desk_risk_usd,desk_equity_usd,policy_version,opened_at,report_file,last_verified_at,
                         hold_band,hold_min_ms,hold_max_ms,cycle_id,escalation_level)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.mint, c.symbol ?? null, c.category ?? null, c.launchpad ?? null,
      c.sourceFloor ?? null, c.sourceScope ?? "unattributed", c.sourceAttributed === true ? 1 : 0,
      c.imageUrl ?? null, c.conviction ?? null,
      c.entryRef ?? null, c.entryLo ?? null, c.entryHi ?? null, c.stop ?? null, c.target ?? null,
      c.thesis ?? null, c.invalidation ?? null,
      c.flags == null ? null : JSON.stringify(c.flags), c.liqUsd ?? null, c.rtLossPct ?? null, c.mcapUsd ?? null,
      c.deskSizeUsd ?? null, c.deskRiskUsd ?? null, c.deskEquityUsd ?? null, c.policyVersion ?? POLICY_VERSION,
      Date.now(), c.reportFile ?? null,
      Date.now(),           // last_verified_at — clearing the gauntlet IS the first verification
      hold?.band ?? null, hold?.holdMinMs ?? null, hold?.holdMaxMs ?? null,
      /* The cohort stamp. Both are NULL unless a cycle actually published this, so a
         reader can tell "published under the quota at L3" from "published by a lane
         that has no quota" — a distinction the owner explicitly asked to be able to
         see, and one that a defaulted 0 would erase. */
      c.cycleId ?? null,
      /* `== null` and not Number.isFinite: Number(null) is 0, and 0 is L0 — a real
         level with a real meaning. Coercing "no quota" into "the desk did not have to
         reach at all" is precisely the silent claim this column exists to prevent. */
      c.escalationLevel == null ? null : Number(c.escalationLevel));
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
  /* THE COHORT GATE RELEASES ON THE LAST CLOSE, not on the next timer. "When the last
     one closes, the cycle closes and the next opens immediately" is only true if
     something notices the close at the moment it happens — and this is that moment. A
     no-op when no cohort is open, and wrapped because bookkeeping must never be able to
     fail a close: a call that closed is closed whatever the ledger thinks. */
  try { settleCycles(); } catch (e) { emit("cycle:settle_failed", { callId: id, error: String(e?.message || e) }); }
  return getCall(id);
}

/**
 * The exit triggers, in precedence order. Chain facts fire on one observation because
 * they are facts, not prices; price-based triggers need confirmation so one thin print
 * cannot close a call.
 */
/** The call's best CONFIRMED price since it opened, from the marks the monitor
 * already writes.
 *
 * MAX(mark) was a one-witness ratchet: a single anomalous mark entered history and
 * set the high-water mark forever, arming trails and breakeven stops off a price
 * that never traded twice — the exact defect the shared policy's two-witness rule
 * (snipe-v3) exists to prevent, which this pre-computed high was quietly bypassing
 * on the server path. The confirmed high is the best MIN of two CONSECUTIVE marks:
 * a spike flanked by honest neighbours contributes only its neighbour, while a real
 * run confirms one observation later. Same invariant as pricePolicy's pendingHigh,
 * derived from history instead of carried state. */
export function highWaterMark(callId) {
  const r = db.prepare(`SELECT MAX(pairLow) hwm FROM (
      SELECT MIN(mark, LAG(mark) OVER (ORDER BY id)) pairLow
      FROM call_events WHERE call_id=? AND mark IS NOT NULL
    )`).get(callId);
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

  /* ONE VERSIONED PRICE POLICY. The server's paper record and the user's executor
   * import this same pure function, so a target/stop/expiry has one meaning. Chain
   * failures above still outrank price because only the desk can observe them. */
  /* Do NOT pre-max the current mark into the high — that hands pricePolicy a high
   * that already contains the unconfirmed sample, making its two-witness staging dead
   * code on this path. The current mark goes in as `mark`, where the policy stages
   * it; history confirms it on the next monitor pass via highWaterMark's pair rule. */
  const policyHwm = Math.max(highWaterMark(call.id) ?? 0, call.entry_ref ?? 0);
  const policy = pricePolicy({
    // The band's clock rides on the position, so the paper record closes a call at the
    // same moment a tenant's bot closes the trade. Without it the two paths disagreed
    // by hours on exactly the coins the desk holds for minutes.
    position: { entry: call.entry_ref, stop: call.stop, target: call.target,
      high: policyHwm, openedAtMs: call.opened_at,
      holdBand: call.hold_band ?? null, holdMaxMs: call.hold_max_ms ?? null },
    mark,
    // Tests and replay jobs may supply the observation timestamp. Live monitoring
    // omits it and uses the wall clock.
    nowMs: Number.isFinite(Number(now?.nowMs)) ? Number(now.nowMs) : Date.now(),
    config: { ...POLICY_DEFAULTS,
      takeProfitX: Number(process.env.DESK_TAKE_PROFIT_X || POLICY_DEFAULTS.takeProfitX),
      maxAgeHours: Number(process.env.DESK_MAX_AGE_HOURS || POLICY_DEFAULTS.maxAgeHours),
      trailPct: Number(process.env.DESK_TRAIL_PCT || POLICY_DEFAULTS.trailPct) },
  });
  if (policy.action === "sell") return { fire: true, code:
      policy.reason.startsWith("take profit") ? "take_profit" :
      policy.reason.startsWith("age exit") || / window closed /.test(policy.reason) ? "thesis_expired" :
      policy.reason === "desk target hit" ? "target_hit" : "stop_hit",
    urgency: "level", detail: `${policy.reason} · policy ${POLICY_VERSION}`, pct: 100 };
  return { fire: false, policyVersion: POLICY_VERSION };

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

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE COHORT CYCLE LEDGER, AND THE SAFETY FLOOR THAT OUTRANKS IT
 *
 * The owner wants at least three published calls per cycle, "at any cost, by any
 * means", and a new cycle once that cycle's calls have closed. Everything below exists
 * to make that instruction produce TRADES rather than BAGS.
 *
 * The measurement that shapes it: of the last 100 kills, ~60 are safety mechanics, not
 * opinions — 18 cannot_exit alone, where the round-trip probe PROVED the position could
 * not be sold. Publishing three of those is not three calls, it is three coins nobody
 * can get out of, and the quota's own purpose (a desk that trades) is defeated by
 * filling it that way. So the quota is pursued by EFFORT and by relaxed JUDGEMENT on a
 * recorded ladder, and never by lowering the floor.
 *
 * THE CLASSIFICATION LIVES HERE AND ONLY HERE. One table, one lookup, one default.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS cycles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER,
  quota         INTEGER NOT NULL,
  published_count INTEGER NOT NULL DEFAULT 0,
  escalation_level_reached INTEGER NOT NULL DEFAULT 0,
  shortfall     INTEGER NOT NULL DEFAULT 0,
  forced_close  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cycles_open ON cycles(closed_at, id DESC);
`);
/* How many pursuit passes this cycle has had. The LADDER IS THE PASS COUNT: pass 1 runs
   at L0, pass 2 at L1, and so on to L4 — which is why a cycle needs to remember how
   many times it has tried. Kept out of the spec'd column list on purpose; it is
   bookkeeping, not a fact about the cohort. */
ensureColumn("cycles", "passes", "INTEGER NOT NULL DEFAULT 0");
/* THE IDS THAT WERE STILL OPEN WHEN THE GATE WAS FORCED. Written so a force-close is
   visible rather than silent — the whole failure mode being guarded is one position
   that never closes, and a guard nobody can see fires is not a guard. */
ensureColumn("cycles", "forced_open_ids", "TEXT");
ensureColumn("cycles", "close_reason", "TEXT");

/**
 * EVERY GATE IN THE PIPELINE, CLASSIFIED ONCE.
 *
 *   SAFETY   — a measured fact about whether the position can be entered and LEFT, or
 *              used against whoever holds it. Keeps its veto at EVERY escalation level,
 *              for ANY quota. There is no level 5.
 *   JUDGMENT — an opinion about whether the edge is big enough or the coin is the kind
 *              of trade this desk is for. The ladder may relax these, in the spec's
 *              order, and every relaxation is recorded on the call.
 *
 * Anything not in this table is SAFETY (see gateClass). That default is the point: new
 * gates arrive — the crosscheck emits its own codes, a seat invents a kill — and a gate
 * nobody has classified must not be waivable by a quota merely because nobody got round
 * to it. Default-deny.
 */
export const GATE_CLASS = Object.freeze({
  // ── the free screen (data/evidence.js) ────────────────────────────────────────────
  cannot_exit: "SAFETY",              // the round-trip probe PROVED it cannot be sold (18/100 kills)
  unverified_exit: "SAFETY",          // unverified is not safe: we could not measure the way out
  unverified_mint: "SAFETY",          // mint/freeze authority UNKNOWN, which is not absent
  unverified_holders: "SAFETY",       // concentration and bundling UNKNOWN
  mintable: "SAFETY",                 // the creator can print supply and sell it to you
  freezable: "SAFETY",                // accounts can be frozen mid-trade
  seizable: "SAFETY",                 // a permanent delegate can take the tokens out of your wallet
  transfer_hook: "SAFETY",            // arbitrary code runs on transfer and can refuse your sell
  frozen_by_default: "SAFETY",        // new accounts frozen by default — a buyer may not be able to sell
  holder_concentration: "SAFETY",     // one non-pool wallet holding half the float
  serial_deployer: "SAFETY",          // the launch farm (16/100 kills)
  post_migration_dump: "SAFETY",      // the graduate dead zone (9/100 kills)
  wash_suspect: "SAFETY",             // the volume is a machine round-tripping
  thin_liquidity: "SAFETY",           // below the BAND's own floor — the floor travels with the coin
  liquidity_did_not_hold: "SAFETY",   // liquidity that posed for a snapshot and left
  /* AMBIGUOUS, THEREFORE SAFETY. These three read as "the market is not real yet",
     which is a claim about losing money rather than about opportunity, and the rule for
     an ambiguous gate on this desk is to classify it SAFETY and say so. too_new carries
     the research directly: rugs express inside the first hour, and the band's age floor
     is what keeps the desk out of that window. The ladder therefore has NO knob that
     lowers any of them (escalationPlan.minAgeFloorMultiplier is pinned at 1). */
  too_new: "SAFETY",
  no_volume: "SAFETY",
  no_participants: "SAFETY",
  fdv_propped: "SAFETY",              // a thin float propping a fat FDV
  /* OPPORTUNITY, AND SAID SO WHERE IT IS CHECKED: "Not a safety fact — a coin this size
     is perfectly tradeable, it simply is not the trade this desk exists to find."
     These two are the ONLY screen codes L4 may widen, and it widens them by moving the
     SEARCH band, never by moving a per-coin floor. */
  too_big: "JUDGMENT",
  too_small: "JUDGMENT",

  // ── the reputation read (desk.js) ─────────────────────────────────────────────────
  /* The two arms of the same seat, and they are not the same kind of thing. */
  deployer_has_rugged: "SAFETY",      // a FACT it claims to have sourced (4/100 kills)
  manufactured_narrative: "JUDGMENT", // a model's OPINION about attention — the L3 gate

  // ── the record-level facts a call cannot be published without ─────────────────────
  no_data: "SAFETY",                  // the desk cannot read this coin at all
  workup_error: "SAFETY",
  insufficient_coverage: "SAFETY",    // fewer than three analysts returned
  analyst_kill: "SAFETY",             // any seat's hard kill
  compliance_veto: "SAFETY",
  redteam_refuted_unanswered: "SAFETY",
  no_invalidation: "SAFETY",          // could never be graded
  no_stop: "SAFETY",                  // unmanageable for anyone copying it
  no_entry_price: "SAFETY",
  stop_at_or_above_entry: "SAFETY",   // it would fire on arrival
  zero_authorized_size: "SAFETY",
  spike_entry: "SAFETY",              // copiers would be the exit

  // ── the team's explicit no. Not a measured fact; not rankable either. ─────────────
  /* JUDGMENT by kind, but NO level of the ladder waives them, because ranking the
     team's maybes is not the same as trading against the team's no. They are listed so
     the classification is complete rather than silently defaulting. */
  pm_passed: "JUDGMENT",
  ceo_declined: "JUDGMENT",
  // ── the quota bar itself ──────────────────────────────────────────────────────────
  tier_below_bar: "JUDGMENT",
  conviction_below_bar: "JUDGMENT",
});

/** Unknown gate ⇒ SAFETY. Default-deny, deliberately. */
export const gateClass = (code) => GATE_CLASS[code] ?? "SAFETY";
export const isSafetyGate = (code) => gateClass(code) === "SAFETY";
/** Every SAFETY code, for the tests that must drive all of them. */
export const SAFETY_GATES = Object.freeze(
  Object.entries(GATE_CLASS).filter(([, k]) => k === "SAFETY").map(([c]) => c));
export const JUDGMENT_GATES = Object.freeze(
  Object.entries(GATE_CLASS).filter(([, k]) => k === "JUDGMENT").map(([c]) => c));

/* EVERY COMPLIANCE VIOLATION IS SAFETY, WHATEVER ITS CODE.
 *
 * Compliance is code, not a model, and every violation it raises is a hard rule of the
 * charter. The one that matters most to a QUOTA is stop_inside_costs: the executor
 * refused four consecutive LIVE calls on 2026-09-03 (HeeHaw, TOAD, USWS, HeeHaw again,
 * stops 5%-6.5% below entry) because the round-trip costs alone would trigger the stop.
 * Publishing one of those to reach three produces a call that cannot trade — the quota's
 * own purpose, defeated by the act of filling it. So compliance is matched by SOURCE
 * rather than by code list, and a new violation code is covered the day it is written. */
export const complianceGateClass = () => "SAFETY";

/**
 * EVERY GATE THIS RECORD FAILED, classified. Pure: reads the record, touches nothing.
 *
 * The order matters only for reporting; the veto is "any SAFETY entry at all".
 */
export function gateFailures(rec) {
  const out = [];
  const add = (code, detail) => out.push({ code, cls: gateClass(code), detail: detail ?? null });
  if (!rec) { add("no_data", "no record"); return out; }

  if (rec.outcome === "no_data") add("no_data", rec.error ?? "the desk cannot read this coin");
  if (rec.outcome === "error") add("workup_error", rec.error ?? "unknown");
  if (rec.outcome === "insufficient_coverage") add("insufficient_coverage", "fewer than three analysts returned");
  if (rec.outcome === "screened_out")
    for (const f of rec.fails ?? []) add(f.code, f.detail);
  if (rec.outcome === "killed") {
    /* The X read's two arms are separated at the source (desk.js sets killArm) because
       only one of them is an opinion. Anything else that kills is a seat's hard kill. */
    if (rec.killedBy === "xread")
      add(rec.killArm === "manufactured" ? "manufactured_narrative" : "deployer_has_rugged", rec.reason);
    else add("analyst_kill", `${rec.killedBy ?? "an analyst"}: ${rec.reason ?? "hard kill"}`);
  }
  for (const v of (rec.compliance?.pass === false ? rec.compliance.violations ?? [] : []))
    out.push({ code: v.code, cls: complianceGateClass(v.code), detail: v.detail ?? null });
  if (rec.compliance?.pass === false && !(rec.compliance.violations ?? []).length)
    add("compliance_veto", "compliance refused without naming a code");
  if (rec.finalDecision === "VETOED") add("compliance_veto", "vetoed by compliance");
  if (rec.redteam?.verdict === "refuted" && rec.pm?.decision !== "PROPOSE")
    add("redteam_refuted_unanswered", rec.redteam?.headline ?? "refuted");

  // Publishability. A call that cannot be graded or managed is not a call.
  if (rec.outcome === "decided" || rec.pm) {
    if (!rec.pm?.invalidation) add("no_invalidation", "no pre-stated invalidation");
    const stop = Number(rec.ticket?.stop_price);
    const price = Number(rec.ev?.pair?.priceUsd);
    if (!(stop > 0)) add("no_stop", `stop=${rec.ticket?.stop_price ?? "none"}`);
    if (!(price > 0)) add("no_entry_price", `price=${rec.ev?.pair?.priceUsd ?? "none"}`);
    if (stop > 0 && price > 0 && stop >= price) add("stop_at_or_above_entry", `stop ${stop} >= entry ${price}`);
    const size = Number(rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd);
    if (!(size > 0)) add("zero_authorized_size", `size=${size}`);
    const m5 = Number(rec.ev?.pair?.priceChange?.m5 ?? 0);
    const fastBand = rec.ev?.band === "nano" || rec.ev?.band === "micro";
    if (!fastBand && m5 > 20) add("spike_entry", `+${m5}% in five minutes`);
    if (rec.pm?.decision === "PASS") add("pm_passed", "the PM passed on a named flaw");
    if (rec.finalDecision === "DECLINED") add("ceo_declined", "the CEO declined it outright");
  }
  return out;
}

/** The SAFETY failures only — the ones no level and no quota may reach past. */
export const safetyFailures = (rec) => gateFailures(rec).filter((g) => g.cls === "SAFETY");

/* ── the ledger ──────────────────────────────────────────────────────────────────── */

const cycleRow = (id) => db.prepare("SELECT * FROM cycles WHERE id=?").get(id) || null;
/** The cycle currently holding the gate, or null. */
export const openCycle = () =>
  db.prepare("SELECT * FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get() || null;
export const cycleCalls = (id) =>
  db.prepare("SELECT * FROM calls WHERE cycle_id=? ORDER BY id").all(id);
const liveCycleCallIds = (id) =>
  db.prepare("SELECT id FROM calls WHERE cycle_id=? AND status='live' ORDER BY id").all(id).map((r) => r.id);
const publishedCount = (id) =>
  db.prepare("SELECT COUNT(*) n FROM calls WHERE cycle_id=?").get(id).n;

/** Has this cycle finished PURSUING its quota (met it, or exhausted the ladder)? */
export function pursuitOver(c) {
  if (!c) return true;
  return publishedCount(c.id) >= c.quota || c.passes > MAX_ESCALATION_LEVEL;
}

function closeCycleRow(c, { forced = false, stillOpen = [], reason }) {
  const n = publishedCount(c.id);
  const short = n < c.quota ? 1 : 0;
  db.prepare(`UPDATE cycles SET closed_at=?, published_count=?, shortfall=?, forced_close=?,
              forced_open_ids=?, close_reason=? WHERE id=?`)
    .run(Date.now(), n, short, forced ? 1 : 0,
      stillOpen.length ? JSON.stringify(stillOpen) : null, reason, c.id);
  emit("cycle:closed", { cycleId: c.id, published: n, quota: c.quota, shortfall: !!short,
    forced, stillOpen, level: c.escalation_level_reached, reason });
  return cycleRow(c.id);
}

/**
 * Close whatever is finished. Safe to call at any time and from any lane.
 *
 * THREE WAYS A CYCLE ENDS, and the ordering between them is the whole guard:
 *
 *  1. NATURALLY — it stopped pursuing (quota met, or the ladder exhausted at L4) and
 *     every call it published has closed. The next cycle opens immediately.
 *  2. VACUOUSLY — it published ZERO calls and its pursuit is over. It has nothing to
 *     wait for, so it must not hold the gate for a second. (Doc: "A cycle that
 *     publishes ZERO calls must not hold the gate at all.") This is case 1 with an
 *     empty set; it is called out because getting it wrong deadlocks the desk on a bad
 *     night, which is exactly when it can least afford to stop.
 *  3. FORCIBLY — past CYCLE_MAX_AGE_MS. THE DEADLOCK GUARD. One position that never
 *     closes would otherwise stop the desk forever and silently. The still-open calls
 *     are NOT touched: they stay live and keep being monitored and exited by the normal
 *     lanes. They just stop holding the gate shut, and their ids are recorded.
 */
export function settleCycles(now = Date.now()) {
  const settled = [];
  for (const c of db.prepare("SELECT * FROM cycles WHERE closed_at IS NULL ORDER BY id").all()) {
    const live = liveCycleCallIds(c.id);
    const done = pursuitOver(c);
    if (done && live.length === 0) {
      const n = publishedCount(c.id);
      settled.push(closeCycleRow(c, { forced: false, reason: n === 0
        ? "published nothing — a cycle with no calls holds no gate"
        : "every call in the cohort closed" }));
      continue;
    }
    if (now - c.opened_at >= CYCLE.maxAgeMs) {
      settled.push(closeCycleRow(c, { forced: true, stillOpen: live,
        reason: `force-closed at ${Math.round((now - c.opened_at) / 60000)}m (CYCLE_MAX_AGE_MS ` +
          `${Math.round(CYCLE.maxAgeMs / 60000)}m) — ${live.length} call(s) still live and still monitored: ` +
          `${live.join(", ") || "none"}` }));
    }
  }
  return settled;
}

/** Open a fresh cohort. Callers should settle first; beginCyclePass does. */
export function openNewCycle({ quota = CYCLE.quota, now = Date.now() } = {}) {
  const info = db.prepare("INSERT INTO cycles (opened_at,quota) VALUES (?,?)").run(now, quota);
  const c = cycleRow(info.lastInsertRowid);
  emit("cycle:opened", { cycleId: c.id, quota: c.quota });
  return c;
}

/**
 * THE GATE, called once at the top of a pursuit pass.
 *
 * Returns either { waiting: true, cycle } — the previous cohort is still holding, so
 * this pass may warm the free funnel but must not publish — or { cycle, level, pass },
 * the level this pass runs at. THE LADDER IS THE PASS COUNT: pass 1 is L0, pass 2 is
 * L1, ... pass 5 is L4, and there is nothing past L4. It resets to L0 with the cycle,
 * because a new cohort has not earned any relaxation yet.
 */
export function beginCyclePass({ now = Date.now(), quota = CYCLE.quota } = {}) {
  settleCycles(now);
  let c = openCycle();
  if (c && pursuitOver(c)) {
    // Pursuit finished but calls are still working: the cohort holds the gate.
    return { waiting: true, cycle: cycleRow(c.id), level: c.escalation_level_reached,
      liveCallIds: liveCycleCallIds(c.id), quota: c.quota,
      published: publishedCount(c.id) };
  }
  if (!c) c = openNewCycle({ quota, now });
  const pass = c.passes + 1;
  const level = Math.min(MAX_ESCALATION_LEVEL, pass - 1);
  db.prepare("UPDATE cycles SET passes=?, escalation_level_reached=?, published_count=? WHERE id=?")
    .run(pass, Math.max(level, c.escalation_level_reached), publishedCount(c.id), c.id);
  const fresh = cycleRow(c.id);
  if (level > 0)
    emit("cycle:escalated", { cycleId: c.id, level, pass,
      published: publishedCount(c.id), quota: c.quota,
      note: "the open cycle is short of quota — effort and judgement move, the safety floor does not" });
  return { waiting: false, cycle: fresh, level, pass, quota: fresh.quota,
    published: publishedCount(c.id) };
}

/** Count a publication against the open cohort. Recomputed from the calls table, never
    incremented, so the ledger cannot drift away from the rows it describes. */
export function recordCyclePublish(cycleId, callId, level) {
  if (cycleId == null) return null;
  db.prepare("UPDATE cycles SET published_count=?, escalation_level_reached=MAX(escalation_level_reached,?) WHERE id=?")
    .run(publishedCount(cycleId), Number(level) || 0, cycleId);
  const c = cycleRow(cycleId);
  emit("cycle:published", { cycleId, callId, level, published: c?.published_count, quota: c?.quota });
  return c;
}

/** What the owner-facing surface needs: the open cohort and how it is doing. */
export function cycleStatus(now = Date.now()) {
  const c = openCycle();
  if (!c) return { open: false };
  const published = publishedCount(c.id);
  return { open: true, id: c.id, openedAt: c.opened_at, quota: c.quota, published,
    short: Math.max(0, c.quota - published), level: c.escalation_level_reached,
    passes: c.passes, pursuitOver: pursuitOver(c),
    liveCallIds: liveCycleCallIds(c.id),
    ageMs: now - c.opened_at, forceCloseInMs: Math.max(0, CYCLE.maxAgeMs - (now - c.opened_at)) };
}

/** Closed cohorts, newest first, with the realised P&L of the calls each published. */
export function cycleHistory(n = 20) {
  return db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT ?").all(n).map((c) => {
    const calls = cycleCalls(c.id);
    const closed = calls.filter((k) => k.status === "closed" && k.entry_ref > 0 && k.close_mark != null);
    const pnls = closed.map((k) => ((k.close_mark - k.entry_ref) / k.entry_ref) * 100);
    return { ...c, calls: calls.length,
      stillLive: calls.filter((k) => k.status === "live").length,
      realisedPnlPct: pnls.length ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)) : null,
      levels: calls.map((k) => k.escalation_level) };
  });
}
