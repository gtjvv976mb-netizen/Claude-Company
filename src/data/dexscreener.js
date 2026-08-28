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
