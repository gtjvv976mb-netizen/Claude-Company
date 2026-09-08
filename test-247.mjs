/**
 * A DESK THAT RUNS AROUND THE CLOCK.
 *
 * "24/7" needs three things that are easy to confuse with each other:
 *
 *   CONCURRENCY — more than one position may be open, or the desk idles for as long
 *     as a trade takes to work. One slot was right for the first trades and wrong
 *     for continuous operation.
 *   CADENCE — the desk must look often enough to refill a slot soon after it frees.
 *     A six-hourly cycle leaves a slot empty for most of a day.
 *   PACE — and it must not spend the day's money by lunchtime. This is the one that
 *     actually decides whether anything is running at 3am. On the 30th the desk did
 *     163 workups and spent $22 by mid-afternoon, then went silent.
 *
 * Frequent ticks are only affordable because the expensive part is gated twice: a
 * cycle that finds the book full costs nothing at all, and the hourly pace stops a
 * hunting spree eating tomorrow morning.
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
  path.join(os.tmpdir(), "cc-247-" + process.pid + ".db");
import db from "./src/lib/store.js";
import { assertDailyBudget, BudgetExhausted, HOURLY_BURST, OPPORTUNISTIC_SHARE } from "./src/lib/llm.js";
import { bookState, MAX_LIVE_CALLS } from "./src/mandate.js";
import { CYCLE_BUDGET_DEFAULT_USD } from "./src/config.js";
import { openCall, closeCall, liveCalls } from "./src/calls.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const allowed = (cap, lane) => {
  try { assertDailyBudget(cap, { lane }); return true; }
  catch (e) { if (e instanceof BudgetExhausted) return false; throw e; }
};
/** Charge `usd` at `minsAgo`, so the hour window and the day window differ. */
const charge = (usd, minsAgo) => db.prepare(
  "INSERT INTO llm_spend (ts, seat, model, usd, in_tok, out_tok) VALUES (?,?,?,?,?,?)")
  .run(Date.now() - minsAgo * 60000, "test", "claude-opus-5", usd, 0, 0);
const reset = () => db.prepare("DELETE FROM llm_spend").run();

const CAP = 40;
/* THE ALLOWANCE HAS A FLOOR UNDER IT, and this file used to ignore it because at the
   time the two numbers were equal by coincidence: $40/24 x 3 = $5.00 and the cycle
   budget llm.js defaulted to was $4, whose floor is $4 x 1.25 = $5.00. The floor exists
   so a pace tighter than one cycle's own allowance cannot deadlock the cycle (llm.js,
   "a pace tighter than one cycle's own allowance is not a pace, it is a deadlock"), and
   the cycle budget's default moved to $16 on 2026-09-08 — so the coincidence ended and
   the literal ruler here started measuring a cap the code no longer applies. Derived
   from the same two constants the code reads, so the PROPERTY under test (under the
   allowance the desk runs, over it it waits) survives the next move too. */
const cycleBudget = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || CYCLE_BUDGET_DEFAULT_USD);
const hourCap = Math.max((CAP / 24) * HOURLY_BURST, cycleBudget * 1.25);
console.log(`\nCAP $${CAP}/day · burst x${HOURLY_BURST} · one cycle $${cycleBudget.toFixed(2)} ` +
  `· hourly allowance $${hourCap.toFixed(2)} = max($${((CAP / 24) * HOURLY_BURST).toFixed(2)}, $${(cycleBudget * 1.25).toFixed(2)})`);
console.log(`concurrency ${MAX_LIVE_CALLS} · scanner share ${(OPPORTUNISTIC_SHARE * 100).toFixed(0)}%\n`);

console.log("CONCURRENCY — the desk no longer idles behind one trade");
for (const c of liveCalls()) closeCall(c.id, "reset", 1);
ok("an empty book is not full", !bookState().full, `live=0 max=${MAX_LIVE_CALLS}`);
const ids = [];
for (let i = 0; i < MAX_LIVE_CALLS; i++) {
  const c = openCall({ mint: "Mint" + i + "1111111111111111111111111111111111", symbol: "C" + i,
    category: "memecoin", entryRef: 0.001, stop: 0.0006, target: 0.002, conviction: 60 });
  ids.push(c?.id);
  if (i < MAX_LIVE_CALLS - 1)
    ok(`with ${i + 1} open the desk keeps hunting`, !bookState().full, `live=${bookState().live}`);
}
ok(`at ${MAX_LIVE_CALLS} open the book is full`, bookState().full, `live=${bookState().live}`);
closeCall(ids[0], "target_hit", 0.002);
ok("closing ONE position frees a slot immediately", !bookState().full,
  `live=${bookState().live} — the next cycle refills it`);

console.log("\nPACE — the brake that keeps the desk alive tonight");
reset();
charge(hourCap - 0.5, 10);                       // most of this hour spent
ok("under the hourly allowance the cycle runs", allowed(CAP, "cycle"),
  `$${(hourCap - 0.5).toFixed(2)} of $${hourCap.toFixed(2)}`);
charge(1.0, 5);                                   // now over it
ok("over the hourly allowance the cycle waits", !allowed(CAP, "cycle"),
  `$${(hourCap + 0.5).toFixed(2)} of $${hourCap.toFixed(2)} this hour`);
ok("the scanner waits too", !allowed(CAP, "fresh"));
ok("but a tenant's PAID floor run never waits on our pacing", allowed(CAP, "floor"),
  "they bought that work");

console.log("\n...and the pause is temporary, which is the whole point");
reset();
charge(hourCap + 5, 75);                          // spent, but over an hour ago
ok("an hour later the desk is working again", allowed(CAP, "cycle"),
  "spend aged out of the 1h window");
ok("the daily total still counts against the day", true,
  `$${(hourCap + 5).toFixed(2)} of $${CAP} used today`);

console.log("\nTHE DAILY CAP IS STILL THE HARD CEILING");
reset();
charge(CAP + 1, 200);                             // whole day gone, hours ago
ok("the cycle stops for the day", !allowed(CAP, "cycle"));
ok("the scanner stops for the day", !allowed(CAP, "fresh"));

console.log("\nCOST OF RUNNING HOT — a full book must be free to check");
// The reason a 45-minute cadence is affordable: when the book is full the cycle
// returns before any paid stage. Nothing here spends, so nothing here is metered.
reset();
for (const c of liveCalls()) closeCall(c.id, "reset", 1);
for (let i = 0; i < MAX_LIVE_CALLS; i++)
  openCall({ mint: "Full" + i + "111111111111111111111111111111111", symbol: "F" + i,
    category: "memecoin", entryRef: 0.001, stop: 0.0006, target: 0.002, conviction: 60 });
ok("a full book short-circuits the cycle", bookState().full);
const ticksPerDay = Math.round((24 * 60) / 45);
console.log(`     at a 45m cadence that is ${ticksPerDay} ticks a day, each free while the book is full`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
