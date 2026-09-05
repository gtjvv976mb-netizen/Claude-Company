/**
 * AN UNREADABLE MARK IS A HEALTH FLAG, NEVER A SELL.
 *
 * On 2026-09-04 the bot's first autonomous position, TOAD — a very_high coin the desk
 * meant to hold five to twenty-four hours — was sold thirty-two minutes in at a 1.2%
 * loss on two transient "Failed to get quotes" answers four seconds apart. The first fix
 * classified the failure: transport errors started an outage clock and sold only after a
 * sustained outage; every other failure kept a two-tick latch. Both branches were still
 * BOT-ORIGINATED EXITS, and desk-led-v4 (2026-09-05) removed the category: Shrek, call
 * 55 — the bot sold 03:01:42Z on its own normalised stop at -13.5%, the desk's determined
 * stop_hit came 03:10:24Z, and the owner's rule is that exits are followed "not after or
 * before, but as exactly as it was determined". A bot with no stop of its own has no stop
 * for a hostile order service to hide; a desk_exit intent never consults this mark.
 *
 * What survives is the classification (weather vs refusal — still worth an operator's
 * eye) and the entry block. What a failed mark now does: riskDataUnavailable (new entries
 * blocked, as before) and markUnavailableSince anchored on the FIRST failure, for the
 * heartbeat and the monitor. What it never does: sell.
 */
import fs from "node:fs";
import { clearMarkUnavailable, noteMarkUnavailable } from "./exit-trigger.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const src = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");

/* The classifier, lifted from the source so this cannot drift. */
const block = src.slice(src.indexOf("const TRANSIENT_ENTRY_FAILURE = ["), src.indexOf("const isTransientEntryFailure"));
const patterns = [...block.matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1], m[2]));
const isTransient = (msg) => patterns.some((re) => re.test(msg));

/** The caller's decision, reproduced from manageOpen: what happens on each failed mark. */
function decide(pos, error, nowMs) {
  const transient = isTransient(error);
  const outageMs = noteMarkUnavailable(pos, { observedAt: nowMs, reason: error, transient });
  return { verdict: "hold", transient, outageMs };
}
const T = 1_700_000_000_000;

console.log("\nTHE TOAD SALE, REPLAYED — AND THE SHREK SALE IT WOULD HAVE BECOME");
{
  const pos = {};
  const a = decide(pos, "Jupiter /order 400: Failed to get quotes", T);
  const b = decide(pos, "Jupiter /order 400: Failed to get quotes", T + 4_000);
  ok("the first transient failure holds", a.verdict === "hold", `${a.verdict}, transient=${a.transient}`);
  ok("the second, four seconds later, holds", b.verdict === "hold", `${b.verdict}, outage ${b.outageMs}ms`);
  ok("...and it is classified as transport", a.transient === true && b.transient === true);
  ok("the outage clock is anchored on the FIRST failure", pos.markUnavailableSince === T, `${pos.markUnavailableSince} vs ${T}`);
}

console.log("\nEVERY TRANSIENT THE LOG HAS ACTUALLY SHOWN IS CLASSIFIED AS WEATHER");
{
  for (const msg of [
    "RPC could not produce one coherent exact-slot account snapshot after 3 attempts",
    "Solana RPC HTTP request timed out after 4000ms",
    "failed to simulate transaction: Minimum context slot has not been reached",
    "fetch failed", "feed HTTP 502", "socket hang up",
  ]) {
    const pos = {};
    const d = decide(pos, msg, T);
    ok(`transport: ${msg.slice(0, 52)}`, d.transient === true && d.verdict === "hold", `transient=${d.transient}`);
  }
}

console.log("\nA SUSTAINED OUTAGE NO LONGER SELLS — IT AGES THE FLAG");
{
  const pos = {};
  let last = null;
  for (let t = 0; t <= 30 * 60_000; t += 15_000) last = decide(pos, "fetch failed", T + t);
  ok("thirty minutes of an unreadable mark is still a hold", last.verdict === "hold", last.verdict);
  ok("...with the outage age reported honestly", last.outageMs === 30 * 60_000, `${last.outageMs / 60_000}m`);
  ok("...and the flag still anchored on the first failure", pos.markUnavailableSince === T, String(pos.markUnavailableSince));
  ok("the transient classification rides on the position", pos.markUnavailableTransient === true, String(pos.markUnavailableTransient));
}

console.log("\nA NON-TRANSPORT FAILURE IS CLASSIFIED AS A REFUSAL — AND STILL NEVER SELLS");
{
  /* Jupiter ANSWERED and the answer was rejected. That is the shape a hostile order
     service produces; it is flagged as such, and the desk still owns the exit. */
  for (const msg of [
    "simulation SOL proceeds are below the signed minimum after capped fees",
    "exit price impact 61.2% exceeds 50% cap",
    "final executable exit has breached the authored stop",
    "something nobody has seen before",
  ]) {
    const pos = {};
    const a = decide(pos, msg, T), b = decide(pos, msg, T + 15_000);
    ok(`two of "${msg.slice(0, 40)}" hold in two ticks`, a.verdict === "hold" && b.verdict === "hold" && a.transient === false,
      `${a.verdict} -> ${b.verdict}, transient=${a.transient}`);
    ok("...and are flagged as not-transport on the position", pos.markUnavailableTransient === false, String(pos.markUnavailableTransient));
  }
}

console.log("\nA GOOD MARK CLEARS THE FLAG");
{
  const pos = {};
  decide(pos, "fetch failed", T); decide(pos, "unknown", T + 1_000);
  clearMarkUnavailable(pos);
  ok("the outage clock is gone", pos.markUnavailableSince === undefined);
  ok("the reason is gone", pos.markUnavailableReason === undefined);
  const again = decide(pos, "fetch failed", T + 10 * 60_000);
  ok("a fresh failure after recovery starts over, not from the old outage",
    again.outageMs === 0 && pos.markUnavailableSince === T + 10 * 60_000, `age ${again.outageMs}, since ${pos.markUnavailableSince}`);
  const stale = { markUnavailableSince: T, exitMarkOutageSince: T, pendingExitMarkFailure: { observedAt: T }, pendingPriceExit: { kind: "price" } };
  clearMarkUnavailable(stale);
  ok("pre-v4 witness state left on a position is cleared with it",
    stale.exitMarkOutageSince === undefined && stale.pendingExitMarkFailure === undefined && stale.pendingPriceExit === undefined,
    JSON.stringify(stale));
}

console.log("\nTHE SOURCE DOES WHAT THIS MODEL SAYS");
{
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("function recordPositionFailure"));
  const catchStart = manage.lastIndexOf("catch (error) {", manage.indexOf("AN UNREADABLE MARK IS A HEALTH FLAG, NEVER A SELL."));
  const catchBlock = manage.slice(catchStart, manage.indexOf("const decision = stepPosition("));
  ok("the exit-mark catch exists and is the health-flag version", catchBlock.length > 0 && /noteMarkUnavailable\(pos, \{/.test(catchBlock),
    `${catchBlock.length} chars`);
  ok("the catch never sells", !/sellAll\(/.test(catchBlock), `${(catchBlock.match(/sellAll\(/g) || []).length} sellAll calls in the catch`);
  ok("the catch still classifies transport vs refusal", /isTransientEntryFailure\(error\)/.test(catchBlock));
  ok("new entries stay blocked while the mark is unreadable", /pos\.riskDataUnavailable = true;/.test(catchBlock));
  ok("the old two-tick latch is gone from the valuation pass",
    !/confirmExitMarkFailureWitness/.test(manage) && !/on two consecutive ticks/.test(manage));
  ok("the old sustained-outage sell is gone from the valuation pass",
    !/sustained outage; latching/.test(manage) && !/outageMs < EXIT_MARK_OUTAGE_LATCH_MS/.test(manage),
    "the constant survives only in a comment and on the launchd allowlist");
  ok("a successful mark clears the flag", /executableExitMark\(pos, observation\.actualOutputRaw, currentSolUsd\);[\s\S]{0,200}clearMarkUnavailable\(pos\);/.test(manage));
  ok("the only sell in the valuation pass is the retry of an already-latched exit",
    (manage.match(/await sellAll\(/g) || []).length === 1 && /if \(pos\.exitExecutionRequired\) \{\s*\n\s*await sellAll\(/.test(manage),
    `${(manage.match(/await sellAll\(/g) || []).length} sellAll call(s)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
