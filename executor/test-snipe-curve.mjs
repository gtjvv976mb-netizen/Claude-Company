/**
 * VALIDATE THE RULER BEFORE YOU TRUST IT.
 *
 * snipe-curve.mjs is the measurement every later decision on the sniper lane is taken
 * from: the mark that arms a stop, the ceiling that bounds an entry, the floor that
 * defines a catastrophe. So this file's job is not to exercise the functions, it is to
 * prove the ruler against cases whose answer is known BEFORE the code runs.
 *
 * The house rule that earned this discipline: a leg-swing metric read as 2*arccos(|w|)
 * reported every walking quadruped in the game at 0.0 degrees, and three gaits were
 * "fixed" by shortening them before anybody suspected the ruler. So:
 *
 *   - Every fixture below has an answer worked by hand from the constant-product curve,
 *     and every derived number is PRINTED alongside the assertion.
 *   - Every ruler is cross-checked against a SECOND, independently written expression:
 *     the exit engine's own executableExitMark for the mark, a float reference for the
 *     curve algebra, a 200-iteration bisection for the stop floor, and a re-derivation
 *     of the floor identity for the integer quotes.
 *   - Every assertion is made in BOTH directions. A ruler that cannot say no is not a
 *     ruler, so the fundable stop is asserted fundable at 0.8000 and NOT fundable at
 *     0.7999, the ceiling is asserted to hold on a favourable move and to REFUSE on a
 *     front-run, and the tolerance argument is asserted to throw.
 *   - The frozen rails are read from source. If maxSolPerTrade, expectedNetworkFeeLamports,
 *     maxFeeShareOfStop or minSolPerTrade ever move, this file fails LOUDLY with the
 *     value it found, because the 0.80 stop distance is a consequence of those four
 *     numbers and of nothing else.
 *
 * No network, no clock, no keypair, no signing. Runs in well under a second.
 */
import fs from "node:fs";
import { DEFAULTS, minViableSolPerTrade } from "./strategy.mjs";
import { executableExitMark } from "./exit-trigger.mjs";
import {
  BPS_DENOM, MARK_SCALE, SNIPE_CURVE_VERSION, absoluteMaxCostLamports, constantProductExactIn,
  constantProductExactOut, constantProductSellExactIn, curveExitMarkX, frictionXFor, snipeCurveState,
  snipeFloor,
} from "./snipe-curve.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const throws = (name, fn, detail = "") => {
  try { fn(); ok(name, false, `no throw — ${detail}`); }
  catch (e) { ok(name, true, e.message.slice(0, 96)); }
};
const SOL = 1_000_000_000n;            // lamports per SOL
const TOK = 1_000_000n;                // base units per token at six decimals
const f = (x, n = 6) => (x === null || x === undefined ? "null" : Number(x).toFixed(n));

/* Deterministic PRNG. A random test that cannot be replayed is a test that reports a
   failure nobody can reproduce. */
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* ------------------------------------------------------------------ *
 * 1. HAND-WORKED FIXTURES — the answers below were computed on paper. *
 * ------------------------------------------------------------------ */
console.log("\nONE SOL INTO A ONE-SOL / ONE-THOUSAND-TOKEN CURVE TAKES EXACTLY HALF THE TOKENS");
{
  /* Doubling the quote reserve must halve the base reserve — that IS the invariant, and
     it is the one case where the answer needs no arithmetic at all. vQuote 1 SOL,
     vBase 1,000 tokens (1e9 six-decimal base units), buy with 1 SOL at zero fee:
     out = 1e9 * 1e9 / (1e9 + 1e9) = 5e8 = 500 tokens. */
  const vQuote = 1n * SOL, vBase = 1_000n * TOK;
  const buy = constantProductExactIn({ vBase, vQuote, quoteInRaw: 1n * SOL, feeBps: 0 });
  console.log(`  buy: in ${buy.quoteInRaw} lamports · out ${buy.baseOutRaw} base units`
    + ` · fee ${buy.feeRaw} · impact ${f(buy.impactPct, 4)}%`);
  ok("half the base reserve, to the unit", buy.baseOutRaw === 500_000_000n, `${buy.baseOutRaw}`);
  ok("the curve was not drained", buy.vBaseAfterRaw === 500_000_000n, `${buy.vBaseAfterRaw}`);
  ok("zero fee means nothing was taken", buy.feeRaw === 0n, `${buy.feeRaw}`);
  ok("impact on a half-the-pool buy is exactly +100%", Math.abs(buy.impactPct - 100) < 1e-9,
    `${f(buy.impactPct, 9)}%`);

  const cost = constantProductExactOut({ vBase, vQuote, baseOutRaw: 500_000_000n, feeBps: 0 });
  console.log(`  exact-out: 500,000,000 base units cost ${cost.quoteInRaw} lamports`
    + ` (delivered ${cost.deliveredBaseOutRaw})`);
  ok("exact-out asks for exactly the 1 SOL exact-in spent", cost.quoteInRaw === 1n * SOL,
    `${cost.quoteInRaw}`);
  ok("and it genuinely delivers the amount asked for", cost.deliveredBaseOutRaw >= 500_000_000n,
    `${cost.deliveredBaseOutRaw}`);

  const back = constantProductSellExactIn({ vBase: buy.vBaseAfterRaw, vQuote: buy.vQuoteAfterRaw,
    baseInRaw: buy.baseOutRaw, feeBps: 0 });
  console.log(`  sell back: ${back.baseInRaw} base units returned ${back.quoteOutRaw} lamports`);
  ok("at zero fee the round trip returns the whole SOL", back.quoteOutRaw === 1n * SOL,
    `${back.quoteOutRaw}`);
}

console.log("\nTHE SAME CURVE AT A 100 BPS VENUE FEE — 497.487437 TOKENS, WORKED BY HAND");
{
  /* fee = ceil(1e9 * 100 / 10000) = 10,000,000 (0.01 SOL); net 990,000,000 reaches the
     curve; out = floor(1e9 * 99e7 / 199e7) = floor(497,487,437.185...) = 497,487,437. */
  const vQuote = 1n * SOL, vBase = 1_000n * TOK;
  const buy = constantProductExactIn({ vBase, vQuote, quoteInRaw: 1n * SOL, feeBps: 100 });
  console.log(`  buy: fee ${buy.feeRaw} · net ${buy.quoteInAfterFeeRaw} · out ${buy.baseOutRaw}`
    + ` · curve impact ${f(buy.impactPct, 4)}% · exec impact ${f(buy.execImpactPct, 4)}%`);
  ok("the fee is 0.01 SOL, rounded up", buy.feeRaw === 10_000_000n, `${buy.feeRaw}`);
  ok("the hand-worked out is 497,487,437", buy.baseOutRaw === 497_487_437n, `${buy.baseOutRaw}`);
  ok("the fee is charged before the curve, not inside it",
    buy.vQuoteAfterRaw === vQuote + buy.quoteInAfterFeeRaw, `${buy.vQuoteAfterRaw}`);
  ok("the fee makes the fill cost more than the curve alone", buy.execImpactPct > buy.impactPct,
    `${f(buy.execImpactPct, 4)}% > ${f(buy.impactPct, 4)}%`);

  const sell = constantProductSellExactIn({ vBase: buy.vBaseAfterRaw, vQuote: buy.vQuoteAfterRaw,
    baseInRaw: buy.baseOutRaw, feeBps: 100 });
  const lost = 1n * SOL - sell.quoteOutRaw;
  console.log(`  sell back: gross ${sell.grossQuoteOutRaw} · fee ${sell.feeRaw}`
    + ` · net ${sell.quoteOutRaw} · round-trip loss ${lost} lamports`);
  ok("the round trip loses the two fee legs and no more",
    lost >= buy.feeRaw + sell.feeRaw && lost <= buy.feeRaw + sell.feeRaw + 2n,
    `${lost} vs ${buy.feeRaw + sell.feeRaw} (+dust)`);
  ok("that is 1.99% of the ticket — 2x the venue fee, as advertised",
    Math.abs(Number(lost) / Number(1n * SOL) - 0.0199) < 1e-6, `${f(Number(lost) / 1e9 * 100, 4)}%`);
}

console.log("\nA 100 BPS BUY IS EXACTLY A ZERO-FEE BUY OF THE NET AMOUNT");
{
  const vQuote = 30n * SOL, vBase = 1_073_000_000n * TOK;
  const gross = 4_500_000n;
  const withFee = constantProductExactIn({ vBase, vQuote, quoteInRaw: gross, feeBps: 100 });
  const netOnly = constantProductExactIn({ vBase, vQuote, quoteInRaw: withFee.quoteInAfterFeeRaw, feeBps: 0 });
  const noFee = constantProductExactIn({ vBase, vQuote, quoteInRaw: gross, feeBps: 0 });
  console.log(`  0 bps out ${noFee.baseOutRaw} · 100 bps out ${withFee.baseOutRaw}`
    + ` · fee ${withFee.feeRaw} lamports`);
  ok("the fee is the only difference between the two",
    withFee.baseOutRaw === netOnly.baseOutRaw, `${withFee.baseOutRaw} === ${netOnly.baseOutRaw}`);
  ok("a fee can only ever reduce what you receive", withFee.baseOutRaw < noFee.baseOutRaw,
    `${withFee.baseOutRaw} < ${noFee.baseOutRaw}`);
  ok("and it raises what an exact amount costs",
    constantProductExactOut({ vBase, vQuote, baseOutRaw: 1_000_000_000n, feeBps: 100 }).quoteInRaw >
    constantProductExactOut({ vBase, vQuote, baseOutRaw: 1_000_000_000n, feeBps: 0 }).quoteInRaw);
  ok("a fee at or above 100% is not a venue and is refused",
    (() => { try { constantProductExactIn({ vBase, vQuote, quoteInRaw: gross, feeBps: 10_000 }); return false; }
             catch { return true; } })());
  ok("BPS_DENOM is the basis-point denominator and nothing else", BPS_DENOM === 10_000n);
}

/* ----------------------------------------------------------------- *
 * 2. THE CURVE STATE IS DERIVED FROM THE ROW — no graduation constant *
 * ----------------------------------------------------------------- */
console.log("\nTHE CURVE STATE IS RECOVERED FROM ITS OWN ROW, AND 85 SOL IS NOT A CONSTANT");
{
  /* The repo's own hand-worked fixture (test-pumpfun-curve.mjs): vSol 30, vTok 1073M,
     realTok 793.1M, realSol 0 -> held 279.9M, and 30*1073/279.9 - 30 = 85.005 SOL owed. */
  const state = snipeCurveState({
    vQuoteRaw: 30n * SOL, vBaseRaw: 1_073_000_000n * TOK,
    realQuoteRaw: 0n, realBaseRaw: 793_100_000n * TOK, feeBps: 100,
  });
  const owed = Number(state.quoteToCompleteRaw) / 1e9;
  console.log(`  held ${state.heldBaseRaw} base units · k ${state.k}`
    + ` · owes ${f(owed, 3)} SOL · opening virtual quote ${Number(state.vQuote0Raw) / 1e9} SOL`);
  ok("held is vBase - realBase", state.heldBaseRaw === 279_900_000n * TOK, `${state.heldBaseRaw}`);
  ok("this row owes 85.005 SOL, derived and not assumed", Math.abs(owed - 85.005) < 0.001, `${f(owed, 4)} SOL`);
  ok("the opening virtual quote is recovered as 30 SOL", state.vQuote0Raw === 30n * SOL, `${state.vQuote0Raw}`);
  ok("the invariant is exact in BigInt", state.k === state.vQuoteRaw * state.vBaseRaw);
  ok("a real quote reserve makes the mark executable rather than notional", state.reserveKnown === true);

  /* A boosted row owes a completely different total. This is why the constant was wrong. */
  const boosted = snipeCurveState({
    vQuoteRaw: 70n * SOL, vBaseRaw: 1_073_000_000n * TOK,
    realQuoteRaw: 0n, realBaseRaw: 793_100_000n * TOK, feeBps: 100,
  });
  const boostedOwed = Number(boosted.quoteToCompleteRaw) / 1e9;
  console.log(`  boosted row owes ${f(boostedOwed, 3)} SOL from the same token reserves`);
  ok("a boosted row owes nothing like 85 SOL", Math.abs(boostedOwed - 85.005) > 50,
    `${f(boostedOwed, 3)} SOL`);

  const source = fs.readFileSync(new URL("./snipe-curve.mjs", import.meta.url), "utf8");
  const code = source.split("\n").filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join("\n");
  ok("no graduation constant survives in the code", !/\b85[_.]?0*\d*\s*[*n]?\s*(SOL|LAMPORTS)/i.test(code)
    && !/85_005|85\.005/.test(code));
  ok("the ONLY desk-side import is minViableSolPerTrade",
    (code.match(/^import .*$/gm) || []).filter((l) => /strategy\.mjs/.test(l)).join("")
      === 'import { minViableSolPerTrade } from "./strategy.mjs";');
  ok("nothing is imported from trade-policy or desk-mirror",
    !/trade-policy|desk-mirror|pricePolicy|stepPosition|evaluateMirror/.test(code));
  ok("the module is pure: no clock, no randomness, no I/O, no env",
    !/Date\.now|Math\.random|fetch\(|process\.env|readFile|Connection/.test(code));
  ok("version string is present for the shadow rows", SNIPE_CURVE_VERSION === "snipe-curve-v1",
    SNIPE_CURVE_VERSION);
}

/* --------------------------------------------------- *
 * 3. BIGINT EXACTNESS — money is integers, not doubles *
 * --------------------------------------------------- */
console.log("\nTHE INVARIANT DOES NOT FIT IN A DOUBLE, AND EVERY MONEY FIELD IS A BIGINT");
{
  const vQuote = 30_000_000_007n, vBase = 1_073_000_000_000_123n;
  const exactK = vQuote * vBase;
  const doubleK = BigInt(Math.round(Number(vQuote) * Number(vBase)));
  const drift = exactK > doubleK ? exactK - doubleK : doubleK - exactK;
  console.log(`  exact k   ${exactK}\n  double k  ${doubleK}\n  drift     ${drift} raw units`);
  ok("a double cannot even hold k for a real launch curve", drift > 0n, `${drift} units out`);

  const q = constantProductExactIn({ vBase, vQuote, quoteInRaw: 4_500_000n, feeBps: 100 });
  /* Re-derive the floor from its definition rather than from the same expression:
     out is the unique integer with out*(vQuote+net) <= vBase*net < (out+1)*(vQuote+net). */
  const denom = vQuote + q.quoteInAfterFeeRaw;
  const numer = vBase * q.quoteInAfterFeeRaw;
  ok("the quote is the exact floor of the curve ratio, re-derived independently",
    q.baseOutRaw * denom <= numer && numer < (q.baseOutRaw + 1n) * denom, `${q.baseOutRaw}`);
  ok("one lamport into a fresh curve still quotes an exact integer",
    typeof constantProductExactIn({ vBase, vQuote, quoteInRaw: 1n, feeBps: 0 }).baseOutRaw === "bigint");

  const sell = constantProductSellExactIn({ vBase, vQuote, baseInRaw: 1_000_000n, feeBps: 100,
    realQuoteRaw: 30_000_000_007n });
  const moneyFields = [q.baseOutRaw, q.quoteInRaw, q.quoteInAfterFeeRaw, q.feeRaw, q.vBaseAfterRaw,
    q.vQuoteAfterRaw, sell.quoteOutRaw, sell.grossQuoteOutRaw, sell.feeRaw,
    constantProductExactOut({ vBase, vQuote, baseOutRaw: 1_000_000n, feeBps: 100 }).quoteInRaw];
  ok("every money field returned anywhere is a bigint",
    moneyFields.every((v) => typeof v === "bigint"), `${moneyFields.length} fields checked`);
  throws("a fractional amount is refused, never truncated",
    () => constantProductExactIn({ vBase, vQuote, quoteInRaw: 4_500_000.5, feeBps: 0 }));
  throws("a negative amount is refused", () => constantProductExactIn({ vBase, vQuote, quoteInRaw: -1n }));
  throws("an input that is entirely fee is refused rather than quoted at zero",
    () => constantProductExactIn({ vBase, vQuote, quoteInRaw: 50n, feeBps: 9_999 }));

  /* A NINE-DECIMAL TOKEN WITH A TEN-BILLION SUPPLY holds 2e19 raw units — past the
     9,007,199,254,740,991 where a Number stops counting by ones. The quote must still be
     exact and the MARK must still be a number: a diagnostic that cannot be computed must
     never take a held position's mark down with it. */
  const huge = { vBaseRaw: 20_000_000_000_000_000_000n, vQuoteRaw: 30n * SOL, feeBps: 100 };
  const hugeBuy = constantProductExactIn({ vBase: huge.vBaseRaw, vQuote: huge.vQuoteRaw,
    quoteInRaw: 4_500_000n, feeBps: 100 });
  const hugeMark = curveExitMarkX({
    curve: { vBaseRaw: hugeBuy.vBaseAfterRaw, vQuoteRaw: hugeBuy.vQuoteAfterRaw, feeBps: 100 },
    qtyRaw: hugeBuy.baseOutRaw, entryInputLamports: 4_500_000n });
  console.log(`  2e19-unit curve: out ${hugeBuy.baseOutRaw} · spot ${hugeBuy.spotBefore}`
    + ` · impact ${f(hugeBuy.impactPct, 6)}% · markX ${f(hugeMark, 9)}`);
  ok("a reserve past 2^53 still quotes an exact integer",
    hugeBuy.baseOutRaw * (huge.vQuoteRaw + hugeBuy.quoteInAfterFeeRaw)
      <= huge.vBaseRaw * hugeBuy.quoteInAfterFeeRaw, `${hugeBuy.baseOutRaw}`);
  ok("and the price diagnostics stay finite instead of throwing",
    Number.isFinite(hugeBuy.spotBefore) && Number.isFinite(hugeBuy.impactPct),
    `spot ${hugeBuy.spotBefore}`);
  ok("and the MARK survives a token a Number cannot count",
    Number.isFinite(hugeMark) && hugeMark > 0.97 && hugeMark < 1, `${f(hugeMark, 9)}`);
}

/* ------------------------------------------------------------------- *
 * 4. ROUND-TRIP AGREEMENT between exact-in, exact-out and sell-exact-in *
 * ------------------------------------------------------------------- */
console.log("\nEXACT-IN AND EXACT-OUT AGREE, IN BOTH DIRECTIONS, OVER 200 RANDOM STATES");
{
  const rand = mulberry32(20260911);
  const bigRand = (lo, hi) => lo + BigInt(Math.floor(rand() * Number(hi - lo)));
  let checked = 0, worstOvershoot = 0n, worstUndershoot = 0n, maxDust = 0n, violations = 0, gave = 0;
  for (let i = 0; i < 200; i += 1) {
    const vQuote = bigRand(1n * SOL, 400n * SOL);
    const vBase = bigRand(1_000_000n * TOK, 1_073_000_000n * TOK);
    const feeBps = [0, 25, 100, 300][i % 4];
    const quoteIn = bigRand(100_000n, 5n * SOL);
    const buy = constantProductExactIn({ vBase, vQuote, quoteInRaw: quoteIn, feeBps });
    if (buy.baseOutRaw <= 0n) continue;

    // exact-out of what exact-in produced must not cost MORE than exact-in paid.
    const cost = constantProductExactOut({ vBase, vQuote, baseOutRaw: buy.baseOutRaw, feeBps });
    if (cost.quoteInRaw > quoteIn) worstOvershoot = quoteIn - cost.quoteInRaw;
    // and exact-in of the exact-out cost must deliver at least what was asked for.
    const redelivered = constantProductExactIn({ vBase, vQuote, quoteInRaw: cost.quoteInRaw, feeBps });
    if (redelivered.baseOutRaw < buy.baseOutRaw) worstUndershoot = buy.baseOutRaw - redelivered.baseOutRaw;

    // buy then sell returns the input less exactly the two fee legs, plus bounded dust.
    const sell = constantProductSellExactIn({ vBase: buy.vBaseAfterRaw, vQuote: buy.vQuoteAfterRaw,
      baseInRaw: buy.baseOutRaw, feeBps });
    const expected = quoteIn - buy.feeRaw - sell.feeRaw;
    const dust = expected - sell.quoteOutRaw;
    if (dust > maxDust) maxDust = dust;
    /* The derived bound: one floor on the base out (worth up to one rounded-up unit price
       in quote) and one floor on the gross quote out, so at most 2 + 2*price lamports. A
       round trip that returned MORE than the two fee legs left would be free money out of
       a rounding rule, which is the direction that would matter. */
    const priceCeil = (vQuote + vBase - 1n) / vBase + 1n;   // lamports per base unit, rounded up
    if (sell.quoteOutRaw > expected) gave += 1;
    if (dust > 2n + 2n * priceCeil) violations += 1;
    checked += 1;
  }
  console.log(`  ${checked} states · worst exact-out overshoot ${worstOvershoot}`
    + ` · worst redelivery undershoot ${worstUndershoot} · worst round-trip dust ${maxDust} lamports`
    + ` · ${violations} outside the derived dust bound · ${gave} returning more than taken`);
  ok("200 states were actually exercised", checked === 200, `${checked}`);
  ok("exact-out never costs more than the exact-in it inverts", worstOvershoot === 0n, `${worstOvershoot}`);
  ok("exact-out always delivers at least what it was asked for", worstUndershoot === 0n, `${worstUndershoot}`);
  ok("no round trip ever returned more than it took", gave === 0, `${gave} of ${checked}`);
  ok("and every round trip landed inside the derived dust bound", violations === 0,
    `${violations} of ${checked}, worst dust ${maxDust} lamports`);
}

/* -------------------------------------------------------- *
 * 5. THE MARK — the same quantity the audited exit path uses *
 * -------------------------------------------------------- */
console.log("\nTHE MARK AGREES WITH exit-trigger.mjs TO 1e-12, AND WITH AN INDEPENDENT FLOAT REFERENCE");
{
  const rand = mulberry32(77_203);
  const bigRand = (lo, hi) => lo + BigInt(Math.floor(rand() * Number(hi - lo)));
  let worstParity = 0, worstFloatUnits = 0n, compared = 0;
  for (let i = 0; i < 200; i += 1) {
    const vQuote = bigRand(5n * SOL, 300n * SOL);
    const vBase = bigRand(10_000_000n * TOK, 1_073_000_000n * TOK);
    const feeBps = [0, 25, 100, 300][i % 4];
    const entryInputLamports = bigRand(1_000_000n, 20_000_000n);
    const buy = constantProductExactIn({ vBase, vQuote, quoteInRaw: entryInputLamports, feeBps });
    const curve = { vBaseRaw: buy.vBaseAfterRaw, vQuoteRaw: buy.vQuoteAfterRaw, feeBps };
    const sell = constantProductSellExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw,
      baseInRaw: buy.baseOutRaw, feeBps });
    if (sell.quoteOutRaw <= 0n) continue;

    const mine = curveExitMarkX({ curve, qtyRaw: buy.baseOutRaw, entryInputLamports });
    /* The exit engine's expression, written independently of this lane and audited on the
       desk path. Feeding it the same SOL/USD at entry and now makes its ratio exactly 1,
       which is the definition of markX. */
    const theirs = executableExitMark(
      { entryInputLamports: String(entryInputLamports), solUsdAtEntry: 137.42 },
      String(sell.quoteOutRaw), 137.42);
    worstParity = Math.max(worstParity, Math.abs(mine - theirs));

    /* A THIRD expression, in plain floating point straight off the reserves. Parity with
       exit-trigger proves the two lanes mean the same thing by "mark"; only this one can
       catch an algebra error, because it shares no code with either. */
    const nb = Number(curve.vBaseRaw), nq = Number(curve.vQuoteRaw), nin = Number(buy.baseOutRaw);
    const floatOut = (nq * nin) / (nb + nin) * (1 - feeBps / 10_000);
    const diffUnits = BigInt(Math.round(Math.abs(floatOut - Number(sell.quoteOutRaw))));
    if (diffUnits > worstFloatUnits) worstFloatUnits = diffUnits;
    compared += 1;
  }
  console.log(`  ${compared} states · worst |markX - executableExitMark| ${worstParity.toExponential(3)}`
    + ` · worst |float reference - exact| ${worstFloatUnits} lamports`);
  ok("the sniper's mark IS the exit engine's mark", worstParity < 1e-12, `${worstParity.toExponential(3)}`);
  ok("and it matches an independent float derivation to within rounding",
    worstFloatUnits <= 2n, `${worstFloatUnits} lamports`);
  ok("MARK_SCALE is the 1e-9 resolution both sides share", MARK_SCALE === 1_000_000_000n);
}

console.log("\nA MARK IS AN EXECUTABLE OUTPUT, NOT A SPOT PRICE — IMPACT IS CHARGED");
{
  const vQuote = 30n * SOL, vBase = 1_073_000_000n * TOK;
  const entry = 4_500_000n;
  const buy = constantProductExactIn({ vBase, vQuote, quoteInRaw: entry, feeBps: 100 });
  const curve = { vBaseRaw: buy.vBaseAfterRaw, vQuoteRaw: buy.vQuoteAfterRaw, feeBps: 100 };
  const sell = constantProductSellExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw,
    baseInRaw: buy.baseOutRaw, feeBps: 100 });
  const spotValue = (curve.vQuoteRaw * buy.baseOutRaw) / curve.vBaseRaw;    // qty x spot, no impact
  console.log(`  qty ${buy.baseOutRaw} · at spot ${spotValue} lamports · executable ${sell.quoteOutRaw}`
    + ` · impact ${f(sell.impactPct, 4)}%`);
  ok("the executable exit is STRICTLY less than qty x spot", sell.quoteOutRaw < spotValue,
    `${sell.quoteOutRaw} < ${spotValue}`);
  ok("selling into the curve is a negative-impact event", sell.impactPct < 0, `${f(sell.impactPct, 4)}%`);
  const mark = curveExitMarkX({ curve, qtyRaw: buy.baseOutRaw, entryInputLamports: entry });
  console.log(`  round-trip markX immediately after the fill: ${f(mark, 9)}`);
  ok("an instant round trip marks BELOW 1.0 — the fees and impact are inside the number",
    mark < 1 && mark > 0.97, `${f(mark, 9)}`);
}

console.log("\nTHE MARK IS CAPPED BY WHAT THE CURVE CAN ACTUALLY PAY");
{
  /* Virtual reserves are a pricing device, not SOL. A fresh curve quotes against 30
     virtual SOL while holding 0.3 real; a sell simulated off the virtual reserves alone
     would report proceeds that cannot be paid, and that number would become a mark. */
  const vQuote = 30n * SOL, vBase = 900_000_000n * TOK;
  const qty = 100_000_000n * TOK;
  const uncapped = constantProductSellExactIn({ vBase, vQuote, baseInRaw: qty, feeBps: 100 });
  const capped = constantProductSellExactIn({ vBase, vQuote, baseInRaw: qty, feeBps: 100,
    realQuoteRaw: 300_000_000n });
  console.log(`  virtual answer ${uncapped.quoteOutRaw} lamports · real reserve 300,000,000`
    + ` · executable ${capped.quoteOutRaw}`);
  ok("the virtual answer promises SOL the curve does not hold",
    uncapped.quoteOutRaw > 300_000_000n, `${uncapped.quoteOutRaw}`);
  ok("the capped answer pays only what is there", capped.quoteOutRaw === 300_000_000n,
    `${capped.quoteOutRaw}`);
  ok("and it says so", capped.reserveBound === true && capped.reserveKnown === true);
  const ample = constantProductSellExactIn({ vBase, vQuote, baseInRaw: qty, feeBps: 100,
    realQuoteRaw: 30n * SOL });
  ok("an ample reserve changes nothing at all",
    ample.reserveBound === false && ample.quoteOutRaw === uncapped.quoteOutRaw, `${ample.quoteOutRaw}`);
  ok("an unsupplied reserve is flagged, so the caller knows the mark is an upper bound",
    uncapped.reserveKnown === false);
  const markCapped = curveExitMarkX({
    curve: { vBaseRaw: vBase, vQuoteRaw: vQuote, realQuoteRaw: 300_000_000n, feeBps: 100 },
    qtyRaw: qty, entryInputLamports: 4_500_000n });
  ok("the mark follows the payable amount, not the promised one",
    Math.abs(markCapped - 300_000_000 / 4_500_000) < 1e-6, `${f(markCapped, 6)}`);
  const dead = curveExitMarkX({
    curve: { vBaseRaw: vBase, vQuoteRaw: vQuote, realQuoteRaw: 0n, feeBps: 100 },
    qtyRaw: qty, entryInputLamports: 4_500_000n });
  ok("a drained curve marks 0 and reaches the FLOOR trigger as a number, not as a throw",
    dead === 0, `${dead}`);
}

/* ------------------------------------------------------- *
 * 6. THE ABSOLUTE CEILING — and why it refuses a tolerance *
 * ------------------------------------------------------- */
console.log("\nTHE ENTRY CEILING IS ABSOLUTE: A FRONT-RUN MAKES IT REVERT, NOT FILL WORSE");
{
  const vQuote = 30n * SOL, vBase = 1_073_000_000n * TOK;
  const curve = { vBaseRaw: vBase, vQuoteRaw: vQuote, feeBps: 100 };
  const planned = constantProductExactIn({ vBase, vQuote, quoteInRaw: 4_500_000n, feeBps: 100 });
  const ceiling = absoluteMaxCostLamports({ curve, baseOutRaw: planned.baseOutRaw });
  console.log(`  plan: ${planned.baseOutRaw} base units · ceiling ${ceiling} lamports`
    + ` (ticket was ${planned.quoteInRaw})`);
  ok("the ceiling is the exact-out cost at the state we decoded", ceiling <= planned.quoteInRaw,
    `${ceiling} <= ${planned.quoteInRaw}`);

  // Someone lands 0.5 SOL in front of us at the same slot.
  const frontRun = constantProductExactIn({ vBase, vQuote, quoteInRaw: 500_000_000n, feeBps: 100 });
  const afterCost = absoluteMaxCostLamports({
    curve: { vBaseRaw: frontRun.vBaseAfterRaw, vQuoteRaw: frontRun.vQuoteAfterRaw, feeBps: 100 },
    baseOutRaw: planned.baseOutRaw });
  console.log(`  after a 0.5 SOL front-run the same tokens cost ${afterCost} lamports`
    + ` (${f(Number(afterCost) / Number(ceiling), 4)}x the ceiling)`);
  ok("the front-run pushes the cost ABOVE the ceiling, so the buy reverts", afterCost > ceiling,
    `${afterCost} > ${ceiling}`);

  // And a favourable move still fills.
  const dumped = constantProductSellExactIn({ vBase, vQuote, baseInRaw: 50_000_000n * TOK, feeBps: 100 });
  const cheaper = absoluteMaxCostLamports({
    curve: { vBaseRaw: dumped.vBaseAfterRaw, vQuoteRaw: dumped.vQuoteAfterRaw, feeBps: 100 },
    baseOutRaw: planned.baseOutRaw });
  console.log(`  after a sell into the curve the same tokens cost ${cheaper} lamports`);
  ok("a favourable move fills under the ceiling — the ceiling is not a limit order",
    cheaper < ceiling, `${cheaper} < ${ceiling}`);

  throws("a non-zero tolerance is REFUSED: a ceiling is not a tolerance",
    () => absoluteMaxCostLamports({ curve, baseOutRaw: planned.baseOutRaw, tolerance: 50 }));
  throws("not even a BigInt one", () => absoluteMaxCostLamports({ curve, baseOutRaw: 1n, tolerance: 1n }));
  ok("an explicit zero tolerance is accepted",
    absoluteMaxCostLamports({ curve, baseOutRaw: planned.baseOutRaw, tolerance: 0n }) === ceiling);

  // An adapter, when one exists, is the authority on its own venue's arithmetic.
  const adapter = { quoteExactOut: () => ({ quoteInRaw: 1_234_567n }),
    sellExactIn: () => ({ quoteOutRaw: 2_250_000n }) };
  ok("an adapter's exact-out is used when the venue provides one",
    absoluteMaxCostLamports({ curve, baseOutRaw: planned.baseOutRaw, adapter }) === 1_234_567n);
  ok("and its sell drives the mark",
    curveExitMarkX({ curve, qtyRaw: 1_000n, entryInputLamports: 4_500_000n, adapter }) === 0.5,
    `${curveExitMarkX({ curve, qtyRaw: 1_000n, entryInputLamports: 4_500_000n, adapter })}`);
  throws("an adapter that cannot answer is an ENTRY REFUSAL, never a silent zero",
    () => curveExitMarkX({ curve, qtyRaw: 1_000n, entryInputLamports: 4_500_000n,
      adapter: { sellExactIn: () => { throw new Error("unimplemented venue"); } } }));
}

/* --------------------------------------------------------------------- *
 * 7. THE FLOOR IS DERIVED FROM FROZEN RAILS — 0.80 distance, 0.20 level. *
 * --------------------------------------------------------------------- */
console.log("\nTHE FROZEN RAILS, READ FROM SOURCE — IF THEY MOVE, THIS FAILS LOUDLY");
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const pollerConst = (name) => {
  const m = poller.match(new RegExp(`${name}:\\s*([0-9_.]+)`));
  return m ? Number(m[1].replace(/_/g, "")) : null;
};
const MAX_SOL_PER_TRADE = pollerConst("maxSolPerTrade");
const EXPECTED_FEE_LAMPORTS = pollerConst("expectedNetworkFeeLamports");
{
  console.log(`  LIVE_LIMITS.maxSolPerTrade ${MAX_SOL_PER_TRADE} SOL`
    + ` · expectedNetworkFeeLamports ${EXPECTED_FEE_LAMPORTS}`
    + ` · DEFAULTS.maxFeeShareOfStop ${DEFAULTS.maxFeeShareOfStop}`
    + ` · DEFAULTS.minSolPerTrade ${DEFAULTS.minSolPerTrade}`);
  ok("the live per-trade cap is still 0.005 SOL", MAX_SOL_PER_TRADE === 0.005, `${MAX_SOL_PER_TRADE}`);
  ok("the fee cost model is still 500,000 lamports a leg", EXPECTED_FEE_LAMPORTS === 500_000,
    `${EXPECTED_FEE_LAMPORTS}`);
  ok("fees may still be at most a quarter of the stop distance", DEFAULTS.maxFeeShareOfStop === 0.25,
    `${DEFAULTS.maxFeeShareOfStop}`);
  ok("the smallest position is still 0.005 SOL", DEFAULTS.minSolPerTrade === 0.005,
    `${DEFAULTS.minSolPerTrade}`);
  ok("observe mode still zeroes the fee reserve — the guard in snipeFloor depends on it",
    /networkFeeReserveSol: EXECUTE \? jupiter\.cfg\.expectedNetworkFeeLamports \/ LAMPORTS : 0/.test(poller));
}

const LIVE_CFG = Object.freeze({ ...DEFAULTS, networkFeeReserveSol: EXPECTED_FEE_LAMPORTS / 1e9 });

console.log("\nAT THE LIVE CAP THE TIGHTEST FUNDABLE STOP IS 0.80 — A STOP AT 0.20x ENTRY");
{
  const floor = snipeFloor({ cfg: LIVE_CFG, sol: MAX_SOL_PER_TRADE });
  console.log(`  ticket ${MAX_SOL_PER_TRADE} SOL · stopFrac ${f(floor.stopFrac)}`
    + ` · floorMarkX ${f(floor.floorMarkX)} · minViableSol ${f(floor.minViableSol)}`);
  ok("the stop DISTANCE is 0.800000", Math.abs(floor.stopFrac - 0.8) < 1e-12, `${f(floor.stopFrac, 12)}`);
  ok("the stop LEVEL is 0.200000 of entry", Math.abs(floor.floorMarkX - 0.2) < 1e-12,
    `${f(floor.floorMarkX, 12)}`);
  ok("and the ticket can actually fund it", floor.minViableSol <= MAX_SOL_PER_TRADE + 1e-15,
    `${f(floor.minViableSol, 9)} <= ${MAX_SOL_PER_TRADE}`);

  /* THE OTHER DIRECTION, which is the half that makes this a ruler: one tick tighter and
     the repo's own sizing engine refuses the position outright. */
  const tighter = minViableSolPerTrade(LIVE_CFG, 0.7999);
  /* A stop at 0.70x ENTRY is a 0.30 distance, and that is the shape of stop a hand-set
     constant reaches for because it sounds prudent. It needs 0.0133 SOL — 2.7x the live
     cap — so it is not a tighter risk control, it is a position that cannot be opened. */
  const handSet = minViableSolPerTrade(LIVE_CFG, 0.30);
  console.log(`  a 0.7999 stop distance needs ${f(tighter, 9)} SOL`
    + ` · a stop at 0.70x entry (0.30 distance) needs ${f(handSet, 9)} SOL`);
  ok("a 0.7999 stop is NOT fundable at the live cap", tighter > MAX_SOL_PER_TRADE,
    `${f(tighter, 9)} > ${MAX_SOL_PER_TRADE}`);
  ok("a stop at 0.70x entry needs 2.7x the live cap — unfundable is not the same as safe",
    Math.abs(handSet - 0.0133333333) < 1e-6 && handSet > 2.6 * MAX_SOL_PER_TRADE,
    `${f(handSet, 9)} SOL = ${f(handSet / MAX_SOL_PER_TRADE, 2)}x the cap`);

  /* An independent ruler for the ruler: bisect the frozen function itself, 200 iterations,
     the same way the measurement in the build spec was taken. */
  let lo = 0.0001, hi = 1.0;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (minViableSolPerTrade(LIVE_CFG, mid) <= MAX_SOL_PER_TRADE) hi = mid; else lo = mid;
  }
  console.log(`  bisected smallest fundable stopFrac: ${f(hi, 9)}`);
  ok("the derivation agrees with a 200-iteration bisection of the frozen function",
    Math.abs(hi - floor.stopFrac) < 1e-9, `${f(hi, 12)} vs ${f(floor.stopFrac, 12)}`);
}

console.log("\nTHE FLOOR MOVES WITH THE TICKET — NOBODY EDITS A NUMBER");
{
  const sizes = [0.005, 0.01, 0.05, 0.1, 0.4];
  let lastFloor = -1, monotone = true, tight = true;
  for (const sol of sizes) {
    const r = snipeFloor({ cfg: LIVE_CFG, sol });
    console.log(`  ${String(sol).padEnd(6)} SOL → stopFrac ${f(r.stopFrac)}`
      + ` · floorMarkX ${f(r.floorMarkX)} · minViableSol ${f(r.minViableSol)}`);
    if (r.floorMarkX < lastFloor) monotone = false;
    if (r.minViableSol > sol + 1e-12) tight = false;
    lastFloor = r.floorMarkX;
  }
  ok("a bigger ticket funds a tighter stop, every step of the way", monotone);
  ok("and the inversion is tight: every size funds exactly the stop it derives", tight);

  const tiny = snipeFloor({ cfg: LIVE_CFG, sol: 0.001 });
  console.log(`  0.001  SOL → stopFrac ${f(tiny.stopFrac)} · minViableSol ${f(tiny.minViableSol)}`);
  ok("a ticket under the minimum position is not fundable at ANY stop",
    tiny.minViableSol > 0.001, `${f(tiny.minViableSol, 9)} > 0.001`);
  ok("and the stop distance is capped at 0.95 — a stop wider than entry is not a stop",
    tiny.stopFrac <= 0.95, `${f(tiny.stopFrac)}`);
}

console.log("\nOBSERVE MODE ZEROES THE FEE RESERVE, AND A FLOOR OF 1.0 WOULD SELL EVERYTHING");
{
  /* poller.mjs:1407 sets networkFeeReserveSol to 0 whenever EXECUTE is off — which is the
     configuration this lane ships in FIRST. The bare inversion gives stopFrac 0, and
     1 - 0 = 1 would put the floor AT ENTRY: every shadow position would trip the FLOOR
     trigger on its first sample and the shadow book would measure its own arithmetic. */
  const observe = { ...DEFAULTS, networkFeeReserveSol: 0 };
  const r = snipeFloor({ cfg: observe, sol: 0.005 });
  console.log(`  observe cfg → stopFrac ${f(r.stopFrac)} · floorMarkX ${f(r.floorMarkX)}`
    + ` · minViableSol ${f(r.minViableSol)}`);
  ok("no fee rail means no derived stop minimum", r.stopFrac === 0, `${r.stopFrac}`);
  ok("and the floor is 0, NOT 1 — this is the trap the guard exists for", r.floorMarkX === 0,
    `${r.floorMarkX}`);
  ok("a mark of 1.0 does not breach a 0 floor",
    !(1.0 <= r.floorMarkX), `markX 1.0 vs floor ${r.floorMarkX}`);

  throws("a zero-size ticket is refused", () => snipeFloor({ cfg: LIVE_CFG, sol: 0 }));
  throws("a negative ticket is refused", () => snipeFloor({ cfg: LIVE_CFG, sol: -0.005 }));
  throws("a config with no fee-share rail is refused, never defaulted",
    () => snipeFloor({ cfg: { ...LIVE_CFG, maxFeeShareOfStop: 0 }, sol: 0.005 }));
}

/* ------------------------------------------------------------ *
 * 8. FRICTION — breakeven is not 1.0, and it is never a constant *
 * ------------------------------------------------------------ */
console.log("\nBREAKEVEN IS COMPUTED PER FILL, AND AT THE LIVE CAP IT IS 1.2222x");
{
  const CAP = BigInt(Math.round(MAX_SOL_PER_TRADE * 1e9));
  const FEE = BigInt(EXPECTED_FEE_LAMPORTS);
  const swapIn = CAP - FEE;                     // the ticket pays its entry fee from its own budget
  const withinBudget = frictionXFor({ entryInputLamports: swapIn, entryFeeLamports: FEE,
    expectedExitFeeLamports: FEE });
  const besideBudget = frictionXFor({ entryInputLamports: CAP, entryFeeLamports: FEE,
    expectedExitFeeLamports: FEE });
  const frictionShare = Number(2n * FEE) / Number(CAP);
  console.log(`  cap ${CAP} lamports · fee ${FEE} a leg · round-trip friction`
    + ` ${f(frictionShare * 100, 2)}% of the cap`);
  console.log(`  fee inside the budget (swaps ${swapIn}) → frictionX ${f(withinBudget, 6)}`);
  console.log(`  fee beside the budget (swaps ${CAP})    → frictionX ${f(besideBudget, 6)}`);
  ok("round-trip friction at live size is 20% of the cap", Math.abs(frictionShare - 0.2) < 1e-12,
    `${f(frictionShare, 12)}`);
  ok("breakeven with the fee inside the budget is 11/9 = 1.222222",
    Math.abs(withinBudget - 11 / 9) < 1e-12, `${f(withinBudget, 12)}`);
  ok("breakeven with the fee beside it is 1.200000", Math.abs(besideBudget - 1.2) < 1e-12,
    `${f(besideBudget, 12)}`);
  ok("neither number is 1.0, which is the whole point", withinBudget > 1.2 && besideBudget > 1.19);

  /* THE TWO PERCENTAGES IN THE RECORD ARE THE SAME FORMULA. The realized fraction at any
     mark is markX / frictionX - 1, so selling at "breakeven" = entry realizes -18.18% on
     one sizing convention and -16.67% on the other. That reconciles the two figures that
     have been quoted for this lane; neither is wrong, they have different denominators. */
  const realized = (markX, friction) => markX / friction - 1;
  console.log(`  selling at markX 1.0 realizes ${f(realized(1, withinBudget) * 100, 2)}%`
    + ` (fee inside) / ${f(realized(1, besideBudget) * 100, 2)}% (fee beside)`);
  ok("a stop at entry is a LOSS-TAKING stop: -18.18% on the live sizing",
    Math.abs(realized(1, withinBudget) + 0.181818181818) < 1e-9,
    `${f(realized(1, withinBudget) * 100, 4)}%`);
  ok("and -16.67% on the other convention",
    Math.abs(realized(1, besideBudget) + 1 / 6) < 1e-12, `${f(realized(1, besideBudget) * 100, 4)}%`);
  ok("at markX = frictionX the position is exactly whole",
    Math.abs(realized(withinBudget, withinBudget)) < 1e-15);

  /* And the arithmetic behind it, in lamports, so the multiple is not the only witness. */
  const outlay = swapIn + FEE;
  const proceedsAtFriction = BigInt(Math.round(withinBudget * Number(swapIn))) - FEE;
  console.log(`  outlay ${outlay} lamports · proceeds at frictionX ${proceedsAtFriction} lamports`);
  ok("selling at frictionX returns the outlay, to the lamport",
    proceedsAtFriction === outlay, `${proceedsAtFriction} vs ${outlay}`);

  ok("a larger fill carries less friction", frictionXFor({ entryInputLamports: 400_000_000n,
    entryFeeLamports: FEE, expectedExitFeeLamports: FEE }) < withinBudget);
  ok("a zero-fee fill breaks even at exactly 1.0", frictionXFor({ entryInputLamports: CAP,
    entryFeeLamports: 0n, expectedExitFeeLamports: 0n }) === 1);
  throws("a zero-size fill has no breakeven multiple and is refused, never defaulted to 1",
    () => frictionXFor({ entryInputLamports: 0n, entryFeeLamports: FEE, expectedExitFeeLamports: FEE }));
  throws("a negative fee is refused",
    () => frictionXFor({ entryInputLamports: CAP, entryFeeLamports: -1n, expectedExitFeeLamports: FEE }));
}

/* -------------------------------------- *
 * 9. PURITY — same in, same out, no touch *
 * -------------------------------------- */
console.log("\nPURE: NOTHING IS MUTATED AND NOTHING IS REMEMBERED");
{
  const curve = Object.freeze(snipeCurveState({
    vQuoteRaw: 30n * SOL, vBaseRaw: 1_073_000_000n * TOK,
    realQuoteRaw: 1_500_000_000n, realBaseRaw: 793_100_000n * TOK, feeBps: 100,
  }));
  const before = JSON.stringify(curve, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  const args = Object.freeze({ curve, qtyRaw: 1_000_000n * TOK, entryInputLamports: 4_500_000n });
  const a = curveExitMarkX(args);
  const b = curveExitMarkX(args);
  const after = JSON.stringify(curve, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`  markX ${f(a, 9)} on two identical calls`);
  ok("the same inputs give the same mark", a === b, `${f(a, 12)}`);
  ok("the curve argument is untouched", before === after);
  ok("the decoded state is frozen at the source", Object.isFrozen(curve));
  ok("the floor is a pure function of cfg and size too",
    JSON.stringify(snipeFloor({ cfg: LIVE_CFG, sol: 0.005 }))
    === JSON.stringify(snipeFloor({ cfg: LIVE_CFG, sol: 0.005 })));
  ok("quote results are frozen, so a caller cannot edit a quote after the fact",
    Object.isFrozen(constantProductExactIn({ vBase: 1_000n * TOK, vQuote: SOL, quoteInRaw: 1_000n })));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
