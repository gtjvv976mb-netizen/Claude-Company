/**
 * THE DESK SAYS ONLY WHAT AND WHEN. THE BOT OWNS EVERY MONEY DECISION.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE RULE (owner, 2026-09-07, stated three times and final)
 *
 *   The research desk says WHAT to buy, hold or sell, and WHEN. It must NEVER care
 *   about how much, about fees, about costs, or about balance. The bot owns every money
 *   decision: size, fees, costs, caps, balance.
 *
 * WHY IT IS A CORRECTION AND NOT A LOOSENING. Every money veto the desk held was a
 * DUPLICATE of machinery the bot already owned, and the desk's copy ran on a size the
 * desk invented. Verified counts in executor/ at the time of the change: roundTrip 11
 * references, maxFeeShareOfStop 5, priceImpact 23, validateExecutableEntryOrder 14,
 * networkFee 50. The bot measures the real round trip, at its own real size, against a
 * live quote, immediately before signing.
 *
 * THE INCIDENT. On 2026-09-07 a coin was refused for "round-trip loss 8.08% > ceiling 8%
 * at $75". The bot's actual trade size is about $2. Twelve of the desk's last hundred
 * kills died on that ceiling with nothing else against them.
 *
 * THIS FILE IS THE PROOF, IN BOTH DIRECTIONS. It is not enough that the desk went quiet
 * on money — the judgments have to still exist somewhere, or the rule has traded a
 * duplicate for a hole. So every section asserts a removal AND its surviving equivalent.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-desk-says-what-and-when.mjs
 */
import fs from "node:fs";
import { cfg } from "./src/config.js";
import { complianceCheck } from "./src/agents/compliance.js";
import { enforceRiskRails } from "./src/agents/risk-rails.js";
import { screen } from "./src/data/evidence.js";
import { GATE_CLASS, gateClass, SAFETY_GATES, evaluateExit } from "./src/calls.js";
import * as copy from "./src/copy.js";
/* THE SWEEP READS THE BRIEFS AS VALUES. Every one of these was a template literal buried
   inside an ask() call until 2026-09-07; they are exported now for exactly this reason —
   a prompt a test cannot reach is a prompt nobody is checking. */
import { ANALYSTS, NARRATIVE_SYSTEM } from "./src/agents/analysts.js";
import { SCOUT_SYSTEM, REDTEAM_SYSTEM, RISK_SYSTEM, PM_SYSTEM, EXECUTION_SYSTEM,
  BESTPICK_SYSTEM } from "./src/agents/decision.js";
import { CEO_SYSTEM } from "./src/agents/ceo.js";
import { REVIEW_SYSTEM } from "./src/agents/review.js";
import { SHARED_RULES } from "./src/lib/llm.js";
import { TUTOR_SYSTEM } from "./src/agents/codex-tutor.js";
/* THE LANE JUDGE'S OWN BRIEF. It is a prompt the desk ships — it runs on every technique
   the coach proposes — and it is the one brief that HAS to name fees, slippage and the
   round trip in order to recognise them. A judge whose own prompt could smuggle a
   cost-conditioned imperative into the building would be the exact hole it exists to
   close, so it is swept here with everything else. */
import { POLICY_JUDGE_SYSTEM } from "./src/lib/policy-judge.js";
/* THE DETECTOR LIVES IN src/ NOW, and this file imports the same copy the run-time fence
   imports. It used to be defined a few lines below, inside this test — which was enough
   while a prompt could only change when a human edited a source file. CODEX BANKS
   rewrites the seats' standing orders while the desk trades, and a rule that lives in a
   test protects nothing at run time. desk-policy.js runs THIS function over every
   candidate technique before it can be stored; sharing one copy is what stops the fence
   and the proof from ever disagreeing about what the rule is. */
import { IMPERATIVE, MONEY, NEGATION, windows, costImperatives } from "./src/lib/cost-imperative.js";
/* Namespaces too: the coverage gate resolves a `system:` identifier to its VALUE. */
import * as analysts from "./src/agents/analysts.js";
import * as decision from "./src/agents/decision.js";
import * as ceo from "./src/agents/ceo.js";
import * as review from "./src/agents/review.js";
import * as llm from "./src/lib/llm.js";
import * as tutor from "./src/agents/codex-tutor.js";
import * as policyJudge from "./src/lib/policy-judge.js";
import { planEntry, DEFAULTS } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
/** Lines that RUN, not lines that talk. A deleted judgment may be described at length in
 *  a comment — that is how the next reader learns why it went — but it may not execute. */
const liveLines = (text, re) => text.split("\n")
  .filter((l) => re.test(l) && !/^\s*(\*|\/\*|\/\/)/.test(l));
/* liveLines() only recognises a comment by its LEADING marker, so a block comment whose
   continuation lines are not asterisked reads to it as code — and this file now removes
   judgments by replacing them with long notes about why. `codeOnly` strips comments
   properly before the scan. Deliberately naive about `/*` inside a string literal: no
   file it is pointed at has one, and a false positive here fails loudly rather than
   silently passing something through. */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MONEY_CODES = ["size_exceeds_exit_probe", "edge_below_cost", "stop_inside_costs", "cannot_exit"];

/* One coin, held constant everywhere below: clean mint, readable holders, a real market,
   an exit route that quotes. Only its MONEY properties vary. */
const coin = (over = {}) => ({
  ok: true, mint: "Whn111111111111111111111111111111111111111", symbol: "WHEN",
  pair: { priceUsd: 1, liquidityUsd: 60_000, ageHours: 9, marketCap: 400_000,
    volume: { h24: 90_000 }, txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1 } },
  pairs: { count: 2, totalLiquidityUsd: 60_000 },
  derived: { totalLiquidityUsd: 60_000, volToLiqRatio: 1.5, fdvToLiqRatio: 7, txns24h: 700 },
  mintAccount: { ok: true, flags: [] }, holders: { ok: true, top1Pct: 8 },
  crosscheck: { verdicts: [] },
  exitProbe: { targetSizeUsd: 15, roundTripLossPct: 2 },
  ...over,
});

console.log("\n1. THE DESK EMITS NO SIZE");
{
  copy.settingsFor(7);
  copy.saveSettings(7, { appetite: "aggressive", bankrollSol: 10, fixedSol: 0.4 });
  const d = copy.decide(7, { category: "memecoin", conviction: 62, desk_size_usd: 50, desk_equity_usd: 10_000 });
  ok("a delivery carries sizeSol null, not a number",
    d.verdict === "offered" && d.sizeSol === null, `sizeSol=${d.sizeSol}`);
  ok("...and declares itself non-binding in a machine-readable field",
    d.sizeBinding === false, `sizeBinding=${d.sizeBinding}`);
  ok("...and quotes no SOL amount or dollar figure a client could act on",
    !/\d[\d.]*\s*SOL/i.test(d.reason) && !/\$\s*\d/.test(d.reason), d.reason);

  const copySrc = src("./src/copy.js");
  ok("decide() derives nothing from the floor's bankroll or fixed size",
    liveLines(copySrc.slice(copySrc.indexOf("export function decide(")), /bankroll_sol|fixed_sol|AUTO_RISK_PCT/).length === 0,
    "no live read of a tenant's money settings in decide()");
  ok("the desk's per-floor sizing helpers are gone",
    copy.probeSizeCapSol === undefined && copy.probeSizingMismatch === undefined
    && copy.AUTO_RISK_PCT_PER_TRADE === undefined,
    "probeSizeCapSol / probeSizingMismatch / AUTO_RISK_PCT_PER_TRADE");

  // THE BOT'S EQUIVALENT, and it still binds.
  const stratSrc = src("./executor/strategy.mjs");
  ok("BOT: strategy.mjs still sizes from its own equity and caps",
    liveLines(stratSrc, /want = \(f \* equity\) \/ effectiveStopFrac/).length === 1
    && liveLines(stratSrc, /want = Math\.min\(want, c\.maxSolPerTrade\)/).length === 1,
    "executor/strategy.mjs:243-246, 305");
  ok("BOT: ...and reads neither call.size_sol nor ev.fixed_sol",
    liveLines(stratSrc, /call\.size_sol/).length === 0
    && liveLines(src("./executor/poller.mjs"), /ev\.fixed_sol/).length === 0,
    "executor/strategy.mjs:247, executor/poller.mjs:1192");
}

console.log("\n2. THE DESK MAKES NO FEE JUDGMENT");
{
  const configSrc = src("./src/config.js");
  for (const key of ["executorMaxFeeShareOfStop", "executorSlippageBps", "executorWorstFeeRatio"])
    ok(`cfg.${key} is gone`, cfg[key] === undefined, `cfg.${key} = ${cfg[key]}`);
  ok("...and no live line of config.js defines one",
    liveLines(configSrc, /executorMaxFeeShareOfStop|executorSlippageBps|executorWorstFeeRatio/).length === 0,
    "every mention is a comment explaining the removal");

  /* THE FEE FLOOR THAT SUPPRESSED CALLS. decide() used to skip a floor entirely when the
     size it had just invented came out under ~0.02 SOL — "below that, network fees eat
     the trade". A fee judgment, on a made-up size, that stopped the tenant hearing about
     a coin. A tiny bankroll must now still receive the call. */
  copy.settingsFor(8);
  copy.saveSettings(8, { appetite: "conservative", bankrollSol: 0.05, fixedSol: 0.0005 });
  const tiny = copy.decide(8, { category: "memecoin", conviction: 55 });
  ok("a floor whose whole bankroll is 0.05 SOL still receives the call",
    tiny.verdict === "offered", `${tiny.verdict}: ${tiny.reason}`);

  // THE BOT'S EQUIVALENT: the fee floor, judged against the real reserve and real stop.
  const stratSrc = src("./executor/strategy.mjs");
  ok("BOT: strategy.mjs still derives a fee floor from its own reserve and stop",
    liveLines(stratSrc, /feeFloorSol = feeReserve > 0 && c\.maxFeeShareOfStop > 0/).length === 1,
    "executor/strategy.mjs:232-234");
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: 0.3366, spendableSol: 0.3366, wins: 0, losses: 0 };
  const refused = planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop: 0.95, target: 3, conviction: 100 },
    cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
      networkFeeReserveSol: 500_000 / 1e9, measuredRoundTripLossPct: 2.26 }, state });
  ok("BOT: ...and refuses a 5% stop because no size clears that floor",
    refused.action === "skip", refused.reason);
}

console.log("\n3. THE DESK MAKES NO COST JUDGMENT");
{
  ok("cfg.maxRoundTripSlippagePct is gone", cfg.maxRoundTripSlippagePct === undefined);
  ok("cfg.minStopDistancePct is gone", cfg.minStopDistancePct === undefined);

  /* THE SCREEN. A round trip of 22.5% at the probed amount — nearly three times the old
     8% ceiling — no longer kills. This is the DEGS case, generalised. */
  const dear = screen(coin({ exitProbe: { targetSizeUsd: 15, roundTripLossPct: 22.5 } }));
  ok("a 22.5% round trip does not fail the screen",
    !dear.fails.some((f) => f.code === "cannot_exit"),
    dear.fails.map((f) => f.code).join(",") || "no failures");

  /* COMPLIANCE. A 3% stop and a first target only 1% away, against a 22.5% round trip:
     by every one of the old rules this was three separate vetoes. */
  const ev = coin({ exitProbe: { targetSizeUsd: 15, roundTripLossPct: 22.5 } });
  const res = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    /* Sized to sit inside the desk's OWN paper book ($10k equity, 1% max risk = $100),
       so the only thing that could fail here is a money veto. An earlier draft used 900
       and passed while also raising risk_budget_breach — true, unrelated, and enough
       noise to hide a real failure behind. */
    risk: { stop_price: 0.97, position_size_usd: 300, max_loss_usd: Number((300 * (0.03 + 0.225)).toFixed(2)) },
    ticket: { entry_zone_low: 1, entry_zone_high: 1.02, stop_price: 0.97,
      take_profit: [{ price: 1.01, pct_to_sell: 100 }] }, ev });
  /* THE VIOLATIONS THIS FIXTURE DOES RAISE ARE NOT MONEY VETOES, and the assertion is
     written by NAME so that stays checkable. A 1% target under a 1.02 zone high is a
     bracket that sells into its own entry (`target_inside_zone`) and is inside the
     bot's declared 6% round trip (`target_inside_cost`) — both added 2026-09-09, both
     judged on numbers the desk authored itself, both identical at $2 and at $75. That
     size-independence is the whole test for whether a judgment is the desk's, and it is
     why neither is in MONEY_CODES. */
  ok("compliance raises no money veto on a 3% stop, a 1% target and a 22.5% round trip",
    !res.violations.some((v) => MONEY_CODES.includes(v.code)),
    res.violations.map((v) => v.code).join(",") || "no violations");

  /* RISK RAILS. The round-trip ceiling used to zero the position mechanically; the
     probed notional used to cap it. A size 60x the probe now survives both. */
  const railed = enforceRiskRails({ risk: { stop_price: 0.75, risk_tier: "full", confidence: 1 },
    ev, redteam: { verdict: "survived" } });
  ok("risk-rails does not mechanically zero a coin for its round-trip cost",
    railed.position_size_usd > 0, `$${railed.position_size_usd} — ${railed.rail_notes.join("; ")}`);
  ok("...and does not cap to the probed notional",
    railed.position_size_usd > ev.exitProbe.targetSizeUsd,
    `$${railed.position_size_usd} vs a $${ev.exitProbe.targetSizeUsd} probe`);

  // THE BOT'S EQUIVALENT: two of them, both unconditional, both at the bot's own size.
  const pollerSrc = src("./executor/poller.mjs");
  /* RE-ANCHORED, NOT RELAXED (route sizing, 2026-09-09). The guard moved into
     executor/entry-sizing.mjs so the halving ladder applies it at EVERY candidate amount
     instead of once at the desk's clip — strictly more refusal, and still the BOT's, at
     the bot's own size: poller.mjs hands it the bot's entryReference stop and the bot's
     own cost model, and no desk field reaches the ladder at all. */
  const sizingSrc = src("./executor/entry-sizing.mjs");
  /* RE-ANCHORED, NOT RELAXED (the paper-preflight seam, 2026-09-09). This counted the
     poller's sizeEntryToRoute arguments and required EXACTLY ONE of each, which is a
     count of CALL SITES standing in for the property. SIM C's PAPER_PREFLIGHT seam adds a
     second call site — paper mode now runs the same ladder instead of returning before it
     — and the literal 1 went red while the property it protects was untouched.
     The property is "every call to the route sizer is handed the BOT's own stop ratio and
     the BOT's own fee model, and no desk field reaches it", so that is what is asserted
     now, over every call site rather than over an assumed single one. Strictly stronger:
     the old form said nothing about a second call site, this one judges all of them. */
  const sizingCalls = codeOnly(pollerSrc).split("sizeEntryToRoute({").slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("})")));
  ok("BOT: the entry path still refuses an entry whose costs already reach the stop",
    liveLines(sizingSrc, /cost\.conservativeReturnRatio <= stopRatio/).length === 1
    && liveLines(sizingSrc, /worstFeeRatio = 2 \* expectedNetworkFeeLamports \/ Number\(input\)/).length === 1
    && sizingCalls.length >= 1
    && sizingCalls.every((c) => /stopRatio: entryReference\.stopRatio/.test(c)
      && /expectedNetworkFeeLamports: jupiter\.cfg\.expectedNetworkFeeLamports/.test(c)),
    `executor/entry-sizing.mjs, on the ladder's own quoted lamports — ${sizingCalls.length} ` +
    `sizeEntryToRoute call site(s) in poller.mjs, every one on the bot's own stop and fee model`);
  ok("BOT: jupiter.mjs still caps the measured entry round trip",
    liveLines(src("./executor/jupiter.mjs"), /if \(lossPct > cap\) throw new Error/).length === 1,
    "executor/jupiter.mjs:1349, maxEntryRoundTripLossPct");
  ok("BOT: ...and refuses an order whose real price impact is too high",
    liveLines(src("./executor/jupiter.mjs"), /if \(impact > cfg\.maxPriceImpactPct\) throw new Error/).length === 1,
    "executor/jupiter.mjs:148-149, on the built order");
  ok("BOT: strategy.mjs still refuses a bracket whose costs eat the target",
    liveLines(src("./executor/strategy.mjs"), /costs eat the target: R_net/).length === 1,
    "executor/strategy.mjs:161-164");
}

console.log("\n4. THE COIN-QUALITY JUDGMENTS ARE ALL STILL THERE");
{
  /* WHAT, not HOW MUCH. Every one of these is a fact about the token that gets the same
     answer at every order size — which is exactly the test for whether it is the desk's
     to make. Driven through the real screen, not asserted off a list. */
  const cases = [
    ["mintable", coin({ mintAccount: { ok: true, flags: ["mint_authority_live"] } })],
    ["freezable", coin({ mintAccount: { ok: true, flags: ["freeze_authority_live"] } })],
    ["seizable", coin({ mintAccount: { ok: true, flags: ["ext_permanentDelegate"] } })],
    ["transfer_hook", coin({ mintAccount: { ok: true, flags: ["ext_transferHook"] } })],
    ["unverified_mint", coin({ mintAccount: { error: "rpc 429" } })],
    ["unverified_holders", coin({ holders: { ok: false, error: "rpc 429" } })],
    ["unverified_exit", coin({ exitProbe: { targetSizeUsd: 15, error: "no route" } })],
    ["holder_concentration", coin({ holders: { ok: true, top1Pct: 61 } })],
    ["serial_deployer", coin({ deployer: { ok: true, priorLaunches: 22, graduated: 0 } })],
    ["wash_suspect", coin({ derived: { totalLiquidityUsd: 60_000, volToLiqRatio: 900, fdvToLiqRatio: 7, txns24h: 700 } })],
    ["too_new", coin({ pair: { ...coin().pair, ageHours: 0.01 } })],
    ["no_volume", coin({ pair: { ...coin().pair, volume: { h24: 1 } } })],
    ["no_participants", coin({ derived: { totalLiquidityUsd: 60_000, volToLiqRatio: 1.5, fdvToLiqRatio: 7, txns24h: 1 } })],
  ];
  for (const [code, ev] of cases) {
    const codes = screen(ev).fails.map((f) => f.code);
    ok(`${code} still kills`, codes.includes(code), codes.join(",") || "nothing fired");
  }

  /* THIN LIQUIDITY, and the reason it is NOT an inconsistency beside the deleted
     cannot_exit. "What does it cost to leave?" changes with the order size, so only the
     bot can answer it. "Is there a market here at all?" gets the same answer at every
     size: $0.65 across two venues has nothing on the other side of any order. */
  const noMarket = screen(coin({ pairs: { count: 2, totalLiquidityUsd: 0.65 },
    derived: { totalLiquidityUsd: 0.65, volToLiqRatio: 1.5, fdvToLiqRatio: 7, txns24h: 700 } }));
  ok("thin_liquidity still kills — a $0.65 pool is not an expensive market, it is no market",
    noMarket.fails.some((f) => f.code === "thin_liquidity"),
    noMarket.fails.map((f) => f.code).join(","));
  ok("...and the code says WHY it survived the round that removed cannot_exit",
    /it is not a market/.test(src("./src/data/evidence.js"))
    && /same answer at every size/i.test(src("./src/data/evidence.js")),
    "data/evidence.js states the WHAT-versus-HOW-MUCH distinction at the check");

  /* THE NARRATIVE READ, the desk's other genuine WHAT. Its two arms stay separated. */
  ok("the manufactured-narrative read is still classified, as JUDGMENT",
    gateClass("manufactured_narrative") === "JUDGMENT");
  ok("...and the deployer-has-rugged FACT is still SAFETY",
    gateClass("deployer_has_rugged") === "SAFETY");
  ok("post_migration_dump is still SAFETY", gateClass("post_migration_dump") === "SAFETY");
}

console.log("\n5. THE REMOVED GATES LEFT NO DEAD CODES, AND UNKNOWN STILL MEANS SAFETY");
{
  ok("no removed gate is still classified",
    MONEY_CODES.every((c) => !(c in GATE_CLASS)),
    MONEY_CODES.filter((c) => c in GATE_CLASS).join(",") || `${SAFETY_GATES.length} safety codes, none of them`);
  ok("an unknown gate still defaults to SAFETY",
    gateClass("a_gate_nobody_has_classified_yet") === "SAFETY");
  ok("...which is what catches a removed code replayed off an old record",
    MONEY_CODES.every((c) => gateClass(c) === "SAFETY"),
    MONEY_CODES.map((c) => `${c}=${gateClass(c)}`).join(" "));
}

console.log("\n6. THE PROMPT SWEEP — every brief the desk ships, not one seat's");
/* ═══════════════════════════════════════════════════════════════════════════════════
 * WHY THIS SECTION WAS REWRITTEN, AND IT IS THE REASON THE OTHER SEVEN SURVIVED.
 *
 * It used to be three regexes against ONE file for ONE seat: "the Risk seat is told size
 * is not its question". Risk was clean, the section was green, and the desk shipped SIX
 * other briefs nobody looked at. An adversarial pass found the liquidity seat still
 * ordered to "KILL if the position cannot be exited at an acceptable cost", the execution
 * seat still ordered to put its first target at "AT LEAST 5x THE MEASURED ROUND-TRIP
 * COST" and to set slippage "against the measured round-trip cost", and the CEO still
 * handed the round trip as a headline fact — all under a green 113/113 suite.
 *
 * So the sweep iterates EVERY prompt string the desk ships, prints each one's name and
 * verdict so the coverage is visible rather than asserted, and — the part that makes it
 * stay true — cross-checks the registry against the source: every `system:` site under
 * src/ must name a brief this sweep holds. Add a seat, or inline a literal back into a
 * call, and this file fails until the new prompt is swept.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  /* The detector is imported, not defined here: see the note at the import. Its
     reasoning — the two halves in one window, the sentence-or-bullet window, the
     negation arm that lets the desk say the rule out loud, and why it is
     case-INSENSITIVE — is written out in src/lib/cost-imperative.js. What this section
     still owns is the SWEEP: which prompts are judged, that the registry is complete,
     and that the detector has teeth. Those are asserted below.
     IMPERATIVE, MONEY, NEGATION and windows are imported alongside it so a reader can
     see the regexes themselves from here; the assertions immediately below drive them. */
  ok("the detector's two halves and its exoneration arm are the shared ones",
    IMPERATIVE.test("MUST") && MONEY.test("round-trip") && NEGATION.test("never") &&
    windows("One. Two.").length === 2,
    "imported from src/lib/cost-imperative.js");

  /* EVERY PROMPT THE DESK SHIPS, as VALUES — not as source text, so a brief that is
     assembled or interpolated at run time is swept in the form the model actually sees.
     `ANALYSTS` is spread so a sixth analyst seat joins the sweep the day it is written. */
  const PROMPTS = {
    SHARED_RULES,
    ...Object.fromEntries(Object.entries(ANALYSTS).map(([k, a]) => [`ANALYSTS.${k}.system`, a.system])),
    NARRATIVE_SYSTEM,
    SCOUT_SYSTEM, REDTEAM_SYSTEM, RISK_SYSTEM, PM_SYSTEM, EXECUTION_SYSTEM, BESTPICK_SYSTEM,
    CEO_SYSTEM, REVIEW_SYSTEM, TUTOR_SYSTEM, POLICY_JUDGE_SYSTEM,
  };

  console.log(`  sweeping ${Object.keys(PROMPTS).length} prompts:`);
  for (const [name, text] of Object.entries(PROMPTS)) {
    const hits = costImperatives(String(text ?? ""));
    ok(`    ${name} carries no cost-conditioned imperative`, hits.length === 0,
      hits.length ? hits[0].replace(/\s+/g, " ").slice(0, 150) : `${String(text).length} chars swept, clean`);
  }

  /* THE COVERAGE GATE. Without this the sweep is only as complete as whoever last edited
     it remembered to be — which is exactly how one Risk-scoped section came to stand in
     for seven seats. Every `system:` in the desk's source must hand over a NAMED brief,
     and that name must be one this sweep holds. */
  const promptFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith(".js")) promptFiles.push(`${dir}${entry.name}`);
    }
  };
  walk("./src/");
  const sites = [];
  for (const rel of promptFiles)
    for (const line of src(rel).split("\n")) {
      const m = /^\s*system:\s*(.+?),?\s*$/.exec(line);
      if (m && !/^\s*(\*|\/\*|\/\/)/.test(line)) sites.push({ rel, expr: m[1].replace(/,$/, "").trim() });
    }
  /* RESOLVED BY VALUE, NOT BY NAME. A site names `FORENSICS_SYSTEM` while the sweep holds
     it as `ANALYSTS.forensics.system`; matching identifiers would have to know that, and
     would be satisfied by any const with a plausible name. So the identifier is looked up
     in the module it lives in and its STRING is compared against what was actually swept.
     Rename a brief and nothing breaks; ship one this sweep never read and it fails. */
  const namespaces = [analysts, decision, ceo, review, llm, tutor, policyJudge];
  const sweptValues = new Set(Object.values(PROMPTS).map(String));
  const resolve = (id) => { for (const ns of namespaces) if (typeof ns[id] === "string") return ns[id]; return null; };
  // `a.system` is the ANALYSTS table's own dispatch and every row of it is swept above;
  // `[` is llm.js building the request's `system` array from SHARED_RULES alone (the
  // seat's brief now travels in the user turn, after the cached bundle — seatTurn()),
  // and the PM's Grok path is those same two swept strings concatenated. The string
  // form askWithWeb used to build was an allowed indirection here until it went to the
  // same array as ask(); the entry is gone so nothing can ship under it unswept.
  const ALLOWED_INDIRECTION = new Set(["a.system", 'SHARED_RULES + "\\n\\n" + PM_SYSTEM']);
  const uncovered = sites.filter((s0) => {
    const e = s0.expr;
    if (ALLOWED_INDIRECTION.has(e) || e.startsWith("[")) return false;
    // A backtick here means a brief was inlined back into a call, where no test reaches it.
    if (!/^[A-Za-z_$][\w$]*$/.test(e)) return true;
    const value = resolve(e);
    return value == null || !sweptValues.has(value);
  });
  ok(`every system: site in src/ names a swept brief (${sites.length} sites, ${promptFiles.length} files)`,
    uncovered.length === 0,
    uncovered.map((u) => `${u.rel}: ${u.expr.slice(0, 60)}`).join(" | ") || "no inlined or unswept prompt");

  /* AND THE SWEEP HAS TO HAVE TEETH. A detector nobody has watched fire is a detector
     that might match nothing at all — so drive it with the exact strings the desk used to
     ship, and with the corrected wording that must NOT trip it. */
  const wasShipped = [
    ["liquidity seat", "KILL if the position cannot be exited at an acceptable cost."],
    ["execution seat", "THE FIRST TARGET MUST BE AT LEAST 5x THE MEASURED ROUND-TRIP COST."],
    ["execution seat", "Slippage tolerance must be set against the measured round-trip cost, with headroom."],
  ];
  for (const [seat, line] of wasShipped)
    ok(`the detector fires on what the ${seat} used to ship`, costImperatives(line).length === 1, line.slice(0, 60));
  const mustStaySayable = [
    "KILL only when there is no market at all, or when no route out can be quoted.",
    "Never on what leaving costs.",
    "So you never kill on price, cost, fees or slippage.",
    "So do not reason about dollars, fees, slippage, what a round trip costs.",
  ];
  for (const line of mustStaySayable)
    ok("...and not on the correction itself", costImperatives(line).length === 0, line.slice(0, 60));

  /* The two sentences the Risk seat has carried since the change, still there, and now
     required in the seats that were making the same mistake without them. */
  ok("the Risk seat is still told size is not its question",
    /HOW MUCH IS BOUGHT IS NOT YOUR QUESTION AND NOT THIS DESK'S/.test(RISK_SYSTEM));
  for (const [name, text] of [["CEO", CEO_SYSTEM], ["PM", PM_SYSTEM], ["Liquidity", ANALYSTS.liquidity.system]])
    ok(`...and so is the ${name} seat, in the same words`,
      /IS NOT YOUR QUESTION AND NOT THIS DESK'S/.test(text));
  ok("the CEO's token line no longer quotes the round trip at it",
    !/round-trip cost \$\{|roundTripLossPct/.test(src("./src/agents/ceo.js").split("prompt:")[1] ?? ""),
    "ceo.js prompt block");
  ok("no seat is handed a computed dollar floor",
    liveLines(src("./src/agents/decision.js"), /stopFloorForCoin|minStopDistancePct|probedNotionalUsd/).length === 0,
    "no live reference to a removed helper or knob");
}

console.log("\n7. THE JUDGMENTS THAT SURVIVED THE CODE VETOES — balance, the monitor, the wire");
/* Every one of these was live under a green 113/113 suite. They are code paths, not
   prompts, and each is driven here rather than grepped for. */
{
  /* 7a. THE DESK NO LONGER REFUSES ON ITS OWN PAPER BALANCE.
     Reproduced before the fix: four live calls with no recorded desk_risk_usd reserved
     the whole $400 paper book, riskBudget hit 0, and a clean coin was declined with
     safety:true at `zero_authorized_size` — a SAFETY gate no escalation level can pass. */
  const cleanEv = { symbol: "CLEAN", mint: "Whn111111111111111111111111111111111111111",
    pair: { priceUsd: 0.001, priceChange: { m5: 2 } },
    pairs: { count: 3, totalLiquidityUsd: 60_000 },
    exitProbe: { roundTripLossPct: 1.2 },
    mintAccount: { mintAuthority: null, freezeAuthority: null, flags: [] } };
  const sized = enforceRiskRails({ risk: { risk_tier: "full", stop_price: 0.0007, confidence: 0.9 },
    ev: cleanEv, redteam: { verdict: "survives" } });
  ok("a clean coin is still sized whatever the desk's paper book is carrying",
    sized.position_size_usd > 0, `$${sized.position_size_usd}`);
  ok("...and no rail note mentions book heat, open risk or a balance",
    !/book heat|already at risk|balance/i.test((sized.rail_notes || []).join("; ")),
    (sized.rail_notes || []).join("; "));
  const signature = String(enforceRiskRails).split("\n")[0];
  ok("enforceRiskRails takes no openRiskUsd argument any more",
    !/openRiskUsd/.test(signature), signature.trim());
  ok("`maxBookRiskPct` is gone from config entirely",
    !("maxBookRiskPct" in cfg), Object.keys(cfg).filter((k) => /book/i.test(k)).join(",") || "no book knob");
  const bookClamps = [
    ...liveLines(codeOnly(src("./src/agents/risk-rails.js")), /remainingBookRisk|maxBookRisk|retainedBookRiskUsd/),
    ...liveLines(codeOnly(src("./src/desk.js")), /retainedBookRiskUsd|openRiskUsd/)];
  ok("no live line anywhere clamps size to a remaining book budget",
    bookClamps.length === 0, bookClamps.join(" | ") || "risk-rails.js and desk.js carry only the note");

  /* 7b. AND THE ZEROS THAT ARE NOT ABOUT MONEY STILL ZERO. This is the over-removal
     guard: `zero_authorized_size` had to keep its teeth for the unmeasurable exit and
     the live authority, which are facts about the coin. */
  const unprovenExit = enforceRiskRails({ risk: { risk_tier: "full", stop_price: 0.0007, confidence: 0.9 },
    ev: { ...cleanEv, exitProbe: { error: "no route" } }, redteam: { verdict: "survives" } });
  ok("an exit nobody could measure still zeroes the size", unprovenExit.position_size_usd === 0,
    (unprovenExit.rail_notes || []).join("; "));
  for (const [what, mintAccount] of [
    ["a live mint authority", { mintAuthority: "Mint1111", freezeAuthority: null, flags: [] }],
    ["a live freeze authority", { mintAuthority: null, freezeAuthority: "Frz11111", flags: [] }],
    ["a permanent delegate", { mintAuthority: null, freezeAuthority: null, flags: ["permanent_delegate"] }]]) {
    const z = enforceRiskRails({ risk: { risk_tier: "full", stop_price: 0.0007, confidence: 0.9 },
      ev: { ...cleanEv, mintAccount }, redteam: { verdict: "survives" } });
    ok(`${what} still zeroes the size`, z.position_size_usd === 0, (z.rail_notes || []).join("; "));
  }
  ok("...and zero_authorized_size is still SAFETY, so those zeros are still unwaivable",
    gateClass("zero_authorized_size") === "SAFETY");

  /* 7c. THE MONITOR NO LONGER SELLS ON WHAT LEAVING COSTS.
     Reproduced before the fix: rtLossPct 12.1 fired an unconditional 100% exit on a
     position whose liquidity was 97% of the call's and whose mark was above entry. */
  const held = { id: 990_001, entry_ref: 0.001, stop: 0.0007, target: 0.0025,
    opened_at: Date.now() - 60_000, liq_at_call: 60_000, flags_at_call: "[]",
    hold_band: null, hold_max_ms: null };
  const healthy = { mark: 0.00102, liqUsd: 58_000, flags: [], flagsReadable: true, nowMs: Date.now() };
  for (const rt of [12.1, 30, 99]) {
    const v = evaluateExit(held, { ...healthy, rtLossPct: rt });
    ok(`a ${rt}% round trip does not sell a position that is otherwise fine`,
      v.fire !== true && v.code !== "cannot_exit", JSON.stringify(v));
  }
  const stillFires = liveLines(codeOnly(src("./src/calls.js")), /cannot_exit/);
  ok("no live line in calls.js raises cannot_exit any more",
    stillFires.length === 0, stillFires.join(" | ") || "only the note at its old site");
  /* ...AND WHAT REPLACED IT STILL FIRES. The point of dropping the trigger was that
     liq_collapse is the better ruler for the same danger, so it had better work. */
  const drained = evaluateExit(held, { ...healthy, liqUsd: 20_000, rtLossPct: 1 });
  ok("liquidity collapsing still fires an unconditional exit",
    drained.fire === true && drained.code === "liq_collapse" && drained.urgency === "unconditional",
    JSON.stringify(drained));
  const seized = evaluateExit(held, { ...healthy, flags: ["freeze_authority_live"], rtLossPct: 1 });
  ok("an authority appearing still fires an unconditional exit",
    seized.fire === true && seized.code === "authority_appeared", JSON.stringify(seized));

  /* 7d. THE WIRE. A SOL amount has no business riding on a published ticket. */
  const office = src("./src/office.js");
  const eventsBlock = office.slice(office.indexOf("events: rows.map("), office.indexOf("/** Authenticated route payload"));
  ok("no fixed_sol on the per-event payload", !/^\s*fixed_sol:/m.test(eventsBlock),
    liveLines(eventsBlock, /fixed_sol/).join(" | ") || "the event carries no SOL amount");
  ok("...while size_binding:false survives for legacy clients",
    /size_binding: false/.test(eventsBlock) && /size_binding: false/.test(office.slice(0, office.indexOf("events: rows.map("))));
  ok("rt_loss_at_call is labelled an observation on the wire",
    /rt_loss_at_call_is_observation: true/.test(eventsBlock),
    "a recorded measurement, not an instruction");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
