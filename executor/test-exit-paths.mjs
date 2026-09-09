/**
 * SIM — CAN THE BOT ALWAYS GET OUT?
 *
 * A coin the bot cannot sell is not a call. Under desk-led-v4 the bot has no exit of its
 * own (strategy.mjs stepPosition holds unless a desk exit is supplied), so every path by
 * which a determination reaches a held position is load-bearing, and four of them used to
 * close on facts that say nothing about whether selling is safe:
 *
 *   (a) A FEED ROLLBACK returned from consumeFeed before the exit prepass, printing
 *       "local position/risk exits continue" — a promise v4 cannot keep. Entries must
 *       freeze (a rewound database must not authorise NEW exposure); getting OUT of
 *       exposure the bot already has is a different question, and reconciliation was
 *       switched off by the same alarm, so nothing was left.
 *   (b) ONE GARBLED EXIT ROW pinned the cursor for ever. office.js builds the feed with
 *       `alerts LEFT JOIN calls`, so an alert whose call row is gone yields a null mint;
 *       handleDeskExitEvent throws on it, the sequential pass leaves the cursor put, and
 *       every later entry AND exit is invisible behind it on every poll thereafter.
 *   (c) A "price impact X% exceeds cap" refusal latched manualExitRequired on the FIRST
 *       occurrence — permanently disabling the automated exit for that position and
 *       freezing every entry on the book behind it. A drained pump.fun pool quotes over
 *       50% impact for a full-position sell as a matter of course.
 *   (d) riskDataUnavailable — an unreadable Jupiter exit MARK — was an entry block, and
 *       under v4 that mark decides nothing. One coin the bot could not quote silenced
 *       the whole book.
 *
 * WHAT IS REAL HERE: the same rig as executor/test-follow-through.mjs — src/office.js
 * startOffice() and the authenticated feed, src/calls.js openCall/evaluateExit/closeCall
 * and src/copy.js broadcast on a throwaway CLAUDE_CO_DB, and executor/poller.mjs spawned
 * as a subprocess against it. A rewriting loopback proxy sits in front of the office so a
 * rollback and a malformed row are things the REAL poller reads off a real HTTP response.
 *
 * WHAT IS STUBBED: EXECUTE=0 throughout, as the owner's rules require. Fills are written
 * into the journal as CONFIRMED intents (test-recovery-accounting's technique) so the bot
 * has a real book; the accounting that turns them into positions is the real one. In
 * paper, sellAll returns at "PAPER EXIT ... position retained" before signing, so the
 * sell leg measured here is THE BOT REACHING THE POINT OF EXECUTING THE DETERMINATION,
 * not a settled sale. Paper also cannot produce a Jupiter price-impact refusal (sellAll
 * returns before the quote), so (c) is measured on the real exported ladder plus the
 * poller's own wiring of it — stated, not implied.
 *
 * Re-run with:  node executor/test-exit-paths.mjs      (XP_VERBOSE=1 to tail the bot)
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-exit-paths-"));
const FLOOR = 50;
const SECRET = "exit-paths-test-secret-0123456789";

process.env.CLAUDE_CO_DB = path.join(TMP, "office.db");
process.env.DESK_MAX_OPEN_POSITIONS = "64";
process.env.NODE_NO_WARNINGS = "1";

const db = (await import(path.join(ROOT, "src/lib/store.js"))).default;
const { openCall, closeCall, getCall, noteEvent, evaluateExit, liveCalls } =
  await import(path.join(ROOT, "src/calls.js"));
const copy = await import(path.join(ROOT, "src/copy.js"));
const { announceExit } = await import(path.join(ROOT, "src/alerts.js"));
const { startOffice, executorFeedPayload } = await import(path.join(ROOT, "src/office.js"));
const { ExecutionJournal, positionEntryBlock } = await import(path.join(ROOT, "executor/journal.mjs"));
const { WSOL } = await import(path.join(ROOT, "executor/jupiter.mjs"));
const { freshState } = await import(path.join(ROOT, "executor/strategy.mjs"));
const { reconcileGate } = await import(path.join(ROOT, "executor/desk-mirror.mjs"));
const {
  EXIT_IMPACT_FRACTIONS, exitRetryFraction, isPriceImpactRefusal, noteExitImpactRefusal,
  clearExitImpactRefusals,
} = await import(path.join(ROOT, "executor/exit-trigger.mjs"));

const POLLER_SRC = fs.readFileSync(POLLER, "utf8");
const JOURNAL_SRC = fs.readFileSync(path.join(ROOT, "executor/journal.mjs"), "utf8");

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  cond ? pass++ : (fail++, failures.push({ name, detail }));
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(cond);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The log line a matcher found, printed verbatim — an assertion that prints only "true"
 *  is an assertion nobody can check. */
const line = (out, re) => (re.exec(out) || ["(no matching line)"])[0].trim();

/* ── THE DESK ─────────────────────────────────────────────────────────────── */
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run("Tenant11111111111111111111111111111111111111", "Exit Paths Capital", Date.now(), FLOOR);
copy.settingsFor(FLOOR);
db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=?").run(SECRET, FLOOR);
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

const { server: office } = startOffice(0);
await once(office, "listening");
const OFFICE_PORT = office.address().port;

/* ── THE PROXY THAT CAN CORRUPT THE FEED ──────────────────────────────────────
 * Two knobs, both of them things a real desk has produced: `rollback` rewrites
 * latest_id BELOW the bot's durable cursor (a database restored from backup re-issues
 * lower AUTOINCREMENT ids), and `nullMintFor` blanks the mint on one exit row (the
 * `alerts LEFT JOIN calls` in office.js:88 yields exactly this when the call row is
 * gone). Everything else is passed through from the real office untouched. */
const feed = { rollback: false, nullMintFor: null };
const proxy = http.createServer((req, res) => {
  const upstream = http.request({ host: "127.0.0.1", port: OFFICE_PORT, path: req.url,
    method: req.method, headers: req.headers }, (up) => {
    const isFeed = String(req.url || "").includes("/executor/feed");
    if (!isFeed || up.statusCode !== 200) { res.writeHead(up.statusCode, up.headers); return up.pipe(res); }
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      let body = Buffer.concat(chunks).toString();
      try {
        const payload = JSON.parse(body);
        if (feed.rollback) payload.latest_id = 0;
        if (feed.nullMintFor) {
          for (const event of payload.events || [])
            if (event.type === "exit" && event.symbol === feed.nullMintFor) event.mint = null;
        }
        body = JSON.stringify(payload);
      } catch { /* a body we cannot parse is passed through as-is */ }
      const headers = { ...up.headers, "content-length": Buffer.byteLength(body) };
      delete headers["transfer-encoding"];
      res.writeHead(up.statusCode, headers);
      res.end(body);
    });
  });
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
const fakeSignature = () => {
  let n = ++sigSeed, s = "";
  while (s.length < 88) { s += B58[(n * 7 + s.length * 13 + 5) % 58]; n = (n * 31 + 17) % 100_000; }
  return s.slice(0, 88);
};

class Bot {
  constructor(stateDb, label) { this.stateDb = stateDb; this.label = label; this.child = null; this.out = ""; }
  async start(env = {}) {
    this.child = spawn(process.execPath, [POLLER], {
      cwd: TMP,
      env: {
        ...process.env,
        CC_API: API, CC_SECRET: SECRET, CC_FLOOR: String(FLOOR), EXECUTE: "0",
        KEYPAIR: keypairFile, STATE_DB: this.stateDb, LOCK_FILE: `${this.stateDb}.lock`,
        PAUSE_ENTRIES_FILE: path.join(TMP, `pause-${this.label}`),
        HARD_STOP_FILE: path.join(TMP, `hard-stop-${this.label}`),
        POLL_MS: "1000", MARK_MS: "0", RECONCILE_MS: "0", MAX_CALL_AGE_MIN: "45",
        // The mirror is the bot standing in for a desk it cannot hear; held off so every
        // exit observed here is the DESK's determination and never the bot's stand-in.
        DESK_UNREACHABLE_MS: "3600000", DESK_SILENT_MS: "3600000",
        JUPITER_API_KEY: "", DS_OFFLINE: "1", NODE_NO_WARNINGS: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (c) => {
      this.out += c.toString();
      try { fs.appendFileSync(path.join(TMP, `poller-${this.label}.log`), c.toString()); } catch {}
      if (process.env.XP_VERBOSE === "1") process.stdout.write(c.toString().replace(/^/gm, `   ${this.label}| `));
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
  tail(n = 30) { return this.out.split("\n").slice(-n).join("\n"); }
}

/* ── PUBLISHING (identical to test-follow-through.mjs) ────────────────────── */
const mintFor = () => Keypair.generate().publicKey.toBase58();
const ENTRY_REF = 0.0010;
const publish = ({ sym, mcap = 250_000, mint = mintFor() }) => {
  const call = openCall({
    mint, symbol: sym, category: "memecoin", launchpad: "pump.fun", conviction: 60,
    entryRef: ENTRY_REF, entryLo: ENTRY_REF * 0.9, entryHi: ENTRY_REF * 1.1,
    stop: ENTRY_REF * 0.75, target: ENTRY_REF * 1.5,
    thesis: `${sym} — a call the bot must be able to leave`, invalidation: "volume dies",
    liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: mcap,
  });
  if (!call) throw new Error(`openCall refused ${sym}`);
  const res = copy.broadcast(call.id, [FLOOR]);
  if (res.offered !== 1) throw new Error(`${sym} was not offered: ${JSON.stringify(res)}`);
  return call;
};

/** The desk's own determination — evaluateExit is the real function. */
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
const stopHit = (call) => deskDetermine(call.id, { mark: call.stop * 0.9, liqUsd: call.liq_at_call, flags: [] });
const entryEventFor = (callId) =>
  executorFeedPayload(FLOOR, 0).events.find((e) => e.call_id === callId && e.type === "entry");
const exitEventFor = (callId) =>
  executorFeedPayload(FLOOR, 0).events.find((e) => e.call_id === callId && e.type === "exit");

function seedConfirmedEntry(journal, ev, { sol = 0.02, qtyRaw = "1000000000", openedAtMs = Date.now() } = {}) {
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
  journal.markConfirmed(spec.id, 1, { signature, totalInputAmount: amountRaw,
    totalOutputAmount: qtyRaw, networkFeeLamports: "5000" }, { status: "Success", code: 0, signature });
  return { intentId: spec.id, signature };
}

/** Boot a bot on a fresh journal primed at the current feed head. */
function freshJournal(file) {
  const j = new ExecutionJournal(file, { wallet: WALLET });
  j.saveRuntime({ cursor: executorFeedPayload(FLOOR, 0).latest_id, primed: true,
    state: freshState(Date.now()), positions: {} });
  j.close();
}

/* ══════════════════════════════════════════════════════════════════════════════
   (a) A FEED ROLLBACK FREEZES ENTRIES — AND NOTHING ELSE
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n(a) latest_id BEHIND the durable cursor: entries frozen, the desk's exit still executed");
const ROLL_DB = path.join(TMP, "rollback.sqlite");
{
  freshJournal(ROLL_DB);
  const botA = new Bot(ROLL_DB, "rollback");
  const held = publish({ sym: "XPR1" });
  { const j = new ExecutionJournal(ROLL_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(held.id), { openedAtMs: held.opened_at }); j.close(); }

  /* One clean run FIRST, so the bot's durable cursor is genuinely ahead of something:
     it accounts the seeded fill into a real position and reads past the entry row. A
     rewritten latest_id can only be BEHIND a cursor that has moved. */
  await botA.start();
  await botA.waitFor(/(ENTRY|SKIP) XPR1\b/, 15_000);
  await sleep(1_200);
  await botA.stop();

  // The desk determines while the bot is DOWN, so the determination is already on the
  // feed when the bot comes back — and it comes back to a rolled-back latest_id.
  const exit = stopHit(held);
  const exitEvent = exitEventFor(held.id);
  feed.rollback = true;
  await botA.start();
  const alarmed = await botA.waitFor(/CRITICAL FEED ROLLBACK/, 15_000);
  const sold = await botA.waitFor(/PAPER EXIT XPR1 — desk exit \(stop_hit\)/, 15_000);
  ok("the rollback alarm fires — latest_id is behind the durable cursor",
    exit?.code === "stop_hit" && alarmed, line(botA.out, /CRITICAL FEED ROLLBACK[^\n]*/));
  ok("...and the desk's determination is STILL executed on the held position",
    sold, line(botA.out, /PAPER EXIT XPR1[^\n]*/));
  ok("...and the alarm line itself no longer promises exits that desk-led-v4 removed",
    /entries remain frozen; the batch's \d+ desk exit\(s\) were still executed/.test(botA.out) &&
      !/local position\/risk exits continue/.test(botA.out),
    line(botA.out, /CRITICAL FEED ROLLBACK[^\n]*/));

  /* THE FREEZE ITSELF IS UNTOUCHED — the half of the contract that must NOT move. Note
     WHERE the freeze lands: the rollback branch returns before the sequential cursor
     pass, so a call published under the alarm is never handed to onEntry at all. That is
     stronger than the SKIP, not weaker — but it means the SKIP line is not the evidence,
     so the evidence is that no buy was decided and no cursor crossed the call. */
  publish({ sym: "XPR2" });
  await sleep(3_500);
  ok("a call published during the rollback is not bought — new exposure stays frozen",
    !/ENTRY XPR2 —/.test(botA.out),
    `${botA.count(/ENTRY XPR2 —/g)} buy decision(s) for XPR2 while the alarm stood`);
  ok("...and the entry gate's own rollback refusal is still in place for one that reaches it",
    /if \(feedRollbackActive\(\)\)\s*\n\s*return log\(`SKIP \$\{ev\.symbol\}: authenticated feed latest_id rolled behind durable cursor/
      .test(POLLER_SRC),
    "onEntry still refuses on feedRollbackActive() — the deferred-entry drain reaches it");

  await botA.stop();
  { const j = new ExecutionJournal(ROLL_DB, { wallet: WALLET });
    const cursor = j.snapshot().cursor;
    const alarm = j.getMeta("feed_rollback");
    ok("the durable cursor never moved backward, and the alarm is durable",
      cursor < Number(exitEvent.id) && alarm?.active === true,
      `cursor=${cursor} < the exit row's own id ${exitEvent.id}; feed_rollback=${JSON.stringify(alarm)}`);
    j.close(); }

  /* AND IT WAS FROZEN, NOT LOST. The cursor never crossed XPR2, so the moment the feed
     stops rewinding the same call is read and decided on its own merits. */
  feed.rollback = false;
  await botA.start();
  const thawed = await botA.waitFor(/(ENTRY|SKIP) XPR2\b/, 15_000);
  ok("...and the moment the rollback clears, that very call is decided",
    thawed, line(botA.out, /(ENTRY|SKIP) XPR2[^\n]*/));
  await botA.stop();

  /* THE OTHER LANE THE ALARM USED TO CLOSE. reconcileGate is EXECUTE-only, so a paper
     harness cannot show it running; the gate itself is a pure function and every clause
     is executed here against values whose answer is known. */
  const T0 = 1_800_000_000_000;
  const open = { execute: true, inFlight: false, deskUnreachableSince: null, now: T0,
    lastReconcileAt: T0 - 300_000, reconcileMs: 60_000, heldCallIds: [held.id] };
  const under = reconcileGate({ ...open, feedRollback: true });
  const clear = reconcileGate({ ...open, feedRollback: false });
  ok("reconciliation RUNS under the rollback alarm — the only exit lane while the feed is frozen",
    under.run === true && under.why === "reconcile" && under.feedRollback === true,
    JSON.stringify(under));
  ok("...and the pass is otherwise identical to one with no alarm at all",
    clear.run === true && JSON.stringify(clear.ids) === JSON.stringify(under.ids),
    `alarm ids=${JSON.stringify(under.ids)} vs clear ids=${JSON.stringify(clear.ids)}`);
  ok("...while every OTHER gate still refuses, so nothing else was widened",
    reconcileGate({ ...open, feedRollback: true, execute: false }).why === "paper" &&
      reconcileGate({ ...open, feedRollback: true, inFlight: true }).why === "in-flight" &&
      reconcileGate({ ...open, feedRollback: true, deskUnreachableSince: T0 }).why === "desk-unreachable" &&
      reconcileGate({ ...open, feedRollback: true, lastReconcileAt: T0 }).why === "throttled" &&
      reconcileGate({ ...open, feedRollback: true, heldCallIds: [] }).why === "nothing-held",
    "paper · in-flight · desk-unreachable · throttled · nothing-held");
}

/* ══════════════════════════════════════════════════════════════════════════════
   (b) ONE GARBLED ROW MUST NOT HIDE EVERY LATER EVENT
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n(b) a null-mint exit row: acknowledged, the cursor advances, later exits still fire");
{
  const MAL_DB = path.join(TMP, "malformed.sqlite");
  freshJournal(MAL_DB);
  const botB = new Bot(MAL_DB, "malformed");
  const bad = publish({ sym: "XPB1" });
  const good = publish({ sym: "XPB2" });
  { const j = new ExecutionJournal(MAL_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(bad.id), { openedAtMs: bad.opened_at });
    seedConfirmedEntry(j, entryEventFor(good.id), { openedAtMs: good.opened_at });
    j.close(); }

  // XPB1's exit row is served with a null mint — office.js's LEFT JOIN produces exactly
  // this when the call row behind an alert is gone. XPB2's exit is published AFTER it,
  // so it sits behind the bad row in the same feed window.
  feed.nullMintFor = "XPB1";
  const badExit = stopHit(bad);
  const goodExit = stopHit(good);
  const badRow = exitEventFor(bad.id), goodRow = exitEventFor(good.id);
  await botB.start();

  const acked = await botB.waitFor(/MALFORMED EXIT ROW XPB1/, 15_000);
  const later = await botB.waitFor(/PAPER EXIT XPB2 — desk exit \(stop_hit\)/, 15_000);
  ok("the unusable row is named out loud and acknowledged, not retried for ever",
    badExit?.code === "stop_hit" && acked, line(botB.out, /MALFORMED EXIT ROW XPB1[^\n]*/));
  ok("...and nothing was sold on it — the bot still holds the coin it could not identify",
    !/PAPER EXIT XPB1/.test(botB.out), "no PAPER EXIT line for XPB1");
  ok("...and the exit BEHIND it, published later, still executes",
    goodExit?.code === "stop_hit" && later, line(botB.out, /PAPER EXIT XPB2[^\n]*/));

  await botB.stop();
  { const j = new ExecutionJournal(MAL_DB, { wallet: WALLET });
    const cursor = j.snapshot().cursor;
    ok("the durable cursor advanced past the garbled row rather than pinning on it",
      cursor >= Number(goodRow.id),
      `cursor=${cursor}, bad row id=${badRow.id}, later exit row id=${goodRow.id}`);
    j.close(); }
  feed.nullMintFor = null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   (c) A DRAINED POOL IS A CLIP SIZE, NOT AN OPERATOR
   Paper cannot produce a Jupiter refusal — sellAll returns at "PAPER EXIT" before any
   quote — so the ladder is measured on the real exported functions the poller calls,
   and the poller's wiring of them is asserted against its own source. Said plainly
   rather than implied: this half is a unit measurement, not an end-to-end one.
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n(c) 'price impact 60% exceeds cap 15%': the clip steps down, nothing latches for review");
{
  // THE RULER, CHECKED FIRST. jupiter.mjs:157 throws this exact string.
  const real = "price impact 60.4% exceeds cap 15%";
  ok("the classifier recognises the message jupiter.mjs actually throws",
    isPriceImpactRefusal(real) === true, JSON.stringify(real));
  ok("...and does NOT swallow a custody failure, which must still be treated as one",
    isPriceImpactRefusal("tracked balance could not be verified on two independent RPCs") === false &&
      isPriceImpactRefusal("") === false,
    "a custody refusal and an empty message both classify false");

  const pos = { symbol: "XPC1", exitExecutionRequired: true };
  const rungs = [{ fraction: exitRetryFraction(pos), refusals: pos.exitImpactRefusals ?? 0 }];
  for (const at of [1_800_000_000_000, 1_800_000_030_000, 1_800_000_060_000])
    rungs.push({ fraction: noteExitImpactRefusal(pos, { observedAt: at, reason: real }),
      refusals: pos.exitImpactRefusals });
  const [first, afterOne, afterTwo, afterThree] = rungs;
  ok("the first attempt sells the whole position, as it always did",
    first.fraction === 1, `fraction=${first.fraction} (refusals=${first.refusals})`);
  ok("after the first impact refusal the next attempt sells half",
    afterOne.fraction === 0.5, `fraction=${afterOne.fraction} (refusals=${afterOne.refusals})`);
  ok("after the second it sells a quarter",
    afterTwo.fraction === 0.25, `fraction=${afterTwo.fraction} (refusals=${afterTwo.refusals})`);
  ok("...and it floors at a quarter rather than chasing dust",
    afterThree.fraction === 0.25 && EXIT_IMPACT_FRACTIONS.join(",") === "1,0.5,0.25",
    `fraction=${afterThree.fraction} at refusal ${afterThree.refusals}, ` +
    `ladder=[${EXIT_IMPACT_FRACTIONS.join(", ")}]`);
  ok("NO manual latch at any rung — the exit stays latched and keeps being retried",
    pos.manualExitRequired === undefined && pos.exitExecutionRequired === true &&
      positionEntryBlock(pos) === "required exit unresolved",
    `manualExitRequired=${pos.manualExitRequired}, entry block = ${JSON.stringify(positionEntryBlock(pos))}`);
  clearExitImpactRefusals(pos);
  ok("a fresh determination starts at the whole position again, not at the old clip",
    exitRetryFraction(pos) === 1 && pos.exitImpactRefusals === undefined,
    `fraction=${exitRetryFraction(pos)} after clearing`);

  // THE WIRING. The ladder is worthless if the poller does not call it, and the old
  // behaviour is worse than worthless if it survives anywhere.
  ok("the poller's impact branch notes the refusal instead of latching manual review",
    /if \(isPriceImpactRefusal\(error\.message\)\) \{[\s\S]{0,400}?noteExitImpactRefusal\(pos,/.test(POLLER_SRC),
    "the branch reads: if (isPriceImpactRefusal(error.message)) { noteExitImpactRefusal(pos, ...) }");
  ok("...and NOTHING in the poller sets manualExitRequired any more",
    !/manualExitRequired = true/.test(POLLER_SRC),
    `${(POLLER_SRC.match(/manualExitRequired = true/g) || []).length} assignment(s) left`);
  ok("...while manualExitRequired stays a registered blocking flag for a journal that carries one",
    /\["manualExitRequired", "manualExitReason"/.test(JOURNAL_SRC) &&
      positionEntryBlock({ manualExitRequired: true, manualExitReason: "legacy latch" }) === "legacy latch",
    "an older journal's latch still blocks; nothing new writes one");
  ok("the latched retry sells the ladder's clip, and a reduced clip gets its own intent id",
    /await sellAll\(pos, pos\.exitExecutionReason \|\| "required risk exit", fraction,/.test(POLLER_SRC) &&
      /function exitClipIntentId\(baseIntentId, pos, fraction\)/.test(POLLER_SRC),
    "journal.ensureIntent holds amountRaw immutable per id, so a smaller sell needs its own");
}

/* ══════════════════════════════════════════════════════════════════════════════
   (d) AN UNREADABLE MARK IS WEATHER, NOT A REASON TO STOP TRADING
   ══════════════════════════════════════════════════════════════════════════════ */
console.log("\n(d) a held position flagged riskDataUnavailable: the next call is still decided");
{
  const RISK_DB = path.join(TMP, "riskdata.sqlite");
  freshJournal(RISK_DB);
  const held = publish({ sym: "XPD0" });
  { const j = new ExecutionJournal(RISK_DB, { wallet: WALLET });
    seedConfirmedEntry(j, entryEventFor(held.id), { openedAtMs: held.opened_at }); j.close(); }
  const botD = new Bot(RISK_DB, "riskdata");
  // The confirmed fill becomes a POSITION through the real accounting, not by fixture.
  await botD.start();
  await botD.waitFor(/(ENTRY|SKIP) XPD0\b/, 15_000);
  await sleep(1_200);
  await botD.stop();
  // Then flag it exactly as manageOpen's catch does when the exit quote cannot be read.
  const flagged = (mutate) => {
    const j = new ExecutionJournal(RISK_DB, { wallet: WALLET });
    const snap = j.snapshot();
    const pos = Object.values(snap.positions)[0];
    if (!pos) throw new Error("the bot never accounted the seeded fill into a position");
    mutate(pos);
    j.saveRuntime(snap);
    j.close();
    return pos;
  };
  const withMarkOutage = flagged((pos) => {
    pos.riskDataUnavailable = true;
    pos.riskDataUnavailableReason = "independent executable exit mark unavailable: Failed to get quotes";
    pos.riskDataUnavailableAt = Date.now();
  });
  ok("the held position really does carry the flag, and it no longer reads as a block",
    withMarkOutage.riskDataUnavailable === true && positionEntryBlock(withMarkOutage) === null,
    `${withMarkOutage.symbol}.riskDataUnavailable=true → positionEntryBlock = ${JSON.stringify(positionEntryBlock(withMarkOutage))}`);

  await botD.start();
  await sleep(1_200);
  publish({ sym: "XPD1" });
  const decided = await botD.waitFor(/(ENTRY|SKIP) XPD1\b/, 15_000);
  ok("a new call is still DECIDED while a held coin's mark is unreadable",
    decided && /ENTRY XPD1 —/.test(botD.out),
    line(botD.out, /(ENTRY|SKIP) XPD1[^\n]*/));
  ok("...and the refusal it used to get is gone from the log entirely",
    !/XPD1: XPD0 blocks new exposure/.test(botD.out),
    "no 'blocks new exposure — risk data unavailable' line");

  /* THE RULER, CHECKED AGAINST A CASE WHOSE ANSWER IS KNOWN. If every flag stopped
     blocking, the assertion above would just be a string that always appears. A custody
     contradiction on the SAME book must still freeze the next entry. */
  await botD.stop();
  flagged((pos) => {
    pos.balanceReconciliationRequired = true;
    pos.balanceReconciliationReason = "two independent RPCs disagree on the tracked balance";
  });
  await botD.start();
  await sleep(1_200);
  publish({ sym: "XPD2" });
  const blocked = await botD.waitFor(/SKIP XPD2: XPD0 blocks new exposure/, 15_000);
  ok("CONTROL: a custody contradiction on the same position DOES still freeze new exposure",
    blocked && !/ENTRY XPD2 —/.test(botD.out), line(botD.out, /SKIP XPD2:[^\n]*/));
  await botD.stop();

  ok("the block list is custody and identity only, and every entry on it is explicit",
    !/\["riskDataUnavailable", "riskDataUnavailableReason"/.test(JOURNAL_SRC) &&
      /\["deskIdentityMismatch", "deskIdentityMismatchReason"/.test(JOURNAL_SRC) &&
      ["callIdentityIncomplete", "accountingIncomplete", "balanceReconciliationRequired",
        "exitExecutionRequired", "manualExitRequired"]
        .every((flag) => JOURNAL_SRC.includes(`["${flag}", "`)),
    "riskDataUnavailable out; deskIdentityMismatch in; the other five untouched");
  ok("...and riskDataUnavailable survives where it belongs: the heartbeat's health flags",
    fs.readFileSync(path.join(ROOT, "executor/heartbeat-health.mjs"), "utf8")
      .includes('"riskDataUnavailable"'),
    "heartbeat-health.mjs POSITION_FLAGS still reports it as a blocked/degraded position");
}

/* ── SUMMARY ──────────────────────────────────────────────────────────────── */
await new Promise((r) => proxy.close(r));
await new Promise((r) => office.close(r));

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAILED: ${f.name} — ${f.detail}`);
console.log(`logs: ${TMP}`);
process.exit(fail ? 1 : 0);
