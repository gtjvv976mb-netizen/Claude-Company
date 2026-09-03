import { getJson } from "../lib/http.js";

const BASE = "https://api.dexscreener.com";

/** Tokens people are paying to promote. High signal for "what's moving", high noise for quality. */
export async function boosted() {
  const r = await getJson(`${BASE}/token-boosts/top/v1`, { label: "dexscreener/boosts" });
  if (!r.ok) return [];
  return (r.data || [])
    .filter((t) => t.chainId === "solana" && t.tokenAddress)
    .map((t) => ({ mint: t.tokenAddress, hook: "paid boost", blurb: t.description || "" }));
}

/** Every promotion this token PAID for — boosts, ads — from the official orders
 * endpoint. The sweep uses paid attention to find coins; the analysts use this
 * to discount it: bought reach is not organic demand, and the buyer of a call
 * deserves to know which kind they are looking at. */
export async function paidOrders(mint) {
  const r = await getJson(`${BASE}/orders/v1/solana/${mint}`, { label: "dexscreener/orders" });
  if (!r.ok) return { ok: false, orders: [] };
  const orders = (r.data?.orders ?? r.data ?? []).map((o) => ({
    type: o.type, status: o.status, paidAt: o.paymentTimestamp ?? null,
  }));
  return { ok: true, orders };
}

/** Freshly listed token profiles. */
export async function profiles() {
  const r = await getJson(`${BASE}/token-profiles/latest/v1`, { label: "dexscreener/profiles" });
  if (!r.ok) return [];
  return (r.data || [])
    .filter((t) => t.chainId === "solana" && t.tokenAddress)
    .map((t) => ({ mint: t.tokenAddress, hook: "new profile", blurb: t.description || "" }));
}

/** All pairs for a mint, richest first. pairs[0] from the API is NOT the deepest. */
export async function pairsFor(mint) {
  /* Offline test seam. The behavioral close-confirm suite runs the REAL subTickMarks,
   * whose mark loop fetches prices for its fixture calls — and the suite was green
   * only because the fixture mint happened not to resolve. A safety net whose green
   * depends on an external API erroring is the wrong-axis suite again; tests set this
   * flag and the fetch declines deterministically. Never set in production. */
  if (process.env.DS_OFFLINE === "1") return { ok: false, error: "DS_OFFLINE test mode" };
  const r = await getJson(`${BASE}/latest/dex/tokens/${mint}`, { label: "dexscreener/tokens" });
  if (!r.ok || !r.data?.pairs?.length) return { ok: false, error: r.error || "no pairs", pairs: [] };
  const pairs = r.data.pairs
    .filter((p) => p.chainId === "solana")
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return { ok: true, pairs };
}

export function shapePair(p) {
  if (!p) return null;
  const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null;
  return {
    dex: p.dexId,
    pairAddress: p.pairAddress,
    url: p.url,
    baseSymbol: p.baseToken?.symbol,
    baseName: p.baseToken?.name,
    quoteSymbol: p.quoteToken?.symbol,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    liquidityUsd: p.liquidity?.usd ?? null,
    fdv: p.fdv ?? null,
    marketCap: p.marketCap ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
    ageHours: ageHours == null ? null : Number(ageHours.toFixed(1)),
    volume: p.volume ?? {},
    txns: p.txns ?? {},
    priceChange: p.priceChange ?? {},
    imageUrl: p.info?.imageUrl ?? null,
    socials: p.info?.socials ?? [],
    websites: p.info?.websites ?? [],
  };
}


/**
 * Consensus pricing across a token's pools.
 *
 * The deepest pool by REPORTED liquidity is not the market. RAY's deepest reported pair
 * is a Meteora DLMM quoting $4,064.74 against $7.07m of claimed liquidity, while the
 * median across its top pools is $0.81 — a 5,000x error. Pricing off pairs[0] killed RAY
 * on `fdv_propped` with a fabricated ratio of 128,920, and every screen, score and exit
 * trigger downstream would have inherited the same number.
 *
 * So: take the median price across the deepest pools, discard any pool that disagrees
 * with it beyond a tolerance, and only then pick the deepest SURVIVING pool to read
 * volume, txns and price changes from.
 */
export function consensus(pairs, { sample = 8, tolerancePct = 25 } = {}) {
  const sol = (pairs || []).filter((p) => p.chainId === "solana" && Number(p.priceUsd) > 0);
  if (!sol.length) return { ok: false, error: "no priced solana pairs" };

  /* AN EMPTY POOL IS NOT A PRICE SOURCE, AND IT WAS OUTVOTING A REAL ONE.
   *
   * Measured on 24 coins from the ignition shortlist: 14 were discarded here as "no pool
   * agrees with the median", and all 14 were the same shape. A pump.fun coin that
   * graduates leaves its bonding curve behind, listed for ever at the launch price of
   * about $0.0000417 with ZERO liquidity, while the real market moves to pumpswap. So
   * the vote was $247,346 of pumpswap at $0.008676 against $0 of dead curve at
   * $0.0000415 — an unweighted median split the difference at $0.004359, which is a
   * price NEITHER pool quotes, and then the 25% tolerance rejected both. With exactly
   * two pools that is the general failure: the median sits between them, so if they
   * differ by more than about 50% nothing survives and the coin is dropped before a
   * single piece of evidence is gathered.
   *
   * Two corrections, and neither weakens the check this function exists for. First, a
   * pool with no liquidity is excluded from the vote: it is not depth, nothing can be
   * exited through it, and it is stale by construction. Second, the anchor is now the
   * LIQUIDITY-WEIGHTED median, so a dust pool cannot outvote a deep one — and because
   * the anchor is always a price some real pool is quoting, `kept` can no longer come
   * back empty while a funded pool exists.
   *
   * The RAY lesson still holds — a deep pool can still be a broken one — which is why
   * the anchor was never the last line: gather() cross-checks this mark against Jupiter
   * and KILLS on a 25% disagreement, and the exit probe measures a real round trip.
   * Both are stronger evidence than an unweighted vote among unequal pools.
   */
  const funded = sol.filter((p) => Number(p.liquidity?.usd) > 0);
  // Only prefer the funded pools when there ARE some. A coin whose venues simply do not
  // report liquidity must still be priced, not blinded.
  const voters = funded.length ? funded : sol;
  const drained = sol.length - voters.length;

  const byLiq = [...voters].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = byLiq.slice(0, sample);

  /* The weighted median: sort by price, walk the cumulative liquidity, and take the
     price standing at the halfway mark. With one pool it is that pool. With equal
     depths it is the ordinary median. With unequal depths it is the price the money is
     actually at. */
  const ranked = [...top].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
  const weights = ranked.map((p) => Math.max(Number(p.liquidity?.usd) || 0, 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let median;
  if (totalWeight > 0) {
    let run = 0;
    median = Number(ranked.at(-1).priceUsd);
    for (let i = 0; i < ranked.length; i++) {
      run += weights[i];
      if (run >= totalWeight / 2) { median = Number(ranked[i].priceUsd); break; }
    }
  } else {
    const prices = ranked.map((p) => Number(p.priceUsd));
    median = prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  }

  const agrees = (p) => Math.abs(Number(p.priceUsd) - median) / median * 100 <= tolerancePct;
  const kept = byLiq.filter(agrees);
  const rejected = byLiq.filter((p) => !agrees(p))
    .map((p) => ({ dex: p.dexId, priceUsd: Number(p.priceUsd), reportedLiqUsd: p.liquidity?.usd ?? 0 }));

  if (!kept.length) return { ok: false, error: "no pool agrees with the median", median, rejected };

  const spreadPrices = kept.map((p) => Number(p.priceUsd)).sort((a, b) => a - b);
  return {
    ok: true,
    priceUsd: median,
    // Depth counts only pools that price the asset sanely — a pool quoting 5,000x is not
    // depth you could ever exit through.
    liquidityUsd: Number(kept.reduce((a, p) => a + (p.liquidity?.usd || 0), 0).toFixed(2)),
    deepest: kept[0],
    poolsUsed: kept.length,
    poolsRejected: rejected,
    // How many listings were left out of the vote for holding no money at all. A
    // graduated pump.fun coin always has exactly one.
    drainedPoolsIgnored: drained,
    priceSpreadPct: spreadPrices.length > 1
      ? Number(((spreadPrices.at(-1) - spreadPrices[0]) / median * 100).toFixed(1)) : 0,
  };
}
