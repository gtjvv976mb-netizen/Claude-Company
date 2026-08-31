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
const { bookState, MAX_LIVE_CALLS } = await import("./src/mandate.js");
const { spend } = await import("./src/lib/llm.js");
ok("penthouse.js imported", typeof ph.runPenthouseCycle === "function", `${Date.now() - t0}ms`);
ok("freshScan exported", typeof ph.freshScan === "function");
ok("promoteWatches exported", typeof ph.promoteWatches === "function");

console.log("\nFULL BOOK — every lane must stand down before it spends");
/* The desk now runs MAX_LIVE_CALLS positions at once so it can work around the clock
 * instead of idling behind a single trade. The gate under test is unchanged — it
 * simply closes at three rather than one — so fill the configured book. */
for (const c of liveCalls()) closeCall(c.id, "test reset", null);
const held = [];
for (let i = 0; i < MAX_LIVE_CALLS; i++) {
  held.push(openCall({
    mint: `HeldPos${i}1111111111111111111111111111111111`, symbol: i === 0 ? "HELD" : `HELD${i}`,
    entryRef: 1, stop: 0.7, target: 2, thesis: "t", invalidation: "i", category: "memecoin",
  }));
}
ok(`${MAX_LIVE_CALLS} positions are open`, held.every(Boolean) && bookState().full === true,
  `live=${bookState().live}/${MAX_LIVE_CALLS}`);

// A full book still refreshes the FREE funnel, but it must never cross into the paid
// workup path. Stub only that free network boundary: wall-clock speed is a property of
// the CI runner and DexScreener, not proof that no model call occurred.
let warmCalls = 0;
const beforeSpend = { calls: spend.calls, usd: spend.usd };
const r = await ph.runPenthouseCycle({
  warmFunnelFn: async () => {
    warmCalls++;
    return { swept: 7, screened: 3, ready: 2, source: "sequencing-test" };
  },
});
ok("the cycle refused to run", r.skipped === "position_open", JSON.stringify(r.skipped ?? r));
// liveCalls() is ordered newest-first, so with a full book this names the most recent
// position rather than the first one opened. Either is a true answer to "what are you
// waiting on"; what matters is that the refusal is specific rather than bare.
ok("it named a position it is waiting on",
  typeof r.holding?.symbol === "string" && held.some((h) => h.symbol === r.holding.symbol),
  `${r.holding?.symbol} (holding ${r.live})`);
ok("it opened nothing", r.opened === 0);
ok("it spent nothing", r.costUsd === 0, `$${r.costUsd}`);
ok("it refreshed the free funnel exactly once",
  warmCalls === 1 && r.warmed?.source === "sequencing-test", JSON.stringify(r.warmed));
ok("and it never crossed into a paid workup",
  r.workedUp === 0 && spend.calls === beforeSpend.calls && spend.usd === beforeSpend.usd,
  `workedUp=${r.workedUp} calls=${spend.calls - beforeSpend.calls} usd=$${spend.usd - beforeSpend.usd}`);

const fs = await ph.freshScan();
ok("the fresh lane also stood down", fs.skipped === "position_open", JSON.stringify(fs));
const pw = await ph.promoteWatches();
ok("the promotion lane also stood down", pw.skipped === "position_open", JSON.stringify(pw));

console.log("\nA FREED SLOT — closing ONE trade is what releases the next cycle");
closeCall(held[0].id, "target_hit", 1.8);
ok("one close reopens the book", bookState().full === false,
  `live=${bookState().live}/${MAX_LIVE_CALLS} — the desk hunts again without waiting for the others`);
for (const c of held.slice(1)) closeCall(c.id, "test reset", 1);
ok("the book is empty again", bookState().full === false, `live=${bookState().live}`);
// We do NOT run a full cycle here: that would hit the network and spend real money.
// What matters is that the gate is the only thing that was stopping it.
ok("nothing is holding the desk back now", bookState().holding === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
