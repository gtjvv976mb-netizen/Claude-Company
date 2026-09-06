/**
 * THE QUOTA NEVER OUTRANKS THE SAFETY FLOOR.
 *
 * The owner's instruction is that every cycle produces at least three published calls
 * "at any cost, by any means". The constraint that shapes how that was built is a
 * measurement, not a preference: of the last 100 kills, ~60 are safety MECHANICS rather
 * than opinions — 18 cannot_exit (the round-trip probe PROVED the position could not be
 * sold), 16 serial_deployer, 9 post_migration_dump, 5 holder_concentration, 4
 * deployer-has-rugged, 4 thin_liquidity, 2 mintable, 2 freezable, 1 wash_suspect.
 *
 * Filling a quota out of that pool does not produce three trades. It produces three
 * bags — and the quota exists to make the desk TRADE, so filling it that way defeats
 * its own purpose. The quota is therefore pursued by MORE EFFORT (L1) and by RELAXED
 * JUDGEMENT (L2 conviction, L3 narrative, L4 band), on a ladder recorded on every call,
 * and there is no level five.
 *
 * THIS FILE IS THE PROOF. It drives EVERY level of the ladder against a candidate that
 * fails EACH safety gate in turn and asserts the refusal, printing the level and the
 * gate every time. If a future change ever lets a quota outrank a measured fact, this
 * is where it fails.
 *
 *   node test-quota-escalation.mjs
 */
import { publishCall, cohortEligibility } from "./src/penthouse.js";
import { GATE_CLASS, SAFETY_GATES, JUDGMENT_GATES, gateClass, gateFailures, safetyFailures,
  openNewCycle, settleCycles } from "./src/calls.js";
import { escalationPlan, MAX_ESCALATION_LEVEL, CYCLE, cfg, floorsFor,
  setCycleBandWindow, cycleBandWindow } from "./src/config.js";
import { complianceCheck } from "./src/agents/compliance.js";
import fs from "node:fs";

/* A fixture size legal under WHATEVER the probe notional currently is. It was a hard-coded
   50 — fine while the exit probe measured $75, and an automatic size_exceeds_exit_probe veto
   the day it became $15. The fixture broke, not the code: compliance.js refuses
   position_size_usd above cfg.targetSizeUsd * 1.001, and risk-rails caps real sizes at that
   same number, so 80% of it is always inside the bar whatever the probe becomes. */
const PROBE_SAFE_SIZE_USD = Number((cfg.targetSizeUsd * 0.8).toFixed(2));

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const LEVELS = [0, 1, 2, 3, 4];

/** A clean, publishable workup: the CEO approved it and nothing is wrong with it. */
const clean = (over = {}) => ({
  mint: "Cln111111111111111111111111111111111111111", symbol: "CLEAN",
  outcome: "decided", finalDecision: "APPROVED", weighted: 71,
  pm: { decision: "PROPOSE", conviction: 68, thesis: "real ignition", invalidation: "deployer sells" },
  redteam: { verdict: "wounded", headline: "thin on holders" },
  compliance: { pass: true, violations: [] },
  risk: { position_size_usd: PROBE_SAFE_SIZE_USD, stop_price: 0.00062, max_loss_usd: 20.55 },
  ceo: { ruling: "APPROVE", order_size_usd: 50 },
  order: { size: 50 },
  ticket: { stop_price: 0.00062, take_profit: [{ price: 0.0019 }] },
  ev: { symbol: "CLEAN", pair: { priceUsd: 0.001, priceChange: { m5: 2 }, liquidityUsd: 90_000 },
        pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
        mintAccount: { flags: [] } },
  ...over,
});
/** The same coin, but it failed exactly one screen check. */
const screened = (code) => clean({ outcome: "screened_out",
  fails: [{ code, detail: `${code} fired on the free screen` }] });
const vetoed = (code) => clean({ compliance: { pass: false, violations: [{ code, detail: `${code}` }] },
  finalDecision: "VETOED" });

/* One record per SAFETY gate, failing that gate and nothing else. Every code in
   GATE_CLASS marked SAFETY must appear here — the coverage assertion below enforces it,
   so a new safety gate cannot be added without a case that drives it. */
const CASES = {
  // the free screen
  cannot_exit: screened("cannot_exit"),
  unverified_exit: screened("unverified_exit"),
  unverified_mint: screened("unverified_mint"),
  unverified_holders: screened("unverified_holders"),
  mintable: screened("mintable"),
  freezable: screened("freezable"),
  seizable: screened("seizable"),
  transfer_hook: screened("transfer_hook"),
  frozen_by_default: screened("frozen_by_default"),
  holder_concentration: screened("holder_concentration"),
  serial_deployer: screened("serial_deployer"),
  post_migration_dump: screened("post_migration_dump"),
  wash_suspect: screened("wash_suspect"),
  thin_liquidity: screened("thin_liquidity"),
  liquidity_did_not_hold: screened("liquidity_did_not_hold"),
  too_new: screened("too_new"),
  no_volume: screened("no_volume"),
  no_participants: screened("no_participants"),
  fdv_propped: screened("fdv_propped"),
  // the reputation read's FACT arm
  deployer_has_rugged: clean({ outcome: "killed", killedBy: "xread", killArm: "serial_rugger",
    reason: "the deployer's own account has rugged before" }),
  analyst_kill: clean({ outcome: "killed", killedBy: "forensics", reason: "bundled float" }),
  // record-level
  no_data: clean({ outcome: "no_data", error: "dexscreener: 429" }),
  workup_error: clean({ outcome: "error", error: "boom" }),
  insufficient_coverage: clean({ outcome: "insufficient_coverage" }),
  compliance_veto: clean({ compliance: { pass: false, violations: [] }, finalDecision: "VETOED" }),
  redteam_refuted_unanswered: clean({ redteam: { verdict: "refuted", headline: "the volume is 3 wallets" },
    pm: { decision: "WATCH", conviction: 68, thesis: "t", invalidation: "i" } }),
  no_invalidation: clean({ pm: { decision: "PROPOSE", conviction: 68, thesis: "t" } }),
  no_stop: clean({ ticket: { stop_price: 0, take_profit: [] } }),
  no_entry_price: clean({ ev: { ...clean().ev, pair: { ...clean().ev.pair, priceUsd: 0 } } }),
  stop_at_or_above_entry: clean({ ticket: { stop_price: 0.002, take_profit: [] } }),
  zero_authorized_size: clean({ order: { size: 0 }, ceo: { ruling: "APPROVE", order_size_usd: 0 },
    risk: { position_size_usd: 0, stop_price: 0.00062, max_loss_usd: 0 } }),
  spike_entry: clean({ ev: { ...clean().ev,
    pair: { ...clean().ev.pair, priceChange: { m5: 44 } } } }),
};
/* THE ONE THE EXECUTOR TAUGHT US. Not a separate class — every compliance violation is
   SAFETY by SOURCE rather than by code list — but it gets its own case because it is
   the violation a quota is most tempted by: it refuses a coin that looks fine. */
CASES.stop_inside_costs = vetoed("stop_inside_costs");

console.log("\nEVERY SAFETY GATE IS DRIVEN — no gate may be classified and then never tested");
{
  const missing = SAFETY_GATES.filter((g) => !CASES[g]);
  ok(`all ${SAFETY_GATES.length} SAFETY gates have a case`, missing.length === 0,
    missing.length ? `untested: ${missing.join(", ")}` : SAFETY_GATES.join(", "));
  ok("an UNKNOWN gate defaults to SAFETY, not to waivable",
    gateClass("some_future_gate_nobody_classified") === "SAFETY",
    `gateClass("some_future_gate_nobody_classified") = ${gateClass("some_future_gate_nobody_classified")}`);
  ok("the classification lives in ONE frozen table",
    Object.isFrozen(GATE_CLASS), `${Object.keys(GATE_CLASS).length} codes, frozen=${Object.isFrozen(GATE_CLASS)}`);
}

console.log("\nTHE DECISIVE ONE: EVERY SAFETY GATE, REFUSED AT EVERY LEVEL L0-L4");
{
  /* The cycle is deliberately OPEN and SHORT of quota for all of this — the exact
     condition under which the ladder is allowed to reach. It reaches for effort and for
     conviction; it never reaches for one of these. */
  settleCycles();
  const cyc = openNewCycle({ quota: 3 });
  for (const [gate, rec] of Object.entries(CASES)) {
    for (const level of LEVELS) {
      const r = publishCall(rec, { category: "memecoin", launchpad: "pump.fun",
        escalation: level, cycleId: cyc.id });
      ok(`L${level} · ${gate} refused`,
        r.outcome !== "published" && r.gate === gate && r.outcome === "unsafe",
        `outcome=${r.outcome} gate=${r.gate} level=${r.level} :: ${String(r.reason).slice(0, 70)}`);
    }
  }
}

console.log("\nTHE SAFETY CHECK IS NOT EVEN GIVEN THE LEVEL — it cannot bend to a number");
{
  for (const gate of ["cannot_exit", "mintable", "serial_deployer", "stop_inside_costs"]) {
    const verdicts = LEVELS.map((l) => cohortEligibility(CASES[gate], l));
    ok(`${gate}: identical refusal at all five levels`,
      verdicts.every((v) => !v.publishable && v.safety === true && v.gate === gate),
      verdicts.map((v) => `L${v.level}:${v.gate}`).join(" "));
  }
  ok("a level past the ladder is clamped to L4, never invented",
    escalationPlan(5).level === MAX_ESCALATION_LEVEL && escalationPlan(99).level === MAX_ESCALATION_LEVEL,
    `escalationPlan(5).level=${escalationPlan(5).level}, escalationPlan(99).level=${escalationPlan(99).level}, MAX=${MAX_ESCALATION_LEVEL}`);
  const l5 = publishCall(CASES.cannot_exit, { escalation: 5, category: "memecoin" });
  ok("...and an L5 publish of an unsellable coin is still refused",
    l5.outcome === "unsafe" && l5.gate === "cannot_exit", `outcome=${l5.outcome} gate=${l5.gate} level=${l5.level}`);
}

console.log("\nTHE LADDER DOES MOVE SOMETHING — otherwise the floor is untested");
{
  // A WATCH at conviction 40: the PM wanted one more trigger. Tier 1, below the L0 bar.
  const watch = clean({ finalDecision: "HELD", ceo: { ruling: "HOLD", order_size_usd: 50 },
    pm: { decision: "WATCH", conviction: 40, thesis: "t", invalidation: "i" } });
  const at = LEVELS.map((l) => cohortEligibility(watch, l));
  ok("L0 refuses it on conviction, and says which bar",
    !at[0].publishable && at[0].gate === "conviction_below_bar" && at[0].safety === false,
    `${at[0].reason}`);
  ok("L1 still refuses it — L1 is EFFORT ONLY, no standard moves",
    !at[1].publishable && at[1].gate === "conviction_below_bar",
    `L1 bar: tier>=${escalationPlan(1).minTier} conviction>=${escalationPlan(1).minConviction} (identical to L0's ${escalationPlan(0).minTier}/${escalationPlan(0).minConviction})`);
  ok("L2 accepts it — the conviction floor, and only the conviction floor",
    at[2].publishable === true,
    `tier=${at[2].tier} conviction=${at[2].conviction} floor=${escalationPlan(2).minConviction}`);
  ok("...and the relaxation is recorded on the verdict, not applied silently",
    (at[2].relaxations || []).some((r) => /^L2:/.test(r)), (at[2].relaxations || []).join(" | "));
  const below = clean({ finalDecision: "HELD", ceo: { ruling: "HOLD", order_size_usd: 50 },
    pm: { decision: "WATCH", conviction: 10, thesis: "t", invalidation: "i" } });
  ok("the floor is a FLOOR — conviction 10 is refused even at L4",
    !cohortEligibility(below, 4).publishable,
    `L4: ${cohortEligibility(below, 4).reason}`);
  // The team's explicit no is not a maybe, at any level.
  const passed = clean({ pm: { decision: "PASS", conviction: 90, thesis: "t", invalidation: "i" },
    finalDecision: "DECLINED", ceo: { ruling: "DECLINE", order_size_usd: 0 } });
  ok("a PM PASS is refused at every level — ranking maybes is not overruling the team",
    LEVELS.every((l) => !cohortEligibility(passed, l).publishable),
    LEVELS.map((l) => `L${l}:${cohortEligibility(passed, l).gate}`).join(" "));
}

console.log("\nL3 — THE NARRATIVE GATE, AND THE ARM OF IT THAT NEVER MOVES");
{
  ok("'the story is manufactured' is classified JUDGMENT",
    gateClass("manufactured_narrative") === "JUDGMENT", `= ${gateClass("manufactured_narrative")}`);
  ok("'the deployer has rugged before' is classified SAFETY",
    gateClass("deployer_has_rugged") === "SAFETY", `= ${gateClass("deployer_has_rugged")}`);
  ok("only L3 and above accept the manufactured verdict",
    LEVELS.map((l) => escalationPlan(l).acceptManufacturedNarrative).join(",") === "false,false,false,true,true",
    LEVELS.map((l) => `L${l}=${escalationPlan(l).acceptManufacturedNarrative}`).join(" "));
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  ok("the waiver in desk.js is gated on the MANUFACTURED arm alone",
    /const waived = killArm === "manufactured" && plan\.acceptManufacturedNarrative/.test(src),
    (src.match(/const waived = .*/) || ["not found"])[0]);
  ok("...so a serial_rugger read can never be waived by any plan",
    !/killArm === "serial_rugger" && plan\./.test(src) && !/acceptSerialRugger/.test(src),
    "no plan field exists that could waive it");
  // Belt and braces: a record that still carries the rugger kill is refused everywhere.
  ok("a record still carrying the rugger kill is refused at L3 and L4 too",
    [3, 4].every((l) => publishCall(CASES.deployer_has_rugged, { escalation: l }).outcome === "unsafe"),
    `L3=${publishCall(CASES.deployer_has_rugged, { escalation: 3 }).gate} L4=${publishCall(CASES.deployer_has_rugged, { escalation: 4 }).gate}`);
}

console.log("\nL4 — THE BAND WIDENS; NOT ONE PER-COIN FLOOR MOVES");
{
  const before = { ...floorsFor(30_000) };
  const flatBefore = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, age: cfg.screen.minPairAgeHours, rt: cfg.maxRoundTripSlippagePct };
  const baseMax = cfg.screen.maxMarketCapUsd;
  setCycleBandWindow(escalationPlan(4));
  const after = { ...floorsFor(30_000) };
  const flatAfter = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, age: cfg.screen.minPairAgeHours, rt: cfg.maxRoundTripSlippagePct };
  ok("the search band widened", cfg.screen.maxMarketCapUsd > baseMax,
    `$${baseMax.toLocaleString()} -> $${cfg.screen.maxMarketCapUsd.toLocaleString()}`);
  ok("the coin's own liquidity/volume/txns/age floors are byte-identical",
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  ok("and so is every flat safety number, the round-trip ceiling included",
    JSON.stringify(flatBefore) === JSON.stringify(flatAfter), JSON.stringify(flatAfter));
  ok("the minimum-AGE floor has no knob at any level — it is a SAFETY gate",
    LEVELS.every((l) => escalationPlan(l).minAgeFloorMultiplier === 1),
    LEVELS.map((l) => `L${l}=${escalationPlan(l).minAgeFloorMultiplier}x`).join(" "));
  ok("...and too_new is classified SAFETY, so widening cannot reach it",
    gateClass("too_new") === "SAFETY", `too_new=${gateClass("too_new")}, too_big=${gateClass("too_big")}`);
  setCycleBandWindow(null);
  ok("the window is cleared, not left widened", cycleBandWindow() === null
    && cfg.screen.maxMarketCapUsd === baseMax, `max back to $${cfg.screen.maxMarketCapUsd.toLocaleString()}`);
}

console.log("\nTHE STOP-INSIDE-COSTS VETO IS THE ONE A QUOTA IS MOST TEMPTED BY");
{
  /* 2026-09-03: the executor refused four consecutive LIVE calls because the stop sat
     inside the round-trip costs. A quota that published those would produce calls the
     bot cannot sign — the quota's purpose destroyed by the act of filling it. */
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09], ["USWS", 6.5, 1.03]]) {
    const stop = 1 - stopPct / 100;
    /* Sized and costed so that stop_inside_costs is the ONLY violation this coin
       raises. An earlier draft of this test left position_size_usd out, so compliance
       ALSO raised zero_size_proposal and the refusal was reported under that code — the
       test would have passed while proving something adjacent to the claim. Print the
       whole violation list, and assert on the code by name. */
    const res = complianceCheck({
      pm: { decision: "PROPOSE" },
      risk: { stop_price: stop, position_size_usd: PROBE_SAFE_SIZE_USD,
        max_loss_usd: Number((PROBE_SAFE_SIZE_USD * (stopPct / 100 + rt / 100)).toFixed(2)) },
      redteam: { verdict: "survived" },
      ticket: { stop_price: stop, entry_zone_low: 1, entry_zone_high: 1, take_profit: [] },
      ev: { pair: { priceUsd: 1 }, exitProbe: { roundTripLossPct: rt } } });
    const codes = res.violations.map((v) => v.code);
    const rec = clean({ compliance: { pass: false, violations: res.violations }, finalDecision: "VETOED" });
    const refusals = LEVELS.map((l) => publishCall(rec, { escalation: l }));
    ok(`${name} (${stopPct}% stop, ${rt}% round trip) refused at all five levels ON THE STOP`,
      codes.includes("stop_inside_costs") && refusals.every((r) => r.outcome === "unsafe" &&
        r.gate === "stop_inside_costs"),
      `compliance said [${codes.join(", ")}]; refusals: ${refusals.map((r) => `L${r.level}:${r.gate}`).join(" ")}`);
  }
}

console.log("\nTHE CLASSIFICATION ITSELF");
{
  ok("gateFailures separates the two kinds on one record",
    (() => {
      const g = gateFailures(screened("too_big"));
      return g.length === 1 && g[0].cls === "JUDGMENT";
    })(), JSON.stringify(gateFailures(screened("too_big"))));
  ok("safetyFailures is empty for a clean record",
    safetyFailures(clean()).length === 0, JSON.stringify(safetyFailures(clean()).map((g) => g.code)));
  ok("a clean record IS publishable at L0 — the floor is not a wall",
    cohortEligibility(clean(), 0).publishable === true,
    `tier=${cohortEligibility(clean(), 0).tier} conviction=${cohortEligibility(clean(), 0).conviction}`);
  ok(`${JUDGMENT_GATES.length} judgment gates, ${SAFETY_GATES.length} safety gates`,
    JUDGMENT_GATES.length > 0 && SAFETY_GATES.length > JUDGMENT_GATES.length,
    `judgment: ${JUDGMENT_GATES.join(", ")}`);
  ok("the quota itself is 3 and the ladder ends at 4",
    CYCLE.quota === 3 && MAX_ESCALATION_LEVEL === 4,
    `quota=${CYCLE.quota} maxLevel=${MAX_ESCALATION_LEVEL}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
