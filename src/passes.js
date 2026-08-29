/**
 * GUEST PASSES — paid admission to another tenant's floor.
 *
 * A tenant's floor is private, but privacy here is a market, not a wall: anyone
 * who already holds a lease may buy their way into another tenant's gallery by
 * paying that tenant directly — 250,000 $CLAUDECO, wallet to wallet, none of it
 * touching the treasury. The building takes no cut; the tenant's alpha earns
 * the tenant's rent.
 *
 * The payment is a plain on-chain transfer the buyer makes in their own wallet.
 * We only verify it: the named transaction must move enough $CLAUDECO from the
 * buyer to the floor owner's wallet, must have succeeded, and must not have
 * been used to buy a pass before. Verification is read-only, like everything
 * else this desk does on chain.
 */
import db from "./lib/store.js";
import { readRpc } from "./lib/http.js";
import { cfg } from "./config.js";
import { MINT, DECIMALS, leaseFor } from "./leasing.js";

export const PASS_TOKENS = Number(process.env.GUEST_PASS_CLAUDECO || 250_000);
export const PASS_DAYS = Number(process.env.GUEST_PASS_DAYS || 30);
const PASS_BASE_UNITS = BigInt(Math.round(PASS_TOKENS)) * 10n ** BigInt(DECIMALS);

db.exec(`
CREATE TABLE IF NOT EXISTS floor_passes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no   INTEGER NOT NULL,
  viewer     TEXT NOT NULL,
  owner      TEXT NOT NULL,
  signature  TEXT NOT NULL UNIQUE,
  base_units TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passes_floor ON floor_passes(floor_no, viewer, expires_at);
`);

/** The viewer's live pass for a floor, if one is current. */
export function passFor(floorNo, viewer) {
  if (!viewer) return null;
  return db.prepare(
    "SELECT * FROM floor_passes WHERE floor_no=? AND viewer=? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .get(floorNo, viewer, Date.now()) || null;
}

/**
 * Verify a payment and grant the pass. The transaction is judged by its token
 * balance deltas — the only part of a transaction that cannot be dressed up:
 * the owner's $CLAUDECO must rise by at least the price, the buyer's must fall.
 */
export async function grantPass({ floorNo, viewer, signature }) {
  const lease = leaseFor(floorNo);
  if (!lease) return { ok: false, error: "that floor has no tenant to pay" };
  if (lease.wallet === viewer) return { ok: false, error: "it is your own floor" };
  if (passFor(floorNo, viewer)) return { ok: false, error: "your pass is still live" };
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(String(signature || "")))
    return { ok: false, error: "that does not look like a transaction signature" };
  const used = db.prepare("SELECT 1 FROM floor_passes WHERE signature=?").get(signature);
  if (used) return { ok: false, error: "that payment already bought a pass" };

  // Finalized, like every other money path: a confirmed-but-reorged payment must
  // not grant 30 days of access and permanently burn its signature as used.
  const res = await readRpc(cfg.rpc, "getTransaction",
    [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
  if (!res?.ok || !res.data) return { ok: false, error: "transaction not found yet — give it a moment" };
  const tx = res.data;
  if (tx.meta?.err) return { ok: false, error: "that transaction failed on chain" };

  // Only a payment made FOR this purchase counts: a months-old transfer between
  // the same two wallets is not pass revenue, and each old transfer would
  // otherwise be one free pass.
  const age = tx.blockTime ? Date.now() - tx.blockTime * 1000 : null;
  if (age == null || age > 30 * 60e3)
    return { ok: false, error: "that payment is too old — send the pass payment now, then paste its signature" };
  if (tx.blockTime * 1000 < lease.created_at)
    return { ok: false, error: "that payment predates the current lease" };

  const deltas = new Map();   // owner wallet -> base-unit delta of MINT
  for (const post of tx.meta?.postTokenBalances ?? []) {
    if (post.mint !== MINT) continue;
    const pre = (tx.meta?.preTokenBalances ?? []).find((p) => p.accountIndex === post.accountIndex);
    const d = BigInt(post.uiTokenAmount?.amount ?? "0") - BigInt(pre?.uiTokenAmount?.amount ?? "0");
    const who = post.owner;
    deltas.set(who, (deltas.get(who) ?? 0n) + d);
  }
  // A closed token account only appears on the pre side; count those too.
  for (const pre of tx.meta?.preTokenBalances ?? []) {
    if (pre.mint !== MINT) continue;
    const hasPost = (tx.meta?.postTokenBalances ?? []).some((p) => p.accountIndex === pre.accountIndex);
    if (!hasPost) deltas.set(pre.owner, (deltas.get(pre.owner) ?? 0n) - BigInt(pre.uiTokenAmount?.amount ?? "0"));
  }

  const ownerGain = deltas.get(lease.wallet) ?? 0n;
  const viewerLoss = deltas.get(viewer) ?? 0n;
  if (ownerGain < PASS_BASE_UNITS)
    return { ok: false, error: `the floor's owner received ${Number(ownerGain) / 10 ** DECIMALS} — a pass costs ${PASS_TOKENS.toLocaleString()}` };
  if (viewerLoss > -PASS_BASE_UNITS)
    return { ok: false, error: "the payment must come from the wallet you signed in with" };

  const now = Date.now();
  const expires = now + PASS_DAYS * 86400e3;
  try {
    db.prepare(`INSERT INTO floor_passes (floor_no, viewer, owner, signature, base_units, granted_at, expires_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(floorNo, viewer, lease.wallet, signature, ownerGain.toString(), now, expires);
  } catch (e) {
    // Double-click race: both requests pass the used-check before either inserts.
    // The loser's UNIQUE violation is "already bought", not a 500.
    if (/UNIQUE/i.test(String(e.message))) return { ok: false, error: "that payment already bought a pass" };
    throw e;
  }
  return { ok: true, pass: passFor(floorNo, viewer), days: PASS_DAYS };
}
