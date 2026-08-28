import { readRpc } from "./lib/http.js";
import db from "./lib/store.js";
import { cfg } from "./config.js";
import { emit } from "./lib/bus.js";
import { MINT, TREASURY } from "./leasing.js";

/**
 * The treasury scanner: the ONLY writer of credit rows.
 *
 * Nothing a user can call performs an RPC request. That is deliberate — an earlier
 * design let anyone submit a signature for verification, which meant a free keypair and
 * a random string could force archival lookups, exhaust the RPC plan, and close the sale
 * for everybody. Here RPC volume is a function of treasury traffic, not HTTP traffic.
 *
 * Credit goes to the owner of the DEBITED token account, never the signer or fee payer:
 * a relayer or an SPL delegate paying on someone's behalf must credit that someone.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS scanner_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

const getState = (k) => db.prepare("SELECT value FROM scanner_state WHERE key=?").get(k)?.value ?? null;
const setState = (k, v) => db.prepare("INSERT INTO scanner_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/** The treasury's token account for the mint, found by RPC so no PDA math is needed. */
async function treasuryTokenAccount() {
  const cached = getState("treasury_token_account");
  if (cached) return cached;
  const r = await readRpc(cfg.rpc, "getTokenAccountsByOwner",
    [TREASURY, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
  if (!r.ok) throw new Error(`getTokenAccountsByOwner: ${r.error}`);
  const acct = r.data?.value?.[0]?.pubkey;
  if (!acct) throw new Error("treasury holds no token account for this mint yet — receive 1 token to create it");
  setState("treasury_token_account", acct);
  return acct;
}

/** Pull the credit-relevant facts out of one confirmed transaction. */
function readTransfer(tx, tokenAccount) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;                       // failed transactions credit nobody

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const idxOf = (i) => keys[i];

  const pre = new Map((meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
  const post = new Map((meta.postTokenBalances || []).map((b) => [b.accountIndex, b]));

  let received = 0n, payer = null, biggestDebit = 0n;
  for (const [idx, p] of post) {
    if (p.mint !== MINT) continue;
    const before = BigInt(pre.get(idx)?.uiTokenAmount?.amount ?? "0");
    const after = BigInt(p.uiTokenAmount.amount);
    const delta = after - before;
    if (idxOf(idx) === tokenAccount && delta > 0n) received += delta;
  }
  if (received <= 0n) return null;

  // whoever's balance fell the most, for this mint, is who paid
  for (const [idx, p] of pre) {
    if (p.mint !== MINT) continue;
    const before = BigInt(p.uiTokenAmount.amount);
    const after = BigInt(post.get(idx)?.uiTokenAmount?.amount ?? "0");
    const debit = before - after;
    if (debit > biggestDebit) { biggestDebit = debit; payer = p.owner ?? null; }
  }
  if (!payer) return null;

  return { received, payer };
}

export async function scanOnce({ limit = 40 } = {}) {
  if (!TREASURY) return { ok: false, error: "TREASURY_OWNER not set" };

  const tokenAccount = await treasuryTokenAccount();
  const until = getState("last_signature") || undefined;

  const sigs = await readRpc(cfg.rpc, "getSignaturesForAddress",
    [tokenAccount, { limit, ...(until ? { until } : {}) }, { commitment: "finalized" }]);
  if (!sigs.ok) return { ok: false, error: sigs.error };

  const list = (sigs.data || []).filter((s) => !s.err).reverse();   // oldest first
  let credited = 0;

  for (const s of list) {
    const already = db.prepare("SELECT 1 FROM credits WHERE signature=? LIMIT 1").get(s.signature);
    if (already) continue;

    const tx = await readRpc(cfg.rpc, "getTransaction",
      [s.signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!tx.ok || !tx.data) continue;

    const found = readTransfer(tx.data, tokenAccount);
    if (!found) continue;

    try {
      db.prepare(`INSERT INTO credits (signature,dest_account,wallet,base_units,slot,block_time,seen_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(s.signature, tokenAccount, found.payer, found.received.toString(),
             tx.data.slot ?? null, tx.data.blockTime ?? null, Date.now());
      credited++;
      emit("credit", { wallet: found.payer, baseUnits: found.received.toString(), signature: s.signature });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;    // duplicate = already credited
    }
  }

  if (list.length) setState("last_signature", list[list.length - 1].signature);
  return { ok: true, scanned: list.length, credited };
}

let timer = null;
export function startScanner({ intervalMs = 20000 } = {}) {
  if (!TREASURY) { console.log("[scanner] TREASURY_OWNER not set — leasing is closed"); return; }
  if (timer) return;
  const tick = async () => {
    try {
      const r = await scanOnce();
      if (r.ok && r.credited) console.log(`[scanner] credited ${r.credited} payment(s)`);
      if (!r.ok) console.log(`[scanner] ${r.error}`);
    } catch (e) { console.log(`[scanner] ${e.message}`); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  console.log(`[scanner] watching treasury ${TREASURY.slice(0, 6)}… every ${intervalMs / 1000}s`);
}
export function stopScanner() { if (timer) clearInterval(timer); timer = null; }
