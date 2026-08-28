import { getJson } from "../lib/http.js";

const HOSTS = ["https://lite-api.jup.ag", "https://api.jup.ag"];

async function tryHosts(pathAndQuery, label) {
  let last;
  for (const h of HOSTS) {
    const r = await getJson(h + pathAndQuery, { label: label || pathAndQuery });
    if (r.ok) return r;
    last = r;
  }
  return last;
}

export async function price(mints) {
  const r = await tryHosts(`/price/v3?ids=${mints.join(",")}`, "jupiter/price");
  return r.ok ? r.data : null;
}

export async function quote({ inputMint, outputMint, amount, slippageBps = 100 }) {
  const r = await tryHosts(
    `/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`,
    "jupiter/quote"
  );
  if (!r.ok) return { ok: false, error: r.error };
  const q = r.data;
  return {
    ok: true,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    priceImpactPct: q.priceImpactPct != null ? Number(q.priceImpactPct) * 100 : null,
    hops: q.routePlan?.length ?? null,
    amms: (q.routePlan || []).map((p) => p.swapInfo?.label).filter(Boolean),
  };
}

/**
 * The exitability probe: buy $X of the token, then immediately sell everything you
 * received back. The round trip is the number that actually matters — a token can
 * quote a tight buy and still be a roach motel on the way out.
 */
export async function roundTrip({ quoteMint, tokenMint, quoteAmountRaw }) {
  const buy = await quote({ inputMint: quoteMint, outputMint: tokenMint, amount: quoteAmountRaw });
  if (!buy.ok) return { ok: false, error: `buy leg: ${buy.error}` };

  const sell = await quote({ inputMint: tokenMint, outputMint: quoteMint, amount: buy.outAmount });
  if (!sell.ok) return { ok: false, error: `sell leg: ${sell.error}`, buy };

  const back = Number(sell.outAmount);
  const sent = Number(quoteAmountRaw);
  const roundTripLossPct = sent > 0 ? ((sent - back) / sent) * 100 : null;

  return {
    ok: true,
    buy,
    sell,
    // Total cost of a there-and-back trip: both price impacts plus both venue fees.
    roundTripLossPct: roundTripLossPct == null ? null : Number(roundTripLossPct.toFixed(2)),
    buyImpactPct: buy.priceImpactPct,
    sellImpactPct: sell.priceImpactPct,
  };
}
