import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import { getCall } from "./calls.js";
/* THE BOT'S OWN DEFINITION OF "TRADEABLE", read here for the same reason penthouse.js
   reads it: an entry alert raised on geometry the bot deterministically refuses is not
   a slow trade, it is a dead one. One module, both processes — test-entry-contract-
   parity.mjs pins the hop count at 0 for every desk file that reaches it. */
import { entryContract, entryWindowMs } from "../executor/entry-contract.mjs";

/**
 * ALERTS — the desk can be right and the tenant still lose money because nobody told them.
 *
 * An exit that fires at 3am is worthless if it assumes someone is watching a browser tab.
 * So an exit is recorded as a durable, unread alert the moment it happens: it survives a
 * closed tab, a reload, and a week away, and it is only cleared when a human acknowledges it.
 *
 * Exit alerts are delivered to a floor REGARDLESS of arrears or unpaid fees. Gating an
 * exit on a billing dispute would trap someone in a position, which is indefensible.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no   INTEGER NOT NULL,
  call_id    INTEGER REFERENCES calls(id),
  kind       TEXT NOT NULL,          -- exit | entry
  urgency    TEXT NOT NULL DEFAULT 'normal',
  title      TEXT NOT NULL,
  body       TEXT,
  mint       TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  UNIQUE (floor_no, call_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_alerts_floor ON alerts(floor_no, id DESC);
`);
ensureColumn("copy_settings", "webhook_url", "TEXT");
// The executor lane: a tenant may point THEIR OWN trading bot at our calls.
// We post signed JSON; their machine verifies the HMAC and does what it likes
// with its own keys. The desk still signs nothing and custodies nothing.
ensureColumn("copy_settings", "executor_url", "TEXT");
ensureColumn("copy_settings", "executor_secret", "TEXT");

/**
 * Where a tenant may be pinged. Restricted on purpose: an arbitrary user-supplied URL that
 * the server fetches is a server-side request forgery hole, so only the messaging hosts
 * people actually use are accepted.
 */
const WEBHOOK_HOSTS = ["discord.com", "discordapp.com", "api.telegram.org", "hooks.slack.com"];

/** An executor endpoint: any public https host, never anything that smells internal. */
export function validExecutorUrl(url) {
  if (!url) return { ok: true, url: null };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "not a URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "must be https" };
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")
      || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":"))
    return { ok: false, error: "must be a public hostname, not an address" };
  return { ok: true, url: u.toString() };
}

/** Fire one signed event at a floor's executor. Best effort; never blocks an exit. */
export async function pushExecutor(floorNo, event) {
  // Polling is the durable, non-SSRF delivery path. Push delivery stays disabled until
  // it has a resolved-address egress policy and persistent retry outbox.
  if (process.env.EXECUTOR_WEBHOOKS_ENABLED !== "1") return false;
  const row = db.prepare("SELECT executor_url, executor_secret FROM copy_settings WHERE floor_no=?").get(floorNo);
  if (!row?.executor_url || !row?.executor_secret) return false;
  const eventId = `${floorNo}:${event.type}:${event.call?.id ?? "unknown"}`;
  const body = JSON.stringify({ v: 2, event_id: eventId, ts: Date.now(), floor: floorNo, ...event });
  const sig = crypto.createHmac("sha256", row.executor_secret).update(body).digest("hex");
  let t;
  try {
    const ctl = new AbortController();
    t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(row.executor_url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-cc-signature": sig }, body, signal: ctl.signal });
    return res.ok;
  } catch { return false; }
  finally { if (t) clearTimeout(t); }
}

export function validWebhook(url) {
  if (!url) return { ok: true, url: null };            // clearing it is valid
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "not a URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "must be https" };
  if (!WEBHOOK_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) {
    return { ok: false, error: `host must be one of: ${WEBHOOK_HOSTS.join(", ")}` };
  }
  return { ok: true, url: u.toString() };
}

export function raise({ floorNo, callId, kind, urgency = "normal", title, body, mint }) {
  try {
    db.prepare(`INSERT INTO alerts (floor_no,call_id,kind,urgency,title,body,mint,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(floorNo, callId ?? null, kind, urgency, title, body ?? null, mint ?? null, Date.now());
    emit("alert", { floorNo, callId, kind, urgency, title });
    return true;
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return false;   // already alerted; never spam
    throw e;
  }
}

export const unreadFor = (floorNo) =>
  db.prepare("SELECT * FROM alerts WHERE floor_no=? AND read_at IS NULL ORDER BY id DESC LIMIT 20").all(floorNo);

export const recentFor = (floorNo, n = 20) =>
  db.prepare("SELECT * FROM alerts WHERE floor_no=? ORDER BY id DESC LIMIT ?").all(floorNo, n);

export function acknowledge(floorNo, ids) {
  const now = Date.now();
  const stmt = db.prepare("UPDATE alerts SET read_at=? WHERE floor_no=? AND id=? AND read_at IS NULL");
  let n = 0;
  for (const id of ids || []) n += stmt.run(now, floorNo, Number(id)).changes;
  return n;
}

/** Best effort push. A webhook that fails must never hold up an exit reaching the room. */
async function push(url, title, body) {
  const v = validWebhook(url);
  if (!v.ok || !v.url) return false;
  const text = `${title}\n${body ?? ""}`.trim();
  const payload = v.url.includes("api.telegram.org")
    ? { text }                                  // telegram sendMessage needs chat_id in the URL
    : { content: text };                        // discord / slack
  let t;
  try {
    const ctl = new AbortController();
    t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(v.url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: ctl.signal });
    return res.ok;
  } catch { return false; }
  finally { if (t) clearTimeout(t); }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE ENTRY ALERT IS A CLOCK, SO RAISING ONE INTO A BOT THAT CANNOT ACT BURNS IT.
 *
 * The alert row's created_at IS the event's `ts` on the wire (office.js executorFeedPayload
 * serves `ts: r.created_at`), and that timestamp is what starts the call's expiry clock in
 * the bot (poller.mjs callExpiryMs, judged against `ev.ts`). So an alert raised while the
 * bot is paused, hard-stopped, holding an unresolved blocking intent, rolled back off the
 * feed, un-rehearsed, absent, or already in this very mint does not wait politely: it ages.
 * Under a blocking intent every entry in the batch is deferred and replayed against that
 * same clock, and a nano call — a 90s window on a 60s hold — is dead before the intent
 * resolves.
 *
 * HOLDING COSTS NOTHING. The delivery row is already durable; the alert is the only thing
 * with a clock, and reconcileMissingEntryAlerts (which the bot's own poll runs on every
 * tick) re-raises it the moment the floor is healthy again — with a FRESH created_at, i.e.
 * a full window. Past the band's own window the call is stamped not_executable instead, so
 * the cohort ledger can tell "the bot was down" from "the bot declined".
 *
 * A FLOOR WITH NO HEARTBEAT AT ALL IS NOT A FLOOR WITH A DOWN BOT. Every floor has an
 * executor_secret from the moment its copy settings exist (it is minted with them, not
 * configured), so the secret cannot distinguish a floor that runs a bot from one whose
 * tenant reads the Calls tab. The HEARTBEAT can: it exists only once a poller has posted
 * one. A floor that has never posted one has nothing to burn a window on and its alert is
 * a human notification, so the gate does not apply there and the behaviour is unchanged.
 *
 * NEITHER IS A BOT THAT SAYS IT IS REHEARSING. The gate applies only to a heartbeat whose
 * `mode` is "live", and the reason is not politeness — it is what the window is FOR. A
 * paper bot spends no money on an aged entry, and it reports no executionReadiness at all
 * (poller.mjs builds that block only under EXECUTE, because the rehearsal it records is a
 * live route probe), so judging it on that flag would hold every call from every paper
 * floor for ever. What a paper run produces instead is exactly the contract
 * executor/test-follow-through.mjs measures end to end: every published call reaches the
 * bot and is DECIDED on — held in the bot's own journal while a signed buy is unresolved,
 * and offered back to the same gates the moment it resolves. Holding those calls at the
 * desk would delete the one signal a rehearsal exists to produce, and protect nothing.
 * The bot that can lose money on a stale window is the live one, and it is gated.
 *
 * NONE OF THESE REASONS IS A PUBLISH GATE, and none is registered in calls.js GATE_CLASS
 * on purpose. gateFailures() answers "may this coin be published"; these answer "can THIS
 * floor's bot act on it right now", which is a fact about a machine and not about a mint.
 * They never reach gateClass(), so its default-deny cannot turn a paused laptop into an
 * un-waivable safety kill — the same separation the exit-alert namespace already keeps
 * (calls.js, the `cannot_exit` note). The GEOMETRY half of the gate reports the entry
 * contract's own codes, and those twelve ARE registered there explicitly.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** Why a floor's bot could not be handed an entry right now. Machine state, not coin facts. */
export const ENTRY_HOLD_REASONS = Object.freeze([
  "heartbeat_stale",       // the bot has been quiet longer than the entry itself lives
  "bot_hard_stop",         // the HARD STOP sentinel is present; nothing is automated
  "bot_entries_paused",    // the operator paused new exposure
  "bot_blocking_intent",   // an unresolved journal intent defers the whole batch
  "bot_feed_rollback",     // the bot has rolled itself back off this feed
  "bot_not_ready",         // no passing execution rehearsal (or a paper-mode bot, which has none)
  "mint_already_held",     // the bot is in this coin; the desk does not stack a second entry
]);

/** The floor's last self-reported pulse, read as "can this bot take an entry?".
 *  `bot:false` means no LIVE pulse was ever posted — no bot to burn a window on (an
 *  absent floor or a rehearsing one), so no gate. See the two carve-outs above. */
export function executorReadiness(floorNo, { now = Date.now(), windowMs = null } = {}) {
  let hb = null;
  try {
    const raw = db.prepare("SELECT executor_heartbeat FROM copy_settings WHERE floor_no=?")
      .get(Number(floorNo))?.executor_heartbeat;
    hb = raw ? JSON.parse(raw) : null;
  } catch { hb = null; }
  const none = (mode = null) => ({ bot: false, ready: true, reason: null, ageMs: null, held: [], mode });
  if (!hb || typeof hb !== "object" || Array.isArray(hb)) return none();
  if (String(hb.mode ?? "") !== "live") return none(hb.mode ?? null);

  const seenAt = Number(hb.seenAt) > 0 ? Number(hb.seenAt) : (Number(hb.ts) > 0 ? Number(hb.ts) : 0);
  const ageMs = seenAt > 0 ? now - seenAt : null;
  const held = Array.isArray(hb.held)
    ? hb.held.map((h) => String(h?.mint ?? "")).filter(Boolean) : [];
  const health = hb.health && typeof hb.health === "object" ? hb.health : null;
  const state = { bot: true, ageMs, held, seenAt, mode: "live" };
  const no = (reason) => ({ ...state, ready: false, reason });

  /* THE AGE IS JUDGED AGAINST THE ENTRY'S OWN WINDOW, not against the 60s heartbeat
     cadence: the question is not "is this bot chatty" but "will it still be here while
     this entry is worth taking". A caller with no window falls back to the same default
     the contract uses for a call with no band. */
  const window = Number(windowMs) > 0 ? Number(windowMs) : entryWindowMs({ holdMinMs: null });
  if (ageMs == null || ageMs > window) return no("heartbeat_stale");
  /* Ordered worst-first so the reason a tenant reads is the one they must act on. Each
     flag is sanitizeExecutorHealth's own boolean (office.js) — self-reported, already
     bounded, and only ever able to make this reading more conservative. */
  if (health?.hardStop === true) return no("bot_hard_stop");
  if (health?.entriesPaused === true) return no("bot_entries_paused");
  if (health?.blockingIntent === true) return no("bot_blocking_intent");
  if (health?.feedRollback === true) return no("bot_feed_rollback");
  if (health?.executionReadiness?.ready !== true) return no("bot_not_ready");
  return { ...state, ready: true, reason: null };
}

/** The newest observation on the call, exactly as the feed COALESCEs it (office.js). */
function markOn(call) {
  let row = null;
  try {
    row = db.prepare(`SELECT mark, ts FROM call_events
      WHERE call_id=? AND mark IS NOT NULL ORDER BY id DESC LIMIT 1`).get(call.id);
  } catch { row = null; }
  return { mark: row?.mark ?? call.entry_ref ?? null, markAt: row?.ts ?? call.opened_at ?? null };
}

/**
 * Should this floor be handed this entry right now — and if not, what says no?
 * Returns { bot, hold }: `hold` is null to raise, else { reason, windowMs, ageMs,
 * message, notExecutable }. `bot` says whether this floor has ever posted a pulse, which
 * is what decides whether the delivery is worth stamping at all.
 *
 * The call's own clock is `opened_at`, not the alert's: the alert is what this function
 * decides whether to create, so it cannot be its own timestamp. entryWindowMs is the
 * contract's, so "the band's window" has one definition on both sides of the fence.
 */
function entryGate(call, floorNo, { now = Date.now() } = {}) {
  const windowMs = entryWindowMs({ holdMinMs: call.hold_min_ms });
  const readiness = executorReadiness(floorNo, { now, windowMs });
  // No live bot on this floor (absent, or rehearsing): nothing to burn, so nothing to gate.
  if (!readiness.bot) return { bot: false, hold: null };
  const base = { windowMs, ageMs: readiness.ageMs, heartbeatSeenAt: readiness.seenAt ?? null };
  const no = (reason, message, extra = {}) => ({ bot: true,
    hold: { ...base, reason, message, ...extra } });
  if (readiness.reason)
    return no(readiness.reason, `the floor's bot is ${readiness.reason}`);
  if (call.mint && readiness.held.includes(String(call.mint)))
    return no("mint_already_held",
      `the bot already holds ${call.symbol || String(call.mint).slice(0, 6)}`);

  /* THE GEOMETRY, ON THE SAME ROW SHAPE THE FEED WILL SERVE. costPct is 0 for the reason
     publishCall states at length: what a round trip costs belongs to the process that
     knows the order size (owner, 2026-09-07), so `target_inside_cost` cannot fire from
     the desk. alertTs is the call's opening, which makes `window_expired` the ONE gate
     here that is terminal — an entry past its own band window will never come back. */
  const { mark, markAt } = markOn(call);
  const contract = entryContract({
    entryRef: call.entry_ref, entryLo: call.entry_lo, entryHi: call.entry_hi,
    stop: call.stop, target: call.target, mark, markAt, now,
    holdBand: call.hold_band ?? null, holdMinMs: call.hold_min_ms ?? null,
    alertTs: call.opened_at ?? null, costPct: 0,
  });
  if (contract.ok) return { bot: true, hold: null };
  return no(contract.gate, contract.detail?.message ?? contract.gate,
    { notExecutable: contract.gate === "window_expired" });
}

/** Was this delivery ever executable? See the column's note in copy.js. Never throws:
 *  bookkeeping must not be able to fail an alert. */
function stampDeliverable(callId, floorNo, value) {
  try {
    return db.prepare(`UPDATE deliveries SET deliverable=? WHERE call_id=? AND floor_no=?
                         AND (deliverable IS NULL OR deliverable <> ?)`)
      .run(value, callId, floorNo, value).changes > 0;
  } catch { return false; }
}

/* ONE DEXSCREENER READ WHEN AN ALERT IS HELD, and a witness mark from it.
 *
 * A held alert is re-raised later, and the contract it must pass then is judged on the
 * newest marked call_event — which, without this, is the publish-time witness aging past
 * MARK_MAX_AGE_MS (15m). Every band but nano holds for longer than that, so a call held
 * for a paused bot would come back refused as `mark_stale`: cured by the wait, killed by
 * the ruler. One read per announcement, not per floor — it is one mint.
 *
 * INJECTED, NOT IMPORTED. penthouse.js imports announceExit from this file, so a static
 * import back would be a module cycle; the desk process has both modules loaded already,
 * which makes the dynamic import a lookup rather than a load. writeWitnessMark is used
 * rather than noteEvent because it is THE ONE DOOR a witness mark enters by (its own note
 * in penthouse.js): the spacing rule that stops one observation confirming itself. */
async function witnessOnHold(call, deps = null) {
  try {
    const d = deps ?? await (async () => {
      const [ds, pent] = await Promise.all([
        import("./data/dexscreener.js"), import("./penthouse.js"),
      ]);
      return { pairsFor: ds.pairsFor, consensus: ds.consensus, writeWitnessMark: pent.writeWitnessMark };
    })();
    const px = await d.pairsFor(call.mint);
    if (!px?.ok) return null;
    const cons = d.consensus(px.pairs);
    if (!cons?.ok || !(cons.priceUsd > 0)) return null;
    return d.writeWitnessMark(call.id, cons.priceUsd) ? cons.priceUsd : null;
  } catch { return null; }
}

/**
 * A new call is worth waking up for too. The trade loop STARTS with knowing the
 * call exists: a tenant whose tab was closed at 3am used to learn about an entry
 * only by opening the Calls pane later — and about the desk's work only at the
 * exit. Durable alert + webhook, same machinery as exits, kind 'entry'.
 */
/**
 * THE ONE COMPLETELY SILENT WAY A PUBLISHED CALL CAN VANISH.
 *
 * broadcast() writes the delivery row durably and then fires announceEntry WITHOUT
 * awaiting it — `.then(...).catch(() => {})` in copy.js. The alerts table is the bot's
 * ONLY entry channel, so if that write never lands the call sits for ever as
 * verdict='offered' while the bot polls an empty feed. Nothing logs anything: the
 * executor's own "not offered" reporter deliberately skips verdict='offered', because
 * from its side the call simply is not there.
 *
 * Nothing anywhere re-created a missing alert, so this repairs it from the durable side.
 * It is called by the feed route, which means the bot's own poll heals the gap on its
 * next tick. raise() is idempotent through UNIQUE(floor_no, call_id, kind), so a
 * repeated sweep cannot duplicate an alert, and a call the desk has already closed is
 * deliberately left alone — resurrecting a dead call is worse than losing it.
 *
 * IT IS ALSO THE RE-RAISE FOR A HELD ALERT. announceEntry withholds an entry from a floor
 * whose bot cannot act on it (see the readiness gate above), which leaves EXACTLY the row
 * shape this sweep already looks for: an offered delivery with no entry alert on a live
 * call. So the same poll that heals a lost write hands over a held one the moment the
 * floor is healthy — with a fresh created_at, and therefore a full window rather than the
 * remains of one. Past the band's own window the entry is dead however healthy the bot
 * gets, so the delivery is stamped not_executable instead and never raised: the ledger
 * can then tell a bot that was down from a bot that declined.
 *
 * SYNCHRONOUS, DELIBERATELY. office.js calls it fire-and-forget inside a try/catch on
 * every feed poll; an async version's rejection would escape that catch as an unhandled
 * rejection. The DexScreener witness read therefore lives on announceEntry's hold path
 * only — the poll that runs this is already the bot's, seconds apart.
 */
/* THE ROW SHAPE A HELD CALL HAS: offered to this floor, live, and with no entry alert
 * yet. The repair sweep below and heldEntriesFor() must look at exactly the same set —
 * a report that disagreed with the sweep about what is being withheld would be worse
 * than no report, so they share one query rather than two that drift apart. */
function unraisedOfferedEntries(floorNo, { withinMs, limit, now }) {
  try {
    return db.prepare(`
      SELECT d.call_id, d.size_sol, d.delivered_at, c.*
        FROM deliveries d
        JOIN calls c ON c.id = d.call_id
        LEFT JOIN alerts a
          ON a.floor_no = d.floor_no AND a.call_id = d.call_id AND a.kind = 'entry'
       WHERE d.floor_no = ? AND d.verdict = 'offered' AND a.id IS NULL
         AND c.status = 'live' AND d.delivered_at > ?
       ORDER BY d.delivered_at DESC LIMIT ?`)
      .all(floorNo, now - withinMs, Math.max(1, Math.min(100, limit)));
  } catch { return null; }
}

/**
 * WHAT THIS FLOOR IS NOT BEING TOLD, AND WHY — the read the 2026-09-12 outage needed.
 *
 * A live macOS install comes up entry-paused on purpose, and the operator's had been
 * paused since its release adoption on 09-11. Four calls were published to floor 50 that
 * afternoon. Every one was offered, every one was held by entryGate for
 * `bot_entries_paused`, and NOTHING anywhere said so for a day and a half:
 *
 *   - the desk holds silently by design (see the sweep below: announcing each wait would
 *     be a bus event every five seconds), so only the first hold emitted an event, which
 *     scrolled off the page's event strip the minute it appeared;
 *   - the bot logs its pause only when an entry ARRIVES, and none ever did, because the
 *     hold is what stops it arriving. The one message that would name the cause is
 *     unreachable precisely when the cause is present;
 *   - the floor's board said "your bot is not in this one", which reads as the bot having
 *     passed on the call rather than never having been handed it;
 *   - and the feed the bot polls carried no trace at all: `latest_id` simply sat where it
 *     was, which is indistinguishable from a desk that has published nothing.
 *
 * Four silences, one state. So the state gets published: read-only, derived from the same
 * durable rows and the same gate, and served everywhere the question is asked — the feed
 * (curl-able with the floor's own secret), the floor's board, and the owner's heartbeat.
 * A held call must never again be reachable only by reading this file.
 *
 * Read-only, DELIBERATELY: no raise, no stamp, no emit. The sweep owns every transition;
 * this only reports. A floor with no live bot returns [] rather than a list of holds,
 * because entryGate raises for such a floor instead of holding — nothing is withheld.
 */
export function heldEntriesFor(floorNo, { withinMs = 6 * 3600e3, limit = 20, now = Date.now() } = {}) {
  const rows = unraisedOfferedEntries(floorNo, { withinMs, limit, now });
  if (!rows?.length) return [];
  const out = [];
  for (const r of rows) {
    let hold = null;
    // A report must not be able to fail a poll: office.js serves this inside the feed.
    try { ({ hold } = entryGate(r, floorNo, { now })); } catch { hold = null; }
    if (!hold) continue;
    out.push({
      call_id: r.call_id,
      mint: r.mint ?? null,
      symbol: r.symbol || (r.mint ? String(r.mint).slice(0, 6) : null),
      reason: hold.reason,
      detail: hold.message ?? null,
      /* Terminal: the band's window has closed and no amount of fixing the bot brings
         this one back. The operator needs that distinction to know whether to hurry. */
      not_executable: hold.notExecutable === true,
      window_ms: hold.windowMs ?? null,
      bot_age_ms: hold.ageMs ?? null,
      heartbeat_seen_at: hold.heartbeatSeenAt ?? null,
      delivered_at: r.delivered_at ?? null,
      held_for_ms: r.delivered_at ? Math.max(0, now - r.delivered_at) : null,
    });
  }
  return out;
}

export function reconcileMissingEntryAlerts(floorNo, { withinMs = 6 * 3600e3, limit = 20, now = Date.now() } = {}) {
  const rows = unraisedOfferedEntries(floorNo, { withinMs, limit, now });
  if (!rows) return 0;

  let repaired = 0;
  for (const r of rows) {
    const sym = r.symbol || String(r.mint).slice(0, 6);
    /* The gate again, on the durable row. A held alert stays held silently — this runs on
       every poll, so announcing each wait would be a bus event every few seconds — and
       only the terminal verdict speaks. */
    const { bot, hold } = entryGate(r, floorNo, { now });
    if (hold) {
      if (hold.notExecutable) {
        stampDeliverable(r.call_id, floorNo, 0);
        emit("call:entry_held", { floorNo, callId: r.call_id, mint: r.mint, symbol: sym,
          reason: hold.reason, windowMs: hold.windowMs, botAgeMs: hold.ageMs,
          notExecutable: true, detail: hold.message });
      }
      continue;
    }
    const fresh = raise({
      floorNo, callId: r.call_id, kind: "entry", urgency: "normal",
      title: `New call — ${sym}`,
      body: `${r.thesis || "The desk has published a call."}\n` +
        `Open your floor's Calls tab for the ticket. Your bot sizes this trade from its ` +
        `own caps — the desk does not.\n` +
        `This is research; you trade from your own wallet or not at all.`,
      mint: r.mint,
    });
    if (fresh) {
      repaired++;
      if (bot) stampDeliverable(r.call_id, floorNo, 1);
      emit("alert:repaired", { floorNo, callId: r.call_id, symbol: sym,
        note: "an offered delivery had no entry alert; the bot could never have seen this call" });
    }
  }
  return repaired;
}

export async function announceEntry(call, { now = Date.now(), witnessDeps = null } = {}) {
  const rows = db.prepare(`SELECT d.floor_no, d.size_sol, c.webhook_url
                           FROM deliveries d LEFT JOIN copy_settings c ON c.floor_no = d.floor_no
                           WHERE d.call_id=? AND d.verdict='offered'`).all(call.id);
  const sym = call.symbol || call.mint.slice(0, 6);
  /* The DURABLE row, not the caller's object: hold_min_ms, hold_band, entry_lo/hi and
     opened_at are what the gate is judged on, and a caller may hand us a projection. */
  const row = getCall(call.id) ?? call;
  let sent = 0, held = 0;
  for (const r of rows) {
    /* ── THE READINESS + GEOMETRY GATE ────────────────────────────────────────────
       Before raise(), because raise() is what starts the clock. A held alert leaves the
       delivery exactly as it was — verdict 'offered', deliverable unjudged — so the
       reconciler below re-raises it with a full window the moment the floor is healthy. */
    const { bot, hold } = entryGate(row, r.floor_no, { now });
    if (hold) {
      held++;
      if (hold.notExecutable) stampDeliverable(call.id, r.floor_no, 0);
      emit("call:entry_held", { floorNo: r.floor_no, callId: call.id, mint: call.mint,
        symbol: sym, reason: hold.reason, windowMs: hold.windowMs, botAgeMs: hold.ageMs,
        notExecutable: hold.notExecutable === true, detail: hold.message });
      continue;
    }
    const title = `New call — ${sym}`;
    /* THE SIZE CAME OUT OF THIS SENTENCE ON 2026-09-07. It read "Your floor sized it at
       X SOL", which was untrue twice over even then — the floor did not size it, the desk
       did, and the bot ignored the number. With decide() publishing no size, `r.size_sol`
       is null on every new delivery and the sentence would have read "sized it at ? SOL".
       An alert is the first thing a tenant sees about a call; it must not be the place a
       stale field surfaces as a question mark. */
    const body = `${call.thesis || "The desk has published a call."}\n` +
      `Open your floor's Calls tab for the ticket. Your bot sizes this trade from its ` +
      `own caps — the desk does not.\n` +
      `This is research; you trade from your own wallet or not at all.`;
    const fresh = raise({ floorNo: r.floor_no, callId: call.id, kind: "entry",
      urgency: "normal", title, body, mint: call.mint });
    if (fresh && r.webhook_url) push(r.webhook_url, title, body).catch(() => {});
    if (fresh) pushExecutor(r.floor_no, { type: "entry", call: { id: call.id, mint: call.mint,
      symbol: call.symbol, side: "buy", entry_ref: call.entry_ref, stop: call.stop,
      /* Still on the wire for older clients; null on everything written since
         2026-09-07, and non-binding either way (executor/strategy.mjs:247). */
      target: call.target, size_sol: r.size_sol ?? null, size_binding: false, thesis: call.thesis,
      invalidation: call.invalidation } }).catch(() => {});
    /* Stamped 1 only when there IS a bot: the column records whether a delivery was ever
       executable, and a floor with no executor at all has no such fact to record. NULL
       already counts as deliverable in the ledger (calls.js cycleExecution). */
    if (fresh) { sent++; if (bot) stampDeliverable(call.id, r.floor_no, 1); }
  }
  /* One read for the mint, only when something was actually held — see witnessOnHold. */
  if (held) await witnessOnHold(row, witnessDeps);
  return { floors: rows.length, alerted: sent, held };
}

/* THE ONE PLACE AN EXIT ALERT'S WORDS AND URGENCY ARE DECIDED. announceExit and the
 * repair sweep below both go through here, so a repaired alert is byte-for-byte what
 * the live one would have been — the bot reads urgency and title off this row. */
export function exitAlertText(call, exit) {
  const sym = call.symbol || String(call.mint).slice(0, 6);
  return {
    title: exit.urgency === "unconditional" ? `EXIT NOW — ${sym}` : `Exit called — ${sym}`,
    body: `${exit.detail}\nThis is a research call. Sell in your own wallet; the desk cannot and does not.`,
    urgency: exit.urgency === "unconditional" ? "urgent" : "normal",
  };
}

/* The urgency each close code was announced with when it fired live: the chain-fact
 * exits are unconditional (calls.evaluateExit), went_dark is urgent (penthouse), and
 * every price exit and thesis_stale is a level. A repaired alert must carry the same
 * urgency the original would have, or the bot would treat a rug like a target.
 *
 * `cannot_exit` IS A HISTORICAL CODE. Its trigger was deleted from calls.evaluateExit on
 * 2026-09-07 (a cost ceiling the desk had no business firing on; see the note at its old
 * site). Nothing raises it any more, and the entry stays because this table REPAIRS
 * alerts for exits already in the journal — a live call closed under that code before
 * the deletion must still announce with the urgency it actually had. */
const EXIT_URGENCY_BY_CODE = Object.freeze({
  authority_appeared: "unconditional", cannot_exit: "unconditional", liq_collapse: "unconditional",
  went_dark: "urgent",
});

/**
 * Fan an exit out to every floor that was offered the call. Deliberately not filtered by
 * arrears, unpaid fees, or whether the tenant said they took it — someone who quietly
 * bought without pressing the button still needs to hear that it is time to leave.
 */
export async function announceExit(call, exit) {
  const rows = db.prepare(`SELECT d.floor_no, c.webhook_url
                           FROM deliveries d LEFT JOIN copy_settings c ON c.floor_no = d.floor_no
                           WHERE d.call_id=? AND d.verdict='offered'`).all(call.id);
  const { title, body, urgency } = exitAlertText(call, exit);

  let sent = 0;
  for (const r of rows) {
    const fresh = raise({ floorNo: r.floor_no, callId: call.id, kind: "exit",
      urgency, title, body, mint: call.mint });
    // Fire and forget. Awaiting here let ONE hung webhook burn its full timeout and
    // hold up every later floor's exit alert — and the executor feed row that tells
    // a bot to sell. Nobody's exit may wait on someone else's Discord.
    if (fresh && r.webhook_url) push(r.webhook_url, title, body).catch(() => {});
    if (fresh) pushExecutor(r.floor_no, { type: "exit", call: { id: call.id, mint: call.mint,
      symbol: call.symbol, side: "sell", code: exit.code, urgency: exit.urgency,
      detail: exit.detail } }).catch(() => {});
    if (fresh) sent++;
  }
  return { floors: rows.length, alerted: sent };
}

/**
 * THE EXIT THAT WENT MISSING IS THE ONE THE BOT COULD NEVER RECOVER FROM.
 *
 * An exit alert is the desk's only outbound sell signal to a bot, and it is raised
 * exactly once per (floor, call) — UNIQUE(floor_no, call_id, kind). announceExit is
 * fired without being awaited from fireExit, went_dark and thesis_stale alike, so a
 * write that fails in flight leaves a CLOSED call with no exit row on the floor: the
 * bot polls, sees nothing, and holds a coin the desk has already left. Entries had a
 * repair sweep since 2026-09-03; exits had none, and under desk-led exits (Shrek call
 * 55, 2026-09-05 — the bot must sell exactly what the desk determined, when it hears
 * it) a lost exit alert is a position with no exit at all.
 *
 * Same shape as the entry repair: durable side, bounded, idempotent through the
 * UNIQUE index, run by the bot's own feed poll. The words and urgency come from the
 * same helper announceExit uses, keyed off the close code the call was closed with,
 * so the repaired row is what the live one would have been.
 */
export function reconcileMissingExitAlerts(floorNo, { withinMs = 6 * 3600e3, limit = 20, now = Date.now() } = {}) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT c.*, cs.webhook_url
        FROM deliveries d
        JOIN calls c ON c.id = d.call_id
        LEFT JOIN copy_settings cs ON cs.floor_no = d.floor_no
        LEFT JOIN alerts a
          ON a.floor_no = d.floor_no AND a.call_id = d.call_id AND a.kind = 'exit'
       WHERE d.floor_no = ? AND d.verdict = 'offered' AND a.id IS NULL
         AND c.status = 'closed' AND c.closed_at > ?
       ORDER BY c.closed_at DESC LIMIT ?`)
      .all(floorNo, now - withinMs, Math.max(1, Math.min(100, limit)));
  } catch { return 0; }

  let repaired = 0;
  for (const call of rows) {
    const code = call.close_reason || "closed";
    const exit = { code, urgency: EXIT_URGENCY_BY_CODE[code] ?? "level",
      detail: `${code.replace(/_/g, " ")}` +
        (call.close_mark != null ? ` at $${call.close_mark}` : "") +
        ` — the desk closed this call at ${new Date(call.closed_at).toISOString()}; ` +
        `this alert is a repair, the original never landed` };
    const { title, body, urgency } = exitAlertText(call, exit);
    const fresh = raise({ floorNo, callId: call.id, kind: "exit", urgency, title, body, mint: call.mint });
    if (!fresh) continue;
    repaired++;
    if (call.webhook_url) push(call.webhook_url, title, body).catch(() => {});
    pushExecutor(floorNo, { type: "exit", call: { id: call.id, mint: call.mint, symbol: call.symbol,
      side: "sell", code, urgency: exit.urgency, detail: exit.detail } }).catch(() => {});
    emit("alert:repaired", { floorNo, callId: call.id, kind: "exit", symbol: call.symbol || String(call.mint).slice(0, 6),
      code, note: "a closed call had no exit alert on this floor; the bot could never have heard the exit" });
  }
  return repaired;
}
