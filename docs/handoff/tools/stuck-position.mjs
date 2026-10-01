#!/usr/bin/env node
/**
 * STUCK POSITION — why a coin HAWK-AI holds cannot be sold by the bot, and what it is worth.
 *
 *   node docs/handoff/tools/stuck-position.mjs <MINT> [--wallet WALLET] [--rpc URL] [--json]
 *
 * Zero dependencies (Node 18+). Reads three public sources and says what they mean:
 *
 *   pump.fun's coin record    is the curve complete? which pool did it graduate to? market cap?
 *   DexScreener's pairs       where it trades now and at what price
 *   the wallet (--wallet)     how much of it the wallet holds, and what that is worth
 *
 * Then the verdict, in the bot's own terms:
 *
 *   ON THE CURVE  → the lane can sell it itself (executor/snipe-execute.mjs, sell_v2). If the
 *                   sell keeps failing anyway, the heartbeat's snipe.counts.exitFailures climbs
 *                   once per tick and the Mac's log names the clause.
 *   GRADUATED     → NO bot path exists. snipe-execute.mjs refuses a completed curve ("the curve
 *                   has graduated — the position must leave through a pool route, which this
 *                   path does not build"), and the executor builds no PumpSwap route. The
 *                   launch lane keeps the position and retries every tick for ever; the trend
 *                   lane (snipe-trend-live.mjs) retries on a 2s–30s backoff. Either way the
 *                   coin is sold by hand or left where it is.
 *
 * Reads only. Never signs. Never needs a key.
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const isKey = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s));
const mint = args.find((a, i) => isKey(a) && args[i - 1] !== "--wallet");
const wallet = opt("--wallet", null);
if (!mint || (wallet && !isKey(wallet))) {
  console.error("usage: node stuck-position.mjs <MINT> [--wallet WALLET] [--rpc URL] [--json]");
  process.exit(2);
}
const RPC = opt("--rpc", process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
const JSON_OUT = args.includes("--json");
const PUMPFUN = "https://frontend-api-v3.pump.fun";
const DEXSCREENER = "https://api.dexscreener.com";

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function main() {
  const out = { mint, readAt: new Date().toISOString() };

  /* 1. pump.fun's own record. `complete` is the curve's flag; the pool fields say where it went. */
  const pf = await getJson(`${PUMPFUN}/coins/${mint}`);
  if (pf.error) out.pumpfun = { error: pf.error };
  else {
    const c = pf.data ?? {};
    out.pumpfun = {
      name: c.name ?? null, symbol: c.symbol ?? null, creator: c.creator ?? null,
      createdAt: num(c.created_timestamp) ? new Date(Number(c.created_timestamp)).toISOString() : null,
      complete: typeof c.complete === "boolean" ? c.complete : null,
      pumpSwapPool: c.pump_swap_pool ?? null,
      raydiumPool: c.raydium_pool ?? null,
      usdMarketCap: num(c.usd_market_cap),
      bondingCurve: c.bonding_curve ?? null,
    };
  }

  /* 2. Where it trades now. pumpfun pairs are the curve; anything else is a pool. */
  const ds = await getJson(`${DEXSCREENER}/latest/dex/tokens/${mint}`);
  if (ds.error) out.pairs = { error: ds.error };
  else {
    out.pairs = (ds.data?.pairs ?? []).map((p) => ({
      dex: p.dexId ?? null, pair: p.pairAddress ?? null,
      quote: p.quoteToken?.symbol ?? null,
      priceUsd: num(p.priceUsd), priceNative: num(p.priceNative),
      liquidityUsd: num(p.liquidity?.usd), volume24hUsd: num(p.volume?.h24),
    })).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  }
  const pairs = Array.isArray(out.pairs) ? out.pairs : [];
  const best = pairs[0] ?? null;

  /* 3. What the wallet holds of it. Both token programs, because pump.fun has used both. */
  if (wallet) {
    try {
      const r = await rpc("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const accounts = (r?.value ?? []).map((a) => {
        const amt = a.account?.data?.parsed?.info?.tokenAmount ?? {};
        return { account: a.pubkey, amountRaw: String(amt.amount ?? "0"), uiAmount: Number(amt.uiAmountString ?? amt.uiAmount ?? 0), decimals: amt.decimals ?? null };
      });
      const uiAmount = accounts.reduce((s, a) => s + a.uiAmount, 0);
      out.wallet = {
        address: wallet, accounts, uiAmount,
        valueUsd: best?.priceUsd !== null && best ? Math.round(uiAmount * best.priceUsd * 100) / 100 : null,
        valueSol: best?.priceNative !== null && best ? Math.round(uiAmount * best.priceNative * 1e6) / 1e6 : null,
      };
    } catch (e) { out.wallet = { address: wallet, error: String(e?.message ?? e) }; }
  }

  /* 4. The verdict. Graduation is read from pump.fun first; a non-pumpfun pair is the second witness. */
  const pfc = out.pumpfun?.complete;
  const poolPair = pairs.find((p) => p.dex && p.dex !== "pumpfun");
  const graduated = pfc === true || Boolean(out.pumpfun?.pumpSwapPool) || Boolean(out.pumpfun?.raydiumPool) || Boolean(poolPair);
  const onCurve = pfc === false && !poolPair;
  out.verdict = graduated
    ? { state: "graduated",
        soldBy: "nobody in this executor: snipe-execute.mjs refuses a completed curve and no pool route exists. Sell by hand or leave it.",
        tradesOn: poolPair ? `${poolPair.dex} pair ${poolPair.pair}` : (out.pumpfun?.pumpSwapPool ? `PumpSwap pool ${out.pumpfun.pumpSwapPool}` : "a pool pump.fun has not named yet") }
    : onCurve
    ? { state: "on the curve",
        soldBy: "the lane itself (sell_v2). A sell that still fails every tick has another cause — read the clause in the Mac log, or lastError on the heartbeat." }
    : { state: "unknown", soldBy: "pump.fun and DexScreener disagreed or did not answer; re-run, or read the curve account on chain." };

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }

  const p = out.pumpfun ?? {};
  console.log(`mint        ${mint}`);
  console.log(`pump.fun    ${p.error ? `unreachable (${p.error})` : `${p.name ?? "?"} (${p.symbol ?? "?"}), created ${p.createdAt ?? "?"}, complete=${p.complete}, cap $${p.usdMarketCap === null ? "?" : Math.round(p.usdMarketCap).toLocaleString("en-US")}`}`);
  if (!p.error && (p.pumpSwapPool || p.raydiumPool)) console.log(`            pool: ${p.pumpSwapPool ? `PumpSwap ${p.pumpSwapPool}` : ""}${p.raydiumPool ? ` Raydium ${p.raydiumPool}` : ""}`);
  if (out.pairs?.error) console.log(`dexscreener unreachable (${out.pairs.error})`);
  else if (!pairs.length) console.log("dexscreener no pairs listed");
  for (const q of pairs.slice(0, 4)) {
    console.log(`pair        ${(q.dex ?? "?").padEnd(10)} ${q.pair ?? "?"}  $${q.priceUsd ?? "?"} (${q.priceNative ?? "?"} ${q.quote ?? "SOL"})  liq $${q.liquidityUsd === null ? "?" : Math.round(q.liquidityUsd).toLocaleString("en-US")}  24h vol $${q.volume24hUsd === null ? "?" : Math.round(q.volume24hUsd).toLocaleString("en-US")}`);
  }
  if (out.wallet) {
    const w = out.wallet;
    console.log(`wallet      ${w.error ? `read failed (${w.error})` : `${w.address} holds ${w.uiAmount} ${p.symbol ?? ""} ≈ $${w.valueUsd ?? "?"} ≈ ${w.valueSol ?? "?"} SOL`}`);
  }
  console.log("");
  console.log(`VERDICT     ${out.verdict.state.toUpperCase()}${out.verdict.tradesOn ? ` — trades on ${out.verdict.tradesOn}` : ""}`);
  console.log(`            sold by: ${out.verdict.soldBy}`);
  if (graduated) {
    console.log("");
    console.log("by hand means: the key is ~/claudeco-executor/burner.json on the Mac. Either import it into a wallet");
    console.log("app and sell on pump.fun's coin page (it routes graduated coins through PumpSwap) or on Jupiter —");
    console.log("knowing that a key loaded into a browser extension is no longer only the bot's — or leave the coin");
    console.log("where it is when its value is below the care it would take. Either way, the bot cannot do it.");
  }
}

main().catch((e) => { console.error(`stuck-position: ${e.message ?? e}`); process.exit(1); });
