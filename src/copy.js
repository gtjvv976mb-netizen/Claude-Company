import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";
import { cfg } from "./config.js";
import { CAP_BANDS } from "./categories.js";

/** The pads a floor can choose between. `other` covers established coins with no pad. */
export const LAUNCHPADS = ["pump.fun", "letsbonk.fun", "bags.fm", "moonshot", "boop.fun", "meteora-dbc", "trix", "other"];
import { liveCalls, getCall, highWaterMark } from "./calls.js";
/* The same policy defaults evaluateExit overrides with the DESK_* env dials, so the
   call-state route can hand the bot the desk it is standing in for, not a generic one. */
import { POLICY_DEFAULTS } from "../executor/trade-policy.mjs";
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

-- THE BOT'S REAL BOOK, one row per confirmed chain fill it reports. The site showed
-- the desk's paper 0.4 SOL for a real 0.0175 SOL fill and never learned the bot had
-- sold (Shrek call 55, 2026-09-05): the only executor fact the desk ever stored was
-- the taken flag, a bit with no size, no price, no exit and no reason. Every buy and
-- every sell now lands here with the chain's own numbers, keyed by the transaction
-- signature so a retried report is an upsert and never a second fill.
CREATE TABLE IF NOT EXISTS executor_fills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no     INTEGER NOT NULL,
  call_id      INTEGER NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  signature    TEXT NOT NULL UNIQUE,
  wallet       TEXT,
  at           INTEGER NOT NULL,     -- the chain confirmation time the bot recorded (ms)
  sol          REAL,                 -- buy: SOL paid; sell: SOL proceeds
  lamports_in  INTEGER,
  qty_raw      TEXT,                 -- raw token units, as a string (may exceed 2^53)
  entry_mark   REAL,
  sol_usd      REAL,
  realized_sol REAL,                 -- sell only: net of the entry
  fraction     REAL,
  reason       TEXT,
  kind         TEXT,                 -- desk_exit | mirror_exit | risk_exit | ...
  desk_code    TEXT,                 -- the desk's close code when the bot knew it
  event_id     TEXT,                 -- the desk alert event_id when the bot knew it
  intent_id    TEXT,
  received_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executor_fills_call ON executor_fills(floor_no, call_id, side);
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
// The last 48 pulses, oldest first: {seenAt, mode, open, state}. The single latest blob
// gave the WALL-ST-E tab no history at all — every past pulse was overwritten.
ensureColumn("copy_settings", "executor_heartbeat_log", "TEXT");
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
/* THE AUTO SIZE, for a tenant who states funds but no per-trade number: a percentage of
 * their own bankroll, scaled by the category's risk and the call's conviction. One desk
 * number, because sizing policy is the team's job too — the tenant's lever is the
 * explicit per-trade SOL amount, which overrides this entirely. */
export const AUTO_RISK_PCT_PER_TRADE = Number(process.env.DESK_AUTO_RISK_PCT || 3);

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

/* ONE-TIME CORRECTION FOR THE HOUSE FLOOR (2026-09-03). Floor 50 sat on the `micro`
   sleeve, so it refused every call above $100k — and after the sleeves were rebuilt
   around the owner's six bands, `micro` means $20k-$60k, which would have refused
   almost everything. The owner wants all six bands traded, so the house floor is put
   on `any` once. It moves only a floor still holding the pre-rebuild default; a
   sleeve chosen in the Team tab afterwards wins. */
function widenHouseFloorSleeve() {
  try {
    const cur = db.prepare("SELECT mcap_tier FROM copy_settings WHERE floor_no=?").get(HOUSE_SEED.floor);
    if (!cur || cur.mcap_tier !== "micro") return;
    db.prepare("UPDATE copy_settings SET mcap_tier='any', updated_at=? WHERE floor_no=? AND mcap_tier='micro'")
      .run(Date.now(), HOUSE_SEED.floor);
    console.log(`[copy] house floor ${HOUSE_SEED.floor} was on the micro sleeve and refused every larger call; widened to every sleeve`);
  } catch (e) { console.error("[copy] house sleeve widen skipped:", e.message); }
}

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
widenHouseFloorSleeve();

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

/* HOW MANY POSITIONS A BOT MAY HOLD AT ONCE. Set by the desk, not the tenant: it is a
 * property of how this desk trades — several small clips running at once, each on its
 * own band's clock — and not a taste the customer should have to have. */
export const MAX_OPEN_POSITIONS = Number(process.env.DESK_MAX_OPEN_POSITIONS || 8);

/**
 * What should THIS floor do about THIS call?
 *
 * THE TENANT CHOOSES TWO NUMBERS: how much money their bot has, and how much SOL goes
 * into each trade. Nothing else (owner, 2026-09-03). Every other question — which
 * launchpad, which category, which market-cap sleeve, what liquidity is enough, what
 * conviction clears the bar — is the trading team's job, and the team answers it once,
 * upstream, by deciding what to publish at all. A customer who has to assemble a
 * filter policy before their bot works has been handed the desk's job; and every one
 * of those filters was, in practice, a way to receive nothing. On 2026-09-02 the house
 * floor's own bot sat armed for twelve hours while every call it was sent died on one
 * of them.
 *
 * So what remains here is only what is genuinely per-floor: whether the rent is paid,
 * how much of the tenant's own money to put in, and whether that money is enough to
 * clear Solana's fees.
 */
export function decide(floorNo, call) {
  const s = settingsFor(floorNo);

  // Rent unpaid: the floor stops receiving NEW calls. It never stops receiving exits —
  // holding someone in a position over a billing dispute would be indefensible, and
  // exits are published to every floor regardless of what it owes.
  if (inArrears(floorNo))
    return { verdict: "skipped", reason: "rent is overdue — top up $CLAUDECO to resume new calls" };
  const risk = CATEGORY_RISK[call.category] ?? CATEGORY_RISK.unclear;

  const open = openCount(floorNo);
  if (open >= MAX_OPEN_POSITIONS)
    return { verdict: "skipped", reason: `already holding ${open} of a maximum ${MAX_OPEN_POSITIONS}` };

  /* SIZE. Two ways, and the tenant picks: a FIXED fund — the same SOL on every trade,
   * which makes a young record legible because every outcome is comparable — or auto,
   * where the desk sizes from the floor's bankroll, the category's risk and the call's
   * own conviction. Fixed overrides how MUCH; it never overrides the refusals above. */
  const convScale = call.conviction != null ? Math.min(1, Math.max(0.4, call.conviction / 100)) : 0.6;
  const autoSize = s.bankroll_sol * (AUTO_RISK_PCT_PER_TRADE / 100) * risk.sizeMultiplier * convScale;
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
  /* A FIXED SIZE IS THE OPERATOR'S NUMBER. The team's book-allocation cap
     exists to keep AUTO sizing in proportion to the desk's own conviction; it
     was also shrinking an explicit fixed order (0.2 SOL) to 0.0006 and then
     "lifting" it to the 0.02 fee floor — so the operator asked for 0.2 and got
     0.02 on every trade, with the reason string cheerfully saying both. Fixed
     means fixed; the refusals above still apply. */
  const raw = fixed != null
    ? (deskRatio === 0 ? 0 : fixed)   // an explicit ZERO authorization is never revived by a fixed size
    : Math.min(uncapped, teamCapSol);
  let sizeSol = Number(raw.toFixed(4));
  let liftedForFees = false;
  if (sizeSol > 0 && sizeSol < MIN_EXECUTABLE_SOL) {
    /* The lift is bounded by the risk the tenant actually chose. An EXPLICIT fixed
     * size is that choice, stated in SOL; the appetite percentage is the AUTO rule
     * for tenants who did not state one. This branch used to read only the
     * percentage, so a floor with fixed_sol = 0.2 was refused with the advice
     * "...or set a fixed size" — the house floor sat on that contradiction for a day
     * while an armed bot polled an empty feed. */
    const perTradeBudget = fixed != null ? fixed : s.bankroll_sol * (AUTO_RISK_PCT_PER_TRADE / 100);
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
    ? `${fixed} SOL a trade, the size you set`
    : `auto · ${risk.sizeMultiplier}x for ${call.category} · conviction ${Math.round(call.conviction ?? 0)}`;
  const how = fixed == null && Number.isFinite(teamCapSol) && teamCapSol < uncapped
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

/* THE BOT'S BOOK RIDES ON EVERY FEED ROW AS bot_* FIELDS — and the wallet does not.
 * The floor feed is what the site's board renders, and the HQ feed is public, so the
 * burner's address stays out of it: every other executor surface already masks it
 * for non-owners, and a public feed row is read by everyone. The numbers are the
 * bot's own (SOL in, SOL out, realized, reason) so the board can say what is
 * actually held instead of what the desk sized on paper.
 *
 * AND NEITHER DO THE CHAIN IDENTIFIERS. Withholding the wallet while publishing the
 * transaction signatures withheld nothing at all: a signature pasted into any explorer
 * names the signing wallet in one click, so bot_entry_sig / bot_exit_sig handed the
 * burner's address to every anonymous reader of an unauthenticated feed — and
 * bot_qty_raw handed them its exact token holding on top of it. This is the operator's
 * self-hosted burner; the whole architecture exists so the server never learns or
 * controls it, and a public route that de-anonymises it undoes that in one field.
 * Nothing in viewer/office3d.html ever rendered the three (grepped 2026-09-05: it
 * reads bot_status, bot_size_sol, bot_entry_mark, bot_realized_sol, bot_closed_at and
 * the exit reason), so they are gone rather than masked. */
const BOT_FIELDS = Object.freeze({
  bot_status: null, bot_size_sol: null, bot_opened_at: null, bot_entry_mark: null,
  bot_sold_sol: null, bot_realized_sol: null,
  bot_exit_reason: null, bot_exit_kind: null, bot_exit_code: null, bot_closed_at: null,
});

function botFieldsFor(fills) {
  const out = { ...BOT_FIELDS };
  if (!fills?.length) return out;
  const buys = fills.filter((f) => f.side === "buy").sort((a, b) => a.at - b.at || a.id - b.id);
  const sells = fills.filter((f) => f.side === "sell").sort((a, b) => a.at - b.at || a.id - b.id);
  if (buys.length) {
    const first = buys[0];
    // Size is summed across every buy on the call, so a second clip on the same
    // call is not silently under-reported; the entry facts come from the first.
    out.bot_size_sol = buys.reduce((s, f) => s + (Number(f.sol) || 0), 0);
    out.bot_opened_at = first.at;
    out.bot_entry_mark = first.entry_mark;
  }
  if (sells.length) {
    const last = sells[sells.length - 1];
    out.bot_sold_sol = sells.reduce((s, f) => s + (Number(f.sol) || 0), 0);
    out.bot_realized_sol = sells.reduce((s, f) => s + (Number(f.realized_sol) || 0), 0);
    out.bot_exit_reason = last.reason;
    out.bot_exit_kind = last.kind;
    out.bot_exit_code = last.desk_code;
    out.bot_closed_at = last.at;
  }
  // 'closed' the moment a sell lands, even if the desk's own call is still live —
  // the site drops the position from the board on the bot's word, not the desk's.
  out.bot_status = sells.length ? "closed" : buys.length ? "open" : null;
  return out;
}

export function feedFor(floorNo, limit = 25) {
  const rows = db.prepare(`
  SELECT d.*, c.mint, c.symbol, c.category, c.launchpad, c.conviction, c.status,
         c.entry_ref, c.entry_lo, c.entry_hi, c.stop, c.target, c.opened_at, c.closed_at,
         c.thesis, c.invalidation, c.close_reason, c.close_mark, c.image_url,
         c.mcap_at_call, c.liq_at_call, c.rt_loss_at_call, c.hold_band, c.hold_min_ms, c.hold_max_ms,
         (SELECT e.mark FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL
          ORDER BY e.id DESC LIMIT 1) AS last_mark,
         (SELECT MAX(e.ts) FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL) AS last_mark_ts
  FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? ORDER BY d.id DESC LIMIT ?`).all(floorNo, limit);
  if (!rows.length) return rows;
  const byCall = new Map();
  try {
    const ids = rows.map((r) => r.call_id);
    // The wallet column is deliberately NOT selected: it never reaches a feed row.
    // Neither are `signature` and `qty_raw`, for the same reason and by the same rule:
    // a signature resolves to the signing wallet on any explorer, so publishing one on
    // an unauthenticated feed leaks the burner's address as surely as the column we
    // withheld — plus its exact holding. Select only what the board actually draws.
    const fills = db.prepare(`
      SELECT id, call_id, side, at, sol, entry_mark, realized_sol,
             reason, kind, desk_code
      FROM executor_fills WHERE floor_no=? AND call_id IN (${ids.map(() => "?").join(",")})
      ORDER BY id`).all(floorNo, ...ids);
    for (const f of fills) {
      if (!byCall.has(f.call_id)) byCall.set(f.call_id, []);
      byCall.get(f.call_id).push(f);
    }
  } catch { /* a feed must never fail because the fill join did */ }
  return rows.map((r) => ({ ...r, ...botFieldsFor(byCall.get(r.call_id)) }));
}

/** The tenant says they took it. Bookkeeping over a number they declared — never a balance we hold. */
export function markTaken(floorNo, callId, taken = true) {
  // Only an OFFERED delivery can be taken: marking a skipped or ancient call
  // pulls it into fill-scanning and settlement it was never part of.
  const r = db.prepare("UPDATE deliveries SET taken=?, taken_at=? WHERE floor_no=? AND call_id=? AND verdict='offered'")
    .run(taken ? 1 : 0, taken ? Date.now() : null, floorNo, callId);
  return r.changes === 1;
}

/* ── THE STATE READ: WHAT THE DESK CURRENTLY BELIEVES ABOUT THE CALLS THE BOT HOLDS ──
 *
 * Wave 1 made the desk the SOLE author of exits: the bot has no stop, no target, no
 * clock and no take-profit of its own (Shrek call 55, 2026-09-05 — it sold at
 * 03:01:42Z on its own normalised stop at -13.5%, nine minutes before the desk's own
 * stop_hit at 03:10:24Z, and that is exactly what the owner asked us to remove). The
 * consequence is the thing this function exists for: with the bot's own exit policy
 * gone, a desk exit that is never DELIVERED is not merely late, it is never taken.
 *
 * Two ways the single `type:"exit"` row on the feed fails to arrive, neither of which
 * wave 1 covers:
 *   1. It is delivered once, ever. alerts has UNIQUE(floor_no, call_id, kind), the feed
 *      serves strictly after a durable cursor, and the cursor advances per event. A bot
 *      that restarts, throws on that row, or advances past it never sees it again;
 *      reconcileMissingExitAlerts repairs a missing alert ROW, not a missed DELIVERY.
 *   2. A desk that answers 200 while it is not deciding. A wedged penthouse loop or a
 *      dead price source serves a perfectly healthy feed with no exit events, which is
 *      byte-for-byte identical to "the desk looked and decided to hold". Mirror mode
 *      engages only when the feed is UNREACHABLE, so this reads as normal for ever.
 *
 * So the bot asks, about the calls it is ACTUALLY holding, what the desk currently
 * thinks. A state read, not a bigger event stream. Three rules make it safe:
 *   - It is READ-ONLY. It must never close a call, never write an alert, never touch a
 *     delivery. A monitoring read with side effects is a second, unaudited exit path,
 *     and the whole design turns on there being exactly one author of exits.
 *   - It is bounded by an OFFERED delivery on THIS floor, exactly like recordExecutorFill,
 *     so one floor's secret can never read another floor's calls.
 *   - It carries no wallet and no secret. The bot already knows its own wallet; nothing
 *     else on this route needs one.
 */

/** The exact wire shape. Named once so the route, the tests and the bot agree, and so a
 *  column added to `calls` later cannot silently join a public payload. */
export const CALL_STATE_FIELDS = Object.freeze([
  "call_id", "status", "close_reason", "close_mark", "closed_at", "opened_at",
  "entry_ref", "stop", "target", "hold_band", "hold_min_ms", "hold_max_ms",
  "last_mark", "last_mark_ts", "mint", "high_water",
  "take_profit_x", "max_age_hours", "trail_pct",
]);

/* WHY mint AND high_water WERE ADDED, AFTER THE ORIGINAL FOURTEEN.
 *
 * mint — a call id is a desk-side integer, and the bot sells a TOKEN. Under desk-led
 * exits the bot has no stop and no clock of its own: whatever this row says about
 * call 55 is what it sells. If the row it matched to a position is about a different
 * coin — an id reused after a database restore, a mis-keyed position, a bug in the
 * bot's own map — nothing on the old wire could tell it, and it would sell the wrong
 * bag on a stranger's stop. The mint lets the bot PROVE the row is about the thing it
 * is holding before acting on it. It is not a secret: it is on the public feed row,
 * on the board, and on every explorer already.
 *
 * high_water — the desk arms its trail and its breakeven stop off the confirmed high,
 * not off entry, so a bot that only ever sees `stop` cannot reproduce the level the
 * desk is actually watching, and reads a trail exit as a desk that fired for no
 * reason. It is the SAME number the desk's own evaluateExit uses: highWaterMark(id)
 * from calls.js, the two-witness confirmed high — never a second definition, because
 * two definitions of the high is exactly how the bot and the desk came to disagree by
 * nine minutes and 13.5% on Shrek call 55. Note the desk's policy then seeds its high
 * at max(high_water, entry_ref); this field is the raw history side of that max, so a
 * call the monitor has never marked reports null rather than a fabricated level. */

/** At most this many ids per read. The bot holds a handful of positions; a route that
 *  will answer about a thousand ids is a scan someone will eventually point at us. */
export const CALL_STATE_MAX_IDS = 25;

/**
 * Parse the `ids=1,2,3` query argument. Strict on purpose: a silently-dropped garbage
 * id would answer 200 with the call simply ABSENT, and absence is defined to mean "the
 * desk has never heard of it — hold". A malformed request that reads as a hold is the
 * failure mode this whole route was built to remove, so it is a 400 instead.
 */
export function parseCallStateIds(raw) {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return { ok: false, error: "ids is required: up to 25 comma-separated call ids" };
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length > CALL_STATE_MAX_IDS) {
    return { ok: false, error: `at most ${CALL_STATE_MAX_IDS} ids (got ${parts.length})` };
  }
  const ids = [];
  for (const p of parts) {
    // /^\d+$/ and not Number(): Number(" ")===0, Number("1e3")===1000 and Number("0x2")===2
    // all parse, and every one of them would be a call id the caller did not write.
    if (!/^\d+$/.test(p)) return { ok: false, error: `'${p}' is not a call id` };
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: `'${p}' is not a positive call id` };
    if (!ids.includes(n)) ids.push(n);
  }
  return { ok: true, ids };
}

/**
 * What the desk believes about these calls, for the floor that asked. Returns
 * `{calls, now}`; `now` is the DESK'S clock so the bot measures the desk's silence
 * against the desk's own time rather than against a laptop whose clock has drifted.
 *
 * Unknown ids, ids belonging to another floor and ids this floor was only ever offered
 * as 'skipped' are simply absent — never an error and never another floor's row.
 *
 * last_mark_ts falls back to opened_at when the desk has never recorded a mark for the
 * call, mirroring executorFeedPayload's current_mark_at. That fallback IS the second
 * failure mode's signal: a call the monitor has never once marked must read as stale
 * from the moment it opened, not as null — a null would compare false against every
 * staleness threshold and the bot would hold through a desk that never looked.
 */
export function callStateFor(floorNo, ids, { now = Date.now() } = {}) {
  const floor = Number(floorNo);
  const wanted = (Array.isArray(ids) ? ids : [])
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, CALL_STATE_MAX_IDS);
  if (!Number.isFinite(floor) || !wanted.length) return { calls: [], now };
  const rows = db.prepare(`
    SELECT c.id AS call_id, c.status, c.close_reason, c.close_mark, c.closed_at, c.opened_at,
           c.entry_ref, c.stop, c.target, c.hold_band, c.hold_min_ms, c.hold_max_ms, c.mint,
           (SELECT e.mark FROM call_events e
             WHERE e.call_id=c.id AND e.mark IS NOT NULL
             ORDER BY e.id DESC LIMIT 1) AS event_mark,
           (SELECT MAX(e.ts) FROM call_events e
             WHERE e.call_id=c.id AND e.mark IS NOT NULL) AS event_mark_ts
    FROM deliveries d JOIN calls c ON c.id=d.call_id
    WHERE d.floor_no=? AND d.verdict='offered' AND d.call_id IN (${wanted.map(() => "?").join(",")})
    ORDER BY c.id`).all(floor, ...wanted);
  const calls = rows.map((r) => ({
    call_id: r.call_id, status: r.status,
    close_reason: r.close_reason ?? null, close_mark: r.close_mark ?? null,
    closed_at: r.closed_at ?? null, opened_at: r.opened_at ?? null,
    entry_ref: r.entry_ref ?? null, stop: r.stop ?? null, target: r.target ?? null,
    hold_band: r.hold_band ?? null, hold_min_ms: r.hold_min_ms ?? null, hold_max_ms: r.hold_max_ms ?? null,
    last_mark: r.event_mark ?? r.entry_ref ?? null,
    last_mark_ts: r.event_mark_ts ?? r.opened_at ?? null,
    mint: r.mint ?? null,
    // highWaterMark is a pure SELECT over call_events, so the read stays read-only —
    // the one property this route may never lose. At most CALL_STATE_MAX_IDS of them.
    high_water: highWaterMark(r.call_id) ?? null,
    /* THE DESK'S OWN DIALS, SO THE MIRROR CANNOT DRIFT FROM THE DESK THAT TUNED THEM.
     * evaluateExit runs pricePolicy with POLICY_DEFAULTS overridden by these three env
     * values (src/calls.js). A mirror running the bare defaults against a desk tuned to
     * DESK_TAKE_PROFIT_X=3 sells a full multiple early — a determination the desk never
     * made, which is the whole failure this change exists to remove. Built from the same
     * expressions, so tuning the desk retunes its stand-in on the next reconcile. */
    take_profit_x: Number(process.env.DESK_TAKE_PROFIT_X || POLICY_DEFAULTS.takeProfitX),
    max_age_hours: Number(process.env.DESK_MAX_AGE_HOURS || POLICY_DEFAULTS.maxAgeHours),
    trail_pct: Number(process.env.DESK_TRAIL_PCT || POLICY_DEFAULTS.trailPct),
  }));
  return { calls, now };
}

/* ── THE BOT REPORTING WHAT IT ACTUALLY DID, WITH NUMBERS ──────────────────────
 *
 * /executor/take carried one bit. On Shrek call 55 (2026-09-05) the bot filled
 * 0.0175 SOL, the board showed the desk's paper 0.4, the bot sold at 03:01:42Z on
 * its own normalised stop at -13.5% and the site never heard about it — the desk's
 * own stop_hit landed at 03:10:24Z and the card kept calling the position held.
 * A fill report is a fact about the chain: side, signature, SOL in or out, the
 * realized figure, the reason. The validator is strict because these rows drive
 * the public board; a NaN here would render as a held position of size NaN. */
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;

/** A finite number, or null when absent; `undefined` (not null) means "unusable". */
function finiteOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function validateExecutorFill(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const callId = Number(body.callId);
  if (!Number.isInteger(callId) || callId <= 0) return { ok: false, error: "callId must be a positive integer" };
  const side = String(body.side ?? "");
  if (side !== "buy" && side !== "sell") return { ok: false, error: "side must be 'buy' or 'sell'" };
  const signature = String(body.signature ?? "");
  if (!BASE58_SIG.test(signature)) return { ok: false, error: "signature must be 60-100 base58 characters" };
  const at = Number(body.at);
  if (!Number.isFinite(at) || at <= 0) return { ok: false, error: "at must be a positive millisecond timestamp" };
  const nums = {};
  const numericKeys = side === "buy"
    ? { sol: "sizeSol", lamports_in: "lamportsIn", entry_mark: "entryMark", sol_usd: "solUsd" }
    : { sol: "sol", realized_sol: "realizedSol", fraction: "fraction" };
  for (const [col, key] of Object.entries(numericKeys)) {
    const n = finiteOrNull(body[key]);
    if (n === undefined) return { ok: false, error: `${key} must be a finite number` };
    nums[col] = n;
  }
  const text = (v, max) => (v == null ? null : String(v).slice(0, max));
  // qtyRaw is a string on purpose: raw token units routinely exceed 2^53.
  const qtyRaw = body.qtyRaw == null ? null : String(body.qtyRaw);
  if (qtyRaw != null && !/^\d{1,40}$/.test(qtyRaw)) return { ok: false, error: "qtyRaw must be a string of digits" };
  return { ok: true, fill: {
    call_id: callId, side, signature, at: Math.floor(at),
    wallet: text(body.wallet, 64),
    sol: nums.sol ?? null, lamports_in: nums.lamports_in == null ? null : Math.floor(nums.lamports_in),
    qty_raw: qtyRaw, entry_mark: nums.entry_mark ?? null, sol_usd: nums.sol_usd ?? null,
    realized_sol: nums.realized_sol ?? null, fraction: nums.fraction ?? null,
    reason: text(body.reason, 400), kind: text(body.kind, 40), desk_code: text(body.deskCode, 40),
    event_id: text(body.eventId, 120), intent_id: text(body.intentId, 120),
  } };
}

/**
 * Store one reported fill. Returns null when this floor was never OFFERED the call —
 * the same refusal markTaken makes, because a fill on a call the desk did not hand
 * this floor is either a mistake or a forgery and must not appear on its board.
 * Throws on a malformed body (the route answers 400 before ever getting here).
 * Upsert by signature: INSERT OR IGNORE, then refresh the mutable figures, so the
 * bot's durable retry queue can re-post after a lost 2xx without a second row.
 * Returns `{conflict:"signature_claimed"}` — never a row — when that signature already
 * belongs to a different floor, call or side; the route turns that into a 409. A fill
 * row and a conflict are told apart by the `conflict` key, which no column carries.
 */
export function recordExecutorFill(floorNo, body, { now = Date.now() } = {}) {
  const v = validateExecutorFill(body);
  if (!v.ok) { const e = new Error(v.error); e.code = "malformed"; throw e; }
  const f = v.fill;
  const offered = db.prepare("SELECT 1 FROM deliveries WHERE floor_no=? AND call_id=? AND verdict='offered'")
    .get(floorNo, f.call_id);
  if (!offered) return null;
  const ins = db.prepare(`INSERT OR IGNORE INTO executor_fills
      (floor_no, call_id, side, signature, wallet, at, sol, lamports_in, qty_raw, entry_mark, sol_usd,
       realized_sol, fraction, reason, kind, desk_code, event_id, intent_id, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(floorNo, f.call_id, f.side, f.signature, f.wallet, f.at, f.sol, f.lamports_in, f.qty_raw,
      f.entry_mark, f.sol_usd, f.realized_sol, f.fraction, f.reason, f.kind, f.desk_code,
      f.event_id, f.intent_id, now);
  const fresh = ins.changes === 1;
  if (!fresh) {
    // A re-post refreshes the figures but never rebinds the row to another floor,
    // call or side: those are the identity of the fill, and COALESCE keeps a value a
    // later, thinner retry did not carry.
    db.prepare(`UPDATE executor_fills SET
        sol=COALESCE(?, sol), lamports_in=COALESCE(?, lamports_in), qty_raw=COALESCE(?, qty_raw),
        entry_mark=COALESCE(?, entry_mark), sol_usd=COALESCE(?, sol_usd),
        realized_sol=COALESCE(?, realized_sol), fraction=COALESCE(?, fraction),
        reason=COALESCE(?, reason), kind=COALESCE(?, kind), desk_code=COALESCE(?, desk_code),
        event_id=COALESCE(?, event_id), intent_id=COALESCE(?, intent_id)
      WHERE signature=? AND floor_no=? AND call_id=? AND side=?`)
      .run(f.sol, f.lamports_in, f.qty_raw, f.entry_mark, f.sol_usd, f.realized_sol, f.fraction,
        f.reason, f.kind, f.desk_code, f.event_id, f.intent_id, f.signature, floorNo, f.call_id, f.side);
  }
  /* THE READ-BACK IS SCOPED TO THE CALLER, OR IT HANDS BACK SOMEBODY ELSE'S ROW.
     `signature` is globally UNIQUE, so INSERT OR IGNORE silently does nothing when
     another floor has already claimed that signature — and the old read-back,
     "WHERE signature=?", then returned THAT floor's entire row, wallet column and
     all, over an authenticated 200 to a floor that never wrote it. One forged (or
     merely copied) signature was a cross-floor read of the burner's address. So the
     read-back carries the caller's own identity: signature AND floor AND call AND
     side, which are exactly the four columns the upsert refuses to rebind. */
  const row = db.prepare("SELECT * FROM executor_fills WHERE signature=? AND floor_no=? AND call_id=? AND side=?")
    .get(f.signature, floorNo, f.call_id, f.side);
  /* Nothing matching means the row belongs to somebody else: the write genuinely did
     not happen, and 200 would be the same false success the take route already taught
     us about — it ends the bot's retry on a report the desk never stored. The route
     answers 409 (see office.js), and the conflict is decided BEFORE markTaken and
     before the bus emit so a stranger's signature cannot flip a delivery to taken or
     announce a fill that has no row behind it. */
  if (!row) return { conflict: "signature_claimed", callId: f.call_id, side: f.side };
  // A buy IS the take. The flag stays the site's compatibility bit for old rows; the
  // bot no longer needs a second report to set it.
  if (f.side === "buy") markTaken(floorNo, f.call_id, true);
  if (fresh) {
    const call = getCall(f.call_id);
    emit("executor:fill", { floorNo, callId: f.call_id, side: f.side, symbol: call?.symbol ?? null,
      sol: f.sol, realizedSol: f.realized_sol, reason: f.reason, kind: f.kind, deskCode: f.desk_code });
  }
  return row;
}
