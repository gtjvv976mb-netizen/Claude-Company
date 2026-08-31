/**
 * FLOORS THAT SCALE, AND THE LINE BETWEEN "UNKNOWN" AND "THIN".
 *
 * Two bugs of the same family. A FLAT liquidity floor asked a $30k-cap coin for a 40%
 * liquidity-to-cap ratio, and reading a MISSING pool figure as $0 killed 119 of 300
 * swept coins as "thin" when they were doing $26k-$239k of daily volume. Between them
 * the micro band passed 2 of 60, so "at least 5 per category" was arithmetically
 * impossible in the band the desk exists to hunt.
 *
 * The tests that matter here are the ones proving the safety line did NOT move: a pool
 * that can be read and is genuinely too thin still dies, and an unreadable pool still
 * has to prove it can be exited by measurement rather than assumption.
 */
import { floorsFor, BAND_FLOORS, cfg } from "./src/config.js";
import { wouldSurviveScreen } from "./src/penthouse.js";
import { screen } from "./src/data/evidence.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const coin = ({ mcap = 50_000, liq, vol = 50_000, tx = 500, age = 5 } = {}) => {
  const pair = { marketCap: mcap, volume: { h24: vol }, txns: { h24: { buys: tx, sells: 0 } }, ageHours: age };
  if (liq !== undefined) pair.liquidityUsd = liq;      // undefined = the feed reported nothing
  return { mint: "M", pair };
};

console.log("\nFLOORS SCALE WITH THE COIN, BECAUSE THE BANDS SPAN 2000x");
ok("a micro-cap is asked for $5k of depth", floorsFor(30_000).liq === 5_000);
ok("a very-high-cap is asked for $25k", floorsFor(15_000_000).liq === 25_000);
ok("the floor RISES with size", BAND_FLOORS.micro.liq < BAND_FLOORS.very_high.liq,
  "a $30k coin with $5k of depth is ordinary; a $15m coin with $5k of depth is a fiction");
ok("an UNREADABLE market cap gets the STRICT flat floor, not the loosest band",
  floorsFor(null).liq === cfg.screen.minLiquidityUsd,
  "an unknown number must never be handed the most permissive treatment");

console.log("\nA POOL THAT CAN BE READ AND IS TOO THIN STILL DIES");
ok("micro-cap with $1k of depth is refused",
  wouldSurviveScreen(coin({ mcap: 30_000, liq: 1_000 })) === "thin_liquidity", "$1k < $5k floor");
ok("...and a $15m coin with $12k of depth is refused too",
  wouldSurviveScreen(coin({ mcap: 15_000_000, liq: 12_000, vol: 50_000 })) === "thin_liquidity",
  "$12k would have PASSED the old flat floor — the band bar is stricter up here, not looser");

console.log("\nUNKNOWN LIQUIDITY IS NOT THIN LIQUIDITY");
ok("an unreadable pool with a real tape is not killed on depth",
  wouldSurviveScreen(coin({ mcap: 40_000, liq: undefined, vol: 239_000, tx: 6_184 })) === null,
  "$239k over 6,184 trades — the market is real, the feed just reports no pool");
/* This assertion used to be ok(..., true, ...) — a tautology dressed as a test, and the
 * single most important claim in the file. It is the PAID screen that has to hold the
 * line once the free one steps aside, so it is the paid screen that must be asserted. */
const paidEv = ({ liq, probe }) => ({
  ok: true, mint: "M", symbol: "M",
  pair: { marketCap: 40_000, volume: { h24: 239_000 }, priceChange: {}, pairCreatedAt: Date.now() - 6 * 3.6e6 },
  pairs: { count: 1, totalLiquidityUsd: liq },
  derived: { txns24h: 6_184, ageHours: 6 },
  exitProbe: probe,
  mintAccount: { mintAuthority: null, freezeAuthority: null },
  holders: { ok: true, top10Pct: 20, holderCount: 400 },
});
const codes = (ev) => (screen(ev)?.fails ?? []).map((f) => f.code);

ok("the PAID screen refuses an unreadable pool whose exit CANNOT be measured",
  codes(paidEv({ liq: null, probe: { roundTripLossPct: null, error: "no route" } })).includes("unverified_exit"),
  "unknown depth plus unknown exit is refused — unverified is not safe");

ok("...and refuses one that measures WORSE than the ceiling",
  codes(paidEv({ liq: null, probe: { roundTripLossPct: cfg.maxRoundTripSlippagePct + 1 } })).includes("cannot_exit"),
  `round trip over the ${cfg.maxRoundTripSlippagePct}% ceiling`);

ok("...but does NOT refuse one that measures fine, merely because depth is unreadable",
  !codes(paidEv({ liq: null, probe: { roundTripLossPct: 4.53 } })).includes("thin_liquidity"),
  "4.53% measured — the exact case the old proxy killed");

ok("and a READABLE pool below the band floor is still refused there",
  codes(paidEv({ liq: 900, probe: { roundTripLossPct: 4.53 } })).includes("thin_liquidity"),
  "$900 of depth on a micro-cap, floor $5,000");

console.log("\nBUT AN UNREADABLE POOL MUST CLEAR A HIGHER BAR OF REAL TRADING");
ok("unreadable pool with a thin tape is still refused",
  wouldSurviveScreen(coin({ mcap: 40_000, liq: undefined, vol: 5_000, tx: 30 })) === "thin_liquidity",
  "the tape is the only evidence of a market it has, so it must be strong");
ok("2x the volume floor is the bar for an unreadable pool",
  wouldSurviveScreen(coin({ mcap: 40_000, liq: undefined, vol: BAND_FLOORS.micro.vol * 2 + 1, tx: BAND_FLOORS.micro.txns * 2 + 1 })) === null &&
  wouldSurviveScreen(coin({ mcap: 40_000, liq: undefined, vol: BAND_FLOORS.micro.vol * 2 - 1, tx: BAND_FLOORS.micro.txns * 2 + 1 })) === "thin_liquidity",
  `$${BAND_FLOORS.micro.vol * 2} volume and ${BAND_FLOORS.micro.txns * 2} trades`);

console.log("\nEVERY OTHER FLOOR IS UNCHANGED");
ok("too_big still fires at the ceiling",
  wouldSurviveScreen(coin({ mcap: 50_000_000, liq: 900_000, vol: 900_000 })) === "too_big");
ok("too_small still fires under $10k",
  wouldSurviveScreen(coin({ mcap: 5_000, liq: 9_000, vol: 50_000 })) === "too_small");
ok("too_new still fires inside the migration hour",
  wouldSurviveScreen(coin({ mcap: 50_000, liq: 9_000, vol: 50_000, age: 0.5 })) === "too_new");
ok("wash_suspect still fires on an absurd volume/depth ratio",
  wouldSurviveScreen(coin({ mcap: 50_000, liq: 6_000, vol: 6_000 * 41 })) === "wash_suspect");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
