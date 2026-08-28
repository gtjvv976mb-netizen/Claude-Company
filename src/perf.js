import db, { ensureColumn } from "./lib/store.js";
import { readRpc } from "./lib/http.js";
import { cfg } from "./config.js";
import { isAddress } from "./lib/base58.js";
import { emit } from "./lib/bus.js";
import { DECIMALS } from "./leasing.js";
// fills references calls(id), so that table must exist before this module's DDL runs.
// Importing for the side effect is the dependency, and stating it here keeps it honest.
import "./calls.js";

/**
 * PERFORMANCE — did the tenant actually take the call, and what did it make them?
 *
 * Read-only, always. Solana is public, so the desk can follow a floor owner's own
 * wallet and see the fills without ever holding a key, a coin, or a permission. Nothing
 * here can move anything: it reads balance deltas out of confirmed transactions and
 * writes rows to a local database.
 *
 * This exists because a track record the desk computes from chain data is worth
 * something, and one the desk asks its customers to self-report is worth nothing.
 */

export const FEE_PCT = Number(process.env.PERF_FEE_PCT || 10);
export const MINT = process.env.CLAUDECO_MINT || "HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

db.exec(`
CREATE TABLE IF NOT EXISTS fills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL,
  call_id     INTEGER REFERENCES calls(id),
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,
  side        TEXT NOT NULL,          -- buy | sell
  token_units TEXT NOT NULL,          -- base units of the token that moved
  quote_usd   REAL,                   -- what it cost or returned, best effort
  signature   TEXT NOT NULL,
  slot        INTEGER,
  block_time  INTEGER,
  seen_at     INTEGER NOT NULL,
  UNIQUE (signature, mint, side)
);
CREATE INDEX IF NOT EXISTS idx_fills_floor ON fills(floor_no, id DESC);
CREATE INDEX IF NOT EXISTS idx_fills_call ON fills(call_id);

-- One settled result per (floor, call). Written only when a position is fully closed,
-- because an unrealised gain is not a result and must never be billed as one.
CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no     INTEGER NOT NULL,
  call_id      INTEGER NOT NULL REFERENCES calls(id),
  wallet       TEXT NOT NULL,
  bought_usd   REAL NOT NULL,
  sold_usd     REAL NOT NULL,
  pnl_usd      REAL NOT NULL,
  fee_pct      REAL NOT NULL,
  fee_usd      REAL NOT NULL DEFAULT 0,
  fee_claudeco TEXT,                  -- base units owed, only ever on a gain
  fee_paid     INTEGER NOT NULL DEFAULT 0,
  token_usd    REAL,                  -- the CLAUDECO price the fee was converted at
  settled_at   INTEGER NOT NULL,
  UNIQUE (floor_no, call_id)
);
`);

ensureColumn("results", "fee_usd", "REAL NOT NULL DEFAULT 0");
ensureColumn("results", "fee_paid", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("results", "token_usd", "REAL");

/** The wallet's token account for a mint, if it has ever held one. */
async function tokenAccountOf(wallet, mint) {
  const r = await readRpc(cfg.rpc, "getTokenAccountsByOwner",
    [wallet, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  if (!r.ok) return { ok: false, error: r.error };
  const acct = r.data?.value?.[0]?.pubkey;
  return acct ? { ok: true, account: acct } : { ok: false, error: "no token account" };
}

/**
 * Read one transaction as a fill. The token side is unambiguous — the owner's balance in
 * that mint went up or down. The dollar side is best-effort: SOL and USDC deltas are
 * netted, and where neither moved the value is left null rather than invented.
 */
function readFill(tx, wallet, mint, solPriceUsd) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;

  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const amountFor = (list, m) => list
    .filter((b) => b.mint === m && b.owner === wallet)
    .reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);

  const tokenDelta = amountFor(post, mint) - amountFor(pre, mint);
  if (tokenDelta === 0n) return null;

  // what the wallet paid or received, in dollars
  const usdcDelta = Number(amountFor(post, USDC) - amountFor(pre, USDC)) / 1e6;
  const wsolDelta = Number(amountFor(post, SOL) - amountFor(pre, SOL)) / 1e9;

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const idx = keys.indexOf(wallet);
  const lamportDelta = idx >= 0 && meta.preBalances && meta.postBalances
    ? (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9 : 0;
  // the fee is the wallet's own, and is not part of the trade's economics
  const solMoved = wsolDelta + (idx === 0 ? lamportDelta + (meta.fee ?? 0) / 1e9 : lamportDelta);

  let quoteUsd = null;
  if (Math.abs(usdcDelta) > 0.000001) quoteUsd = Math.abs(usdcDelta);
  else if (Math.abs(solMoved) > 0.000001 && solPriceUsd) quoteUsd = Math.abs(solMoved) * solPriceUsd;

  // A genuine trade moves tokens AND meaningful value the other way. A plain transfer
  // moves only tokens — the counter-movement is dust, rent or a fee. Reading a transfer
  // as a sale is not a rounding error: it would bill a performance fee on money that was
  // never made. The tenant's own payment to the treasury is exactly this shape.
  const TRADE_FLOOR_USD = 0.5;
  const isTrade = quoteUsd != null && quoteUsd >= TRADE_FLOOR_USD;
  const side = tokenDelta > 0n
    ? (isTrade ? "buy" : "transfer_in")
    : (isTrade ? "sell" : "transfer_out");

  return {
    side,
    tokenUnits: (tokenDelta > 0n ? tokenDelta : -tokenDelta).toString(),
    quoteUsd: isTrade ? Number(quoteUsd.toFixed(4)) : null,
  };
}

/** What one CLAUDECO is worth right now — the rate a fee is converted at. */
export async function tokenPriceUsd() {
  const { price } = await import("./data/jupiter.js");
  const p = await price([MINT]);
  return p?.[MINT]?.usdPrice ?? null;
}

async function solPrice() {
  const { price } = await import("./data/jupiter.js");
  const p = await price([SOL]);
  return p?.[SOL]?.usdPrice ?? null;
}

/**
 * Follow one wallet's activity in one mint and record any fills found.
 * Purely observational: it asks the chain what already happened.
 */
export async function scanFills({ floorNo, callId, wallet, mint, limit = 40 }) {
  if (!isAddress(wallet) || !isAddress(mint)) return { ok: false, error: "bad address" };
  const ta = await tokenAccountOf(wallet, mint);
  if (!ta.ok) return { ok: true, fills: 0, note: ta.error };   // never held it: not an error

  const sigs = await readRpc(cfg.rpc, "getSignaturesForAddress",
    [ta.account, { limit, commitment: "finalized" }]);
  if (!sigs.ok) return { ok: false, error: sigs.error };

  const solUsd = await solPrice();
  let found = 0;

  for (const s of (sigs.data || []).filter((x) => !x.err).reverse()) {
    const already = db.prepare("SELECT 1 FROM fills WHERE signature=? AND mint=? LIMIT 1").get(s.signature, mint);
    if (already) continue;
    const tx = await readRpc(cfg.rpc, "getTransaction",
      [s.signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!tx.ok || !tx.data) continue;

    const fill = readFill(tx.data, wallet, mint, solUsd);
    if (!fill) continue;
    try {
      db.prepare(`INSERT INTO fills (floor_no,call_id,wallet,mint,side,token_units,quote_usd,signature,slot,block_time,seen_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(floorNo, callId ?? null, wallet, mint, fill.side, fill.tokenUnits, fill.quoteUsd,
             s.signature, tx.data.slot ?? null, tx.data.blockTime ?? null, Date.now());
      found++;
      emit("fill", { floorNo, callId, side: fill.side, quoteUsd: fill.quoteUsd, mint });
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  return { ok: true, fills: found };
}

/**
 * Settle a call for a floor. A result is only written once the position is fully closed:
 * an unrealised gain is not a result, and must never be billed as one.
 */
export async function settle({ floorNo, callId, wallet }) {
  const fills = db.prepare("SELECT * FROM fills WHERE floor_no=? AND call_id=? ORDER BY id").all(floorNo, callId);
  if (!fills.length) return { ok: false, error: "no fills" };

  // Transfers are recorded for the audit trail but are not trades and cannot be billed.
  const bought = fills.filter((f) => f.side === "buy");
  const sold = fills.filter((f) => f.side === "sell");
  const transfers = fills.filter((f) => f.side.startsWith("transfer"));
  const boughtUnits = bought.reduce((a, f) => a + BigInt(f.token_units), 0n);
  const soldUnits = sold.reduce((a, f) => a + BigInt(f.token_units), 0n);
  if (!bought.length || soldUnits < boughtUnits) return { ok: false, error: "position still open" };

  const boughtUsd = bought.reduce((a, f) => a + (f.quote_usd ?? 0), 0);
  const soldUsd = sold.reduce((a, f) => a + (f.quote_usd ?? 0), 0);
  if (!boughtUsd || !soldUsd) return { ok: false, error: "no priced fills — cannot compute a result honestly" };

  const pnl = Number((soldUsd - boughtUsd).toFixed(4));
  // A fee is charged on gains only. A losing call costs the tenant nothing.
  const feeUsd = pnl > 0 ? (pnl * FEE_PCT) / 100 : 0;

  // Convert the fee to CLAUDECO at the live rate and settle it against the same credit
  // balance the tenant already tops up. Priced at settlement, and the rate is recorded,
  // so a later price move cannot retroactively change what was charged.
  let feeUnits = 0n, tokenUsd = null, paid = 0;
  if (feeUsd > 0) {
    tokenUsd = await tokenPriceUsd();
    if (tokenUsd && tokenUsd > 0) {
      feeUnits = BigInt(Math.round((feeUsd / tokenUsd) * 10 ** DECIMALS));
    }
  }

  try {
    db.exec("BEGIN IMMEDIATE");
    const existing = db.prepare("SELECT 1 FROM results WHERE floor_no=? AND call_id=?").get(floorNo, callId);
    if (existing) { db.exec("ROLLBACK"); return { ok: false, error: "already settled" }; }

    if (feeUnits > 0n) {
      const { balanceOf } = await import("./leasing.js");
      if (balanceOf(wallet) >= feeUnits) {
        db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
          .run(wallet, feeUnits.toString(), Date.now());
        paid = 1;
      }
      // If the balance will not cover it the fee stands as owed. It is never written as
      // a negative balance, and it never blocks an exit call — see feesOwed().
    }

    db.prepare(`INSERT INTO results (floor_no,call_id,wallet,bought_usd,sold_usd,pnl_usd,fee_pct,fee_usd,fee_claudeco,fee_paid,token_usd,settled_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(floorNo, callId, wallet, boughtUsd, soldUsd, pnl, FEE_PCT,
           Number(feeUsd.toFixed(4)), feeUnits.toString(), paid, tokenUsd, Date.now());
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (!/UNIQUE/i.test(String(e.message))) throw e;
    return { ok: false, error: "already settled" };
  }

  emit("result", { floorNo, callId, pnlUsd: pnl, feeUsd: Number(feeUsd.toFixed(4)),
    feeClaudeco: feeUnits.toString(), paid: Boolean(paid) });
  return { ok: true, boughtUsd, soldUsd, pnlUsd: pnl, feeUsd: Number(feeUsd.toFixed(4)),
           feeClaudeco: feeUnits.toString(), paid: Boolean(paid), tokenUsd,
           transfersIgnored: transfers.length };
}

/**
 * Fees settled but not covered by the balance at the time.
 *
 * An unpaid fee may gate NEW research. It must never gate an exit call: holding
 * someone in a position over a billing dispute would be indefensible, and the desk
 * publishes exits to everyone regardless of what they owe.
 */
export function feesOwed(wallet) {
  const rows = db.prepare("SELECT fee_claudeco, fee_usd FROM results WHERE wallet=? AND fee_paid=0 AND fee_usd>0").all(wallet);
  return {
    count: rows.length,
    baseUnits: rows.reduce((a, r) => a + BigInt(r.fee_claudeco || "0"), 0n).toString(),
    usd: Number(rows.reduce((a, r) => a + r.fee_usd, 0).toFixed(2)),
  };
}

/** Try again on fees that could not be covered when they settled. */
export async function collectOwed(wallet) {
  const { balanceOf } = await import("./leasing.js");
  const rows = db.prepare("SELECT id, fee_claudeco FROM results WHERE wallet=? AND fee_paid=0 AND fee_usd>0 ORDER BY id").all(wallet);
  let collected = 0;
  for (const r of rows) {
    const units = BigInt(r.fee_claudeco || "0");
    if (units <= 0n || balanceOf(wallet) < units) continue;
    db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)").run(wallet, units.toString(), Date.now());
    db.prepare("UPDATE results SET fee_paid=1 WHERE id=?").run(r.id);
    collected++;
  }
  return { collected, stillOwed: feesOwed(wallet) };
}

export function recordFor(floorNo) {
  const rows = db.prepare("SELECT * FROM results WHERE floor_no=? ORDER BY id DESC").all(floorNo);
  const wins = rows.filter((r) => r.pnl_usd > 0).length;
  const net = rows.reduce((a, r) => a + r.pnl_usd, 0);
  const fees = rows.reduce((a, r) => a + (r.fee_usd ?? 0), 0);
  const unpaid = rows.filter((r) => r.fee_usd > 0 && !r.fee_paid);
  return {
    settled: rows.length,
    wins, losses: rows.length - wins,
    winRate: rows.length ? Math.round((wins / rows.length) * 100) : null,
    netPnlUsd: Number(net.toFixed(2)),
    feesChargedUsd: Number(fees.toFixed(2)),
    feesUnpaidUsd: Number(unpaid.reduce((a, r) => a + r.fee_usd, 0).toFixed(2)),
    feePct: FEE_PCT,
    results: rows.slice(0, 20),
  };
}

/** The house record across every floor — computed from chain data, not self-reported. */
export function houseRecord() {
  const rows = db.prepare("SELECT pnl_usd FROM results").all();
  const wins = rows.filter((r) => r.pnl_usd > 0).length;
  return {
    settled: rows.length, wins, losses: rows.length - wins,
    winRate: rows.length ? Math.round((wins / rows.length) * 100) : null,
    netPnlUsd: Number(rows.reduce((a, r) => a + r.pnl_usd, 0).toFixed(2)),
  };
}
