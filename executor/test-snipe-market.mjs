/**
 * THE MARKET FLOOR, PINNED — and what it is pinned against is a change of strategy, not a
 * change of code.
 *
 * This floor exists because of 64 real trades: -0.361 SOL, 5 winners, entries under three
 * seconds winning 0% of the time for -18.5% while entries at ten seconds and later won 40%
 * for +34.0%. bagworkagent.fun's agents refuse almost exactly the population that lost that
 * money — nothing under an hour old, $30,000 of liquidity, $50,000 of 24-hour volume or a
 * $50,000 market cap — and those four numbers are theirs, read out of their own running
 * configuration. This file holds them, holds the five this desk adds, and holds the one rule
 * that makes the whole thing trustworthy:
 *
 *   A THRESHOLD SET AGAINST A FACT THAT COULD NOT BE MEASURED REFUSES.
 *
 * `Number(null)` is `0`, and this desk has already shipped that bug once — a creator-fee
 * vault read that failed came back as a confident "empty". Here it would be worse in both
 * directions: an unreadable liquidity reading as $0 refuses everything, and an unreadable
 * volume reading as $0 does too, so the floor would look like it was working while measuring
 * nothing at all. Every case below that ends in "could not be measured" is that rule.
 *
 *   node test-snipe-market.mjs
 */
import fs from "node:fs";
import {
  BAGWORK_FLOOR, CLAUDE_CO_ADDITIONS, MARKET_FLOOR_DEFAULTS, MARKET_FLOOR_KEYS, MARKET_FACTS,
  PREFILTER_CLAUSES, SNIPE_MARKET_VERSION, MarketFloorError,
  marketFacts, marketFloor, resolveMarketFloor, floorIsArmed, solUsdFromPairs,
  createMarketReader, marketReadFor, prefilterListingRow, momentumFetcher, momentumDedupeConflict,
  CURVE_FLOOR, STANDARD_CURVE_GRADUATION_SOL, curveReachability, ageAloneRefuses,
} from "./snipe-market.mjs";
import { SNIPE_GATES, SNIPE_GATE_COST, SOL_QUOTE_MINT } from "./snipe-entry.mjs";
import { MARKET_FLOOR_PRESETS, snipeLaneConfig } from "./snipe-lane.mjs";
import { PUMPFUN_LIST_SORTS, pumpfunListingFetcher } from "./snipe-feed.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const NOW = 1_790_000_000_000;
const WSOL = { address: "So11111111111111111111111111111111111111112" };
/** A candidate that clears BAGWORK's floor with room to spare: 2.5 hours old, 200 SOL in the
 *  curve at $200/SOL, $120k of daily volume across one pool, $80k market cap. */
const goodPair = (over = {}) => ({
  chainId: "solana", quoteToken: { ...WSOL }, priceUsd: "0.00008", priceNative: "0.0000004",
  liquidity: { usd: 34_000 }, volume: { h24: 120_000 },
  txns: { h24: { buys: 420, sells: 300 } }, priceChange: { h24: 35 },
  marketCap: 81_000, ...over,
});
const goodListing = (over = {}) => ({
  mint: "MoM1111111111111111111111111111111111111111", creator: "Cr8", complete: false,
  created_timestamp: NOW - 9_000_000, usd_market_cap: 80_000, ...over,
});
const goodCurve = { realQuoteRaw: "200000000000" };   // 200 SOL
const factsFor = (over = {}) => marketFacts({
  listing: goodListing(over.listing), curve: over.curve === undefined ? goodCurve : over.curve,
  pairs: over.pairs === undefined ? [goodPair()] : over.pairs,
  solUsd: over.solUsd, createdAtMs: over.createdAtMs, nowMs: over.nowMs ?? NOW,
});

console.log("\ntheir four numbers, kept as theirs");
{
  ok("BAGWORK's floor is exactly the four thresholds their agents run",
    BAGWORK_FLOOR.minAgeHours === 1 && BAGWORK_FLOOR.minLiquidityUsd === 30_000
    && BAGWORK_FLOOR.minVolume24hUsd === 50_000 && BAGWORK_FLOOR.minMcapUsd === 50_000
    && Object.keys(BAGWORK_FLOOR).length === 4, Object.keys(BAGWORK_FLOOR).join(", "));
  /* Kept in separate objects so nothing this desk invented can be mistaken for something a
     system earning 14.5 SOL actually proved. */
  ok("this desk's five additions are in their own object, all OFF",
    Object.values(CLAUDE_CO_ADDITIONS).every((v) => v === null) && Object.keys(CLAUDE_CO_ADDITIONS).length === 5,
    Object.keys(CLAUDE_CO_ADDITIONS).join(", "));
  ok("no key appears in both", !Object.keys(BAGWORK_FLOOR).some((k) => k in CLAUDE_CO_ADDITIONS));
  ok("the defaults are their four plus our five", MARKET_FLOOR_KEYS.length === 9
    && MARKET_FLOOR_KEYS.every((k) => k in MARKET_FLOOR_DEFAULTS));
  ok("the module names its version", SNIPE_MARKET_VERSION === "snipe-market-v1");
}

console.log("\nthe candidate that should pass, and the four ways their floor stops one");
{
  const floor = resolveMarketFloor({});
  const facts = factsFor();
  ok("a 2.5-hour-old coin with real depth, volume and cap clears the floor",
    marketFloor(facts, floor) === null, JSON.stringify(marketFloor(facts, floor)?.message ?? "passed"));
  ok("and every fact the floor judges was actually measured",
    MARKET_FACTS.every((f) => facts[f] !== null), MARKET_FACTS.filter((f) => facts[f] === null).join(", ") || "all measured");

  const cases = [
    ["minAgeHours", { listing: { created_timestamp: NOW - 120_000 } }, /2 minutes old/],
    ["minMcapUsd", { listing: { usd_market_cap: 9_000 } }, /market cap is \$9,000/],
    ["minLiquidityUsd", { curve: { realQuoteRaw: "10000000000" } }, /holds \$2,000 of real SOL/],
    ["minVolume24hUsd", { pairs: [goodPair({ volume: { h24: 1_200 } })] }, /volume is \$1,200/],
  ];
  for (const [clause, over, re] of cases) {
    const v = marketFloor(factsFor(over), floor);
    ok(`${clause} refuses by name`, v?.clause === clause, `answered ${v?.clause ?? "PASS"}`);
    ok(`...and says what it measured`, re.test(String(v?.message)), String(v?.message).slice(0, 110));
  }
  /* FIRST FAILURE WINS, cheapest first, so a report names one thing to look at rather than
     a list — and the cheapest facts are the free ones. */
  const both = marketFloor(factsFor({ listing: { created_timestamp: NOW - 60_000, usd_market_cap: 1 } }), floor);
  ok("the cheapest fact is judged first", both.clause === "minAgeHours", both.clause);
}

console.log("\nunverified is not safe — in both directions");
{
  const floor = resolveMarketFloor({});
  /* A supplied SOL price so that LIQUIDITY is measurable and the volume threshold is the
     first one with nothing to judge — otherwise the floor correctly stops one rule earlier,
     since with no pairs there is no denominator for the depth either. */
  const noPairs = marketFloor(factsFor({ pairs: null, solUsd: 200 }), floor);
  ok("a threshold with no measurement REFUSES rather than passing", noPairs?.clause === "minVolume24hUsd",
    `answered ${noPairs?.clause}`);
  ok("and names the missing fact, not a number", /volume24hUsd could not be measured/.test(String(noPairs.message)));
  ok("it does not claim the measurement was zero", noPairs.measured.volume24hUsd === null);

  const noCurve = marketFloor(factsFor({ curve: null, solUsd: 200 }), floor);
  ok("an unreadable curve refuses at liquidity rather than reading as \\$0",
    noCurve?.clause === "minLiquidityUsd" && /could not be measured/.test(noCurve.message));

  /* The opposite mistake, and the more dangerous one: a genuinely EMPTY curve must refuse as
     a measurement of zero, with a dollar figure, not as "unknown". */
  const emptyCurve = marketFloor(factsFor({ curve: { realQuoteRaw: "0" }, solUsd: 200 }), floor);
  ok("a genuinely empty curve refuses as a measured zero, not as unknown",
    emptyCurve?.clause === "minLiquidityUsd" && emptyCurve.measured.liquidityUsd === 0
    && /\$0 of real SOL/.test(emptyCurve.message), emptyCurve?.message?.slice(0, 80));

  /* And with NO thresholds armed, nothing is refused however little was measured. */
  const bare = resolveMarketFloor({ minAgeHours: null, minLiquidityUsd: null, minVolume24hUsd: null, minMcapUsd: null });
  ok("an unarmed floor refuses nothing at all", marketFloor(marketFacts({}), bare) === null);
  ok("...and floorIsArmed says so", floorIsArmed(bare) === false && floorIsArmed(resolveMarketFloor({})) === true);
}

console.log("\nthe five this desk adds");
{
  const f = factsFor();
  ok("maxVolumeToLiquidity catches a treadmill",
    marketFloor(f, resolveMarketFloor({ maxVolumeToLiquidity: 2 }))?.clause === "maxVolumeToLiquidity");
  ok("...and reports the turnover it computed",
    /3x turnover/.test(String(marketFloor(f, resolveMarketFloor({ maxVolumeToLiquidity: 2 })).message)));
  ok("...and a real book passes it", marketFloor(f, resolveMarketFloor({ maxVolumeToLiquidity: 10 })) === null);
  /* A RATIO AGAINST ZERO IS NOT A LARGE NUMBER. Same discipline as snipe-volume's baseline. */
  const zeroDepth = marketFloor(factsFor({ curve: { realQuoteRaw: "0" } }),
    resolveMarketFloor({ minLiquidityUsd: null, maxVolumeToLiquidity: 10 }));
  ok("volume over ZERO depth is refused by name, never divided",
    zeroDepth?.clause === "maxVolumeToLiquidity" && zeroDepth.ratio === null
    && /not a number/.test(zeroDepth.message));

  ok("minTxns24h counts trades, not dollars",
    marketFloor(f, resolveMarketFloor({ minTxns24h: 5_000 }))?.clause === "minTxns24h");
  ok("maxSellShare catches a book that is all exits",
    marketFloor(factsFor({ pairs: [goodPair({ txns: { h24: { buys: 100, sells: 900 } } })] }),
      resolveMarketFloor({ maxSellShare: 0.75 }))?.clause === "maxSellShare");
  ok("...and a balanced book passes it", marketFloor(f, resolveMarketFloor({ maxSellShare: 0.75 })) === null);
  ok("maxPriceChange24hPct refuses what has already run",
    marketFloor(factsFor({ pairs: [goodPair({ priceChange: { h24: 900 } })] }),
      resolveMarketFloor({ maxPriceChange24hPct: 400 }))?.clause === "maxPriceChange24hPct");
  ok("minTopPoolLiquidityUsd looks at the pool you would trade in, not the sum",
    marketFloor(factsFor({ curve: null, pairs: [goodPair({ liquidity: { usd: 3_000 } }), goodPair({ liquidity: { usd: 3_100 } })] }),
      snipeLaneConfig({ SNIPE_MIN_TOP_POOL_LIQUIDITY_USD: "20000" }).marketFloor)?.clause === "minTopPoolLiquidityUsd");
  /* A ZERO-TRADE DAY HAS NO SELL SHARE — reported null, not 0, which would read as "every
     trade was a buy": the most bullish possible reading of no trades at all. */
  const quiet = factsFor({ pairs: [goodPair({ txns: { h24: { buys: 0, sells: 0 } } })] });
  ok("a day with no trades has a null sell share, not a 0% one", quiet.sellShare === null && quiet.txns24h === 0);
  ok("and an armed sell-share cap therefore refuses it",
    marketFloor(quiet, resolveMarketFloor({ maxSellShare: 0.75 }))?.clause === "maxSellShare");
}

console.log("\nSOL in dollars, out of the same response");
{
  ok("a WSOL-quoted pair states SOL's price without another request",
    Math.abs(solUsdFromPairs([goodPair()]) - 200) < 0.001, String(solUsdFromPairs([goodPair()])));
  /* THE TRAP: this venue lists curves quoted in other mints, proved on mainnet. On one of
     those the same ratio reads about 1.0, which would value 200 SOL at two hundred dollars. */
  const usdcPair = goodPair({ quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    priceUsd: "0.00008", priceNative: "0.00008" });
  ok("a non-WSOL-quoted pair is NOT used as a SOL price", solUsdFromPairs([usdcPair]) === null);
  ok("...and is ignored when a WSOL pair is present too",
    Math.abs(solUsdFromPairs([usdcPair, goodPair()]) - 200) < 0.001);
  ok("the median across pools decides, so one stale pool cannot set the denominator",
    Math.abs(solUsdFromPairs([goodPair(), goodPair({ priceNative: "0.0000008" }), goodPair({ priceNative: "0.0000002" })]) - 200) < 1,
    String(solUsdFromPairs([goodPair(), goodPair({ priceNative: "0.0000008" }), goodPair({ priceNative: "0.0000002" })])));
  ok("an absurd result is reported unknown, never used — a $0.004 SOL is a unit fault",
    solUsdFromPairs([goodPair({ priceUsd: "0.00008", priceNative: "20" })]) === null);
  ok("no pairs at all is null, not a guess", solUsdFromPairs(null) === null && solUsdFromPairs([]) === null);

  ok("a supplied oracle price WINS over the derived one",
    factsFor({ solUsd: 400 }).solUsd === 400 && factsFor({ solUsd: 400 }).solUsdSource === "supplied");
  ok("and which one was used is on the facts, because a depth is only as good as its denominator",
    factsFor().solUsdSource === "pairs" && factsFor({ pairs: null }).solUsdSource === null);
  ok("the WSOL literal here matches snipe-entry's, which cannot be imported without a cycle",
    WSOL.address === SOL_QUOTE_MINT);
}

console.log("\nfacts: assembled honestly, or not at all");
{
  const f = factsFor();
  ok("liquidity comes from the CURVE — the SOL a seller can actually get out",
    f.liquiditySol === 200 && Math.abs(f.liquidityUsd - 40_000) < 0.01, `$${f.liquidityUsd}`);
  ok("volume is summed across pools",
    factsFor({ pairs: [goodPair({ volume: { h24: 10 } }), goodPair({ volume: { h24: 32 } })] }).volume24hUsd === 42);
  ok("depth is NOT summed — the deepest pool is reported on its own",
    factsFor({ curve: null, pairs: [goodPair({ liquidity: { usd: 10 } }), goodPair({ liquidity: { usd: 32 } })] }).topPoolLiquidityUsd === 32);
  ok("price change is taken from the deepest pool, not averaged across dust",
    factsFor({ pairs: [goodPair({ liquidity: { usd: 1 }, priceChange: { h24: 9_999 } }),
      goodPair({ liquidity: { usd: 90_000 }, priceChange: { h24: 12 } })] }).priceChange24hPct === 12);
  /* DexScreener really does return pairs with liquidity: null — measured against the live API
     while this was being built. A missing field must not become a zero. */
  ok("a pool with no liquidity field is skipped, not counted as zero depth",
    factsFor({ curve: null, pairs: [{ chainId: "solana", liquidity: null, volume: { h24: 60_000 } }, goodPair()] }).topPoolLiquidityUsd === 34_000);
  ok("non-solana pairs are dropped",
    factsFor({ curve: null, pairs: [{ chainId: "ethereum", liquidity: { usd: 9e9 }, volume: { h24: 9e9 } }] }).topPoolLiquidityUsd === null);
  /* THE CURVE IS A POOL. DexScreener lists every on-curve pumpfun pair with no liquidity
     field at all (measured 2026-09-26), so a top-pool figure read from pairs alone was null
     for every coin this desk can buy, and an armed minTopPoolLiquidityUsd refused them all. */
  const pumpfunPair = { chainId: "solana", dexId: "pumpfun", quoteToken: { ...WSOL }, priceUsd: "0.00008",
    priceNative: "0.0000004", liquidity: null, volume: { h24: 60_000 } };
  const onCurve = factsFor({ curve: { realQuoteRaw: "68000000000" }, pairs: [pumpfunPair] });   // 68 SOL
  ok("an on-curve coin's top pool is the curve itself, not unknown",
    onCurve.topPoolLiquidityUsd !== null && Math.abs(onCurve.topPoolLiquidityUsd - onCurve.liquidityUsd) < 1e-9,
    String(onCurve.topPoolLiquidityUsd));
  ok("so minTopPoolLiquidityUsd can now be judged on the coins this desk buys",
    marketFloor(onCurve, { minTopPoolLiquidityUsd: 10_000 }) === null);
  ok("a deeper DexScreener pool still wins over a shallower curve",
    factsFor({ curve: { realQuoteRaw: "1000000000" }, pairs: [goodPair()] }).topPoolLiquidityUsd === 34_000);
  ok("age can come from the notice when a listing carries no stamp",
    Math.abs(marketFacts({ createdAtMs: NOW - 7_200_000, nowMs: NOW }).ageHours - 2) < 0.001);
  ok("a listing stamp beats the notice hint",
    Math.abs(marketFacts({ listing: goodListing(), createdAtMs: NOW - 60_000, nowMs: NOW }).ageHours - 2.5) < 0.001);
  ok("a clock before the coin existed yields null age, not a negative one",
    marketFacts({ createdAtMs: NOW, nowMs: NOW - 1_000 }).ageHours === null);
  ok("whether the coin is still on its curve is carried, since this desk can only buy those",
    factsFor().onCurve === true && marketFacts({ listing: { mint: "X", complete: true } }).onCurve === false
    && marketFacts({}).onCurve === null);
  ok("two independent market caps are BOTH reported rather than one being picked",
    f.mcapUsd === 80_000 && f.venueMcapUsd === 80_000 && f.dexMcapUsd === 81_000 && f.mcapSource === "venue");
  /* THE PRE-FILTER'S PROMISE, KEPT. It keeps a row whose cap is unknown "because the gate can
     still measure it from DexScreener" — which was false until the gate actually did. */
  const noVenueCap = marketFacts({ listing: goodListing({ usd_market_cap: undefined }), curve: goodCurve,
    pairs: [goodPair()], nowMs: NOW });
  ok("with no venue cap, DexScreener's is judged", noVenueCap.mcapUsd === 81_000 && noVenueCap.mcapSource === "dexscreener");
  ok("so a launch notice with no listing can still be judged on cap",
    marketFloor(noVenueCap, { minMcapUsd: 50_000 }) === null);
  const disagree = factsFor({ pairs: [goodPair({ marketCap: 900_000 })] });
  ok("two caps more than 3x apart: the SMALLER is judged, and the disagreement is stamped",
    disagree.mcapUsd === 80_000 && disagree.mcapDisagreement === true && disagree.mcapSource === "venue(lower)");
  const disagree2 = factsFor({ pairs: [goodPair({ marketCap: 5_000 })] });
  ok("...whichever side is lower",
    disagree2.mcapUsd === 5_000 && disagree2.mcapSource === "dexscreener(lower)");
}

console.log("\nthe config: a typo is a floor that is not there");
{
  ok("an unknown threshold throws rather than being ignored",
    threw(() => resolveMarketFloor({ minLiqidityUsd: 1 })) instanceof MarketFloorError);
  ok("...and the message lists what it does understand",
    /Known: minAgeHours/.test(String(threw(() => resolveMarketFloor({ nope: 1 })).message)));
  ok("marketFloor itself refuses an unknown key too, not just the resolver",
    threw(() => marketFloor(factsFor(), { minLiqidityUsd: 1 })) instanceof MarketFloorError);
  ok("a negative threshold is refused", threw(() => resolveMarketFloor({ minMcapUsd: -1 })) !== null);
  ok("a non-numeric threshold is refused", threw(() => resolveMarketFloor({ minMcapUsd: "lots" })) !== null);
  ok("null is a valid threshold and means off", resolveMarketFloor({ minAgeHours: null }).minAgeHours === null);

  ok("SNIPE_MARKET_FLOOR=off is the shipped default, so nothing changes by upgrading",
    snipeLaneConfig({}).marketFloor === null);
  ok("SNIPE_MARKET_FLOOR=bagwork loads their four and none of ours",
    (() => { const f = snipeLaneConfig({ SNIPE_MARKET_FLOOR: "bagwork" }).marketFloor;
      return f.minAgeHours === 1 && f.minVolume24hUsd === 50_000 && f.maxSellShare === null; })());
  /* A dial on its own arms EXACTLY that dial. Inheriting three thresholds the operator never
     typed is how a bot ends up refusing on a number nobody chose. */
  ok("one dial alone arms a floor of exactly that dial",
    (() => { const f = snipeLaneConfig({ SNIPE_MIN_AGE_HOURS: "3" }).marketFloor;
      return f.minAgeHours === 3 && f.minLiquidityUsd === null && f.minMcapUsd === null; })());
  ok("a dial overrides the preset it sits beside",
    snipeLaneConfig({ SNIPE_MARKET_FLOOR: "bagwork", SNIPE_MIN_MCAP_USD: "250000" }).marketFloor.minMcapUsd === 250_000);
  ok("a misspelled preset is refused rather than silently becoming off",
    threw(() => snipeLaneConfig({ SNIPE_MARKET_FLOOR: "bagwrok" })) !== null);
  ok("the preset vocabulary is named and small", MARKET_FLOOR_PRESETS.join(",") === "off,curve,bagwork");
  ok("SNIPE_MARKET_FLOOR=curve loads the two thresholds a curve can meet, and nothing else",
    (() => { const f = snipeLaneConfig({ SNIPE_MARKET_FLOOR: "curve" }).marketFloor;
      return f.minAgeHours === 1 && f.minVolume24hUsd === 50_000 && f.minLiquidityUsd === null
        && f.minMcapUsd === null && f.minTopPoolLiquidityUsd === null; })());
  ok("the curve preset is exactly CURVE_FLOOR", JSON.stringify(CURVE_FLOOR) === JSON.stringify({ minAgeHours: 1, minVolume24hUsd: 50_000 }));
  ok("...and every one of its numbers is one of bagwork's, not an invention",
    Object.entries(CURVE_FLOOR).every(([k, v]) => BAGWORK_FLOOR[k] === v));
}

console.log("\nbagwork on a curve: a floor with nothing above it");
{
  /* THE FIXTURE ABOVE HOLDS 200 SOL, AND NO STANDARD CURVE EVER DOES — it graduates at 85.005.
     These are the shapes the 2026-09-26 snapshot actually saw on-curve at SOL $121.69: the
     deepest curve held 68 SOL, the richest cap was $36k, and the busiest hour-old coin did
     $110,756 of volume. bagwork refuses it; curve admits it. */
  const SOL = 121.69;
  const real = marketFacts({
    listing: goodListing({ created_timestamp: NOW - 2.4 * 3_600_000, usd_market_cap: 36_000 }),
    curve: { realQuoteRaw: "68000000000" }, solUsd: SOL,
    pairs: [{ chainId: "solana", dexId: "pumpfun", quoteToken: { ...WSOL }, liquidity: null, volume: { h24: 110_756 },
      priceUsd: "0.00004", priceNative: String(0.00004 / SOL) }],
    nowMs: NOW,
  });
  /* Resolved exactly as the lane resolves them — snipeLaneConfig names every key, so a preset
     never inherits another preset's thresholds through resolveMarketFloor's defaults. */
  const presetFloor = (name) => snipeLaneConfig({ SNIPE_MARKET_FLOOR: name }).marketFloor;
  const bag = marketFloor(real, presetFloor("bagwork"));
  ok("bagwork refuses the best on-curve coin of the day", bag !== null, bag?.message);
  ok("...on a threshold no curve can reach", ["minLiquidityUsd", "minMcapUsd"].includes(bag?.clause), bag?.clause);
  const cur = marketFloor(real, presetFloor("curve"));
  ok("curve admits it", cur === null, cur?.message);
  const maxCurveUsd = STANDARD_CURVE_GRADUATION_SOL * SOL;
  ok("a FULL standard curve at today's price is still under bagwork's $30k", maxCurveUsd < BAGWORK_FLOOR.minLiquidityUsd,
    `$${maxCurveUsd.toFixed(0)}`);

  const warn = curveReachability(presetFloor("bagwork"));
  ok("the startup check names both unreachable bagwork thresholds",
    warn.map((w) => w.key).sort().join(",") === "minLiquidityUsd,minMcapUsd", warn.map((w) => w.key).join(","));
  ok("...with the SOL price each would need", Math.round(warn.find((w) => w.key === "minLiquidityUsd").solUsdNeeded) === 353);
  ok("...and points at the preset that works", warn.every((w) => /SNIPE_MARKET_FLOOR=curve/.test(w.message)));
  ok("the curve preset draws no warning", curveReachability(presetFloor("curve")).length === 0);
  ok("no floor draws no warning", curveReachability(null).length === 0);
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  ok("the lane logs the warning at start", /curveReachability\(conf\.marketFloor\)/.test(lane));
}

console.log("\nage is free, so it is judged before anything is fetched");
{
  const floor = snipeLaneConfig({ SNIPE_MARKET_FLOOR: "curve" }).marketFloor;
  ok("a launch notice 10s old is refused on age alone",
    ageAloneRefuses(floor, { createdAtMs: NOW - 10_000, nowMs: NOW }) === true);
  ok("an hour-and-a-half-old listing row is not", ageAloneRefuses(floor, { listing: goodListing(), nowMs: NOW }) === false);
  ok("an UNKNOWN age is not 'refused on age' here — the gate refuses it by name",
    ageAloneRefuses(floor, { nowMs: NOW }) === false);
  ok("no age floor refuses nothing",
    ageAloneRefuses(snipeLaneConfig({ SNIPE_MIN_VOLUME_24H_USD: "1" }).marketFloor, { createdAtMs: NOW, nowMs: NOW }) === false);
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  ok("the lane skips the paid read when age alone refuses", /skipMarketRead/.test(lane) && /clause: "skipped_age"/.test(lane));
  ok("...and counts it", /counters\.marketReadsSkipped\+\+/.test(lane));
}

console.log("\nthe gate above it");
{
  ok("market_floor is a gate", SNIPE_GATES.includes("market_floor"));
  ok("it costs 1 — a request, like the socials read it rides beside", SNIPE_GATE_COST.market_floor === 1);
  const i = SNIPE_GATES.indexOf("market_floor");
  ok("it sits among the cost-1 gates, before any arithmetic",
    SNIPE_GATES[i - 1] === "no_socials" && SNIPE_GATES[i + 1] === "impact_over_cap");
  /* The gate's own three answers are asserted in test-snipe-entry.mjs, which owns the fixture
     that can reach gate 16 of 26. What is asserted here is that it cannot be reached by
     accident: the whole population of the launch lane is minutes old. */
  const entry = fs.readFileSync(new URL("./snipe-entry.mjs", import.meta.url), "utf8");
  const body = entry.slice(entry.indexOf("market_floor: (c)"), entry.indexOf("market_floor: (c)") + 1_600);
  ok("OFF MEANS OFF: an unarmed floor passes without looking", /floorIsArmed\(floor\)\) return null/.test(body));
  ok("a floor with no market read refuses rather than passing", /no market read reached this candidate/.test(body));
  ok("the measurement rides on the row whether or not it refuses", /trace\.measured\.market_floor/.test(body));
}

console.log("\nthe reader: a port, and it fails soft into nulls rather than zeros");
{
  const reader = createMarketReader({ pairsFor: async () => ({ ok: true, pairs: [goodPair()] }) });
  const got = await reader("M");
  ok("a good read carries the pairs", got.ok === true && got.pairs.length === 1);

  const dead = createMarketReader({ pairsFor: async () => ({ ok: false, error: "HTTP 503" }) });
  const bad = await dead("M");
  ok("a failed read is ok:false with a clause, never an empty pair list",
    bad.ok === false && bad.clause === "no_pairs" && bad.pairs === null, bad.message);

  const thrower = createMarketReader({ pairsFor: () => { throw new Error("socket hung up"); } });
  const caught = await thrower("M");
  ok("a throwing reader becomes a clause, not an exception on the buying path",
    caught.ok === false && caught.clause === "fetch_failed" && /socket hung up/.test(caught.message));

  const slow = createMarketReader({ pairsFor: () => new Promise(() => {}), timeoutMs: 20 });
  const timedOut = await slow("M");
  ok("a hanging API times out rather than holding a launch open forever",
    timedOut.clause === "fetch_failed" && /timed out/.test(timedOut.message));
  ok("a reader with no fetcher is refused at construction", threw(() => createMarketReader({})) !== null);

  /* THE JOIN. The network half and the local half meet in marketReadFor, and the floor above
     it must be able to tell "nobody read" from "the read failed" from "the read was empty". */
  const joined = marketReadFor({ read: got, listing: goodListing(), curve: goodCurve, nowMs: NOW });
  ok("the joined read produces facts the floor clears", joined.ok === true && marketFloor(joined.facts, resolveMarketFloor({})) === null);
  ok("no read at all is its own clause", marketReadFor({}).clause === "no_read");
  ok("a failed read carries its clause through to the gate",
    marketReadFor({ read: bad, listing: goodListing(), curve: goodCurve, nowMs: NOW }).clause === "no_pairs");
  ok("...and its facts are null where the pairs would have been, never zero",
    marketReadFor({ read: bad, listing: goodListing(), curve: goodCurve, nowMs: NOW }).facts.volume24hUsd === null);
}

console.log("\nthe momentum source: cheap facts first, and it counts what it drops");
{
  ok("the listing fetcher can be pointed at activity, and only at sorts that were verified",
    PUMPFUN_LIST_SORTS.includes("last_trade_timestamp")
    && threw(() => pumpfunListingFetcher({ sort: "volume" })) !== null);
  ok("the created-order default is unchanged, so the launch sources behave exactly as before",
    typeof pumpfunListingFetcher({}) === "function");

  const floor = resolveMarketFloor({});
  const rows = [
    goodListing({ mint: "BONDED", complete: true }),
    goodListing({ mint: "YOUNG", created_timestamp: NOW - 60_000 }),
    goodListing({ mint: "SMALL", usd_market_cap: 9_000 }),
    goodListing({ mint: "GOOD" }),
    goodListing({ mint: "NOAGE", created_timestamp: undefined }),
    goodListing({ mint: "NOMCAP", usd_market_cap: undefined }),
    { complete: false },
  ];
  const fetchRows = async () => rows;
  const fetcher = momentumFetcher({ fetchRows, floor, now: () => NOW });
  const kept = await fetcher();
  /* A BONDED COIN IS NOT A THRESHOLD FAILURE, IT IS A CAPABILITY ONE: the only buy layouts
     proved here are pump.fun's bonding curve, so admitting one would pay for a market read to
     refuse at curve_already_complete. */
  ok("a bonded coin is dropped before anything is fetched for it",
    !kept.some((r) => r.mint === "BONDED") && fetcher.stats().dropped.bonded === 1);
  ok("a coin under the age floor is dropped on the free fact", fetcher.stats().dropped.too_young === 1);
  ok("a coin whose market cap is KNOWN and under the bar is dropped", fetcher.stats().dropped.under_mcap === 1);
  /* Age and market cap are treated differently ON PURPOSE. Age cannot be recovered later, so
     unknown age is dropped; market cap can be measured from DexScreener, so an unknown one is
     deferred to the gate that has better evidence. */
  ok("unknown AGE is dropped — the floor exists so this bot stops buying coins whose age it does not know",
    fetcher.stats().dropped.unknown_age === 1);
  ok("unknown MARKET CAP is kept, because the gate can still measure it",
    kept.some((r) => r.mint === "NOMCAP"));
  ok("a row with no mint is dropped and counted", fetcher.stats().dropped.no_mint === 1);
  ok("the survivor is the one that should survive", kept.map((r) => r.mint).join(",") === "GOOD,NOMCAP");
  /* THE TALLY IS NOT DECORATION: two rows out of seven looks identical to a dead market and
     to a broken filter, and those need opposite responses. */
  ok("the arrivals are reported even when almost nothing survived",
    fetcher.stats().arrived === 7 && fetcher.stats().survived === 2 && fetcher.stats().polls === 1);
  ok("every drop clause is declared", Object.keys(fetcher.stats().dropped).every((c) => PREFILTER_CLAUSES.includes(c)));

  const capped = momentumFetcher({ fetchRows: async () => Array.from({ length: 40 }, (_, i) => goodListing({ mint: `M${i}` })),
    floor, now: () => NOW, keep: 5 });
  const head = await capped();
  ok("survivors past the cap are cut from the ACTIVITY-SORTED head and counted",
    head.length === 5 && capped.stats().capped === 35);
  const notAnArray = momentumFetcher({ fetchRows: async () => null, floor });
  ok("a fetcher that returns something other than an array throws rather than reading as empty",
    await notAnArray().then(() => false).catch((e) => /not an array/.test(e.message)));
  ok("prefilterListingRow is pure and takes its clock", prefilterListingRow(goodListing(), floor, { nowMs: NOW }) === null);
  /* A BROKEN CLOCK IS NOT A YOUNG COIN. Comparing against NaN drops the row either way, so the
     fail-closed behaviour was always right — but an operator reading a listing where every row
     is "too young" looks at the market, and one reading "unknown_age" looks at the clock. */
  ok("an unusable clock is reported as unknown_age, not as a coin that is too young",
    prefilterListingRow(goodListing(), floor, { nowMs: NaN }).clause === "unknown_age");
  /* `undefined` is not the case here — it triggers the parameter default, which is Date.now()
     and perfectly usable. `null` is the one that arrives when a caller passes a clock it could
     not read. */
  ok("...and says the clock was the fault, not the row",
    prefilterListingRow(goodListing(), floor, { nowMs: null }).clockUnusable === true);
  ok("an omitted clock still uses the default rather than reading as a fault",
    prefilterListingRow(goodListing(), floor) === null);
  ok("momentumFetcher needs a fetcher", threw(() => momentumFetcher({})) !== null);
}

console.log("\nthe momentum source follows filters changed on a running lane");
{
  /* The desk can change a running lane's floor (snipe-lane.mjs LIVE_FILTER_ENV), so the
     pre-filter reads the floor on every poll, and sits idle — fetching nothing — while no filter
     that wants these candidates is armed. */
  let floorNow = {};
  let wanted = false;
  let fetched = 0;
  const young = goodListing({ mint: "Young111111111111111111111111111111111111111", created_timestamp: NOW - 600_000 });
  const fetch = momentumFetcher({ now: () => NOW, floor: () => floorNow, active: () => wanted,
    fetchRows: async () => { fetched++; return [goodListing(), young]; } });
  const idle = await fetch();
  ok("while nothing wants candidates the source is idle and fetches nothing", idle.length === 0 && fetched === 0 && fetch.stats().idle === 1);
  wanted = true;
  ok("armed with no age floor, both rows pass the pre-filter", (await fetch()).length === 2 && fetched === 1);
  floorNow = { minAgeHours: 1 };
  const aged = await fetch();
  ok("the floor is read on every poll, so a change applies to the very next one",
    aged.length === 1 && aged[0].mint === goodListing().mint && fetch.stats().dropped.too_young === 1);
}

console.log("\nthe floor and the feed must not silently cancel each other out");
{
  /* THE DEFAULT PAIRING WORKS BY COINCIDENCE: a 1-hour age floor against a 30-minute dedupe
     window. Two constants chosen for unrelated reasons that happen to sit the right way round. */
  const TTL = 30 * 60_000;
  ok("the shipped pairing is fine — an hour-old candidate has aged out of the window",
    momentumDedupeConflict({ minAgeHours: 1, dedupeTtlMs: TTL }) === null);
  /* AND THE ONE THAT WOULD SILENTLY DELIVER NOTHING. A quarter-hour floor is a reasonable thing
     to try, and every candidate would still be held in the ledger from its own launch. */
  const clash = momentumDedupeConflict({ minAgeHours: 0.25, dedupeTtlMs: TTL });
  ok("a floor under the dedupe window is reported, not a quiet afternoon of nothing", clash !== null);
  ok("...as a WARNING: only a band is lost, so the lane still runs", clash.severity === "warning");
  ok("...naming the band that is swallowed", /between 15 minutes and 30 minutes/.test(clash.message), clash.message);
  ok("...and saying older candidates still arrive, rather than claiming the source delivers nothing",
    /Older candidates arrive normally/.test(clash.message) && !/deliver nothing/.test(clash.message));
  ok("...and gives the number to raise it to", /at least 0\.50/.test(clash.message));
  ok("exactly at the window is fine, since insertion order is time order",
    momentumDedupeConflict({ minAgeHours: 0.5, dedupeTtlMs: TTL }) === null);
  /* NO AGE FLOOR IS AN AGE FLOOR OF ZERO — the whole first half hour is the swallowed band. */
  const noAge = momentumDedupeConflict({ minAgeHours: null, dedupeTtlMs: TTL });
  ok("no age floor is the WIDEST conflict, not none", noAge !== null && /between 0 and 30 minutes/.test(noAge.message), noAge?.message);
  ok("an unknown window is not assumed",
    momentumDedupeConflict({ minAgeHours: 0.1, dedupeTtlMs: null }) === null
    && momentumDedupeConflict({ minAgeHours: 0.1, dedupeTtlMs: 0 }) === null);

  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller logs the clash at startup rather than discovering it as silence",
    /momentumDedupeConflict\(\{/.test(poller) && /if \(dedupeClash\) log\(`\[snipe\] WARNING: \$\{dedupeClash\.message\}`\);/.test(poller));
  ok("...and no longer refuses the whole lane over a partial loss", !/if \(dedupeClash\) throw/.test(poller));
  ok("...against the feed's real constant, not a copy of it",
    /dedupeTtlMs: feedMod\.FEED_DEFAULTS\.dedupeTtlMs/.test(poller));
}

console.log("\nwiring");
{
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  ok("the lane issues the market read BESIDE the account read, not after it",
    lane.indexOf("const marketPromise") < lane.indexOf("read = await readAcrossEndpoints"));
  ok("...and only when a floor is actually configured, so an operator running none pays nothing",
    /const floorArmed = floorIsArmed\(conf\.marketFloor\);/.test(lane) && /const marketPromise = !floorArmed \? null/.test(lane));
  ok("the facts are assembled after the curve decodes, where the honest depth is",
    lane.indexOf("marketReadFor({") > lane.indexOf("curve = adapter.curveFromAccount"));
  ok("an armed floor with no reader is refused at CONSTRUCTION, not once per candidate",
    /market_reader_missing/.test(lane) && /Wire the reader or set SNIPE_MARKET_FLOOR=off/.test(lane));
  ok("the lane stamps the floor it is running and whether it can honour it",
    /marketFloor: conf\.marketFloor,/.test(lane) && /marketReaderWired: typeof marketReader === "function"/.test(lane));
  ok("the arming banner names the thresholds rather than saying 'armed'",
    /snipe market floor ARMED: \$\{named\}/.test(lane));

  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the momentum source is ADDED to the feed, never substituted for the launch sources",
    /id: "logs:pumpfun"/.test(poller) && /id: "poll:pumpfun-list"/.test(poller) && /id: "poll:pumpfun-momentum"/.test(poller));
  ok("it exists only when a floor is armed", /momentumFetch \? \[feedMod\.pollSource\(/.test(poller));
  ok("it polls slower than the launch poll, because these coins are hours old", /intervalMs: 30_000/.test(poller));
  ok("the reader uses the desk's own DexScreener client rather than a second one",
    /pairsFor: \(mint\) => dexPairsFor\(mint\)/.test(poller));
  ok("snipe-market is imported dynamically, so SNIPE_LANE=off still costs nothing",
    !/^import .*snipe-market/m.test(poller) && /import\("\.\/snipe-market\.mjs"\)/.test(poller));

  const src = fs.readFileSync(new URL("./snipe-market.mjs", import.meta.url), "utf8");
  ok("the module opens no connection and builds no HTTP client",
    !/new Connection\(/.test(src) && !/\bfetch\(/.test(src));
  ok("nothing in it coerces a missing fact to zero", !/Number\(.*\) \|\| 0/.test(src));
  ok("the limit of this desk's execution is stated, not papered over",
    /bonded coin trades where this repo cannot yet encode/.test(src));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-market  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
