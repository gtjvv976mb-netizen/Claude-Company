import { getJson } from "../lib/http.js";

/* The exit probe is the desk's most important free screen — a coin that cannot be
 * SOLD is a roach motel no analyst should ever see — and it runs on Jupiter's public
 * lite host with no key and no back-off. Under load that host answers HTTP 429, the
 * probe reports "did not complete", and the coin is screened out as unverified_exit
 * before a dollar of research is spent. Three live house calls re-run locally all
 * died exactly that way, for $0.00. Two changes, both strictly additive:
 *  - JUPITER_API_KEY, when present, is sent as x-api-key and the keyed host goes first.
 *  - 429 and 5xx answers are retried with jittered back-off before the next host. */
const LITE_HOST = "https://lite-api.jup.ag";
const KEYED_HOST = "https://api.jup.ag";
const apiKey = () => String(process.env.JUPITER_API_KEY || "").trim();
const hosts = () => apiKey() ? [KEYED_HOST, LITE_HOST] : [LITE_HOST, KEYED_HOST];
const RETRY_DELAYS_MS = [600, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (r) => !r.ok && /HTTP (429|5\d\d)/.test(String(r.error || ""));

/** Call `attempt` until it succeeds or the transient budget is spent. Exported for tests. */
export async function withRetry(attempt, { delays = RETRY_DELAYS_MS, wait = sleep } = {}) {
  let r = await attempt();
  for (const base of delays) {
    if (!transient(r)) return r;
    await wait(base + Math.floor(Math.random() * base * 0.5));
    r = await attempt();
  }
  return r;
}

async function tryHosts(pathAndQuery, label) {
  let last;
  for (const h of hosts()) {
    const headers = h === KEYED_HOST && apiKey() ? { "x-api-key": apiKey() } : {};
    const r = await withRetry(() => getJson(h + pathAndQuery, { label: label || pathAndQuery, headers }));
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
