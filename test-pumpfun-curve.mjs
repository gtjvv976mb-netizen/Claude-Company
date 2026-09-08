/**
 * THE CURVE IS DERIVED FROM ITS OWN ROW — the ruler before the measurement.
 *
 * "85 SOL to graduate" was a constant, and per coin it is wrong: measured live the
 * graduation total is 85.005 on most rows and 10-345 on boosted and mini curves. And
 * pool_address is set on 49-50 of 50 FRESH launches with complete=false, so a graduation
 * test on it would call every launch graduated. Each fixture below has an answer worked
 * by hand from pump.fun's constant-product curve, and every derived number is printed.
 *
 * Fixtures are in the feed's own units: lamports and six-decimal base units.
 */
import { asCandidate } from "./src/data/pumpfun-live.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const NOW = 1_788_400_000_000;
const MIN = 60_000;
const SOL = 1e9;          // lamports per SOL
const M = 1e12;           // base units per million tokens (six decimals)
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
const pct = (x) => x == null ? "null" : `${(x * 100).toFixed(2)}%`;
const sol = (x) => x == null ? "null" : `${x.toFixed(3)} SOL`;

/** A fresh launch as the feed sends it. Every reserve is explicit; `over` replaces. */
const row = (over = {}) => ({
  mint: "M1", symbol: "TEST", name: "Test Coin", creator: "C1",
  created_timestamp: NOW - 6 * MIN, last_trade_timestamp: NOW - MIN,
  usd_market_cap: 30_000, total_supply: 1e15, complete: false,
  virtual_sol_reserves: 30 * SOL, virtual_token_reserves: 1073 * M,
  real_sol_reserves: 0, real_token_reserves: 793.1 * M,
  bonding_curve: "curve1", pool_address: "pool1",
  ath_market_cap: 45_000, ath_market_cap_timestamp: NOW - 20 * MIN,
  ...over,
});
const read = (over, opts = {}) => asCandidate(row(over), { solUsd: 100, now: NOW, ...opts });
const show = (label, c) => console.log(`  ${label}: solToGraduate ${sol(c.live.solToGraduate)}`
  + ` · gradSolTotal ${sol(c.live.gradSolTotal)} · progressSol ${pct(c.live.progressSol)}`
  + ` · progressTok ${pct(c.live.progressTok)} · class ${c.live.curveClass}`
  + ` · onCurve ${c.onCurve} · graduated ${c.live.graduated}`);

console.log("\nA STANDARD CURVE OWES 85.005 SOL, AND THE NUMBER CAME FROM THE ROW");
{
  // vSol 30, vTok 1073M, realTok 793.1M: 30*1073/(1073-793.1) - 30 = 115.005 - 30 = 85.005.
  const c = read();
  show("standard", c);
  ok("solToGraduate is 85.005", near(c.live.solToGraduate, 85.005, 0.001), sol(c.live.solToGraduate));
  ok("gradSolTotal equals it with no SOL in yet", near(c.live.gradSolTotal, 85.005, 0.001), sol(c.live.gradSolTotal));
  ok("progress by SOL is 0", c.live.progressSol === 0, pct(c.live.progressSol));
  ok("progress by tokens is 0", c.live.progressTok === 0, pct(c.live.progressTok));
  ok("it is classed standard", c.live.curveClass === "standard", c.live.curveClass);
}

console.log("\nMID-CURVE: 8 SOL IN, 77 TO GO, THE SAME 85 IN TOTAL");
{
  // vSol 38.0, vTok 847.1M, realTok 567.2M: 38*847.1/279.9 - 38 = 77.005; plus 8.0 real = 85.005.
  const c = read({ virtual_sol_reserves: 38 * SOL, virtual_token_reserves: 847.1 * M,
    real_sol_reserves: 8 * SOL, real_token_reserves: 567.2 * M });
  show("mid-curve", c);
  ok("curveSolReserve reads the 8.0 SOL", c.live.curveSolReserve === 8, sol(c.live.curveSolReserve));
  ok("solToGraduate is 77.005", near(c.live.solToGraduate, 77.005, 0.001), sol(c.live.solToGraduate));
  ok("gradSolTotal is 85.0 — the total does not move as the curve fills",
    near(c.live.gradSolTotal, 85.005, 0.01), sol(c.live.gradSolTotal));
  ok("progress by SOL is 9.4%", near(c.live.progressSol, 8 / 85.005, 0.0005), pct(c.live.progressSol));
  /* The opening tokens are recovered, not assumed: vSol0 = 38 - 8 = 30, vTok0 = 38*847.1/30
     = 1072.99M, less the 279.9M held back = 793.1M — so 567.2M left is 28.5% sold. */
  ok("progress by tokens is 28.5%, from a recovered 793.1M start",
    near(c.live.progressTok, 1 - 567.2 / 793.1, 0.001), pct(c.live.progressTok));
  ok("token progress leads SOL progress on a convex curve", c.live.progressTok > c.live.progressSol,
    `${pct(c.live.progressTok)} > ${pct(c.live.progressSol)}`);
  ok("still classed standard", c.live.curveClass === "standard", c.live.curveClass);
  ok("the curve's SOL is priced and doubled as the book", c.pair.liquidityUsd === 1_600 && c.live.curveLiquidityUsd === 800,
    `$${c.pair.liquidityUsd} from 8 SOL at $100`);
}

console.log("\nBOOSTED AND MINI CURVES READ THEIR OWN TOTALS, NOT 85");
{
  // vSol 107.57, vTok 1066.6M, realTok 786.7M: 107.57*1066.6/279.9 - 107.57 = 302.34.
  const boosted = read({ virtual_sol_reserves: 107.57 * SOL, virtual_token_reserves: 1066.6 * M,
    real_token_reserves: 786.7 * M });
  show("boosted", boosted);
  const boostedExpect = 107.57 * 1066.6 / (1066.6 - 786.7) - 107.57;
  ok("a boosted curve owes ~302 SOL", near(boosted.live.gradSolTotal, boostedExpect, 0.01) && near(boosted.live.gradSolTotal, 302, 1),
    `${sol(boosted.live.gradSolTotal)} (hand: ${boostedExpect.toFixed(3)})`);
  ok("...and is classed boosted", boosted.live.curveClass === "boosted", boosted.live.curveClass);

  // vSol 3.75, vTok 1097.1M, realTok 817.2M: 3.75*1097.1/279.9 - 3.75 = 10.948.
  const mini = read({ virtual_sol_reserves: 3.75 * SOL, virtual_token_reserves: 1097.1 * M,
    real_token_reserves: 817.2 * M });
  show("mini", mini);
  const miniExpect = 3.75 * 1097.1 / (1097.1 - 817.2) - 3.75;
  ok("a mini curve owes ~10.95 SOL", near(mini.live.gradSolTotal, miniExpect, 0.001) && near(mini.live.gradSolTotal, 10.95, 0.01),
    `${sol(mini.live.gradSolTotal)} (hand: ${miniExpect.toFixed(3)})`);
  ok("...and is classed mini", mini.live.curveClass === "mini", mini.live.curveClass);

  /* NO CONSTANT ANYWHERE. Move the held-back slice and the answer must move with the
     formula, not snap to 85: a curve holding 373M back owes 30*1073/373 - 30 = 56.30. */
  const odd = read({ real_token_reserves: 700 * M });
  ok("an unfamiliar curve is still read from its row", near(odd.live.solToGraduate, 30 * 1073 / 373 - 30, 0.001),
    `${sol(odd.live.solToGraduate)} for 373M held back`);
}

console.log("\nGRADUATED MEANS THE CURVE IS EMPTY — NEVER THAT A POOL ADDRESS EXISTS");
{
  const fresh = read({ pool_address: "pool-preassigned" });
  show("fresh+pool", fresh);
  ok("a fresh row with a pool_address is ON the curve", fresh.onCurve === true && fresh.live.graduated === false,
    `pool_address=${fresh.raw.pool_address}, complete=${fresh.raw.complete}, real_token_reserves=${fresh.raw.real_token_reserves}`);
  ok("...trades on the curve, at the curve's address", fresh.pair.dex === "pumpfun" && fresh.pair.pairAddress === "curve1",
    `${fresh.pair.dex} @ ${fresh.pair.pairAddress}`);

  const complete = read({ complete: true, real_sol_reserves: 0, real_token_reserves: 0 });
  show("complete", complete);
  ok("complete=true reads graduated", complete.live.graduated === true && complete.onCurve === false);
  ok("...on the pool, at the pool's address", complete.pair.dex === "pumpswap" && complete.pair.pairAddress === "pool1",
    `${complete.pair.dex} @ ${complete.pair.pairAddress}`);
  ok("...with unknown liquidity, never zero", complete.pair.liquidityUsd === null && complete.live.curveLiquidityUsd === null);
  ok("...owing nothing and all the way along",
    complete.live.solToGraduate === 0 && complete.live.progressSol === 1 && complete.live.progressTok === 1,
    `owes ${sol(complete.live.solToGraduate)}, ${pct(complete.live.progressSol)} / ${pct(complete.live.progressTok)}`);
  ok("...and its curve total is not invented from drained reserves",
    complete.live.gradSolTotal === null && complete.live.curveClass === null);

  // The flag can lag the chain: an empty curve is graduated whatever `complete` says.
  const drained = read({ complete: false, real_token_reserves: 0, real_sol_reserves: 0 });
  show("drained", drained);
  ok("real_token_reserves === 0 reads graduated even with complete=false",
    drained.live.graduated === true && drained.onCurve === false);
  // A truthy-but-not-true `complete` is not a graduation either.
  const truthy = read({ complete: "false" });
  ok("only complete === true counts, not a truthy string", truthy.live.graduated === false && truthy.onCurve === true,
    `complete=${JSON.stringify(truthy.raw.complete)}`);
}

console.log("\nTHE HIGH: WHEN IT WAS SET AND HOW FAR BELOW IT THE COIN SITS");
{
  const c = read();
  ok("athRatio is cap over ATH", near(c.live.athRatio, 30_000 / 45_000, 1e-12), `${c.live.athRatio.toFixed(4)} ($30,000 / $45,000)`);
  ok("athAt is the ATH stamp in ms", c.live.athAt === NOW - 20 * MIN, `${c.live.athAt} (20 min before now)`);
  const secs = read({ ath_market_cap_timestamp: Math.floor((NOW - 20 * MIN) / 1000) });
  ok("a seconds ATH stamp is read as ms, not as 1970", secs.live.athAt === Math.floor((NOW - 20 * MIN) / 1000) * 1000,
    `${secs.live.athAt}`);
  const born = read({ ath_market_cap: undefined, ath_market_cap_timestamp: undefined });
  ok("a coin with no ATH yet has null, not NaN", born.live.athRatio === null && born.live.athAt === null && born.live.athMarketCap === null,
    `ratio ${born.live.athRatio}, at ${born.live.athAt}`);
  ok("a zero ATH yields no ratio", read({ ath_market_cap: 0 }).live.athRatio === null);
}

console.log("\nMISSING RESERVES ARE UNKNOWN, NOT NaN — AND RAW IS KEPT");
{
  const bare = asCandidate({ mint: "M2", usd_market_cap: 30_000, total_supply: 1e15, complete: false,
    real_sol_reserves: 30 * SOL, created_timestamp: NOW - 6 * MIN }, { solUsd: 100, now: NOW });
  show("no virtuals", bare);
  const curveKeys = ["solToGraduate", "gradSolTotal", "progressSol", "progressTok", "curveClass"];
  ok("a row without virtual reserves derives nothing", curveKeys.every((k) => bare.live[k] === null),
    curveKeys.map((k) => `${k}=${bare.live[k]}`).join(" "));
  ok("...but is still on the curve with its book priced", bare.onCurve === true && bare.pair.liquidityUsd === 6_000,
    `$${bare.pair.liquidityUsd}`);
  const nan = Object.entries(bare.live).filter(([, v]) => typeof v === "number" && !Number.isFinite(v));
  ok("no field is NaN or Infinity", nan.length === 0, nan.map(([k]) => k).join(",") || "none");
  const inverted = read({ real_token_reserves: 1073 * M });   // more real than virtual: not a curve
  ok("an impossible row derives nothing rather than a negative", inverted.live.solToGraduate === null && inverted.live.curveClass === null);
  const original = row();
  ok("raw is the row itself", asCandidate(original, { now: NOW }).raw === original);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
