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

/* THE BOT'S REAL NUMBERS, NOT THE 0.05-ERA ONES. This file swept at fixedSol 0.05 and
   maxSolPerTrade 0.05, which was the operator ceiling when it was written; the shipped
   ceiling is 0.4 SOL (executor/strategy.mjs DEFAULTS.fixedSol / maxSolPerTrade) and a
   sweep at a tenth of it proves the executor's answer moves in a range the executor no
   longer trades. RE-ANCHORED, not loosened: the property below is unchanged — the desk's
   answer must not move with any money variable and the bot's must — and it is now
   measured at the size the bot would actually sign for. */
const BOT_FIXED_SOL = 0.4, BOT_MAX_SOL = 0.4;
const WALLET = 0.3366, FEE = 500_000;
const SLIP = (1 - 300 / 10_000) ** 2;
const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0 };

/** Would the desk publish this call? Everything about the COIN is held constant.
 *  `target` is the first take-profit; it defaults to the re-rate every sweep cell uses,
 *  and the upside-leg section below is the only caller that varies it. */
const publishes = (stopPct, rtPct, target = 1.9) => {
  const res = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    /* Loss at stop, off the STOP ALONE. The `+ rtPct / 100` term here matched the round
       trip compliance used to fold into its recompute; both went on 2026-09-07, because
       a friction measured at a notional the desk invented is not the desk's to price. */
    risk: { stop_price: 1 - stopPct / 100, position_size_usd: 12,
      max_loss_usd: Number((12 * (stopPct / 100)).toFixed(2)) },
    /* THE TARGET IS A RE-RATE, and it has to be for this sweep to be about money at all.
       It read 1.03 against a 1.02 zone high, which compliance now refuses outright as a
       broken bracket (`target_inside_zone`, and `target_inside_cost` under it): a first
       take-profit one cent above the price the ticket still wants to BUY at sells into
       its own entry, and the bot's entry contract kills it on arrival. Re-anchored to
       1.9x — the multiple the desk's own Execution brief says a micro-cap thesis argues
       for — so the only things varying across the sweep remain the stop distance and the
       round trip, which is the property under test. */
    ticket: { stop_price: 1 - stopPct / 100, entry_zone_low: 1, entry_zone_high: 1.02,
      take_profit: [{ price: target, pct_to_sell: 100 }] },
    ev: { pair: { priceUsd: 1 }, exitProbe: { targetSizeUsd: 15, roundTripLossPct: rtPct } },
  });
  return { pass: res.pass, codes: res.violations.map((v) => v.code) };
};

/** Would the executor take it? Its sizing, then the poller's executable-cost guard. */
const takes = (stopPct, rtPct, conviction) => {
  const sized = planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - stopPct / 100, target: 3, conviction },
    cfg: { ...DEFAULTS, fixedSol: BOT_FIXED_SOL, maxSolPerTrade: BOT_MAX_SOL, dailySolCap: 0.5,
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

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE UPSIDE LEG OF THE BRACKET — the half nothing checked.
 *
 * The sections above and below are about the SAME question asked at two sizes. This one
 * is a different question, and it is the one that made the desk pay for calls the bot
 * was always going to refuse: `stop_above_entry` proved the downside leg coherent while
 * NOTHING proved the upside one, so a ticket could publish with a first take-profit
 * inside its own entry zone. The bot then killed it on arrival under the entry
 * contract's `target_inside_cost`, deterministically and without a retry — after the
 * whole workup was bought.
 *
 * IT IS NOT A COST JUDGMENT SNEAKING BACK. The threshold is a FRACTION (costPct 0.06,
 * imported from executor/strategy.mjs so it cannot drift), applied to numbers the desk
 * authored itself. It is the same at $2 and at $75, which is the exact test that
 * separated a WHAT from a HOW MUCH on 2026-09-07, and it moves no amount: the sections
 * either side of it prove the desk's answer still does not move with the round trip or
 * with size, and that the bot's still does.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE DESK REFUSES A TARGET THAT IS NOT A RE-RATE");
{
  const COST = DEFAULTS.costPct;                       // 0.06 — the constant compliance imports
  const ENTRY = 1, ZONE_HIGH = 1.02;                   // the fixture's authored bracket
  console.log(`  entry_ref ${ENTRY}, entry_zone_high ${ZONE_HIGH}, ` +
    `bot costPct ${COST} → the re-rate floor is ${(ENTRY * (1 + COST)).toFixed(4)}`);
  const cases = [
    ["a target AT the entry price", 1.00, ["target_inside_zone", "target_inside_cost"]],
    ["a target inside the entry zone", 1.015, ["target_inside_zone", "target_inside_cost"]],
    ["a target AT the zone high", ZONE_HIGH, ["target_inside_zone", "target_inside_cost"]],
    ["a target above the zone but inside the round trip", 1.03, ["target_inside_cost"]],
    ["a target exactly AT 1.06x entry", 1.06, ["target_inside_cost"]],
    ["a target a hair over 1.06x entry", 1.0601, []],
    ["the 1.9x re-rate the sweep uses", 1.9, []],
  ];
  for (const [name, target, expected] of cases) {
    const p = publishes(20, 1, target);
    const got = p.codes.filter((c) => c.startsWith("target_"));
    ok(`${name} (${target}) → ${expected.length ? expected.join("+") : "published"}`,
      got.length === expected.length && expected.every((c) => got.includes(c)),
      `codes=[${p.codes.join(",") || "clean"}] pass=${p.pass}`);
  }

  /* AND THE POINT OF IT: whatever the desk publishes, the bot's two deterministic
     bracket refusals cannot fire on it. Swept over the same stop range as the sections
     either side, at the target the fixture now authors. */
  const bracketKills = [];
  for (const stopPct of STOPS) {
    const sized = planEntry({
      call: { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - stopPct / 100, target: 1.9, conviction: 100 },
      cfg: { ...DEFAULTS, fixedSol: BOT_FIXED_SOL, maxSolPerTrade: BOT_MAX_SOL, dailySolCap: 0.5,
        networkFeeReserveSol: FEE / 1e9, measuredRoundTripLossPct: 1 }, state });
    if (sized.action === "skip" && (/costs eat the target/.test(sized.reason)
        || /stop is at or above entry/.test(sized.reason)))
      bracketKills.push(`stop ${stopPct}%: ${sized.reason}`);
  }
  ok("no desk-published bracket makes planEntry say 'costs eat the target' or 'stop is at or above entry'",
    bracketKills.length === 0,
    bracketKills.length ? bracketKills.slice(0, 3).join(" | ") : `${STOPS.length} stop distances, none refused on the bracket`);
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
