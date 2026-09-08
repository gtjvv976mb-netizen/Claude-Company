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
/* HOW MANY POOLS THE WAY OUT RAN THROUGH AT PUBLICATION. The worse of the probe's two
   legs (data/evidence.js routeShape), stored beside rt_loss_at_call as another
   OBSERVATION of the route the desk measured — never a threshold. NULL on every legacy
   row and whenever the probe could not report a hop count, which is unmeasured rather
   than one. */
ensureColumn("calls", "route_hops_at_call", "INTEGER");
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
                         thesis,invalidation,flags_at_call,liq_at_call,rt_loss_at_call,route_hops_at_call,mcap_at_call,
                         desk_size_usd,desk_risk_usd,desk_equity_usd,policy_version,opened_at,report_file,last_verified_at,
                         hold_band,hold_min_ms,hold_max_ms,cycle_id,escalation_level)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.mint, c.symbol ?? null, c.category ?? null, c.launchpad ?? null,
      c.sourceFloor ?? null, c.sourceScope ?? "unattributed", c.sourceAttributed === true ? 1 : 0,
      c.imageUrl ?? null, c.conviction ?? null,
      c.entryRef ?? null, c.entryLo ?? null, c.entryHi ?? null, c.stop ?? null, c.target ?? null,
      c.thesis ?? null, c.invalidation ?? null,
      c.flags == null ? null : JSON.stringify(c.flags), c.liqUsd ?? null, c.rtLossPct ?? null,
      /* `== null` FIRST, for the same reason escalation_level does it below: Number(null)
         is 0, and 0 hops is not a route — it is the absence of one. An unmeasured probe
         must store NULL. */
      c.routeHops == null || !Number.isFinite(Number(c.routeHops)) ? null : Number(c.routeHops),
      c.mcapUsd ?? null,
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

  /* THE `cannot_exit` EXIT TRIGGER WAS HERE AND IS DELETED, NOT RE-KEYED
   * (owner, 2026-09-07 — the desk says WHAT and WHEN, never how much or what it costs).
   *
   * It read `now.rtLossPct > 12` and fired an UNCONDITIONAL 100% exit. Reproduced before
   * removal: a 12.1% reading dumped the whole position on a call whose liquidity was
   * still 97% of what it was at the call and whose mark was ABOVE the entry. That is a
   * sell ordered on a price the desk had to pay at a notional the desk chose — the same
   * $75-versus-$2 mistake as the screen kill of the same name, one file later and on a
   * position somebody already holds.
   *
   * DELETED RATHER THAN RE-KEYED TO THE BAND FLOOR, deliberately. The obvious rewrite —
   * "fire when liquidity falls under the band's own floor" — is a second, weaker copy of
   * `liq_collapse` immediately below, which already fires unconditionally when liquidity
   * falls to 60% of what it was AT THE CALL. That is the better ruler for a position: it
   * is relative to the market this call was actually opened into, so it catches a pool
   * draining out from under a coin that was always thin AND one that was deep and is not
   * any more, while an absolute floor catches only the second. Two triggers on one fact
   * would fire together and disagree about why.
   *
   * WHAT COVERS THE POSITION GOING BAD, all on facts the desk can observe at any size:
   *   authority_appeared  a control that was not there at the call (above)
   *   liq_collapse        the market leaving (below)
   *   went_dark           the desk can no longer read the coin (penthouse.js:1806)
   *   pricePolicy         stop, target, trail and the band's clock
   * And the cost of leaving, at the size actually held, is measured by the process that
   * holds it: executor/jupiter.mjs quotes the real round trip on the real lamports.
   *
   * The `cannot_exit` STRING survives in alerts.js's urgency table on purpose: exits
   * already written to the journal under that code still have to render. */

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
 * The measurement that shapes it: of the last 100 kills, most are safety mechanics
 * rather than opinions — the honeypot controls (mintable, freezable, seizable, a
 * transfer hook), the launch farm (12 serial_deployer), the graduate dead zone (15
 * post_migration_dump), the bundled float. Every one is a fact about the coin, and a
 * coin that fails one is a coin nobody can get out of. Publishing three of those is not
 * three calls, it is three bags, and the quota's own purpose (a desk that trades) is
 * defeated by filling it that way.
 *
 * RE-MEASURED 2026-09-07, after the money gates were removed: 12 of those 100 kills
 * died ONLY on `cannot_exit`, a cost ceiling the desk had no business enforcing. They
 * are not safety and they never were, so the safety pool this ladder must respect is
 * smaller — and correspondingly more honest — than it was. So the quota is pursued by EFFORT and by relaxed JUDGEMENT on a
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
/* WHAT THE BOT DID WITH THE COHORT. The owner's goal is calls the bot EXECUTES, and
   until these columns the ledger recorded only publishes (recordCyclePublish counts
   `calls` rows) — so P(taken | published) was invisible: cycle 19 spent $21.68 for 0
   calls, and nothing here could say whether the calls that DID publish were ever
   bought, or sold. Three counts, DISTINCT by call: offered to a floor and never stamped
   not-executable (deliverable), a reported buy (taken), a reported sell (exited). All
   from the bot's own rows (copy.js: deliveries, executor_fills). Snapshotted at close
   and recomputed on every read, exactly as published_count is. Measurement only —
   nothing reads these to decide anything. */
ensureColumn("cycles", "deliverable_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("cycles", "taken_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("cycles", "exited_count", "INTEGER NOT NULL DEFAULT 0");

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
  /* `cannot_exit` WAS THE FIRST ENTRY IN THIS TABLE and it is deleted, not reclassified
   * (owner, 2026-09-07: the desk says only WHAT and WHEN; how much, and what it costs,
   * belong to the bot). It vetoed a coin whose round trip cost more than 8% AT A
   * NOTIONAL THE DESK CHOSE — $75, while the bot's real clip is about $2. It was the
   * single most destructive line in the funnel: 12 of the last 100 kills died on it with
   * nothing else against them, 11 of those between 8.0% and 9.2%.
   *
   * REMOVED RATHER THAN DOWNGRADED TO JUDGMENT, deliberately. Making it JUDGMENT would
   * have kept it killing at L0-L2 and let a quota waive it at L3 — the desk would still
   * be refusing tradeable coins, and would additionally be waiving a real cost fact
   * under pressure to fill three slots. The judgment does not belong on a ladder; it
   * belongs to the process that knows the order size, where it is unconditional:
   * executor/jupiter.mjs:1341-1350 and executor/poller.mjs:1234-1253.
   *
   * The code string still exists ELSEWHERE and that is not an oversight: calls.js:219
   * fires an EXIT alert coded `cannot_exit` when a position the desk already holds sees
   * its round trip pass 12%. That is a WHEN-to-sell judgment about a coin whose exit the
   * desk is managing, not a publish gate, and it never reaches gateFailures() — the exit
   * alert namespace (alerts.js) and this table are separate vocabularies. */
  unverified_exit: "SAFETY",          // unverified is not safe: we could not measure the way out
  unverified_mint: "SAFETY",          // mint/freeze authority UNKNOWN, which is not absent
  unverified_holders: "SAFETY",       // concentration and bundling UNKNOWN
  mintable: "SAFETY",                 // the creator can print supply and sell it to you
  freezable: "SAFETY",                // accounts can be frozen mid-trade
  seizable: "SAFETY",                 // a permanent delegate can take the tokens out of your wallet
  transfer_hook: "SAFETY",            // arbitrary code runs on transfer and can refuse your sell
  frozen_by_default: "SAFETY",        // new accounts frozen by default — a buyer may not be able to sell
  /* THE REST OF THE BOT'S MINT AUDIT (2026-09-08). All pump.fun mints are Token-2022,
     and the executor accepts one only when no extension can tax, block, redirect,
     freeze, pause or re-denominate a transfer (executor/token2022.mjs
     ALLOWED_MINT_EXTENSIONS). The desk screened three of those twenty — permanentDelegate,
     transferHook, defaultAccountState — so a transferFeeConfig mint published and the
     poller then threw on arrival and acknowledged the event WITHOUT a retry: the call
     spent for nothing. Registered EXPLICITLY rather than left to the default below, and
     SAFETY on its own merits: every member of the refused set is a way the mint can stop
     or tax the way OUT, which is the freezable/transfer_hook family, not an opinion
     about edge. No rung of escalationPlan names it, so no quota reaches it either. */
  bot_mint_refusal: "SAFETY",
  holder_concentration: "SAFETY",     // one non-pool wallet holding half the float
  serial_deployer: "SAFETY",          // the launch farm (16/100 kills)
  post_migration_dump: "SAFETY",      // the graduate dead zone (9/100 kills)
  wash_suspect: "SAFETY",             // the volume is a machine round-tripping
  /* THIN LIQUIDITY IS A COIN FACT, NOT A COST FACT — which is why it survived the round
     that removed cannot_exit. "How much does it cost to leave?" changes with the order
     size, so only the bot can answer it. "Is there a market here at all?" gets the same
     answer at every size: a coin with $0.65 of liquidity across two venues has nothing
     on the other side of any order. Same family as a live freeze authority. The check
     itself (data/evidence.js) carries the same reasoning at length. */
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
  /* THE CREATOR ALREADY SOLD (2026-09-08). openCall stamps "Thesis void if the deployer
     wallet sells" on every *pump call, so a creator whose own token account was funded
     and is now empty makes that invalidation true at publish. JUDGMENT, not SAFETY: the
     coin can still be bought and sold — what is gone is the thesis, not the exit — and it
     fires only on POSITIVE chain evidence (data/solana.js: a zero balance after two or
     more transactions, read inside the coin's first 30 minutes); an unread or never-opened
     account is null and never fires. No level of the ladder has a knob for it. Registered
     here explicitly so default-deny cannot mislabel it a measured safety fact. */
  dev_dumped: "JUDGMENT",
  /* THE CURVE'S TWO OPPORTUNITY READS (2026-09-08), from the FREE pre-screen
     (penthouse.js wouldSurviveScreen) rather than the paid one. `dead_curve` is a coin
     still on its curve, under a tenth of the way along after two hours, with no live
     tape; `post_ath_dump` a nano or micro coin under 40% of a high set more than twenty
     minutes ago. Neither is a fact about whether the position can be LEFT — a dead
     curve and a dumped coin both sell — so JUDGMENT, and registered BY NAME so the
     default-deny below cannot promote either to SAFETY. No rung of escalationPlan
     references them, so no quota waives them either: a late look is refused for $0 at
     every level instead of after the ~$0.40 paid workup it used to cost (4 PASS + 15
     WATCH in 500 workups was the rate that refusal was eating into). */
  dead_curve: "JUDGMENT",
  post_ath_dump: "JUDGMENT",
  /* THE SHAPE OF THE WAY OUT (2026-09-08). The exit probe now quotes in the asset the
     bot actually swaps — WSOL at the bot's own declared cap — and records the hop count
     of each leg (data/evidence.js routeShape). A route with more than one hop is worth
     SAYING: every extra hop is another program that can fail while a stop is trying to
     fire, and the bot's entry refuses a route needing a third wallet ATA outright. It is
     not worth REFUSING on: the coin still sells, and "can this be sold at all" is the
     only question the probe is allowed to gate (`unverified_exit`). So screen() records
     it as a NOTE and never as a failure — it can reach no gate today — and it is
     registered here BY NAME so that if a future caller ever does put it in front of one,
     gateClass()'s default-deny cannot silently promote a route observation into an
     un-waivable safety kill. BestPick reads the hop count and prefers the shorter route
     when the field gives it a choice; that is a ranking, not a veto. */
  multi_hop_route: "JUDGMENT",

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

  /* ── THE ENTRY CONTRACT'S OWN CODES (2026-09-08) ─────────────────────────────────
   *
   * penthouse.js publishCall now runs executor/entry-contract.mjs on the fresh
   * consensus mark its caller took, and withholds under the contract's gate code. The
   * moment a desk file emits one of these, gateClass()'s default-deny turns any
   * UNregistered one into a SAFETY gate no escalation rung may ever waive — a live-mark
   * refusal wearing a rug check's clothes. entry-contract.mjs says so at ENTRY_GATES
   * and test-entry-contract-parity.mjs enforces it the moment the desk is wired, which
   * is now. So every one of them is registered here EXPLICITLY, and every one of them
   * is JUDGMENT:
   *
   *   NONE OF THESE IS A FACT ABOUT THE COIN. They are facts about where the price
   *   stands relative to a bracket somebody wrote minutes ago. The same coin, unchanged
   *   — same mint authority, same holders, same pool — passes all of them again as soon
   *   as the mark comes back inside the zone. That is the definition of a judgment on
   *   this desk, and the opposite of `mintable` or `thin_liquidity`.
   *
   * `no_stop` and `stop_at_or_above_entry` are NOT repeated here: they are the two the
   * contract shares with the desk's own vocabulary, they are the same facts computed
   * off the same bracket, and they keep their SAFETY classification above.
   *
   * `target_inside_cost` cannot fire from the desk at all — publishCall passes
   * costPct 0, because what a round trip costs belongs to the bot — but it is
   * registered anyway: the classification must not depend on which caller happens to
   * be running the contract today. */
  no_entry_ref: "JUDGMENT",           // the anchor is unreadable, not the coin
  mark_stale: "JUDGMENT",             // the READ aged out; nothing about the token moved
  invalid_zone: "JUDGMENT",           // a malformed authored bracket
  mark_outside_zone: "JUDGMENT",      // the price walked out of the zone and can walk back
  mark_breached_stop: "JUDGMENT",     // this entry is gone; the coin is not
  invalid_target: "JUDGMENT",
  mark_at_target: "JUDGMENT",         // the move already happened — a missed trade, not a rug
  target_inside_cost: "JUDGMENT",     // inert from the desk (costPct 0); the bot owns cost
  window_expired: "JUDGMENT",         // untested at publish: the call has no clock yet
  reference_refused: "JUDGMENT",      // the contract's dead-man's handle
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
 * charter — matched by SOURCE rather than by code list, so a new violation code is
 * covered the day it is written.
 *
 * This note used to justify the rule with `stop_inside_costs` (the executor refusing
 * four consecutive live calls on 2026-09-03 whose stops sat inside the round-trip
 * costs), and that veto no longer exists: it was the desk recomputing the bot's cost
 * guard on a size the desk invented, and it is enforced for real at
 * executor/poller.mjs:1234-1253. The rule is unchanged and the reason is simpler —
 * compliance raises charter violations, and a quota does not get to waive the charter
 * because it is short a call. What is left after 2026-09-07 is coin-quality and
 * record-consistency: proposal-only language, an unanswered refutation, the desk's own
 * risk arithmetic agreeing with itself, a stop below the entry zone, take-profit legs
 * summing under 100%. None of those become negotiable at L4. */
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

/* ── the publishability ledger ───────────────────────────────────────────────────── */

/**
 * WHAT HAPPENED TO EVERY PM-POSITIVE WORKUP AT THE PUBLISH GATE.
 *
 * Every "P(>=3 calls per cohort)" estimate runs on the PM-positive rate — 224 WATCH or
 * PROPOSE verdicts out of 1,571 paid X reads all-time, 14.3% — and then assumes some
 * fraction of those publishes. That fraction has never been measured under the
 * recalibrated bar (config.js minConviction 20): all-time it was 58 published / 224
 * PM-positive = 26% under the OLD bars, and the live heartbeat today shows 13 WATCH
 * verdicts and 0 cohort calls, with no counter anywhere naming which gate ate them.
 * publishCall emits `call:withheld`, but a chronicle row is not a denominator.
 *
 * So publishCall writes one row per PM-positive record, whatever the outcome, and the
 * histogram over `gate` is the publishable fraction with its refusals itemised. It
 * records; it decides nothing, and it is written for PM-positive records ONLY so the
 * row count IS the denominator every estimate uses.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS publishability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  mint          TEXT NOT NULL,
  symbol        TEXT,
  cycle_id      INTEGER,
  escalation_level INTEGER,
  pm_decision   TEXT NOT NULL,
  conviction    REAL,
  gate          TEXT NOT NULL,
  refused_by    TEXT NOT NULL,
  gates         TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  call_id       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_publishability_gate ON publishability(gate, ts);
CREATE INDEX IF NOT EXISTS idx_publishability_cycle ON publishability(cycle_id, ts);
`);

/** The PM's two positive verdicts — the denominator of every published-per-positive rate. */
export const isPmPositive = (rec) =>
  rec?.pm?.decision === "WATCH" || rec?.pm?.decision === "PROPOSE";

/**
 * THE GATE THE HISTOGRAM CHARGES A REFUSAL TO.
 *
 * Almost always the gate that refused it. The one exception is a mechanical zero: the
 * ticket is only drafted when `risk.position_size_usd > 0` (desk.js, stage 10), so a
 * record the rails sized to zero ALSO has no stop, and `no_stop` sorts ahead of
 * `zero_authorized_size` in gateFailures. Charging that refusal to `no_stop` would hide
 * the rails behind their own consequence, and "zero size" is one of the four losses
 * this ledger exists to itemise. Nothing about the gate itself moves — the record is
 * still refused by the safety floor, on the same code, with the same reason; only the
 * column the count lands in changes, and `refused_by` keeps the raw gate beside it.
 */
export function publishabilityGate(rec, refusedBy) {
  if (refusedBy === "no_stop" &&
      gateFailures(rec).some((g) => g.code === "zero_authorized_size")) return "zero_authorized_size";
  return refusedBy;
}

/** One row per PM-positive publish attempt. A no-op for anything the PM did not like. */
export function recordPublishability(rec, { refusedBy, outcome, escalation = null, cycleId = null,
                                            callId = null } = {}) {
  if (!isPmPositive(rec) || !rec?.mint) return null;
  const codes = gateFailures(rec).map((g) => g.code);
  const gate = publishabilityGate(rec, refusedBy);
  const info = db.prepare(`INSERT INTO publishability
    (ts,mint,symbol,cycle_id,escalation_level,pm_decision,conviction,gate,refused_by,gates,outcome,call_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(Date.now(), rec.mint, rec.symbol ?? rec.ev?.symbol ?? null, cycleId, escalation,
      rec.pm.decision, Number.isFinite(Number(rec.pm?.conviction)) ? Number(rec.pm.conviction) : null,
      gate, String(refusedBy), JSON.stringify(codes), String(outcome), callId);
  emit("call:publishability", { mint: rec.mint, symbol: rec.symbol ?? rec.ev?.symbol,
    pmDecision: rec.pm.decision, conviction: rec.pm?.conviction ?? null, gate, refusedBy,
    outcome, cycleId, level: escalation });
  return Number(info.lastInsertRowid);
}

/**
 * PUBLISHED PER PM-POSITIVE, itemised by gate. `byGate` is {gate: count} with
 * `published` as one of the keys, so the fraction and every refusal read off one map.
 * `f` is null, not 0, when nothing has been measured yet — an unmeasured desk must not
 * read as one that publishes nothing.
 */
export function publishabilityHistogram({ cycleId = null, sinceMs = 0 } = {}) {
  const conds = ["ts >= ?"]; const args = [Number(sinceMs) || 0];
  if (cycleId != null) { conds.push("cycle_id = ?"); args.push(cycleId); }
  const rows = db.prepare(`SELECT gate, COUNT(*) n FROM publishability
    WHERE ${conds.join(" AND ")} GROUP BY gate ORDER BY n DESC, gate`).all(...args);
  const byGate = {};
  for (const r of rows) byGate[r.gate] = r.n;
  const pmPositive = rows.reduce((a, r) => a + r.n, 0);
  const published = byGate.published ?? 0;
  return { byGate, pmPositive, published,
    f: pmPositive > 0 ? Number((published / pmPositive).toFixed(4)) : null };
}

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

/* The bot's tables belong to copy.js, and not every process that loads this ledger
   loads copy.js (test-hold-clock, test-mandate and five more import calls.js alone),
   nor does every production database predate-proof itself: a table or column that is
   not there must read as "nothing reported", never as a throw inside closeCycleRow —
   a cycle must not fail to close over a count it only records. Remembered once true,
   because a schema only grows. */
const schemaHas = (() => {
  const seen = new Set();
  return (table, column = null) => {
    const key = column ? `${table}.${column}` : table;
    if (seen.has(key)) return true;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const has = cols.length > 0 && (column == null || cols.includes(column));
    if (has) seen.add(key);
    return has;
  };
})();

/**
 * THE BOT'S SIDE OF ONE COHORT, recomputed from its own rows every time it is asked.
 * `deliverable` — published calls a floor was OFFERED whose delivery was never stamped
 * `deliverable=0` (an unstamped row counts: today every offered call is raised at once);
 * `taken` — calls with at least one reported buy; `exited` — with at least one reported
 * sell. DISTINCT by call, so the bot's re-posted or partial fills cannot inflate a count
 * past the number of calls behind it. Read live by cycleStatus and cycleHistory, and
 * frozen into the row by closeCycleRow.
 */
export function cycleExecution(id) {
  const n = (sql) => db.prepare(sql).get(id).n;
  const fills = schemaHas("executor_fills");
  return {
    deliverable: schemaHas("deliveries", "deliverable")
      ? n(`SELECT COUNT(DISTINCT d.call_id) n FROM deliveries d JOIN calls c ON c.id=d.call_id
           WHERE c.cycle_id=? AND d.verdict='offered' AND COALESCE(d.deliverable, 1) <> 0`) : 0,
    taken: fills
      ? n(`SELECT COUNT(DISTINCT f.call_id) n FROM executor_fills f JOIN calls c ON c.id=f.call_id
           WHERE c.cycle_id=? AND f.side='buy'`) : 0,
    exited: fills
      ? n(`SELECT COUNT(DISTINCT f.call_id) n FROM executor_fills f JOIN calls c ON c.id=f.call_id
           WHERE c.cycle_id=? AND f.side='sell'`) : 0,
  };
}

/** Has this cycle finished PURSUING its quota (met it, or exhausted the ladder)? */
export function pursuitOver(c) {
  if (!c) return true;
  return publishedCount(c.id) >= c.quota || c.passes > MAX_ESCALATION_LEVEL;
}

function closeCycleRow(c, { forced = false, stillOpen = [], reason }) {
  const n = publishedCount(c.id);
  const short = n < c.quota ? 1 : 0;
  const x = cycleExecution(c.id);
  db.prepare(`UPDATE cycles SET closed_at=?, published_count=?, shortfall=?, forced_close=?,
              forced_open_ids=?, close_reason=?, deliverable_count=?, taken_count=?, exited_count=?
              WHERE id=?`)
    .run(Date.now(), n, short, forced ? 1 : 0,
      stillOpen.length ? JSON.stringify(stillOpen) : null, reason,
      x.deliverable, x.taken, x.exited, c.id);
  emit("cycle:closed", { cycleId: c.id, published: n, quota: c.quota, shortfall: !!short,
    forced, stillOpen, level: c.escalation_level_reached, reason,
    deliverable: x.deliverable, taken: x.taken, exited: x.exited });
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
  const before = { passes: c.passes, level: c.escalation_level_reached };
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
    published: publishedCount(c.id), before };
}

/**
 * GIVE A RUNG BACK THAT AN OUTAGE TOOK.
 *
 * THE LADDER IS THE PASS COUNT, and that is right when a pass is a look at the market:
 * a level is spent because the market was searched and came back short. It is wrong
 * when the pass never searched anything. Measured 2026-09-07 with the Anthropic account
 * empty (HTTP 400 "credit balance is too low"): five scheduled passes each halted at the
 * first workup having asked ZERO seats and spent $0.0000, and the cohort arrived at L4
 * exhausted — then recorded a shortfall against a market it had never looked at. The
 * same market published three the moment the account was funded.
 *
 * So a pass that could not think hands its rung back: the counters are restored to
 * exactly what they were before the pass began, and the next pass runs at the same
 * level. This RELAXES NOTHING — it is the opposite, since a rung is only ever spent to
 * relax a standard, and refusing to spend one keeps the desk at the tighter bar. It is
 * refused outright if anything was published on this pass, and it can never lower the
 * level below one a published call in the cohort actually ran at.
 */
export function abandonCyclePass(cycleId, before = {}, reason = "") {
  const c = cycleRow(cycleId);
  if (!c) return null;
  const priorPasses = Number(before?.passes);
  if (!Number.isInteger(priorPasses) || priorPasses < 0) return null;
  // Only ever undo THIS pass, and only if nothing else moved the counter meanwhile.
  if (c.passes !== priorPasses + 1) return null;
  const publishedLevel = db
    .prepare("SELECT MAX(escalation_level) AS lvl FROM calls WHERE cycle_id=?").get(cycleId)?.lvl;
  const floor = Math.max(0, Number(publishedLevel) || 0);
  const priorLevel = Number.isInteger(Number(before?.level)) ? Number(before.level) : 0;
  const level = Math.max(floor, Math.min(priorLevel, c.escalation_level_reached));
  db.prepare("UPDATE cycles SET passes=?, escalation_level_reached=? WHERE id=?")
    .run(priorPasses, level, cycleId);
  emit("cycle:pass_abandoned", { cycleId, passes: priorPasses, level, reason,
    note: "the pass researched nothing, so it does not spend a rung of the ladder — " +
      "the next pass runs at the same level, against a market this one never saw" });
  return cycleRow(cycleId);
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
    // What the bot has done with those publishes so far: deliverable / taken / exited.
    ...cycleExecution(c.id),
    passes: c.passes, pursuitOver: pursuitOver(c),
    liveCallIds: liveCycleCallIds(c.id),
    ageMs: now - c.opened_at, forceCloseInMs: Math.max(0, CYCLE.maxAgeMs - (now - c.opened_at)) };
}

/** Closed cohorts, newest first, with the realised P&L of the calls each published.
 *  `deliverable` / `taken` / `exited` are recomputed here on every read, like `calls` is:
 *  a sell the bot reports after a force-close (its calls are still live and still
 *  monitored) must show up, and the `*_count` columns keep the close-time snapshot. */
export function cycleHistory(n = 20) {
  return db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT ?").all(n).map((c) => {
    const calls = cycleCalls(c.id);
    const closed = calls.filter((k) => k.status === "closed" && k.entry_ref > 0 && k.close_mark != null);
    const pnls = closed.map((k) => ((k.close_mark - k.entry_ref) / k.entry_ref) * 100);
    return { ...c, calls: calls.length, ...cycleExecution(c.id),
      stillLive: calls.filter((k) => k.status === "live").length,
      realisedPnlPct: pnls.length ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)) : null,
      levels: calls.map((k) => k.escalation_level) };
  });
}
