/**
 * THE RESERVE — proving the scanner cannot starve the publisher.
 *
 * The live desk ran 160 workups in a day, spent $20.15 of $25, and published nothing.
 * `call:withheld` never fired once, which is the tell: the desk was not rejecting
 * candidates, it never reached the publish step. The 5-minute fresh scan (288 chances
 * a day) consumed the budget belonging to the 6-hourly cycle (4 chances), and the
 * cycle is the only lane that carries the mandate hunt.
 *
 * This asserts the fix at the exact boundary — spend a share of the day, then check
 * that the scanning lanes are refused while the publishing lane and a PAID tenant run
 * still go through.
 */
import db from "./src/lib/store.js";
import { assertDailyBudget, BudgetExhausted, OPPORTUNISTIC_SHARE, spendSince } from "./src/lib/llm.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
/** Does this lane get to spend right now? */
const allowed = (cap, lane) => {
  try { assertDailyBudget(cap, { lane }); return true; }
  catch (e) { if (e instanceof BudgetExhausted) return false; throw e; }
};
/** Pretend the desk has already spent `usd` today. */
/* Stamped 90 MINUTES AGO, not now. A day's spend does not happen in one instant, and
 * stamping it at Date.now() made every case here also trip the hourly pace added for
 * 24/7 running — so the file would have reported the reserve broken when what it had
 * actually caught was a second, correct brake. The pace has its own tests in
 * test-247.mjs; this file is about the daily lane split alone. */
const setSpend = (usd) => {
  db.prepare("DELETE FROM llm_spend").run();
  db.prepare("INSERT INTO llm_spend (ts, seat, model, usd, in_tok, out_tok) VALUES (?,?,?,?,?,?)")
    .run(Date.now() - 90 * 60000, "test", "claude-opus-5", usd, 0, 0);
};

const CAP = 25;
const share = CAP * OPPORTUNISTIC_SHARE;
console.log(`\nTHE RESERVE — cap $${CAP}, opportunistic share ${(OPPORTUNISTIC_SHARE * 100).toFixed(0)}% ($${share.toFixed(2)})`);
console.log(`reserved for the publishing cycle: $${(CAP - share).toFixed(2)}\n`);

console.log("EARLY IN THE DAY — everyone may spend");
setSpend(1);
for (const lane of ["cycle", "fresh", "promote", "floor"])
  ok(`${lane} may spend`, allowed(CAP, lane), `$1 of $${CAP}`);

console.log("\nPAST THE OPPORTUNISTIC SHARE — the reserve engages");
setSpend(share + 0.01);
ok("fresh is refused",   !allowed(CAP, "fresh"),   `$${(share + 0.01).toFixed(2)} spent`);
ok("promote is refused", !allowed(CAP, "promote"));
ok("THE CYCLE STILL RUNS — this is the whole point", allowed(CAP, "cycle"),
  `$${(CAP - share).toFixed(2)} still reserved for it`);
ok("a PAID tenant floor run still runs", allowed(CAP, "floor"),
  "they bought it; refusing it would be keeping the money");

console.log("\nTHE DAY IS GONE — the hard cap still binds everyone");
setSpend(CAP + 0.01);
for (const lane of ["cycle", "fresh", "promote", "floor"])
  ok(`${lane} is refused at the full cap`, !allowed(CAP, lane));

console.log("\nTHE REGRESSION THIS EXISTS TO PREVENT");
// Replay the measured day: the scanner spends until it is cut off, and the question
// is whether anything is left for the cycle that actually publishes.
setSpend(0);
let scanned = 0, spent = 0;
const PER_WORKUP = 0.126;                    // measured on the live desk
while (allowed(CAP, "fresh") && scanned < 500) { scanned++; spent += PER_WORKUP; setSpend(spent); }
ok("the scanner is stopped before it empties the day", spent < CAP,
  `${scanned} scans, $${spent.toFixed(2)} of $${CAP}`);
ok("and the cycle can still afford a full mandate hunt", allowed(CAP, "cycle"),
  `$${(CAP - spent).toFixed(2)} left = ~${Math.floor((CAP - spent) / PER_WORKUP)} workups`);
const huntable = Math.floor((CAP - spent) / PER_WORKUP);
ok("which is more than one cycle's shortlist plus a deep hunt", huntable >= 20,
  `${huntable} workups available to the publisher`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
