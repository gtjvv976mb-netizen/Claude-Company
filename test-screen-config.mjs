/**
 * THE SCREEN'S INTERNAL CONSISTENCY.
 *
 * Three numbers have to agree or the desk contradicts itself: the liquidity floor
 * (how thin a pool may be), the probe size (how big a trade we price the exit at),
 * and the round-trip ceiling (how much exit cost is tolerable).
 *
 * If the floor is lowered without the probe following, coins pass `thin_liquidity`
 * and then die on `cannot_exit` — the desk appears to have loosened while nothing
 * changed, which is the most confusing possible failure. This asserts the arithmetic
 * so that stays impossible.
 */
import { cfg } from "./src/config.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const { minLiquidityUsd: LIQ } = cfg.screen;
const SIZE = cfg.targetSizeUsd, CEIL = cfg.maxRoundTripSlippagePct;
// Constant-product round trip: buying X against a pool of total value L moves price
// by ~2X/L each way, so a round trip costs ~4X/L.
const roundTripAtFloor = (4 * SIZE / LIQ) * 100;

console.log(`\nliquidity floor $${LIQ.toLocaleString()} · probe $${SIZE} · ceiling ${CEIL}%`);
console.log(`worst-case round trip at the floor: ${roundTripAtFloor.toFixed(2)}%\n`);

ok("the probe still costs something at the floor (the check is not decorative)",
  roundTripAtFloor > 0.5, `${roundTripAtFloor.toFixed(2)}%`);
ok("a coin at the liquidity floor still clears the round-trip ceiling",
  roundTripAtFloor < CEIL, `${roundTripAtFloor.toFixed(2)}% < ${CEIL}%`);
ok("with headroom, so a marginal coin is not judged by two rulers at once",
  roundTripAtFloor < CEIL * 0.75, `${roundTripAtFloor.toFixed(2)}% < ${(CEIL * 0.75).toFixed(1)}%`);

// The probe must sit ABOVE a single tenant's clip — that is why we probe at all —
// but not so far above that it prices an order nobody sends.
const REAL_TRADE_USD = 0.05 * 200;          // executor maxSolPerTrade at SOL ~$200
ok("the probe is larger than one tenant's biggest clip",
  SIZE > REAL_TRADE_USD, `$${SIZE} > $${REAL_TRADE_USD}`);
ok("but within 50x of it, so it prices a real book rather than a fantasy",
  SIZE <= REAL_TRADE_USD * 50, `$${SIZE} <= $${REAL_TRADE_USD * 50}`);

// FDV/liq: a $1m-market-cap coin sitting exactly on the liquidity floor must not be
// killed by the ratio ceiling instead — that would just move the goalposts.
const ratioAt1m = 1_000_000 / LIQ;
ok("a $1m coin at the liquidity floor survives the fdv/liq ceiling",
  ratioAt1m <= cfg.screen.maxFdvToLiqRatio, `fdv/liq ${ratioAt1m.toFixed(0)} <= ${cfg.screen.maxFdvToLiqRatio}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
