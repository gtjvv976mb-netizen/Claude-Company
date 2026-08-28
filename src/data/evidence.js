import * as ds from "./dexscreener.js";
import * as jup from "./jupiter.js";
import * as sol from "./solana.js";
import { cfg, MINTS } from "../config.js";
import { emit } from "../lib/bus.js";

/**
 * Everything the desk knows about one token, fetched deterministically.
 * This object is the ONLY numeric ground truth the agents are permitted to use.
 */
export async function gather(mint, hook = "") {
  emit("evidence:fetch", { mint });

  const px = await ds.pairsFor(mint);
  if (!px.ok) return { ok: false, mint, error: `dexscreener: ${px.error}` };

  const best = ds.shapePair(px.pairs[0]);
  const totalLiquidityUsd = px.pairs.reduce((a, p) => a + (p.liquidity?.usd || 0), 0);

  const mintAcct = await sol.mintInfo(mint);
  const holders = mintAcct.ok && mintAcct.supply
    ? await sol.topHolders(mint, mintAcct.supply)
    : { ok: false, error: "mint info unavailable" };

  // Exitability probe at the desk's real target size, quoted in USDC.
  const usdcRaw = Math.round(cfg.targetSizeUsd * 1e6);
  const rt = await jup.roundTrip({ quoteMint: MINTS.USDC, tokenMint: mint, quoteAmountRaw: String(usdcRaw) });

  const jp = await jup.price([mint]);
  const jupPrice = jp?.[mint] ?? null;

  const vol24 = best?.volume?.h24 ?? null;
  // Depth must be measured across ALL venues, not the single deepest pair. A token
  // trading on 30 pools looks fraudulently thin if you only price the biggest one.
  const liq = Number(totalLiquidityUsd.toFixed(2)) || null;
  const txns24 = (best?.txns?.h24?.buys ?? 0) + (best?.txns?.h24?.sells ?? 0);

  return {
    ok: true,
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

  const totalLiq = ev.pairs?.totalLiquidityUsd ?? p.liquidityUsd;
  check(totalLiq == null || totalLiq < s.minLiquidityUsd,
    "thin_liquidity", `total liquidity across ${ev.pairs?.count} venues = ${totalLiq} < floor ${s.minLiquidityUsd}`);
  check(p.ageHours == null || p.ageHours < s.minPairAgeHours,
    "too_new", `ageHours=${p.ageHours} < floor ${s.minPairAgeHours}`);
  check((p.volume?.h24 ?? 0) < s.minVolume24hUsd,
    "no_volume", `volume.h24=${p.volume?.h24} < floor ${s.minVolume24hUsd}`);
  check(d.txns24h < s.minTxns24,
    "no_participants", `txns24h=${d.txns24h} < floor ${s.minTxns24}`);
  check(d.volToLiqRatio != null && d.volToLiqRatio > s.maxVolToLiqRatio,
    "wash_suspect", `volume/liquidity=${d.volToLiqRatio} > ceiling ${s.maxVolToLiqRatio}`);
  check(d.fdvToLiqRatio != null && d.fdvToLiqRatio > s.maxFdvToLiqRatio,
    "fdv_propped", `fdv/liquidity=${d.fdvToLiqRatio} > ceiling ${s.maxFdvToLiqRatio}`);
  check(ev.exitProbe?.roundTripLossPct != null && ev.exitProbe.roundTripLossPct > cfg.maxRoundTripSlippagePct,
    "cannot_exit", `round-trip loss ${ev.exitProbe.roundTripLossPct}% > ceiling ${cfg.maxRoundTripSlippagePct}% at $${cfg.targetSizeUsd}`);

  return { pass: fails.length === 0, fails };
}
