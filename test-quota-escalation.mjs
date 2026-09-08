/**
 * THE QUOTA NEVER OUTRANKS THE SAFETY FLOOR.
 *
 * The owner's instruction is that every cycle produces at least three published calls
 * "at any cost, by any means". The constraint that shapes how that was built is a
 * measurement, not a preference: most of the last 100 kills are safety MECHANICS rather
 * than opinions — 15 post_migration_dump, 12 serial_deployer, 6 holder_concentration,
 * 6 mintable, 5 thin_liquidity, 4 deployer-has-rugged, 3 each freezable / seizable /
 * transfer_hook / frozen_by_default / unverified_exit, 2 wash_suspect.
 *
 * RE-COUNTED 2026-09-07, and the old count led with a number that was never safety at
 * all: "18 cannot_exit (the round-trip probe PROVED the position could not be sold)".
 * It proved nothing of the kind — it proved a $75 order was expensive on a desk whose
 * bot trades about $2, and 12 of those 100 coins died on it with NOTHING else against
 * them. That gate is deleted (owner's rule: the desk says WHAT and WHEN, never how
 * much or what it costs) and the cost judgment now runs in the bot at its real size.
 * The safety floor this file defends is genuinely smaller, and every gate left in it is
 * a fact about the coin rather than about an order.
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

/* A fixture size that clears what compliance STILL checks. It used to track the probe
   notional (cfg.targetSizeUsd * 0.8) because size_exceeds_exit_probe vetoed anything
   above it; both the veto and the config key were removed on 2026-09-07. What remains
   is the desk's own paper-book arithmetic, so this is a plain small number. */
const PAPER_SIZE_USD = 12;

/* The conviction the CLEAN fixture carries: comfortably clear of the L0 bar, and DERIVED
   from that bar rather than frozen at a literal. It was a bare 68, chosen when the L0 bar
   was 55; the owner cut the bar to 20 on 2026-09-07 and 68 survived only by luck. The
   fixture's job is "a coin nobody has any objection to", so it is stated that way — one
   clear step above whatever the bar is — and it still evaluates to 68 today. */
const CLEAN_CONVICTION = Math.max(68, escalationPlan(0).minConviction + 5);

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const LEVELS = [0, 1, 2, 3, 4];

/** A clean, publishable workup: the CEO approved it and nothing is wrong with it. */
const clean = (over = {}) => ({
  mint: "Cln111111111111111111111111111111111111111", symbol: "CLEAN",
  outcome: "decided", finalDecision: "APPROVED", weighted: 71,
  pm: { decision: "PROPOSE", conviction: CLEAN_CONVICTION, thesis: "real ignition", invalidation: "deployer sells" },
  redteam: { verdict: "wounded", headline: "thin on holders" },
  compliance: { pass: true, violations: [] },
  risk: { position_size_usd: PAPER_SIZE_USD, stop_price: 0.00062, max_loss_usd: 20.55 },
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
  /* the free screen.
     `cannot_exit: screened("cannot_exit")` was the first entry and is gone with the gate
     — it was the round-trip COST ceiling, measured at a notional the desk chose, and it
     is now the bot's judgment at the bot's own size (executor/jupiter.mjs:1341-1350).
     `unverified_exit` below is what survived of that probe and is the real safety half:
     nobody could measure whether this token can be sold at all. */
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
    pm: { decision: "WATCH", conviction: CLEAN_CONVICTION, thesis: "t", invalidation: "i" } }),
  no_invalidation: clean({ pm: { decision: "PROPOSE", conviction: CLEAN_CONVICTION, thesis: "t" } }),
  no_stop: clean({ ticket: { stop_price: 0, take_profit: [] } }),
  no_entry_price: clean({ ev: { ...clean().ev, pair: { ...clean().ev.pair, priceUsd: 0 } } }),
  stop_at_or_above_entry: clean({ ticket: { stop_price: 0.002, take_profit: [] } }),
  zero_authorized_size: clean({ order: { size: 0 }, ceo: { ruling: "APPROVE", order_size_usd: 0 },
    risk: { position_size_usd: 0, stop_price: 0.00062, max_loss_usd: 0 } }),
  spike_entry: clean({ ev: { ...clean().ev,
    pair: { ...clean().ev.pair, priceChange: { m5: 44 } } } }),
};
/* A COMPLIANCE VIOLATION, because those are SAFETY by SOURCE rather than by code list
   and that rule needs driving. This was `vetoed("stop_inside_costs")` — the veto the
   quota was most tempted by, and one the desk no longer raises: it recomputed the bot's
   cost guard on a size the desk invented. `stop_above_entry` is a violation compliance
   still emits, and it is arithmetic rather than money: a stop that is not below the
   entry zone fires on arrival whatever anyone paid. */
CASES.stop_above_entry = vetoed("stop_above_entry");

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
  for (const gate of ["unverified_exit", "mintable", "serial_deployer", "stop_above_entry"]) {
    const verdicts = LEVELS.map((l) => cohortEligibility(CASES[gate], l));
    ok(`${gate}: identical refusal at all five levels`,
      verdicts.every((v) => !v.publishable && v.safety === true && v.gate === gate),
      verdicts.map((v) => `L${v.level}:${v.gate}`).join(" "));
  }
  ok("a level past the ladder is clamped to L4, never invented",
    escalationPlan(5).level === MAX_ESCALATION_LEVEL && escalationPlan(99).level === MAX_ESCALATION_LEVEL,
    `escalationPlan(5).level=${escalationPlan(5).level}, escalationPlan(99).level=${escalationPlan(99).level}, MAX=${MAX_ESCALATION_LEVEL}`);
  const l5 = publishCall(CASES.unverified_exit, { escalation: 5, category: "memecoin" });
  ok("...and an L5 publish of a coin nobody could prove is sellable is still refused",
    l5.outcome === "unsafe" && l5.gate === "unverified_exit", `outcome=${l5.outcome} gate=${l5.gate} level=${l5.level}`);
}

console.log("\nTHE LADDER DOES MOVE SOMETHING — otherwise the floor is untested");
{
  /* DERIVED FROM THE CONFIG, NEVER HARDCODED. These fixtures used conviction 40 and 10,
     chosen when the bars were 55 and 35. The owner recalibrated them to 20 and 15 on
     2026-09-07 (the old 55 sat above the highest conviction the desk had ever scored),
     and a 40 that used to be "below L0" became "comfortably above it" — the test broke
     while the PROPERTY it checks was still true. So the numbers are read from the ladder
     itself: one conviction strictly between the floor and the L0 bar, and one below the
     floor. Recalibrate the bars again and this test still proves the same two things. */
  const L0_BAR = escalationPlan(0).minConviction;
  const FLOOR = escalationPlan(2).minConviction;
  if (!(FLOOR < L0_BAR))
    throw new Error(`the ladder must lower conviction: floor ${FLOOR} is not below the L0 bar ${L0_BAR}`);
  const BETWEEN = FLOOR + Math.max(1, Math.floor((L0_BAR - FLOOR) / 2));  // refused at L0/L1, accepted at L2
  const BELOW_FLOOR = Math.max(0, FLOOR - Math.max(1, Math.ceil(FLOOR / 3)));

  // A WATCH between the floor and the L0 bar: the PM wanted one more trigger. Tier 1.
  const watch = clean({ finalDecision: "HELD", ceo: { ruling: "HOLD", order_size_usd: 50 },
    pm: { decision: "WATCH", conviction: BETWEEN, thesis: "t", invalidation: "i" } });
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
    pm: { decision: "WATCH", conviction: BELOW_FLOOR, thesis: "t", invalidation: "i" } });
  ok(`the floor is a FLOOR — conviction ${BELOW_FLOOR} is refused even at L4`,
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

console.log("\nTHE CURVE'S TWO OPPORTUNITY CODES — JUDGMENT by name, and no rung of L0-L4 waives either");
{
  /* Step 13 (2026-09-08): dead_curve and post_ath_dump are read off the launch feed's own
     row for $0 (penthouse.js wouldSurviveScreen) and are OPPORTUNITY, not safety — a dead
     curve and a dumped coin both sell — so they sit in JUDGMENT_GATES explicitly rather
     than falling to the SAFETY default. But JUDGMENT is not WAIVABLE: no field of
     escalationPlan names them (the ladder waives only the manufactured arm at L3 and
     moves the SEARCH band at L4), so a record carrying either is refused at every level
     and charged to that code. Driven exactly the way the safety gates are above. */
  const configSrc = fs.readFileSync(new URL("./src/config.js", import.meta.url), "utf8");
  for (const code of ["dead_curve", "post_ath_dump"]) {
    ok(`${code} is in GATE_CLASS by name as JUDGMENT`,
      Object.hasOwn(GATE_CLASS, code) && gateClass(code) === "JUDGMENT"
        && JUDGMENT_GATES.includes(code) && !SAFETY_GATES.includes(code),
      `GATE_CLASS.${code}=${GATE_CLASS[code]}`);
    const verdicts = LEVELS.map((l) => cohortEligibility(screened(code), l));
    ok(`${code}: not publishable at any of L0-L4, and charged to itself`,
      verdicts.every((v) => v.publishable === false && v.gate === code),
      verdicts.map((v) => `L${v.level}:${v.gate}`).join(" ") +
      ` (mandate declines every screened_out record as safety=${verdicts[0].safety}; the CLASS is what the ladder reads, and it is ${gateClass(code)})`);
    const pubs = LEVELS.map((l) => publishCall(screened(code), { category: "memecoin", launchpad: "pump.fun", escalation: l }));
    ok(`${code}: publishCall refuses it at every level`,
      pubs.every((r) => r.outcome !== "published" && !r.callId && r.gate === code),
      pubs.map((r) => `L${r.level}:${r.outcome}/${r.gate}`).join(" "));
    ok(`${code}: no rung of the ladder names it`,
      !configSrc.includes(code) && LEVELS.every((l) => !JSON.stringify(escalationPlan(l)).includes(code)),
      "config.js and every escalationPlan(L) are silent about it");
  }
}

console.log("\nL4 — THE BAND WINDOW MOVES; NOT ONE PER-COIN FLOOR MOVES");
{
  const before = { ...floorsFor(30_000) };
  const flatBefore = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, age: cfg.screen.minPairAgeHours, rt: cfg.maxRoundTripSlippagePct };
  const baseMin = cfg.screen.minMarketCapUsd;
  const baseMax = cfg.screen.maxMarketCapUsd;
  const plan4 = escalationPlan(4);
  setCycleBandWindow(plan4);
  const after = { ...floorsFor(30_000) };
  const flatAfter = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, age: cfg.screen.minPairAgeHours, rt: cfg.maxRoundTripSlippagePct };
  /* RE-ANCHORED 2026-09-07, AND THE DIRECTION CLAIM IS GONE ON PURPOSE — SAY SO OUT LOUD.
     This read `cfg.screen.maxMarketCapUsd > baseMax`, back when the base band stopped at
     $10M and the L4 knob reached to $40M. The owner then raised the BASE band to
     $1,000-$50,000,000 to let more coins through, and left CYCLE_L4_MCAP_MAX at $40M —
     so L4's window is now NARROWER at the top than the band it replaces, and the note
     stamped on every L4 call still says "widened". That is a config drift for the owner
     to settle (it is flagged in the report), not something a test may paper over by
     asserting the opposite of what the numbers say.
     What this assertion is FOR is unchanged and is why it cannot simply be dropped: the
     three byte-identical comparisons below prove nothing unless the window actually took
     effect. So it now asserts exactly that — the screens read the L4 plan's band, and
     that band is NOT the base band — derived from the plan so the next recalibration of
     either number leaves it standing. */
  ok("the SEARCH band the screens read is the L4 plan's own band, and it is not the base band",
    cfg.screen.minMarketCapUsd === plan4.mcapMin && cfg.screen.maxMarketCapUsd === plan4.mcapMax
      && (plan4.mcapMin !== baseMin || plan4.mcapMax !== baseMax),
    `base $${baseMin.toLocaleString()}-$${baseMax.toLocaleString()} -> L4 ` +
    `$${cfg.screen.minMarketCapUsd.toLocaleString()}-$${cfg.screen.maxMarketCapUsd.toLocaleString()}`);
  /* And the account the call carries names the band that was really installed — the
     `allLaunchpads` defect (a relaxation stamped on 33 live calls that no module did)
     in its other form: a hardcoded pair of numbers in the note, drifting from the knobs. */
  ok("...and the L4 note stamped on a published call names the band that was installed",
    (() => {
      const note = plan4.relaxations.find((r) => /^L4:/.test(r)) || "";
      return note.includes(`$${plan4.mcapMin.toLocaleString()}`)
          && note.includes(`$${plan4.mcapMax.toLocaleString()}`);
    })(), plan4.relaxations.find((r) => /^L4:/.test(r)) || "no L4 note");
  ok("the coin's own liquidity/volume/txns/age floors are byte-identical",
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  /* `rt` is cfg.maxRoundTripSlippagePct, retired with the cannot_exit gate on 2026-09-07
     (test-screen-config.mjs asserts its absence). It stays in the compared object so that
     if the key is ever resurrected the band window still may not move it. */
  ok("and so is every flat safety number the screens read",
    JSON.stringify(flatBefore) === JSON.stringify(flatAfter), JSON.stringify(flatAfter));
  ok("the minimum-AGE floor has no knob at any level — it is a SAFETY gate",
    LEVELS.every((l) => escalationPlan(l).minAgeFloorMultiplier === 1),
    LEVELS.map((l) => `L${l}=${escalationPlan(l).minAgeFloorMultiplier}x`).join(" "));
  ok("...and too_new is classified SAFETY, so widening cannot reach it",
    gateClass("too_new") === "SAFETY", `too_new=${gateClass("too_new")}, too_big=${gateClass("too_big")}`);
  setCycleBandWindow(null);
  ok("the window is cleared, not left in force — BOTH ends of the band come back",
    cycleBandWindow() === null && cfg.screen.maxMarketCapUsd === baseMax
      && cfg.screen.minMarketCapUsd === baseMin,
    `band back to $${cfg.screen.minMarketCapUsd.toLocaleString()}-$${cfg.screen.maxMarketCapUsd.toLocaleString()}`);
}

console.log("\nTHE MONEY VETOES ARE GONE, AND THOSE CALLS NOW REACH THE COHORT");
{
  /* This section used to assert the opposite, and it was right to at the time: on
     2026-09-03 the executor refused four consecutive LIVE calls whose stops sat inside
     the round-trip costs, so the desk learned to refuse them first. The lesson survived;
     the SEAT holding it did not.
     What the desk could never see is that its copy of the guard ran at a notional the
     desk invented — $75, against a bot whose real clip is about $2 — so it was not a
     conservative version of the executor's check, it was a differently-wrong one. The
     original still runs, unconditionally, in executor/poller.mjs:1234-1253, on the exact
     lamports about to be spent.
     So the assertion inverts: these three coins now pass compliance, and their fate is
     decided by the wallet that has to pay for them. */
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09], ["USWS", 6.5, 1.03]]) {
    const stop = 1 - stopPct / 100;
    const res = complianceCheck({
      pm: { decision: "PROPOSE" },
      /* Loss at stop, off the STOP ALONE — compliance stopped adding the round trip to
         its recompute on 2026-09-07, so a fixture that still adds it is asserting the
         old arithmetic and fails as `risk_arithmetic_mismatch`. */
      risk: { stop_price: stop, position_size_usd: PAPER_SIZE_USD,
        max_loss_usd: Number((PAPER_SIZE_USD * (stopPct / 100)).toFixed(2)) },
      redteam: { verdict: "survived" },
      ticket: { stop_price: stop, entry_zone_low: 1, entry_zone_high: 1, take_profit: [] },
      ev: { pair: { priceUsd: 1 }, exitProbe: { roundTripLossPct: rt } } });
    const codes = res.violations.map((v) => v.code);
    const money = codes.filter((c) => ["stop_inside_costs", "edge_below_cost", "size_exceeds_exit_probe"].includes(c));
    ok(`${name} (${stopPct}% stop, ${rt}% round trip) is no longer refused on cost`,
      res.pass === true && money.length === 0,
      `compliance said [${codes.join(", ") || "nothing"}]`);
  }
  /* AND THE FLOOR DID NOT MOVE. The same coin carrying a genuine safety fact is still
     refused at every level — proof this section's inversion loosened the money gate and
     nothing else. */
  const stillUnsafe = LEVELS.map((l) => publishCall(CASES.mintable, { escalation: l }));
  ok("a mintable coin with the same bracket is still refused at all five levels",
    stillUnsafe.every((r) => r.outcome === "unsafe" && r.gate === "mintable"),
    stillUnsafe.map((r) => `L${r.level}:${r.gate}`).join(" "));
}

console.log("\nTHE REMOVED GATES LEFT NO DEAD CODES BEHIND");
{
  /* A gate removed from the pipeline but left in GATE_CLASS is worse than either state:
     it reads as a live safety guarantee that nothing can ever fire. Assert the table
     itself no longer names them. */
  const removed = ["cannot_exit", "edge_below_cost", "stop_inside_costs", "size_exceeds_exit_probe"];
  ok("no removed gate is still classified in the table",
    removed.every((g) => !(g in GATE_CLASS)),
    removed.filter((g) => g in GATE_CLASS).join(", ") || `${Object.keys(GATE_CLASS).length} codes, none of them`);
  /* ...and the default still catches them, so a stale record replayed out of the journal
     is refused rather than waived. Default-deny survives the deletion. */
  ok("...yet each still defaults to SAFETY if one turns up on an old record",
    removed.every((g) => gateClass(g) === "SAFETY"),
    removed.map((g) => `${g}=${gateClass(g)}`).join(" "));
  const stale = clean({ outcome: "screened_out", fails: [{ code: "cannot_exit", detail: "replayed from a pre-2026-09-07 record" }] });
  ok("...and such a record is refused at L4, not published",
    cohortEligibility(stale, 4).publishable === false && cohortEligibility(stale, 4).safety === true,
    `gate=${cohortEligibility(stale, 4).gate}`);
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
