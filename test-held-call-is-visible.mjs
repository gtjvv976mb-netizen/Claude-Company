/**
 * A HELD CALL MUST BE READABLE FROM OUTSIDE, ON EVERY SURFACE THAT IS ASKED.
 *
 * Measured on 2026-09-12, floor 50. A live macOS install binds its release through a
 * path that requires an entry pause first, so the operator's bot had been entry-paused
 * since its adoption on 09-11 and nobody knew. Four calls were published that afternoon.
 * Every one was offered to the floor, every one was withheld by entryGate for
 * `bot_entries_paused`, and the state was unreadable from every surface at once:
 *
 *   - the feed the bot polls showed `latest_id` frozen at the last call before the
 *     pause, which is byte-for-byte what a desk that has published nothing looks like;
 *   - `decisions` on that same feed said 'offered' for all four, so the two halves of
 *     the payload disagreed and neither admitted it;
 *   - the floor's board said "your bot is not in this one", which reads as a bot that
 *     saw the call and declined it;
 *   - and the bot's own log was silent, because it names its pause only when an entry
 *     ARRIVES — and the hold is precisely what stops one arriving.
 *
 * Diagnosis took a day and a half and ended in the source of alerts.js. The fix is not a
 * new decision anywhere: the gate's verdict was always computed, it was simply never
 * published. This file holds it published.
 *
 * WHAT IS REAL HERE. A throwaway database, real calls, real deliveries, the real
 * entryGate through heldEntriesFor(), and the real executorFeedPayload. The page's
 * sentence table is read out of viewer/office3d.html as text, which is how the other
 * plain-language tests in this repo assert on it.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-held-visible-" + process.pid + ".db");

import db from "./src/lib/store.js";
import { openCall, closeCall, noteEvent, getCall } from "./src/calls.js";
import { settingsFor } from "./src/copy.js";
import { heldEntriesFor, reconcileMissingEntryAlerts, ENTRY_HOLD_REASONS } from "./src/alerts.js";
import { executorFeedPayload, withHold } from "./src/office.js";
import { ENTRY_GATES } from "./executor/entry-contract.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 21;
const healthyHealth = (now) => ({
  state: "healthy", entriesPaused: false, hardStop: false, blockingIntent: false,
  blockedPositions: 0, manualAction: false, exitBlocked: false,
  lastTickCompletedAt: now, lastFeedSuccessAt: now,
  consecutiveFeedFailures: 0, consecutiveTickFailures: 0, feedRollback: false,
  executionReadiness: { ready: true, lastSuccessAt: now, observedAt: now,
    route: "wsol-usdc", providers: 2, amountLamports: 400_000_000, lastError: null },
  caps: null, runtimeCommit: null, runtimeFingerprint: null,
});

function setHeartbeat(floorNo, patch = {}, { now = Date.now() } = {}) {
  settingsFor(floorNo);
  const hb = { mode: "live", wallet: "", cursor: 0, open: 0, held: [],
    health: { ...healthyHealth(now), ...patch }, ts: now, seenAt: now };
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
    .run(JSON.stringify(hb), floorNo);
}

let mintSeq = 0;
/** A live call with an in-zone witness mark, offered to FLOOR and not yet alerted. */
function offeredCall({ deliveredAt = Date.now() } = {}) {
  const mint = `Hld${String(++mintSeq).padStart(2, "0")}1111111111111111111111111111111111111`.slice(0, 43);
  const call = openCall({ mint, symbol: `HLD${mintSeq}`, category: "memecoin",
    launchpad: "pump.fun", conviction: 60,
    entryRef: 0.001, entryLo: 0.0009, entryHi: 0.0011, stop: 0.00075, target: 0.0021,
    thesis: "a call the bot never heard about", invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 40_000 });
  if (!call) throw new Error("fixture call not opened");
  noteEvent(call.id, "mark", null, 0.001);
  settingsFor(FLOOR);
  db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at)
              VALUES (?,?,'offered','fixture',NULL,?)`).run(call.id, FLOOR, deliveredAt);
  return getCall(call.id);
}

console.log("\n1. A PAUSED BOT'S HELD CALL IS NAMED, NOT INFERRED");
{
  const now = Date.now();
  setHeartbeat(FLOOR, { entriesPaused: true }, { now });
  const call = offeredCall({ deliveredAt: now - 90 * 60_000 });

  const held = heldEntriesFor(FLOOR, { now });
  const row = held.find((h) => h.call_id === call.id);
  ok("the held call is reported at all", Boolean(row), `${held.length} held`);
  ok("...naming the operator's own pause", row?.reason === "bot_entries_paused", row?.reason);
  ok("...carrying the symbol a person reads", row?.symbol === call.symbol, row?.symbol);
  ok("...and how long it has been waiting", Number(row?.held_for_ms) >= 89 * 60_000,
    `${Math.round(Number(row?.held_for_ms) / 60_000)}m`);
  ok("a pause is not terminal — it comes back when the file goes", row?.not_executable === false);

  /* THE SWEEP AND THE REPORT MUST AGREE. They share one query for exactly this reason:
     a report that claimed a call was in flight while the sweep was withholding it would
     have sent the operator looking at their bot instead of at the pause file. */
  const repaired = reconcileMissingEntryAlerts(FLOOR, { now });
  ok("the sweep withholds the same call the report names", repaired === 0, `repaired=${repaired}`);

  console.log("\n2. THE FEED THE BOT POLLS CARRIES IT");
  const feed = executorFeedPayload(FLOOR, 0);
  ok("the payload has a `held` array", Array.isArray(feed.held), typeof feed.held);
  ok("...listing this call", feed.held.some((h) => h.call_id === call.id && h.reason === "bot_entries_paused"));
  ok("...while latest_id still shows nothing to act on", !feed.events.some((e) => e.call_id === call.id),
    `latest_id=${feed.latest_id}`);
  /* THE WHOLE POINT, IN ONE ASSERTION: the two halves of the payload no longer disagree
     in silence. 'offered' in decisions and absent from events is now explained in place. */
  const decided = feed.decisions.find((d) => d.call_id === call.id);
  ok("the 'offered' decision now has its companion explanation",
    decided?.verdict === "offered" && feed.held.some((h) => h.call_id === call.id));

  console.log("\n3. THE BOARD ROW CARRIES IT, SO THE CARD CAN STOP GUESSING");
  const rows = withHold([{ call_id: call.id, symbol: call.symbol }], FLOOR);
  ok("withHold stamps the reason onto the row", rows[0].held_reason === "bot_entries_paused");
  ok("...and how long, for the card's sentence", Number(rows[0].held_for_ms) > 0);
  ok("a row for a call that is NOT held is returned untouched",
    withHold([{ call_id: -1 }], FLOOR)[0].held_reason === undefined);

  console.log("\n4. A HEALTHY BOT HAS NOTHING HELD, AND GETS THE CALL");
  setHeartbeat(FLOOR, {}, { now });
  ok("the report is empty once the pause is lifted",
    heldEntriesFor(FLOOR, { now }).every((h) => h.call_id !== call.id));
  const after = reconcileMissingEntryAlerts(FLOOR, { now });
  ok("...and the sweep hands the call over on the very next poll", after === 1, `repaired=${after}`);
  ok("...so the feed now carries it as an event",
    executorFeedPayload(FLOOR, 0).events.some((e) => e.call_id === call.id));
  closeCall(call.id, "test_reset", 1);
}

console.log("\n5. A FLOOR WITH NO LIVE BOT IS NOT 'HELD' — NOTHING IS BEING WITHHELD");
{
  const now = Date.now();
  const BARE = 22;
  settingsFor(BARE);
  db.prepare("UPDATE copy_settings SET executor_heartbeat=NULL WHERE floor_no=?").run(BARE);
  const call = offeredCall();
  db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at)
              VALUES (?,?,'offered','fixture',NULL,?)`).run(call.id, BARE, Date.now());
  ok("no pulse means no hold to report", heldEntriesFor(BARE, { now }).length === 0);
  closeCall(call.id, "test_reset", 1);
}

console.log("\n6. EVERY REASON THE GATE CAN PRODUCE HAS A SENTENCE A PERSON CAN ACT ON");
{
  const page = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
  const table = page.slice(page.indexOf("const HELD = {"), page.indexOf("const held = (code)"));
  ok("the page has a HELD table at all", table.length > 100);

  for (const reason of [...ENTRY_HOLD_REASONS, ...ENTRY_GATES]) {
    ok(`${reason} is translated`, new RegExp(`\\b${reason}:`).test(table));
  }
  /* THE ONE THE OUTAGE TURNED ON. A sentence that says "paused" without saying which
     file to delete is the same dead end in friendlier words. */
  ok("the pause sentence names the file to delete", /PAUSE_ENTRIES/.test(table));
  ok("the hard-stop sentence names its file too", /HARD_STOP/.test(table));
  ok("the table is reachable from the card", /held,\s*plainDetail/.test(page) || /\bheld,/.test(page));

  /* THE CARD'S ORDER IS THE FINDING. "not in this one" must never win over a hold: it is
     the exact sentence that cost a day and a half. */
  const holdBranch = page.indexOf("c.held_reason");
  const genericBranch = page.indexOf("is not in this one");
  ok("the hold branch is tested before the generic sentence",
    holdBranch > 0 && genericBranch > 0 && holdBranch < genericBranch,
    `hold@${holdBranch} generic@${genericBranch}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
