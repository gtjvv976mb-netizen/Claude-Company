/**
 * THE COHORT CYCLE — three calls, then wait for them, then the next.
 *
 * The owner's instruction has two halves and the second one is the dangerous half:
 * "each cycle produces at least three published calls... after those calls are finished
 * (sold), a new cycle begins". A cohort that waits for its own calls bounds concurrent
 * exposure to the quota and makes each cycle's P&L attributable to one cycle. It also
 * hands the desk a way to stop forever: ONE position that never closes and the gate
 * never reopens, silently, for as long as the process runs.
 *
 * So the deadlock guard is not a footnote here, it is the point of the file. Its proof
 * is at the bottom: a cycle holding a position that never closes is force-closed at
 * CYCLE_MAX_AGE_MS, the next cycle opens, and the stuck call is STILL LIVE and STILL
 * MONITORED — it stopped holding the gate, it did not stop being a position.
 *
 *   node test-cohort-cycles.mjs
 */

/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE. scripts/test-all.mjs points
   CLAUDE_CO_DB at a throwaway file, but running this file on its own falls back to
   ./claude-co.db (src/lib/store.js) — and the resets in these tests DELETE FROM calls,
   deliveries and call_events. On 2026-09-07 that emptied three tables of the local dev
   database, which is gitignored and had no backup. The runner's value still wins; this
   only covers the unguarded direct run. */
import os from "node:os";
import path from "node:path";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-cohort-cycles-" + process.pid + ".db");
import db from "./src/lib/store.js";
import { publishCall, needsFastExitLane } from "./src/penthouse.js";
import { openCall, closeCall, getCall, liveCalls, evaluateExit,
  beginCyclePass, settleCycles, openCycle, openNewCycle, cycleStatus, cycleHistory,
  cycleCalls, pursuitOver, cycleExecution } from "./src/calls.js";
import { recordExecutorFill } from "./src/copy.js";
import { startOffice } from "./src/office.js";
import { CYCLE, MAX_ESCALATION_LEVEL } from "./src/config.js";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const MIN = 60_000;
const reset = () => {
  for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
  // call_events references calls, so it goes first or the FK refuses the delete.
  db.exec("DELETE FROM call_events; DELETE FROM executor_fills; DELETE FROM deliveries; DELETE FROM calls; DELETE FROM cycles");
};
let seq = 0;
const clean = (over = {}) => {
  const n = String(++seq).padStart(2, "0");
  return {
    mint: `Coh${n}11111111111111111111111111111111111111`.slice(0, 43), symbol: `COH${n}`,
    outcome: "decided", finalDecision: "APPROVED", weighted: 71,
    pm: { decision: "PROPOSE", conviction: 68, thesis: "real ignition", invalidation: "deployer sells" },
    redteam: { verdict: "wounded", headline: "thin on holders" },
    compliance: { pass: true, violations: [] },
    risk: { position_size_usd: 50, stop_price: 0.00062, max_loss_usd: 20.55 },
    ceo: { ruling: "APPROVE", order_size_usd: 50 },
    order: { size: 50 },
    ticket: { stop_price: 0.00062, take_profit: [{ price: 0.0019 }] },
    ev: { symbol: `COH${n}`, pair: { priceUsd: 0.001, marketCap: 300_000,
          priceChange: { m5: 2 }, liquidityUsd: 90_000 },
          pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
          mintAccount: { flags: [] } },
    ...over,
  };
};

console.log("\nTHE LEDGER — one row per cycle, with the columns the record needs");
{
  reset();
  const cols = db.prepare("PRAGMA table_info(cycles)").all().map((c) => c.name);
  for (const c of ["id", "opened_at", "closed_at", "quota", "published_count",
    "escalation_level_reached", "shortfall", "forced_close",
    "deliverable_count", "taken_count", "exited_count"])
    ok(`cycles.${c}`, cols.includes(c), cols.join(","));
  const ccols = db.prepare("PRAGMA table_info(calls)").all().map((c) => c.name);
  ok("calls.cycle_id and calls.escalation_level exist",
    ccols.includes("cycle_id") && ccols.includes("escalation_level"),
    `added by the same ensureColumn pattern as hold_band / source_floor`);
  ok("the deadlock guard defaults to 6h and is env-settable",
    CYCLE.maxAgeMs === 6 * 3600_000 &&
    /CYCLE_MAX_AGE_MS/.test(fs.readFileSync(new URL("./src/config.js", import.meta.url), "utf8")),
    `CYCLE.maxAgeMs = ${CYCLE.maxAgeMs}ms (${CYCLE.maxAgeMs / 3600_000}h), quota = ${CYCLE.quota}`);
}

console.log("\nA COHORT'S LIFE — open, publish the quota, hold the gate, close, next");
let firstCycleId = null;
{
  reset();
  const p = beginCyclePass();
  firstCycleId = p.cycle.id;
  ok("a cycle opened at L0", p.waiting === false && p.level === 0,
    `cycle=${p.cycle.id} level=L${p.level} quota=${p.quota}`);
  const pubs = [];
  for (let i = 0; i < CYCLE.quota; i++)
    pubs.push(publishCall(clean(), { category: "memecoin", launchpad: "pump.fun",
      escalation: 0, cycleId: p.cycle.id }));
  ok(`${CYCLE.quota} calls published into the cohort`, pubs.every((r) => r.outcome === "published"),
    pubs.map((r) => `#${r.callId}@L${r.level}`).join(" "));
  const st = cycleStatus();
  ok("the ledger counts them", st.published === CYCLE.quota && st.short === 0,
    `published=${st.published}/${st.quota} short=${st.short} level=L${st.level}`);
  const rows = cycleCalls(p.cycle.id);
  ok("every call carries its cycle and the level it was published at",
    rows.length === CYCLE.quota && rows.every((r) => r.cycle_id === p.cycle.id && r.escalation_level === 0),
    rows.map((r) => `#${r.id} cycle=${r.cycle_id} L${r.escalation_level}`).join(" "));
  const ev = db.prepare("SELECT detail FROM call_events WHERE call_id=? AND kind='escalation'").get(rows[0].id);
  ok("...and says so on the call itself, L0 included",
    !!ev && /published at L0/.test(ev.detail), ev?.detail ?? "no escalation event");

  ok("the cohort now holds the gate", pursuitOver(openCycle()) === true &&
    beginCyclePass().waiting === true,
    `pursuitOver=${pursuitOver(openCycle())} live=${cycleStatus().liveCallIds.join(",")}`);

  closeCall(rows[0].id, "target_hit", 0.002);
  ok("one close is not enough — the cohort is the unit, not the call",
    beginCyclePass().waiting === true, `still live: ${cycleStatus().liveCallIds.join(",")}`);
  closeCall(rows[1].id, "stop_hit", 0.0005);
  closeCall(rows[2].id, "thesis_expired", 0.0009);
  const closed = db.prepare("SELECT * FROM cycles WHERE id=?").get(p.cycle.id);
  ok("the last close closes the cohort, immediately",
    closed.closed_at != null && closed.published_count === CYCLE.quota,
    `closed_at=${closed.closed_at} published=${closed.published_count} forced=${closed.forced_close} shortfall=${closed.shortfall}`);
  ok("...with no shortfall and no force", closed.shortfall === 0 && closed.forced_close === 0,
    `shortfall=${closed.shortfall} forced_close=${closed.forced_close} reason=${closed.close_reason}`);
  const next = beginCyclePass();
  ok("and the next cycle opens, back at L0",
    next.waiting === false && next.cycle.id !== p.cycle.id && next.level === 0,
    `cycle ${p.cycle.id} -> ${next.cycle.id}, level=L${next.level}`);
}

console.log("\nTHE LADDER — one rung per pass while the cycle is short, and nothing past L4");
{
  reset();
  const seen = [];
  for (let i = 0; i < 7; i++) {
    const p = beginCyclePass();
    if (p.waiting) { seen.push("waiting"); continue; }
    seen.push(p.level);
  }
  /* Passes 1-5 run L0..L4 on ONE cycle. Its pursuit is then over: it published nothing,
     so it holds no gate, closes vacuously, and passes 6-7 are a NEW cycle back at L0. */
  ok("levels went 0,1,2,3,4 and then reset with the new cycle",
    JSON.stringify(seen) === JSON.stringify([0, 1, 2, 3, 4, 0, 1]), `levels: ${seen.join(",")}`);
  const rows = db.prepare("SELECT * FROM cycles ORDER BY id").all();
  ok("the exhausted cycle recorded its shortfall rather than inventing a call",
    rows[0].shortfall === 1 && rows[0].published_count === 0 && rows[0].forced_close === 0,
    `cycle ${rows[0].id}: published=${rows[0].published_count}/${rows[0].quota} ` +
    `level_reached=L${rows[0].escalation_level_reached} shortfall=${rows[0].shortfall} reason=${rows[0].close_reason}`);
  ok("A CYCLE THAT PUBLISHED ZERO CALLS HELD THE GATE FOR NOTHING",
    rows.length === 2 && rows[0].closed_at != null,
    `${rows.length} cycles exist; the empty one closed at ${rows[0].closed_at} without waiting on anything`);
  ok("it reached L4 and stopped — there is no L5",
    rows[0].escalation_level_reached === MAX_ESCALATION_LEVEL,
    `escalation_level_reached=${rows[0].escalation_level_reached}, MAX_ESCALATION_LEVEL=${MAX_ESCALATION_LEVEL}`);
}

console.log("\nSHORT OF QUOTA AT L4 — publish what was found, record the shortfall");
{
  reset();
  let p = beginCyclePass();                       // pass 1, L0
  const pub = publishCall(clean(), { category: "memecoin", escalation: 0, cycleId: p.cycle.id });
  for (let i = 0; i < 4; i++) p = beginCyclePass();  // passes 2-5: L1..L4, nothing more found
  ok("the ladder was exhausted with one call of three",
    p.level === MAX_ESCALATION_LEVEL && cycleStatus().published === 1,
    `level=L${p.level} published=${cycleStatus().published}/${cycleStatus().quota}`);
  closeCall(pub.callId, "target_hit", 0.0018);
  const row = db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT 1").get();
  const closedRow = db.prepare("SELECT * FROM cycles WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  ok("the cohort closed SHORT, and the ledger says so",
    closedRow.shortfall === 1 && closedRow.published_count === 1 && closedRow.forced_close === 0,
    `published=${closedRow.published_count}/${closedRow.quota} shortfall=${closedRow.shortfall} ` +
    `level=L${closedRow.escalation_level_reached}`);
  const hist = cycleHistory(5).find((h) => h.id === closedRow.id);
  ok("the history carries the cohort's realised P&L and the levels it published at",
    hist.calls === 1 && hist.realisedPnlPct === 80, `pnl=${hist.realisedPnlPct}% levels=[${hist.levels}]`);
}

console.log("\nTHE DEADLOCK PROOF — a position that never closes must not stop the desk");
{
  reset();
  const p = beginCyclePass();
  const cycleId = p.cycle.id;
  const pubs = [];
  for (let i = 0; i < CYCLE.quota; i++)
    pubs.push(publishCall(clean(), { category: "memecoin", escalation: 0, cycleId }));
  const stuck = pubs[2].callId;
  closeCall(pubs[0].callId, "target_hit", 0.002);
  closeCall(pubs[1].callId, "stop_hit", 0.0005);

  const openedAt = db.prepare("SELECT opened_at FROM cycles WHERE id=?").get(cycleId).opened_at;
  const nearly = openedAt + CYCLE.maxAgeMs - MIN;
  ok(`at ${(CYCLE.maxAgeMs / 3600_000)}h minus a minute the gate is still shut — the guard is a LAST resort`,
    beginCyclePass({ now: nearly }).waiting === true,
    `waiting on call #${stuck}; force-close in ${Math.round((CYCLE.maxAgeMs - (nearly - openedAt)) / MIN)}m`);

  const past = openedAt + CYCLE.maxAgeMs + 1;
  const settled = settleCycles(past);
  const forced = db.prepare("SELECT * FROM cycles WHERE id=?").get(cycleId);
  ok("past CYCLE_MAX_AGE_MS the cohort is force-closed",
    settled.length === 1 && forced.forced_close === 1 && forced.closed_at != null,
    `forced_close=${forced.forced_close} reason=${forced.close_reason}`);
  ok("...and the ids that were still open are RECORDED, not swallowed",
    JSON.parse(forced.forced_open_ids || "[]").includes(stuck),
    `forced_open_ids=${forced.forced_open_ids}`);
  /* The quota WAS met, so there is no shortfall — the unresolved position is recorded
     as a forced-open id, which is a different fact and must not be laundered into the
     shortfall flag. A reader has to be able to tell "we could not find three" from "we
     found three and one of them will not close". */
  ok("the quota was met, so shortfall stays 0 — the stuck call is recorded separately",
    forced.published_count === CYCLE.quota && forced.shortfall === 0,
    `published=${forced.published_count}/${forced.quota} shortfall=${forced.shortfall} ` +
    `forced_open_ids=${forced.forced_open_ids}`);

  const next = beginCyclePass({ now: past });
  ok("THE NEXT CYCLE OPENS — the desk is not stopped",
    next.waiting === false && next.cycle.id !== cycleId && next.level === 0,
    `cycle ${cycleId} (forced) -> ${next.cycle.id} at L${next.level}`);

  /* AND THE STUCK CALL IS STILL A POSITION. It stopped holding the gate; it did not
     stop being monitored. Anything less would mean the guard closed the desk's eyes on
     a live position to keep the schedule moving, which is worse than the deadlock. */
  const call = getCall(stuck);
  ok("the stuck call is still LIVE", call.status === "live",
    `#${call.id} ${call.symbol} status=${call.status} closed_at=${call.closed_at}`);
  ok("...still in the live book the monitor walks",
    liveCalls().some((c) => c.id === stuck), `liveCalls() = [${liveCalls().map((c) => c.id).join(",")}]`);
  ok("...still on the 45-second fast exit lane",
    needsFastExitLane(call) === true, `hold_band=${call.hold_band} hold_max_ms=${call.hold_max_ms}`);
  const exit = evaluateExit(call, { mark: 0.0005, flags: [], flagsReadable: true });
  ok("...and the normal exit logic still fires on it",
    exit.fire === true && exit.code === "stop_hit",
    `mark 0.0005 vs stop ${call.stop}: fire=${exit.fire} code=${exit.code} — ${exit.detail}`);
  ok("...and it is still attributed to the cohort that published it",
    call.cycle_id === cycleId && call.escalation_level === 0,
    `cycle_id=${call.cycle_id} escalation_level=L${call.escalation_level}`);

  // Closing it later must not resurrect or re-close the cohort.
  closeCall(stuck, "thesis_expired", 0.0009);
  const after = db.prepare("SELECT * FROM cycles WHERE id=?").get(cycleId);
  ok("closing it later leaves the forced record exactly as it was",
    after.forced_close === 1 && after.closed_at === forced.closed_at &&
    after.published_count === forced.published_count,
    `closed_at ${forced.closed_at} -> ${after.closed_at}, forced ${after.forced_close}`);
  ok("and the newer cycle is untouched by that close",
    openCycle().id === next.cycle.id, `open cycle is still ${openCycle().id}`);
}

console.log("\nTHE LANES THAT HAVE NO QUOTA ARE UNTOUCHED");
{
  reset();
  const r = publishCall(clean(), { category: "memecoin", launchpad: "pump.fun" });
  const call = getCall(r.callId);
  ok("a publish with no cohort context still publishes",
    r.outcome === "published", `outcome=${r.outcome} level=${r.level}`);
  ok("...and stamps NULL, which is 'no quota', not 'L0'",
    call.cycle_id === null && call.escalation_level === null,
    `cycle_id=${call.cycle_id} escalation_level=${call.escalation_level}`);
  ok("...and opened no cycle behind the desk's back", openCycle() === null,
    `openCycle() = ${JSON.stringify(openCycle())}`);
}

console.log("\nTHE BOT'S SIDE OF THE COHORT — published is not taken, and taken is not exited");
/* The owner's goal is calls the bot EXECUTES. The ledger counted publishes only
   (recordCyclePublish), so P(taken | published) was invisible: cycle 19 spent $21.68
   for 0 calls and no row could say whether any published call was ever bought or sold.
   This block drives the bot's REAL report path (copy.recordExecutorFill, the writer
   behind POST /executor/fill) rather than raw INSERTs, so the counts are proved against
   the rows the bot actually leaves — including its re-posts, which must not double
   count — and reads them back through the real GET /api/cycle route. */
{
  reset();
  const FLOOR = 7;
  // A base58 signature the validator accepts (no 0, O, I or l), unique per fill.
  const sig = (n) => `Cohort${n}`.padEnd(64, "x");
  const p = beginCyclePass();
  const cycleId = p.cycle.id;
  const pubs = [];
  for (let i = 0; i < 3; i++)
    pubs.push(publishCall(clean(), { category: "memecoin", launchpad: "pump.fun",
      escalation: 0, cycleId }));
  ok("3 calls published into the cohort", pubs.every((r) => r.outcome === "published"),
    pubs.map((r) => `#${r.callId}`).join(" "));
  const [a, b, c] = pubs.map((r) => r.callId);
  // Offer each to the floor — the precondition recordExecutorFill enforces (a fill on a
  // call the desk never handed this floor is refused, copy.js).
  for (const id of [a, b, c])
    db.prepare("INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at) VALUES (?,?,?,?,?,?)")
      .run(id, FLOOR, "offered", "test fixture", 0.05, Date.now());

  const before = cycleStatus();
  ok("before any fill: deliverable 3, taken 0, exited 0 — offered is not taken",
    before.deliverable === 3 && before.taken === 0 && before.exited === 0 && before.published === 3,
    `published=${before.published} deliverable=${before.deliverable} taken=${before.taken} exited=${before.exited}`);

  // The bot buys two of the three and sells one of those, with the chain's numbers.
  const now = Date.now();
  const buyA = recordExecutorFill(FLOOR, { callId: a, side: "buy", signature: sig(1), at: now,
    sizeSol: 0.0175, lamportsIn: 17_500_000, entryMark: 0.001, solUsd: 210 });
  const buyB = recordExecutorFill(FLOOR, { callId: b, side: "buy", signature: sig(2), at: now + 1,
    sizeSol: 0.0175, lamportsIn: 17_500_000, entryMark: 0.001, solUsd: 210 });
  const sellA = recordExecutorFill(FLOOR, { callId: a, side: "sell", signature: sig(3), at: now + 2,
    sol: 0.021, realizedSol: 0.0035, fraction: 1, reason: "desk target hit", kind: "desk_exit" });
  ok("the bot's three reports were stored through the real writer",
    buyA?.side === "buy" && buyB?.side === "buy" && sellA?.side === "sell",
    `rows: #${buyA?.id} ${buyA?.side} call ${buyA?.call_id} · #${buyB?.id} ${buyB?.side} call ${buyB?.call_id} · #${sellA?.id} ${sellA?.side} call ${sellA?.call_id}`);
  // A second buy on the same call (a scale-in, or a retried report under a new
  // signature) is one more fill, not one more call taken.
  recordExecutorFill(FLOOR, { callId: a, side: "buy", signature: sig(4), at: now + 3,
    sizeSol: 0.01, lamportsIn: 10_000_000, entryMark: 0.00102, solUsd: 210 });
  const fillRows = db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n;
  // The third call was never executable: stamp its delivery the way the readiness gate will.
  db.prepare("UPDATE deliveries SET deliverable=0 WHERE call_id=?").run(c);

  const live = cycleExecution(cycleId);
  ok("live read: deliverable 2, taken 2, exited 1 — DISTINCT by call, over 4 fill rows",
    live.deliverable === 2 && live.taken === 2 && live.exited === 1 && fillRows === 4,
    `deliverable=${live.deliverable} taken=${live.taken} exited=${live.exited} (executor_fills rows=${fillRows})`);
  const st = cycleStatus();
  ok("...and cycleStatus carries the same three beside published",
    st.published === 3 && st.deliverable === 2 && st.taken === 2 && st.exited === 1,
    `published=${st.published} deliverable=${st.deliverable} taken=${st.taken} exited=${st.exited}`);

  // The real route, over real HTTP, while the cohort is still open.
  const { server } = startOffice(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const open = await hit("/api/cycle");
  ok("GET /api/cycle shows them on the OPEN cohort, beside published",
    open.status === 200 && open.body.current?.id === cycleId && open.body.current.published === 3 &&
    open.body.current.deliverable === 2 && open.body.current.taken === 2 && open.body.current.exited === 1,
    `HTTP ${open.status} current={published:${open.body.current?.published}, deliverable:${open.body.current?.deliverable}, ` +
    `taken:${open.body.current?.taken}, exited:${open.body.current?.exited}}`);

  // Close the cohort: closeCycleRow freezes the three into the row.
  closeCall(a, "target_hit", 0.002);
  closeCall(b, "stop_hit", 0.0005);
  closeCall(c, "thesis_expired", 0.0009);
  const row = db.prepare("SELECT * FROM cycles WHERE id=?").get(cycleId);
  console.log("  cycles row:", JSON.stringify(row));
  ok("closeCycleRow wrote taken_count 2 / exited_count 1 / deliverable_count 2 beside published_count 3",
    row.closed_at != null && row.published_count === 3 && row.deliverable_count === 2 &&
    row.taken_count === 2 && row.exited_count === 1,
    `published_count=${row.published_count} deliverable_count=${row.deliverable_count} ` +
    `taken_count=${row.taken_count} exited_count=${row.exited_count}`);
  const closed = await hit("/api/cycle");
  const h = closed.body.history.find((x) => x.id === cycleId);
  ok("GET /api/cycle shows them on the CLOSED cohort's history row",
    !!h && h.published === 3 && h.deliverable === 2 && h.taken === 2 && h.exited === 1 && h.open === false,
    `history[${cycleId}]={published:${h?.published}, deliverable:${h?.deliverable}, taken:${h?.taken}, exited:${h?.exited}, open:${h?.open}}`);

  /* A sell the bot reports AFTER the cohort closed still counts on read — a force-closed
     cohort's calls stay live and still get sold — while the row keeps the close-time
     snapshot. Both are facts; the surface shows the live one, the ledger the other. */
  recordExecutorFill(FLOOR, { callId: b, side: "sell", signature: sig(5), at: now + 4,
    sol: 0.009, realizedSol: -0.0085, fraction: 1, reason: "stop", kind: "risk_exit" });
  const later = (await hit("/api/cycle")).body.history.find((x) => x.id === cycleId);
  const rowLater = db.prepare("SELECT exited_count FROM cycles WHERE id=?").get(cycleId);
  ok("a sell reported after the close reads live (exited 2) and leaves the snapshot at 1",
    later.exited === 2 && rowLater.exited_count === 1,
    `history exited=${later.exited}, cycles.exited_count=${rowLater.exited_count}`);
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
