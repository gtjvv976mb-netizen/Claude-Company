import * as ds from "./dexscreener.js";
import * as jup from "./jupiter.js";
import * as sol from "./solana.js";
import { cfg, MINTS } from "../config.js";
import { emit } from "../lib/bus.js";
import { whaleFeed } from "../identity.js";
import * as pf from "./pumpfun.js";
import { regime } from "./regime.js";

/**
 * Everything the desk knows about one token, fetched deterministically.
 * This object is the ONLY numeric ground truth the agents are permitted to use.
 */
export async function gather(mint, hook = "") {
  emit("evidence:fetch", { mint });

  const px = await ds.pairsFor(mint);
  if (!px.ok) return { ok: false, mint, error: `dexscreener: ${px.error}` };

  // Never price off pairs[0]. See dexscreener.consensus() — the deepest REPORTED pool
  // can be a broken one, and RAY was killed on a price 5,000x its real market.
  const cons = ds.consensus(px.pairs);
  if (!cons.ok) return { ok: false, mint, error: `pricing: ${cons.error}` };
  const best = ds.shapePair(cons.deepest);
  if (best) best.priceUsd = cons.priceUsd;              // the consensus mark, not one pool's quote
  const totalLiquidityUsd = cons.liquidityUsd;

  const mintAcct = await sol.mintInfo(mint);
  const holders = mintAcct.ok && mintAcct.supply
    ? await sol.topHolders(mint, mintAcct.supply)
    : { ok: false, error: "mint info unavailable" };

  // Exitability probe at the desk's real target size, quoted in USDC.
  const usdcRaw = Math.round(cfg.targetSizeUsd * 1e6);
  const rt = await jup.roundTrip({ quoteMint: MINTS.USDC, tokenMint: mint, quoteAmountRaw: String(usdcRaw) });

  const jp = await jup.price([mint]);
  const jupPrice = jp?.[mint] ?? null;

  // The two questions every memecoin call must answer about its attention:
  // is it PAID FOR (DexScreener boosts/ads — bought reach, not organic demand),
  // and was it CALLED OUT (our own recorded whale callouts for this mint).
  const promo = await ds.paidOrders(mint);
  const approved = promo.orders.filter((o) => o.status === "approved");
  const promotion = {
    boosted: approved.length > 0,
    paidOrders: approved.length,
    lastPaidAt: approved.reduce((m, o) => Math.max(m, o.paidAt ?? 0), 0) || null,
  };
  const callouts = whaleFeed({ limit: 200 }).filter((w) => w.mint === mint).slice(0, 5);
  const marketRegime = await regime().catch(() => ({ regime: "unknown" }));

  // Who created it — the doctrine's deferred question, answered where it is
  // answerable (pump.fun coins) and skipped on monitor ticks, which need prices,
  // not biographies. Best-effort: an API failure reads as unknown, never a block.
  let deployer = null;
  if (hook !== "monitor" && mint.endsWith("pump")) {
    deployer = await pf.deployerProfile(mint).catch(() => null);
    if (deployer && !deployer.ok) deployer = { note: deployer.note ?? "deployer unknown" };
  }

  const vol24 = best?.volume?.h24 ?? null;
  // Depth must be measured across ALL venues, not the single deepest pair. A token
  // trading on 30 pools looks fraudulently thin if you only price the biggest one.
  const liq = Number(totalLiquidityUsd.toFixed(2)) || null;
  const txns24 = (best?.txns?.h24?.buys ?? 0) + (best?.txns?.h24?.sells ?? 0);

  return {
    ok: true,
    promotion, callouts, deployer, marketRegime,
    mint,
    hook,
    symbol: best?.baseSymbol ?? "?",
    name: best?.baseName ?? "?",
    fetchedAt: new Date().toISOString(),
    pair: best,
    pairs: {
      count: px.pairs.length,
      totalLiquidityUsd: Number(totalLiquidityUsd.toFixed(2)),
      venues: [...new Set(px.pairs.map((p) => p.dexId))],
    },
    mintAccount: mintAcct.ok ? mintAcct : { error: mintAcct.error },
    holders: holders.ok ? holders : { error: holders.error },
    exitProbe: rt.ok
      ? { targetSizeUsd: cfg.targetSizeUsd, ...rt }
      : { targetSizeUsd: cfg.targetSizeUsd, error: rt.error },
    jupPrice,
    derived: {
      totalLiquidityUsd: liq,
      volToLiqRatio: vol24 && liq ? Number((vol24 / liq).toFixed(2)) : null,
      fdvToLiqRatio: best?.fdv && liq ? Number((best.fdv / liq).toFixed(1)) : null,
      buySellRatio24h: best?.txns?.h24?.sells ? Number(((best.txns.h24.buys || 0) / best.txns.h24.sells).toFixed(2)) : null,
      txns24h: txns24,
      avgTradeSizeUsd: vol24 && txns24 ? Number((vol24 / txns24).toFixed(2)) : null,
    },
  };
}

/**
 * SCREENER — stage 1, pure code, zero tokens. Deterministic floors from the charter.
 * The point of this stage is that the expensive stages never see garbage.
 */
export function screen(ev) {
  const fails = [];
  const s = cfg.screen;
  const p = ev.pair || {};
  const d = ev.derived || {};

  const check = (cond, code, detail) => { if (cond) fails.push({ code, detail }); };

  // The launch farm: many priors, none ever graduated. Fires only on POSITIVE
  // evidence — a coin whose deployer we could not identify passes this check,
  // because "unknown" must never be an execution.
  const dep = ev.deployer;
  check(dep?.ok && dep.priorLaunches >= 8 && dep.graduated === 0,
    "serial_deployer",
    dep?.ok ? `deployer shipped ${dep.priorLaunches}+ coins, zero ever graduated` : null);

  const totalLiq = ev.pairs?.totalLiquidityUsd ?? p.liquidityUsd;
  check(totalLiq == null || totalLiq < s.minLiquidityUsd,
    "thin_liquidity", `total liquidity across ${ev.pairs?.count} venues = ${totalLiq} < floor ${s.minLiquidityUsd}`);
  check(p.ageHours == null || p.ageHours < s.minPairAgeHours,
    "too_new", `ageHours=${p.ageHours} < floor ${s.minPairAgeHours}`);
  check((p.volume?.h24 ?? 0) < s.minVolume24hUsd,
    "no_volume", `volume.h24=${p.volume?.h24} < floor ${s.minVolume24hUsd}`);
  // Was `s.minTxns24`, which is undefined — so `n < undefined` was always false and this
  // screen never fired once. The config key is minTxns24h.
  check(d.txns24h < s.minTxns24h,
    "no_participants", `txns24h=${d.txns24h} < floor ${s.minTxns24h}`);
  check(d.volToLiqRatio != null && d.volToLiqRatio > s.maxVolToLiqRatio,
    "wash_suspect", `volume/liquidity=${d.volToLiqRatio} > ceiling ${s.maxVolToLiqRatio}`);
  check(d.fdvToLiqRatio != null && d.fdvToLiqRatio > s.maxFdvToLiqRatio,
    "fdv_propped", `fdv/liquidity=${d.fdvToLiqRatio} > ceiling ${s.maxFdvToLiqRatio}`);
  check(ev.exitProbe?.roundTripLossPct != null && ev.exitProbe.roundTripLossPct > cfg.maxRoundTripSlippagePct,
    "cannot_exit", `round-trip loss ${ev.exitProbe.roundTripLossPct}% > ceiling ${cfg.maxRoundTripSlippagePct}% at $${cfg.targetSizeUsd}`);

  return { pass: fails.length === 0, fails };
}
