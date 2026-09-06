/**
 * A STOP INSIDE THE ROUND TRIP IS A LOSS SOMEBODY HAS ALREADY BOOKED — AND IT IS THE
 * BOT'S JOB TO SAY SO, NOT THE DESK'S.
 *
 * THE HISTORY THIS FILE KEEPS. On 2026-09-03 the bot refused four consecutive live calls
 * with the same sentence: "entry round trip plus worst-case fees is already at/below the
 * authored stop". HeeHaw, TOAD, USWS and a second HeeHaw carried stops 5% to 6.5% below
 * entry against a conservative cost near 9%. The desk had published trades its own bot
 * could prove were already lost, and the response was to reproduce the bot's guard at
 * publish time as `stop_inside_costs`, with cfg.minStopDistancePct as its fallback.
 *
 * WHY THAT ANSWER WAS WRONG, measured 2026-09-07. The guard's verdict depends on the
 * ORDER SIZE — fees are a fixed number of lamports, so they are a huge share of a small
 * trade and a trivial share of a large one — and the desk does not know the order size.
 * It was running the calculation at $75 while the bot's real clip is about $2. That is
 * not a conservative copy of the executor's check; it is a differently-wrong one, and it
 * withheld sound calls in one direction while the config was tuned back and forth in the
 * other (executorWorstFeeRatio was revised 5.7% -> 2.5% after a sweep found the desk
 * blocking 8.5%-9.5% stops the bot would happily have taken).
 *
 * SO THE CONTRACT INVERTED, and this file inverted with it rather than being deleted.
 * The owner's rule is that the desk says only WHAT and WHEN. What this file now proves:
 *
 *   1. the desk holds NO stop floor, at any distance, on any coin;
 *   2. the config knobs that fed it are gone, so nobody can quietly re-derive one;
 *   3. the executor's guard is still there, still unconditional, and still refuses
 *      exactly the four calls of 2026-09-03 — at the size it is really about to sign for;
 *   4. the Risk seat is still asked for an honest invalidation level, in words about the
 *      COIN rather than about dollars.
 *
 *   node test-stop-floor.mjs
 */
import fs from "node:fs";
import { cfg } from "./src/config.js";
import { complianceCheck } from "./src/agents/compliance.js";
import { planEntry, DEFAULTS } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE DESK STATES NO STOP FLOOR, AND HAS NO KNOB LEFT TO STATE ONE WITH");
{
  for (const key of ["minStopDistancePct", "executorSlippageBps", "executorMaxFeeShareOfStop",
                     "executorWorstFeeRatio", "maxRoundTripSlippagePct", "targetSizeUsd"])
    ok(`cfg.${key} is gone`, cfg[key] === undefined, `cfg.${key} = ${cfg[key]}`);

  /* Grepped rather than merely read off cfg, because a reintroduction would most likely
     arrive as a fresh local constant in the seat that used it rather than as a config
     key. The desk may still MENTION these ideas in a comment; it may not compute one. */
  const complianceSrc = fs.readFileSync(new URL("./src/agents/compliance.js", import.meta.url), "utf8");
  const live = complianceSrc.split("\n").filter((l) =>
    /(minStopDistancePct|executorSlippageBps|executorMaxFeeShareOfStop|slippageHaircut|haircut)/.test(l)
    && !/^\s*(\*|\/\*|\/\/)/.test(l));
  ok("compliance.js computes nothing from a cost model", live.length === 0,
    live.length ? live.slice(0, 2).map((l) => l.trim()).join(" | ") : "every mention is prose in a comment");
}

console.log("\nNO STOP DISTANCE IS REFUSED BY THE DESK — NOT EVEN 1%");
{
  /* The whole sweep, including the absurd end of it. A 1% stop on a coin whose round
     trip costs 9% is almost certainly a bad trade, and saying so is not this desk's job:
     it is a claim about what the trade COSTS, which depends on a size the desk does not
     know. The bot refuses it below, at its own size, which is where the claim is true. */
  const codes = (stopPct, rtPct) => complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    risk: { stop_price: 1 - stopPct / 100, position_size_usd: 12,
      max_loss_usd: Number((12 * (stopPct / 100 + rtPct / 100)).toFixed(2)) },
    ticket: { stop_price: 1 - stopPct / 100, entry_zone_low: 1, entry_zone_high: 1.02,
      take_profit: [{ price: 1.02, pct_to_sell: 100 }] },
    ev: { pair: { priceUsd: 1 }, exitProbe: { targetSizeUsd: 15, roundTripLossPct: rtPct } },
  }).violations.map((v) => v.code);

  const MONEY = ["stop_inside_costs", "edge_below_cost", "size_exceeds_exit_probe"];
  const refused = [];
  for (let stopPct = 1; stopPct <= 40; stopPct += 0.5)
    for (const rt of [0, 0.2, 1, 2.26, 5, 9, 22.5])
      for (const c of codes(stopPct, rt)) if (MONEY.includes(c)) refused.push(`${stopPct}%/${rt}%:${c}`);
  ok("no stop distance at any measured round trip raises a money veto",
    refused.length === 0, refused.length ? refused.slice(0, 3).join(", ") : "312 combinations, none refused");

  // The four real calls, named, because they are why the old floor existed.
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09],
                                     ["USWS", 6.5, 1.03], ["HeeHaw again", 8.5, 2.23]])
    ok(`${name}'s ${stopPct}% stop now passes compliance`,
      !codes(stopPct, rt).some((c) => MONEY.includes(c)), codes(stopPct, rt).join(",") || "clean");

  /* AND THE ARITHMETIC CHECKS ARE UNTOUCHED. Removing the cost floor must not have
     removed the checks that are true at every size — a stop above the entry zone fires
     on arrival whatever anybody paid for the trade. */
  const inverted = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    risk: { stop_price: 1.2, position_size_usd: 12, max_loss_usd: 1 },
    ticket: { stop_price: 1.2, entry_zone_low: 1, entry_zone_high: 1.02, take_profit: [] },
    ev: { pair: { priceUsd: 1 }, exitProbe: { targetSizeUsd: 15, roundTripLossPct: 2 } },
  });
  ok("a stop ABOVE the entry zone is still a veto",
    inverted.violations.some((v) => v.code === "stop_above_entry"),
    inverted.violations.map((v) => v.code).join(","));
}

console.log("\nTHE EXECUTOR'S GUARD IS STILL THERE, AND STILL REFUSES THOSE FOUR");
{
  /* The guard read out of the source rather than imported, because importing poller.mjs
     boots the bot. This is the check the desk was copying, in the file where its inputs
     are real: `preflight.lossPct` is measured on `preliminaryAmountRaw`, the lamports
     about to be spent, and `worstFeeRatio` is the fee share of that same order. */
  const pollerSrc = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
  ok("poller.mjs still computes a conservative return and compares it to the stop",
    /conservativeReturnRatio\s*=\s*executableReturnRatio\s*\*\s*slippageHaircut\s*-\s*worstFeeRatio/.test(pollerSrc)
    && /if\s*\(conservativeReturnRatio\s*<=\s*entryReference\.stopRatio\)/.test(pollerSrc),
    "executor/poller.mjs:1234-1253");
  ok("...on the amount it is really about to spend, not on a desk constant",
    /worstFeeRatio\s*=\s*2\s*\*\s*jupiter\.cfg\.expectedNetworkFeeLamports\s*\/\s*Number\(preliminaryAmountRaw\)/.test(pollerSrc),
    "worstFeeRatio is a share of preliminaryAmountRaw");
  ok("...and jupiter.mjs still caps the measured entry round trip",
    /entry round-trip loss \$\{lossPct\}% exceeds cap/.test(
      fs.readFileSync(new URL("./executor/jupiter.mjs", import.meta.url), "utf8")),
    "executor/jupiter.mjs:1341-1350, maxEntryRoundTripLossPct");

  /* Now RUN the arithmetic on the four calls at the bot's real numbers. FEE and the
     wallet are the live figures from the 2026-09-03 log; SLIP is the executor's own
     slippage tolerance applied to both legs. */
  const FEE = 500_000, WALLET = 0.3366;
  const SLIP = (1 - DEFAULTS.slippageBps / 10_000) ** 2 || (1 - 300 / 10_000) ** 2;
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0 };
  const botTakes = (stopPct, rtPct) => {
    const sized = planEntry({
      call: { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - stopPct / 100, target: 3, conviction: 100 },
      cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
        networkFeeReserveSol: FEE / 1e9, measuredRoundTripLossPct: rtPct }, state });
    /* Name the mechanism as well as quoting the executor's own words. Three of the four
       are refused by the FEE FLOOR — `feeFloorSol = 2*feeReserve / (maxFeeShareOfStop *
       effectiveStop)` (strategy.mjs:232-234) — which on a 5% stop demands 0.0551 SOL
       while the operator's ceiling is 0.05, so no size fits. The executor reports that
       as "the sized position rounds to nothing", which is true and unhelpfully terse. */
    if (sized.action !== "buy") {
      const eff = stopPct / 100 + rtPct / 100;
      const feeFloor = (2 * (FEE / 1e9)) / (DEFAULTS.maxFeeShareOfStop * Math.max(eff, 0.01));
      return { taken: false,
        why: `${sized.reason} (fee floor needs ${feeFloor.toFixed(4)} SOL; ceiling is 0.05)` };
    }
    const conservative = (1 - rtPct / 100) * SLIP - 2 * FEE / (sized.sol * 1e9);
    return { taken: conservative > (1 - stopPct / 100),
      why: `conservative ${(conservative * 100).toFixed(2)}% vs stop at ${(100 - stopPct).toFixed(2)}% of entry`,
      sol: sized.sol };
  };
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09],
                                     ["USWS", 6.5, 1.03], ["HeeHaw again", 8.5, 2.23]]) {
    const t = botTakes(stopPct, rt);
    ok(`${name} (${stopPct}% stop) is refused by the BOT, where the numbers are real`,
      t.taken === false, t.why);
  }
  const wide = botTakes(25, 1.03);
  ok("a 25% stop — ordinary for a coin that moves 20% in minutes — the bot takes",
    wide.taken === true, `${wide.sol} SOL; ${wide.why}`);
}

console.log("\nTHE SEAT THAT PICKS THE STOP IS STILL ASKED FOR AN HONEST LEVEL");
{
  const src = fs.readFileSync(new URL("./src/agents/decision.js", import.meta.url), "utf8");
  ok("stopFloorForCoin no longer exists", !/export function stopFloorForCoin/.test(src),
    "the desk holds no per-coin stop floor");
  ok("the Risk seat is told size is not its question",
    /HOW MUCH IS BOUGHT IS NOT YOUR QUESTION/.test(src));
  ok("...and is still told a stop must survive the coin's own noise",
    /A STOP MUST SURVIVE THIS COIN'S OWN NOISE/.test(src) && /20% in\na few minutes|moves 20%/.test(src));
  ok("...and that moving the level to fit is refused",
    /rather than moving the level to fit/.test(src));
  ok("the prompt quotes no dollar floor at it",
    !/stopFloorForCoin\(ev, cfg\)/.test(src) && !/minStopDistancePct/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
