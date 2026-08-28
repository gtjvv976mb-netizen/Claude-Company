import { cfg } from "./config.js";
import { readRpc } from "./lib/http.js";
import * as ds from "./data/dexscreener.js";
import { emit } from "./lib/bus.js";

/**
 * WHALE CALLOUTS — who is actually taking size, and which way.
 *
 * Read-only. Every trade against an AMM appears TWICE in the token balances: once for
 * the trader and once, mirrored, for the pool. Counting both reads every sale as also a
 * purchase and doubles the flow. The pool's own account is therefore excluded, and the
 * trader is whichever owner is left — the same class of mistake as reading a transfer
 * as a sale, and just as easy to ship.
 */

export const WHALE_USD = Number(process.env.WHALE_MIN_USD || 500);

/** Recent large trades in one mint, largest first. */
export async function callouts(mint, { scan = 30, minUsd = WHALE_USD } = {}) {
  const px = await ds.pairsFor(mint);
  if (!px.ok || !px.pairs.length) return { ok: false, error: px.error || "no pairs" };

  const cons = ds.consensus(px.pairs);
  const pair = cons.ok ? cons.deepest : px.pairs[0];
  const price = cons.ok ? cons.priceUsd : Number(pair.priceUsd);
  const pool = pair.pairAddress;
  if (!price || !pool) return { ok: false, error: "no price or pool" };

  const sigs = await readRpc(cfg.rpc, "getSignaturesForAddress",
    [pool, { limit: scan, commitment: "confirmed" }]);
  if (!sigs.ok) return { ok: false, error: sigs.error };

  const decimals = pair.baseToken?.decimals ?? 6;
  const trades = [];

  for (const s of (sigs.data || []).filter((x) => !x.err)) {
    const tx = await readRpc(cfg.rpc, "getTransaction",
      [s.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!tx.ok || !tx.data?.meta || tx.data.meta.err) continue;
    const m = tx.data.meta;

    const pre = new Map((m.preTokenBalances || []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, b]));
    const post = new Map((m.postTokenBalances || []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, b]));

    for (const [i, p] of post) {
      // The pool is the counterparty to every trade, not a participant in it.
      if (!p.owner || p.owner === pool) continue;
      const before = BigInt(pre.get(i)?.uiTokenAmount?.amount ?? "0");
      const delta = BigInt(p.uiTokenAmount.amount) - before;
      if (delta === 0n) continue;

      const tokens = Math.abs(Number(delta)) / 10 ** decimals;
      const usd = tokens * price;
      if (usd < minUsd) continue;
      trades.push({
        wallet: p.owner,
        side: delta > 0n ? "buy" : "sell",
        usd: Number(usd.toFixed(2)),
        tokens: Number(tokens.toFixed(0)),
        signature: s.signature,
        at: tx.data.blockTime ? tx.data.blockTime * 1000 : null,
      });
    }
  }

  trades.sort((a, b) => b.usd - a.usd);
  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const boughtUsd = buys.reduce((a, t) => a + t.usd, 0);
  const soldUsd = sells.reduce((a, t) => a + t.usd, 0);

  return {
    ok: true, mint, pool, priceUsd: price, scanned: sigs.data.length,
    trades: trades.slice(0, 12),
    buys: buys.length, sells: sells.length,
    boughtUsd: Number(boughtUsd.toFixed(2)),
    soldUsd: Number(soldUsd.toFixed(2)),
    netUsd: Number((boughtUsd - soldUsd).toFixed(2)),
    // distinct wallets matter: one wallet round-tripping is not accumulation
    uniqueBuyers: new Set(buys.map((t) => t.wallet)).size,
    uniqueSellers: new Set(sells.map((t) => t.wallet)).size,
  };
}

/**
 * A ranking signal from whale flow, deliberately conservative.
 *
 * Net dollars alone is easy to fake — one wallet buying and selling itself moves the
 * number without moving conviction. Distinct wallets on the buy side is the harder thing
 * to manufacture, so it carries most of the weight.
 */
export function whaleScore(c) {
  if (!c?.ok) return { score: 0, why: [] };
  const why = [];
  let s = 0;
  if (c.netUsd > 0 && c.uniqueBuyers >= 3) { s += 14; why.push(`${c.uniqueBuyers} separate wallets accumulating`); }
  else if (c.netUsd > 0 && c.uniqueBuyers >= 2) { s += 7; why.push("a couple of wallets accumulating"); }
  if (c.netUsd < 0 && c.uniqueSellers >= 3) { s -= 16; why.push(`${c.uniqueSellers} wallets distributing`); }
  else if (c.netUsd < 0) { s -= 8; why.push("net whale selling"); }
  if (c.buys + c.sells === 0) why.push("no size trading either way");
  if (c.uniqueBuyers === 1 && c.buys > 2) { s -= 6; why.push("one wallet doing all the buying"); }
  return { score: s, why };
}
