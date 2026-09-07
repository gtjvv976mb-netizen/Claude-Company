/**
 * SIM A — DOES THE BOT FOLLOW EVERY PUBLISHED CALL, BUY TO SELL?
 *
 * A runnable end-to-end simulation of the second of the owner's two goals. It boots the
 * REAL office on a throwaway database, publishes calls through the REAL publish path,
 * and spawns the REAL executor/poller.mjs as a subprocess against it.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────────
 *   - src/office.js startOffice() and the authenticated /executor/feed, /take and
 *     /fill routes, on a throwaway CLAUDE_CO_DB under a temp dir.
 *   - src/calls.js openCall / evaluateExit / closeCall, src/copy.js broadcast+decide,
 *     src/alerts.js announceEntry / announceExit — the desk's real publish and exit path.
 *     `evaluateExit` IS the desk's determination; nothing here invents a close code.
 *   - executor/poller.mjs, spawned as a subprocess: its tick loop, feed cursor and
 *     priming, entry gates, entry sizing (strategy.mjs planEntry and its rails), the
 *     journal, confirmed-intent accounting, the deferred-desk-exit path, manageOpen,
 *     the desk-led exit path and the fill-report queue.
 *
 * ── WHAT IS STUBBED, AND SO WHAT THIS MAY NOT CLAIM ─────────────────────────────
 *   - EXECUTE=0 (paper) throughout, as the owner's rules require. In paper mode
 *     poller.mjs makes the ENTRY DECISION and returns before signing (poller.mjs:1221
 *     "PAPER — no transaction signed"), so no position is created and no intent is
 *     journaled. THE BUY LEG MEASURED HERE IS A DECISION, NOT A FILL. Under EXECUTE=1
 *     the same call would still face the executable-round-trip preflight that runs
 *     AFTER this log line, and could be refused there.
 *   - To give the bot a real book, the fills are written into the journal as CONFIRMED
 *     intents (the technique executor/test-recovery-accounting.mjs uses). The chain is
 *     stubbed; the accounting that turns a confirmed fill into a position — the real
 *     applyConfirmedEntry — is not.
 *   - In paper mode sellAll() likewise returns before signing (poller.mjs:1326 "PAPER
 *     EXIT ... position retained"). THE SELL LEG MEASURED HERE IS THE BOT REACHING THE
 *     POINT OF EXECUTING THE DESK'S DETERMINATION, carrying the desk's own close code
 *     — not a settled sale. Under EXECUTE the hard-stop check, the two-RPC custody
 *     balance verification and the quote/route still stand between that point and a
 *     sold position.
 *   - Also note poller.mjs:742 — latchExit() is a no-op under EXECUTE=0, so a heard
 *     exit is NOT durably recorded in paper. The only paper exception is a DEFERRED
 *     desk exit, which is written by applyConfirmedEntry itself.
 *   - No price feed runs: marks are written into the desk's own call_events table,
 *     which is where the desk's monitor writes them.
 *   - A switchable loopback proxy sits in front of the office so a feed outage is a
 *     real HTTP 503 the poller must survive. The office behind it is the real one.
 *
 * Re-run with:  node executor/test-follow-through.mjs        (FT_VERBOSE=1 to tail the bot)
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POLLER = path.join(ROOT, "executor", "poller.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-follow-through-"));
const FLOOR = 50;
const SECRET = "follow-through-test-secret-0123456789";

process.env.CLAUDE_CO_DB = path.join(TMP, "office.db");
process.env.DESK_MAX_OPEN_POSITIONS = "64";   // the desk-side delivery cap is not what is under test
process.env.NODE_NO_WARNINGS = "1";

const db = (await import(path.join(ROOT, "src/lib/store.js"))).default;
const { openCall, closeCall, getCall, noteEvent, evaluateExit, liveCalls } =
  await import(path.join(ROOT, "src/calls.js"));
const copy = await import(path.join(ROOT, "src/copy.js"));
const { announceExit } = await import(path.join(ROOT, "src/alerts.js"));
const { startOffice, executorFeedPayload } = await import(path.join(ROOT, "src/office.js"));
const { ExecutionJournal, deskExitDecisionForPosition } =
  await import(path.join(ROOT, "executor/journal.mjs"));
const { WSOL } = await import(path.join(ROOT, "executor/jupiter.mjs"));
const { freshState } = await import(path.join(ROOT, "executor/strategy.mjs"));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  cond ? pass++ : (fail++, failures.push({ name, detail }));
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(cond);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ── THE DESK ─────────────────────────────────────────────────────────────── */
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run("Tenant11111111111111111111111111111111111111", "Follow-Through Capital", Date.now(), FLOOR);
copy.settingsFor(FLOOR);
db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=?").run(SECRET, FLOOR);
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

const { server: office } = startOffice(0);
await once(office, "listening");
const OFFICE_PORT = office.address().port;

let outage = false;
const proxy = http.createServer((req, res) => {
  if (outage) { res.writeHead(503, { "content-type": "application/json" }); return res.end('{"error":"upstream down"}'); }
  const upstream = http.request({ host: "127.0.0.1", port: OFFICE_PORT, path: req.url,
    method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  upstream.on("error", () => { res.writeHead(502); res.end("{}"); });
  req.pipe(upstream);
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${proxy.address().port}`;

/* ── THE BOT ──────────────────────────────────────────────────────────────── */
const wallet = Keypair.generate();
const WALLET = wallet.publicKey.toBase58();
const keypairFile = path.join(TMP, "burner.json");
fs.writeFileSync(keypairFile, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let sigSeed = 0;
/** A syntactically valid 88-char base58 signature, so the desk's /executor/fill route
 *  judges the REPORT rather than rejecting the fixture. */
const fakeSignature = () => {
  let n = ++sigSeed, s = "";
  while (s.length < 88) { s += B58[(n * 7 + s.length * 13 + 5) % 58]; n = (n * 31 + 17) % 100_000; }
  return s.slice(0, 88);
};

class Bot {
  constructor(stateDb, label) { this.stateDb = stateDb; this.label = label; this.child = null; this.out = ""; this.boots = 0; }
  async start(env = {}) {
    this.boots++;
    this.child = spawn(process.execPath, [POLLER], {
      cwd: TMP,
      env: {
        ...process.env,
        CC_API: API, CC_SECRET: SECRET, CC_FLOOR: String(FLOOR), EXECUTE: "0",
        KEYPAIR: keypairFile, STATE_DB: this.stateDb, LOCK_FILE: `${this.stateDb}.lock`,
        PAUSE_ENTRIES_FILE: path.join(TMP, `pause-${this.label}`),
        HARD_STOP_FILE: path.join(TMP, `hard-stop-${this.label}`),
        POLL_MS: "1000", MARK_MS: "0", RECONCILE_MS: "0", MAX_CALL_AGE_MIN: "45",
        /* The mirror is the bot standing in for a desk it cannot hear. Held off for the
           whole run so that every exit observed here is the DESK's determination and
           never the bot's stand-in; the outage below is far shorter than this. */
        DESK_UNREACHABLE_MS: "3600000", DESK_SILENT_MS: "3600000",
        JUPITER_API_KEY: "", DS_OFFLINE: "1", NODE_NO_WARNINGS: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (c) => {
      this.out += c.toString();
      try { fs.appendFileSync(path.join(TMP, `poller-${this.label}.log`), c.toString()); } catch {}
      if (process.env.FT_VERBOSE === "1") process.stdout.write(c.toString().replace(/^/gm, `   ${this.label}| `));
    };
    this.child.stdout.on("data", take);
    this.child.stderr.on("data", take);
    if (!await this.waitFor(new RegExp(`up — floor ${FLOOR}`), 20_000))
      throw new Error(`poller ${this.label} never booted:\n${this.tail(20)}`);
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
  count(re) { return (this.out.match(re) || []).length; }
  tail(n = 40) { return this.out.split("\n").slice(-n).join("\n"); }
}

/* ── PUBLISHING ───────────────────────────────────────────────────────────── */
const mintFor = () => Keypair.generate().publicKey.toBase58();
const ENTRY_REF = 0.0010;
/* mcap picks the band, and the band picks the hold window (src/bands.js):
   nano 1m/30m · micro 20m/1h · low|medium|high 1h/5h · very_high 5h/24h */
const PLAN = [
  { sym: "FT01", band: "nano",      mcap: 9_000,     exit: "stop_hit" },
  { sym: "FT02", band: "nano",      mcap: 12_000,    exit: "thesis_expired" },
  { sym: "FT03", band: "micro",     mcap: 35_000,    exit: "target_hit" },
  { sym: "FT04", band: "micro",     mcap: 50_000,    exit: "stop_hit" },
  { sym: "FT05", band: "low",       mcap: 75_000,    exit: "take_profit" },
  { sym: "FT06", band: "low",       mcap: 90_000,    exit: "liq_collapse" },
  { sym: "FT07", band: "medium",    mcap: 250_000,   exit: "target_hit" },
  { sym: "FT08", band: "medium",    mcap: 400_000,   exit: "authority_appeared" },
  { sym: "FT09", band: "high",      mcap: 600_000,   exit: "stop_hit" },
  { sym: "FT10", band: "high",      mcap: 900_000,   exit: "thesis_expired" },
  { sym: "FT11", band: "very_high", mcap: 2_000_000, exit: "target_hit" },
  { sym: "FT12", band: "very_high", mcap: 5_000_000, exit: "liq_collapse" },
];
const publish = ({ sym, mcap, mint = mintFor(), cycleId = null, level = null }) => {
  const call = openCall({
    mint, symbol: sym, category: "memecoin", launchpad: "pump.fun", conviction: 60,
    entryRef: ENTRY_REF, entryLo: ENTRY_REF * 0.9, entryHi: ENTRY_REF * 1.1,
    stop: ENTRY_REF * 0.75, target: ENTRY_REF * 1.5,
    thesis: `${sym} — a call the bot must follow`, invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: mcap, cycleId, escalationLevel: level,
  });
  if (!call) throw new Error(`openCall refused ${sym}`);
  const res = copy.broadcast(call.id, [FLOOR]);
  if (res.offered !== 1) throw new Error(`${sym} was not offered: ${JSON.stringify(res)}`);
  return call;
};

/* THE DESK'S OWN DETERMINATION. evaluateExit is the real function; this feeds it the
   observation the monitor would have made, then closes and announces exactly as
   penthouse.js fireExit does (closeCall + announceExit). */
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

const entryEventFor = (callId) =>
  executorFeedPayload(FLOOR, 0).events.find((e) => e.call_id === callId && e.type === "entry");

/** Write a CONFIRMED entry fill into the journal — the chain stub. `resolve:false`
 *  leaves it SIGNED (in flight, not accounted), which is the state the "exit before
 *  the buy accounts" case needs. */
function seedConfirmedEntry(journal, ev, { sol = 0.02, qtyRaw = "1000000000", openedAtMs = Date.now(), resolve = true } = {}) {
  const amountRaw = String(Math.floor(sol * 1e9));
  const signature = fakeSignature();
  const spec = {
    id: `entry:${ev.event_id}`, kind: "entry", eventId: ev.event_id, feedId: ev.id,
    mint: ev.mint, inputMint: WSOL, outputMint: ev.mint, amountRaw,
    context: {
      wallet: WALLET, event: ev,
      plan: { action: "buy", sol, f: 0.02 },
      takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
      positionConfig: { stopBufferPct: 0 },
      entryReference: {
        marketMark: ev.current_mark, marketMarkAt: ev.current_mark_at,
        entryLow: ev.entry_lo, entryHigh: ev.entry_hi,
        stopRatio: ev.stop / ev.current_mark, targetRatio: ev.target / ev.current_mark,
      },
      entryPreflight: {
        inputAmountRaw: amountRaw, forwardOutputRaw: qtyRaw,
        reverseOutputRaw: String(Math.floor(sol * 1e9 * 0.98)), roundTripLossPct: 2,
        solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
        solUsdPublishTime: Math.floor(openedAtMs / 1000), solUsdConfidencePct: 0.01,
        solUsdProviderDivergencePct: 0.01, tokenDecimals: 6, observedAt: openedAtMs,
      },
      openedAtMs, riskStateBefore: freshState(openedAtMs),
    },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, { attempt: 1, requestId: `req-${spec.id}`,
    signedTx: Buffer.from(`signed-${spec.id}`), signature, blockhash: "test-blockhash",
    lastValidBlockHeight: 999, quotedOutputRaw: qtyRaw, minOutputRaw: qtyRaw, order: { test: true } });
  if (resolve) journal.markConfirmed(spec.id, 1, { signature, totalInputAmount: amountRaw,
    totalOutputAmount: qtyRaw, networkFeeLamports: "5000" }, { status: "Success", code: 0, signature });
  return { intentId: spec.id, signature };
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 1 — every published call reaches the bot and gets a decision
   ══════════════════════════════════════════════════════════════════════════════ */
const MAIN_DB = path.join(TMP, "main.sqlite");
{
  const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
  j.saveRuntime({ cursor: 0, primed: true, state: freshState(Date.now()), positions: {} });
  j.close();
}
const bot = new Bot(MAIN_DB, "main");

console.log("\nPHASE 1 — every published call reaches the bot and gets a decision");
await bot.start();
const calls = new Map();
for (const p of PLAN) {
  calls.set(p.sym, publish(p));
  const seen = await bot.waitFor(new RegExp(`(ENTRY|SKIP|ERROR|RETRY) ${p.sym}\\b`), 12_000);
  if (!seen) ok(`${p.sym} (${p.band}) reached the bot`, false, bot.tail(15));
}
const decidedEntry = new Map();
for (const p of PLAN) {
  const m = new RegExp(`ENTRY ${p.sym} — ([0-9.]+) SOL`).exec(bot.out);
  decidedEntry.set(p.sym, m ? Number(m[1]) : null);
}
ok(`the bot decided to BUY all ${PLAN.length} published calls, spanning every band`,
  PLAN.every((p) => decidedEntry.get(p.sym) != null),
  PLAN.map((p) => `${p.sym}=${decidedEntry.get(p.sym) ?? "SKIP"}`).join(" "));
ok("...and each size came from the bot's own rails, identical across every band and conviction",
  new Set([...decidedEntry.values()]).size === 1,
  `sizes: ${[...new Set(decidedEntry.values())].join(",")} SOL — the desk publishes no size`);

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 2 — the confirmed fills are accounted into a real book
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\nPHASE 2 — the confirmed fills are accounted into a real book");
await bot.stop();
{
  const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
  for (const p of PLAN) {
    const ev = entryEventFor(calls.get(p.sym).id);
    if (!ev) { ok(`${p.sym} has an entry event on the feed`, false, "no feed row"); continue; }
    seedConfirmedEntry(j, ev, { openedAtMs: calls.get(p.sym).opened_at });
  }
  j.close();
}
await bot.start();
await sleep(2_000);
{
  const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
  const held = Object.values(j.snapshot().positions);
  ok(`the bot's book holds all ${PLAN.length} calls`, held.length === PLAN.length,
    `${held.length} position(s)`);
  ok("every position carries its originating call id and no entry-blocking flag",
    held.length === PLAN.length && held.every((h) => Number(h.callId) > 0 && !h.accountingIncomplete && !h.callIdentityIncomplete),
    held.map((h) => `${h.symbol}:${h.callId}`).join(" "));
  j.close();
}
{
  const fills = db.prepare("SELECT call_id, side, sol, qty_raw FROM executor_fills WHERE floor_no=? AND side='buy'").all(FLOOR);
  ok("the desk's /executor/fill route accepted the bot's real buy numbers for every call",
    fills.length === PLAN.length, `${fills.length} of ${PLAN.length} buy fills stored · e.g. ${JSON.stringify(fills[0])}`);
  const taken = db.prepare("SELECT COUNT(*) n FROM deliveries WHERE floor_no=? AND taken=1").get(FLOOR).n;
  ok("...and every delivery is marked taken on the desk's side", taken === PLAN.length, `${taken} taken`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 3 — the desk determines an exit and the bot acts on that determination
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\nPHASE 3 — the desk determines an exit and the bot acts on that determination");
const determined = new Map(), followed = new Map();

async function driveExit(p, { restartBefore = false, outageMs = 0 } = {}) {
  const call = getCall(calls.get(p.sym).id);
  if (restartBefore) { await bot.stop(); await bot.start(); }
  const failuresBefore = bot.count(/feed HTTP 503/g);
  if (outageMs) { outage = true; await sleep(outageMs); }
  let exit = null;
  if (p.exit === "stop_hit")
    exit = deskDetermine(call.id, { mark: call.stop * 0.95, liqUsd: call.liq_at_call, flags: [] });
  else if (p.exit === "target_hit")
    exit = deskDetermine(call.id, { mark: call.target * 1.02, liqUsd: call.liq_at_call, flags: [] });
  else if (p.exit === "take_profit")
    exit = deskDetermine(call.id, { mark: call.entry_ref * 2.2, liqUsd: call.liq_at_call, flags: [] });
  else if (p.exit === "thesis_expired") {
    db.prepare("UPDATE calls SET opened_at=? WHERE id=?").run(Date.now() - (call.hold_max_ms + 60_000), call.id);
    exit = deskDetermine(call.id, { mark: call.entry_ref, liqUsd: call.liq_at_call, flags: [] });
  } else if (p.exit === "liq_collapse")
    exit = deskDetermine(call.id, { mark: call.entry_ref, liqUsd: call.liq_at_call * 0.4, flags: [] });
  else if (p.exit === "authority_appeared") {
    db.prepare("UPDATE calls SET flags_at_call=? WHERE id=?").run("[]", call.id);
    exit = deskDetermine(call.id, { mark: call.entry_ref, liqUsd: call.liq_at_call, flags: ["mint_authority"], flagsReadable: true });
  }
  if (outageMs) {
    const missed = bot.count(/feed HTTP 503/g) - failuresBefore;
    ok(`${p.sym}: the feed was genuinely down while the desk determined`, missed >= 2, `${missed} failed poll(s)`);
    outage = false;
  }
  determined.set(p.sym, exit?.code ?? null);
  if (!exit) return ok(`${p.sym}: the desk determined an exit`, false, `evaluateExit did not fire for ${p.exit}`);
  ok(`${p.sym}: the desk determined ${exit.code}${outageMs ? " (during the outage)" : ""}${restartBefore ? " (after a restart)" : ""}`,
    exit.code === p.exit, `wanted ${p.exit}, got ${exit.code}`);
  const seen = await bot.waitFor(new RegExp(`PAPER EXIT ${p.sym} — desk exit \\(${exit.code}\\)`), 15_000);
  if (seen) followed.set(p.sym, exit.code);
  return ok(`${p.sym}: the bot acted on the desk's ${exit.code}`, seen, seen ? "" : bot.tail(12));
}

/* FT06's exit crosses a BOT RESTART mid-cohort; FT09's is determined during a real
   FEED OUTAGE. Both are the owner's awkward cases, run on real calls. */
for (const p of PLAN)
  await driveExit(p, { restartBefore: p.sym === "FT06", outageMs: p.sym === "FT09" ? 3_500 : 0 });

/* THE MOST DANGEROUS ORDERING: the desk determines the exit while the bot is DOWN.
   The determination is already on the feed when the bot comes back, past its durable
   cursor, so it must be delivered and followed on the first poll of the new process. */
{
  const call = publish({ sym: "FTDN", mcap: 250_000 });
  await bot.waitFor(/(ENTRY|SKIP) FTDN\b/, 10_000);
  await bot.stop();
  { const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(call.id), { openedAtMs: call.opened_at }); j.close(); }
  await bot.start();
  await sleep(1_500);
  await bot.stop();                                   // the bot is DOWN
  const exit = deskDetermine(call.id, { mark: call.stop * 0.9, liqUsd: call.liq_at_call, flags: [] });
  await bot.start();                                  // ...and comes back to a determination it never heard
  ok("an exit determined while the bot was DOWN is delivered and followed on the next boot",
    exit?.code === "stop_hit" && await bot.waitFor(/PAPER EXIT FTDN — desk exit \(stop_hit\)/, 15_000),
    bot.tail(10));
}

/* THE RULER, CHECKED AGAINST A CASE WHOSE ANSWER IS KNOWN. A call the desk leaves
   LIVE must produce NO exit line at all, or "the bot followed" would just be a string
   that always appears. */
{
  const ctrl = publish({ sym: "FTCTL", mcap: 250_000 });
  await bot.waitFor(/(ENTRY|SKIP) FTCTL\b/, 10_000);
  await bot.stop();
  { const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(ctrl.id), { openedAtMs: ctrl.opened_at }); j.close(); }
  await bot.start();
  await sleep(3_000);
  ok("CONTROL: a call the desk has NOT closed produces no exit line at all",
    !/PAPER EXIT FTCTL/.test(bot.out) && getCall(ctrl.id).status === "live",
    `held, desk status ${getCall(ctrl.id).status}`);
}

console.log("\nPER-CALL LEDGER — buy leg (decision) and sell leg (determination followed)");
let full = 0;
for (const p of PLAN) {
  const buy = decidedEntry.get(p.sym) != null, det = determined.get(p.sym), fol = followed.get(p.sym);
  const good = buy && det && fol === det;
  if (good) full++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${p.sym} ${p.band.padEnd(10)} buy=${buy ? decidedEntry.get(p.sym) + " SOL" : "NO"} ` +
    `desk=${det ?? "none"} bot=${fol ?? "none"}`);
}
ok(`N of N: every published call was entered and exited on the desk's own determination`,
  full === PLAN.length, `${full} of ${PLAN.length}`);

/* ONE DETERMINATION, ONE EXECUTION. consumeFeed used to hand each exit to
   handleDeskExitEvent twice — once in the pre-pass that runs exits ahead of the cursor
   loop, once in the cursor loop itself — and this line measured 24 executions for 12
   determinations. It was an observation then; it is an assertion now. */
const exitLines = bot.count(/PAPER EXIT FT\d+ — desk exit/g);
ok("every desk determination was executed exactly once, not twice",
  exitLines === PLAN.length,
  `${exitLines} exit lines for ${PLAN.length} determinations`);

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 4 — the awkward cases, on a SECOND bot with an empty book
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\nPHASE 4 — the awkward cases");
await bot.stop();
const ALT_DB = path.join(TMP, "alt.sqlite");
const cursorNow = executorFeedPayload(FLOOR, 0).latest_id;
{
  const j = new ExecutionJournal(ALT_DB, { wallet: WALLET });
  j.saveRuntime({ cursor: cursorNow, primed: true, state: freshState(Date.now()), positions: {} });
  j.close();
}
const bot2 = new Bot(ALT_DB, "alt");
await bot2.start();

/* 4a — CALLS PUBLISHED ASYNCHRONOUSLY TO THE TICK. Five calls at 137 ms offsets across
   a 1000 ms poll cycle: their arrival is uniformly spread over the tick, so some
   necessarily land while a tick is in flight. Every one must still be decided. */
{
  const syms = ["FTA1", "FTA2", "FTA3", "FTA4", "FTA5"];
  for (const sym of syms) { publish({ sym, mcap: 250_000 }); await sleep(137); }
  let decided = 0;
  for (const sym of syms) if (await bot2.waitFor(new RegExp(`(ENTRY|SKIP) ${sym}\\b`), 12_000)) decided++;
  ok("5 calls published at 137ms offsets across the 1s poll cycle were every one decided",
    decided === syms.length, `${decided} of ${syms.length}`);
  ok("...and all five were BUY decisions off an empty book",
    syms.every((s) => new RegExp(`ENTRY ${s} —`).test(bot2.out)),
    syms.map((s) => `${s}=${new RegExp(`ENTRY ${s} —`).test(bot2.out) ? "ENTRY" : "SKIP"}`).join(" "));
}

/* 4b — TWO CALLS ON THE SAME MINT FROM DIFFERENT CYCLES.
 * FOUND BY THIS RUN: the desk will not publish a second call on a mint whose first
 * call is still LIVE — openCall's UNIQUE index returns null (src/calls.js:150, "the
 * desk does not stack calls on one coin"). So the case only exists once cycle 1's call
 * has CLOSED, which is the sequence exercised below. */
{
  const mint = mintFor();
  /* 9001/9002 rather than 1/2: the cycle_id column is a STAMP, and low literals
     collide with the real cohort ledger phase 5 opens. */
  const a = publish({ sym: "FTM1", mcap: 250_000, mint, cycleId: 9001, level: 0 });
  await bot2.waitFor(/(ENTRY|SKIP) FTM1\b/, 10_000);
  await bot2.stop();
  { const j = new ExecutionJournal(ALT_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(a.id), { openedAtMs: a.opened_at }); j.close(); }
  await bot2.start();
  await sleep(1_500);
  const stacked = openCall({ mint, symbol: "FTM2X", category: "memecoin", conviction: 60,
    entryRef: ENTRY_REF, stop: ENTRY_REF * 0.75, target: ENTRY_REF * 1.5, mcapUsd: 250_000 });
  ok("the desk refuses to stack a second LIVE call on a mint it already has a call on",
    stacked === null, `openCall returned ${stacked === null ? "null" : `call ${stacked.id}`}`);
  const exitA = deskDetermine(a.id, { mark: a.stop * 0.9, liqUsd: a.liq_at_call, flags: [] });
  const followedA = await bot2.waitFor(/PAPER EXIT FTM1 — desk exit \(stop_hit\)/, 12_000);
  ok("cycle 1's exit reaches the position its own call opened",
    exitA?.code === "stop_hit" && followedA, `${exitA?.code} followed=${followedA}`);
  const b = publish({ sym: "FTM2", mcap: 250_000, mint, cycleId: 9002, level: 1 });
  const seenB = await bot2.waitFor(/(ENTRY|SKIP) FTM2\b/, 12_000);
  ok("cycle 2 may then re-call the same mint, and the bot decides on it as a new call",
    seenB && b.id !== a.id, `call ${a.id} then ${b.id}: ` + (/SKIP FTM2: ([^\n]+)/.exec(bot2.out)?.[1] || "ENTRY"));
  ok("...refused here only because the paper book still holds the mint from call 1",
    /SKIP FTM2: already holding/.test(bot2.out), /SKIP FTM2: ([^\n]+)/.exec(bot2.out)?.[1] || bot2.tail(8));
  const decision = deskExitDecisionForPosition({ mint, callId: b.id, symbol: "FTM2" }, { mint, call_id: a.id });
  ok("...and an exit for cycle 1's call is refused against a position opened by cycle 2's",
    decision.action === "ignore" && decision.reason === "different-call", JSON.stringify(decision));
}

/* 4c — AN EXIT THAT ARRIVES BEFORE ITS BUY IS ACCOUNTED. */
{
  await bot2.stop();
  const call = publish({ sym: "FTD1", mcap: 250_000 });
  let seeded;
  { const j = new ExecutionJournal(ALT_DB, { wallet: WALLET });
    seeded = seedConfirmedEntry(j, entryEventFor(call.id), { openedAtMs: call.opened_at, resolve: false });
    j.close(); }
  await bot2.start();
  const exit = deskDetermine(call.id, { mark: call.stop * 0.9, liqUsd: call.liq_at_call, flags: [] });
  const deferred = await bot2.waitFor(
    new RegExp(`EXIT FTD1: durably deferred until unresolved entry ${rx(seeded.intentId)} is accounted`), 12_000);
  ok("an exit arriving before its buy has accounted is durably deferred, not dropped",
    exit?.code === "stop_hit" && deferred, deferred ? "" : bot2.tail(12));
  await bot2.stop();
  { const j = new ExecutionJournal(ALT_DB, { wallet: WALLET });
    j.markConfirmed(seeded.intentId, 1, { signature: seeded.signature, totalInputAmount: "20000000",
      totalOutputAmount: "1000000000", networkFeeLamports: "5000" }, { status: "Success", code: 0, signature: seeded.signature });
    j.close(); }
  await bot2.start();
  ok("...and the moment the buy accounts, the deferred determination becomes the position's exit",
    await bot2.waitFor(/PAPER EXIT FTD1 — desk exit \(stop_hit\)/, 12_000), bot2.tail(15));
}

/* 4d — A CALL PUBLISHED WHILE THE BOT IS AT ITS OPEN-POSITION LIMIT. A third bot with
   MAX_OPEN_POSITIONS=2 and two positions already open: the count rail, not book heat. */
{
  const LIM_DB = path.join(TMP, "limit.sqlite");
  { const j = new ExecutionJournal(LIM_DB, { wallet: WALLET });
    j.saveRuntime({ cursor: executorFeedPayload(FLOOR, 0).latest_id, primed: true, state: freshState(Date.now()), positions: {} });
    j.close(); }
  const bot3 = new Bot(LIM_DB, "limit");
  const held = [publish({ sym: "FTL1", mcap: 250_000 }), publish({ sym: "FTL2", mcap: 250_000 })];
  { const j = new ExecutionJournal(LIM_DB, { wallet: WALLET });
    for (const c of held) seedConfirmedEntry(j, entryEventFor(c.id), { openedAtMs: c.opened_at });
    j.close(); }
  await bot3.start({ MAX_OPEN_POSITIONS: "2" });
  await sleep(1_500);
  publish({ sym: "FTL3", mcap: 250_000 });
  const seen = await bot3.waitFor(/(ENTRY|SKIP) FTL3\b/, 12_000);
  const reason = /SKIP FTL3: ([^\n]+)/.exec(bot3.out)?.[1] || "";
  ok("a call published while the bot is at its open-position limit is refused with a reason",
    seen && /already holding 2 of max 2/.test(reason), reason || bot3.tail(10));
  ok("...and the refusal came from the BOT's own rail, on its own configured limit",
    /already holding/.test(reason) && !/desk|feed|size_sol/.test(reason), reason);
  await bot3.stop();
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 5 — the cohort gate, on the real cycle ledger
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\nPHASE 5 — a cohort holds the gate until every call it published has closed");
{
  const { openNewCycle, recordCyclePublish, openCycle, cycleStatus, settleCycles } =
    await import(path.join(ROOT, "src/calls.js"));
  const COH_DB = path.join(TMP, "cohort.sqlite");
  { const j = new ExecutionJournal(COH_DB, { wallet: WALLET });
    j.saveRuntime({ cursor: executorFeedPayload(FLOOR, 0).latest_id, primed: true,
      state: freshState(Date.now()), positions: {} }); j.close(); }
  const bot4 = new Bot(COH_DB, "cohort");
  await bot4.start();

  const cycle = openNewCycle({ quota: 3 });
  const cohort = [];
  for (const [i, sym] of ["FTC1", "FTC2", "FTC3"].entries()) {
    const c = publish({ sym, mcap: 250_000, cycleId: cycle.id, level: i });
    recordCyclePublish(cycle.id, c.id, i);
    cohort.push(c);
    await bot4.waitFor(new RegExp(`(ENTRY|SKIP) ${sym}\\b`), 12_000);
  }
  ok("the cohort published its quota of 3 and the bot decided to buy all three",
    cycleStatus().published === 3 && cohort.every((c) => new RegExp(`ENTRY ${c.symbol} —`).test(bot4.out)),
    `published=${cycleStatus().published} quota=${cycleStatus().quota}`);
  await bot4.stop();
  { const j = new ExecutionJournal(COH_DB, { wallet: WALLET });
    for (const c of cohort) seedConfirmedEntry(j, entryEventFor(c.id), { openedAtMs: c.opened_at });
    j.close(); }
  await bot4.start();
  await sleep(1_500);

  for (const [i, c] of cohort.entries()) {
    const exit = deskDetermine(c.id, { mark: c.stop * 0.9, liqUsd: c.liq_at_call, flags: [] });
    const followedIt = await bot4.waitFor(new RegExp(`PAPER EXIT ${c.symbol} — desk exit \\(stop_hit\\)`), 15_000);
    settleCycles();
    const last = i === cohort.length - 1;
    ok(`${c.symbol}: exited on the desk's ${exit?.code}, and the gate is ${last ? "released" : "still held"}`,
      followedIt && (last ? openCycle() === null || openCycle().id !== cycle.id : openCycle()?.id === cycle.id),
      `open cycle now ${openCycle()?.id ?? "none"} (cohort ${cycle.id})`);
  }
  await bot4.stop();
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 6 — WHAT HAPPENS TO CALLS PUBLISHED WHILE AN INTENT IS UNRESOLVED
   consumeFeed freezes new exposure while journal.hasBlockingIntent() is true and then
   calls advanceFrozenBatchCursor (feed-drain.mjs:6), which moves the durable cursor to
   the LAST id in the batch. The cursor can therefore never be the record of what the
   bot decided on. THE CONTRACT MEASURED HERE IS THE OWNER'S GOAL ITSELF: every call
   published in that window is still decided on — held while the buy's fate is unknown,
   and offered back to the same gates the moment it resolves. And the safety half of the
   same contract: a held call the desk CLOSES in the meantime is retired, never bought.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\nPHASE 6 — calls published while a buy is in flight (signed, unconfirmed)");
{
  const FRZ_DB = path.join(TMP, "frozen.sqlite");
  { const j = new ExecutionJournal(FRZ_DB, { wallet: WALLET });
    j.saveRuntime({ cursor: executorFeedPayload(FLOOR, 0).latest_id, primed: true,
      state: freshState(Date.now()), positions: {} }); j.close(); }
  const bot5 = new Bot(FRZ_DB, "frozen");
  // One buy that was SIGNED and whose confirmation never came back — the ordinary
  // consequence of an RPC timeout after signing, not an exotic state.
  const inflight = publish({ sym: "FTZ0", mcap: 250_000 });
  let inflightIntent;
  { const j = new ExecutionJournal(FRZ_DB, { wallet: WALLET });
    inflightIntent = seedConfirmedEntry(j, entryEventFor(inflight.id),
      { openedAtMs: inflight.opened_at, resolve: false });
    j.close(); }
  await bot5.start();
  await sleep(1_500);
  const during = ["FTZ1", "FTZ2", "FTZ3"];
  const published = [];
  for (const sym of during) { published.push(publish({ sym, mcap: 250_000 })); await sleep(200); }
  // ...and one more that the desk CLOSES while it is still held. It must never be bought.
  const doomed = publish({ sym: "FTZ4", mcap: 250_000 });
  await sleep(6_000);

  const named = during.filter((s) => new RegExp(`(HOLD|ENTRY|SKIP|RETRY|ERROR) ${s}\\b`).test(bot5.out));
  const frozenLine = /journal intent [^\n]*unresolved[^\n]*/.exec(bot5.out)?.[0] || "";
  ok("every call published while a buy is in flight is NAMED in the bot's log, not passed over in silence",
    named.length === during.length,
    `${named.length} of ${during.length} named (${named.join(",") || "none"}) · the bot logged: ${frozenLine.slice(0, 160)}`);
  ok("...and the log says it is HELD, not passed over",
    during.every((s) => new RegExp(`HOLD ${s} \\(call \\d+\\): new exposure is frozen[^\\n]*offered again`).test(bot5.out)),
    /HOLD FTZ1[^\n]*/.exec(bot5.out)?.[0] || bot5.tail(6));
  ok("...and NONE of them was bought while the buy was in flight — the freeze still holds",
    during.every((s) => !new RegExp(`ENTRY ${s} —`).test(bot5.out)),
    "no ENTRY line for any call published inside the freeze");

  // THE DURABLE RECORD. The cursor advances past them (it must, or a newer exit hides
  // behind the frozen window); the calls survive in the journal instead.
  await bot5.stop();
  let heldIds = [];
  { const j = new ExecutionJournal(FRZ_DB, { wallet: WALLET });
    const cur = j.snapshot().cursor;
    const backlog = j.deferredEntries();
    heldIds = backlog.map((r) => r.callId);
    const ids = during.map((s) => executorFeedPayload(FLOOR, 0).events.find((e) => e.symbol === s)?.id)
      .filter((n) => Number.isFinite(n));
    ok("the calls the cursor crossed are held DURABLY in the journal, not abandoned",
      during.every((s) => backlog.some((r) => r.symbol === s)),
      `cursor=${cur} (past their event ids ${ids.join(",")}), deferred_entries holds ` +
      `${backlog.map((r) => `${r.symbol}#${r.callId}`).join(",") || "nothing"}`);
    j.close(); }

  // THE DESK CLOSES ONE OF THEM WHILE IT IS HELD. A determination is a determination.
  deskDetermine(doomed.id, { mark: doomed.stop * 0.9, liqUsd: doomed.liq_at_call, flags: [] });

  // The buy's fate comes back: the intent confirms and accounts, and the freeze lifts.
  { const j = new ExecutionJournal(FRZ_DB, { wallet: WALLET });
    j.markConfirmed(inflightIntent.intentId, 1,
      { signature: inflightIntent.signature, totalInputAmount: String(Math.floor(0.02 * 1e9)),
        totalOutputAmount: "1000000000", networkFeeLamports: "5000" },
      { status: "Success", code: 0, signature: inflightIntent.signature });
    j.close(); }
  await bot5.start();
  for (const sym of during) await bot5.waitFor(new RegExp(`(ENTRY|SKIP) ${sym} `), 15_000);
  await sleep(1_500);

  const decided = during.filter((s) => new RegExp(`(ENTRY|SKIP) ${s} `).test(bot5.out));
  ok("N of N: once the buy resolves, EVERY held call is decided on — none was abandoned",
    decided.length === during.length,
    `${decided.length} of ${during.length} decided (${decided.join(",")})`);
  const bought = during.filter((s) => new RegExp(`ENTRY ${s} —`).test(bot5.out));
  ok("...and they were BUY decisions, inside the band window they were published for",
    bought.length === during.length,
    `${bought.join(",") || "none"} — ${(/ENTRY FTZ1 —[^\n]*/.exec(bot5.out) || [""])[0]}`);
  ok("the call the desk CLOSED while it was held was retired, not bought",
    !/ENTRY FTZ4 —/.test(bot5.out) && /HELD CALL FTZ4[^\n]*retired/.test(bot5.out),
    (/HELD CALL FTZ4[^\n]*/.exec(bot5.out) || ["no retirement line"])[0]);
  await bot5.stop();
  { const j = new ExecutionJournal(FRZ_DB, { wallet: WALLET });
    const left = j.deferredEntries();
    ok("the held-call backlog is empty once every one of them has been decided",
      left.length === 0, `${left.length} still held (${left.map((r) => r.symbol).join(",") || "none"})`);
    j.close(); }
  void heldIds;
}

/* ══════════════════════════════════════════════════════════════════════════════
   WHAT PAPER MODE LEAVES BEHIND — measured, not asserted
   ══════════════════════════════════════════════════════════════════════════════ */
{
  const j = new ExecutionJournal(MAIN_DB, { wallet: WALLET });
  const held = Object.values(j.snapshot().positions);
  j.close();
  const closedCalls = new Set(db.prepare("SELECT id FROM calls WHERE status='closed'").all().map((r) => r.id));
  const zombies = held.filter((h) => closedCalls.has(Number(h.callId)));
  const latched = held.filter((h) => h.exitExecutionRequired === true).length;
  console.log(`\n  note  the main bot's paper book still holds ${held.length} position(s), ` +
    `${zombies.length} of them for calls the desk has CLOSED, and ${latched} carry a durable exit latch.`);
  console.log("        poller.mjs:742 — latchExit() returns immediately under EXECUTE=0, so in PAPER a heard");
  console.log("        exit is never written down. The sell is real under EXECUTE=1; paper cannot show it.");
}

/* ── SUMMARY ──────────────────────────────────────────────────────────────── */
await bot2.stop();
await new Promise((r) => proxy.close(r));
await new Promise((r) => office.close(r));

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAILED: ${f.name} — ${f.detail}`);
console.log(`logs: ${TMP}`);
process.exit(fail ? 1 : 0);
