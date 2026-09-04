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
 */
import { planEntry, DEFAULTS } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const WALLET = 0.3366;
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
  ok("the book holds far more than the old four", book.n >= 10, `${book.n} positions, ${book.deployed.toFixed(3)} SOL deployed`);
  ok("...and it is RISK that stops it, not the position sentinel",
    !/of max/.test(book.stoppedBy), book.stoppedBy.slice(0, 70));
  const old = fillBook(cfg({ bookHeatMax: 0.08, maxOpenPositions: 4 }));
  ok("the old settings stopped at four", old.n === 4, `${old.n} positions`);
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
  /* THE POINT OF THE CHANGE. Under the old absolute-only brake the same loss traded on,
     because 0.15 SOL is 45% of this bankroll. */
  ok("the old absolute brake would have kept trading through that loss",
    planEntry({ call: call(), cfg: cfg({ dailyLossPctOfEquity: 0 }),
      state: state({ realizedTodaySol: -(brake + 0.0002) }) }).action === "buy",
    "0.15 SOL was 45% of this wallet");
}

console.log("\nWHICHEVER IS TIGHTER WINS, SO IT CAN ONLY EVER BRAKE SOONER");
{
  // A small bankroll: the percentage is tighter than the absolute cap.
  const small = planEntry({ call: call(), cfg: cfg(),
    state: state({ equitySol: 0.1, spendableSol: 0.1, realizedTodaySol: -0.021 }) });
  ok("on a small bankroll the percentage binds", small.action === "skip" && /% of a/.test(small.reason),
    small.reason.slice(0, 62));
  // A large bankroll: 20% would be 0.4 SOL, so the operator's 0.15 absolute cap binds.
  const large = planEntry({ call: call(), cfg: cfg(),
    state: state({ equitySol: 2, spendableSol: 2, realizedTodaySol: -0.16 }) });
  ok("on a large bankroll the operator's absolute cap binds",
    large.action === "skip" && /absolute cap/.test(large.reason), large.reason.slice(0, 62));
  ok("an operator lowering the absolute cap still wins",
    planEntry({ call: call(), cfg: cfg({ dailyLossLimitSol: 0.01 }),
      state: state({ realizedTodaySol: -0.011 }) }).action === "skip");
  ok("an unreadable bankroll falls back to the absolute cap rather than braking wrongly",
    planEntry({ call: call(), cfg: cfg(), state: state({ equitySol: null, realizedTodaySol: -0.02 }) }).action !== "skip");
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
