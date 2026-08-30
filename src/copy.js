import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";

/** The pads a floor can choose between. `other` covers established coins with no pad. */
export const LAUNCHPADS = ["pump.fun", "letsbonk.fun", "bags.fm", "moonshot", "boop.fun", "meteora-dbc", "trix", "other"];
import { liveCalls, getCall } from "./calls.js";
import { inArrears } from "./leasing.js";

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
  bankroll_sol REAL NOT NULL DEFAULT 5,        -- SOL, held in the tenant own wallet
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
  size_sol    REAL,
  taken       INTEGER NOT NULL DEFAULT 0,
  taken_at    INTEGER,
  delivered_at INTEGER NOT NULL,
  UNIQUE (call_id, floor_no)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_floor ON deliveries(floor_no, id DESC);
`);

/**
 * A floor has two numbers, and conflating them would be the most dangerous mistake in
 * this product:
 *
 *   BUDGET   — $CLAUDECO. The access token, and nothing else: it pays the lease and
 *              the rent. It is never traded and buys no exposure.
 *   BANKROLL — SOL. The trading capital, which stays in the tenant own wallet. The
 *              desk never holds it, never sees it, and never signs for it. It exists
 *              here only as a declared number so calls can be sized.
 *
 * The desk can spend the first and only ever sizes against the second.
 */
// Migrations for databases that predate these columns — production is always one of them.
ensureColumn("copy_settings", "bankroll_sol", "REAL NOT NULL DEFAULT 5");
ensureColumn("copy_settings", "webhook_url", "TEXT");
ensureColumn("copy_settings", "executor_url", "TEXT");
ensureColumn("copy_settings", "executor_secret", "TEXT");
ensureColumn("copy_settings", "launchpads", "TEXT");
ensureColumn("deliveries", "size_sol", "REAL", "size_usd");

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
  const bankroll = Math.max(0, Math.min(100_000, Number(patch.bankrollSol ?? cur.bankroll_sol)));
  const auto = patch.auto == null ? (cur.auto ? 1 : 0) : (patch.auto ? 1 : 0);
  // The column is an EXPLICIT override and nothing else. The first version wrote the
  // previous appetite's list back whenever the appetite changed, so switching to
  // aggressive silently kept conservative's categories and the floor still refused
  // memecoins. Null means "follow whatever the appetite says".
  // Omitted key = keep the stored override; the UI form sends only appetite/
  // bankroll/auto/webhook, and writing NULL for what it did not send silently
  // wiped explicit category/launchpad overrides on every ordinary save.
  const raw = db.prepare("SELECT categories, launchpads FROM copy_settings WHERE floor_no=?").get(floorNo) || {};
  const cats = "categories" in patch
    ? (Array.isArray(patch.categories) ? JSON.stringify(patch.categories.filter((c) => c in CATEGORY_RISK)) : null)
    : raw.categories ?? null;
  const hook = "webhookUrl" in patch ? (patch.webhookUrl || null) : cur.webhook_url ?? null;
  // The executor lane: setting a URL mints the floor's signing secret once;
  // clearing the URL keeps the secret so re-enabling doesn't rotate it under
  // a bot the tenant already configured.
  let execUrl = cur.executor_url ?? null, execSecret = cur.executor_secret ?? null;
  if ("executorUrl" in patch) {
    execUrl = patch.executorUrl || null;
    if (execUrl && !execSecret) execSecret = crypto.randomBytes(24).toString("hex");
  }
  const pads = "launchpads" in patch
    ? (Array.isArray(patch.launchpads) ? JSON.stringify(patch.launchpads.filter((l) => LAUNCHPADS.includes(l))) : null)
    : raw.launchpads ?? null;
  db.prepare("UPDATE copy_settings SET appetite=?, bankroll_sol=?, auto=?, categories=?, launchpads=?, webhook_url=?, executor_url=?, executor_secret=?, updated_at=? WHERE floor_no=?")
    .run(appetite, bankroll, auto, cats, pads, hook, execUrl, execSecret, Date.now(), floorNo);
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

  // Rent unpaid: the floor stops receiving NEW calls. It never stops receiving exits —
  // holding someone in a position over a billing dispute would be indefensible, and
  // exits are published to every floor regardless of what it owes.
  if (inArrears(floorNo))
    return { verdict: "skipped", reason: "rent is overdue — top up $CLAUDECO to resume new calls" };
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
  const sizeSol = Number((s.bankroll_sol * (s.preset.riskPctPerTrade / 100) * risk.sizeMultiplier * convScale).toFixed(4));
  if (sizeSol < 0.001) return { verdict: "skipped", reason: "the sized position rounds to nothing on this bankroll" };

  return { verdict: "offered", sizeSol,
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
      db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(callId, floorNo, d.verdict, d.reason, d.sizeSol ?? null, Date.now());
      d.verdict === "offered" ? offered++ : skipped++;
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  emit("call:broadcast", { callId, symbol: call.symbol, offered, skipped });
  // Durable per-floor entry alerts + webhooks — the loop starts with hearing
  // about the call, not with happening to have the tab open. Fire and forget.
  if (offered) import("./alerts.js").then((a) => a.announceEntry(call)).catch(() => {});
  return { ok: true, offered, skipped };
}

export const feedFor = (floorNo, limit = 25) => db.prepare(`
  SELECT d.*, c.mint, c.symbol, c.category, c.conviction, c.status, c.entry_ref, c.stop, c.target,
         c.thesis, c.invalidation, c.close_reason, c.close_mark, c.image_url,
         (SELECT e.mark FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL
          ORDER BY e.id DESC LIMIT 1) AS last_mark,
         (SELECT MAX(e.ts) FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL) AS last_mark_ts
  FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? ORDER BY d.id DESC LIMIT ?`).all(floorNo, limit);

/** The tenant says they took it. Bookkeeping over a number they declared — never a balance we hold. */
export function markTaken(floorNo, callId, taken = true) {
  // Only an OFFERED delivery can be taken: marking a skipped or ancient call
  // pulls it into fill-scanning and settlement it was never part of.
  const r = db.prepare("UPDATE deliveries SET taken=?, taken_at=? WHERE floor_no=? AND call_id=? AND verdict='offered'")
    .run(taken ? 1 : 0, taken ? Date.now() : null, floorNo, callId);
  return r.changes === 1;
}
