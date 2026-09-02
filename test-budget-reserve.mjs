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
import { grokUsageCost } from "./src/lib/grok.js";
import {
  anthropicUsageCost,
  assertDailyBudget,
  BudgetExhausted,
  meterAnthropicUsage,
  OPPORTUNISTIC_SHARE,
  reserveProviderBudget,
  spendSince,
} from "./src/lib/llm.js";

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

console.log("\nEVERY MODEL CALL RESERVES THE WORST CASE BEFORE IT STARTS");
setSpend(0);
const reservationOptions = { provider: "anthropic", maxTokens: 8000,
  payload: "small fixture", capUsd: 0.7 };
const firstReservation = reserveProviderBudget(reservationOptions);
let parallelBlocked = false;
try { reserveProviderBudget(reservationOptions); }
catch (error) { parallelBlocked = error instanceof BudgetExhausted; }
ok("a parallel seat cannot spend the same remaining budget", parallelBlocked,
  `first seat reserved up to $${firstReservation.usd.toFixed(2)}`);
firstReservation.release();
let afterRelease = null;
try { afterRelease = reserveProviderBudget(reservationOptions); } catch {}
ok("a completed seat releases unused headroom", Boolean(afterRelease));
afterRelease?.release();

setSpend(0.4);
ok("a paid floor can begin below the cap", allowed(0.7, "floor"));
let floorCallBlocked = false;
try { reserveProviderBudget(reservationOptions); }
catch (error) { floorCallBlocked = error instanceof BudgetExhausted; }
ok("but its next provider call cannot cross the metered ceiling", floorCallBlocked);

setSpend(0);
/* A WEB SEAT STILL RESERVES FOR CONTEXT IT CANNOT SEE — search results are injected
 * after the request leaves this process, so payload bytes cannot account for them. What
 * changed on 2026-09-03 is the SIZE of that ceiling, not its purpose. It used to be a
 * complete model context, a million tokens and $20.82, for any call that merely enabled
 * a tool — against a measured real cost of $0.18 for that same call. On a $200 day a
 * handful of concurrent seats exhausted the reservation pool and the desk began refusing
 * work it had the money for, reporting it as "fewer than three analysts returned": a
 * billing failure wearing a research verdict, 2,532 times in seven days. The ceiling now
 * scales with the number of searches the call is allowed to make. */
const noWeb = reserveProviderBudget({ provider: "anthropic", maxTokens: 16_000,
  maxSearches: 0, payload: "small web fixture", capUsd: 1e9 });
const webReservation = reserveProviderBudget({ provider: "anthropic", maxTokens: 16_000,
  maxSearches: 2, payload: "small web fixture", capUsd: 25 });
ok("a web seat reserves provider-generated search context before launch",
  webReservation.usd > noWeb.usd, `$${webReservation.usd.toFixed(2)} vs $${noWeb.usd.toFixed(2)} without tools`);
const webFour = reserveProviderBudget({ provider: "anthropic", maxTokens: 16_000,
  maxSearches: 4, payload: "small web fixture", capUsd: 1e9 });
ok("...and reserves more when it may search more",
  webFour.usd > webReservation.usd, `$${webFour.usd.toFixed(2)} for four vs $${webReservation.usd.toFixed(2)} for two`);
ok("...but no longer reserves a whole context for a two-search call",
  webReservation.usd < 5, `$${webReservation.usd.toFixed(2)} — it was $20.82`);
ok("...while still standing well clear of what such a call actually costs",
  webReservation.usd > 1, `$${webReservation.usd.toFixed(2)} against a measured $0.18`);
noWeb.release(); webFour.release();
let parallelWebBlocked = false;
try {
  // Sized to the new ceiling: two web seats must still not both spend one seat's room.
  for (let i = 0; i < 12; i++)
    reserveProviderBudget({ provider: "anthropic", maxTokens: 16_000,
      maxSearches: 2, payload: "second web fixture", capUsd: 25 });
} catch (error) { parallelWebBlocked = error instanceof BudgetExhausted; }
ok("parallel web seats cannot both consume the same unmetered search headroom", parallelWebBlocked);
webReservation.release();

console.log("\nCOMPLETED CALLS REPLACE RESERVATIONS WITH CONSERVATIVE ACTUAL COST");
setSpend(0);
const fallbackMessage = {
  model: "claude-fable-5",
  usage: {
    input_tokens: 1_000,
    cache_creation_input_tokens: 100_000,
    cache_read_input_tokens: 50_000,
    output_tokens: 2_000,
    server_tool_use: { web_search_requests: 2 },
  },
};
const priced = anthropicUsageCost("claude-opus-5", fallbackMessage);
ok("the provider's actual fallback model sets the rate", priced.model === "claude-fable-5");
ok("cache writes, cache reads, output, and searches are all charged",
  Math.abs(priced.usd - 2.18) < 1e-9, `$${priced.usd.toFixed(2)}`);
meterAnthropicUsage("claude-opus-5", fallbackMessage, "budget-test", "low");
const metered = db.prepare("SELECT model,in_tok,cached_tok,usd FROM llm_spend ORDER BY id DESC LIMIT 1").get();
ok("the durable ledger keeps actual model and total provider-reported input",
  metered.model === "claude-fable-5" && metered.in_tok === 151_000 &&
    metered.cached_tok === 50_000 && Math.abs(metered.usd - 2.18) < 1e-9,
  JSON.stringify(metered));
let sequentialBlocked = false;
try { reserveProviderBudget({ ...reservationOptions, capUsd: 2.6 }); }
catch (error) { sequentialBlocked = error instanceof BudgetExhausted; }
ok("a sequential call sees the completed cached/fallback charge", sequentialBlocked);

const grokCost = grokUsageCost({
  model: "grok-4.6-actual",
  usage: { input_tokens: 999_999, output_tokens: 999_999,
    input_tokens_details: { cached_tokens: 123 }, cost_in_usd_ticks: 37_756_000 },
}, 50);
ok("xAI uses the provider's exact all-in cost instead of a token/tool estimate",
  grokCost.exact && grokCost.model === "grok-4.6-actual" && grokCost.cached === 123 &&
    Math.abs(grokCost.usd - 0.0037756) < 1e-12, JSON.stringify(grokCost));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
