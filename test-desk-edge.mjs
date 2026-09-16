/* THE DESK'S EDGE, PINNED TO THE EVIDENCE THAT SET IT (owner, 2026-09-16: "the trading
 * team has been losing again and again — diagnose, fix, change the code and the agents").
 *
 * Diagnosed on the live desk, not on opinion. Its first 132 closed calls: 43% won, +0.4%
 * average on paper, median -4.3%. Underneath the paper, the house floor's first twenty
 * live trades lost 3.2% a trade MORE than the desk's own marks for the same calls, up to
 * 11 points on bonding-curve coins. Four measured facts, four changes, and this file holds
 * each change to the fact that justified it:
 *
 *   1. CONVICTION. Calls the PM scored under 30: n=51, 29% won, -4.7%. At 30 and above:
 *      n=81, 52% won, +3.6%; at 35+, +8.5%. The bar is 35 at L0/L1 and the L2+ floor is
 *      30 — the measured line — and no rung goes under it. (config.js CYCLE)
 *   2. THE SEATS. /api/decisions/seat-scores: technical rho +0.234 PREDICTS (retired a week
 *      earlier, weight 0), flow +0.124 PREDICTS, narrative +0.025 no signal at weight 0.39.
 *      Technical is reinstated with a KILL clause; the weights follow the record.
 *      (config.js weights, analysts.js TECHNICAL_SYSTEM, desk.js CHEAP_SEATS)
 *   3. THE STOP. On calls scored 30+: stops 8-25% under the entry ~60% won, +8%; 25%+ 44%
 *      won, -3.4%; under 8% reached by noise. Stops outside 6%-35% are refused at
 *      publication as JUDGMENT, and the Risk seat is told where the band is.
 *      (calls.js STOP_BAND, mandate.js, decision.js RISK_SYSTEM)
 *   4. FRICTION. The bot's entry round-trip DEFAULT drops from the 12% ceiling to 5%, so
 *      the route ladder shrinks a clip that cannot clear it instead of paying 12% to fill
 *      it whole. The operator's ceiling of 12 is unchanged. (executor/poller.mjs)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let passed = 0;
const ok = (name, cond, detail = "") => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok   ${name}`);
};

/* Config is read with a clean environment: an operator's shell override would be measuring
   the override, not the default the evidence set. */
for (const k of Object.keys(process.env))
  if (/^(CYCLE_|DESK_MODEL_|DESK_EFFORT_)/.test(k)) delete process.env[k];

const { cfg, CYCLE, escalationPlan, MAX_ESCALATION_LEVEL } = await import("./src/config.js");
const { ANALYSTS, TECHNICAL_SYSTEM: TECHNICAL_RAW } = await import("./src/agents/analysts.js");
const TECHNICAL_SYSTEM = String(TECHNICAL_RAW).replace(/\s+/g, " ");
const decision = await import("./src/agents/decision.js");
/* The briefs wrap at 90 columns; the phrases below are read with the wrapping undone. */
const flat = (s) => String(s).replace(/\s+/g, " ");
const RISK_SYSTEM = flat(decision.RISK_SYSTEM), PM_SYSTEM = flat(decision.PM_SYSTEM);
const { CHEAP_SEATS } = await import("./src/desk.js");
const { STOP_BAND, stopDistance, gateFailures, GATE_CLASS } = await import("./src/calls.js");
const { eligibility } = await import("./src/mandate.js");

console.log("\n1 · CONVICTION — under 30 lost (n=51, 29% won, -4.7%); 30+ won (n=81, 52%, +3.6%)");
ok("the L0 bar is 35, the bucket that actually paid", CYCLE.minConviction === 35, String(CYCLE.minConviction));
ok("the L2+ floor is 30, the measured line", CYCLE.floorConviction === 30, String(CYCLE.floorConviction));
for (let L = 0; L <= MAX_ESCALATION_LEVEL; L++) {
  const plan = escalationPlan(L);
  ok(`L${L} never publishes under 30 (bar ${plan.minConviction})`, plan.minConviction >= 30, String(plan.minConviction));
}
ok("the ladder still lowers the bar under quota pressure — to the floor, not under it",
  escalationPlan(2).minConviction < escalationPlan(0).minConviction && escalationPlan(2).minConviction === CYCLE.floorConviction);
ok("the PM is told the number is a graded gate, on the record that set it",
  /YOUR CONVICTION NUMBER IS A PUBLISHED GATE, AND IT IS GRADED/.test(PM_SYSTEM) && /scored under 30 won 29%/.test(PM_SYSTEM));

console.log("\n2 · THE SEATS — the two that predict carry the composite; Technical is back with a KILL");
ok("Technical sits in the analyst table", "technical" in ANALYSTS && ANALYSTS.technical.system === TECHNICAL_RAW);
ok("...on Haiku, in the cheap batch", cfg.models.technical === "claude-haiku-4-5" && CHEAP_SEATS.includes("technical"));
ok("...with a KILL that fires only for a move that is already over",
  /KILL only when the tape says the move is already over/.test(TECHNICAL_SYSTEM) &&
  /A young move, a chop or a thin tape is never a kill/.test(TECHNICAL_SYSTEM));
ok("...and it is forbidden to invent a level the four windows cannot derive",
  /Never invent a support, a resistance, a moving average or a pattern/.test(TECHNICAL_SYSTEM));
ok("...and it knows nano and micro are bought moving — extension there is the last hour turning",
  /whether the LAST HOUR has turned against the day/.test(TECHNICAL_SYSTEM));
const w = cfg.weights;
ok("technical and flow, the seats that predict, weigh at least as much as any other seat",
  w.technical >= w.forensics && w.technical >= w.narrative && w.flow >= w.forensics && w.flow >= w.narrative,
  JSON.stringify(w));
ok("narrative no longer dominates the table", w.narrative < w.technical && w.narrative < w.flow, JSON.stringify(w));
ok("the five weights sum to 1.00", Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9);
ok("the config records the scorecard the weights follow", /technical\s+rho \+0\.234\s+PREDICTS/.test(read("src/config.js")));

console.log("\n3 · THE STOP — 8-25% under the entry is where this desk's stops have paid");
ok("the band is 6% to 35% of the entry", STOP_BAND.min === 0.06 && STOP_BAND.max === 0.35);
ok("stopDistance reads the fraction and refuses nonsense",
  Math.abs(stopDistance(0.8, 1) - 0.2) < 1e-12 && stopDistance(1, 1) === null && stopDistance(0, 1) === null && stopDistance(0.5, 0) === null);
ok("stop_out_of_band is a JUDGMENT gate, so no quota can waive it and no rung names it",
  GATE_CLASS.stop_out_of_band === "JUDGMENT" && !/stop_out_of_band/.test(read("src/config.js")));
const rec = (stop) => ({ outcome: "decided", pm: { decision: "PROPOSE", conviction: 40, invalidation: "x" },
  ticket: { stop_price: stop }, risk: { position_size_usd: 10, stop_price: stop }, order: { size: 10 },
  ev: { pair: { priceUsd: 1, priceChange: { m5: 1 } } }, redteam: { verdict: "wounded" }, compliance: { pass: true, violations: [] } });
ok("gateFailures names the band on a 3% stop", gateFailures(rec(0.97)).some((g) => g.code === "stop_out_of_band"));
ok("...and on a 50% stop", gateFailures(rec(0.5)).some((g) => g.code === "stop_out_of_band"));
ok("...and stays silent on a 20% stop", !gateFailures(rec(0.8)).some((g) => g.code === "stop_out_of_band"));
ok("eligibility refuses both as judgement", eligibility(rec(0.97)).gate === "stop_out_of_band" && eligibility(rec(0.5)).gate === "stop_out_of_band" &&
  eligibility(rec(0.97)).safety === false && eligibility(rec(0.8)).eligible === true);
ok("the Risk seat is told where the band is, and why, before it authors a level",
  /WHERE THIS DESK'S OWN STOPS HAVE WORKED/.test(RISK_SYSTEM) && /stops set 8% to 25% under the entry won about six times/.test(RISK_SYSTEM) &&
  /tighter than 6% or wider than 35% is refused at publication \(stop_out_of_band\)/.test(RISK_SYSTEM));

console.log("\n4 · FRICTION — the bot's default round trip is 5%, not the 12% ceiling");
const poller = read("executor/poller.mjs");
ok("the entry round-trip default is its own constant, 5", /const ENTRY_ROUND_TRIP_DEFAULT_PCT = 5;/.test(poller));
ok("...and it is the default the dial reads",
  /process\.env\.MAX_ENTRY_ROUND_TRIP_LOSS_PCT \|\| ENTRY_ROUND_TRIP_DEFAULT_PCT/.test(poller));
ok("...while the live ceiling stays at 12 for an operator who wants it back",
  /maxEntryRoundTripLossPct: 12,/.test(poller) && /max: EXECUTE \? LIVE_LIMITS\.maxEntryRoundTripLossPct : 50/.test(poller));
ok("the README says so", /`5` default · `12` live ceiling/.test(read("executor/README.md")));
ok("the measurement that set it is recorded beside the dial",
  /lost\s+3\.2% a trade more than the desk's record said/s.test(poller.replace(/\n\s*\*\s?/g, " ")));

console.log(`\n${passed} passed — every knob the desk turned is pinned to the number that turned it`);
