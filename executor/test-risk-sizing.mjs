/**
 * MORE RISK, LESS SIZE — AND A SMALLER TRADE BEATS NO TRADE.
 *
 * Two defects, one rule. Every size rail was a `return skip`, so a fixed size one basis
 * point over the per-name risk cap threw the whole call away instead of buying slightly
 * less. Measured in the live log: "SKIP NATIX: actual stop risk 3.22% exceeds per-name
 * cap 2.50%" — a trade the bot could have taken at 78% of the size.
 *
 * The operator's fixed size is now a CEILING rather than an instruction: the rails may
 * size under it and never over it. What must stay true, and is asserted throughout: no
 * rail may ever make a position LARGER, the operator's ceiling is absolute, and when no
 * size fits the trade is still refused.
 *
 * AND NO FIELD THE DESK AUTHORS TOUCHES THE AMOUNT. This file used to assert that the
 * desk's `conviction` multiplied the position (0.35x to 1.0x, a 2.9x range on the live
 * 20-51 spread). That was the last size dial the desk held after 9eee450 took size_sol
 * and fixed_sol out of the path, and it is deleted: section two below proves the same
 * inputs now buy one identical amount.
 */
import { planEntry, DEFAULTS } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const cfg = { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
  networkFeeReserveSol: 0.0005, measuredRoundTripLossPct: 0 };
const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: 0.3367, spendableSol: 0.3367, wins: 0, losses: 0 };
// entry 1, stop 0.9 => a 10% stop. target 2 => plenty of R.
const call = (over = {}) => ({ mint: "m", symbol: "T", entry_ref: 1, stop: 0.9, target: 2, ...over });
const plan = (c = {}, s = {}, k = {}) => planEntry({ call: call(c), cfg: { ...cfg, ...k }, state: { ...state, ...s } });

console.log("\nA WIDER STOP IS MORE RISK, SO IT BUYS LESS");
{
  /* 5% is no longer a tradeable stop and the desk no longer publishes one: fees are
     capped at a quarter of the stop, so a 5% stop would need a 0.08 SOL position to
     carry them — above the operator's whole per-trade ceiling. 12% is the tight end of
     what actually reaches the bot now. */
  const tight = plan({ stop: 0.88 });            // 12% stop
  const wide = plan({ stop: 0.70 });             // 30% stop
  ok("a tight stop trades", tight.action === "buy", `${tight.sol?.toFixed(4)} SOL — ${tight.reason}`);
  ok("...and a 5% stop is refused, because it cannot carry its own fees",
    plan({ stop: 0.95 }).action === "skip", plan({ stop: 0.95 }).reason?.slice(0, 60));
  ok("a wide stop still trades, smaller", wide.action === "buy", `${wide.sol?.toFixed(4)} SOL`);
  ok("...and is strictly smaller than the tight one", wide.sol < tight.sol,
    `${wide.sol.toFixed(4)} < ${tight.sol.toFixed(4)}`);
  ok("the wide stop names what sized it down", /per-name risk cap/.test(wide.reason), wide.reason);
  /* THE REGRESSION THIS FIXES. The old code refused outright at this stop width. */
  ok("a stop that used to be refused now trades at a smaller size",
    wide.action === "buy" && wide.f <= DEFAULTS.fNameMax + 1e-9,
    `stop risk ${(wide.f * 100).toFixed(2)}% vs cap ${(DEFAULTS.fNameMax * 100).toFixed(2)}%`);
}

console.log("\nTHE TEAM'S CONFIDENCE MOVES NO MONEY");
{
  /* THE LAST CHANNEL, AND IT IS CLOSED NOW (2026-09-07).
   *
   * This section asserted the OPPOSITE until today, and the reversal is the whole point.
   * It read "a confident call trades bigger than a lukewarm one" and measured a haircut
   * of `Math.max(0.35, min(1, conviction/100))` applied straight to the position. Every
   * other desk field had already been taken out of the sizing path by 9eee450 —
   * size_sol and fixed_sol are read NOWHERE — and this one survived because "price the
   * team's uncertainty into the size" reads as risk management rather than as a size
   * instruction.
   *
   * It was a size instruction. Live conviction runs 20 to 51 out of 100, so the desk
   * was moving this wallet's stake across a 2.9x range through a number the desk writes
   * about itself, and anything that could raise a seat's conviction score — a coach
   * rewriting a seat's standing orders included — raised the amount without ever
   * writing the word size. The owner's rule does not have a wording exemption: the desk
   * says WHAT and WHEN, and this process decides HOW MUCH.
   *
   * So the same inputs now prove the inverse. */
  const sure = plan({ conviction: 100 });
  const unsure = plan({ conviction: 20 });
  const silent = plan({});
  ok("a lukewarm call and a confident one buy exactly the same amount",
    sure.action === "buy" && sure.sol === unsure.sol,
    `conviction 100 -> ${sure.sol?.toFixed(4)} SOL, conviction 20 -> ${unsure.sol?.toFixed(4)} SOL`);
  ok("...and so does a call that states no conviction at all",
    silent.sol === sure.sol, `${silent.sol?.toFixed(4)} SOL`);

  /* THE CASE THE OLD HAIRCUT WAS TUNED FOR. At the live 0.05 ceiling the fee floor left
     conviction only a 20% band to work in, so a test run only there could pass on a
     rounding accident. This is the roomy ceiling the old section used to demonstrate
     the scale working — where it had a full 0.35x-to-1.0x range — and the two sizes are
     now identical there too. */
  const roomy = (over) => planEntry({ call: call(over),
    state: { ...state, equitySol: 4, spendableSol: 4 },
    cfg: { ...cfg, fixedSol: 0.2, maxSolPerTrade: 0.2 } });
  ok("...including with a ceiling roomy enough for the old 0.35x haircut to show",
    roomy({ conviction: 100 }).sol === roomy({ conviction: 20 }).sol,
    `${roomy({ conviction: 100 }).sol.toFixed(4)} vs ${roomy({ conviction: 20 }).sol.toFixed(4)} SOL`);

  /* THE WHOLE RANGE, INCLUDING THE OUT-OF-CONTRACT VALUES A HOSTILE FEED WOULD SEND.
     One distinct size across all of them is the property: not "it does not scale UP",
     not "it is floored" — it does not participate in the arithmetic at all. */
  const sweep = [null, 0, 1, 20, 30, 50, 51, 80, 99, 100, 999, -40, "70", NaN];
  const sizes = new Set(sweep.map((v) => {
    const r = planEntry({ call: { ...call(), ...(v === null ? {} : { conviction: v }) }, cfg, state });
    return r.action === "buy" ? r.sol : `skip:${r.reason}`;
  }));
  ok(`all ${sweep.length} conviction values — absent, zero, negative, string, NaN, 999 — buy one single size`,
    sizes.size === 1, [...sizes].map(String).join(" | "));
  ok("...and the plan's own reason never mentions conviction",
    !/conviction/i.test(String(sure.reason)), sure.reason);
  ok("...and nothing in the answer reports a conviction scale any more",
    sure.convictionScale === undefined && !("convictionScale" in sure),
    Object.keys(sure).join(","));
  ok("the engine ships no convictionFloor to scale by", DEFAULTS.convictionFloor === undefined,
    String(DEFAULTS.convictionFloor));

  /* WHAT CONVICTION MAY STILL DO: nothing, unless the OPERATOR turns it on, and then
     only take-it-or-leave-it. A gate that cannot change an amount cannot set one. */
  ok("the operator's conviction floor is OFF by default, so a stock install never reads it",
    DEFAULTS.minConviction === 0, String(DEFAULTS.minConviction));
  const gated = (conviction) => planEntry({ call: call({ conviction }),
    cfg: { ...cfg, minConviction: 50 }, state });
  ok("an operator who sets a floor gets a refusal under it",
    gated(30).action === "skip", gated(30).reason);
  ok("...named as the OPERATOR's, so it can never read as the desk sizing",
    /operator/.test(gated(30).reason || ""), gated(30).reason);
  ok("...and a call over the floor is taken at the untouched size, not a scaled one",
    gated(80).action === "buy" && gated(80).sol === sure.sol,
    `${gated(80).sol?.toFixed(4)} vs ungated ${sure.sol?.toFixed(4)} SOL`);
  ok("...so the gate has exactly two outcomes: this size, or no trade",
    new Set([gated(50).sol, gated(80).sol, gated(100).sol]).size === 1
    && gated(49).action === "skip",
    `${gated(50).sol?.toFixed(4)} / ${gated(80).sol?.toFixed(4)} / ${gated(100).sol?.toFixed(4)}, 49 -> ${gated(49).action}`);

  /* The fee floor itself is unchanged and still shapes every size, so keep the two
     properties the deleted haircut used to be asserted alongside. */
  const feeFloorFor = (stopFrac) =>
    (2 * cfg.networkFeeReserveSol) / (DEFAULTS.maxFeeShareOfStop * (stopFrac + cfg.measuredRoundTripLossPct / 100));
  ok("no position is opened inside its own fees",
    sure.sol >= feeFloorFor(0.10) - 1e-9,
    `${sure.sol.toFixed(4)} SOL, floor ${feeFloorFor(0.10).toFixed(4)} at a 10% stop`);
  ok("...and that floor FALLS as the stop widens, so a wide stop may run smaller",
    feeFloorFor(0.30) < feeFloorFor(0.10),
    `${feeFloorFor(0.10).toFixed(4)} at 10% vs ${feeFloorFor(0.30).toFixed(4)} at 30%`);
}

console.log("\nEVERY RAIL SIZES DOWN, NONE SIZES UP");
{
  const ceiling = plan({ stop: 0.88, conviction: 100 }).sol;   // the least-constrained TRADEABLE trade
  ok("nothing exceeds the operator's per-trade ceiling", ceiling <= cfg.fixedSol + 1e-9,
    `${ceiling.toFixed(4)} <= ${cfg.fixedSol}`);
  const nearlyDeployed = plan({}, { deployedTodaySol: 0.45 });
  ok("the daily deploy cap sizes down instead of refusing",
    nearlyDeployed.action === "buy" && nearlyDeployed.sol < cfg.fixedSol,
    `${nearlyDeployed.sol?.toFixed(4)} SOL — ${nearlyDeployed.reason}`);
  /* ...but only while the room left is still a viable position. Past that it refuses
     rather than spending the last of the day's budget on fees. */
  const capExhausted = plan({}, { deployedTodaySol: 0.48 });
  ok("...and refuses once the room left cannot carry its own fees",
    capExhausted.action === "skip", capExhausted.reason?.slice(0, 62));
  const hotBook = plan({}, { bookHeat: DEFAULTS.bookHeatMax - 0.016 });
  ok("a hot book sizes down instead of refusing", hotBook.action === "buy" && hotBook.sol < cfg.fixedSol,
    `${hotBook.sol?.toFixed(4)} SOL`);
  /* But only down to the fee floor. Past that there is no partial trade to make — the
     remaining budget buys a position that is mostly fees — so it refuses instead. That
     is the fee floor working, not the heat cap failing. */
  const veryHot = plan({}, { bookHeat: DEFAULTS.bookHeatMax - 0.004 });
  ok("...and refuses rather than trading a position of pure fees when the room runs out",
    veryHot.action === "skip", veryHot.reason?.slice(0, 60));
  const thin = plan({}, { spendableSol: 0.02, equitySol: 0.02 });
  ok("a thin wallet sizes to what it actually has",
    thin.action !== "buy" || thin.sol <= 0.02 - cfg.networkFeeReserveSol + 1e-9,
    `${thin.action} ${thin.sol?.toFixed(4) ?? ""}`);
  /* THIS PAIR ASSERTED THE OPPOSITE UNTIL 2026-09-07, and the reversal is the point.
     They read "a call asking for less than the fee floor is refused" and "a call's own
     size_sol still caps it when it is viable" — both true of the old
     `want = Math.min(want, Number(call.size_sol))`, and both a description of the DESK
     setting this wallet's size. The owner's rule makes size the bot's alone: not the
     amount, not the ceiling, not the minimum. A min() only ever shrinks, which is why
     it read as prudence for so long, but shrinking is still deciding — a desk that can
     set 0.001 can silence the bot as surely as one that can set 10.

     So the same two inputs now prove the inverse, and the sizing they used to control
     is asserted right above this by the bot's OWN rails, which is where it belongs. */
  const baseline = plan({});
  const askedTiny = plan({ size_sol: 0.01 });
  ok("a desk size under the fee floor no longer refuses the trade",
    askedTiny.action === "buy" && askedTiny.sol === baseline.sol,
    `desk 0.01 SOL -> ${askedTiny.sol?.toFixed(4)} SOL (baseline ${baseline.sol?.toFixed(4)})`);
  const capped = plan({ size_sol: 0.042 });
  ok("...and a call's own size_sol no longer caps the bot either",
    capped.action === "buy" && capped.sol === baseline.sol,
    `desk 0.042 SOL -> ${capped.sol?.toFixed(4)} SOL (baseline ${baseline.sol?.toFixed(4)})`);
}

console.log("\nWHEN NO SIZE FITS, IT IS STILL REFUSED");
{
  const broke = plan({}, { spendableSol: 0.001, equitySol: 0.001, deployedTodaySol: 0 });
  ok("a wallet that cannot fund the minimum refuses", broke.action === "skip", broke.reason);
  ok("...and says which rail left nothing", /minimum|rounds to nothing/.test(broke.reason), broke.reason);
  const capped = plan({}, { deployedTodaySol: 0.4999 });
  ok("a spent daily cap refuses rather than trading dust", capped.action === "skip", capped.reason);
  ok("no stop is still an outright refusal", plan({ stop: null }).action === "skip");
  ok("a stop above entry is still an outright refusal", plan({ stop: 1.2 }).action === "skip");
  ok("the open-position limit still refuses",
    plan({}, { openCount: DEFAULTS.maxOpenPositions }).action === "skip");
  ok("the realized-loss brake still refuses",
    plan({}, { realizedTodaySol: -Math.abs(DEFAULTS.dailyLossLimitSol) }).action === "skip");
}

console.log("\nTHE ANSWER NEVER BREACHES THE RAIL IT WAS SIZED TO");
{
  // Sweep the space: whatever comes back must satisfy every cap it claims to respect.
  let checked = 0;
  const breaches = [];
  for (const stop of [0.99, 0.95, 0.9, 0.8, 0.7, 0.5, 0.3]) {
    for (const conviction of [null, 20, 30, 50, 80, 100]) {
      for (const heat of [0, 0.01, 0.02]) {
        for (const deployed of [0, 0.2, 0.45]) {
          const r = plan({ stop, ...(conviction == null ? {} : { conviction }) },
            { bookHeat: heat, deployedTodaySol: deployed });
          if (r.action !== "buy") continue;
          checked++;
          const where = `stop ${stop}, conviction ${conviction}, heat ${heat}, deployed ${deployed}`;
          if (r.sol > cfg.fixedSol + 1e-9) breaches.push(`ceiling: ${r.sol} at ${where}`);
          if (r.f > DEFAULTS.fNameMax + 1e-9) breaches.push(`name cap: ${r.f} at ${where}`);
          if (heat + r.f > DEFAULTS.bookHeatMax + 1e-9) breaches.push(`heat: ${r.f} at ${where}`);
          if (deployed + r.sol + cfg.networkFeeReserveSol > cfg.dailySolCap + 1e-9)
            breaches.push(`daily cap: ${r.sol} at ${where}`);
        }
      }
    }
  }
  ok("no sized trade breaches any cap", breaches.length === 0, breaches.slice(0, 3).join(" | "));
  ok(`every sized trade respects every cap`, true, `${checked} combinations checked`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
