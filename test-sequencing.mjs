/**
 * THE SEQUENCING TEST — the one the unit tests cannot do.
 *
 * test-mandate.mjs proves eligibility() refuses the right things in isolation. That
 * is not the same as proving the CYCLE obeys it: the whole point of "one cycle, one
 * trade" is that runPenthouseCycle actually declines to run while a call is live, and
 * declines BEFORE it spends money on a workup it could never publish.
 *
 * This also serves as a boot check. `node --check` balanced braces on a broken module
 * once already in this codebase; importing penthouse.js for real is what catches a
 * circular import or a temporal-dead-zone read that would take the whole desk down.
 *
 *   CLAUDE_CO_DB=/tmp/x.db ANTHROPIC_API_KEY= node test-sequencing.mjs
 */
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

console.log("\nBOOT — the modules must actually load, not merely parse");
const t0 = Date.now();
const ph = await import("./src/penthouse.js");
const { openCall, closeCall, liveCalls } = await import("./src/calls.js");
const { bookState } = await import("./src/mandate.js");
ok("penthouse.js imported", typeof ph.runPenthouseCycle === "function", `${Date.now() - t0}ms`);
ok("freshScan exported", typeof ph.freshScan === "function");
ok("promoteWatches exported", typeof ph.promoteWatches === "function");

console.log("\nOPEN BOOK — a live call must stop every lane before it spends");
for (const c of liveCalls()) closeCall(c.id, "test reset", null);
const held = openCall({
  mint: "HeldPos11111111111111111111111111111111111", symbol: "HELD",
  entryRef: 1, stop: 0.7, target: 2, thesis: "t", invalidation: "i", category: "memecoin",
});
ok("a position is open", !!held && bookState().full === true, `live=${bookState().live}`);

// If the gate is wrong, THIS is where it shows: the cycle would proceed to sweep()
// and then to paid workups. With no API key it would fail loudly instead of
// returning cleanly, which is itself the signal.
const t1 = Date.now();
const r = await ph.runPenthouseCycle();
const ms = Date.now() - t1;
ok("the cycle refused to run", r.skipped === "position_open", JSON.stringify(r.skipped ?? r));
ok("it named the position it is waiting on", r.holding?.symbol === "HELD", r.holding?.symbol);
ok("it opened nothing", r.opened === 0);
ok("it spent nothing", r.costUsd === 0, `$${r.costUsd}`);
ok("and it returned immediately, so it never reached the network",
  ms < 1500, `${ms}ms`);

const fs = await ph.freshScan();
ok("the fresh lane also stood down", fs.skipped === "position_open", JSON.stringify(fs));
const pw = await ph.promoteWatches();
ok("the promotion lane also stood down", pw.skipped === "position_open", JSON.stringify(pw));

console.log("\nCLOSED BOOK — closing the trade is what releases the next cycle");
closeCall(held.id, "target_hit", 1.8);
ok("the book is empty again", bookState().full === false, `live=${bookState().live}`);
// We do NOT run a full cycle here: that would hit the network and spend real money.
// What matters is that the gate is the only thing that was stopping it.
ok("nothing is holding the desk back now", bookState().holding === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
