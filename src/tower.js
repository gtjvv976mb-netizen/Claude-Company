import db from "./lib/store.js";

/**
 * CLAUDE TOWER — fifty floors, one desk each.
 * Floor 50 is the headquarters and is never for sale. Floors 1-49 are tenancies.
 *
 * This module owns floor state only. It holds no keys and moves no money: the
 * purchase path is buyer-signed and verified read-only against the chain.
 */
export const FLOORS = 50;
export const HQ_FLOOR = 50;
export const PRICE_USDC = 50;

db.exec(`
CREATE TABLE IF NOT EXISTS floors (
  n INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'vacant',      -- vacant | owned | hq
  owner TEXT,                                 -- wallet address
  name TEXT,                                  -- tenant's name for their desk
  claimed_at INTEGER,
  payment_sig TEXT UNIQUE                     -- one transaction can buy exactly one floor
);
CREATE INDEX IF NOT EXISTS idx_floors_owner ON floors(owner);
`);

// Seed the stack once.
const seeded = db.prepare("SELECT COUNT(*) n FROM floors").get().n;
if (seeded === 0) {
  const ins = db.prepare("INSERT INTO floors (n, state) VALUES (?, ?)");
  for (let n = 1; n <= FLOORS; n++) ins.run(n, n === HQ_FLOOR ? "hq" : "vacant");
}

export function listFloors() {
  return db.prepare("SELECT n, state, owner, name FROM floors ORDER BY n").all();
}

export function getFloor(n) {
  return db.prepare("SELECT * FROM floors WHERE n = ?").get(n) || null;
}

export function summary() {
  const rows = listFloors();
  return {
    floors: rows,
    total: FLOORS,
    hq: HQ_FLOOR,
    priceUsdc: PRICE_USDC,
    taken: rows.filter((f) => f.state !== "vacant").length,
    available: rows.filter((f) => f.state === "vacant").length,
  };
}

/** Set the HQ tenant's display name / owner wallet (the building owner). */
export function setHq(owner, name = "Headquarters") {
  db.prepare("UPDATE floors SET owner = ?, name = ?, state = 'hq' WHERE n = ?").run(owner, name, HQ_FLOOR);
}
