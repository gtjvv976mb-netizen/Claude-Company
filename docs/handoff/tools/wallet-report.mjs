#!/usr/bin/env node
/**
 * WALLET REPORT — what HAWK-AI's wallet holds and what moved, read from the chain.
 *
 *   node docs/handoff/tools/wallet-report.mjs <WALLET> [--rpc URL] [--limit N] [--json]
 *
 * Zero dependencies (Node 18+, JSON-RPC over fetch), so it runs from any checkout or any
 * machine that can reach a Solana RPC — it does NOT need executor/node_modules. It answers,
 * without the Mac's log:
 *
 *   - the SOL balance now;
 *   - every token the wallet still holds (a non-zero balance is a position, stuck or not);
 *   - how many EMPTY token accounts are holding rent (executor/reclaim-rent.mjs gets it back);
 *   - the last N transactions, each with the wallet's own SOL change, the fee, the venue it
 *     went through (pump.fun curve, PumpSwap, Jupiter, other), the token that moved, and
 *     whether it failed on chain;
 *   - the net SOL change over that window, and the fees burned by failed transactions.
 *
 * The default RPC is the public endpoint and it rate-limits hard (this script paces itself
 * to about two reads a second there). Pass the owner's private RPC with --rpc or SOLANA_RPC
 * and never paste that URL anywhere: only its hostname is ever printed.
 *
 * Reads only. Never signs, never needs a key.
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const isKey = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s));
const wallet = args.find((a) => isKey(a));
if (!wallet) {
  console.error("usage: node wallet-report.mjs <WALLET> [--rpc URL] [--limit N] [--json]");
  process.exit(2);
}
const RPC = opt("--rpc", process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
const LIMIT = Math.min(1000, Math.max(1, Math.floor(Number(opt("--limit", "50"))) || 50));
const JSON_OUT = args.includes("--json");
const LAMPORTS = 1e9;
const PUBLIC_RPC = /mainnet-beta\.solana\.com/.test(RPC);
const PACE_MS = PUBLIC_RPC ? 450 : 60;

const TOKEN_PROGRAMS = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "token-2022",
};
/* The programs this bot's money has gone through. Anything else reads "other". */
const VENUES = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun curve",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
};
const TOKEN_ACCOUNT_RENT = 2_039_280; // lamports held by a classic 165-byte token account

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-4)}` : "?");
const sol = (n) => (n === null || n === undefined ? "      ?" : (n >= 0 ? "+" : "") + n.toFixed(6));

function summarize(sigRow, tx) {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  const meta = tx.meta ?? {};
  const pre = meta.preBalances?.[i];
  const post = meta.postBalances?.[i];
  const deltaSol = Number.isFinite(pre) && Number.isFinite(post) ? (post - pre) / LAMPORTS : null;
  const feeSol = Number.isFinite(meta.fee) ? meta.fee / LAMPORTS : null;
  const programs = new Set();
  const collect = (ixs) => { for (const ix of ixs ?? []) if (ix?.programId) programs.add(String(ix.programId)); };
  collect(tx.transaction?.message?.instructions);
  for (const inner of meta.innerInstructions ?? []) collect(inner.instructions);
  const venue = [...programs].map((p) => VENUES[p]).find(Boolean) ?? (programs.size ? "other" : "?");
  const owned = (list) => new Map((list ?? []).filter((b) => b.owner === wallet)
    .map((b) => [b.mint, Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0)]));
  const before = owned(meta.preTokenBalances);
  const after = owned(meta.postTokenBalances);
  const tokenMoves = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0);
    if (delta !== 0) tokenMoves.push({ mint, delta });
  }
  const failed = Boolean(meta.err);
  const kind = failed ? "FAILED"
    : tokenMoves.some((m) => m.delta > 0) ? "buy"
    : tokenMoves.some((m) => m.delta < 0) ? "sell"
    : deltaSol !== null && Math.abs(deltaSol) > (feeSol ?? 0) + 1e-9 ? "transfer"
    : "other";
  return {
    signature: sigRow.signature,
    slot: tx.slot ?? sigRow.slot ?? null,
    time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    kind, venue, deltaSol, feeSol, failed, tokenMoves,
  };
}

async function main() {
  const out = { wallet, rpcHost: new URL(RPC).host, readAt: new Date().toISOString() };

  const bal = await rpc("getBalance", [wallet, { commitment: "confirmed" }]);
  out.balanceSol = Number(bal?.value ?? 0) / LAMPORTS;

  const holdings = [];
  const empties = [];
  for (const [programId, program] of Object.entries(TOKEN_PROGRAMS)) {
    const r = await rpc("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const acc of r?.value ?? []) {
      const info = acc.account?.data?.parsed?.info ?? {};
      const amt = info.tokenAmount ?? {};
      const row = {
        account: acc.pubkey, mint: info.mint ?? null, program,
        amountRaw: String(amt.amount ?? "0"),
        uiAmount: Number(amt.uiAmountString ?? amt.uiAmount ?? 0),
        decimals: amt.decimals ?? null,
        rentLamports: Number.isFinite(acc.account?.lamports) ? acc.account.lamports : null,
      };
      (row.amountRaw === "0" ? empties : holdings).push(row);
    }
    await sleep(PACE_MS);
  }
  out.holdings = holdings;
  out.emptyTokenAccounts = empties.length;
  out.rentInEmptyAccountsSol = empties.reduce((a, e) => a + (e.rentLamports ?? TOKEN_ACCOUNT_RENT), 0) / LAMPORTS;

  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: LIMIT, commitment: "confirmed" }]);
  const txs = [];
  for (const s of sigs ?? []) {
    let tx = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !tx; attempt++) {
      try {
        tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      } catch (e) { lastError = e; await sleep(600 * (attempt + 1)); }
    }
    if (!tx) { txs.push({ signature: s.signature, time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, error: `read failed: ${lastError?.message ?? "no transaction"}` }); continue; }
    txs.push(summarize(s, tx));
    await sleep(PACE_MS);
  }
  out.transactions = txs;

  const read = txs.filter((t) => !t.error);
  const sum = (xs, f) => xs.reduce((a, x) => a + (Number.isFinite(f(x)) ? f(x) : 0), 0);
  out.window = {
    transactions: txs.length, unread: txs.length - read.length,
    from: read.length ? read[read.length - 1].time : null, to: read.length ? read[0].time : null,
    netSol: sum(read, (t) => t.deltaSol),
    buys: read.filter((t) => t.kind === "buy").length,
    sells: read.filter((t) => t.kind === "sell").length,
    failed: read.filter((t) => t.failed).length,
    failedFeesSol: sum(read.filter((t) => t.failed), (t) => t.feeSol),
    feesSol: sum(read, (t) => t.feeSol),
  };

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log(`wallet ${wallet}  (rpc ${out.rpcHost}, read ${out.readAt})`);
  console.log(`balance        ${out.balanceSol.toFixed(6)} SOL`);
  console.log(`holdings       ${holdings.length} token${holdings.length === 1 ? "" : "s"} with a balance`);
  for (const h of holdings) console.log(`               ${h.mint}  ${h.uiAmount} (${h.program})`);
  console.log(`empty accounts ${empties.length}, holding ${out.rentInEmptyAccountsSol.toFixed(6)} SOL of rent`
    + (empties.length ? "  → node executor/reclaim-rent.mjs (then --send)" : ""));
  console.log("");
  console.log(`last ${txs.length} transactions (newest first)`);
  console.log("time                 kind      venue           ΔSOL        fee       token                       sig");
  for (const t of txs) {
    if (t.error) { console.log(`${t.time ?? "?".padEnd(20)}  ${t.error}  ${short(t.signature)}`); continue; }
    const tok = t.tokenMoves[0] ? `${short(t.tokenMoves[0].mint)} ${t.tokenMoves[0].delta > 0 ? "+" : ""}${t.tokenMoves[0].delta}` : "";
    console.log(`${(t.time ?? "?").padEnd(20)} ${t.kind.padEnd(9)} ${t.venue.padEnd(15)} ${sol(t.deltaSol).padStart(11)} ${(t.feeSol ?? 0).toFixed(6).padStart(9)} ${tok.padEnd(27)} ${short(t.signature)}`);
  }
  const w = out.window;
  console.log("");
  console.log(`window ${w.from ?? "?"} → ${w.to ?? "?"}: net ${sol(w.netSol)} SOL over ${w.transactions} transactions`
    + ` (${w.buys} buys, ${w.sells} sells, ${w.failed} failed on chain burning ${w.failedFeesSol.toFixed(6)} SOL in fees; all fees ${w.feesSol.toFixed(6)} SOL)`);
  if (w.unread) console.log(`${w.unread} transaction(s) could not be read; re-run with a private --rpc`);
}

main().catch((e) => { console.error(`wallet-report: ${e.message ?? e}`); process.exit(1); });
