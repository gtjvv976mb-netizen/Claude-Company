/**
 * CLOSE-PRINT CONFIRMATION — history-anchored, and never in the book's favour.
 *
 * The fifth review found the confirm loop's two remaining ways to lie. Comparing a
 * close to a LIVE read up to ten minutes later restated an honest dump-wick stop —
 * where the exit alert really fired and follower bots really sold — to the pre-wick
 * price, recording ~breakeven while followers realized -40%. And the 10-minute
 * eligibility window stranded any close whose confirm reads failed (the same outage
 * that produced the bad print) as permanently unexamined.
 *
 * The rebuilt loop adjudicates from RECORDED MARKS (no network), stays eligible until
 * confirmed, and obeys one absolute: a restatement may make the recorded outcome
 * worse, never better. These tests run the REAL subTickMarks against a real database —
 * possible precisely because the adjudication no longer needs a live read.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/close-confirm-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const { subTickMarks } = await import("./src/penthouse.js");
const { noteEvent } = await import("./src/calls.js");
const db = (await import("./src/lib/store.js")).default;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const mkCall = ({ entry, closeMark, closedAgoMs, marks }) => {
  const r = db.prepare(`INSERT INTO calls (mint, symbol, status, entry_ref, close_mark, closed_at, opened_at)
    VALUES ('M', 'T', 'closed', ?, ?, ?, ?)`)
    .run(entry, closeMark, Date.now() - closedAgoMs, Date.now() - closedAgoMs - 3600e3);
  const id = Number(r.lastInsertRowid);
  const closedAt = Date.now() - closedAgoMs;
  for (const [dtMs, mark] of marks)
    db.prepare("INSERT INTO call_events (call_id, kind, mark, ts) VALUES (?, 'mark', ?, ?)")
      .run(id, mark, closedAt + dtMs);
  return { id, closedAt };
};
const callRow = (id) => db.prepare("SELECT close_mark, close_confirmed FROM calls WHERE id=?").get(id);
const restated = (id) => db.prepare(
  "SELECT COUNT(*) n FROM call_events WHERE call_id=? AND kind='close_restated'").get(id).n;

console.log("\nA MANUFACTURED WIN IS RESTATED DOWN");
// entry 1.0; pre-close honest 1.05; close print 6.0 (anomalous read fired take-profit);
// post-close mark 1.02 corroborates the pre-close neighbour.
const fakeWin = mkCall({ entry: 1.0, closeMark: 6.0, closedAgoMs: 5 * 60e3,
  marks: [[-60e3, 1.05], [45e3, 1.02]] });
await subTickMarks();
ok("the 6x print is restated to the pre-close mark", callRow(fakeWin.id).close_mark === 1.05,
  `close_mark=${callRow(fakeWin.id).close_mark} — the win shrinks, which is the allowed direction`);
ok("...confirmed and on the record", callRow(fakeWin.id).close_confirmed === 1 && restated(fakeWin.id) === 1);

console.log("\nAN HONEST DUMP-WICK STOP STANDS, HOWEVER ANOMALOUS IT LOOKS");
// entry 1.0; pre-close 1.00; stop fired into a wick at 0.60; market V-bounced to 0.95.
// Both neighbours call the print an outlier — but restating would FLATTER a loss into
// breakeven while followers really sold at the wick. It must stand.
const wick = mkCall({ entry: 1.0, closeMark: 0.60, closedAgoMs: 5 * 60e3,
  marks: [[-50e3, 1.00], [50e3, 0.95]] });
await subTickMarks();
ok("the wick print stands", callRow(wick.id).close_mark === 0.60,
  "a restatement may never improve the recorded outcome");
ok("...confirmed without restatement", callRow(wick.id).close_confirmed === 1 && restated(wick.id) === 0);

console.log("\nA MARKET THAT TRULY MOVED THROUGH THE CLOSE STANDS");
// pre 1.00, close 0.55, post 0.30 — the dump continued; neighbours do NOT agree.
const dump = mkCall({ entry: 1.0, closeMark: 0.55, closedAgoMs: 5 * 60e3,
  marks: [[-50e3, 1.00], [50e3, 0.30]] });
await subTickMarks();
ok("a continuing dump is never rewritten", callRow(dump.id).close_mark === 0.55 &&
  callRow(dump.id).close_confirmed === 1 && restated(dump.id) === 0);

console.log("\nNO SECOND WITNESS, NO CONVICTION");
const lone = mkCall({ entry: 1.0, closeMark: 4.0, closedAgoMs: 15 * 60e3, marks: [] });
await subTickMarks();
ok("a close with no recorded neighbours confirms as printed", callRow(lone.id).close_mark === 4.0 &&
  callRow(lone.id).close_confirmed === 1, "one witness cannot convict another");

console.log("\nTHE WINDOW NO LONGER STRANDS — LATE ADJUDICATION USES THE SAME HISTORY");
// Closed 40 minutes ago (far outside the old 10-minute eligibility window) with the
// fake-win shape. The old loop would never have examined it.
const late = mkCall({ entry: 1.0, closeMark: 6.0, closedAgoMs: 40 * 60e3,
  marks: [[-60e3, 1.05], [45e3, 1.02]] });
await subTickMarks();
ok("a stranded-era close is still adjudicated, identically", callRow(late.id).close_mark === 1.05,
  "the post-close witness is HISTORY, so a late pass concludes what an on-time pass would have");

console.log("\nSTILL PROVISIONAL WHILE A SECOND WITNESS COULD ARRIVE");
const fresh = mkCall({ entry: 1.0, closeMark: 6.0, closedAgoMs: 60e3,
  marks: [[-45e3, 1.05]] });                       // no post-close mark yet, window open
await subTickMarks();
ok("an outlier print waits for its post-close witness", callRow(fresh.id).close_confirmed === null,
  "neither confirmed nor restated on one neighbour while the window is open");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
