/**
 * THE OWNER-FACING COHORT SURFACE — /api/cycle, and the level stamped on every call.
 *
 * The owner's instruction is that every cycle produces at least three published calls
 * "at any cost, by any means", and that a new cycle begins once that cycle's calls have
 * closed. The engine (calls.js / penthouse.js / config.js) implements that as MORE
 * EFFORT and RELAXED JUDGEMENT on the recorded L0-L4 ladder, and never by crossing the
 * safety floor. This file tests the half the owner actually looks at, and it is written
 * around the two ways that half could quietly become a lie:
 *
 *   1. A QUOTA-FILLED CALL LOOKING LIKE A NORMAL ONE. The spec's words: "a reader must
 *      be able to see 'this was published at L3 because the cycle was short', never a
 *      silent lowering". copy.feedFor selects an explicit column list, so the cohort
 *      stamp is NOT on a feed row by default — the level had to be put back, and if it
 *      is ever dropped again every card on the floor silently reads as an L0.
 *   2. A GREEN NUMBER INSTEAD OF EVIDENCE. "Three of three published" is a number the
 *      desk can always reach by reaching further. What the owner needs is the cost of
 *      reaching it, so the strain signal is asserted with its actual counts.
 *
 * And the two invariants that outrank everything above, proved through this surface:
 *   - THE SAFETY FLOOR: no escalation level, for any quota, publishes a coin that
 *     failed a safety gate — driven at EVERY level from L0 to MAX_ESCALATION_LEVEL,
 *     over EVERY code in SAFETY_GATES that this harness can express.
 *   - THE DEADLOCK GUARD: one position that never closes cannot wedge the desk forever.
 *
 * THE DESK IS OUT OF API CREDIT, so none of this has been observed against a live
 * cycle. Everything here is a local server, a real SQLite ledger and real HTTP.
 *
 *   node test-cycle-surface.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(os.tmpdir(), "cycle-surface-test.db");
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}
process.env.EXECUTE = "0";

const db = (await import("./src/lib/store.js")).default;
const calls = await import("./src/calls.js");
const { publishCall, cohortEligibility } = await import("./src/penthouse.js");
const { CYCLE, MAX_ESCALATION_LEVEL, escalationPlan } = await import("./src/config.js");
const office = await import("./src/office.js");
const { startOffice, cycleStrain, cycleSurfacePayload, withEscalation,
        STRAIN_MIN_CYCLES, STRAIN_PCT } = office;
const { bus } = await import("./src/lib/bus.js");
const { railRisk } = await import("./src/desk.js");
const { recordDecision, gateFor } = await import("./src/evaluation.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const { server } = startOffice(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const hit = async (p) => {
  const r = await fetch(base + p);
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const FLOOR = 50;
/* Six tables carry a foreign key into calls (call_events, deliveries, alerts, fills,
   results, lessons). publishCall writes some of them, so a reset that only clears the
   first two fails on FOREIGN KEY 787 the moment a real publish has happened — which is
   exactly when the next block needs a clean ledger. Each delete is guarded because not
   every module that owns one of those tables is imported by this test. */
const reset = () => {
  for (const c of calls.liveCalls()) calls.closeCall(c.id, "test_reset", 1);
  /* forward_marks and simulated_outcomes carry a foreign key into decision_runs, so
     they go first; publishability and llm_spend are the two ledgers block 10 measures. */
  for (const t of ["call_events", "deliveries", "alerts", "fills", "results", "lessons",
                   "calls", "cycles", "forward_marks", "simulated_outcomes", "decision_runs",
                   "publishability", "llm_spend"]) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* table not created in this process */ }
  }
};
let seq = 0;
const mintFor = () => `Cyc${String(++seq).padStart(3, "0")}1111111111111111111111111111111111111`.slice(0, 43);

/** A record that clears every gate — the control against which a single injected
 *  safety failure is measured. Modelled on the shape penthouse.publishCall reads. */
const cleanRecord = (over = {}) => {
  const mint = over.mint || mintFor();
  return {
    mint, symbol: "CYC" + seq,
    outcome: "decided", finalDecision: "APPROVED", weighted: 71,
    pm: { decision: "PROPOSE", conviction: 68, thesis: "real ignition", invalidation: "deployer sells" },
    redteam: { verdict: "wounded", headline: "thin on holders" },
    compliance: { pass: true, violations: [] },
    risk: { position_size_usd: 50, stop_price: 0.00062, max_loss_usd: 20 },
    ceo: { ruling: "APPROVE", order_size_usd: 50 },
    order: { size: 50 },
    ticket: { stop_price: 0.00062, take_profit: [{ price: 0.0019 }] },
    ev: { symbol: "CYC" + seq, band: "low",
      pair: { priceUsd: 0.001, marketCap: 300_000, priceChange: { m5: 2 }, liquidityUsd: 90_000 },
      pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
      mintAccount: { flags: [] } },
    ...over,
  };
};

/* A call row written straight into the ledger. The surface's job is to READ the ledger
   correctly; forcing every fixture through the whole research chain would test the
   chain, not the surface. The safety-floor block below does the opposite — it drives
   the real publish path, because there the chain IS the thing under test. */
const seedCall = ({ cycleId = null, level = null, status = "live", entry = 0.001,
                    close = null, openedAt = Date.now() } = {}) => {
  const mint = mintFor();
  const info = db.prepare(`INSERT INTO calls
    (mint,symbol,category,status,conviction,entry_ref,stop,target,opened_at,cycle_id,escalation_level)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mint, mint.slice(0, 6), "memecoin", "live", 61, entry, entry * 0.7, entry * 2, openedAt,
      cycleId, level);
  const id = Number(info.lastInsertRowid);
  if (status === "closed")
    db.prepare("UPDATE calls SET status='closed', closed_at=?, close_reason=?, close_mark=? WHERE id=?")
      .run(openedAt + 60_000, "target_hit", close ?? entry, id);
  db.prepare("INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at) VALUES (?,?,?,?,?,?)")
    .run(id, FLOOR, "offered", "test fixture", 0.05, openedAt);
  return id;
};
const seedCycle = ({ quota = 3, level = 0, openedAt = Date.now(), closedAt = null,
                     shortfall = 0, forced = 0, passes = 1, forcedOpen = null } = {}) => {
  const info = db.prepare(`INSERT INTO cycles
    (opened_at,closed_at,quota,published_count,escalation_level_reached,shortfall,forced_close,passes,forced_open_ids)
    VALUES (?,?,?,0,?,?,?,?,?)`)
    .run(openedAt, closedAt, quota, level, shortfall, forced, passes,
      forcedOpen ? JSON.stringify(forcedOpen) : null);
  return Number(info.lastInsertRowid);
};

/* ══════════════════════════════════════════════════════════════════════════════════
   1 · THE ROUTE EXISTS, AND IT DESCRIBES A LADDER WITH NO L5
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE ROUTE, AND THE LADDER IT PUBLISHES");
{
  reset();
  const r = await hit("/api/cycle");
  ok("GET /api/cycle answers 200", r.status === 200, `HTTP ${r.status}`);
  ok("...with the desk's quota and its age guard",
    r.body?.quota === CYCLE.quota && r.body?.maxAgeMs === CYCLE.maxAgeMs,
    `quota=${r.body?.quota} (config ${CYCLE.quota}) maxAgeMs=${r.body?.maxAgeMs} (config ${CYCLE.maxAgeMs})`);
  ok("...and no open cycle reads as null, not as an error",
    r.body?.current === null, `current=${JSON.stringify(r.body?.current)}`);

  const ladder = r.body?.ladder || [];
  ok(`the ladder has exactly ${MAX_ESCALATION_LEVEL + 1} rungs, L0..L${MAX_ESCALATION_LEVEL}`,
    ladder.length === MAX_ESCALATION_LEVEL + 1 &&
    ladder.every((l, i) => l.level === i),
    `levels=${JSON.stringify(ladder.map((l) => l.level))}`);
  ok("...and there is no L5 on the wire",
    !ladder.some((l) => l.level > MAX_ESCALATION_LEVEL) && r.body?.maxLevel === MAX_ESCALATION_LEVEL,
    `maxLevel=${r.body?.maxLevel} highest rung=${Math.max(...ladder.map((l) => l.level))}`);
  ok("...each rung carries the config's own relaxation wording, not the page's",
    ladder.every((l, i) => JSON.stringify(l.relaxations) === JSON.stringify(escalationPlan(i).relaxations)),
    `L3 relaxations=${JSON.stringify(ladder[3]?.relaxations)}`);
  ok("L0 relaxes nothing", (ladder[0]?.relaxations || []).length === 0,
    `L0 relaxations=${JSON.stringify(ladder[0]?.relaxations)}`);
  /* THE ROUTE ITSELF SAYS A HIGHER LEVEL IS NOT A BETTER CALL. Said on the wire so no
     consumer of this payload — not just this page — can render them as equals. */
  ok("...and the payload states plainly that a higher level is not a better call",
    /not a better call/i.test(r.body?.note || "") && /safety floor is identical at every level/i.test(r.body?.note || ""),
    JSON.stringify(String(r.body?.note || "").slice(0, 120)));
}

/* ══════════════════════════════════════════════════════════════════════════════════
   2 · THE CURRENT CYCLE: QUOTA PROGRESS, THE LEVEL REACHED, AND THE HOLD
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE CURRENT CYCLE — progress, level, and whether it is holding");
{
  reset();
  const id = seedCycle({ quota: 3, level: 2, passes: 3 });
  seedCall({ cycleId: id, level: 0, status: "closed", entry: 0.001, close: 0.0012 });
  seedCall({ cycleId: id, level: 2, status: "live" });

  const { body } = await hit("/api/cycle");
  const cur = body.current;
  ok("the open cycle is served", cur && cur.id === id, `id=${cur?.id} expected ${id}`);
  ok("...with quota progress",
    cur.published === 2 && cur.quota === 3 && cur.short === 1,
    `published=${cur.published} quota=${cur.quota} short=${cur.short}`);
  ok("...with the level it has reached", cur.level === 2 && cur.label === escalationPlan(2).label,
    `level=L${cur.level} label=${cur.label}`);
  ok("...still pursuing, so it is not holding yet",
    cur.waiting === false && cur.pursuitOver === false,
    `waiting=${cur.waiting} pursuitOver=${cur.pursuitOver} passes=${cur.passes}`);
  ok("...and each of its calls carries the level it was published at",
    JSON.stringify(cur.calls.map((c) => c.escalationLevel)) === "[0,2]",
    `levels=${JSON.stringify(cur.calls.map((c) => c.escalationLevel))}`);

  /* NOW MEET THE QUOTA. Pursuit is over, one call is still live: the cohort holds the
     gate. This is the state that looks like a stalled desk from outside and is in fact
     the cohort model working, so the surface has to name it. */
  /* recordCyclePublish is the engine's own bookkeeping — the level a cycle "reached" is
     the MAX over what it published, and it is written there, not by the row insert. Use
     it rather than seeding escalation_level_reached by hand, or this asserts a fixture. */
  const third = seedCall({ cycleId: id, level: 3, status: "live" });
  calls.recordCyclePublish(id, third, 3);
  const held = (await hit("/api/cycle")).body.current;
  ok("quota met and a call still open ⇒ the cycle is HOLDING",
    held.waiting === true && held.pursuitOver === true,
    `published=${held.published}/${held.quota} waiting=${held.waiting} holdingFor=${JSON.stringify(held.holdingFor)}`);
  ok("...and it names exactly the calls it is holding for",
    held.holdingFor.length === 2,
    `holdingFor=${JSON.stringify(held.holdingFor)} (the two live rows)`);
  ok("...with the age guard's remaining time, not yet overdue",
    held.overdue === false && held.forceCloseInMs > 0 && held.forceCloseInMs <= CYCLE.maxAgeMs,
    `forceCloseInMs=${held.forceCloseInMs} maxAgeMs=${held.maxAgeMs} overdue=${held.overdue}`);
  ok("...and the highest level it reached is the cycle's level",
    held.level === 3, `level=L${held.level} call levels=${JSON.stringify(held.calls.map((c) => c.escalationLevel))}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   3 · THE ROUTE IS A READ. A GET MUST NOT MOVE THE GATE.
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE SURFACE READS THE LEDGER AND NEVER WRITES IT");
{
  reset();
  const id = seedCycle({ quota: 3, level: 4, passes: 5, openedAt: Date.now() - CYCLE.maxAgeMs - 60_000 });
  const stuck = seedCall({ cycleId: id, level: 4, status: "live" });
  const before = JSON.stringify(db.prepare("SELECT * FROM cycles ORDER BY id").all());
  const { body } = await hit("/api/cycle");
  const after = JSON.stringify(db.prepare("SELECT * FROM cycles ORDER BY id").all());
  ok("a cycle past its age guard is reported OVERDUE rather than force-closed by the read",
    body.current?.overdue === true && body.current?.forceCloseInMs === 0,
    `overdue=${body.current?.overdue} forceCloseInMs=${body.current?.forceCloseInMs} ageMs=${body.current?.ageMs} maxAgeMs=${CYCLE.maxAgeMs}`);
  ok("...and the cycles table is byte-for-byte unchanged by the GET",
    before === after, `changed=${before !== after}`);
  ok("...and the stuck call is untouched by the read",
    calls.getCall(stuck)?.status === "live", `status=${calls.getCall(stuck)?.status}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   4 · HISTORY: PER-CYCLE REALISED P&L, LEVELS, SHORTFALL, FORCE-CLOSE
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nHISTORY — what each cohort published, reached, and realised");
{
  reset();
  const a = seedCycle({ quota: 3, level: 0, closedAt: Date.now() - 300_000 });
  seedCall({ cycleId: a, level: 0, status: "closed", entry: 0.001, close: 0.0012 }); // +20%
  seedCall({ cycleId: a, level: 0, status: "closed", entry: 0.001, close: 0.0008 }); // -20%
  seedCall({ cycleId: a, level: 0, status: "closed", entry: 0.001, close: 0.0013 }); // +30%
  const b = seedCycle({ quota: 3, level: 4, closedAt: Date.now() - 100_000, shortfall: 1, forced: 1,
    forcedOpen: [999] });
  seedCall({ cycleId: b, level: 4, status: "closed", entry: 0.001, close: 0.0005 }); // -50%

  const { body } = await hit("/api/cycle");
  const rows = body.history;
  ok("both cycles are in the history, newest first",
    rows.length === 2 && rows[0].id === b && rows[1].id === a,
    `ids=${JSON.stringify(rows.map((r) => r.id))}`);
  const first = rows.find((r) => r.id === a);
  ok("a cohort's realised P&L is the mean of its closed calls",
    Math.abs(first.realisedPnlPct - 10) < 0.01,
    `realisedPnlPct=${first.realisedPnlPct} (expected mean of +20, -20, +30 = 10)`);
  ok("...and its levels are carried per call", JSON.stringify(first.levels) === "[0,0,0]",
    `levels=${JSON.stringify(first.levels)}`);
  const forced = rows.find((r) => r.id === b);
  ok("a short cohort is marked SHORT, not padded",
    forced.shortfall === true && forced.published === 1 && forced.quota === 3,
    `shortfall=${forced.shortfall} published=${forced.published}/${forced.quota}`);
  ok("...and a force-closed cohort names the ids that were still open",
    forced.forcedClose === true && JSON.stringify(forced.forcedOpenIds) === "[999]",
    `forcedClose=${forced.forcedClose} forcedOpenIds=${JSON.stringify(forced.forcedOpenIds)}`);
  ok("...and the level it had to reach", forced.levelReached === 4,
    `levelReached=L${forced.levelReached}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   5 · THE STRAIN SIGNAL — evidence, not a green number
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE STRAIN SIGNAL — is the funnel too tight, or the market bad?");
{
  const closedRow = (over = {}) => ({ id: 1, closedAt: 1, quota: 3, published: 3, levelReached: 0,
    shortfall: false, forcedClose: false, ...over });

  const tooFew = cycleStrain([closedRow(), closedRow({ levelReached: 4 })]);
  ok(`fewer than ${STRAIN_MIN_CYCLES} closed cycles is an anecdote, not a pattern`,
    tooFew.straining === false && tooFew.enough === false,
    `cycles=${tooFew.cycles} reachingPct=${tooFew.reachingPct}% straining=${tooFew.straining} headline=${JSON.stringify(tooFew.headline)}`);

  const calm = cycleStrain([closedRow(), closedRow(), closedRow(), closedRow({ levelReached: 1 })]);
  ok("four clean cohorts do not raise the signal",
    calm.straining === false && calm.reaching === 0,
    `cycles=${calm.cycles} reaching=${calm.reaching} (${calm.reachingPct}%) short=${calm.short} straining=${calm.straining}`);
  ok("...and the quiet case still shows its counts rather than a bare tick",
    /reached L3 or L4 in 0/.test(calm.headline) && /fell short of quota in 0/.test(calm.headline),
    JSON.stringify(calm.headline));

  const reaching = cycleStrain([closedRow({ levelReached: 3 }), closedRow({ levelReached: 4 }),
    closedRow({ levelReached: 0 }), closedRow({ levelReached: 0 })]);
  ok("regularly reaching L3/L4 raises the signal",
    reaching.straining === true && reaching.reaching === 2 && reaching.reachingPct === 50,
    `reaching=${reaching.reaching}/${reaching.cycles} = ${reaching.reachingPct}% (bar ${STRAIN_PCT}%) straining=${reaching.straining}`);
  ok("...and the sentence names the remedy that is NOT available",
    /not a reason to lower the safety floor/i.test(reaching.headline),
    JSON.stringify(reaching.headline));

  const short = cycleStrain([closedRow({ shortfall: true, published: 1 }),
    closedRow({ shortfall: true, published: 2 }), closedRow(), closedRow(), closedRow()]);
  ok("regularly falling short raises the signal on its own, with no L3 anywhere",
    short.straining === true && short.reaching === 0 && short.shortPct === 40,
    `short=${short.short}/${short.cycles} = ${short.shortPct}% reaching=${short.reaching} straining=${short.straining}`);

  /* AN OPEN CYCLE MUST NOT COUNT. It has not finished escalating, so counting it would
     report a healthy desk as straining every time a cohort opens at L0. */
  const withOpen = cycleStrain([closedRow({ levelReached: 3 }), closedRow(), closedRow(),
    { id: 9, closedAt: null, quota: 3, published: 0, levelReached: 0, shortfall: true, forcedClose: false }]);
  ok("an open cycle is excluded from the strain window",
    withOpen.cycles === 3 && withOpen.short === 0,
    `cycles counted=${withOpen.cycles} (4 rows, 1 open) short=${withOpen.short}`);

  /* End to end, through the route. */
  reset();
  for (let i = 0; i < 4; i++) {
    const id = seedCycle({ quota: 3, level: i < 2 ? 4 : 0, closedAt: Date.now() - (10 - i) * 1000,
      shortfall: i < 2 ? 1 : 0 });
    seedCall({ cycleId: id, level: i < 2 ? 4 : 0, status: "closed", entry: 0.001, close: 0.0009 });
  }
  const { body } = await hit("/api/cycle");
  ok("the route reports the strain with its evidence",
    body.strain.straining === true && body.strain.cycles === 4 && body.strain.reaching === 2,
    `cycles=${body.strain.cycles} reaching=${body.strain.reaching} (${body.strain.reachingPct}%) short=${body.strain.short} (${body.strain.shortPct}%)`);
  ok("...and says so in words the owner can act on",
    /quota is straining/i.test(body.strain.headline) && /funnel is too tight or the market is bad/i.test(body.strain.headline),
    JSON.stringify(body.strain.headline));
}

/* ══════════════════════════════════════════════════════════════════════════════════
   6 · THE LEVEL TRAVELS WITH THE CALL, onto the floor feed
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nEVERY CALL CARRIES THE LEVEL IT WAS PUBLISHED AT");
{
  reset();
  const id = seedCycle({ quota: 3, level: 3 });
  const l0 = seedCall({ cycleId: id, level: 0 });
  const l3 = seedCall({ cycleId: id, level: 3 });
  const outside = seedCall({ cycleId: null, level: null });

  const r = await hit(`/api/floor/${FLOOR}/feed?limit=50`);
  ok("the house floor feed answers", r.status === 200, `HTTP ${r.status}`);
  const byId = new Map((r.body.feed || []).map((row) => [row.call_id, row]));
  ok("an L0 call carries escalation_level 0",
    byId.get(l0)?.escalation_level === 0 && byId.get(l0)?.cycle_id === id,
    `escalation_level=${byId.get(l0)?.escalation_level} cycle_id=${byId.get(l0)?.cycle_id}`);
  ok("an L3 call carries escalation_level 3 — the card cannot render it as an L0",
    byId.get(l3)?.escalation_level === 3,
    `escalation_level=${byId.get(l3)?.escalation_level}`);
  /* NULL IS NOT ZERO. A call published outside a cohort had no quota pursuing it; a
     defaulted 0 would claim the desk cleared its normal bar under a quota it never had. */
  ok("a call published outside any cycle carries NULL, never 0",
    byId.get(outside)?.escalation_level === null && byId.get(outside)?.cycle_id === null,
    `escalation_level=${JSON.stringify(byId.get(outside)?.escalation_level)} cycle_id=${JSON.stringify(byId.get(outside)?.cycle_id)}`);

  /* The stamp is additive: nothing else on the row may change. */
  const raw = (await import("./src/copy.js")).feedFor(FLOOR, 50);
  const stamped = withEscalation(raw);
  const dropped = Object.keys(raw[0] || {}).filter((k) => !(k in (stamped[0] || {})));
  ok("withEscalation adds two columns and removes none",
    dropped.length === 0 && "escalation_level" in stamped[0] && "cycle_id" in stamped[0],
    `dropped=${JSON.stringify(dropped)} added=${JSON.stringify(Object.keys(stamped[0]).filter((k) => !(k in raw[0])))}`);
  ok("...and it survives an empty feed without throwing",
    JSON.stringify(withEscalation([])) === "[]", `withEscalation([])=${JSON.stringify(withEscalation([]))}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   7 · THE SAFETY FLOOR — no level, for any quota, publishes a safety-failed coin
   ══════════════════════════════════════════════════════════════════════════════════
   The measurement this whole design comes from: of the last 100 kills ~60 are safety
   MECHANICS, not opinions — 18 cannot_exit, where the round-trip probe PROVED the
   position cannot be sold. Filling three from that pool is three bags, not three
   trades, and defeats the quota's own purpose. So this is driven through the REAL
   publish path at EVERY level from L0 to MAX_ESCALATION_LEVEL, and the surface is
   re-read afterwards to prove nothing reached it. */
console.log("\nTHE SAFETY FLOOR — driven at every level, for a real quota");
{
  reset();
  const cycleId = seedCycle({ quota: 3, level: 0, passes: 1 });

  /* One injected safety failure per case, on an otherwise perfect record, in the SHAPE
     THE PIPELINE ACTUALLY PRODUCES. The free screen (data/evidence.js) reports its
     verdicts as outcome:"screened_out" with a `fails` list — cannot_exit is raised
     there, at line 253, from the round-trip probe — so expressing it as a hand-built
     "decided" record with a bad exitProbe would test a record no lane can emit.
     Measured while writing this: such a record DOES publish (see openIssues); it is
     recorded there rather than asserted here, because asserting it would be asserting
     against an input the desk cannot generate. */
  const cases = [
    // the 18-of-100 kill: the round-trip probe PROVED the position cannot be sold
    ["cannot_exit", { outcome: "screened_out", fails: [{ code: "cannot_exit",
      detail: "round-trip loss 97% > ceiling 12%" }] }],
    ["mintable", { outcome: "screened_out", fails: [{ code: "mintable", detail: "mint authority present" }] }],
    ["freezable", { outcome: "screened_out", fails: [{ code: "freezable", detail: "freeze authority present" }] }],
    ["serial_deployer", { outcome: "screened_out", fails: [{ code: "serial_deployer", detail: "16 launches, 16 dead" }] }],
    ["post_migration_dump", { outcome: "screened_out", fails: [{ code: "post_migration_dump", detail: "graduate dead zone" }] }],
    ["holder_concentration", { outcome: "screened_out", fails: [{ code: "holder_concentration", detail: "one wallet holds 54%" }] }],
    ["thin_liquidity", { outcome: "screened_out", fails: [{ code: "thin_liquidity", detail: "below the band floor" }] }],
    // the reputation seat's FACT arm — the other arm of the very gate L3 relaxes
    ["deployer_has_rugged", { outcome: "killed", killedBy: "xread", killArm: "serial_rugger",
      reason: "this deployer's own account has rugged before" }],
    ["analyst_kill", { outcome: "killed", killedBy: "redteam", reason: "hard kill" }],
    // the veto that exists because the executor refused four consecutive real calls
    ["compliance stop_inside_costs", { compliance: { pass: false, violations: [{ code: "stop_inside_costs",
      detail: "the round trip alone would trigger the stop" }] } }],
    ["no_stop", { ticket: { stop_price: null }, risk: { position_size_usd: 50, stop_price: null } }],
    ["stop_at_or_above_entry", { ticket: { stop_price: 0.002, take_profit: [{ price: 0.003 }] },
      risk: { position_size_usd: 50, stop_price: 0.002 } }],
  ];

  let publishedAnything = false;
  let checked = 0, flooredHere = 0;
  const notFloored = [];
  for (const [label, over] of cases) {
    for (let level = 0; level <= MAX_ESCALATION_LEVEL; level++) {
      const rec = cleanRecord(over);
      const verdict = cohortEligibility(rec, level);
      const result = publishCall(rec, { category: "memecoin", escalation: level, cycleId });
      checked++;
      /* THE FLOOR ITSELF MUST BE WHAT REFUSED IT. `publishable === false` alone is not
         proof: mandate.eligibility() runs second and independently refuses a killed or
         screened record, so a regression that deleted the safety check entirely would
         still leave every one of these unpublished — and the next record shape that
         mandate happens not to catch would go straight through. Mutation-checked:
         emptying the safety filter at L4 leaves the outcome unchanged and moves the
         refusal's authorship, which is exactly what this counter reads. The string
         comes from cohortEligibility's floor branch and from nowhere else. */
      const byFloor = /^SAFETY FLOOR \(L\d\)/.test(String(verdict.reason || ""));
      if (byFloor) flooredHere++; else notFloored.push(`${label}@L${level}:${verdict.gate}`);
      const refused = verdict.publishable === false && verdict.safety === true &&
        result?.outcome !== "published";
      if (!refused) {
        publishedAnything = true;
        ok(`${label} refused at L${level}`, false,
          `publishable=${verdict.publishable} safety=${verdict.safety} gate=${verdict.gate} outcome=${result?.outcome}`);
      }
    }
  }
  ok(`every safety case is refused at every level L0..L${MAX_ESCALATION_LEVEL}`,
    !publishedAnything, `${checked} (case × level) combinations driven, published=${publishedAnything ? "SOME" : 0}`);
  ok("...and the SAFETY FLOOR is what refused every one of them, not a downstream gate",
    flooredHere === checked,
    `refused by the floor=${flooredHere}/${checked}; refused elsewhere=${JSON.stringify(notFloored)}`);

  /* THE FULL CODE LIST, through the classification itself. gateFailures is what the
     floor consults, so every SAFETY code it can name must veto at the top level. */
  const topLevelSurvivors = calls.SAFETY_GATES.filter((code) =>
    cohortEligibility({ outcome: "screened_out", fails: [{ code, detail: "injected" }] },
      MAX_ESCALATION_LEVEL).publishable !== false);
  ok(`all ${calls.SAFETY_GATES.length} SAFETY codes still veto at L${MAX_ESCALATION_LEVEL}`,
    topLevelSurvivors.length === 0, `survivors=${JSON.stringify(topLevelSurvivors)}`);

  /* AND THE SURFACE AGREES: nothing was published, the cycle is still 0 of 3. */
  const { body } = await hit("/api/cycle");
  ok("the surface shows the cycle still at 0 of 3 after every one of those attempts",
    body.current?.published === 0 && body.current?.short === 3 &&
    db.prepare("SELECT COUNT(*) n FROM calls").get().n === 0,
    `published=${body.current?.published}/${body.current?.quota} calls in ledger=${db.prepare("SELECT COUNT(*) n FROM calls").get().n}`);

  /* THE TWO ARMS OF THE SAME SEAT. L3's whole content is "accept a coin the X read
     called MANUFACTURED" — a model's opinion about attention. The other arm of that
     seat, "this deployer has rugged before", is a FACT and stays refused at L4. If both
     arms behaved the same, either the floor is too blunt or L3 does nothing. */
  const manufactured = () => cleanRecord({ outcome: "killed", killedBy: "xread",
    killArm: "manufactured", reason: "the story is manufactured" });
  /* WHERE THE WAIVER LIVES, measured rather than assumed: the plan carries it and
     desk.js applies it BEFORE the record is killed (desk.js:177, `waived`). So the
     ladder never resurrects an already-killed record — it stops the kill happening. */
  const knob = [0, 1, 2, 3, 4].map((l) => escalationPlan(l).acceptManufacturedNarrative);
  ok("only L3 and above carries the manufactured-narrative waiver",
    JSON.stringify(knob) === "[false,false,false,true,true]",
    `acceptManufacturedNarrative by level = ${JSON.stringify(knob)}`);
  const killedAtL4 = cohortEligibility(manufactured(), MAX_ESCALATION_LEVEL);
  ok("...and a record that WAS killed stays refused at every level — no level resurrects a kill",
    [0, 1, 2, 3, 4].every((l) => cohortEligibility(manufactured(), l).publishable === false),
    `L4 publishable=${killedAtL4.publishable} gate=${killedAtL4.gate} reason=${JSON.stringify(String(killedAtL4.reason).slice(0, 80))}`);
  const rugger = cohortEligibility(cleanRecord({ outcome: "killed", killedBy: "xread",
    killArm: "serial_rugger", reason: "rugged before" }), MAX_ESCALATION_LEVEL);
  ok("...while the serial_rugger arm of that same seat stays refused at the top level",
    rugger.publishable === false && rugger.safety === true && rugger.gate === "deployer_has_rugged",
    `publishable=${rugger.publishable} safety=${rugger.safety} gate=${rugger.gate}`);

  /* THE CONTROL. The same harness DOES publish a clean record — otherwise the block
     above proves only that publishCall never publishes anything. */
  const clean = publishCall(cleanRecord(), { category: "memecoin", escalation: MAX_ESCALATION_LEVEL, cycleId });
  ok("...while a clean record at the same level publishes normally",
    clean?.outcome === "published" && clean?.level === MAX_ESCALATION_LEVEL,
    `outcome=${clean?.outcome} level=L${clean?.level} callId=${clean?.callId}`);
  const stamped = calls.getCall(clean.callId);
  ok("...and it is stamped with the cycle and the level on the row itself",
    stamped.cycle_id === cycleId && stamped.escalation_level === MAX_ESCALATION_LEVEL,
    `cycle_id=${stamped.cycle_id} escalation_level=${stamped.escalation_level}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   8 · THE DEADLOCK GUARD — a stuck position cannot wedge the desk forever
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE DEADLOCK GUARD — one position that never closes must not stop the desk");
{
  reset();
  /* A cohort that met its quota and holds one position that never closes. Backdated
     past CYCLE_MAX_AGE_MS: this is the exact failure the guard exists for. */
  const id = seedCycle({ quota: 1, level: 2, passes: 2, openedAt: Date.now() - CYCLE.maxAgeMs - 60_000 });
  const stuck = seedCall({ cycleId: id, level: 2, status: "live",
    openedAt: Date.now() - CYCLE.maxAgeMs - 60_000 });

  const before = (await hit("/api/cycle")).body;
  ok("before the desk passes, the surface shows it holding and OVERDUE",
    before.current?.id === id && before.current?.waiting === true && before.current?.overdue === true,
    `id=${before.current?.id} waiting=${before.current?.waiting} overdue=${before.current?.overdue} ageMs=${before.current?.ageMs} > maxAgeMs=${CYCLE.maxAgeMs}`);

  /* The desk's own lane settles. calls.beginCyclePass does this at the top of every
     pursuit pass; here it is called directly so the guard is what is under test. */
  const settled = calls.settleCycles(Date.now());
  ok("the age guard force-closes it", settled.length === 1 && settled[0].id === id &&
    settled[0].forced_close === 1,
    `settled=${settled.length} id=${settled[0]?.id} forced_close=${settled[0]?.forced_close}`);

  const next = calls.beginCyclePass({ now: Date.now() });
  ok("the next cycle opens immediately and starts back at L0",
    next.waiting === false && next.cycle.id !== id && next.level === 0,
    `newCycle=${next.cycle?.id} (old ${id}) level=L${next.level} waiting=${next.waiting}`);

  /* THE PART THAT MATTERS. The stuck call was NOT cancelled: it stays live and keeps
     being monitored and exited by the normal lanes. It stopped holding the gate; it
     did not stop being a position. */
  const row = calls.getCall(stuck);
  ok("the stuck call is STILL LIVE — the guard released the gate, not the position",
    row.status === "live" && row.closed_at === null,
    `status=${row.status} closed_at=${row.closed_at}`);
  ok("...and it is still on the live book the monitor walks",
    calls.liveCalls().some((c) => c.id === stuck),
    `liveCalls=${JSON.stringify(calls.liveCalls().map((c) => c.id))}`);

  const after = (await hit("/api/cycle")).body;
  const forcedRow = after.history.find((c) => c.id === id);
  ok("the surface records the force-close, with the id that was still open",
    forcedRow?.forcedClose === true && JSON.stringify(forcedRow.forcedOpenIds) === JSON.stringify([stuck]),
    `forcedClose=${forcedRow?.forcedClose} forcedOpenIds=${JSON.stringify(forcedRow?.forcedOpenIds)} stuck=${stuck}`);
  ok("...and says why, in the ledger's own words",
    /force-closed at \d+m/.test(forcedRow?.closeReason || "") && /still live and still monitored/.test(forcedRow?.closeReason || ""),
    JSON.stringify(forcedRow?.closeReason));
  ok("...and the desk is open for business again",
    after.current?.id === next.cycle.id && after.current?.published === 0 && after.current?.level === 0,
    `current=${after.current?.id} published=${after.current?.published}/${after.current?.quota} level=L${after.current?.level}`);

  /* A CYCLE THAT PUBLISHED NOTHING HOLDS THE GATE FOR NOTHING. The other half of the
     deadlock: on a bad night the desk would otherwise stop exactly when it can least
     afford to. */
  reset();
  const empty = calls.openNewCycle({ quota: 3 });
  db.prepare("UPDATE cycles SET passes=? WHERE id=?").run(MAX_ESCALATION_LEVEL + 2, empty.id);
  const closedEmpty = calls.settleCycles(Date.now());
  ok("a cycle that published ZERO calls closes at once and holds nothing",
    closedEmpty.some((c) => c.id === empty.id && c.closed_at != null && c.forced_close === 0),
    `closed=${JSON.stringify(closedEmpty.map((c) => ({ id: c.id, closed: c.closed_at != null, forced: c.forced_close })))}`);
  const surface = (await hit("/api/cycle")).body;
  ok("...and the surface shows it closed, short, with nothing invented to fill it",
    surface.history.find((c) => c.id === empty.id)?.published === 0 &&
    surface.history.find((c) => c.id === empty.id)?.shortfall === true,
    `published=${surface.history.find((c) => c.id === empty.id)?.published} shortfall=${surface.history.find((c) => c.id === empty.id)?.shortfall}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   9 · THE PAYLOAD BUILDER IS PURE, and matches what the route serves
   ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE BUILDER AND THE ROUTE AGREE");
{
  const direct = cycleSurfacePayload(Date.now(), 20);
  const { body } = await hit("/api/cycle?limit=20");
  ok("cycleSurfacePayload and GET /api/cycle describe the same ledger",
    JSON.stringify(direct.history) === JSON.stringify(body.history) &&
    direct.strain.straining === body.strain.straining,
    `historyRows=${direct.history.length} vs ${body.history.length} straining=${direct.strain.straining}/${body.strain.straining}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
   10 · PUBLISHED PER PM-POSITIVE — the haircut every quota estimate assumed
   ══════════════════════════════════════════════════════════════════════════════════
   Every "P(>=3 calls per cohort)" number runs on the PM-positive rate (224 WATCH or
   PROPOSE / 1,571 paid reads = 14.3% all-time) times a publishable fraction nobody has
   measured under the recalibrated bar: 58 published / 224 PM-positive = 26% under the
   OLD bars, and today 13 WATCH verdicts became 0 cohort calls with no counter naming
   the gate. Three fixtures, one per outcome the plan itemises, through the REAL publish
   path; the ledger, the surface and the emit are then read back with their counts. */
console.log("\nPUBLISHED PER PM-POSITIVE — what the PM's yeses became at the gate");
{
  reset();
  const cycleId = seedCycle({ quota: 3, level: 0, passes: 1 });
  /* The bar comes from the config, not a literal: "conviction 18" in the plan is
     18 because CYCLE_MIN_CONVICTION is 20. If the owner moves the bar the fixture
     moves with it and the PROPERTY (two under the bar is refused) still holds. */
  const bar = escalationPlan(0).minConviction;
  const seen = [];
  const onEvent = (ev) => { if (ev.type === "risk:mechanical_zero") seen.push(ev); };
  bus.on("event", onEvent);

  /* (a) A WATCH two points under the L0 bar. No CEO, no order — a WATCH never reaches
     the CEO, so its only size is Risk's, exactly as desk.js leaves it. */
  const low = cleanRecord({ finalDecision: "WATCH",
    pm: { decision: "WATCH", conviction: bar - 2, thesis: "early", invalidation: "loses the launch low" },
    ceo: undefined, order: undefined });
  const rLow = publishCall(low, { category: "memecoin", escalation: 0, cycleId });
  ok(`a WATCH at conviction ${bar - 2} is refused on conviction_below_bar (L0 bar ${bar})`,
    rLow.outcome === "declined" && rLow.gate === "conviction_below_bar",
    `outcome=${rLow.outcome} gate=${rLow.gate} conviction=${low.pm.conviction} bar=${bar}`);

  /* (b) A mechanical zero from the REAL rails, in the shape the pipeline produces: the
     exit probe never completed, so enforceRiskRails sizes it to $0 — and because the
     ticket is only drafted when the size is positive (desk.js stage 10), there is no
     stop either. That second fact is why the attribution below exists. */
  const zeroMint = mintFor();
  const zeroEv = { symbol: "ZERO", band: "low",
    pair: { priceUsd: 0.001, marketCap: 300_000, priceChange: { m5: 2 }, liquidityUsd: 90_000 },
    pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { error: "no route at any size" },
    mintAccount: { flags: [] } };
  const modelRisk = { risk_tier: "half", confidence: 0.7, stop_price: 0.00062, position_size_usd: 40 };
  const railed = railRisk({ risk: modelRisk, ev: zeroEv, redteam: { verdict: "wounded" },
    mint: zeroMint, symbol: "ZERO" });
  ok("the rails size an unproven exit to $0 and say so in a rail note",
    railed.position_size_usd === 0 && (railed.rail_notes || []).some((n) => /^mechanical zero/.test(n)),
    `position_size_usd=${railed.position_size_usd} (model asked ${modelRisk.position_size_usd}) notes=${JSON.stringify(railed.rail_notes)}`);
  ok("...and risk:mechanical_zero was emitted exactly once, with the rail's own reason",
    seen.length === 1 && seen[0].mint === zeroMint && /^mechanical zero/.test(seen[0].reason),
    `emitted=${seen.length} reason=${JSON.stringify(seen[0]?.reason)} modelSize=${seen[0]?.modelSize}`);
  const zero = cleanRecord({ mint: zeroMint, symbol: "ZERO", finalDecision: "WATCH",
    pm: { decision: "WATCH", conviction: bar + 13, thesis: "real ignition", invalidation: "deployer sells" },
    risk: railed, ceo: undefined, order: undefined, ticket: null, ev: zeroEv });
  const coZero = cohortEligibility(zero, 0);
  const rZero = publishCall(zero, { category: "memecoin", escalation: 0, cycleId });
  ok("the zero-sized WATCH is refused by the SAFETY floor, not by the conviction bar",
    rZero.outcome === "unsafe" && coZero.safety === true && /^SAFETY FLOOR \(L0\)/.test(coZero.reason),
    `outcome=${rZero.outcome} refusedBy=${coZero.gate} gates=${JSON.stringify(coZero.gates)} conviction=${zero.pm.conviction}`);

  /* (c) The control: a clean record publishes. Last, so the one-position book can
     never be what refused (a) or (b). */
  const clean = cleanRecord();
  const rClean = publishCall(clean, { category: "memecoin", escalation: 0, cycleId });
  ok("a clean PROPOSE publishes", rClean.outcome === "published",
    `outcome=${rClean.outcome} callId=${rClean.callId}`);
  bus.off("event", onEvent);

  /* (d) NOT A PM-POSITIVE, NOT IN THE DENOMINATOR. A PASS goes through the same gate and
     must leave no row, or "published per PM-positive" silently becomes "published per
     anything" and the fraction is wrong in the flattering direction. */
  const rowsBefore = db.prepare("SELECT COUNT(*) n FROM publishability").get().n;
  publishCall(cleanRecord({ finalDecision: "PASS",
    pm: { decision: "PASS", conviction: 40, thesis: "no", invalidation: "n/a" } }),
    { category: "memecoin", escalation: 0, cycleId });
  const rowsAfter = db.prepare("SELECT COUNT(*) n FROM publishability").get().n;
  ok("a PM PASS writes no publishability row — the denominator is PM-positive only",
    rowsBefore === 3 && rowsAfter === 3, `rows before=${rowsBefore} after=${rowsAfter}`);

  /* THE SURFACE. Exactly the three columns, one each. */
  const { status, body } = await hit("/api/cycle");
  const hist = body?.publishablePerPmPositive;
  ok("GET /api/cycle carries publishablePerPmPositive", status === 200 && hist && typeof hist === "object",
    `HTTP ${status} publishablePerPmPositive=${JSON.stringify(hist)}`);
  ok("...reading {published:1, conviction_below_bar:1, zero_authorized_size:1}",
    JSON.stringify(Object.fromEntries(Object.entries(hist || {}).sort())) ===
      JSON.stringify({ conviction_below_bar: 1, published: 1, zero_authorized_size: 1 }),
    JSON.stringify(hist));
  ok("...with the fraction beside it: 1 published of 3 PM-positive",
    body.publishableFraction?.pmPositive === 3 && body.publishableFraction?.published === 1 &&
      Math.abs(body.publishableFraction?.f - 1 / 3) < 0.001,
    `publishableFraction=${JSON.stringify(body.publishableFraction)}`);
  ok("...and the open cohort carries its own slice, which here is all of it",
    JSON.stringify(body.current?.publishablePerPmPositive) === JSON.stringify(hist),
    `current.publishablePerPmPositive=${JSON.stringify(body.current?.publishablePerPmPositive)}`);
  /* THE ATTRIBUTION, ON THE ROW. The floor refused the zero on `no_stop` (it sorts first
     in gateFailures, and there IS no stop); the histogram charges it to the rails. Both
     facts are on the row, so nothing is hidden by the choice of column. */
  const zeroRow = db.prepare("SELECT gate, refused_by, gates, pm_decision, conviction, outcome FROM publishability WHERE mint=?").get(zeroMint);
  ok("the mechanical zero is charged to zero_authorized_size with the raw gate kept beside it",
    zeroRow?.gate === "zero_authorized_size" && zeroRow?.refused_by === coZero.gate &&
      JSON.parse(zeroRow?.gates || "[]").includes("zero_authorized_size"),
    `gate=${zeroRow?.gate} refused_by=${zeroRow?.refused_by} gates=${zeroRow?.gates} pm=${zeroRow?.pm_decision}@${zeroRow?.conviction} outcome=${zeroRow?.outcome}`);

  /* THE DECISION HISTOGRAM — the calibration SIM C reads. decision_runs is written by
     desk.workup via recordDecision; drive the same function with the three fixtures
     plus the three other endings a workup has, and require the route to return the
     EXACT binding_gate strings gateFor stamps — derived from the source, not retyped. */
  const endings = [
    ["clean", clean], ["low", low], ["zero", zero],
    ["refuted", cleanRecord({ finalDecision: "WATCH", redteam: { verdict: "refuted", headline: "the float is bundled" },
      pm: { decision: "WATCH", conviction: 30, thesis: "x", invalidation: "y" } })],
    ["killed", { mint: mintFor(), outcome: "killed", killedBy: "Flow", reason: "one wallet is the tape" }],
    ["screened", { mint: mintFor(), outcome: "screened_out", fails: [{ code: "mintable", detail: "mint authority present" }] }],
  ];
  const expectedGates = new Set(endings.map(([, r]) => gateFor(r)));
  for (const [, r] of endings) recordDecision("cycle-histogram", r, Date.now());
  const t = Date.now();
  db.prepare("INSERT INTO llm_spend (seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,?,?,?,?,?,?,?)")
    .run("XRead", "grok-4.6", null, 12_000, 400, 0, 0.15, t - 1000);
  db.prepare("INSERT INTO llm_spend (seat,model,effort,in_tok,out_tok,cached_tok,usd,ts,floor) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("Red Team", "claude-opus-5", "high", 30_000, 10_500, 1_200, 0.37, t, 50);

  const h = await hit("/api/decisions/histogram?hours=24");
  ok("GET /api/decisions/histogram answers 200", h.status === 200, `HTTP ${h.status}`);
  const gotGates = new Set((h.body?.decisions || []).map((r) => r.binding_gate));
  ok("...with exactly the binding_gate strings gateFor produces",
    [...expectedGates].every((g) => gotGates.has(g)) && [...gotGates].every((g) => expectedGates.has(g)),
    `expected=${JSON.stringify([...expectedGates].sort())} got=${JSON.stringify([...gotGates].sort())}`);
  const total = (h.body?.decisions || []).reduce((a, r) => a + r.n, 0);
  const watchRow = (h.body?.decisions || []).find((r) => r.binding_gate === "WATCH" && r.final_decision === "WATCH");
  ok("...grouped by outcome × final_decision × binding_gate, with counts that add up",
    total === endings.length && watchRow?.n === 2 && watchRow?.outcome === "decided",
    `rows=${JSON.stringify(h.body?.decisions?.map((r) => [r.outcome, r.final_decision, r.binding_gate, r.n]))} total=${total}`);
  const spendRows = h.body?.llmSpend || [];
  const keysOf = (r) => JSON.stringify(Object.keys(r).sort());
  ok("...and the per-row llm_spend carries exactly {seat, model, effort, usd, ts} — no floor, no prompt",
    spendRows.length === 2 && spendRows.every((r) => keysOf(r) === JSON.stringify(["effort", "model", "seat", "ts", "usd"])),
    `rows=${JSON.stringify(spendRows)}`);
  ok("...with the measured tails intact rather than a mean",
    JSON.stringify(spendRows.map((r) => r.usd).sort((a, b) => a - b)) === JSON.stringify([0.15, 0.37]),
    `usd=${JSON.stringify(spendRows.map((r) => r.usd))}`);
  ok("...and the same publishable histogram the cycle surface shows",
    JSON.stringify(h.body?.publishablePerPmPositive) === JSON.stringify(hist),
    `route=${JSON.stringify(h.body?.publishablePerPmPositive)} cycle=${JSON.stringify(hist)}`);
  const post = await fetch(base + "/api/decisions/histogram", { method: "POST", body: "{}" });
  ok("...and it is GET only", post.status === 405, `POST → HTTP ${post.status}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} assertion(s) failed`);
console.log("the cohort surface serves the cycle, the level on every call, and the strain — " +
  "and no level publishes past the safety floor. UNPROVEN AGAINST A LIVE CYCLE: the desk is out of API credit.");
