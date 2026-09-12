/**
 * AN ENTRY ALERT IS A CLOCK, AND A CLOCK HANDED TO A BOT THAT CANNOT ACT IS SPENT.
 *
 * The alert row's created_at is what the feed serves as the event's `ts` (office.js
 * executorFeedPayload), and `ts` is what the bot's expiry is judged against
 * (poller.mjs callExpiryMs). So raising an entry while the floor's bot is paused,
 * hard-stopped, holding an unresolved blocking intent, rolled back off the feed,
 * un-rehearsed, absent, or already in this very mint does not queue the call — it ages
 * it. Under a blocking intent the whole batch is deferred and replayed against that same
 * clock, and a nano call (a 90s window over a 60s hold) is dead before the intent clears.
 *
 * Holding costs nothing: the delivery row is already durable, and the bot's own feed poll
 * runs reconcileMissingEntryAlerts, which re-raises the entry with a FRESH created_at —
 * a full window rather than the remains of one. Past the band's own window the entry is
 * dead however healthy the bot becomes, so the delivery is stamped not_executable
 * (deliverable=0) and never raised, which is how the cohort ledger tells a bot that was
 * down from a bot that declined.
 *
 * This file drives all seven machine-state reasons plus the geometry gate on real rows,
 * asserts the alert timestamps directly, and pins the two things the gate must NOT touch:
 * the quota count (recordCyclePublish) and a floor that has no bot at all.
 */

/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE — same guard as test-hq-executor.mjs.
   scripts/test-all.mjs points CLAUDE_CO_DB at a throwaway file; running this file on its
   own would otherwise fall back to ./claude-co.db (src/lib/store.js), which this test
   writes calls, deliveries and alerts into. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-alert-readiness-" + process.pid + ".db");

import db from "./src/lib/store.js";
import { bus } from "./src/lib/bus.js";
import { openCall, closeCall, liveCalls, noteEvent, getCall,
  beginCyclePass, recordCyclePublish, cycleStatus } from "./src/calls.js";
import { settingsFor } from "./src/copy.js";
import { announceEntry, reconcileMissingEntryAlerts, executorReadiness,
  ENTRY_HOLD_REASONS, READINESS_PROOF_GRACE_MS } from "./src/alerts.js";
import { CAP_BANDS } from "./src/bands.js";
import { entryWindowMs } from "./executor/entry-contract.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 11;            // has a bot
const BARE_FLOOR = 12;       // never posted a pulse
const MICRO_MCAP = 40_000;   // CAP_BANDS.micro — a 20-minute minimum hold
const WINDOW_MS = entryWindowMs({ holdMinMs: CAP_BANDS.micro.holdMinMs });

/* The heartbeat the poller posts when everything is armed, in the shape
   office.js sanitizeExecutorHealth stores. */
const healthyHealth = (now) => ({
  state: "healthy", entriesPaused: false, hardStop: false, blockingIntent: false,
  blockedPositions: 0, manualAction: false, exitBlocked: false,
  lastTickCompletedAt: now, lastFeedSuccessAt: now,
  consecutiveFeedFailures: 0, consecutiveTickFailures: 0, feedRollback: false,
  executionReadiness: { ready: true, lastSuccessAt: now, observedAt: now,
    route: "wsol-usdc", providers: 2, amountLamports: 400_000_000, lastError: null },
  caps: null, runtimeCommit: null, runtimeFingerprint: null,
});

function setHeartbeat(floorNo, { seenAt = Date.now(), health = null, held = [], mode = "live" } = {}) {
  settingsFor(floorNo);                       // ensures the copy_settings row exists
  const hb = { mode, wallet: "", cursor: 0, open: held.length, held,
    health: health ?? healthyHealth(seenAt), ts: seenAt, seenAt };
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
    .run(JSON.stringify(hb), floorNo);
  return hb;
}
const clearHeartbeat = (floorNo) => {
  settingsFor(floorNo);
  db.prepare("UPDATE copy_settings SET executor_heartbeat=NULL WHERE floor_no=?").run(floorNo);
};

let mintSeq = 0;
/** A publishable call with a live in-zone mark, and one offered delivery per floor. */
function fixtureCall(floors = [FLOOR], { mark = 0.001, openedAt = null } = {}) {
  const mint = `Rdy${String(++mintSeq).padStart(2, "0")}1111111111111111111111111111111111111`.slice(0, 43);
  const call = openCall({ mint, symbol: `RDY${mintSeq}`, category: "memecoin",
    launchpad: "pump.fun", conviction: 60,
    entryRef: 0.001, entryLo: 0.0009, entryHi: 0.0011, stop: 0.00075, target: 0.0021,
    thesis: "a call to hand a bot", invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: MICRO_MCAP });
  if (!call) throw new Error("fixture call not opened");
  noteEvent(call.id, "mark", null, mark);           // the publish-time witness (step 18)
  if (openedAt != null) db.prepare("UPDATE calls SET opened_at=? WHERE id=?").run(openedAt, call.id);
  for (const f of floors) {
    settingsFor(f);
    db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at)
                VALUES (?,?,'offered','fixture',NULL,?)`).run(call.id, f, Date.now());
  }
  return getCall(call.id);
}

const alertsFor = (callId, floorNo) => db.prepare(
  "SELECT id, created_at, kind FROM alerts WHERE call_id=? AND floor_no=? AND kind='entry' ORDER BY id").all(callId, floorNo);
const delivery = (callId, floorNo) => db.prepare(
  "SELECT verdict, deliverable FROM deliveries WHERE call_id=? AND floor_no=?").get(callId, floorNo);

/** Every call:entry_held emitted while fn runs. The bus has ONE channel ("event") and
 *  the type rides on the payload (src/lib/bus.js emit), so it is filtered here. */
async function heldDuring(fn) {
  const seen = [];
  const listen = (e) => { if (e?.type === "call:entry_held") seen.push(e); };
  bus.on("event", listen);
  try { await fn(); } finally { bus.off("event", listen); }
  return seen;
}

/* The DexScreener read the hold path takes, stubbed: no network in a regression test,
   and the stub counts the reads so "ONE read, not one per floor" is measurable. */
const witnessCalls = [];
const witnessDeps = {
  pairsFor: async (mint) => { witnessCalls.push(mint); return { ok: true, pairs: [{ priceUsd: 0.001 }] }; },
  consensus: () => ({ ok: true, priceUsd: 0.001 }),
  writeWitnessMark: (callId, price) => { witnessCalls.push(`mark:${callId}:${price}`); return true; },
};

for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

/* ──────────────────────────────────────────────────────────────────────────────────
   1. EVERY MACHINE STATE THAT MEANS "NOT NOW"
   ────────────────────────────────────────────────────────────────────────────────── */
console.log(`\nA BOT THAT CANNOT ACT IS NOT HANDED THE CLOCK (micro band, window ${WINDOW_MS / 60_000}m)`);
{
  const now = Date.now();
  const unhealthy = {
    heartbeat_stale:      { seenAt: now - (WINDOW_MS + 60_000) },
    bot_hard_stop:        { health: { ...healthyHealth(now), hardStop: true } },
    bot_entries_paused:   { health: { ...healthyHealth(now), entriesPaused: true } },
    bot_blocking_intent:  { health: { ...healthyHealth(now), blockingIntent: true } },
    bot_feed_rollback:    { health: { ...healthyHealth(now), feedRollback: true } },
    /* Not ready means no proof INSIDE THE GRACE, not merely a refused latest probe: a
       rehearsal that passed two minutes ago still answers for the bot (the flap of
       2026-09-12, tested in test-held-call-is-visible.mjs). Age the proof out here. */
    bot_not_ready:        { health: { ...healthyHealth(now),
      executionReadiness: { ...healthyHealth(now).executionReadiness, ready: false,
        lastSuccessAt: now - (READINESS_PROOF_GRACE_MS + 60_000) } } },
  };
  for (const [reason, hb] of Object.entries(unhealthy)) {
    const call = fixtureCall();
    setHeartbeat(FLOOR, hb);
    witnessCalls.length = 0;
    // Read the clock AFTER the pulse is written, so a printed botAgeMs is a real age.
    const events = await heldDuring(() => announceEntry(call, { now: Date.now(), witnessDeps }));
    const d = delivery(call.id, FLOOR);
    ok(`${reason}: nothing raised, delivery still offered and unjudged`,
      alertsFor(call.id, FLOOR).length === 0 && d.verdict === "offered" && d.deliverable == null,
      `alerts=${alertsFor(call.id, FLOOR).length} verdict=${d.verdict} deliverable=${JSON.stringify(d.deliverable)}`);
    ok(`...and call:entry_held named it`,
      events.length === 1 && events[0].reason === reason && events[0].notExecutable === false,
      `reason=${events[0]?.reason} notExecutable=${events[0]?.notExecutable} botAgeMs=${events[0]?.botAgeMs}`);
    ok(`...and one DexScreener read wrote one witness mark`,
      witnessCalls.length === 2 && witnessCalls[1] === `mark:${call.id}:0.001`,
      witnessCalls.join(" | "));
    closeCall(call.id, "test_reset", 1);
  }

  // held[] — the bot is already in this coin, so a second entry is not an entry.
  const call = fixtureCall();
  setHeartbeat(FLOOR, { held: [{ mint: call.mint, sol: 0.4, openedAt: now - 60_000 }] });
  const events = await heldDuring(() => announceEntry(call, { now, witnessDeps }));
  ok("mint_already_held: the bot holds it, so nothing is raised",
    alertsFor(call.id, FLOOR).length === 0 && events[0]?.reason === "mint_already_held",
    `reason=${events[0]?.reason} detail="${events[0]?.detail}"`);
  closeCall(call.id, "test_reset", 1);

  ok(`all ${ENTRY_HOLD_REASONS.length} declared hold reasons were driven`,
    ENTRY_HOLD_REASONS.every((r) => r === "mint_already_held" || r in unhealthy),
    ENTRY_HOLD_REASONS.join(", "));
}

/* ──────────────────────────────────────────────────────────────────────────────────
   2. THE GEOMETRY GATE — the bot's own contract, before the clock starts
   ────────────────────────────────────────────────────────────────────────────────── */
console.log("\nAND NEITHER IS A CALL THE BOT'S OWN CONTRACT WOULD REFUSE ON ARRIVAL");
{
  const now = Date.now();
  const call = fixtureCall([FLOOR], { mark: 0.0004 });   // under the zone AND under the stop
  setHeartbeat(FLOOR, {});
  const events = await heldDuring(() => announceEntry(call, { now, witnessDeps }));
  ok("a mark outside the authored zone holds the alert under the contract's own code",
    alertsFor(call.id, FLOOR).length === 0 && events[0]?.reason === "mark_outside_zone",
    `reason=${events[0]?.reason} — "${events[0]?.detail}"`);
  ok("...and the delivery is left unjudged, because the mark can walk back in",
    delivery(call.id, FLOOR).deliverable == null,
    `deliverable=${JSON.stringify(delivery(call.id, FLOOR).deliverable)}`);
  closeCall(call.id, "test_reset", 1);
}

/* ──────────────────────────────────────────────────────────────────────────────────
   3. THE RE-RAISE — a healthy bot gets a FULL window, not the remains of one
   ────────────────────────────────────────────────────────────────────────────────── */
console.log("\nWHEN THE FLOOR IS HEALTHY AGAIN THE ENTRY IS RAISED WITH A FRESH CLOCK");
{
  const t0 = Date.now();
  const call = fixtureCall();
  setHeartbeat(FLOOR, { health: { ...healthyHealth(t0), entriesPaused: true } });
  await announceEntry(call, { now: t0, witnessDeps });
  ok("held at announce time", alertsFor(call.id, FLOOR).length === 0);

  // The bot comes back. Its own feed poll runs the reconciler.
  const t1 = t0 + 5 * 60_000;                    // five minutes later, still inside 20m
  setHeartbeat(FLOOR, { seenAt: t1 });
  const before = Date.now();
  const repaired = reconcileMissingEntryAlerts(FLOOR, { now: t1 });
  const after = Date.now();
  const rows = alertsFor(call.id, FLOOR);
  ok("reconcileMissingEntryAlerts raised exactly one alert", repaired === 1 && rows.length === 1,
    `repaired=${repaired} rows=${rows.length}`);
  console.log(`     call ${call.id}: opened_at=${call.opened_at}  alert id=${rows[0]?.id} ` +
    `created_at=${rows[0]?.created_at}  raise window=[${before}, ${after}]`);
  ok("...and its created_at is the RAISE time, not the publish time",
    rows[0].created_at >= before && rows[0].created_at <= after && rows[0].created_at >= call.opened_at,
    `created_at - opened_at = ${rows[0].created_at - call.opened_at}ms (the clock the bot gets back)`);
  ok("...so the bot's window is whole again", WINDOW_MS - (after - rows[0].created_at) > 0.99 * WINDOW_MS,
    `${((WINDOW_MS - (after - rows[0].created_at)) / 60_000).toFixed(2)}m of a ${WINDOW_MS / 60_000}m window left`);
  ok("...and the delivery is stamped executable", delivery(call.id, FLOOR).deliverable === 1,
    `deliverable=${delivery(call.id, FLOOR).deliverable}`);

  // Idempotent: raise() is UNIQUE(floor,call,kind), so a second poll adds nothing.
  const again = reconcileMissingEntryAlerts(FLOOR, { now: t1 + 1_000 });
  ok("a second poll raises nothing more", again === 0 && alertsFor(call.id, FLOOR).length === 1,
    `repaired=${again} rows=${alertsFor(call.id, FLOOR).length}`);
  closeCall(call.id, "test_reset", 1);
}

/* ──────────────────────────────────────────────────────────────────────────────────
   4. PAST THE BAND'S WINDOW — not executable, and never raised late
   ────────────────────────────────────────────────────────────────────────────────── */
console.log("\nPAST THE BAND'S OWN WINDOW THE ENTRY IS DEAD, AND THE LEDGER IS TOLD SO");
{
  const now = Date.now();
  const openedAt = now - (WINDOW_MS + 5 * 60_000);          // 25m old on a 20m window
  const call = fixtureCall([FLOOR], { openedAt });
  setHeartbeat(FLOOR, { health: { ...healthyHealth(now), entriesPaused: true } });
  const events = await heldDuring(() => announceEntry(call, { now, witnessDeps }));
  ok("still held while the bot is paused", alertsFor(call.id, FLOOR).length === 0,
    `reason=${events[0]?.reason}`);

  // The bot comes back healthy — but too late for this entry.
  setHeartbeat(FLOOR, { seenAt: now });
  const stamped = await heldDuring(async () => reconcileMissingEntryAlerts(FLOOR, { now }));
  const d = delivery(call.id, FLOOR);
  ok("the reconciler refuses to raise it and stamps the delivery not_executable",
    alertsFor(call.id, FLOOR).length === 0 && d.deliverable === 0 && d.verdict === "offered",
    `alerts=${alertsFor(call.id, FLOOR).length} deliverable=${d.deliverable} verdict=${d.verdict}`);
  ok("...under the contract's window_expired code, flagged terminal",
    stamped.length === 1 && stamped[0].reason === "window_expired" && stamped[0].notExecutable === true,
    `reason=${stamped[0]?.reason} notExecutable=${stamped[0]?.notExecutable} — "${stamped[0]?.detail}"`);
  console.log(`     call ${call.id}: opened_at=${openedAt}  now=${now}  age=${((now - openedAt) / 60_000).toFixed(1)}m ` +
    `> window ${WINDOW_MS / 60_000}m  → deliverable=${d.deliverable}`);
  closeCall(call.id, "test_reset", 1);
}

/* ──────────────────────────────────────────────────────────────────────────────────
   5. WHAT THE GATE MUST NOT TOUCH
   ────────────────────────────────────────────────────────────────────────────────── */
console.log("\nTHE GATE IS ABOUT DELIVERY, NOT ABOUT PUBLISHING");
{
  const now = Date.now();
  beginCyclePass({ now });
  const open = cycleStatus(now);
  const call = fixtureCall();
  db.prepare("UPDATE calls SET cycle_id=?, escalation_level=0 WHERE id=?").run(open.id, call.id);
  recordCyclePublish(open.id, call.id, 0);
  const publishedBefore = cycleStatus(now).published;

  setHeartbeat(FLOOR, { health: { ...healthyHealth(now), hardStop: true } });
  await announceEntry(getCall(call.id), { now, witnessDeps });
  const afterStatus = cycleStatus(now);
  ok("a held alert does not change the quota count — recordCyclePublish is untouched",
    afterStatus.published === publishedBefore && publishedBefore >= 1,
    `published ${publishedBefore} → ${afterStatus.published} (quota ${afterStatus.quota})`);
  ok("...and alerts.js never calls it",
    !/recordCyclePublish/.test(fs.readFileSync(new URL("./src/alerts.js", import.meta.url), "utf8")));

  // And the cohort's deliverable count still counts it: unjudged is deliverable.
  ok("an unjudged held delivery still counts as deliverable until its window passes",
    afterStatus.deliverable >= 1, `deliverable=${afterStatus.deliverable}`);
  closeCall(call.id, "test_reset", 1);
}

console.log("\nA FLOOR WITH NO BOT IS NOT A FLOOR WITH A DOWN BOT");
{
  const now = Date.now();
  clearHeartbeat(BARE_FLOOR);
  const readiness = executorReadiness(BARE_FLOOR, { now, windowMs: WINDOW_MS });
  ok("a floor that never posted a pulse reads as having no bot",
    readiness.bot === false && readiness.ready === true && readiness.reason === null,
    `bot=${readiness.bot} ready=${readiness.ready} reason=${readiness.reason}`);

  const call = fixtureCall([BARE_FLOOR]);
  witnessCalls.length = 0;
  const events = await heldDuring(() => announceEntry(call, { now, witnessDeps }));
  const rows = alertsFor(call.id, BARE_FLOOR);
  ok("its entry alert is raised exactly as before — the tenant reads the Calls tab",
    rows.length === 1 && events.length === 0,
    `alerts=${rows.length} created_at=${rows[0]?.created_at} held events=${events.length}`);
  ok("...with no DexScreener read taken, because nothing was held", witnessCalls.length === 0,
    `${witnessCalls.length} reads`);
  ok("...and its delivery is left unjudged, since there is no bot to be ready",
    delivery(call.id, BARE_FLOOR).deliverable == null,
    `deliverable=${JSON.stringify(delivery(call.id, BARE_FLOOR).deliverable)}`);
  closeCall(call.id, "test_reset", 1);
}

/* A REHEARSING BOT IS NOT A BLOCKED BOT. Paper mode reports no executionReadiness at all
   (poller.mjs builds that block only under EXECUTE), so gating on it would hold every
   call from every paper floor for ever — and delete the exact contract
   executor/test-follow-through.mjs measures: every published call reaches the bot and is
   DECIDED on, including while a signed buy is unresolved. Nothing is protected by holding
   a call from a bot that cannot spend. */
console.log("\nNEITHER IS A BOT THAT SAYS IT IS REHEARSING");
{
  const now = Date.now();
  const call = fixtureCall();
  // The exact shape a paper poller posts: mode "paper", and no executionReadiness block.
  setHeartbeat(FLOOR, { mode: "paper", seenAt: now,
    health: { ...healthyHealth(now), blockingIntent: true, executionReadiness: null } });
  const readiness = executorReadiness(FLOOR, { now, windowMs: WINDOW_MS });
  ok("a paper heartbeat is not a live bot, whatever its flags say",
    readiness.bot === false && readiness.mode === "paper",
    `bot=${readiness.bot} mode=${readiness.mode}`);
  const events = await heldDuring(() => announceEntry(call, { now, witnessDeps }));
  const rows = alertsFor(call.id, FLOOR);
  ok("...so the call reaches it even with a blocking intent reported",
    rows.length === 1 && events.length === 0,
    `alerts=${rows.length} created_at=${rows[0]?.created_at} held events=${events.length}`);
  closeCall(call.id, "test_reset", 1);
  setHeartbeat(FLOOR, { seenAt: now });                 // back to live for anything after
}

console.log("\nAND A HEALTHY BOT IS HANDED THE CALL AT ONCE");
{
  const now = Date.now();
  const call = fixtureCall();
  setHeartbeat(FLOOR, { seenAt: now });
  witnessCalls.length = 0;
  const t0 = Date.now();
  const res = await announceEntry(call, { now, witnessDeps });
  const rows = alertsFor(call.id, FLOOR);
  ok("one alert, no hold, no extra price read",
    res.alerted === 1 && res.held === 0 && rows.length === 1 && witnessCalls.length === 0,
    `alerted=${res.alerted} held=${res.held} alerts=${rows.length} reads=${witnessCalls.length}`);
  console.log(`     call ${call.id}: opened_at=${call.opened_at}  alert created_at=${rows[0]?.created_at} ` +
    `(+${rows[0].created_at - t0}ms from the announce)`);
  ok("...and the delivery is stamped executable", delivery(call.id, FLOOR).deliverable === 1,
    `deliverable=${delivery(call.id, FLOOR).deliverable}`);
  closeCall(call.id, "test_reset", 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
