/**
 * NO FIXED COUNT OF MEMECOINS, AND A BRAKE THAT IS A SHARE OF THE BANKROLL.
 *
 * Owner's rules, both measured before implementing. Several memes pump together, so a
 * fixed position count makes the desk late on the ones it was right about — but the
 * count was never the real limit: removing it alone took the book from 4 positions to
 * 5, because total book heat bound next. And an absolute loss brake goes stale: 0.15
 * SOL was 45% of the live 0.3366 SOL bankroll, far looser than intended.
 *
 * The two are deliberately matched. A book allowed to carry MORE risk than the day is
 * allowed to lose is incoherent — it would guarantee tripping the brake whenever the
 * book stopped out together, which for correlated memecoins is the normal case.
 *
 * The 0.15 SOL above is history, not the current setting: the owner raised the absolute
 * cap to 0.4 on 2026-09-07 along with the per-trade size. Nothing here hardcodes it —
 * every brake fixture is derived from DEFAULTS.dailyLossLimitSol and
 * DEFAULTS.dailyLossPctOfEquity, which are the two fields planEntry actually reads.
 */
import { planEntry, DEFAULTS } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const WALLET = 0.3366;
/* These per-trade numbers are the FIXTURE'S OWN scale for a 0.3366 SOL wallet — roughly a
   seventh of it per position, so a book of several can actually be filled. They are not the
   operator maximum and must not be re-anchored to it: raise fixedSol to the 0.4 the owner now
   permits and this wallet funds exactly one position, collapsing the book test below into
   nothing. The brake settings are deliberately left at DEFAULTS, because the brake is what
   these tests are about. */
const cfg = (over = {}) => ({ ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
  networkFeeReserveSol: 0.0005, measuredRoundTripLossPct: 2, ...over });
const state = (over = {}) => ({ openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0, ...over });
const call = (stop = 0.85, conviction = 50) => ({ mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction });

/** Open positions one at a time until the desk stops saying buy. */
const fillBook = (c = cfg()) => {
  let heat = 0, deployed = 0, n = 0;
  for (let i = 0; i < 60; i++) {
    const r = planEntry({ call: call(), cfg: c,
      state: state({ openCount: n, bookHeat: heat, deployedTodaySol: deployed, spendableSol: WALLET - deployed }) });
    if (r.action !== "buy") return { n, heat, deployed, stoppedBy: r.reason };
    n++; heat += r.f; deployed += r.sol;
  }
  return { n, heat, deployed, stoppedBy: "ran out of iterations" };
};

console.log("\nRISK DECIDES HOW MANY MEMECOINS RUN AT ONCE, NOT A COUNT");
{
  const book = fillBook();
  /* Fewer than the raw heat budget alone would allow, because positions can no longer
     be shrunk into their own fees — each one is bigger, so the wallet holds fewer. */
  ok("the book holds far more than the old four", book.n >= 8, `${book.n} positions, ${book.deployed.toFixed(3)} SOL deployed`);
  ok("...and it is RISK that stops it, not the position sentinel",
    !/of max/.test(book.stoppedBy), book.stoppedBy.slice(0, 70));
  const old = fillBook(cfg({ bookHeatMax: 0.08, maxOpenPositions: 4 }));
  /* THREE, NOT FOUR, SINCE 2026-09-07 — and the reason is worth writing down rather than
     loosening the assertion around. This fixture opens every position at conviction 50,
     which used to be multiplied straight into the size (`want *= max(0.35, 50/100)`), so
     each position carried half the risk and four of them fitted inside an 8% heat budget.
     The conviction multiplier is deleted: the desk no longer sizes anything, positions
     open at the bot's own full size, and three of THOSE fill the same budget. The
     property under test never moved — risk binds before the count does — only the
     arithmetic did. */
  ok("the old settings bind at three full-size positions, on heat rather than the count",
    old.n === 3 && !/of max/.test(old.stoppedBy), `${old.n} positions — ${old.stoppedBy.slice(0, 60)}`);
  ok("the new settings open strictly more", book.n > old.n, `${old.n} -> ${book.n}`);
  // The sentinel must still exist as a backstop, even though risk binds first.
  ok("the sentinel still refuses when actually reached",
    planEntry({ call: call(), cfg: cfg(), state: state({ openCount: DEFAULTS.maxOpenPositions }) }).action === "skip");
}

console.log("\nTHE BRAKE IS 20% OF THE BANKROLL");
{
  ok("the percentage is 20%", DEFAULTS.dailyLossPctOfEquity === 0.20, `${DEFAULTS.dailyLossPctOfEquity}`);
  const brake = DEFAULTS.dailyLossPctOfEquity * WALLET;
  ok("just inside it still trades",
    planEntry({ call: call(), cfg: cfg(), state: state({ realizedTodaySol: -(brake - 0.0002) }) }).action === "buy",
    `${(brake - 0.0002).toFixed(4)} SOL lost`);
  const tripped = planEntry({ call: call(), cfg: cfg(), state: state({ realizedTodaySol: -(brake + 0.0002) }) });
  ok("just past it stops for the day", tripped.action === "skip", `${(brake + 0.0002).toFixed(4)} SOL lost`);
  ok("...and the reason names the bankroll, not a bare number",
    /% of a .* SOL bankroll/.test(tripped.reason), tripped.reason.slice(0, 78));
  /* THE POINT OF THE CHANGE. Turn the percentage off and the same loss trades on, because
     an absolute cap set for a bigger wallet is a far looser brake than intended on this
     one. The cap was 0.15 SOL when this was written and is 0.4 today; both are looser than
     a fifth of this bankroll, which is exactly why the percentage exists. Reported as a
     derived share so a future raise cannot quietly make this assertion vacuous. */
  ok("the old absolute brake would have kept trading through that loss",
    planEntry({ call: call(), cfg: cfg({ dailyLossPctOfEquity: 0 }),
      state: state({ realizedTodaySol: -(brake + 0.0002) }) }).action === "buy",
    `the ${DEFAULTS.dailyLossLimitSol} SOL absolute cap is ` +
    `${(DEFAULTS.dailyLossLimitSol / WALLET * 100).toFixed(0)}% of this wallet`);
}

console.log("\nWHICHEVER IS TIGHTER WINS, SO IT CAN ONLY EVER BRAKE SOONER");
{
  /* RE-ANCHORED 2026-09-07, and the failure is the reason to derive rather than to
     re-type. Every bankroll here used to be a literal chosen around a 0.15 SOL absolute
     cap; the owner raised the cap to 0.4 with the per-trade size, and "a large bankroll"
     of 2 SOL silently stopped being one — 20% of 2 is EXACTLY 0.4, so the two brakes tied
     at the fixture's own equity and neither bound. The test went red while the property
     it defends never moved: whichever brake is tighter wins.

     So both sides are derived from the crossover, the bankroll at which the two brakes are
     equal (ABS / PCT). Below it the percentage must bind, above it the absolute cap must,
     at any cap the owner picks next. Anchored on DEFAULTS because these two fields ARE the
     numbers planEntry reads; poller's OPERATOR_MAX is the ceiling on what an operator may
     request, is not exported, and its module self-executes on import. */
  const PCT = DEFAULTS.dailyLossPctOfEquity;          // the brake as a share of the bankroll
  const ABS = Math.abs(DEFAULTS.dailyLossLimitSol);   // the operator's absolute cap, in SOL
  const crossover = ABS / PCT;                        // where the two are exactly equal
  ok("the two brakes cross at a real bankroll, so both sides below are reachable",
    Number.isFinite(crossover) && crossover > 0, `they tie at ${crossover.toFixed(4)} SOL`);

  // BELOW the crossover the percentage is the tighter of the two. Overshoot by 0.1% of the
  // brake rather than a fixed 0.001 SOL, so the nudge stays on the right side at any scale.
  const smallWallet = crossover / 4;
  const small = planEntry({ call: call(), cfg: cfg(),
    state: state({ equitySol: smallWallet, spendableSol: smallWallet,
      realizedTodaySol: -(PCT * smallWallet) * 1.001 }) });
  ok("on a small bankroll the percentage binds", small.action === "skip" && /% of a/.test(small.reason),
    small.reason.slice(0, 96));
  /* ABOVE it the operator's absolute cap is tighter, so a loss barely past ABS stops the
     day even though the percentage would still have allowed four times as much. */
  const bigWallet = crossover * 4;
  const large = planEntry({ call: call(), cfg: cfg(),
    state: state({ equitySol: bigWallet, spendableSol: bigWallet,
      realizedTodaySol: -ABS * 1.001 }) });
  ok("on a large bankroll the operator's absolute cap binds",
    large.action === "skip" && /absolute cap/.test(large.reason), large.reason.slice(0, 96));
  const lowered = planEntry({ call: call(), cfg: cfg({ dailyLossLimitSol: 0.01 }),
    state: state({ realizedTodaySol: -0.011 }) });
  // A literal is right here: this is an operator OVERRIDE, self-consistent and deliberately
  // unrelated to whatever the default happens to be.
  ok("an operator lowering the absolute cap still wins", lowered.action === "skip",
    lowered.reason.slice(0, 96));
  /* Equity unreadable: the percentage cannot be computed, so the absolute cap must be what
     answers. The loss is the midpoint of the two brakes — strictly past the percentage this
     wallet would have imposed, strictly under the absolute cap — so a fallback that braked
     on a percentage it could not know, or that let ANY loss through, both fail here. */
  const wouldTripPctHere = PCT * WALLET;
  const betweenTheTwo = (wouldTripPctHere + ABS) / 2;
  const blind = planEntry({ call: call(), cfg: cfg(),
    state: state({ equitySol: null, realizedTodaySol: -betweenTheTwo }) });
  ok("an unreadable bankroll falls back to the absolute cap rather than braking wrongly",
    blind.action !== "skip",
    `lost ${betweenTheTwo.toFixed(4)} — past ${wouldTripPctHere.toFixed(4)} (20% here), under the ${ABS} cap`);
}

console.log("\nTHE BOOK CANNOT RISK MORE THAN THE DAY MAY LOSE");
{
  ok("book heat and the loss brake are the same share",
    DEFAULTS.bookHeatMax === DEFAULTS.dailyLossPctOfEquity,
    `heat ${DEFAULTS.bookHeatMax}, brake ${DEFAULTS.dailyLossPctOfEquity}`);
  const book = fillBook();
  ok("...so a whole book stopping out lands exactly at the brake, never past it",
    book.heat <= DEFAULTS.dailyLossPctOfEquity + 1e-9,
    `${(book.heat * 100).toFixed(1)}% at risk vs a ${(DEFAULTS.dailyLossPctOfEquity * 100).toFixed(0)}% brake`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
