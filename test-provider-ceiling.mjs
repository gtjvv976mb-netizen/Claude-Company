/**
 * A SPEND CEILING IS A BLOCKER, NOT A JUDGEMENT.
 *
 * The desk sat at RUNNING - healthy while 149 calls were withheld as "fewer than three
 * analysts returned". That reads as a research verdict; it was a billing verdict. The
 * provider ceiling refused each analyst seat INDIVIDUALLY, so neither the credit
 * matcher (which knew only about an empty balance) nor the DEGRADED identical-error
 * check (which needs one repeated message) saw it. A blocker dressed as a judgement is
 * the worst kind, because the operator debugs the wrong thing.
 */
import { providerCreditHealth, isProviderCreditError } from "./src/provider-health.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  \u2014 " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  \u2014 " + d : ""}`)); };

const now = Date.now();
const ev = (type, error, agoMs) => ({ type, ts: now - agoMs, data: JSON.stringify({ error }) });
// The exact string production emitted, from llm.js.
const CEILING = "metered provider ceiling: $87.02 spent + $2.57 reserved; next call needs up to $0.51 of the $90.00 limit";

console.log("\nTHE CEILING IS RECOGNISED AS A MONEY WALL");
ok("the production ceiling string matches", isProviderCreditError(CEILING));
const hit = providerCreditHealth([ev("seat:failed", CEILING, 60e3)], { nowMs: now });
ok("it blocks the heartbeat", hit.blocked === true, `${hit.failures} failure(s)`);
ok("...and the failure TEXT is kept for the caller",
  /metered provider ceiling/.test(hit.lastFailureError),
  "an empty balance is topped up; a ceiling is raised — the operator must be told which");

console.log("\nTHE OTHER MONEY WALL STILL WORKS");
ok("an empty balance still blocks",
  providerCreditHealth([ev("seat:failed", "your credit balance is too low", 60e3)], { nowMs: now }).blocked);

console.log("\nORDINARY FAILURES ARE NOT MONEY WALLS");
for (const msg of ["no route for this mint", "429 rate limited", "socket hang up"])
  ok(`"${msg}" is ignored`, !providerCreditHealth([ev("seat:failed", msg, 60e3)], { nowMs: now }).blocked);

console.log("\nAND RECOVERY CLEARS IT");
ok("a seat succeeding after the grace period unblocks", !providerCreditHealth([
  ev("seat:failed", CEILING, 30 * 60e3),
  { type: "seat:done", ts: now - 60e3, data: "{}" },
], { nowMs: now }).blocked, "raising the limit must not leave a stuck red light");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
