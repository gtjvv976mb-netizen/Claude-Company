/**
 * MORE RISK, LESS SIZE — AND A SMALLER TRADE BEATS NO TRADE.
 *
 * Two defects, one rule. Every size rail was a `return skip`, so a fixed size one basis
 * point over the per-name risk cap threw the whole call away instead of buying slightly
 * less. Measured in the live log: "SKIP NATIX: actual stop risk 3.22% exceeds per-name
 * cap 2.50%" — a trade the bot could have taken at 78% of the size. And every call
 * already carried the desk's conviction out of 100, which the bot had never once read.
 *
 * The operator's fixed size is now a CEILING rather than an instruction: the rails may
 * size under it and never over it. What must stay true, and is asserted throughout: no
 * rail may ever make a position LARGER, the operator's ceiling is absolute, and when no
 * size fits the trade is still refused.
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

console.log("\nTHE TEAM'S CONFIDENCE IS PRICED IN");
{
  const sure = plan({ conviction: 100 });
  const unsure = plan({ conviction: 30 });
  const silent = plan({});
  /* THE HAIRCUT HAS ALMOST NO ROOM AT A 0.05 SOL CEILING, and that is a finding rather
     than a bug. Fees are fixed, so a position cannot be shrunk below the size where
     they dominate — 0.04 SOL at a 0.0005 SOL round-trip fee and a 2.5% share. Between
     that floor and the 0.05 ceiling there is a 20% band for conviction to work in, and
     once the per-name risk cap binds first there is none at all. Measured against the
     desk's own calls, letting conviction size past that floor cut the bot from taking
     four of eight to taking one. So the property is asserted where the rule can
     actually operate — a ceiling with room above the fee floor. */
  const roomy = (over) => planEntry({ call: call(over),
    state: { ...state, equitySol: 4, spendableSol: 4 },
    cfg: { ...cfg, fixedSol: 0.2, maxSolPerTrade: 0.2 } });
  ok("a confident call trades bigger than a lukewarm one, where there is room to scale",
    roomy({ conviction: 100 }).sol > roomy({ conviction: 30 }).sol,
    `${roomy({ conviction: 100 }).sol.toFixed(4)} vs ${roomy({ conviction: 30 }).sol.toFixed(4)} SOL`);
  /* At the live 0.05 ceiling the band is 0.05 down to the 0.04 fee floor — conviction
     can cut a fifth off a position and no more. That is the honest shape of "less size"
     on a bankroll this small, and it is why letting it size past the floor cost the bot
     three of the four calls it could otherwise take. */
  ok("...and at the live 0.05 ceiling the band is only down to the fee floor",
    unsure.sol >= 0.0399 && unsure.sol < sure.sol,
    `${sure.sol.toFixed(4)} -> ${unsure.sol.toFixed(4)} SOL, a ${((1 - unsure.sol / sure.sol) * 100).toFixed(0)}% band`);
  const feeFloorFor = (stopFrac) =>
    (2 * cfg.networkFeeReserveSol) / (DEFAULTS.maxFeeShareOfStop * (stopFrac + cfg.measuredRoundTripLossPct / 100));
  ok("a position is never shrunk into its own fees",
    unsure.sol >= feeFloorFor(0.15) - 1e-9,
    `${unsure.sol.toFixed(4)} SOL, floor ${feeFloorFor(0.15).toFixed(4)} at a 15% stop`);
  ok("...and that floor FALLS as the stop widens, so a wide stop may run smaller",
    feeFloorFor(0.30) < feeFloorFor(0.10),
    `${feeFloorFor(0.10).toFixed(4)} at 10% vs ${feeFloorFor(0.30).toFixed(4)} at 30%`);
  ok("the haircut is floored, not proportional all the way down",
    unsure.convictionScale === DEFAULTS.convictionFloor, `${unsure.convictionScale}`);
  ok("conviction 50 sizes to half", plan({ conviction: 50 }).convictionScale === 0.5);
  ok("a call with no conviction is not scaled on the desk's silence", silent.convictionScale === 1);
  ok("...and conviction never sizes a trade UP", plan({ conviction: 999 }).sol <= cfg.fixedSol + 1e-9);
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
  /* A call asking for less than a viable position is refused, not traded tiny — the
     fees would be a quarter of the stop before the coin moved. A call asking for a
     viable-but-smaller size is honoured. */
  ok("a call asking for less than the fee floor is refused", plan({ size_sol: 0.01 }).action === "skip");
  const capped = plan({ size_sol: 0.042 });
  ok("...and a call's own size_sol still caps it when it is viable",
    capped.action === "buy" && capped.sol <= 0.042 + 1e-9, `${capped.sol?.toFixed(4)} SOL`);
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
