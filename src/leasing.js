import db from "./lib/store.js";
import { isAddress } from "./lib/base58.js";
import { FLOORS, HQ_FLOOR } from "./tower.js";

/**
 * Floor leasing, paid in $CLAUDECO.
 *
 * Two facts are kept strictly separate, because they cannot be made atomic:
 *
 *   1. MONEY ARRIVED — a verified inbound $CLAUDECO transfer to the treasury becomes a
 *      wallet-scoped credit, in base units, written ONLY by the treasury scanner.
 *   2. A FLOOR WAS TAKEN — spending 50 CLAUDECO-worth of credit on a vacant floor. Pure
 *      database transaction, no RPC, instant.
 *
 * That separation is what removes the attacks an earlier reservation-based design had:
 * there is no reservation to squat, so the cheapest way to deny a floor is to buy it;
 * and a dust payment produces a dust credit and touches no floor at all.
 */

export const MINT = process.env.CLAUDECO_MINT || "HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump";
export const DECIMALS = Number(process.env.CLAUDECO_DECIMALS || 6);
/** Price in whole tokens; base units = price * 10^decimals. */
export const PRICE_TOKENS = Number(process.env.FLOOR_PRICE_CLAUDECO || 1_000_000);
export const PRICE_BASE_UNITS = BigInt(Math.round(PRICE_TOKENS)) * 10n ** BigInt(DECIMALS);
export const TREASURY = process.env.TREASURY_OWNER || "";

db.exec(`
-- One credit row per (transaction, destination token account). Keyed that way so a single
-- transaction carrying two transfers is two credits, not one silently-dropped one.
CREATE TABLE IF NOT EXISTS credits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  signature     TEXT NOT NULL,
  dest_account  TEXT NOT NULL,
  wallet        TEXT NOT NULL,        -- owner of the DEBITED account: who actually paid
  base_units    TEXT NOT NULL,        -- decimal string; JS numbers cannot hold these safely
  slot          INTEGER,
  block_time    INTEGER,
  seen_at       INTEGER NOT NULL,
  UNIQUE (signature, dest_account)    -- replay of the same transfer is impossible
);
CREATE INDEX IF NOT EXISTS idx_credits_wallet ON credits(wallet);

CREATE TABLE IF NOT EXISTS leases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL UNIQUE REFERENCES floors(n),
  wallet      TEXT NOT NULL,
  base_units  TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
-- ONE FLOOR PER WALLET, enforced by the database. Application-level checks lose races.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_one_per_wallet ON leases(wallet);

CREATE TABLE IF NOT EXISTS spends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT NOT NULL,
  base_units TEXT NOT NULL,
  lease_id   INTEGER REFERENCES leases(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spends_wallet ON spends(wallet);
`);

const sum = (rows) => rows.reduce((t, r) => t + BigInt(r.base_units), 0n);

/** Credited minus spent, in base units. */
export function balanceOf(wallet) {
  const credited = sum(db.prepare("SELECT base_units FROM credits WHERE wallet = ?").all(wallet));
  const spent = sum(db.prepare("SELECT base_units FROM spends WHERE wallet = ?").all(wallet));
  return credited - spent;
}

export function creditsFor(wallet) {
  return db.prepare(
    "SELECT signature, base_units, slot, block_time FROM credits WHERE wallet = ? ORDER BY id DESC LIMIT 25"
  ).all(wallet);
}

export function leaseOf(wallet) {
  return db.prepare("SELECT * FROM leases WHERE wallet = ?").get(wallet) || null;
}

export function leaseFor(floorNo) {
  return db.prepare("SELECT * FROM leases WHERE floor_no = ?").get(floorNo) || null;
}

/**
 * Take a floor. Everything below happens inside one transaction so two concurrent
 * requests cannot both win — the unique indexes are the referee, not the if-statements.
 */
export function allocate({ wallet, floorNo, name = null }) {
  if (!isAddress(wallet)) return { ok: false, error: "bad wallet" };
  floorNo = Number(floorNo);
  if (!Number.isInteger(floorNo) || floorNo < 1 || floorNo > FLOORS) {
    return { ok: false, error: "no such floor" };
  }
  if (floorNo === HQ_FLOOR) return { ok: false, error: "the penthouse is not for lease" };

  try {
    db.exec("BEGIN IMMEDIATE");

    if (leaseOf(wallet)) { db.exec("ROLLBACK"); return { ok: false, error: "this wallet already holds a floor" }; }

    const floor = db.prepare("SELECT * FROM floors WHERE n = ?").get(floorNo);
    if (!floor) { db.exec("ROLLBACK"); return { ok: false, error: "no such floor" }; }
    if (floor.state !== "vacant") { db.exec("ROLLBACK"); return { ok: false, error: "that floor is taken" }; }

    const bal = balanceOf(wallet);
    if (bal < PRICE_BASE_UNITS) {
      db.exec("ROLLBACK");
      return {
        ok: false, error: "not enough $CLAUDECO credited yet",
        needBaseUnits: PRICE_BASE_UNITS.toString(), haveBaseUnits: bal.toString(),
      };
    }

    const lease = db.prepare(
      "INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)"
    ).run(floorNo, wallet, PRICE_BASE_UNITS.toString(), name, Date.now());

    db.prepare("INSERT INTO spends (wallet, base_units, lease_id, created_at) VALUES (?,?,?,?)")
      .run(wallet, PRICE_BASE_UNITS.toString(), lease.lastInsertRowid, Date.now());

    db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=? AND state='vacant'")
      .run(wallet, name, Date.now(), floorNo);

    db.exec("COMMIT");
    return { ok: true, floorNo, wallet, leaseId: lease.lastInsertRowid };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    // A unique-index violation here is the race losing, not a bug.
    if (/UNIQUE/i.test(String(e.message))) {
      return { ok: false, error: "already taken — that floor or that wallet was claimed a moment ago" };
    }
    return { ok: false, error: String(e.message) };
  }
}

export function config() {
  return {
    mint: MINT, decimals: DECIMALS,
    priceTokens: PRICE_TOKENS, priceBaseUnits: PRICE_BASE_UNITS.toString(),
    treasury: TREASURY || null,
    oneFloorPerWallet: true,
    ready: Boolean(TREASURY),
  };
}
