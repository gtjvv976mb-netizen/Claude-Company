/**
 * THE MANDATE'S TESTS.
 *
 * The mandate deliberately lowers the desk's CONVICTION bar so that every cycle ends
 * in a trade. That is only defensible if the SAFETY bar is provably untouched — so
 * most of what follows is an attempt to smuggle an unsafe token past it.
 *
 * Runs against a throwaway database. It never touches the live journal.
 *   CLAUDE_CO_DB=/tmp/x.db node test-mandate.mjs
 */
import { eligibility, contenderScore, pickOne, bookState, MAX_LIVE_CALLS } from "./src/mandate.js";
import { cfg } from "./src/config.js";
/* A fixture size that clears what compliance STILL checks. It chased the probe notional
   for a while (cfg.targetSizeUsd * 0.8) because size_exceeds_exit_probe vetoed anything
   above it; that veto and that config key were both removed on 2026-09-07 — the desk
   does not judge how much is bought. What survives is the desk's own paper-book
   arithmetic (size <= equityUsd, and the recomputed loss inside maxRiskPct of it), so
   the fixture is now a plain small number that satisfies it and nothing tracks a
   removed constant. */
const PAPER_SIZE_USD = 12;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

/** A workup record that is clean in every respect — the control. */
const good = (over = {}) => ({
  mint: "So11111111111111111111111111111111111111112",
  symbol: "CTRL",
  outcome: "decided",
  weighted: 68,
  finalDecision: "APPROVED",
  pm: { decision: "PROPOSE", conviction: 70, thesis: "t", invalidation: "deployer sells" },
  redteam: { verdict: "survives", headline: "h" },
  compliance: { pass: true, violations: [] },
  risk: { position_size_usd: PAPER_SIZE_USD, stop_price: 0.8, max_loss_usd: Number((PAPER_SIZE_USD * 0.20).toFixed(2)) },
  ceo: { ruling: "APPROVE", order_size_usd: 50 },
  order: { size: 50 },
  ticket: { stop_price: 0.8, take_profit: [{ price: 1.9 }] },
  ev: { pair: { priceUsd: 1.0, priceChange: { m5: 2 } } },
  ...over,
});

console.log("\nCONTROL — a clean approval must be eligible");
{
  const e = eligibility(good());
  ok("clean record is eligible", e.eligible === true, e.reason);
  ok("clean approval is tier 4", e.tier === 4, `tier=${e.tier}`);
}

console.log("\nSAFETY — none of these may EVER be published, mandate or not");
const unsafe = [
  ["no data",                  { outcome: "no_data" }],
  ["workup errored",           { outcome: "error", error: "boom" }],
  ["failed the screen",        { outcome: "screened_out", fails: [{ code: "cannot_exit" }] }],
  ["thin analyst coverage",    { outcome: "insufficient_coverage" }],
  ["analyst hard kill",        { outcome: "killed", killedBy: "forensics", reason: "mint authority live" }],
  ["compliance veto",          { compliance: { pass: false, violations: [{ code: "size" }] } }],
  ["VETOED final",             { finalDecision: "VETOED" }],
  ["red team refuted (PM did not answer)", { redteam: { verdict: "refuted", headline: "wash" }, pm: { ...good().pm, decision: "WATCH" } }],
  ["no invalidation",          { pm: { decision: "PROPOSE", conviction: 70, invalidation: "" } }],
  ["stop of zero",             { ticket: { stop_price: 0 } }],
  ["stop missing",             { ticket: {} }],
  ["negative stop",            { ticket: { stop_price: -1 } }],
  ["no readable price",        { ev: { pair: { priceUsd: 0 } } }],
  ["stop at or above entry",   { ticket: { stop_price: 1.0 }, ev: { pair: { priceUsd: 1.0, priceChange: { m5: 0 } } } }],
  ["zero-sized authorization", { risk: { position_size_usd: 0 }, ceo: { ruling: "HOLD", order_size_usd: 0 }, order: { size: 0 } }],
  ["spike-shaped entry",       { ev: { pair: { priceUsd: 1, priceChange: { m5: 44 } } } }],
];
for (const [name, over] of unsafe) {
  const e = eligibility(good(over));
  ok(name + " → refused", e.eligible === false, e.reason);
  if (e.eligible === false) ok(name + " → flagged as safety", e.safety === true, `safety=${e.safety}`);
}

console.log("\nTHE TEAM'S EXPLICIT NO — refused, but as judgement rather than safety");
{
  const p = eligibility(good({ pm: { ...good().pm, decision: "PASS" }, finalDecision: "PASS" }));
  ok("PM PASS is refused", p.eligible === false, p.reason);
  ok("PM PASS is not a safety refusal", p.safety === false);
  const d = eligibility(good({ finalDecision: "DECLINED" }));
  ok("CEO DECLINE is refused", d.eligible === false, d.reason);
}

console.log("\nTHE UNLOCK — what the mandate is actually FOR");
{
  const held = eligibility(good({ finalDecision: "HELD" }));
  ok("a CEO HOLD is now tradeable", held.eligible === true, held.reason);
  ok("a CEO HOLD ranks tier 3", held.tier === 3, `tier=${held.tier}`);

  const watch = eligibility(good({
    finalDecision: "WATCH",
    pm: { decision: "WATCH", conviction: 55, invalidation: "liq halves" },
  }));
  ok("a WATCH with a real ticket is tradeable", watch.eligible === true, watch.reason);
  ok("a WATCH ranks last, tier 1", watch.tier === 1, `tier=${watch.tier}`);

  // The charter's own exception: a PM may answer a refutation and still propose.
  const answered = eligibility(good({
    redteam: { verdict: "refuted", headline: "volume looks washed" },
    pm: { ...good().pm, decision: "PROPOSE" },
    finalDecision: "APPROVED",
  }));
  ok("refuted BUT the PM proposed anyway is allowed", answered.eligible === true, answered.reason);
}

console.log("\nRANKING — a stronger verdict must never lose to a weaker one");
{
  const approvedLowConviction = good({ finalDecision: "APPROVED", pm: { ...good().pm, conviction: 1 }, weighted: 0 });
  const watchMaxConviction = good({ finalDecision: "WATCH", weighted: 100,
    pm: { decision: "WATCH", conviction: 100, invalidation: "x" } });
  ok("approval at conviction 1 outranks a WATCH at 100",
    contenderScore(approvedLowConviction) > contenderScore(watchMaxConviction),
    `${contenderScore(approvedLowConviction)} > ${contenderScore(watchMaxConviction)}`);

  const heldHigh = good({ finalDecision: "HELD", pm: { ...good().pm, conviction: 90 } });
  const heldLow = good({ finalDecision: "HELD", pm: { ...good().pm, conviction: 20 } });
  ok("inside a tier, conviction decides", contenderScore(heldHigh) > contenderScore(heldLow));
  ok("an ineligible record scores -Infinity",
    contenderScore(good({ outcome: "killed" })) === -Infinity);
}

console.log("\nTHE PICK — one cycle, exactly one call");
{
  const cohort = [
    { rec: good({ mint: "a", symbol: "KILLED", outcome: "killed", killedBy: "flow", reason: "rug" }) },
    { rec: good({ mint: "b", symbol: "PASSED", pm: { ...good().pm, decision: "PASS" } }) },
    { rec: good({ mint: "c", symbol: "WATCHED", finalDecision: "WATCH",
      pm: { decision: "WATCH", conviction: 88, invalidation: "x" } }) },
    { rec: good({ mint: "d", symbol: "HELD", finalDecision: "HELD", pm: { ...good().pm, conviction: 41 } }) },
  ];
  const { winner, eligible, judged } = pickOne(cohort);
  ok("all four were judged", judged.length === 4);
  ok("exactly two were eligible", eligible.length === 2, eligible.map((e) => e.rec.symbol).join(", "));
  ok("the HELD wins over the higher-conviction WATCH",
    winner?.rec?.symbol === "HELD", `winner=${winner?.rec?.symbol}`);

  // The case that matters most: a cohort of nothing but poison must produce NO call.
  const poison = [
    { rec: good({ outcome: "screened_out", fails: [{ code: "freezable" }] }) },
    { rec: good({ outcome: "killed", killedBy: "forensics", reason: "honeypot" }) },
    { rec: good({ compliance: { pass: false, violations: [{ code: "x" }] } }) },
  ];
  const p = pickOne(poison);
  ok("a cohort of poison yields NO winner — the mandate does not force", p.winner === null);
  ok("and every refusal is on safety grounds",
    p.judged.every((j) => j.eligibility.safety === true));
}

console.log("\nSEQUENCING — the book gate");
{
  const { openCall, closeCall } = await import("./src/calls.js");
  ok("an empty book is not full", bookState().full === false, `live=${bookState().live}`);

  /* The book holds MAX_LIVE_CALLS at once — three now, so the desk keeps hunting
   * rather than idling behind one trade. What is under test is the GATE, not the
   * number, so fill whatever the configured book is and assert it closes. */
  const opened = [];
  for (let i = 0; i < MAX_LIVE_CALLS; i++) {
    ok(`with ${i} open the desk is still hunting`, bookState().full === false,
      `live=${bookState().live}/${MAX_LIVE_CALLS}`);
    const c = openCall({ mint: `SeqTest${i}11111111111111111111111111111111`, symbol: `SEQ${i}`,
      entryRef: 1, stop: 0.7, target: 2, thesis: "t", invalidation: "i" });
    ok(`call ${i + 1} opened`, !!c);
    opened.push(c);
  }
  const b = bookState();
  ok(`${MAX_LIVE_CALLS} live calls fill the book`, b.full === true, `live=${b.live} max=${MAX_LIVE_CALLS}`);
  ok("the gate names what it is holding", !!b.holding?.symbol, b.holding?.symbol);

  // And the whole point: while it is full, nothing may publish.
  const e = eligibility(good());
  ok("the winner is still eligible on merit", e.eligible === true);
  ok("but the book says full, so the cycle must not open another",
    bookState().full === true);

  closeCall(opened[0].id, "test", 1.2);
  ok("closing ONE call reopens the book", bookState().full === false, `live=${bookState().live}`);
  for (const c of opened.slice(1)) closeCall(c.id, "test", 1.2);
}


console.log("\nCOMPLIANCE — a WATCH ticket must be audited exactly like a PROPOSE ticket");
{
  const { complianceCheck } = await import("./src/agents/compliance.js");
  /* A ticket with a STOP ABOVE ITS ENTRY ZONE — arithmetic that is false whatever the
     verdict behind it, which is the property this section exists to prove is audited on
     a WATCH and not only on a PROPOSE.
     It used to be a bad-EDGE ticket (first target 4% away against a 3% round trip, the
     "machine for paying the market"). That rule — edge_below_cost — was removed on
     2026-09-07: "5x the round trip" is only meaningful at the size the round trip was
     quoted at, and the desk was quoting $75 for a bot that trades about $2. The bot
     makes the same judgment on its own numbers (executor/strategy.mjs:161-164, R_net,
     "costs eat the target"). The WATCH-is-audited-too claim is unchanged; only the
     violation used to demonstrate it moved to one the desk still owns. */
  const badEdge = {
    entry_zone_low: 0.9, entry_zone_high: 1.1, stop_price: 0.8,
    take_profit: [{ price: 1.04, pct_to_sell: 100 }], max_slippage_bps: 500,
  };
  // entry_zone_low 0.9 with a stop at 0.95 => stop_above_entry, on either verdict.
  badEdge.stop_price = 0.95;
  const ev = { pair: { priceUsd: 1.0 }, exitProbe: { roundTripLossPct: 3 } };
  /* 0.05, not 0.08: loss at stop is (1.0 - 0.95) / 1.0. The old 0.08 carried the 3%
     round trip that compliance used to add, and that term is gone — the desk prices its
     own paper record off the stop and nothing else. */
  const risk = { position_size_usd: PAPER_SIZE_USD, stop_price: 0.95, max_loss_usd: Number((PAPER_SIZE_USD * 0.05).toFixed(2)) };

  const asPropose = complianceCheck({ pm: { decision: "PROPOSE" }, risk, redteam: {}, ticket: badEdge, ev });
  ok("a broken-arithmetic PROPOSE ticket is vetoed (unchanged)",
    asPropose.pass === false && asPropose.violations.some((v) => v.code === "stop_above_entry"),
    asPropose.violations.map((v) => v.code).join(","));

  const asWatch = complianceCheck({ pm: { decision: "WATCH" }, risk, redteam: {}, ticket: badEdge, ev });
  ok("the same WATCH ticket is ALSO vetoed (the hole this section guards)",
    asWatch.pass === false && asWatch.violations.some((v) => v.code === "stop_above_entry"),
    asWatch.violations.map((v) => v.code).join(","));

  /* AND THE MONEY VETOES ARE GONE FROM BOTH VERDICTS. A ticket whose first target is
     4% away against a 3% measured round trip used to be refused as edge_below_cost; it
     must now reach the reader, because whether 4% is worth chasing depends on a cost
     that depends on a size this desk does not know. */
  const thinEdge = { entry_zone_low: 0.9, entry_zone_high: 1.1, stop_price: 0.8,
    take_profit: [{ price: 1.04, pct_to_sell: 100 }], max_slippage_bps: 500 };
  for (const decision of ["PROPOSE", "WATCH"]) {
    const r = complianceCheck({ pm: { decision }, redteam: {}, ticket: thinEdge, ev,
      risk: { position_size_usd: PAPER_SIZE_USD, stop_price: 0.8,
        max_loss_usd: Number((PAPER_SIZE_USD * 0.20).toFixed(2)) } });
    ok(`a thin-edge ${decision} ticket is no longer refused for its cost`,
      !r.violations.some((v) => ["edge_below_cost", "stop_inside_costs", "size_exceeds_exit_probe"].includes(v.code)),
      r.violations.map((v) => v.code).join(",") || "no violations");
  }

  // A stop that is not below the entry zone must be caught on a WATCH too.
  const badStop = { ...badEdge, stop_price: 1.2, take_profit: [{ price: 2.0, pct_to_sell: 100 }] };
  const stopWatch = complianceCheck({ pm: { decision: "WATCH" }, risk: { ...risk, stop_price: 1.2 },
    redteam: {}, ticket: badStop, ev });
  ok("a stop above the entry zone is caught on a WATCH", stopWatch.pass === false,
    stopWatch.violations.map((v) => v.code).join(","));

  // And a clean WATCH ticket must still pass — the fix must not veto everything.
  const goodTicket = { entry_zone_low: 0.95, entry_zone_high: 1.05, stop_price: 0.8,
    take_profit: [{ price: 1.6, pct_to_sell: 100 }], max_slippage_bps: 500 };
  /* Its own risk seat, because `risk` above now carries the 0.95 stop that makes
     badEdge illegal — reusing it here would fail on stop_mismatch and say nothing about
     whether a clean ticket passes. */
  const cleanRisk = { position_size_usd: PAPER_SIZE_USD, stop_price: 0.8,
    max_loss_usd: Number((PAPER_SIZE_USD * 0.20).toFixed(2)) };
  const cleanWatch = complianceCheck({ pm: { decision: "WATCH" }, risk: cleanRisk, redteam: {}, ticket: goodTicket, ev });
  ok("a clean WATCH ticket still passes", cleanWatch.pass === true,
    cleanWatch.violations.map((v) => v.code).join(",") || "clear");

  // No ticket at all (alwaysTicket off) must behave exactly as before.
  const noTicket = complianceCheck({ pm: { decision: "WATCH" }, risk, redteam: {}, ticket: null, ev });
  ok("a WATCH with no ticket is unaffected", noTicket.pass === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
