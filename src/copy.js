import db from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";

/** The pads a floor can choose between. `other` covers established coins with no pad. */
export const LAUNCHPADS = ["pump.fun", "letsbonk.fun", "bags.fm", "moonshot", "boop.fun", "meteora-dbc", "trix", "other"];
import { liveCalls, getCall } from "./calls.js";

/**
 * COPY TRADING — how one house call becomes fifty different decisions.
 *
 * Every line here is deterministic code. That is the point: it runs per floor, per call,
 * and must cost nothing, or the product stops working at scale. The expensive thinking
 * happened once, upstairs.
 *
 * "Auto" never means the desk signs. It means the call is delivered instantly with a
 * ready ticket the tenant taps once in their own wallet. There is no code path here that
 * touches a key, and none should ever be added.
 */

export const APPETITES = {
  conservative: { riskPctPerTrade: 0.5, minConviction: 70, maxOpen: 3,
    categories: ["established", "utility", "infra"],
    note: "Only the survivable categories, small size, high bar." },
  balanced:     { riskPctPerTrade: 1.5, minConviction: 55, maxOpen: 5,
    categories: ["established", "utility", "infra", "defi", "ai"],
    note: "Everything but pure memecoins." },
  aggressive:   { riskPctPerTrade: 3.0, minConviction: 40, maxOpen: 8,
    categories: ["established", "utility", "infra", "defi", "ai", "memecoin", "unclear"],
    note: "Takes memecoins. The base rate on those is brutal — size accordingly." },
};

db.exec(`
CREATE TABLE IF NOT EXISTS copy_settings (
  floor_no    INTEGER PRIMARY KEY REFERENCES floors(n),
  appetite    TEXT NOT NULL DEFAULT 'balanced',
  bankroll_usd REAL NOT NULL DEFAULT 1000,
  auto        INTEGER NOT NULL DEFAULT 0,     -- deliver instantly with a ready ticket
  categories  TEXT,                            -- JSON override of the appetite default
  launchpads  TEXT,                            -- JSON allow-list of pads; null = every pad
  updated_at  INTEGER
);

-- One row per (call, floor): what this floor was told, and what it did about it.
CREATE TABLE IF NOT EXISTS deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     INTEGER NOT NULL REFERENCES calls(id),
  floor_no    INTEGER NOT NULL,
  verdict     TEXT NOT NULL,        -- offered | skipped
  reason      TEXT,
  size_usd    REAL,
  taken       INTEGER NOT NULL DEFAULT 0,
  taken_at    INTEGER,
  delivered_at INTEGER NOT NULL,
  UNIQUE (call_id, floor_no)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_floor ON deliveries(floor_no, id DESC);
`);

export function settingsFor(floorNo) {
  let s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  if (!s) {
    db.prepare("INSERT INTO copy_settings (floor_no, updated_at) VALUES (?,?)").run(floorNo, Date.now());
    s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  }
  const preset = APPETITES[s.appetite] ?? APPETITES.balanced;
  return { ...s, auto: !!s.auto, preset,
    categories: s.categories ? JSON.parse(s.categories) : preset.categories,
    // null means every pad — a floor that has expressed no preference should not
    // silently miss calls when a new launchpad is added.
    launchpads: s.launchpads ? JSON.parse(s.launchpads) : LAUNCHPADS };
}

export function saveSettings(floorNo, patch) {
  const cur = settingsFor(floorNo);
  const appetite = APPETITES[patch.appetite] ? patch.appetite : cur.appetite;
  const bankroll = Math.max(0, Math.min(1_000_000, Number(patch.bankrollUsd ?? cur.bankroll_usd)));
  const auto = patch.auto == null ? (cur.auto ? 1 : 0) : (patch.auto ? 1 : 0);
  // The column is an EXPLICIT override and nothing else. The first version wrote the
  // previous appetite's list back whenever the appetite changed, so switching to
  // aggressive silently kept conservative's categories and the floor still refused
  // memecoins. Null means "follow whatever the appetite says".
  const cats = Array.isArray(patch.categories)
    ? JSON.stringify(patch.categories.filter((c) => c in CATEGORY_RISK))
    : null;
  const pads = Array.isArray(patch.launchpads)
    ? JSON.stringify(patch.launchpads.filter((l) => LAUNCHPADS.includes(l)))
    : null;
  db.prepare("UPDATE copy_settings SET appetite=?, bankroll_usd=?, auto=?, categories=?, launchpads=?, updated_at=? WHERE floor_no=?")
    .run(appetite, bankroll, auto, cats, pads, Date.now(), floorNo);
  return settingsFor(floorNo);
}

const openCount = (floorNo) => db.prepare(`
  SELECT COUNT(*) n FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? AND d.taken=1 AND c.status='live'`).get(floorNo).n;

/**
 * What should THIS floor do about THIS call? Pure function of the floor's own settings —
 * which is what makes fifty floors genuinely differ rather than echo one another.
 */
export function decide(floorNo, call) {
  const s = settingsFor(floorNo);
  const risk = CATEGORY_RISK[call.category] ?? CATEGORY_RISK.unclear;

  // Platform first: a floor that only trades pump.fun should say so, rather than
  // reporting a category miss on a coin it was never going to look at.
  const pad = call.launchpad || "other";
  if (!s.launchpads.includes(pad))
    return { verdict: "skipped", reason: `this floor does not trade ${pad}` };

  if (!s.categories.includes(call.category))
    return { verdict: "skipped", reason: `${call.category} is outside this floor's categories` };

  if (call.conviction != null && call.conviction < s.preset.minConviction)
    return { verdict: "skipped", reason: `conviction ${Math.round(call.conviction)} is under this floor's bar of ${s.preset.minConviction}` };

  const open = openCount(floorNo);
  if (open >= s.preset.maxOpen)
    return { verdict: "skipped", reason: `already holding ${open} of a maximum ${s.preset.maxOpen}` };

  // Size from the floor's own bankroll, scaled by category and by conviction.
  const convScale = call.conviction != null ? Math.min(1, Math.max(0.4, call.conviction / 100)) : 0.6;
  const sizeUsd = Number((s.bankroll_usd * (s.preset.riskPctPerTrade / 100) * risk.sizeMultiplier * convScale).toFixed(2));
  if (sizeUsd < 1) return { verdict: "skipped", reason: "the sized position rounds to nothing on this bankroll" };

  return { verdict: "offered", sizeUsd,
    reason: `${s.appetite} · ${risk.sizeMultiplier}x for ${call.category} · conviction ${Math.round(call.conviction ?? 0)}` };
}

/** Broadcast one call to every leased floor. Deterministic, so this is free. */
export function broadcast(callId, leasedFloors) {
  const call = getCall(callId);
  if (!call) return { ok: false, error: "no such call" };
  let offered = 0, skipped = 0;
  for (const floorNo of leasedFloors) {
    const d = decide(floorNo, call);
    try {
      db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_usd,delivered_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(callId, floorNo, d.verdict, d.reason, d.sizeUsd ?? null, Date.now());
      d.verdict === "offered" ? offered++ : skipped++;
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  emit("call:broadcast", { callId, symbol: call.symbol, offered, skipped });
  return { ok: true, offered, skipped };
}

export const feedFor = (floorNo, limit = 25) => db.prepare(`
  SELECT d.*, c.mint, c.symbol, c.category, c.conviction, c.status, c.entry_ref, c.stop, c.target,
         c.thesis, c.close_reason, c.close_mark
  FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? ORDER BY d.id DESC LIMIT ?`).all(floorNo, limit);

/** The tenant says they took it. Bookkeeping over a number they declared — never a balance we hold. */
export function markTaken(floorNo, callId, taken = true) {
  const r = db.prepare("UPDATE deliveries SET taken=?, taken_at=? WHERE floor_no=? AND call_id=?")
    .run(taken ? 1 : 0, taken ? Date.now() : null, floorNo, callId);
  return r.changes === 1;
}
