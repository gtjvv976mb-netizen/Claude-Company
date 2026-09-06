/**
 * THE SCREEN'S INTERNAL CONSISTENCY.
 *
 * WHAT THIS FILE USED TO RECONCILE. Three numbers had to agree or the desk contradicted
 * itself: the liquidity floor (how thin a pool may be), the probe size (how big a trade
 * the exit was priced at), and the round-trip ceiling (how much exit cost was tolerable).
 * A floor lowered without the probe following meant coins passed `thin_liquidity` and
 * then died on `cannot_exit` — the desk appearing to loosen while nothing changed.
 *
 * TWO OF THE THREE ARE GONE (owner, 2026-09-07: the desk says WHAT and WHEN, never how
 * much or what it costs). cfg.targetSizeUsd and cfg.maxRoundTripSlippagePct were deleted
 * with the `cannot_exit` kill they fed. This file's own arithmetic was an argument for
 * why they were hard to keep consistent, and the honest resolution turned out to be that
 * the desk should not have been holding a cost ceiling at all: it was priced at $75
 * while the bot's real clip is about $2, and 12 of the last 100 kills died on it alone.
 *
 * WHAT STILL NEEDS RECONCILING, and is asserted below. The liquidity floor survives —
 * `thin_liquidity` is a WHAT (is there a market at all?) rather than a HOW MUCH (what
 * does leaving cost?) — so it must stay a floor about MARKETS rather than a cost proxy
 * in disguise. And the route probe still needs an amount to quote at, which must be
 * large enough that a real pool can answer it and small enough to resemble a real order.
 */
import fs from "node:fs";
import { cfg } from "./src/config.js";
import { ROUTE_PROBE_FALLBACK_USD, MIN_PROBE_USD } from "./src/probe-size.js";
const probeSrc = fs.readFileSync(new URL("./src/probe-size.js", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const { minLiquidityUsd: LIQ } = cfg.screen;
const SIZE = ROUTE_PROBE_FALLBACK_USD;
// Constant-product round trip: buying X against a pool of total value L moves price
// by ~2X/L each way, so a round trip costs ~4X/L.
const roundTripAtFloor = (4 * SIZE / LIQ) * 100;

console.log(`\nliquidity floor $${LIQ.toLocaleString()} · route probe $${SIZE} (no ceiling — that judgment is the bot's)`);
console.log(`round trip at the floor, for information only: ${roundTripAtFloor.toFixed(2)}%\n`);

console.log("THE TWO COST NUMBERS ARE GONE, NOT JUST UNUSED");
ok("cfg.targetSizeUsd is gone", cfg.targetSizeUsd === undefined);
ok("cfg.maxRoundTripSlippagePct is gone", cfg.maxRoundTripSlippagePct === undefined);
ok("...so the floor can no longer contradict a ceiling that does not exist",
  cfg.screen.minLiquidityUsd > 0, `only the liquidity floor is left: $${LIQ.toLocaleString()}`);

console.log("\nTHE ROUTE PROBE'S AMOUNT IS STILL A SENSIBLE ONE TO QUOTE");
/* It is no longer reconciled against a ceiling, because there is no ceiling. What it
   still has to be is an amount a real pool can meaningfully answer: not dust, where the
   USDC leg rounds hard enough that a live route fails to quote and reads back as a false
   honeypot, and not a fantasy order nobody would ever place. */
const BIGGEST_TENANT_CLIP_USD = 0.05 * 200;   // executor maxSolPerTrade at SOL ~$200
ok("the stated fallback is above the dust threshold the probe itself enforces",
  SIZE >= MIN_PROBE_USD * 5, `$${SIZE} >= $${MIN_PROBE_USD * 5}`);
ok("...and within 50x of the largest clip a tenant's bot can place",
  SIZE <= BIGGEST_TENANT_CLIP_USD * 50, `$${SIZE} <= $${BIGGEST_TENANT_CLIP_USD * 50}`);
/* AND IT PREFERS A MEASUREMENT TO THE CONSTANT. The fallback is the no-bot case; when a
   bot is reporting, the amount is its own declared cap. That is what stops this number
   drifting into being a desk opinion again. */
ok("the fallback is only reached when no bot can be read",
  /fromBot: false/.test(probeSrc) && /fromBot: true/.test(probeSrc)
  && !/DESK_TARGET_SIZE_USD/.test(probeSrc.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n")),
  "probe-size.js resolves from a live heartbeat first");
/* THE LIQUIDITY FLOOR IS A MARKET FLOOR, NOT A COST PROXY. This is the property that
   used to be enforced by reconciling it against the ceiling. With the ceiling gone it is
   asserted directly: the floor exists so a coin with no market on the other side of any
   order is refused, and $12,000 is far above the "no market at all" case ($0.65 across
   two venues, the SAXDUK kill) while being an ordinary pool for a small coin. */
ok("the liquidity floor is a market floor, comfortably above the no-market case",
  LIQ >= 1_000 && LIQ <= 100_000, `$${LIQ.toLocaleString()}`);

// FDV/liq: a $1m-market-cap coin sitting exactly on the liquidity floor must not be
// killed by the ratio ceiling instead — that would just move the goalposts.
const ratioAt1m = 1_000_000 / LIQ;
ok("a $1m coin at the liquidity floor survives the fdv/liq ceiling",
  ratioAt1m <= cfg.screen.maxFdvToLiqRatio, `fdv/liq ${ratioAt1m.toFixed(0)} <= ${cfg.screen.maxFdvToLiqRatio}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
