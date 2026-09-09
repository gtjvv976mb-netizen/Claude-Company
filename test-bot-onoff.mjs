/**
 * THE OFF/ON BUTTON — A REAL CONTROL THAT GIVES THE SERVER NO POWER IT MUST NOT HAVE.
 *
 * The owner asked for "an off/on button" (2026-09-09). The line that does not move is
 * that the desk holds no key, runs no bot, and has no channel to push anything at one:
 * the bot POLLS /executor/feed and POSTs a heartbeat, and the page says so in as many
 * words. So the switch is built as the only shape that keeps all of that true — a
 * boolean the tenant writes on their own floor, which rides on the feed the bot already
 * fetches, and which the bot obeys or does not, on its own machine.
 *
 * WHAT IS REAL HERE. src/office.js startOffice() on a throwaway database with real
 * ed25519 wallet sessions; the real /api/floor/N/bot-run route; the real
 * executorFeedPayload; and executor/poller.mjs spawned as a SUBPROCESS against that
 * office, with its real tick loop, feed cursor, entry gates and desk-led exit path.
 *
 * WHAT IS STUBBED. EXECUTE=0 throughout, as the rules require, so the buy leg is the
 * bot's DECISION and the sell leg is the bot REACHING the point of executing the desk's
 * determination — neither is a settled trade. That is enough for this file's subject,
 * which is whether the switch is consulted at all and on which lane. The held position
 * is written into the journal as a confirmed intent (the technique
 * executor/test-recovery-accounting.mjs uses); the accounting that turns it into a
 * position is the real one.
 *
 * THE FIVE PROPERTIES, and each is asserted in its dangerous direction:
 *   1. the floor's owner can set off and on; nobody else can, and a BOT holding the
 *      feed secret cannot either — a stolen feed key must not switch trading back on;
 *   2. the flag reaches the `rules` block of the feed the bot polls;
 *   3. while OFF the bot opens nothing — and still EXITS what it already holds, because
 *      an off switch that strands an open position is a trap;
 *   4. a LOCAL hard stop beats a server "on", absolutely;
 *   5. the page shows the bot's ECHO, and says pending until the bot has confirmed.
 *
 *   CLAUDE_CO_DB=/tmp/onoff-$$.db node test-bot-onoff.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
/* @solana/web3.js is installed under executor/, not at the root — the desk deliberately
   keeps the trading dependency out of the server's tree. Resolved from there, the way
   test-sim-c.mjs does. */
const { Keypair } = createRequire(path.join(ROOT, "executor/"))("@solana/web3.js");
const POLLER = path.join(ROOT, "executor", "poller.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bot-onoff-"));
process.env.CLAUDE_CO_DB = path.join(TMP, "office.db");
process.env.DESK_MAX_OPEN_POSITIONS = "64";
process.env.NODE_NO_WARNINGS = "1";

const { encode } = await import("./src/lib/base58.js");
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { wallet: encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), privateKey };
}
const tenant = keypair(), stranger = keypair(), boss = keypair();
process.env.HQ_OWNER_WALLET = boss.wallet;

const db = (await import("./src/lib/store.js")).default;
const auth = await import("./src/auth.js");
await import("./src/tower.js");
const copy = await import("./src/copy.js");
const { openCall, closeCall, getCall, noteEvent, evaluateExit, liveCalls } = await import("./src/calls.js");
const { announceExit } = await import("./src/alerts.js");
const { startOffice, executorFeedPayload, executorHeartbeatPayload, executorStatusPayload,
  sanitizeExecutorHealth } = await import("./src/office.js");
const { botRunControl, EXECUTOR_HEARTBEAT_STALE_MS } = await import("./src/executor-dashboard.js");
const { ExecutionJournal } = await import("./executor/journal.mjs");
const { WSOL } = await import("./executor/jupiter.mjs");
const { freshState } = await import("./executor/strategy.mjs");

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  cond ? pass++ : (fail++, failures.push(name));
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(cond);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLOOR = 41, OTHER_FLOOR = 42;
const SECRET = "bot-onoff-test-secret-0123456789abcdef";

const lease = (floorNo, wallet, name) => {
  db.prepare("INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)")
    .run(floorNo, wallet, "0", name, Date.now());
  db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
    .run(wallet, name, Date.now(), floorNo);
};
lease(FLOOR, tenant.wallet, "Forty-First Floor");
lease(OTHER_FLOOR, stranger.wallet, "Forty-Second Floor");
copy.settingsFor(FLOOR);
db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=?").run(SECRET, FLOOR);

function signIn({ wallet, privateKey }) {
  const { nonce, message } = auth.issueNonce(wallet);
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), privateKey);
  const r = auth.verifySignature({ wallet, nonce, signatureB58: encode(sig) });
  if (!r.ok) throw new Error(`sign-in failed: ${r.error}`);
  return r.token;
}
const tokenTenant = signIn(tenant), tokenStranger = signIn(stranger);

for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

const { server: office } = startOffice(0);
await once(office, "listening");
const BASE = `http://127.0.0.1:${office.address().port}`;

const runRoute = async (floor, { token = tokenTenant, method = "GET", body, bearer } = {}) => {
  const headers = { "content-type": "application/json" };
  const authValue = bearer ?? (token == null ? null : `Bearer ${token}`);
  if (authValue) headers.authorization = authValue;
  const r = await fetch(`${BASE}/api/floor/${floor}/bot-run`, { method, headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const storedFlag = (floorNo = FLOOR) =>
  db.prepare("SELECT entries_enabled, entries_enabled_at FROM copy_settings WHERE floor_no=?").get(floorNo);

/* ══════════════════════════════════════════════════════════════════════════════
   1 — THE PROJECTION THE PAGE RENDERS. Pure, so the honesty rule (never show the
   request as though it were the bot's state) is testable without a browser.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n1 — THE PAGE'S PROJECTION: request vs echo");
const NOW = 1_757_000_000_000;
{
  const never = botRunControl({ requested: true, requestedAt: NOW - 1000, nowMs: NOW });
  console.log(`       no bot ever: chip=${never.chip} state=${never.state} pending=${never.pending} ` +
    `confirmed=${never.confirmed} echo=${JSON.stringify(never.echo)}`);
  ok("a floor whose bot has never checked in is PENDING, not ON",
    never.pending === true && never.state === "pending" && never.chip === "ON · PENDING",
    `chip=${never.chip} state=${never.state}`);
  ok("...and it says the bot has not heard it", /has not checked in/.test(never.sentence), never.sentence);

  const justAsked = botRunControl({ requested: false, requestedAt: NOW,
    echoedDesk: true, echoedEffective: true, heartbeatSeenAt: NOW - 5_000, nowMs: NOW });
  console.log(`       OFF asked, bot still echoing ON: chip=${justAsked.chip} state=${justAsked.state} ` +
    `pending=${justAsked.pending} echo.desk=${justAsked.echo.deskEntriesEnabled}`);
  ok("a fresh OFF a live bot has not echoed yet is PENDING",
    justAsked.pending === true && justAsked.chip === "OFF · PENDING" && justAsked.state === "pending",
    `chip=${justAsked.chip}`);

  const confirmedOff = botRunControl({ requested: false, requestedAt: NOW - 60_000,
    echoedDesk: false, echoedEffective: false, heartbeatSeenAt: NOW - 5_000, nowMs: NOW });
  console.log(`       OFF confirmed: chip=${confirmedOff.chip} state=${confirmedOff.state} ` +
    `confirmed=${confirmedOff.confirmed} sentence=${JSON.stringify(confirmedOff.sentence)}`);
  ok("once the bot echoes it back, the page shows OFF",
    confirmedOff.confirmed === true && confirmedOff.state === "off" && confirmedOff.chip === "OFF",
    `chip=${confirmedOff.chip} confirmed=${confirmedOff.confirmed}`);
  ok("...and says it still sells what it holds", /still manages and sells/.test(confirmedOff.sentence),
    confirmedOff.sentence);

  /* THE RULER, CHECKED AGAINST A CASE WHOSE ANSWER IS KNOWN. A stale pulse that happens
     to carry the value just asked for must NOT read as a confirmation, or "confirmed"
     would be a word that appears whenever the two numbers coincide. */
  const stale = botRunControl({ requested: false, requestedAt: NOW - 60_000,
    echoedDesk: false, echoedEffective: false,
    heartbeatSeenAt: NOW - (EXECUTOR_HEARTBEAT_STALE_MS + 1_000), nowMs: NOW });
  console.log(`       matching echo but stale by ${EXECUTOR_HEARTBEAT_STALE_MS + 1_000}ms: ` +
    `chip=${stale.chip} confirmed=${stale.confirmed} connected=${stale.echo.connected}`);
  ok("a STALE heartbeat cannot confirm, even carrying the right value",
    stale.confirmed === false && stale.chip === "OFF · PENDING" && stale.echo.connected === false,
    `chip=${stale.chip} confirmed=${stale.confirmed}`);

  /* The echo wins the display: a floor asking ON whose bot reports entries refused is a
     bot held by its own local sentinel, and the page must not paper over it. */
  const heldLocally = botRunControl({ requested: true, requestedAt: NOW - 60_000,
    echoedDesk: true, echoedEffective: false, heartbeatSeenAt: NOW - 5_000, nowMs: NOW });
  console.log(`       asked ON, bot's own switch refusing: chip=${heldLocally.chip} ` +
    `state=${heldLocally.state} sentence=${JSON.stringify(heldLocally.sentence)}`);
  ok("a bot refusing locally reads OFF even though the floor asked ON",
    heldLocally.state === "off" && /its own switch, on its machine, is refusing/.test(heldLocally.sentence),
    `state=${heldLocally.state}`);
  ok("...and the payload names the delivery as a poll, never a push",
    heldLocally.delivery === "bot-polls-feed-no-push" &&
    /open no new positions/.test(heldLocally.meaning), heldLocally.meaning);
}

/* ══════════════════════════════════════════════════════════════════════════════
   2 — THE ROUTE. Whose switch it is, and whose it is not.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n2 — THE ROUTE: the tenant's switch, and nobody else's");
{
  const g = await runRoute(FLOOR);
  console.log(`       GET as the floor's owner -> HTTP ${g.status} requested=${g.json?.requested} ` +
    `chip=${g.json?.chip} pending=${g.json?.pending}`);
  ok("the floor's owner can read the switch", g.status === 200, `HTTP ${g.status}`);
  ok("...and a floor that has never touched it is ON by default",
    g.json?.requested === true, `requested=${JSON.stringify(g.json?.requested)}`);
  ok("...but PENDING, because no bot has confirmed anything",
    g.json?.pending === true && g.json?.state === "pending", `state=${g.json?.state}`);

  const off = await runRoute(FLOOR, { method: "POST", body: { enabled: false } });
  console.log(`       POST {enabled:false} -> HTTP ${off.status} requested=${off.json?.requested} ` +
    `chip=${off.json?.chip} column entries_enabled=${storedFlag().entries_enabled}`);
  ok("the owner can turn it off", off.status === 200 && off.json?.requested === false,
    `HTTP ${off.status} requested=${off.json?.requested}`);
  ok("...and the column says so", storedFlag().entries_enabled === 0 && storedFlag().entries_enabled_at > 0,
    `entries_enabled=${storedFlag().entries_enabled} at=${storedFlag().entries_enabled_at}`);

  const on = await runRoute(FLOOR, { method: "POST", body: { run: "on" } });
  console.log(`       POST {run:"on"} -> HTTP ${on.status} column entries_enabled=${storedFlag().entries_enabled}`);
  ok("...and back on", on.status === 200 && on.json?.requested === true && storedFlag().entries_enabled === 1,
    `HTTP ${on.status} column=${storedFlag().entries_enabled}`);

  const anon = await runRoute(FLOOR, { token: null, method: "POST", body: { enabled: false } });
  const other = await runRoute(FLOOR, { token: tokenStranger, method: "POST", body: { enabled: false } });
  console.log(`       no session -> HTTP ${anon.status} · another tenant -> HTTP ${other.status} · ` +
    `column entries_enabled=${storedFlag().entries_enabled}`);
  ok("a signed-out visitor cannot switch this floor", anon.status === 401, `HTTP ${anon.status}`);
  ok("another tenant cannot switch this floor", other.status === 403, `HTTP ${other.status}`);
  ok("...and neither of them changed anything", storedFlag().entries_enabled === 1,
    `entries_enabled=${storedFlag().entries_enabled}`);

  /* THE FEED SECRET IS A CREDENTIAL A PROCESS HOLDS. If it could vote, a leaked feed
     key would be a way to switch somebody's trading back on — the exact thing the whole
     no-control-channel design exists to prevent. */
  const asBot = await runRoute(FLOOR, { bearer: `Bearer ${SECRET}`, method: "POST", body: { enabled: false } });
  console.log(`       the executor secret as bearer -> HTTP ${asBot.status} · ` +
    `column entries_enabled=${storedFlag().entries_enabled}`);
  ok("the bot's own feed secret cannot switch its owner's floor",
    asBot.status === 401 && storedFlag().entries_enabled === 1,
    `HTTP ${asBot.status} column=${storedFlag().entries_enabled}`);

  const junk = await runRoute(FLOOR, { method: "POST", body: { enabled: "false" } });
  console.log(`       POST {enabled:"false"} (a string) -> HTTP ${junk.status} ` +
    `error=${JSON.stringify(junk.json?.error)} column=${storedFlag().entries_enabled}`);
  ok("a value that is not a boolean is refused, not coerced",
    junk.status === 400 && storedFlag().entries_enabled === 1,
    `HTTP ${junk.status} column=${storedFlag().entries_enabled}`);

  const empty = await runRoute(FLOOR, { method: "POST", body: {} });
  ok("...and so is a body that says nothing at all", empty.status === 400 && storedFlag().entries_enabled === 1,
    `HTTP ${empty.status} column=${storedFlag().entries_enabled}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   3 — THE FLAG REACHES THE FEED THE BOT POLLS.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n3 — THE FEED the bot polls carries it");
{
  const onRules = executorFeedPayload(FLOOR, 0).rules;
  console.log(`       rules while ON: entries_enabled=${onRules.entries_enabled} ` +
    `entries_enabled_at=${onRules.entries_enabled_at}`);
  ok("the feed's rules block states the switch", onRules.entries_enabled === true,
    `entries_enabled=${onRules.entries_enabled}`);

  await runRoute(FLOOR, { method: "POST", body: { enabled: false } });
  const offRules = executorFeedPayload(FLOOR, 0).rules;
  console.log(`       rules after turning it off: entries_enabled=${offRules.entries_enabled}`);
  ok("...and follows it off", offRules.entries_enabled === false, `entries_enabled=${offRules.entries_enabled}`);

  const wire = await fetch(`${BASE}/api/floor/${FLOOR}/executor/feed?after=0`,
    { headers: { authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
  console.log(`       over the wire on the real authenticated route: rules.entries_enabled=` +
    `${wire?.rules?.entries_enabled}`);
  ok("the bot reads it on the same authenticated route it already polls",
    wire?.rules?.entries_enabled === false, JSON.stringify(wire?.rules));

  /* One floor's switch is one floor's. */
  const otherRules = executorFeedPayload(OTHER_FLOOR, 0).rules;
  ok("another floor is untouched by it", otherRules.entries_enabled === true,
    `floor ${OTHER_FLOOR} entries_enabled=${otherRules.entries_enabled}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   4 — THE BOT. A real poller subprocess against this office.
   ══════════════════════════════════════════════════════════════════════════════ */
const wallet = Keypair.generate();
const WALLET = wallet.publicKey.toBase58();
const KEYPAIR_FILE = path.join(TMP, "burner.json");
fs.writeFileSync(KEYPAIR_FILE, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
const STATE_DB = path.join(TMP, "bot.sqlite");
const HARD_STOP_FILE = path.join(TMP, "HARD_STOP");
const PAUSE_FILE = path.join(TMP, "PAUSE_ENTRIES");

class Bot {
  constructor() { this.child = null; this.out = ""; }
  async start() {
    this.child = spawn(process.execPath, [POLLER], {
      cwd: TMP,
      env: { ...process.env,
        CC_API: BASE, CC_SECRET: SECRET, CC_FLOOR: String(FLOOR), EXECUTE: "0",
        KEYPAIR: KEYPAIR_FILE, STATE_DB, LOCK_FILE: `${STATE_DB}.lock`,
        PAUSE_ENTRIES_FILE: PAUSE_FILE, HARD_STOP_FILE,
        POLL_MS: "1000", MARK_MS: "0", RECONCILE_MS: "0", MAX_CALL_AGE_MIN: "45",
        DESK_UNREACHABLE_MS: "3600000", DESK_SILENT_MS: "3600000",
        JUPITER_API_KEY: "", DS_OFFLINE: "1", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (c) => { this.out += c.toString();
      if (process.env.ONOFF_VERBOSE === "1") process.stdout.write(c.toString().replace(/^/gm, "   bot| ")); };
    this.child.stdout.on("data", take);
    this.child.stderr.on("data", take);
    if (!await this.waitFor(new RegExp(`up — floor ${FLOOR}`), 20_000))
      throw new Error(`the poller never booted:\n${this.tail(25)}`);
  }
  async waitFor(re, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (re.test(this.out)) return true; await sleep(40); }
    return false;
  }
  async stop() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await once(child, "exit"); clearTimeout(t); await sleep(150);
  }
  tail(n = 20) { return this.out.split("\n").slice(-n).join("\n"); }
}

const ENTRY_REF = 0.0010;
const publish = (symbol) => {
  const call = openCall({
    mint: Keypair.generate().publicKey.toBase58(), symbol, category: "memecoin",
    launchpad: "pump.fun", conviction: 60, entryRef: ENTRY_REF,
    entryLo: ENTRY_REF * 0.9, entryHi: ENTRY_REF * 1.1,
    stop: ENTRY_REF * 0.75, target: ENTRY_REF * 1.5,
    thesis: `${symbol} — a call for the off/on switch`, invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 250_000 });
  if (!call) throw new Error(`openCall refused ${symbol}`);
  const res = copy.broadcast(call.id, [FLOOR]);
  if (res.offered !== 1) throw new Error(`${symbol} was not offered: ${JSON.stringify(res)}`);
  return call;
};
const entryEventFor = (callId) =>
  executorFeedPayload(FLOOR, 0).events.find((e) => e.call_id === callId && e.type === "entry");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let sigSeed = 0;
const fakeSignature = () => {
  let n = ++sigSeed, s = "";
  while (s.length < 88) { s += B58[(n * 7 + s.length * 13 + 5) % 58]; n = (n * 31 + 17) % 100_000; }
  return s.slice(0, 88);
};
/** The chain stub: a CONFIRMED buy in the journal, so the bot boots holding a real
 *  position and "it still exits while off" is a claim about a book with a coin in it. */
function seedConfirmedEntry(journal, ev, { sol = 0.02, openedAtMs = Date.now() } = {}) {
  const amountRaw = String(Math.floor(sol * 1e9));
  const qtyRaw = "1000000000";
  const signature = fakeSignature();
  const spec = {
    id: `entry:${ev.event_id}`, kind: "entry", eventId: ev.event_id, feedId: ev.id,
    mint: ev.mint, inputMint: WSOL, outputMint: ev.mint, amountRaw,
    context: {
      wallet: WALLET, event: ev, plan: { action: "buy", sol, f: 0.02 },
      takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
      positionConfig: { stopBufferPct: 0 },
      entryReference: {
        marketMark: ev.current_mark, marketMarkAt: ev.current_mark_at,
        entryLow: ev.entry_lo, entryHigh: ev.entry_hi,
        stopRatio: ev.stop / ev.current_mark, targetRatio: ev.target / ev.current_mark },
      entryPreflight: {
        inputAmountRaw: amountRaw, forwardOutputRaw: qtyRaw,
        reverseOutputRaw: String(Math.floor(sol * 1e9 * 0.98)), roundTripLossPct: 2,
        solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
        solUsdPublishTime: Math.floor(openedAtMs / 1000), solUsdConfidencePct: 0.01,
        solUsdProviderDivergencePct: 0.01, tokenDecimals: 6, observedAt: openedAtMs },
      openedAtMs, riskStateBefore: freshState(openedAtMs) },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, { attempt: 1, requestId: `req-${spec.id}`,
    signedTx: Buffer.from(`signed-${spec.id}`), signature, blockhash: "test-blockhash",
    lastValidBlockHeight: 999, quotedOutputRaw: qtyRaw, minOutputRaw: qtyRaw, order: { test: true } });
  journal.markConfirmed(spec.id, 1, { signature, totalInputAmount: amountRaw,
    totalOutputAmount: qtyRaw, networkFeeLamports: "5000" }, { status: "Success", code: 0, signature });
}

/** The desk's own determination, exactly as penthouse.js fires one. */
const deskDetermine = (callId, now) => {
  const call = getCall(callId);
  if (!call || call.status !== "live") return null;
  if (now.mark != null) noteEvent(callId, "mark", null, now.mark);
  const exit = evaluateExit(getCall(callId), now);
  if (!exit.fire) return null;
  const closed = closeCall(callId, exit.code, now.mark ?? null);
  if (!closed) return null;
  announceExit(closed, exit).catch(() => {});
  return exit;
};

{
  const j = new ExecutionJournal(STATE_DB, { wallet: WALLET });
  j.saveRuntime({ cursor: 0, primed: true, state: freshState(Date.now()), positions: {} });
  j.close();
}
const bot = new Bot();

console.log("\n4 — THE BOT: OFF opens nothing, and still gets out of what it holds");
await bot.start();
const heardOff = await bot.waitFor(/switch is OFF/, 8_000);
ok("the bot read the switch off the feed and said so", heardOff, heardOff ? "logged by the bot on its own poll" : bot.tail(6));

const skipped = publish("OFFA");
{
  const seen = await bot.waitFor(/SKIP OFFA: your floor's switch is OFF/, 12_000);
  const bought = /ENTRY OFFA — [0-9.]+ SOL/.test(bot.out);
  console.log(`       published OFFA while OFF: refused=${seen} bought=${bought}`);
  ok("a call published while the switch is OFF is refused", seen && !bought,
    seen && !bought ? "refused, and no ENTRY line for it anywhere in the bot's log" : bot.tail(8));
  ok("...and the refusal names the switch, not a risk rail",
    /SKIP OFFA: your floor's switch is OFF — no new positions/.test(bot.out),
    "SKIP OFFA: your floor's switch is OFF — no new positions");
  ok("...and says the other lanes keep running",
    /exits, marks and reconciliation continue/.test(bot.out),
    "(exits, marks and reconciliation continue)");
}

/* THE HELD POSITION. Stop the bot (the journal is single-writer), write a confirmed
   buy for a second call, and bring it back — still OFF — with a coin in the book. */
const held = publish("OFFB");
await bot.waitFor(/SKIP OFFB/, 12_000);
await bot.stop();
{
  const j = new ExecutionJournal(STATE_DB, { wallet: WALLET });
  seedConfirmedEntry(j, entryEventFor(held.id), { openedAtMs: held.opened_at });
  j.close();
}
await bot.start();
await sleep(2_000);
{
  const j = new ExecutionJournal(STATE_DB, { wallet: WALLET });
  const positions = Object.values(j.snapshot().positions);
  console.log(`       book while OFF: ${positions.length} position(s) — ` +
    positions.map((p) => `${p.symbol}:${p.callId}`).join(" "));
  ok("the bot holds a real position while the switch is OFF", positions.length === 1,
    `${positions.length} position(s)`);
  j.close();
}
{
  const call = getCall(held.id);
  const exit = deskDetermine(held.id, { mark: call.stop * 0.95, liqUsd: call.liq_at_call, flags: [] });
  const followed = await bot.waitFor(/PAPER EXIT OFFB — desk exit \(stop_hit\)/, 15_000);
  console.log(`       desk determined ${exit?.code} while the switch is OFF: bot acted=${followed}`);
  ok("THE OFF SWITCH DOES NOT STRAND A POSITION — the bot still exits while off",
    exit?.code === "stop_hit" && followed,
    followed ? "PAPER EXIT OFFB — desk exit (stop_hit)" : bot.tail(10));
}
{
  const health = executorHeartbeatPayload(FLOOR).heartbeat?.health || {};
  console.log(`       heartbeat echo while OFF: deskEntriesEnabled=${health.deskEntriesEnabled} ` +
    `entriesEnabled=${health.entriesEnabled} state=${health.state}`);
  ok("the bot ECHOES the switch in its heartbeat",
    health.deskEntriesEnabled === false && health.entriesEnabled === false,
    `deskEntriesEnabled=${health.deskEntriesEnabled} entriesEnabled=${health.entriesEnabled}`);
  const view = await runRoute(FLOOR);
  console.log(`       the route now reads: chip=${view.json?.chip} state=${view.json?.state} ` +
    `confirmed=${view.json?.confirmed}`);
  ok("...and the page turns from pending to a confirmed OFF",
    view.json?.confirmed === true && view.json?.state === "off" && view.json?.chip === "OFF",
    `chip=${view.json?.chip} confirmed=${view.json?.confirmed}`);
}

console.log("\n4b — ON means the bot buys again");
{
  await runRoute(FLOOR, { method: "POST", body: { enabled: true } });
  const heardOn = await bot.waitFor(/switch is ON/, 10_000);
  ok("the bot heard the switch go back on", heardOn,
    heardOn ? "new positions are permitted again (its own sentinels still bind)" : bot.tail(6));
  publish("ONEA");
  const bought = await bot.waitFor(/ENTRY ONEA — [0-9.]+ SOL/, 15_000);
  const size = /ENTRY ONEA — ([0-9.]+) SOL/.exec(bot.out)?.[1] ?? null;
  console.log(`       published ONEA while ON: the bot decided to buy=${bought} at ${size} SOL ` +
    "(its own size, from its own rails — the desk publishes none)");
  ok("a call published while the switch is ON is entered", bought,
    bought ? `ENTRY ONEA — ${size} SOL` : bot.tail(10));
}

console.log("\n4c — THE LOCAL SENTINEL BEATS THE SERVER, ABSOLUTELY");
{
  fs.writeFileSync(HARD_STOP_FILE, "stopped by the operator\n", { mode: 0o600 });
  /* The server is saying ON at this exact moment; assert that rather than assume it. */
  const rules = executorFeedPayload(FLOOR, 0).rules;
  publish("HARDA");
  const refused = await bot.waitFor(/SKIP HARDA: HARD STOP file is present/, 15_000);
  const bought = /ENTRY HARDA — [0-9.]+ SOL/.test(bot.out);
  console.log(`       server rules.entries_enabled=${rules.entries_enabled} · local HARD_STOP present · ` +
    `refused=${refused} bought=${bought}`);
  ok("a server ON cannot clear the operator's own hard stop",
    rules.entries_enabled === true && refused && !bought,
    refused && !bought ? "SKIP HARDA: HARD STOP file is present" : bot.tail(10));
  /* A FRESH PULSE, NOT A STALE ONE. The poller sends a heartbeat at most once a minute
     and immediately on boot, so the echo is read from a restarted process rather than
     by waiting out the interval — and a restart is also the harder case, since the flag
     has to be re-read off the feed before the first pulse is built. */
  await bot.stop();
  await bot.start();
  await sleep(2_500);
  const health = executorHeartbeatPayload(FLOOR).heartbeat?.health || {};
  console.log(`       heartbeat: deskEntriesEnabled=${health.deskEntriesEnabled} ` +
    `entriesEnabled=${health.entriesEnabled} hardStop=${health.hardStop} state=${health.state}`);
  ok("...and the echo tells the truth about it: heard ON, entering nothing",
    health.deskEntriesEnabled === true && health.entriesEnabled === false && health.hardStop === true,
    `desk=${health.deskEntriesEnabled} effective=${health.entriesEnabled} hardStop=${health.hardStop}`);
  const view = await runRoute(FLOOR);
  console.log(`       the page shows: chip=${view.json?.chip} state=${view.json?.state} ` +
    `sentence=${JSON.stringify(view.json?.sentence)}`);
  ok("...and the page shows OFF with the reason, not the floor's ON",
    view.json?.state === "off" && /its own switch, on its machine, is refusing/.test(view.json?.sentence || ""),
    `state=${view.json?.state}`);
  fs.rmSync(HARD_STOP_FILE, { force: true });
}
await bot.stop();

/* ══════════════════════════════════════════════════════════════════════════════
   5 — THE OWNER-ONLY DASHBOARD AND THE PAGE THAT RENDERS IT.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n5 — THE DASHBOARD PAYLOAD AND THE PAGE");
{
  const status = await executorStatusPayload(FLOOR, {
    balanceReader: async () => ({ ok: false, error: "no chain in tests" }), nowMs: Date.now() });
  console.log(`       /executor/status runControl: chip=${status.runControl?.chip} ` +
    `state=${status.runControl?.state} requested=${status.runControl?.requested} ` +
    `pending=${status.runControl?.pending}`);
  ok("the owner-only dashboard carries the switch", Boolean(status.runControl),
    JSON.stringify(status.runControl?.chip));
  ok("...and it still says the boundary holds", status.boundary?.remoteControl === false,
    `remoteControl=${status.boundary?.remoteControl}`);

  /* A pulse from an OLDER bot build says nothing about entries. It must read as "has not
     said", never as a confirmation — the tri-state is the whole point. */
  const legacy = sanitizeExecutorHealth({ state: "healthy", entriesPaused: false, hardStop: false });
  console.log(`       an older bot's pulse: entriesEnabled=${legacy.entriesEnabled} ` +
    `deskEntriesEnabled=${legacy.deskEntriesEnabled}`);
  ok("a pulse with no switch fields reads as 'has not said', not as ON",
    legacy.entriesEnabled === null && legacy.deskEntriesEnabled === null,
    `entriesEnabled=${legacy.entriesEnabled} deskEntriesEnabled=${legacy.deskEntriesEnabled}`);
  const legacyView = botRunControl({ requested: true, echoedDesk: legacy.deskEntriesEnabled,
    echoedEffective: legacy.entriesEnabled, heartbeatSeenAt: Date.now(), nowMs: Date.now() });
  ok("...so a floor whose bot predates the switch reads PENDING",
    legacyView.pending === true && legacyView.chip === "ON · PENDING", `chip=${legacyView.chip}`);
}
{
  const html = fs.readFileSync(path.join(ROOT, "viewer", "office3d.html"), "utf8");
  const overview = html.slice(html.indexOf("async function loadOverviewDashboard"),
    html.indexOf("const CANDIDATE_BANDS"));
  const rendersEcho = /run\.chip/.test(overview) && /exec\.runControl/.test(overview);
  const postsRoute = /\/bot-run["']?,?[\s\S]{0,120}method: "POST"/.test(overview);
  console.log(`       Overview: reads exec.runControl=${/exec\.runControl/.test(overview)} · ` +
    `renders run.chip=${/run\.chip/.test(overview)} · posts /bot-run=${postsRoute} · ` +
    `beside the five figures=${overview.indexOf("el.appendChild(facts)") < overview.indexOf("exec.runControl")}`);
  ok("the off/on button is on the Overview, beside the five figures",
    postsRoute && overview.indexOf("el.appendChild(facts)") < overview.indexOf("exec.runControl"),
    "the runControl block follows the bigfacts grid");
  ok("...and it shows the bot's ECHO, never the raw request", rendersEcho,
    "renders runControl.chip, which is derived from the heartbeat");
  ok("...built from the page's existing helpers, with no new layout system",
    /leadButton\(turningOn \? "Turn new buys on" : "Turn new buys off"/.test(overview) &&
    /chipRow\(\[\{ label: "New buys"/.test(overview),
    "leadButton + chipRow, the page's own primitives");
  ok("...OFF asks for no confirmation; ON does",
    /if \(!turningOn\) return setRun\(false\);/.test(overview) && /Let your bot buy again\?/.test(overview),
    "stopping is the safe direction");
  ok("...and no dropdown bar, accordion or <details> was added",
    !/<details/.test(overview) && !/detailsFold\(/.test(overview) && !/show more/i.test(overview),
    "the owner rejected those explicitly");
  ok("the WALL-ST-E page still states the boundary and calls the switch a request",
    /Nothing on this page reaches your bot's machine/.test(html) &&
    /request your bot reads on its own next check-in/.test(html) &&
    /your machine's own hard stop always wins/.test(html), "the re-worded boundary sentence");
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE FROZEN SAFETY SET — this change reclassifies nothing.
   ══════════════════════════════════════════════════════════════════════════════ */
{
  const { GATE_CLASS } = await import("./src/calls.js");
  const safety = Object.entries(GATE_CLASS).filter(([, v]) => v === "SAFETY").map(([k]) => k);
  console.log(`\n       SAFETY gates after this change: ${safety.length}`);
  ok("the 31 original SAFETY gates plus bot_mint_refusal and target_inside_zone are intact",
    safety.length === 33 && safety.includes("bot_mint_refusal") && safety.includes("target_inside_zone"),
    `${safety.length} SAFETY gates`);
}

office.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failures: " + failures.join(" | ")); process.exit(1); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(0);
