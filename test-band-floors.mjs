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
import { wouldSurviveScreen, rank } from "./src/penthouse.js";
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
/* The six sleeves, since 2026-09-03: nano $5k-$20k, micro $20k-$60k, low $60k-$100k,
   medium $100k-$500k, high $500k-$1m, very high $1m-$10m. */
ok("a nano-cap is asked for $2k of depth", floorsFor(9_000).liq === 2_000);
ok("a micro-cap is asked for $4k", floorsFor(30_000).liq === 4_000);
ok("a very-high-cap is asked for $15k", floorsFor(5_000_000).liq === 15_000);
ok("the floor RISES with size", BAND_FLOORS.nano.liq < BAND_FLOORS.micro.liq
  && BAND_FLOORS.micro.liq < BAND_FLOORS.very_high.liq,
  "a $30k coin with $4k of depth is ordinary; a $5m coin with $4k of depth is a fiction");
/* THE AGE FLOOR IS THE BAND'S OWN NUMBER. One flat 1.5 hours refused the entire
   population the nano and micro sleeves exist for — a coin the desk is asked to hold
   for thirty minutes cannot be required to be ninety minutes old first. */
ok("the nano sleeve looks at a coin about a minute old", floorsFor(9_000).ageH <= 0.02);
ok("...while a $5m coin still has to be an hour and a half old", floorsFor(5_000_000).ageH === 1.5);
ok("an UNREADABLE market cap gets the STRICT flat floor, not the loosest band",
  floorsFor(null).liq === cfg.screen.minLiquidityUsd,
  "an unknown number must never be handed the most permissive treatment");

console.log("\nA POOL THAT CAN BE READ AND IS TOO THIN STILL DIES");
ok("micro-cap with $1k of depth is refused",
  wouldSurviveScreen(coin({ mcap: 30_000, liq: 1_000 })) === "thin_liquidity", "$1k < $5k floor");
ok("...and a $5m coin with $12k of depth is refused too",
  wouldSurviveScreen(coin({ mcap: 5_000_000, liq: 12_000, vol: 50_000 })) === "thin_liquidity",
  "$12k clears the nano bar four times over and still fails up here — the band bar rises with size");

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
/* A cap off the board gets the STRICT flat floors, so this coin is given depth that
   clears them — otherwise it dies on liquidity and never reaches the cap check. */
ok("too_small still fires below the nano floor",
  wouldSurviveScreen(coin({ mcap: 4_000, liq: 20_000, vol: 50_000 })) === "too_small",
  "$4k is under the $5k bottom of the board");
/* Still fires — but on the BAND'S clock. A $5m coin half an hour old is refused; a
   $50k one is exactly what the micro sleeve is hunting. */
ok("too_new still fires on a $5m coin half an hour old",
  wouldSurviveScreen(coin({ mcap: 5_000_000, liq: 20_000, vol: 50_000, age: 0.5 })) === "too_new");
ok("...and does NOT fire on a micro-cap the same age",
  wouldSurviveScreen(coin({ mcap: 50_000, liq: 9_000, vol: 50_000, age: 0.5 })) !== "too_new");
ok("wash_suspect still fires on an absurd volume/depth ratio",
  wouldSurviveScreen(coin({ mcap: 50_000, liq: 6_000, vol: 6_000 * 41 })) === "wash_suspect");

console.log("\nTHE BONDING-CURVE PENALTY RESTED ON A FALSE FACT");
/* -30 for being on a curve, justified as "no AMM depth for the exit probe to measure, so
 * it fails cannot_exit anyway". That is a checkable claim and it is wrong: four on-curve
 * coins probed at 4.53%, 5.49%, 5.58%, 3.70% round trip against an 8% ceiling. Because a
 * score of zero means the coin is never observed at all, this deleted 38 of 58 micro-caps
 * on a live sweep - every one of them on-curve - one line ABOVE the funnel. */
const curveCoin = (over = {}) => ({
  mint: "C", onCurve: true, category: "memecoin",
  pair: {
    baseSymbol: "C", marketCap: 45_000, ageHours: 6,
    volume: { h24: over.vol ?? 120_000 },
    txns: { h24: { buys: over.buys ?? 900, sells: 400 }, h1: { buys: over.h1buys ?? 60 }, h6: { buys: over.h6buys ?? 150 } },
    priceChange: { h1: 4, h6: 12, h24: 30 },
    socials: [{ type: "twitter" }],
    ...(over.liq !== undefined ? { liquidityUsd: over.liq } : {}),
  },
});

ok("an on-curve coin with a real tape is no longer zeroed out of existence",
  rank(curveCoin()).score > 0,
  `score ${rank(curveCoin()).score} — it now reaches the funnel instead of vanishing above it`);

ok("...and it is NOT given a bonus either — being early is neutral, not a licence",
  !rank(curveCoin()).why.some((w) => /bonding curve/i.test(w)),
  "the exit probe still has to measure it; unverified_exit and cannot_exit are unchanged");

/* My first version of this fixture was self-contradictory - $200 of volume with the
 * price up 30% - and it scored positive, correctly. A coin cannot be simultaneously
 * untraded and re-rating; the momentum bonuses were reading the only live signal I had
 * given it. Fixed to be genuinely dead. */
const deadCurve = curveCoin({ vol: 200, buys: 4, h1buys: 0, h6buys: 1 });
deadCurve.pair.priceChange = { h1: 0, h6: 0, h24: 0 };
deadCurve.pair.txns.h24.sells = 3;
ok("an on-curve coin with a genuinely dead tape still scores itself out",
  rank(deadCurve).score <= 0,
  `score ${rank(deadCurve).score} — removing a false penalty is not waving everything through`);

/* And the case my bad fixture accidentally described - price moving with no volume
 * behind it - is caught, just not by rank(). It is worth asserting WHERE, because
 * "rank does not catch it" was the shape of the objection and the answer is that rank
 * is not the thing that has to. */
const ghostPump = curveCoin({ vol: 200, buys: 4, h1buys: 0, h6buys: 1 });
ok("a coin up 30% on $200 of volume is killed by the SCREEN, not ranked away",
  rank(ghostPump).score > 0 && wouldSurviveScreen(ghostPump) === "no_volume",
  "the free screen is the net here — rank only decides what is worth screening");

console.log("\nUNREADABLE DEPTH IS SCORED ON THE TAPE, NOT SILENTLY ZEROED");
ok("a strong tape earns turnover credit even with no readable pool",
  rank(curveCoin()).why.some((w) => /without a readable pool/i.test(w)),
  "the ratio used to evaluate to 0 and quietly withhold the bonus");

ok("a KNOWN pool still scores on the depth ratio, unchanged",
  rank(curveCoin({ liq: 30_000, vol: 60_000 })).why.some((w) => /healthy turnover/i.test(w)),
  "vol/liq = 2, inside the healthy band");

ok("and an implausible ratio on a KNOWN pool is still penalised",
  rank(curveCoin({ liq: 10_000, vol: 900_000 })).why.some((w) => /implausible/i.test(w)),
  "vol/liq = 90 — wash territory");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
