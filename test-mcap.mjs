/**
 * A MEMECOIN DESK, NOT A HOLDINGS DESK.
 *
 * There was no market-cap bound here in either direction, and the ranker paid up to
 * +39 for size alone: +15 over $75k liquidity, another +10 over $400k, and +14 more
 * for an aged coin with a $750k book. A large established coin therefore beat a small
 * one before its story was read, and the desk kept surfacing coins you would hold
 * rather than trade.
 *
 * Those weights were set for a desk placing $500 clips from a $10,000 book. The
 * executor sizes at ~$3.40 and the exit probe now prices $200, so depth past "can I
 * get out" buys nothing while costing all the upside.
 *
 * These assertions are about the RANKING and the SCREEN, so they need no live feed —
 * which matters, because the feed was unreachable when this was written.
 */
import { rank } from "./src/penthouse.js";
import { screen } from "./src/data/evidence.js";
import { cfg } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/** Two coins identical in every way that should matter, differing only in size. */
const coin = ({ mcap, liq, age = 200, h1 = 2, h6 = 12, h24 = 20 }) => ({
  mint: "m" + mcap, onCurve: false,
  pair: { baseSymbol: "T", marketCap: mcap, fdv: mcap, liquidityUsd: liq, ageHours: age,
    priceUsd: 0.001, priceChange: { h1, h6, h24, m5: 1 },
    volume: { h24: liq * 3 }, txns: { h1: { buys: 40 }, h6: { buys: 120 }, h24: { buys: 400, sells: 300 } },
    socials: [{ type: "twitter" }] },
});

console.log(`\nMARKET CAP CEILING: $${cfg.screen.maxMarketCapUsd.toLocaleString()}`);

console.log("\nTHE RANKER MUST PREFER THE SMALL COIN");
const small = rank(coin({ mcap: 900_000, liq: 60_000 }));
const big   = rank(coin({ mcap: 40_000_000, liq: 900_000 }));
console.log(`   $0.9m cap / $60k liq  -> ${small.score}`);
console.log(`   $40m  cap / $900k liq -> ${big.score}`);
ok("a $0.9m coin now out-ranks a $40m coin", small.score > big.score,
  `${small.score} > ${big.score}`);
ok("the small coin is credited for room to re-rate",
  small.why.some((w) => /room to re-rate/.test(w)), small.why.find((w) => /re-rate/.test(w)) ?? "");
ok("the big coin is penalised for needing fresh millions",
  big.why.some((w) => /fresh money/.test(w)), big.why.find((w) => /fresh money/.test(w)) ?? "");

console.log("\nDEPTH IS A THRESHOLD, NOT A LADDER");
const justEnough = rank(coin({ mcap: 900_000, liq: 60_000 }));
const tenTimes   = rank(coin({ mcap: 900_000, liq: 600_000 }));
ok("ten times the book earns no extra rank at the same cap",
  justEnough.score === tenTimes.score, `${justEnough.score} vs ${tenTimes.score}`);
const tooThin = rank(coin({ mcap: 900_000, liq: 20_000 }));
ok("but a book too thin to exit still scores lower", tooThin.score < justEnough.score,
  `${tooThin.score} < ${justEnough.score}`);

console.log("\nTHE SCREEN REFUSES WHAT IS TOO BIG TO RE-RATE");
const ev = (mcap) => ({
  mint: "m", symbol: "T", pair: { marketCap: mcap, fdv: mcap, liquidityUsd: 120_000, ageHours: 200,
    priceUsd: 0.001, volume: { h24: 400_000 }, priceChange: {} },
  pairs: { totalLiquidityUsd: 120_000, count: 2 },
  derived: { txns24h: 900, volToLiqRatio: 3, fdvToLiqRatio: mcap / 120_000 },
  exitProbe: { roundTripLossPct: 2 }, mintAccount: { flags: [] }, holders: { ok: true, top1Pct: 9 },
});
const codes = (m) => screen(ev(m)).fails.map((f) => f.code);
ok("a $50m coin is screened out as too_big", codes(50_000_000).includes("too_big"),
  codes(50_000_000).join(",") || "none");
ok("a $3m coin is not", !codes(3_000_000).includes("too_big"), codes(3_000_000).join(",") || "clean");

// An unreadable number must never become an execution — the same rule the rest of
// the screen follows for unknown deployers and unreadable flags.
const noMcap = { ...ev(3_000_000) };
noMcap.pair = { ...noMcap.pair, marketCap: null, fdv: null };
ok("an UNKNOWN market cap does not fail the ceiling",
  !screen(noMcap).fails.map((f) => f.code).includes("too_big"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
