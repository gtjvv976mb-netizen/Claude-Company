/**
 * PUMP.FUN — who created it, and what else they have created.
 *
 * "Who deployed this" was the one item of the doctrine we had deferred: on-chain
 * discovery is unbounded (a hot mint accrues thousands of signatures in hours,
 * and this Helius plan does not serve DAS creators). Pump.fun's own API answers
 * both questions in two GETs. It is an unofficial API, so everything here is
 * best-effort: a failure degrades to "deployer unknown", never to a blocked
 * pipeline — and the screen rule that reads this only ever fires on POSITIVE
 * evidence of a launch farm, never on the absence of data.
 */
import { getJson } from "../lib/http.js";

const BASE = "https://frontend-api-v3.pump.fun";

/** The coin as pump.fun knows it: creator, graduation, community signals. */
export async function coinInfo(mint) {
  const r = await getJson(`${BASE}/coins/${mint}`, { label: "pumpfun/coin", timeoutMs: 8000 });
  if (!r.ok || !r.data?.mint) return { ok: false };
  const c = r.data;
  return {
    ok: true,
    creator: c.creator ?? null,
    createdAt: c.created_timestamp ?? null,
    graduated: !!c.complete,
    usdMarketCap: c.usd_market_cap ?? null,
    replyCount: c.reply_count ?? null,
    kingOfTheHillAt: c.king_of_the_hill_timestamp ?? null,
  };
}

/**
 * The deployer's record, judged only by what they have shipped before this coin:
 * how many launches, how many ever graduated, how many sit dead. A wallet with
 * many launches and no graduations is a launch farm — the serial-deployer
 * pattern the research pass said dominates rug deployment.
 */
export async function deployerProfile(mint) {
  const info = await coinInfo(mint);
  if (!info.ok || !info.creator) return { ok: false, note: "deployer unknown" };
  const r = await getJson(`${BASE}/coins?creator=${info.creator}&offset=0&limit=50`,
    { label: "pumpfun/creator", timeoutMs: 8000 });
  if (!r.ok || !Array.isArray(r.data)) return { ok: true, creator: info.creator, note: "history unavailable", coin: info };

  const others = r.data.filter((c) => c.mint !== mint);
  const graduated = others.filter((c) => !!c.complete).length;
  const dead = others.filter((c) => (c.usd_market_cap ?? 0) < 5_000).length;
  return {
    ok: true,
    creator: info.creator,
    coin: info,
    priorLaunches: others.length,
    graduated,
    dead,
    // 50 is the page cap, not the universe; say so rather than imply completeness.
    truncated: r.data.length >= 50,
  };
}

/** The coin's CALLOUTS — pump.fun's on-site calls: a wallet posts a thesis on
 * a coin and the site tracks the multiple since. /callout/top/{mint} is the
 * route the live site itself uses (measured from its bundles, 2026-08-30);
 * /replies/{mint} is gone. Best-effort: any surprise reads as an empty thread. */
export async function callouts(mint, limit = 20) {
  const r = await getJson(`${BASE}/callout/top/${mint}?limit=${Math.min(50, limit)}`,
    { label: "pumpfun/callouts", timeoutMs: 8000 });
  const rows = Array.isArray(r.data?.callouts) ? r.data.callouts : [];
  if (!r.ok || !rows.length) return { ok: false, callouts: [] };
  return {
    ok: true,
    callouts: rows.map((x) => ({
      id: x.calloutId ?? null,
      user: x.userId ?? null,                                 // the caller's wallet
      username: x.username ?? x.xUsername ?? null,
      verified: !!x.isVerified,
      text: String(x.thesis ?? "").slice(0, 240),
      multiple: Number.isFinite(x.multiple) ? x.multiple : null,
      ts: x.createdAt ?? null,
      url: x.calloutId ? `https://pump.fun/callouts/${mint}/${x.calloutId}` : `https://pump.fun/coin/${mint}`,
    })).filter((x) => x.text && x.user),
  };
}
