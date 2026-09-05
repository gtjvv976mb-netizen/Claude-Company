/**
 * A DROPPED PACKET IS NOT A HIDDEN STOP.
 *
 * On 2026-09-04 the bot's first autonomous position, TOAD — a very_high coin the desk
 * meant to hold five to twenty-four hours — was sold thirty-two minutes in at a 1.2%
 * loss. Not on the stop, not on the target, not on the band's clock. On this:
 *
 *   15:57:57  mark TOAD: Jupiter /order 400: Failed to get quotes — waiting for one
 *             independent next-tick failure witness before risk reduction
 *   15:58:01  mark TOAD: executable mark failed on two consecutive ticks — latching a
 *             risk-reducing exit so the order service cannot suppress a stop
 *
 * Two transient "no route right now" answers, four seconds apart. The latch existed for
 * a real threat — an order service that answers every exit quote with an error could
 * hide a stop-out indefinitely — but it counted ANY failure, and a 4-second hiccup looks
 * identical to a hostile service only if you refuse to tell the two apart.
 *
 * The fix classifies the failure. Transport errors start an outage clock and latch only
 * after a sustained outage; every other failure keeps the original two-tick latch.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const src = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");

/* The classifier and the allowance, lifted from the source so this cannot drift. */
const block = src.slice(src.indexOf("const TRANSIENT_ENTRY_FAILURE = ["), src.indexOf("const isTransientEntryFailure"));
const patterns = [...block.matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1], m[2]));
const isTransient = (msg) => patterns.some((re) => re.test(msg));
const LATCH_MS = Number((src.match(/\|\| (\d+) \* 60_000\)\);\s*\n\s*const isTransientEntryFailure/) || [])[1]) * 60_000;

/** The caller's decision, reproduced: what happens on each failed exit mark. */
function decide(pos, error, nowMs, { latchMs = LATCH_MS, gapMs = 60_000 } = {}) {
  if (isTransient(error)) {
    const since = pos.exitMarkOutageSince ?? nowMs;
    pos.exitMarkOutageSince = since;
    return (nowMs - since) >= latchMs ? "SELL:sustained-outage" : "hold:transient";
  }
  const prior = pos.pendingExitMarkFailure;
  if (prior && nowMs - prior.observedAt <= gapMs) { delete pos.pendingExitMarkFailure; return "SELL:two-witness"; }
  pos.pendingExitMarkFailure = { observedAt: nowMs };
  return "hold:first-witness";
}
const markOk = (pos) => { delete pos.exitMarkOutageSince; delete pos.pendingExitMarkFailure; };
const T = 1_700_000_000_000;

console.log("\nTHE TOAD SALE, REPLAYED");
{
  const pos = {};
  const a = decide(pos, "Jupiter /order 400: Failed to get quotes", T);
  const b = decide(pos, "Jupiter /order 400: Failed to get quotes", T + 4_000);
  ok("the first transient failure holds", a === "hold:transient", a);
  ok("the second, four seconds later, STILL holds — it no longer sells", b === "hold:transient", b);
  ok("...because it is transport, not a hidden stop", isTransient("Jupiter /order 400: Failed to get quotes"));
}

console.log("\nEVERY TRANSIENT THE LOG HAS ACTUALLY SHOWN HOLDS");
{
  for (const msg of [
    "RPC could not produce one coherent exact-slot account snapshot after 3 attempts",
    "Solana RPC HTTP request timed out after 4000ms",
    "failed to simulate transaction: Minimum context slot has not been reached",
    "fetch failed", "feed HTTP 502", "socket hang up",
  ]) {
    const pos = {};
    decide(pos, msg, T);
    ok(`holds through: ${msg.slice(0, 52)}`, decide(pos, msg, T + 15_000) === "hold:transient");
  }
}

console.log("\nBUT A SUSTAINED OUTAGE STILL SELLS — THE THREAT MODEL SURVIVES");
{
  ok("the allowance is a real number", LATCH_MS >= 60_000 && LATCH_MS <= 30 * 60_000, `${LATCH_MS / 60_000}m`);
  const pos = {};
  let verdict = "";
  for (let t = 0; t <= LATCH_MS + 15_000; t += 15_000) verdict = decide(pos, "fetch failed", T + t);
  ok("Jupiter unreachable for the whole allowance latches a risk exit", verdict === "SELL:sustained-outage", verdict);
  const pos2 = {};
  decide(pos2, "fetch failed", T);
  ok("...but not one tick before it", decide(pos2, "fetch failed", T + LATCH_MS - 15_000) === "hold:transient");
  ok("the clock is anchored on the FIRST failure, not the latest", pos2.exitMarkOutageSince === T);
}

console.log("\nA NON-TRANSPORT FAILURE KEEPS THE ORIGINAL TWO-TICK LATCH, UNCHANGED");
{
  /* Jupiter ANSWERED and the answer was rejected. That is the shape a hostile order
     service produces, and two of those in a row still sell immediately. */
  for (const msg of [
    "simulation SOL proceeds are below the signed minimum after capped fees",
    "exit price impact 61.2% exceeds 50% cap",
    "final executable exit has breached the authored stop",
    "something nobody has seen before",
  ]) {
    const pos = {};
    const a = decide(pos, msg, T), b = decide(pos, msg, T + 15_000);
    ok(`two of "${msg.slice(0, 40)}" still sell in two ticks`, a === "hold:first-witness" && b === "SELL:two-witness", `${a} -> ${b}`);
  }
  const pos = {};
  decide(pos, "something nobody has seen before", T);
  ok("...and a second witness OUTSIDE the 60s gap does not confirm",
    decide(pos, "something nobody has seen before", T + 61_000) === "hold:first-witness");
}

console.log("\nA GOOD MARK CLEARS BOTH CLOCKS");
{
  const pos = {};
  decide(pos, "fetch failed", T); decide(pos, "unknown", T + 1_000);
  markOk(pos);
  ok("the outage clock is gone", pos.exitMarkOutageSince === undefined);
  ok("the witness is gone", pos.pendingExitMarkFailure === undefined);
  ok("a fresh transient after recovery starts over, not from the old outage",
    decide(pos, "fetch failed", T + 10 * 60_000) === "hold:transient" && pos.exitMarkOutageSince === T + 10 * 60_000);
}

console.log("\nTHE SOURCE DOES WHAT THIS MODEL SAYS");
{
  // The whole exit-mark catch: from its first line, which sets the entry block, to the
  // policy step that follows it.
  const catchStart = src.lastIndexOf("catch (error) {", src.indexOf("A DROPPED PACKET IS NOT A HIDDEN STOP."));
  const catchBlock = src.slice(catchStart, src.indexOf("const decision = stepPosition("));
  // The transient branch alone: everything before the else that holds the old witness.
  const transientBranch = catchBlock.slice(catchBlock.indexOf("if (isTransientEntryFailure(error)) {"),
    catchBlock.indexOf("const witness = confirmExitMarkFailureWitness"));
  ok("transport failures are classified before the witness is consulted",
    transientBranch.length > 0 && /if \(isTransientEntryFailure\(error\)\) \{/.test(catchBlock));
  ok("the transient branch never calls the two-tick witness",
    !transientBranch.includes("confirmExitMarkFailureWitness("));
  ok("the sustained outage sells with its own stated reason",
    /sellAll\(pos, `independent executable exit mark unavailable for \$\{Math\.round\(outageMs \/ 60_000\)\}m`/.test(catchBlock));
  ok("the original latch and its wording survive for non-transport failures",
    /independent executable exit mark unavailable on two consecutive ticks/.test(catchBlock));
  ok("new entries stay blocked during a transient outage", /pos\.riskDataUnavailable = true;/.test(catchBlock));
  ok("a successful mark clears the outage clock", /clearExitMarkFailureWitness\(pos\);\s*\n\s*delete pos\.exitMarkOutageSince;/.test(src));
  ok("the allowance is bounded both ways", /Math\.max\(60_000,\s*\n?\s*Math\.min\(30 \* 60_000/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
