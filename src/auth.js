import crypto from "node:crypto";
import { decode, isAddress } from "./lib/base58.js";
import db from "./lib/store.js";

/**
 * Wallet sign-in. The user proves they control an address by signing a plain text
 * message — never a transaction. A message signature cannot move funds, so there is
 * nothing to lose by signing it, and nothing for this server to abuse by asking.
 *
 * The nonce is single-use and short-lived: without that, one captured signature would
 * be a permanent bearer token for that wallet.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet);
`);

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const SIGN_IN_PREFIX = "Claude Company — sign in";

export function issueNonce(wallet) {
  if (!isAddress(wallet)) throw new Error("not a Solana address");
  const nonce = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_nonces (nonce, wallet, issued_at) VALUES (?,?,?)")
    .run(nonce, wallet, Date.now());
  return { nonce, message: buildMessage(wallet, nonce) };
}

export function buildMessage(wallet, nonce) {
  return `${SIGN_IN_PREFIX}\n\nWallet: ${wallet}\nNonce: ${nonce}\n\n` +
    `Signing proves you control this wallet. It is not a transaction and moves no funds.`;
}

/** Raw ed25519 public keys need an SPKI wrapper before node's verifier will take them. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifySignature({ wallet, nonce, signatureB58 }) {
  if (!isAddress(wallet)) return { ok: false, error: "bad wallet" };

  const row = db.prepare("SELECT * FROM auth_nonces WHERE nonce = ?").get(nonce);
  if (!row) return { ok: false, error: "unknown nonce" };
  if (row.used_at) return { ok: false, error: "nonce already used" };
  if (row.wallet !== wallet) return { ok: false, error: "nonce belongs to another wallet" };
  if (Date.now() - row.issued_at > NONCE_TTL_MS) return { ok: false, error: "nonce expired" };

  let sig;
  try { sig = decode(signatureB58); } catch { return { ok: false, error: "bad signature encoding" }; }
  if (sig.length !== 64) return { ok: false, error: "signature must be 64 bytes" };

  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, decode(wallet)]),
    format: "der", type: "spki",
  });
  const message = Buffer.from(buildMessage(wallet, nonce), "utf8");
  // ed25519 takes null as the digest algorithm
  const good = crypto.verify(null, message, key, sig);
  if (!good) return { ok: false, error: "signature does not match" };

  // burn the nonce before minting a session, so a replay races against nothing
  const burned = db.prepare("UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL")
    .run(Date.now(), nonce);
  if (burned.changes !== 1) return { ok: false, error: "nonce already used" };

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, wallet, created_at, expires_at) VALUES (?,?,?,?)")
    .run(token, wallet, now, now + SESSION_TTL_MS);
  return { ok: true, token, wallet, expiresAt: now + SESSION_TTL_MS };
}

export function walletFor(token) {
  if (!token) return null;
  const s = db.prepare("SELECT wallet, expires_at FROM sessions WHERE token = ?").get(token);
  if (!s || s.expires_at < Date.now()) return null;
  // SLIDING renewal: a session that is being USED never expires under its user.
  // The old fixed 7-day window signed people out mid-life — they came back to a
  // zeroed masthead and locked tabs with no way back but the tower. Renew at
  // most once a day to keep this lookup write-light.
  const now = Date.now();
  if (s.expires_at - now < SESSION_TTL_MS - 24 * 3600 * 1000)
    db.prepare("UPDATE sessions SET expires_at=? WHERE token=?").run(now + SESSION_TTL_MS, token);
  return s.wallet;
}

export function signOut(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
