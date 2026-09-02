import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";
import { cfg } from "./config.js";
import { CAP_BANDS } from "./categories.js";

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
// Self-reported executor liveness: {mode,wallet,cursor,open,ts,seenAt} JSON. The site
// never CLAIMS the bot is live — it relays what the bot last said about itself.
ensureColumn("copy_settings", "executor_heartbeat", "TEXT");
ensureColumn("copy_settings", "launchpads", "TEXT");
ensureColumn("copy_settings", "min_liq_usd", "REAL");   // per-floor liquidity floor; null = no floor
ensureColumn("deliveries", "size_sol", "REAL", "size_usd");

/* THE THREE DIALS A TENANT OWNS.
 *
 * Everything above decides WHICH calls reach a floor. These decide what the floor
 * DOES with one, and each has an explicit auto mode where the desk decides instead —
 * because the honest default for someone who has never watched this run is not a
 * number they had to invent, it is "let the team choose and show me what it chose".
 *
 *   take_profit_x  0 = auto (the execution seat's authored target), else a hard
 *                  multiple: 2 sells at a double, 10 rides for a ten-bagger.
 *   fixed_sol      0 = auto (Kelly sizing on the record), else the same size every
 *                  trade. Overrides how MUCH, never WHETHER.
 *   mcap_tier      which end of the market this floor wants: micro, low, mid, any.
 *
 * A tenant who sets nothing gets auto on all three, which is exactly the desk's own
 * behaviour — so the dials add choice without changing the default experience. */
ensureColumn("copy_settings", "take_profit_x", "REAL NOT NULL DEFAULT 0");
ensureColumn("copy_settings", "fixed_sol", "REAL NOT NULL DEFAULT 0");
ensureColumn("copy_settings", "mcap_tier", "TEXT NOT NULL DEFAULT 'any'");

/* One-time data migrations need their own ledger. ALTER TABLE keeps schemas current,
 * but it cannot repair a value that an older release seeded incorrectly. In that
 * release floor 50 was created with the balanced preset, whose category list excludes
 * memecoins; the memecoin desk consequently skipped every call it published. The
 * migration changes only the legacy default shape (balanced + no explicit category
 * override), so a deliberate custom allow-list is never touched. */
db.exec(`
CREATE TABLE IF NOT EXISTS data_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`);

function migrateData(name, fn) {
  if (db.prepare("SELECT 1 FROM data_migrations WHERE name=?").get(name)) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.prepare("INSERT INTO data_migrations (name, applied_at) VALUES (?,?)")
      .run(name, Date.now());
    db.exec("COMMIT");
    return true;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

migrateData("2026-08-31-hq-memecoin-appetite", () => {
  db.prepare(`UPDATE copy_settings SET appetite='aggressive', updated_at=?
              WHERE floor_no=50 AND appetite='balanced' AND categories IS NULL
                AND (updated_at IS NULL OR updated_at < 1788101164000)`)
    .run(Date.now());
});

/**
 * The market-cap sleeves a floor can subscribe to.
 *
 * These are the SAME five bands the desk sorts the market into — see categories.js.
 * They were briefly their own thing, derived from the screen's ceiling, which created
 * two market-cap taxonomies that disagreed the moment the ceiling moved: the desk
 * would call a coin "low" while a tenant's "low" sleeve refused it. One vocabulary,
 * defined once, or the filter a tenant picks does not mean what the desk means by it.
 */
export const MCAP_TIERS = {
  ...Object.fromEntries(Object.entries(CAP_BANDS).map(([k, b]) => [k, { lo: b.lo, hi: b.hi, note: b.note }])),
  any: { lo: 0, hi: Infinity, note: "every band the desk calls" },
};

/* ONE-TIME CORRECTION FOR THE HOUSE FLOOR (2026-09-02). Floor 50's declared
   bankroll sat at 0.05 SOL, so aggressive 3% sized every position at 0.0015 —
   under the fee floor — and every call the desk published was skipped at
   delivery. Twelve hours, six calls, a silent bot. The owner asked for a fixed
   0.2 SOL per trade on a 0.6 SOL wallet; this seeds exactly that, only while
   the floor is in the starved state, and only for the house floor. Anything
   set afterwards in the Team tab wins. */
const HOUSE_SEED = { floor: 50, bankrollSol: 0.6, fixedSol: 0.2 };
function seedStarvedHouseFloor() {
  try {
    const cur = db.prepare("SELECT bankroll_sol, fixed_sol FROM copy_settings WHERE floor_no=?").get(HOUSE_SEED.floor);
    if (!cur) return;
    const starved = Number(cur.bankroll_sol) < 0.2 && !(Number(cur.fixed_sol) > 0);
    if (!starved) return;
    db.prepare("UPDATE copy_settings SET bankroll_sol=?, fixed_sol=?, updated_at=? WHERE floor_no=?")
      .run(HOUSE_SEED.bankrollSol, HOUSE_SEED.fixedSol, Date.now(), HOUSE_SEED.floor);
    console.log(`[copy] house floor ${HOUSE_SEED.floor} was starved (bankroll ${cur.bankroll_sol} SOL, fixed ${cur.fixed_sol}); ` +
      `seeded bankroll ${HOUSE_SEED.bankrollSol} SOL, fixed ${HOUSE_SEED.fixedSol} SOL per trade`);
  } catch (e) { console.error("[copy] house seed skipped:", e.message); }
}
seedStarvedHouseFloor();

export function settingsFor(floorNo) {
  let s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  if (!s) {
    /* This is a memecoin desk. 'balanced' — whose own note reads "Everything but
     * pure memecoins" — receives NONE of what it publishes. Seeding tenants with it
     * meant a floor that leased, installed the bot and touched nothing got zero calls,
     * forever, with no message saying why: the end-to-end tenant test measured
     * offered=0 skipped=1 on untouched defaults. A default that delivers nothing is
     * not a cautious setting; it is a product that does not work. New floors are
     * seeded with the appetite that matches what this desk actually publishes;
     * existing rows are never rewritten, and every tenant can still choose. */
    const appetite = "aggressive";
    db.prepare("INSERT INTO copy_settings (floor_no, appetite, updated_at) VALUES (?,?,?)")
      .run(floorNo, appetite, Date.now());
    s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  }
  /* THE FEED SECRET IS MINTED ON DEMAND, NOT AS A SIDE EFFECT OF A WEBHOOK.
   * It previously appeared only when a tenant set an executor_url — but the shipped
   * bot POLLS /executor/feed and never receives a webhook, so the documented path
   * could not obtain the credential it is authenticated by. Every floor gets one the
   * first time its settings are read; it is revealed only to that floor's owner. */
  if (!s.executor_secret) {
    db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=? AND executor_secret IS NULL")
      .run(crypto.randomBytes(24).toString("hex"), floorNo);
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
  // NaN survives both clamps and binds as NULL into a NOT NULL column, throwing away
  // the ENTIRE settings save; and a bankroll of 0 sizes every call to nothing, muting
  // the floor with no explanation. Fall back to the stored value in both cases.
  const bankRaw = Number(patch.bankrollSol ?? cur.bankroll_sol);
  const bankroll = Number.isFinite(bankRaw) && bankRaw > 0
    ? Math.min(100_000, bankRaw)
    : (Number(cur.bankroll_sol) > 0 ? Number(cur.bankroll_sol) : 5);
  const auto = patch.auto == null ? (cur.auto ? 1 : 0) : (patch.auto ? 1 : 0);
  // The column is an EXPLICIT override and nothing else. The first version wrote the
  // previous appetite's list back whenever the appetite changed, so switching to
  // aggressive silently kept conservative's categories and the floor still refused
  // memecoins. Null means "follow whatever the appetite says".
  // Omitted key = keep the stored override; the UI form sends only appetite/
  // bankroll/auto/webhook, and writing NULL for what it did not send silently
  // wiped explicit category/launchpad overrides on every ordinary save.
  const raw = db.prepare("SELECT categories, launchpads FROM copy_settings WHERE floor_no=?").get(floorNo) || {};
  // An empty selection means "follow my appetite's default", NOT "chase nothing" —
  // storing [] would silently skip every call, an easy footgun off one stray click.
  const catList = Array.isArray(patch.categories) ? patch.categories.filter((c) => c in CATEGORY_RISK) : null;
  const cats = "categories" in patch
    ? (catList && catList.length ? JSON.stringify(catList) : null)
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
  // The POLLER needs a secret but no URL — it dials out. Minting was gated on
  // setting a webhook URL, so a tenant had to invent a fake one to get their
  // own secret. Ask for it directly instead.
  if (patch.mintExecutorSecret && !execSecret) execSecret = crypto.randomBytes(24).toString("hex");
  // A secret that has been seen by anyone else is spent. Rotation invalidates
  // the old one the instant it is written: any executor still holding it gets
  // 401 on its next poll and simply stops — it can never trade on a stale key.
  if (patch.rotateExecutorSecret) execSecret = crypto.randomBytes(24).toString("hex");
  // Same empty-selection footgun the categories column already guards against: an
  // empty allow-list is stored literally and the floor never receives another call.
  // Empty means "no preference" (every pad), never "no pads".
  const padList = Array.isArray(patch.launchpads) ? patch.launchpads.filter((l) => LAUNCHPADS.includes(l)) : null;
  const pads = "launchpads" in patch
    ? (padList && padList.length ? JSON.stringify(padList) : null)
    : raw.launchpads ?? null;
  // The liquidity floor: a coin whose book at call-time is thinner than this is
  // skipped for this floor. 0 / null = no floor. Omitted key keeps the stored value.
  const minLiq = "minLiqUsd" in patch
    ? (patch.minLiqUsd == null ? null : Math.max(0, Math.min(50_000_000, Number(patch.minLiqUsd) || 0)) || null)
    : cur.min_liq_usd ?? null;
  /* THE TENANT'S THREE DIALS. Each accepts 0 / "auto" meaning "the desk decides",
   * which is the default — a number someone had to invent before ever watching this
   * run is worse than the team's own judgement. Clamped, because a take-profit of
   * 0.5x is an instruction to sell at a 50% loss and a 900 SOL "fixed fund" on a
   * 5 SOL bankroll is a typo, not a strategy. */
  const takeProfitX = "takeProfitX" in patch
    ? (patch.takeProfitX == null || patch.takeProfitX === "auto" ? 0
       : Math.min(100, Math.max(1.05, Number(patch.takeProfitX) || 0)))
    : (cur.take_profit_x ?? 0);
  const fixedSol = "fixedSol" in patch
    ? (patch.fixedSol == null || patch.fixedSol === "auto" ? 0
       : Math.min(bankroll, Math.max(0, Number(patch.fixedSol) || 0)))
    : (cur.fixed_sol ?? 0);
  const mcapTier = "mcapTier" in patch && MCAP_TIERS[patch.mcapTier] ? patch.mcapTier : (cur.mcap_tier ?? "any");

  db.prepare("UPDATE copy_settings SET appetite=?, bankroll_sol=?, auto=?, categories=?, launchpads=?, min_liq_usd=?, webhook_url=?, executor_url=?, executor_secret=?, take_profit_x=?, fixed_sol=?, mcap_tier=?, updated_at=? WHERE floor_no=?")
    .run(appetite, bankroll, auto, cats, pads, minLiq, hook, execUrl, execSecret, takeProfitX, fixedSol, mcapTier, Date.now(), floorNo);
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

  // The floor's liquidity floor. Only bites when we KNOW the call-time book and it
  // is genuinely below the set floor — an unreadable liquidity (null) is never
  // treated as zero, so a data gap can't silently gate out every call.
  if (s.min_liq_usd && call.liq_at_call != null && call.liq_at_call < s.min_liq_usd)
    return { verdict: "skipped",
      reason: `liquidity $${Math.round(call.liq_at_call).toLocaleString()} is under this floor's floor of $${Math.round(s.min_liq_usd).toLocaleString()}` };

  /* THE SLEEVE THIS FLOOR ASKED FOR. An unknown market cap is never filtered out —
   * the same rule the screen follows for unreadable numbers, because "we could not
   * measure it" must not quietly become "it qualified". */
  const tier = MCAP_TIERS[s.mcap_tier] ?? MCAP_TIERS.any;
  const mcap = call.mcap_at_call;
  if (s.mcap_tier !== "any" && mcap != null && (mcap < tier.lo || mcap >= tier.hi))
    return { verdict: "skipped",
      reason: `$${Math.round(mcap).toLocaleString()} cap is outside this floor's ${s.mcap_tier} sleeve (${tier.note})` };

  /* A published house call has already cleared the desk's mandate and safety gates.
   * Applying the HQ copy preset here was a second, contradictory conviction vote:
   * the house could publish a 30-conviction mandate pick and then refuse to deliver
   * it to its own executor because the aggressive copy bar is 40. Floor 50 bypasses
   * only this tenant preference; platform, category, liquidity, sleeve, sizing and
   * open-book brakes above and below remain identical. Tenant floors keep their bar. */
  if (floorNo !== 50 && call.conviction != null && call.conviction < s.preset.minConviction)
    return { verdict: "skipped", reason: `conviction ${Math.round(call.conviction)} is under this floor's bar of ${s.preset.minConviction}` };

  const open = openCount(floorNo);
  if (open >= s.preset.maxOpen)
    return { verdict: "skipped", reason: `already holding ${open} of a maximum ${s.preset.maxOpen}` };

  /* SIZE. Two ways, and the tenant picks: a FIXED fund — the same SOL on every trade,
   * which makes a young record legible because every outcome is comparable — or auto,
   * where the desk sizes from the floor's bankroll, the category's risk and the call's
   * own conviction. Fixed overrides how MUCH; it never overrides the refusals above. */
  const convScale = call.conviction != null ? Math.min(1, Math.max(0.4, call.conviction / 100)) : 0.6;
  const autoSize = s.bankroll_sol * (s.preset.riskPctPerTrade / 100) * risk.sizeMultiplier * convScale;
  const fixed = Number(s.fixed_sol) > 0 ? Number(s.fixed_sol) : null;
  // NULL is a legacy call with no portable desk cap. Zero is an explicit refusal
  // and must stay zero all the way downstream; treating both as falsy would revive
  // a trade the team authorized at no size.
  const hasDeskCap = call.desk_size_usd != null && Number(call.desk_equity_usd) > 0;
  const deskRatio = hasDeskCap
    ? Math.max(0, Number(call.desk_size_usd) || 0) / Number(call.desk_equity_usd) : null;
  const teamCapSol = deskRatio != null ? s.bankroll_sol * deskRatio : Infinity;
  const uncapped = fixed ?? autoSize;
  /* A SIZE THAT CANNOT BE EXECUTED IS NOT AN OFFER.
   *
   * Solana's fixed network fees do not scale with trade size, so below a certain
   * notional they eat the trade: two worst-case 500k-lamport fees are 66% of a
   * 0.0015 SOL position and 20% of a 0.005 one. An executor applying any honest
   * cost check must refuse those, and it did — measured on this desk, every call
   * for a day was offered between 0.0015 and 0.0092 SOL and every one was correctly
   * refused as "costs eat the target". The floor was publishing trades that were
   * arithmetically impossible to take.
   *
   * teamCapSol caused it: a tenant's size is scaled to the same fraction-of-book the
   * desk uses, and the desk's paper book trades ~0.03% per position. On a 5 SOL
   * bankroll that is 0.0017 SOL. The cap's intent — never outrun the desk's
   * conviction — is right, but a cap that produces unexecutable sizes is a refusal
   * dressed as an offer.
   *
   * So: below MIN_EXECUTABLE_SOL the call is lifted to it when the bankroll can
   * genuinely afford that (the risk stays inside the appetite's per-trade budget),
   * and otherwise refused honestly — saying the bankroll is too small for the fees,
   * which is a fact the tenant can act on, rather than offering a trade their bot
   * will silently decline. */
  const MIN_EXECUTABLE_SOL = Number(process.env.MIN_EXECUTABLE_SOL || 0.02);
  const raw = Math.min(uncapped, teamCapSol);
  let sizeSol = Number(raw.toFixed(4));
  let liftedForFees = false;
  if (sizeSol > 0 && sizeSol < MIN_EXECUTABLE_SOL) {
    /* The lift is bounded by the risk the tenant actually chose. An EXPLICIT fixed
     * size is that choice, stated in SOL; the appetite percentage is the AUTO rule
     * for tenants who did not state one. This branch used to read only the
     * percentage, so a floor with fixed_sol = 0.2 was refused with the advice
     * "...or set a fixed size" — the house floor sat on that contradiction for a day
     * while an armed bot polled an empty feed. */
    const perTradeBudget = fixed != null ? fixed : s.bankroll_sol * (s.preset.riskPctPerTrade / 100);
    if (MIN_EXECUTABLE_SOL <= perTradeBudget) {
      sizeSol = MIN_EXECUTABLE_SOL;
      liftedForFees = true;
    } else {
      return { verdict: "skipped",
        reason: `a tradeable position needs ~${MIN_EXECUTABLE_SOL} SOL (below that, network fees eat the trade) ` +
          `but this floor's per-trade budget is ${perTradeBudget.toFixed(4)} SOL — raise the bankroll or set a fixed size` };
    }
  }
  if (sizeSol < 0.001) return { verdict: "skipped", reason: "the sized position rounds to nothing on this bankroll" };

  const baseHow = fixed
    ? `fixed ${fixed} SOL a trade`
    : `${s.appetite} · ${risk.sizeMultiplier}x for ${call.category} · conviction ${Math.round(call.conviction ?? 0)}`;
  const how = Number.isFinite(teamCapSol) && teamCapSol < uncapped
    ? `${baseHow} · capped to the team's ${(deskRatio * 100).toFixed(3)}% book allocation`
    : baseHow;
  return { verdict: "offered", sizeSol,
    reason: liftedForFees
      ? `${how} · lifted to ${sizeSol} SOL so network fees do not eat the trade`
      : how };
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
  SELECT d.*, c.mint, c.symbol, c.category, c.launchpad, c.conviction, c.status,
         c.entry_ref, c.entry_lo, c.entry_hi, c.stop, c.target, c.opened_at, c.closed_at,
         c.thesis, c.invalidation, c.close_reason, c.close_mark, c.image_url,
         c.mcap_at_call, c.liq_at_call, c.rt_loss_at_call,
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
