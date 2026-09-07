/**
 * THE DESK PUBLISHES ON COIN QUALITY. THE BOT DECIDES WHETHER IT CAN AFFORD IT.
 *
 * WHAT THIS FILE USED TO ASSERT, and why it was wrong. The old contract was "anything
 * the desk publishes, the bot must be able to take", enforced by running compliance's
 * `stop_inside_costs` and the executor's cost guard over the same sweep and demanding
 * they never disagree. It could not hold, for a reason the file half-admitted in its own
 * comments: the desk "cannot know what size the bot will pick", so it assumed a worst
 * case and accepted a "thin conservative band" of calls it refused that the bot would
 * have taken. The band was the bug, not the price of the guarantee.
 *
 * Measured 2026-09-07: the desk was computing that guard at a $75 notional while the
 * bot's real clip is about $2. Fees are a large share of $2 and a trivial share of $75;
 * slippage is the reverse. So the two calculations did not differ by a conservative
 * margin, they differed in both directions at once and nobody could see which. Twelve of
 * the desk's last hundred kills died on the round-trip ceiling alone.
 *
 * THE NEW CONTRACT, and it is a cleaner one to test because it has no fudge factor:
 *
 *   THE DESK'S PUBLISH DECISION IS INDEPENDENT OF EVERY MONEY VARIABLE.
 *   THE BOT'S TAKE DECISION IS NOT, AND STILL BINDS.
 *
 * Independence is a stronger and more checkable property than agreement: sweep the
 * space, hold the coin fixed, vary only stop distance, round-trip cost and conviction,
 * and the desk's answer must not move at all. Then sweep the same space through the
 * executor and prove its answer DOES move — otherwise the money judgment has not been
 * relocated, it has been lost.
 *
 *   node test-published-is-tradeable.mjs
 */
import fs from "node:fs";
import { complianceCheck } from "./src/agents/compliance.js";
import { planEntry, DEFAULTS } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const WALLET = 0.3366, FEE = 500_000;
const SLIP = (1 - 300 / 10_000) ** 2;
const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0 };

/** Would the desk publish this call? Everything about the COIN is held constant. */
const publishes = (stopPct, rtPct) => {
  const res = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    /* Loss at stop, off the STOP ALONE. The `+ rtPct / 100` term here matched the round
       trip compliance used to fold into its recompute; both went on 2026-09-07, because
       a friction measured at a notional the desk invented is not the desk's to price. */
    risk: { stop_price: 1 - stopPct / 100, position_size_usd: 12,
      max_loss_usd: Number((12 * (stopPct / 100)).toFixed(2)) },
    ticket: { stop_price: 1 - stopPct / 100, entry_zone_low: 1, entry_zone_high: 1.02,
      take_profit: [{ price: 1.03, pct_to_sell: 100 }] },
    ev: { pair: { priceUsd: 1 }, exitProbe: { targetSizeUsd: 15, roundTripLossPct: rtPct } },
  });
  return { pass: res.pass, codes: res.violations.map((v) => v.code) };
};

/** Would the executor take it? Its sizing, then the poller's executable-cost guard. */
const takes = (stopPct, rtPct, conviction) => {
  const sized = planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - stopPct / 100, target: 3, conviction },
    cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
      networkFeeReserveSol: FEE / 1e9, measuredRoundTripLossPct: rtPct }, state });
  if (sized.action !== "buy") return { taken: false, why: sized.reason };
  const conservative = (1 - rtPct / 100) * SLIP - 2 * FEE / (sized.sol * 1e9);
  return { taken: conservative > (1 - stopPct / 100), why: "cost guard", sol: sized.sol };
};

const STOPS = []; for (let s = 4; s <= 40; s += 0.5) STOPS.push(s);
const RTS = [0.2, 0.5, 1, 2, 3, 5, 8, 12, 22.5];
const CONVICTIONS = [20, 30, 50, 80, 100];

console.log("\nTHE DESK'S ANSWER DOES NOT MOVE WITH ANY MONEY VARIABLE");
{
  const refusals = [];
  let checked = 0;
  for (const stopPct of STOPS) for (const rtPct of RTS) {
    checked++;
    const p = publishes(stopPct, rtPct);
    if (!p.pass) refusals.push(`stop ${stopPct}% rt ${rtPct}%: ${p.codes.join(",")}`);
  }
  /* THE WHOLE SWEEP PUBLISHES. Not "most of it", not "a useful range" — all of it. The
     coin is identical in every cell; only the stop distance and the cost of leaving
     change, and neither is a fact about the coin that the desk is entitled to rule on.
     The old version of this test could only claim `published > checked * 0.2`. */
  ok("every stop distance x round trip in the sweep is published",
    refusals.length === 0, refusals.length ? refusals.slice(0, 3).join(" | ") : `${checked} combinations, none refused`);

  const MONEY = ["stop_inside_costs", "edge_below_cost", "size_exceeds_exit_probe", "cannot_exit"];
  const moneyCodes = new Set();
  for (const stopPct of STOPS) for (const rtPct of RTS)
    for (const c of publishes(stopPct, rtPct).codes) if (MONEY.includes(c)) moneyCodes.add(c);
  ok("...and no money veto code is reachable at all",
    moneyCodes.size === 0, [...moneyCodes].join(",") || "none of stop_inside_costs / edge_below_cost / size_exceeds_exit_probe / cannot_exit");
}

console.log("\nTHE BOT'S ANSWER DOES MOVE — THE JUDGMENT WAS RELOCATED, NOT DELETED");
{
  const results = [];
  for (const stopPct of STOPS) for (const rtPct of RTS) for (const conviction of CONVICTIONS)
    results.push({ stopPct, rtPct, conviction, ...takes(stopPct, rtPct, conviction) });
  const refused = results.filter((r) => !r.taken);
  ok("the executor refuses a substantial share of the same sweep",
    refused.length > 0 && refused.length < results.length,
    `${refused.length} refused of ${results.length} — the desk refused 0 of them`);

  /* AND IT REFUSES FOR THE RIGHT REASONS, in the right direction. Tight stops and
     expensive round trips are where the costs bite; wide stops on cheap coins are not.
     If this ever inverts, the executor's cost model has broken. */
  const tightExpensive = results.filter((r) => r.stopPct <= 6 && r.rtPct >= 5);
  const wideCheap = results.filter((r) => r.stopPct >= 25 && r.rtPct <= 1);
  ok("...every tight stop on an expensive round trip is refused",
    tightExpensive.every((r) => !r.taken), `${tightExpensive.filter((r) => r.taken).length} taken of ${tightExpensive.length}`);
  ok("...and every wide stop on a cheap one is taken",
    wideCheap.every((r) => r.taken), `${wideCheap.filter((r) => !r.taken).length} refused of ${wideCheap.length}`);

  /* CONVICTION SIZES NOTHING — AND THIS ASSERTION SAID THE OPPOSITE UNTIL 2026-09-07.
     It read "conviction changes the SIZE the bot chooses, and only the bot chooses it".
     The second clause was the mistake: the bot APPLIED the number, the desk CHOSE it.
     `want *= max(0.35, min(1, conviction/100))` let a field the desk authors about itself
     move this wallet's stake over a 2.9x range, so anything that could inflate a seat's
     conviction — a coach rewriting that seat's standing orders included — inflated the
     amount without ever writing the word size. The desk's confidence is a WHAT. */
  const sizes = CONVICTIONS.map((c) => takes(20, 1, c)).filter((r) => r.taken).map((r) => r.sol);
  ok("conviction moves the bot's size by nothing across the whole live range",
    new Set(sizes).size === 1 && sizes.length === CONVICTIONS.length,
    sizes.map((x) => x.toFixed(4)).join(" / "));

  /* AND THE OTHER HALF STILL HOLDS: the answer moves, on the bot's own inputs. If it did
     not, this section would be passing because sizing stopped working. */
  const byStop = [8, 14, 20, 30, 40].map((stopPct) => takes(stopPct, 1, 50))
    .filter((r) => r.taken).map((r) => r.sol);
  ok("...while the bot's own risk-at-stop still moves it, so the sizing is alive",
    new Set(byStop).size > 1, byStop.map((x) => x.toFixed(4)).join(" / "));
}

console.log("\nTHE FOUR CALLS OF 2026-09-03 ARE PUBLISHED, AND REFUSED BY THE WALLET");
{
  /* HeeHaw 5%/2.26, TOAD 5%/1.09, USWS 6.5%/1.03, HeeHaw again 8.5%/2.23. Every one was
     published, then refused by the bot, and the old fix was to stop publishing them.
     The new answer is that publishing them was never the mistake — the desk had the coin
     right and no standing on the cost. The tenant now hears about the coin, and their own
     bot declines to buy it at their own size, with its own reason, on their own machine.
     A tenant with a larger wallet or a smaller fee reserve may well take it. */
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09],
                                     ["USWS", 6.5, 1.03], ["HeeHaw again", 8.5, 2.23]]) {
    const p = publishes(stopPct, rt), t = takes(stopPct, rt, 100);
    ok(`${name}: published by the desk, refused by the bot`,
      p.pass === true && t.taken === false,
      `desk=[${p.codes.join(",") || "clean"}] bot=${t.why}`);
  }
  const fwog = publishes(13, 0.51);
  ok("FWOG (13% stop, 0.51% round trip) is published too — as it always was",
    fwog.pass === true && takes(13, 0.51, 100).taken === true, fwog.codes.join(",") || "clean");
}

console.log("\nAND NOTHING THE DESK SENDS CAN REACH THE BOT'S SIZING");
{
  /* The other end of the same rule. Even a desk that published a size could not use it:
     both call sites that used to read one are gone, and both carry a comment saying not
     to restore them. Asserted on the SOURCE because these are absences, and an absence
     cannot be exercised by calling a function. */
  const strat = fs.readFileSync(new URL("./executor/strategy.mjs", import.meta.url), "utf8");
  const poller = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
  const live = (src, re) => src.split("\n").some((l) => re.test(l) && !/^\s*(\*|\/\*|\/\/)/.test(l));
  ok("strategy.mjs reads call.size_sol nowhere in the sizing path",
    !live(strat, /call\.size_sol/), "executor/strategy.mjs:247");
  ok("poller.mjs reads ev.fixed_sol nowhere",
    !live(poller, /ev\.fixed_sol/), "executor/poller.mjs:1192");
  ok("...and the bot's per-trade ceiling is still its own",
    live(strat, /want = Math\.min\(want, c\.maxSolPerTrade\)/), "executor/strategy.mjs:305");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
