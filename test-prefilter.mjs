/**
 * THE CYCLE WAS SPENDING ITS SLOTS ON COINS IT WAS ALWAYS GOING TO REFUSE.
 *
 * Eight consecutive cycles, read straight off production:
 *
 *   studied=2 eligible=0   studied=3 eligible=0   studied=1 eligible=0   ...
 *
 * Not one eligible candidate, ever. The cohort step was running fine — it had nothing
 * to choose from, because the three workup slots had been filled by rank() alone, and
 * rank() rewards depth and momentum while the screen kills on thresholds rank knows
 * nothing about. Every slot went to a coin that died at the first free gate.
 *
 * The fresh lane has pre-filtered like this since its first champion died of
 * thin_liquidity. The cycle never learned. This is that lesson, applied.
 */
import { wouldSurviveScreen, selectShortlist } from "./src/penthouse.js";
import { cfg } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const s = cfg.screen;
const coin = (over = {}) => ({
  mint: "m" + Math.round(Math.abs(over.score ?? 1) * 1e6), category: "memecoin",
  score: over.score ?? 50,
  pair: {
    baseSymbol: over.sym ?? "T",
    liquidityUsd: over.liq ?? s.minLiquidityUsd * 3,
    volume: { h24: over.vol ?? s.minVolume24hUsd * 3 },
    txns: { h24: { buys: over.tx ?? s.minTxns24h * 2, sells: 0 } },
    marketCap: over.mcap ?? 800_000,
    ageHours: over.age ?? 48,
  },
});

console.log(`\nTHE FREE SCREEN, APPLIED BEFORE PAYING (floors: liq $${s.minLiquidityUsd.toLocaleString()}, vol $${s.minVolume24hUsd.toLocaleString()}, txns ${s.minTxns24h}, cap $${(s.maxMarketCapUsd||0).toLocaleString()})`);
ok("a healthy micro-cap survives", wouldSurviveScreen(coin()) === null);
for (const [label, over, code] of [
  ["a pool too thin to exit",      { liq: s.minLiquidityUsd - 1 }, "thin_liquidity"],
  ["a coin nobody is trading",     { vol: s.minVolume24hUsd - 1 }, "no_volume"],
  ["almost no participants",       { tx: s.minTxns24h - 1 },       "no_participants"],
  ["too big to re-rate",           { mcap: (s.maxMarketCapUsd || 3e6) + 1 }, "too_big"],
  ["minutes old",                  { age: 0.1 },                   "too_new"],
  ["turnover implausible for depth", { vol: s.minLiquidityUsd * 3 * (s.maxVolToLiqRatio + 5) }, "wash_suspect"],
]) ok(`${label} is dropped BEFORE a workup is paid for`, wouldSurviveScreen(coin(over)) === code,
      wouldSurviveScreen(coin(over)) ?? "survived");

console.log("\nTHE SLOTS NOW GO TO COINS THAT CAN REACH A SEAT");
// The production shape: a handful of high-ranked coins that the screen kills, and one
// quiet survivor ranked below them. The old code spent all three slots on the corpses.
const market = [
  coin({ sym: "BIGCAP", score: 95, mcap: 40_000_000 }),
  coin({ sym: "DEAD",   score: 90, vol: 10 }),
  coin({ sym: "THIN",   score: 88, liq: 500 }),
  coin({ sym: "QUIET",  score: 40 }),
];
const picked = selectShortlist(market, 3);
const syms = picked.map((c) => c.pair.baseSymbol);
ok("the three top-ranked corpses are not bought", !syms.includes("BIGCAP") && !syms.includes("DEAD") && !syms.includes("THIN"),
  `shortlist = ${syms.join(", ")}`);
ok("the survivor gets the slot despite ranking last", syms.includes("QUIET"),
  "rank 40 beats rank 95 when 95 cannot pass the screen");
ok("no slot is wasted", picked.every((c) => wouldSurviveScreen(c) === null), `${picked.length} picked, all viable`);

console.log("\nA CYCLE THAT STUDIES NOTHING LEARNS NOTHING");
// If the filter would empty the list, fall back rather than idle: a doomed workup still
// produces a verdict and a lesson, whereas an empty cycle produces neither.
const allDoomed = [coin({ sym: "A", score: 80, liq: 1 }), coin({ sym: "B", score: 70, vol: 1 })];
const fallback = selectShortlist(allDoomed, 3);
ok("the desk still works up SOMETHING when nothing is viable", fallback.length > 0,
  `${fallback.length} picked from a market of ${allDoomed.length} doomed coins`);

console.log("\nRANK AND SCREEN NO LONGER DISAGREE ABOUT THE SAME COIN");
const contradiction = coin({ sym: "X", score: 99, mcap: 50_000_000, liq: 900_000 });
ok("a coin rank loves but the screen kills is caught here",
  wouldSurviveScreen(contradiction) === "too_big",
  "the exact contradiction that produced eight barren cycles");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
