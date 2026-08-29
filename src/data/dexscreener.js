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

  const byLiq = [...sol].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = byLiq.slice(0, sample);
  const prices = top.map((p) => Number(p.priceUsd)).sort((a, b) => a - b);
  const median = prices.length % 2
    ? prices[(prices.length - 1) / 2]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;

  const agrees = (p) => Math.abs(Number(p.priceUsd) - median) / median * 100 <= tolerancePct;
  const kept = byLiq.filter(agrees);
  const rejected = byLiq.filter((p) => !agrees(p))
    .map((p) => ({ dex: p.dexId, priceUsd: Number(p.priceUsd), reportedLiqUsd: p.liquidity?.usd ?? 0 }));

  if (!kept.length) return { ok: false, error: "no pool agrees with the median", median, rejected };

  return {
    ok: true,
    priceUsd: median,
    // Depth counts only pools that price the asset sanely — a pool quoting 5,000x is not
    // depth you could ever exit through.
    liquidityUsd: Number(kept.reduce((a, p) => a + (p.liquidity?.usd || 0), 0).toFixed(2)),
    deepest: kept[0],
    poolsUsed: kept.length,
    poolsRejected: rejected,
    priceSpreadPct: prices.length > 1
      ? Number(((prices[prices.length - 1] - prices[0]) / median * 100).toFixed(1)) : 0,
  };
}
