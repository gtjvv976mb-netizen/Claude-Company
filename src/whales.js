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

const configuredWhaleUsd = Number(process.env.WHALE_MIN_USD || 500);
export const WHALE_USD = Number.isFinite(configuredWhaleUsd) && configuredWhaleUsd > 0
  ? configuredWhaleUsd : 500;

/** Recent large trades in one mint, largest first. */
/**
 * THE COST OF THIS FUNCTION, STATED PLAINLY.
 *
 * It reads one transaction at a time, sequentially, and readRpc retries each up to
 * three times with backoff on a 12s timeout. At scan=24 the worst case is roughly
 * fourteen MINUTES for a single coin — and the cycle calls it on nine coins in a row.
 *
 * That is how 21 cycles started and never finished: no cycle:end for 1.7 hours while
 * `cycle:start` kept firing. Nothing was hung in the sense of being stuck forever; it
 * was an unbounded sequential loop doing exactly what it was told, on obscure
 * micro-caps that are the slowest reads of all.
 *
 * `deadline` is therefore not an optimisation. Whale flow ADJUSTS A SCORE and decides
 * nothing, so it must never be able to hold the desk hostage: past the deadline it
 * returns what it has and says how much it skipped.
 */
export async function callouts(mint, {
  scan = 30,
  minUsd = WHALE_USD,
  deadline = null,
  includeEvidence = false,
} = {}) {
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

  let skipped = 0;
  let failedReads = 0;
  for (const s of (sigs.data || []).filter((x) => !x.err)) {
    // Out of time: stop reading and report on what we have. A partial whale read is a
    // slightly worse ranking nudge; an unfinished cycle is no calls at all.
    if (deadline && Date.now() > deadline) { skipped++; continue; }
    const tx = await readRpc(cfg.rpc, "getTransaction",
      [s.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      // One attempt under a deadline: the retries exist for holder concentration, which
      // is decision-relevant. This is a nudge and does not deserve three tries.
      deadline ? { attempts: 1 } : {});
    if (!tx.ok || !tx.data?.meta) { failedReads++; continue; }
    // A successfully read transaction which failed on chain is a known non-trade,
    // not missing coverage.
    if (tx.data.meta.err) continue;
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
      // This is the token delta valued at the current DexScreener mark. The
      // transaction parser does not reconstruct quote-token consideration, so callers
      // must not present this approximation as dollars paid at execution time.
      const usd = tokens * price;
      if (usd < minUsd) continue;
      trades.push({
        wallet: p.owner,
        side: delta > 0n ? "buy" : "sell",
        usd: Number(usd.toFixed(2)),
        currentValueUsd: Number(usd.toFixed(2)),
        evidenceKind: delta > 0n
          ? "pool_token_inflow_current_value"
          : "pool_token_outflow_current_value",
        valueBasis: "token-delta-at-current-market-mark",
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

  const result = {
    ok: true, mint, pool, priceUsd: price, scanned: sigs.data.length,
    // How much of the tape we did NOT read, so a thin sample is never mistaken for a
    // quiet one. A coin with no whales and a coin we ran out of time on look identical
    // in every field but this.
    unread: skipped + failedReads,
    skipped,
    failed: failedReads,
    partial: skipped + failedReads > 0,
    trades: trades.slice(0, 12),
    buys: buys.length, sells: sells.length,
    boughtUsd: Number(boughtUsd.toFixed(2)),
    soldUsd: Number(soldUsd.toFixed(2)),
    netUsd: Number((boughtUsd - soldUsd).toFixed(2)),
    // distinct wallets matter: one wallet round-tripping is not accumulation
    uniqueBuyers: new Set(buys.map((t) => t.wallet)).size,
    uniqueSellers: new Set(sells.map((t) => t.wallet)).size,
  };
  // The canonical Callouts matcher needs every bounded qualifying row, not only the
  // former three-card display preview. Keep it opt-in so the legacy/public per-mint
  // endpoint does not widen its wallet payload.
  if (includeEvidence) result.evidenceTrades = trades;
  return result;
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
