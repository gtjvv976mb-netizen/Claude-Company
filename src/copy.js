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
/* WAS THIS DELIVERY EVER EXECUTABLE? NULL = never judged, and it counts as deliverable,
   because today every offered call is raised the moment it is delivered; 0 = the alert
   was held past the band's window (bot paused, blocked, absent or already in the mint)
   and never raised; 1 = raised into a ready bot. Read by the cohort ledger's
   deliverable_count (calls.js cycleExecution) so P(taken | deliverable) can be told
   apart from P(taken | published): a bot that was down is not a bot that declined.
   THE WRITER IS THE PER-FLOOR READINESS GATE in alerts.js, wired 2026-09-09: it stamps 1
   when the alert is raised into a floor that has a bot, 0 when the entry passed the
   band's own window while still held, and leaves NULL for a floor with no bot at all —
   which has no such fact to record and already counts as deliverable. */
ensureColumn("deliveries", "deliverable", "INTEGER");

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

/* THE OFF SWITCH — A REQUEST THIS FLOOR LEAVES OUT, NOT A COMMAND THIS SERVER SENDS.
 *
 * Until now the only way to stop a bot was to walk to the machine it runs on and touch
 * a sentinel file, and the WALL-ST-E page said so in as many words. That is honest and
 * it is unusable: the owner asked for "an off/on button" (2026-09-09) on the same
 * Overview as the five figures.
 *
 * WHAT THIS COLUMN IS. One desired state, stored beside this floor's other copy
 * settings. The server does not — and structurally cannot — push it anywhere: the bot
 * POLLS /executor/feed on its own schedule and reads the flag out of the `rules` block
 * it already fetches. There is no socket, no callback URL, no queue. If the machine is
 * asleep the request simply sits here, which is why every surface that shows it shows
 * the bot's OWN echo and says "pending" until the bot has confirmed.
 *
 * WHAT "OFF" MEANS, EXACTLY: open no new positions. It is NOT a sell, and it does not
 * stop the bot managing or exiting what it already holds — exits, marks, reconciliation
 * and heartbeats all continue. An off switch that stranded an open position would be a
 * trap, and this codebase's whole reason for existing is not to build those.
 *
 * WHAT IT CANNOT DO: turn trading ON against the operator's will. The bot's local
 * sentinels (its hard-stop and entry-pause files) are checked independently of this
 * flag and each other, so a server "on" can never clear one — see poller.mjs onEntry
 * and test-bot-onoff.mjs, which asserts exactly that.
 *
 * NOT REACHABLE THROUGH saveSettings(), for the same reason bot_operator is not: this
 * must not be able to ride along inside a generic settings patch from a form that meant
 * to change a sleeve. It has its own owner-authenticated route. */
ensureColumn("copy_settings", "entries_enabled", "INTEGER NOT NULL DEFAULT 1");
// When the CURRENT desired state was asked for. The page dates the request with it.
ensureColumn("copy_settings", "entries_enabled_at", "INTEGER");

/* WHO RUNS THIS FLOOR'S BOT — the one question the product never asked out loud.
 *
 * A tenant could lease a floor, set six filters and still not know whether a bot was
 * supposed to appear on its own. There are exactly two answers, and they differ on
 * CUSTODY, which is the whole decision:
 *
 *   'self'          the tenant runs it on their own machine. The burner keypair is
 *                   generated there and never leaves it; this desk holds no key of
 *                   theirs and cannot move their funds. One command, live today:
 *                   curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor N
 *                   It costs them a machine that stays awake and, for live trading,
 *                   two RPC accounts.
 *   'hq_requested'  the tenant is ASKING for a managed track that does not exist. Not
 *                   a line of it: multi-tenant keys, deposits, withdrawals, per-user
 *                   ledgers, reconciliation and key-at-rest were scoped at 4-8 months,
 *                   and it cannot accept one deposit before the legal work, because it
 *                   means this operator holding a customer's key and trading their
 *                   money at its own discretion. So this value provisions NOTHING. It
 *                   takes no deposit, mints no custodial wallet, and changes no
 *                   trading behaviour anywhere in this file. It is a recorded want,
 *                   and the count of them is the demand signal that decides whether
 *                   those months are ever spent.
 *
 * NULL is the third state and the default: they have not chosen. A custody decision is
 * never defaulted on someone's behalf — a floor that silently read 'self' would be
 * telling the tenant they had agreed to run a machine, and one that silently read
 * 'hq_requested' would be manufacturing the demand number the owner is trying to
 * measure. Deliberately NOT reachable through saveSettings(): this must not be able to
 * ride along in a generic settings patch from a form that meant to change a sleeve. */
ensureColumn("copy_settings", "bot_operator", "TEXT");
// When the CURRENT choice was made — moves on every change, including a change away.
ensureColumn("copy_settings", "bot_operator_at", "INTEGER");
/* When this floor FIRST asked for the managed track. Never overwritten, and kept even
 * if the floor later switches to 'self': the owner is reading demand over time, and a
 * timestamp that jumped forward on every re-click would compress months of interest
 * into "everybody asked this week". Current demand is bot_operator; this is its date. */
ensureColumn("copy_settings", "hq_requested_at", "INTEGER");

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
/* `AUTO_RISK_PCT_PER_TRADE` (DESK_AUTO_RISK_PCT) WAS HERE. It was the desk's answer to
 * "a tenant states funds but no per-trade number" — a percentage of their bankroll,
 * scaled by category and conviction. It was removed with the rest of decide()'s sizing
 * on 2026-09-07: a tenant who has not chosen a per-trade size has still chosen one,
 * because their bot has a FIXED_SOL and a MAX_SOL_PER_TRADE on their own machine
 * (executor/strategy.mjs:106, :246). The desk answering the question for them was the
 * desk deciding how much is bought, which is the one thing it must never do. */

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
    /* Read back EXPLICITLY, and normalised to null. `SELECT *` already carries these
     * three, but a row written before the ALTER TABLE returns undefined for them, and
     * `undefined` disappears from JSON.stringify — so the panel would receive a
     * settings object with no bot_operator key at all and could not tell "has not
     * chosen" from "the server forgot to say". Unset must arrive as a stated null. */
    bot_operator: s.bot_operator ?? null,
    bot_operator_at: s.bot_operator_at ?? null,
    hq_requested_at: s.hq_requested_at ?? null,
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

/**
 * THIS FLOOR'S DESIRED RUN STATE — read by the page, and by the feed the bot polls.
 *
 * `enabled` is what the tenant last asked for. It is a REQUEST, never a fact about the
 * bot: nothing here has heard from the machine. Every caller that renders it to a human
 * must pair it with the bot's own echo (executor-dashboard.js botRunControl) so an
 * offline bot cannot be reported as having obeyed.
 */
export function entriesEnabledFor(floorNo) {
  const s = settingsFor(Number(floorNo));
  return { enabled: Number(s?.entries_enabled ?? 1) !== 0, at: s?.entries_enabled_at ?? null };
}

/**
 * Record the tenant's off/on request. Writes ONE column pair on this floor's own
 * settings row and nothing else — it starts no process, stops no process, sends no
 * message, and cannot reach the machine the bot runs on. The bot learns about it on its
 * next ordinary poll of /executor/feed, or never, if it is not running.
 *
 * Anything that is not a boolean is refused rather than coerced. "off" arriving as the
 * string "false" and landing on `true` because a truthy check was cheaper is precisely
 * the class of bug that turns a stop button into a decoration.
 */
export function setEntriesEnabled(floorNo, enabled, { now = Date.now() } = {}) {
  const n = Number(floorNo);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "bad floor" };
  if (enabled !== true && enabled !== false)
    return { ok: false, error: "enabled must be true or false" };
  settingsFor(n);                                   // the row must exist before we write it
  db.prepare("UPDATE copy_settings SET entries_enabled=?, entries_enabled_at=? WHERE floor_no=?")
    .run(enabled ? 1 : 0, now, n);
  const s = entriesEnabledFor(n);
  return { ok: true, floorNo: n, entriesEnabled: s.enabled, entriesEnabledAt: s.at };
}

/** The only two answers. Unset is the absence of one, not a third option to pick. */
export const BOT_OPERATORS = Object.freeze(["self", "hq_requested"]);

/**
 * WHAT EACH TRACK ACTUALLY COSTS — shipped as data so no screen has to remember it.
 *
 * The temptation in a comparison like this is to make self-hosting sound arduous, and
 * that would be a lie that pushes people toward the option where somebody else holds
 * their keys. It is one command, it is live, and it says so here. What each track
 * really costs is stated for both, and neither carries a return number: the house
 * record is 26 up / 28 down across 55 calls on 2 settled trades, which this site
 * already says is too few to claim an edge, so anything derived from it would be a
 * claim the evidence does not support. Read the record from /api/record; do not
 * restate it as a forecast anywhere.
 */
export const BOT_OPERATOR_TRACKS = Object.freeze({
  self: Object.freeze({
    id: "self",
    label: "You run it",
    available: true,
    /* CUSTODY FIRST. It is the difference; everything else is logistics. */
    custody: "The burner keypair is generated on your machine and never leaves it. " +
      "This desk holds no key of yours and cannot move your funds.",
    install: "curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor N",
    /* Re-worded 2026-09-09 with the installer: there is no dry-run stage to pass
       through any more, and this line claimed there was. The protection it was really
       describing is the empty wallet, which is unchanged and now says so. */
    installNote: "One command, macOS and Linux. It generates the burner locally and " +
      "arms it, and that wallet starts empty — nothing trades until you fund it.",
    costs: Object.freeze([
      "A machine that stays awake — the bot only trades while it is running.",
      "Two RPC accounts for live trading (a primary and a secondary).",
    ]),
  }),
  hq_requested: Object.freeze({
    id: "hq_requested",
    label: "HQ runs it for you",
    /* NOT A SWITCH. Marking interest is the entire behaviour of this value. */
    available: false,
    status: "register interest",
    /* The panel must show the disclosure and record an acknowledgement before this
     * value can be stored at all — see setBotOperator and /api/floor/:n/hq-consent. */
    requiresAcknowledgement: true,
    custody: "This operator would hold the key and could move the funds. Your recourse " +
      "would depend on this operator.",
    costs: Object.freeze([
      "Custody: your key, and therefore your money, sits with this operator.",
      "This operator's own machine has a measured availability record of 39 boots and " +
        "33 stops in five days (measured to 2026-09-06).",
    ]),
    note: "It does not exist yet — multi-tenant keys, deposits, withdrawals, per-user " +
      "ledgers, reconciliation and key-at-rest were scoped at 4-8 months, and it needs " +
      "legal work before it can take a single deposit. Choosing this takes no money, " +
      "creates no wallet, and starts no trading. It records that you want it.",
  }),
});

/**
 * Record who the tenant says should run their bot. Nothing else happens here — most
 * of all for 'hq_requested', which writes three columns on this floor's own settings
 * row and touches no wallet, no deposit, no delivery and no dial.
 *
 * Anything outside the enum is refused rather than coerced: a custody decision is the
 * last place to be lenient about input, and a typo silently landing on 'self' would
 * tell a tenant they had agreed to run a machine they never agreed to run.
 */
export function setBotOperator(floorNo, choice, { now = Date.now() } = {}) {
  const n = Number(floorNo);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "bad floor" };
  if (!BOT_OPERATORS.includes(choice))
    return { ok: false, error: `choice must be one of ${BOT_OPERATORS.join(", ")}` };
  /* CONSENT FIRST, INTEREST SECOND. Asking for a track where this operator holds the key
   * is not recordable until the tenant has acknowledged today's disclosure — otherwise
   * the demand number the owner is going to spend months acting on would be a count of
   * clicks by people who were never told what they were asking for. Refused, not
   * coerced, and refused with the version and hash so the caller can show the current
   * text and try again. 'self' is unaffected: nobody needs a disclosure to be told that
   * their own machine keeps their own key. */
  if (choice === "hq_requested" && !hqConsentFor(n).acknowledged) {
    const c = hqConsentFor(n);
    return { ok: false, needsAcknowledgement: true, staleAcknowledgement: c.stale,
      error: c.stale
        ? "the disclosure has changed since this floor acknowledged it — acknowledge the current one first"
        : "acknowledge the disclosure before asking for the managed track",
      disclosure: { version: c.disclosureVersion, sha256: c.disclosureSha256 } };
  }
  settingsFor(n);                                   // the row must exist before we write it
  const prior = db.prepare("SELECT hq_requested_at FROM copy_settings WHERE floor_no=?").get(n);
  /* FIRST ask wins, forever. COALESCE, not an overwrite: see the column's own note —
   * re-clicking must not restamp demand as new, and switching to 'self' must not erase
   * the fact that this floor once asked. */
  const hqAt = choice === "hq_requested" ? (prior?.hq_requested_at ?? now) : (prior?.hq_requested_at ?? null);
  db.prepare("UPDATE copy_settings SET bot_operator=?, bot_operator_at=?, hq_requested_at=? WHERE floor_no=?")
    .run(choice, now, hqAt, n);
  const s = settingsFor(n);
  return { ok: true, floorNo: n, botOperator: s.bot_operator,
    botOperatorAt: s.bot_operator_at, hqRequestedAt: s.hq_requested_at };
}

/**
 * THE DEMAND SIGNAL — how many floors have asked for the managed track, and since when.
 *
 * The owner is being asked to commit 4-8 months and a legal review to a track that
 * does not exist. This is the number that decides it, so it is counted from the stored
 * choices themselves rather than from anyone's recollection of who mentioned it.
 * Aggregate on purpose: the operator needs the count and the dates, not a roster of
 * which tenant wants custody. Owner-only at the route.
 */
export function hqOperatorDemand() {
  const row = db.prepare(`SELECT COUNT(*) n, MIN(hq_requested_at) first_at, MAX(hq_requested_at) last_at
    FROM copy_settings WHERE bot_operator='hq_requested'`).get() || {};
  const self = db.prepare("SELECT COUNT(*) n FROM copy_settings WHERE bot_operator='self'").get()?.n ?? 0;
  const unset = db.prepare("SELECT COUNT(*) n FROM copy_settings WHERE bot_operator IS NULL").get()?.n ?? 0;
  /* CURRENT INTEREST vs STALE INTEREST. A floor that asked under an older disclosure has
   * not withdrawn — it simply has not been shown the words that changed — and the two
   * must not be added together, because the second number is the one that would be used
   * to justify building this. Counted by joining the live acknowledgement row and
   * comparing its hash to today's, so nothing has to be swept when a version ships. */
  const d = hqDisclosure();
  const cur = db.prepare(`SELECT COUNT(*) n FROM copy_settings s
    JOIN hq_consents c ON c.floor_no = s.floor_no AND c.current = 1 AND c.action = 'acknowledged'
    WHERE s.bot_operator = 'hq_requested' AND c.disclosure_sha256 = ?`).get(d.sha256)?.n ?? 0;
  return {
    requested: row.n ?? 0,
    currentInterest: cur,
    staleInterest: Math.max(0, (row.n ?? 0) - cur),
    disclosureVersion: d.version,
    disclosureSha256: d.sha256,
    firstRequestAt: row.first_at ?? null,
    latestRequestAt: row.last_at ?? null,
    selfHosted: self,
    undecided: unset,
    // Said out loud next to the number, because the number is the whole case for
    // building it: nothing behind this count is running, and none of it can run yet.
    note: "floors that asked for a managed track. It does not exist and provisions nothing.",
  };
}

/* ── THE CONSENT RECORD BEHIND A MANAGED-TRACK REQUEST ────────────────────────────
 *
 * Registering interest in a track where somebody else holds your key is not a
 * preference, and a click on "HQ runs it" is not evidence that anyone read what that
 * means. So the interest is gated on an ACKNOWLEDGEMENT of a disclosure, and the
 * acknowledgement is a row.
 *
 * A TABLE, NOT MORE COLUMNS. Three columns on copy_settings would hold only the latest
 * state and would be overwritten by the next click; what an operator needs two years
 * from now is the trail — who accepted which words, when, and when they took it back.
 * Every acknowledgement and every withdrawal is an INSERT here. Nothing updates a row's
 * facts; the only mutable field is the `current` flag, which says which row is live.
 *
 * WHAT IT MAY HOLD: the floor, the wallet the session already carries, the disclosure
 * version, the SHA-256 of the exact text shown, which conditions were ticked, and the
 * time. No name, no email, no IP, no device — none of that is needed to prove that this
 * wallet accepted these words, and collecting it would be collecting it. */
db.exec(`
CREATE TABLE IF NOT EXISTS hq_consents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no          INTEGER NOT NULL,
  wallet            TEXT NOT NULL,          -- the signed-in wallet; never taken from a body
  action            TEXT NOT NULL,          -- acknowledged | withdrawn
  version           TEXT NOT NULL,          -- the disclosure version string shown
  disclosure_sha256 TEXT NOT NULL,          -- SHA-256 of the exact text shown on screen
  conditions        TEXT,                   -- JSON array of the condition numbers ticked
  created_at        INTEGER NOT NULL,
  current           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS hq_consents_floor ON hq_consents (floor_no, current);
`);

/**
 * THE DISCLOSURE ITSELF — SERVER-SIDE DATA, HASHED FROM ITS OWN WORDS.
 *
 * The hash is what makes an acknowledgement worth anything later: it proves WHICH words
 * were on screen. That only holds if the hash is taken over the same source the page
 * renders, so the text is built here, hashed here, and served whole — never typed into
 * a template on one side and hashed on the other, which is exactly how a stored hash
 * ends up certifying a paragraph nobody ever saw.
 *
 * It is DISCLOSURE, not a contract. The managed track needs an agreement drafted by a
 * lawyer before it can hold a single deposit, and this says so rather than standing in
 * for it — hence plain sentences and no clause-shaped language anywhere in the copy.
 *
 * Every measured fact in it is a number this codebase or this site already reports, and
 * the unflattering ones are the point: an availability record of 39 starts and 33 stops,
 * a research desk that has been out of paid credit and silent for over a day, and a
 * house record of 55 calls at 26 up / 28 down on 2 settled trades with realised P&L
 * negative — which the site itself calls too few to claim an edge. Softening any of
 * those would make the acknowledgement worthless, because it would be an
 * acknowledgement of a nicer arrangement than the one on offer.
 */
const HQ_DISCLOSURE_2026_09_06 = {
  version: "2026-09-06.1",
  title: "If HQ ran your bot — what that would mean",
  intro: [
    "This is not the agreement, and nothing here holds your money. It is the set of facts about an arrangement that does not exist yet, so you can decide whether you want it. If it is ever offered, a real agreement written by a lawyer comes first.",
    "Ticking these boxes records your interest. It takes no deposit, creates no wallet for you, and changes nothing about how your floor trades today.",
  ],
  conditions: [
    { n: 1, heading: "Who holds the key", points: [
      "The wallet would be created by us, and the private key would be held by us on the operator's own machine. You would not hold it.",
      "That is the opposite of the self-hosted option, where the key is generated on your machine and never leaves it.",
      "While your funds sat in that wallet, your ability to move them would depend on us.",
    ] },
    { n: 2, heading: "Who decides the trades", points: [
      "The desk would choose what to buy and when to sell, inside the filters and caps you set.",
      "You would not be approving individual trades.",
    ] },
    { n: 3, heading: "What the machine is", points: [
      "It would run on the operator's own computer, not in a data centre.",
      "Measured over five days, that machine recorded 39 starts and 33 stops, with 38 sleep-related events.",
      "While it is asleep or offline, nothing is watching your positions.",
    ] },
    { n: 4, heading: "What it depends on", points: [
      "The research desk needs paid API credit at two separate providers before it can publish a single call.",
      "It has been out of paid credit and has published nothing for over a day.",
    ] },
    { n: 5, heading: "The record so far", points: [
      "55 calls published: 26 up and 28 down, with only 2 settled trades and realised P&L negative.",
      "This site's own line about that record is that it is too few to claim an edge.",
      "No expected return is offered here, and none should be read into those numbers.",
    ] },
    { n: 6, heading: "What you could lose", points: [
      "Everything you put in. Memecoin trading can take the whole balance, quickly.",
      "Separately from market losses: theft, a lost key, a bug, or the operator becoming unavailable could each cost you the balance.",
    ] },
    { n: 7, heading: "Getting your money back", points: [
      "There is no withdrawal system. It is not slow — it is unbuilt.",
      "Whatever gets built, taking money out would depend on the operator being available.",
    ] },
    { n: 8, heading: "It does not exist yet", points: [
      "Nothing is being managed today. This records that you want it.",
      "You would be told if and when it is offered, and there would be a real agreement to read before anything holds your money.",
    ] },
  ],
  closing: [
    "Ticking every box records that you read these facts and accept them as they stand. It is not a contract and it commits you to nothing.",
    "You can withdraw your interest at any time, in one click, on this same panel.",
  ],
};

/** The exact bytes that get hashed and shown. Deterministic and boring on purpose: any
 *  cleverness here (locale dates, a Set's iteration order, JSON.stringify of an object)
 *  is a way for the same disclosure to hash differently on two machines and invalidate
 *  every acknowledgement in the table for no reason. */
function renderDisclosure(d) {
  const lines = [d.title, ""];
  for (const p of d.intro) lines.push(p);
  for (const c of d.conditions) {
    lines.push("", `${c.n}. ${c.heading}`);
    for (const p of c.points) lines.push(`- ${p}`);
  }
  lines.push("");
  for (const p of d.closing) lines.push(p);
  return lines.join("\n") + "\n";
}

/* Append-only, newest last. A disclosure version is never edited in place: changing the
 * words changes the hash, and every acknowledgement of the old words stops counting as
 * current — which is the whole mechanism, and it only works if the old text stays around
 * to explain what those older rows were an acknowledgement OF. */
const HQ_DISCLOSURES = [];

/**
 * Ship a disclosure version. The one below is published at import; a later release adds
 * the next one the same way, and that is deliberately the ONLY way — so the hash is
 * always computed from the text by the same code, and a new version can never be
 * introduced with a hash somebody pasted in by hand.
 */
export function publishHqDisclosure(entry) {
  if (!entry || typeof entry.version !== "string" || !entry.version.trim())
    throw new Error("a disclosure needs a version string");
  if (HQ_DISCLOSURES.some((d) => d.version === entry.version))
    throw new Error(`disclosure version ${entry.version} already published`);
  const conditions = Array.isArray(entry.conditions) ? entry.conditions : [];
  if (!conditions.length) throw new Error("a disclosure needs its conditions");
  conditions.forEach((c, i) => {
    if (c.n !== i + 1) throw new Error(`conditions must be numbered 1..n; got ${c.n} at index ${i}`);
  });
  const text = renderDisclosure({ title: entry.title ?? "", intro: entry.intro ?? [],
    conditions, closing: entry.closing ?? [] });
  const rec = Object.freeze({
    version: entry.version,
    title: entry.title,
    intro: Object.freeze([...(entry.intro ?? [])]),
    conditions: Object.freeze(conditions.map((c) => Object.freeze({ ...c, points: Object.freeze([...c.points]) }))),
    closing: Object.freeze([...(entry.closing ?? [])]),
    text,
    // Hex SHA-256 over the UTF-8 of the text above. Computed from the words, always.
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    publishedAt: entry.publishedAt ?? Date.now(),
  });
  HQ_DISCLOSURES.push(rec);
  return rec;
}
publishHqDisclosure(HQ_DISCLOSURE_2026_09_06);

/** The disclosure a tenant must acknowledge right now: text, version and hash together,
 *  so a page renders the same source the hash was taken over. */
export function hqDisclosure() { return HQ_DISCLOSURES[HQ_DISCLOSURES.length - 1]; }

/**
 * WHAT THIS FLOOR HAS ACKNOWLEDGED — and whether it still counts.
 *
 * Two different things, and both are needed. `current` is stored: it is cleared when the
 * tenant withdraws or supersedes their acknowledgement. Staleness is DERIVED by comparing
 * the stored hash with the current one, and derived on purpose — a stored "is stale" flag
 * would have to be rewritten across every row on the day a disclosure changes, and the
 * one row that missed the sweep would read as consent to words nobody had shown.
 *
 * `acknowledged` is the only field a gate should read: current AND over today's words.
 */
export function hqConsentFor(floorNo) {
  const n = Number(floorNo);
  const d = hqDisclosure();
  const row = Number.isInteger(n)
    ? db.prepare("SELECT * FROM hq_consents WHERE floor_no=? AND current=1 AND action='acknowledged' ORDER BY id DESC LIMIT 1").get(n)
    : null;
  const stale = !!row && row.disclosure_sha256 !== d.sha256;
  return {
    floorNo: n,
    acknowledged: !!row && !stale,
    stale,
    wallet: row?.wallet ?? null,
    version: row?.version ?? null,
    sha256: row?.disclosure_sha256 ?? null,
    conditions: row?.conditions ? JSON.parse(row.conditions) : null,
    at: row?.created_at ?? null,
    disclosureVersion: d.version,
    disclosureSha256: d.sha256,
  };
}

/** The trail itself, newest first — every acknowledgement and every withdrawal this
 *  floor has made. The tenant's own floor, so it carries the wallet; the aggregate
 *  demand figure the operator sees never does. */
export function hqConsentHistory(floorNo, limit = 20) {
  const n = Number(floorNo);
  if (!Number.isInteger(n)) return [];
  return db.prepare("SELECT id, wallet, action, version, disclosure_sha256, conditions, created_at, current FROM hq_consents WHERE floor_no=? ORDER BY id DESC LIMIT ?")
    .all(n, Math.max(1, Math.min(200, Number(limit) || 20)))
    .map((r) => ({ id: r.id, wallet: r.wallet, action: r.action, version: r.version,
      sha256: r.disclosure_sha256, conditions: r.conditions ? JSON.parse(r.conditions) : null,
      at: r.created_at, current: !!r.current }));
}

/**
 * Record that this wallet read today's disclosure and accepted it.
 *
 * The version AND the hash both have to match what is current, and the hash is the one
 * that matters: a version string can be reused by a careless edit, whereas the hash
 * changes the moment a single character of the text does. A caller sending yesterday's
 * hash is a page that was open while the disclosure changed, and the honest answer is to
 * refuse and re-show it — accepting it would file a signature against words this tenant
 * never had in front of them.
 *
 * ACKNOWLEDGING PROVISIONS NOTHING. It writes one row in this table. No wallet is
 * created, no deposit is taken, no dial on the floor moves, and the tenant's operator
 * choice does not change either — consent comes first, the interest is a second act.
 */
export function acknowledgeHqDisclosure(floorNo, wallet, { version, sha256, conditions, now = Date.now() } = {}) {
  const n = Number(floorNo);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "bad floor" };
  if (typeof wallet !== "string" || !wallet.trim()) return { ok: false, error: "no wallet" };
  const d = hqDisclosure();
  if (version !== d.version || sha256 !== d.sha256)
    return { ok: false, stale: true,
      error: "the disclosure changed while it was on screen — read the current one and acknowledge that",
      disclosure: { version: d.version, sha256: d.sha256 } };
  /* EVERY CONDITION, TICKED ONE BY ONE. Enforced on the server as well as in the panel,
   * because a single blanket checkbox is exactly the shape people click through — and
   * the custody condition is the one this whole flow exists to make someone read. */
  const ticked = Array.isArray(conditions) ? [...new Set(conditions.map(Number))].sort((a, b) => a - b) : [];
  const needed = d.conditions.map((c) => c.n);
  if (needed.some((k) => !ticked.includes(k)))
    return { ok: false, error: `acknowledge every condition (${needed.join(", ")})`,
      missing: needed.filter((k) => !ticked.includes(k)) };

  db.exec("BEGIN IMMEDIATE");
  try {
    // Supersede rather than overwrite: the older row stays, with its own words' hash.
    db.prepare("UPDATE hq_consents SET current=0 WHERE floor_no=? AND current=1").run(n);
    db.prepare(`INSERT INTO hq_consents (floor_no, wallet, action, version, disclosure_sha256, conditions, created_at, current)
                VALUES (?,?,'acknowledged',?,?,?,?,1)`)
      .run(n, wallet, d.version, d.sha256, JSON.stringify(needed), now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return { ok: false, error: String(e.message) }; }
  return { ok: true, consent: hqConsentFor(n) };
}

/**
 * Withdraw the interest — as easily as it was given, which is the test of whether it was
 * ever really optional. One call: the current acknowledgement stops being current, the
 * floor's operator choice goes back to unset (not to 'self' — withdrawing a request is
 * not a decision to run a machine), and the withdrawal is itself a row, because a trail
 * that records only the yeses is not a trail.
 *
 * hq_requested_at is deliberately left alone: it is the date this floor FIRST asked, and
 * the operator reads demand over time. Current demand is bot_operator, which this clears.
 */
export function withdrawHqInterest(floorNo, wallet, { now = Date.now() } = {}) {
  const n = Number(floorNo);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "bad floor" };
  if (typeof wallet !== "string" || !wallet.trim()) return { ok: false, error: "no wallet" };
  const had = hqConsentFor(n);
  const s = db.prepare("SELECT bot_operator FROM copy_settings WHERE floor_no=?").get(n);
  const hadRow = !!had.version;
  const wasRequesting = s?.bot_operator === "hq_requested";
  /* Nothing to withdraw is not an error — a second click on the same button must not
   * fail — but it does not write a row either, or the trail fills with withdrawals of
   * nothing and the real one gets harder to find. */
  if (!hadRow && !wasRequesting) return { ok: true, withdrawn: false, consent: hqConsentFor(n) };
  const d = hqDisclosure();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE hq_consents SET current=0 WHERE floor_no=? AND current=1").run(n);
    /* The withdrawal row is current=0 on purpose: current=1 means "a live acknowledgement
     * of these words", and a withdrawal is the opposite of one. Reading the trail is how
     * you see it happened. Its hash is of the words that were withdrawn from when they
     * are known, so the row says what was undone. */
    db.prepare(`INSERT INTO hq_consents (floor_no, wallet, action, version, disclosure_sha256, conditions, created_at, current)
                VALUES (?,?,'withdrawn',?,?,NULL,?,0)`)
      .run(n, wallet, had.version ?? d.version, had.sha256 ?? d.sha256, now);
    if (wasRequesting)
      db.prepare("UPDATE copy_settings SET bot_operator=NULL, bot_operator_at=? WHERE floor_no=?").run(now, n);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return { ok: false, error: String(e.message) }; }
  return { ok: true, withdrawn: true, consent: hqConsentFor(n),
    botOperator: db.prepare("SELECT bot_operator FROM copy_settings WHERE floor_no=?").get(n)?.bot_operator ?? null };
}

const openCount = (floorNo) => db.prepare(`
  SELECT COUNT(*) n FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? AND d.taken=1 AND c.status='live'`).get(floorNo).n;

/* HOW MANY POSITIONS A BOT MAY HOLD AT ONCE. Set by the desk, not the tenant: it is a
 * property of how this desk trades — several small clips running at once, each on its
 * own band's clock — and not a taste the customer should have to have. */
export const MAX_OPEN_POSITIONS = Number(process.env.DESK_MAX_OPEN_POSITIONS || 8);

/* The SOL price and the probe notional both moved to probe-size.js when the notional
 * stopped being a desk decision and became a MEASUREMENT of the bot's declared caps.
 * Re-exported here because this module was their address for a day and several
 * callers (and tests) know it by that name. */
export { sizingSolUsd, botProbeNotional } from "./probe-size.js";
import { botProbeNotional } from "./probe-size.js";

/* `probeSizeCapSol()` AND `probeSizingMismatch()` WERE HERE, and both are gone.
 *
 * They converted the exit probe's notional into a SOL ceiling and then applied it to
 * every delivery — the "probe cap" of bb4ae05, which shipped the same week the owner
 * ruled that the desk must never determine how much is bought. It was defended as
 * advisory, and it was still a number the desk chose being written onto a tenant's
 * board next to the word "capped". `probeSizingMismatch()` existed only to report which
 * floors had configured more than that ceiling, which is not a question the desk is
 * entitled to have an opinion about: a tenant's per-trade size is a setting on their own
 * machine.
 *
 * Every ceiling that matters is the bot's and runs on the real order — the operator
 * ceiling and maxSolPerTrade (executor/strategy.mjs:305), per-name risk, book heat, the
 * daily deploy cap and the spendable balance (:307-311), and the built order's measured
 * price impact against the pool (executor/jupiter.mjs:148-149).
 */

/**
 * WHO SIZES THE TRADE — a statement for the floor's screen, and nothing else.
 *
 * The owner has to be able to SEE that size is the bot's; a rule nobody can observe is
 * a rule that quietly stops holding. So this reports the ROUTE-PROBE notional the desk
 * quoted its exitability test at, whether that came from this floor's own bot or from
 * the stated fallback, and why. It carries no cap, no advisory size and no ceiling: an
 * earlier version returned `advisoryCapSol` and that field is deliberately absent, so
 * there is no number here for a client to mistake for an instruction.
 */
export function probeSizingForFloor(floorNo, opts = {}) {
  const probe = botProbeNotional({ ...opts, floorNo });
  return {
    sizeAuthority: "bot",
    probeSizeUsd: probe.sizeUsd,
    probeIsRouteTestOnly: true,
    probeFromBot: probe.fromBot,
    probeSource: probe.source,
    probeWhy: probe.why,
    botMaxSolPerTrade: probe.botSol,
    botSeenAt: probe.botSeenAt,
    solUsd: probe.solUsd,
    solUsdSource: probe.solUsdSource,
    note: probe.fromBot
      ? `Your bot decides how much it buys, and this desk never does. To check a coin can ` +
        `be SOLD at all it takes a round-trip quote at $${probe.sizeUsd} — ${probe.botSol} SOL, ` +
        `the per-trade cap your bot reported on its own heartbeat. That is a test amount, ` +
        `not a trade amount, and nothing the desk publishes is sized from it.`
      : `Your bot decides how much it buys, and this desk never does. With no bot cap to ` +
        `measure, its round-trip route test is quoted at $${probe.sizeUsd} (${probe.why}) — ` +
        `a test amount, not a trade amount.`,
  };
}

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
 * AND SINCE 2026-09-07 IT NO LONGER SIZES ANYTHING. This function used to end by
 * deriving `sizeSol` from the floor's fixed_sol or a fraction of its bankroll, capping
 * that to the desk's fraction-of-book, capping THAT to the exit probe's notional, and
 * refusing the call outright when the result was too small to clear Solana's fees. All
 * of it is gone. What is left is the only thing a per-floor decision can honestly be
 * about once size belongs to the bot: is this floor entitled to receive the call, and
 * does it have room for another position.
 */
export function decide(floorNo, call) {
  // Rent unpaid: the floor stops receiving NEW calls. It never stops receiving exits —
  // holding someone in a position over a billing dispute would be indefensible, and
  // exits are published to every floor regardless of what it owes.
  if (inArrears(floorNo))
    return { verdict: "skipped", reason: "rent is overdue — top up $CLAUDECO to resume new calls" };

  const open = openCount(floorNo);
  if (open >= MAX_OPEN_POSITIONS)
    return { verdict: "skipped", reason: `already holding ${open} of a maximum ${MAX_OPEN_POSITIONS}` };

  /* ═══════════════════════════════════════════════════════════════════════════════════
   * THE DESK PUBLISHES NO SIZE. NOT A NUMBER, NOT AN ESTIMATE, NOT AN ADVISORY ONE.
   *
   * FIVE THINGS USED TO HAPPEN BETWEEN HERE AND THE RETURN, and each was a money
   * decision the desk had no standing to make:
   *
   *   1. `autoSize` — bankroll x AUTO_RISK_PCT_PER_TRADE x the category's multiplier x
   *      the call's conviction. The desk sizing a stranger's wallet from its own taste.
   *   2. `fixed` — the floor's configured fixed_sol, echoed back as the delivered size.
   *      Reading the tenant's own setting and re-issuing it as an instruction adds
   *      nothing and makes the desk look like the author of a number it did not choose.
   *   3. `teamCapSol` — the tenant's size clamped to the same fraction-of-book the desk
   *      allocates on its paper equity. This is what produced a day of offers between
   *      0.0015 and 0.0092 SOL, every one correctly refused by the bot as unexecutable.
   *   4. The probe cap (bb4ae05) — clamped to the SOL value of the exit probe's
   *      notional. A ceiling derived from a size the desk itself invented.
   *   5. `MIN_EXECUTABLE_SOL` — skipping the call entirely when the resulting size was
   *      under ~0.02 SOL, "below that, network fees eat the trade". A fee judgment, made
   *      on a size the desk had just made up, that SUPPRESSED THE CALL: a coin the desk
   *      liked went unpublished because of arithmetic about somebody else's wallet.
   *
   * (5) is the one worth pausing on, because it shows why "advisory" was never true. A
   * number that can stop a call being offered is not advisory whatever it is labelled.
   *
   * EVERY ONE OF THESE JUDGMENTS EXISTS IN THE BOT, ON REAL INPUTS:
   *   size at all        executor/strategy.mjs:243-249  (Kelly/flat risk off its OWN equity)
   *   the fixed fund     executor/strategy.mjs:245      (its own FIXED_SOL, not the feed's)
   *   the hard ceiling   executor/strategy.mjs:246      (`Math.min(want, c.maxSolPerTrade)`)
   *   allocation caps    executor/strategy.mjs:307-311  (per-name risk, book heat, the
   *                                                      24h deploy cap, spendable balance)
   *   the fee floor      executor/strategy.mjs:232-234 and :313-321 — `feeFloorSol =
   *                      2 * feeReserve / (maxFeeShareOfStop * stopForFees)`, and a skip
   *                      when no size clears it. This is (5) done properly: judged
   *                      against the actual fee reserve, the actual stop and the actual
   *                      wallet, instead of against a bankroll figure typed into a form.
   *   can it leave       executor/jupiter.mjs:148-149   (the built order's price impact)
   *
   * WHAT ABOUT THE BOARD? The tenant's screen showed "0.0234 SOL" next to each call.
   * It now shows what the desk actually knows — the coin, the thesis, the levels, the
   * conviction — and the bot reports what it really bought (the bot_* fields further
   * down this file, written from its own fills). A real number from the wallet beats an
   * estimate from a desk that cannot see it.
   *
   * `size_sol` stays on the deliveries table as a NULL-able column: rows written before
   * today carry the number that was offered then, and erasing history to make the new
   * rule look older than it is would be dishonest. Every row written from here on is
   * null, and executor/strategy.mjs:247 refuses to read the field regardless.
   * ═══════════════════════════════════════════════════════════════════════════════════ */
  /* The category's NOTE, not its sizeMultiplier. The note says what kind of coin this is
     ("reflexive; the base rate is near zero"), which is a WHAT and belongs on a delivery;
     the multiplier is a HOW MUCH and is read nowhere in this file any more. */
  const kind = CATEGORY_RISK[call.category] ?? CATEGORY_RISK.unclear;
  return { verdict: "offered",
    /* NO SIZE. Explicitly null rather than absent, so a reader of a delivery row can
       tell "the desk declined to size this" from "this field was lost". */
    sizeSol: null,
    /* Retained and hard-coded false. It is the machine-readable half of the sentence
       below, and it must survive even if some future caller reintroduces a number. */
    sizeBinding: false,
    reason: `${call.category ?? "unclear"} — ${kind.note} · conviction ` +
      `${Math.round(call.conviction ?? 0)}/100 · your bot sizes this trade from its own ` +
      `caps; the desk does not size it, cap it, or judge whether it is worth the fees` };
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
