/**
 * EXIT RECONCILIATION (wave 2, 2026-09-05) — the exit must reach the bot even when the
 * event does not.
 *
 * Wave 1 made the DESK the sole author of exits: no local stop, no target, no clock, no
 * take-profit. That is what the owner asked for after Shrek, call 55 — the bot sold at
 * 03:01:42Z on its own normalised stop at -13.5% and the desk's determined stop_hit
 * landed 03:10:24Z, on a position that no longer existed. It is also exactly why the two
 * holes this suite closes are now UNSURVIVABLE rather than merely late: with the bot's
 * own stop gone there is nothing underneath a desk exit that never arrives.
 *
 *   1. the exit event is delivered ONCE, ever (UNIQUE(floor_no, call_id, kind), a feed
 *      served strictly after a durable cursor, a cursor that advances per event);
 *   2. a desk whose penthouse loop is wedged answers a healthy 200 with no exit events —
 *      byte-for-byte identical to "the desk looked and decided to hold".
 *
 * What this suite pins:
 *   1. what the desk's answer about a held call MEANS (pure reconcileVerdict);
 *   2. the dedupe: two identical reconcile passes sell exactly ONCE;
 *   3. a desk that restates a level is followed;
 *   4. the gates — EXECUTE, a positive callId, a reachable feed, once per RECONCILE_MS;
 *   5. RECONCILE_MS / DESK_SILENT_MS bounded exactly like POLL_MS, in a real poller;
 *   6. the mirror now runs for a QUARANTINED position's clock and desk-level lanes;
 *   7. a reconciled exit reports to /executor/fill as the desk exit it is.
 * Real poller subprocesses run with EXECUTE=0 against a throwaway journal, a dead or
 * local CC_API and DS_OFFLINE=1 — never the live DB, never the public DexScreener API.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import { WSOL } from "./jupiter.mjs";
import { DEFAULTS, freshState, openPosition } from "./strategy.mjs";
import {
  RECONCILE_MAX_IDS, callIdentityVerdict, evaluateMirror, reconcileExitEventId, reconcileGate,
  reconcileVerdict, refreshDeskLevels,
} from "./desk-mirror.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLLER = path.join(here, "poller.mjs");
const src = fs.readFileSync(POLLER, "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const T0 = 1_757_000_000_000;
const MIN = 60_000;
const SILENT_MS = 10 * MIN;

/* ── 1. WHAT THE DESK'S ANSWER MEANS ───────────────────────────────────────── */
console.log("\n1. THE VERDICT ON ONE HELD CALL");
{
  const closedAt = T0 + 9 * MIN;
  const closed = reconcileVerdict({ floorNo: "50", now: T0 + 20 * MIN, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "closed", close_reason: "stop_hit", close_mark: 0.0003026, closed_at: closedAt } });
  ok("a CLOSED call the bot still holds is a desk exit with the desk's own code",
    closed.action === "desk_exit" && closed.code === "stop_hit" && closed.closeMark === 0.0003026,
    `${closed.action} / ${closed.code} / close_mark ${closed.closeMark}`);
  ok("...and its event id is reconcile:<floor>:<callId>:<closed_at>",
    closed.eventId === `reconcile:50:55:${closedAt}`, closed.eventId);
  ok("reconcileExitEventId builds the same key on its own", reconcileExitEventId("50", 55, closedAt) === closed.eventId,
    reconcileExitEventId("50", 55, closedAt));
  /* THE KEY MUST NOT CONTAIN A CLOCK. It is the journal's dedupe key; anything that moves
   * between passes sells the position again every single pass. Same answer, two wall
   * clocks 37 minutes apart, one id. */
  const again = reconcileVerdict({ floorNo: "50", now: T0 + 57 * MIN, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "closed", close_reason: "stop_hit", closed_at: closedAt } });
  ok("the event id is a pure function of the desk's facts, not of the bot's clock",
    again.eventId === closed.eventId, `${again.eventId} vs ${closed.eventId}`);
  const codeless = reconcileVerdict({ floorNo: "50", now: T0, call: { call_id: 7, status: "closed", closed_at: 5 } });
  ok("a close with no close_reason gets the delivered path's neutral code, never an invented one",
    codeless.code === "exit", codeless.code);
  const unstamped = reconcileVerdict({ floorNo: "50", now: T0, call: { call_id: 7, status: "closed", close_reason: "went_dark" } });
  ok("an unstamped closed_at still yields a deterministic key", unstamped.eventId === "reconcile:50:7:0", unstamped.eventId);

  const stale = reconcileVerdict({ floorNo: "50", now: T0 + 11 * MIN, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "live", opened_at: T0, last_mark_ts: T0 } });
  ok("a LIVE call last marked 11 minutes ago engages the mirror for that position",
    stale.action === "engage_mirror" && Math.round(stale.staleMs / MIN) === 11,
    `${stale.action} after ${(stale.staleMs / MIN).toFixed(1)} minutes`);
  const fresh = reconcileVerdict({ floorNo: "50", now: T0 + 11 * MIN, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "live", opened_at: T0, last_mark_ts: T0 + 10.5 * MIN } });
  ok("a LIVE, freshly marked call is the normal path and says nothing",
    fresh.action === "watch", `${fresh.action} after ${Math.round(fresh.staleMs / 1000)}s`);
  const boundary = reconcileVerdict({ floorNo: "50", now: T0 + SILENT_MS, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "live", last_mark_ts: T0 } });
  ok("exactly DESK_SILENT_MS is still a watch (the rule is strictly greater)",
    boundary.action === "watch", `${boundary.action} at staleMs ${boundary.staleMs}`);
  /* A call the desk OPENED and has never marked at all is the exact condition this case
   * exists to catch. Reading a missing last_mark_ts as "fresh" would hide it. */
  const neverMarked = reconcileVerdict({ floorNo: "50", now: T0 + 40 * MIN, deskSilentMs: SILENT_MS,
    call: { call_id: 55, status: "live", opened_at: T0 } });
  ok("a live call the desk has NEVER marked falls back to opened_at and engages the mirror",
    neverMarked.action === "engage_mirror" && Math.round(neverMarked.staleMs / MIN) === 40,
    `${neverMarked.action} after ${(neverMarked.staleMs / MIN).toFixed(1)} minutes`);
  const unmeasurable = reconcileVerdict({ floorNo: "50", now: T0, deskSilentMs: SILENT_MS, call: { call_id: 55, status: "live" } });
  ok("with neither last_mark_ts nor opened_at the staleness is unmeasurable — hold, do not guess",
    unmeasurable.action === "unmeasurable", `${unmeasurable.action}: ${unmeasurable.reason}`);
  const weird = reconcileVerdict({ floorNo: "50", now: T0, call: { call_id: 55, status: "cancelled" } });
  ok("a status that is neither live nor closed is never an exit", weird.action === "unknown", `${weird.action}: ${weird.reason}`);

  /* ABSENCE IS NOT AN EXIT SIGNAL. The id may be one this desk never heard of, or a
   * delivery that was re-verdicted away. Selling on absence would let a desk's 404 close
   * the book. */
  for (const [label, call] of [["null (the id was not in the answer)", null], ["undefined", undefined], ["a non-object", 7]])
    ok(`an absent call (${label}) is a hold, never an exit`, reconcileVerdict({ call, now: T0 }).action === "absent",
      reconcileVerdict({ call, now: T0 }).action);
  ok("the desk's route cap is 25 ids", RECONCILE_MAX_IDS === 25, String(RECONCILE_MAX_IDS));
}

/* ── 2. THE DEDUPE: TWO PASSES, ONE SELL ───────────────────────────────────── */
console.log("\n2. THE SAME RECONCILE PASS TWICE SELLS EXACTLY ONCE");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-reconcile-dedupe-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const closedAt = T0 + 9 * MIN;
  const held = { mint, symbol: "SHREK", callId: 55, qtyRaw: "123456", costBasisLamports: "5000000" };
  const deskAnswer = { now: T0 + 20 * MIN, calls: [{ call_id: 55, status: "closed", close_reason: "stop_hit",
    close_mark: 0.0003026, closed_at: closedAt, opened_at: T0, entry_ref: 0.00035, stop: 0.0003214 }] };
  /* The sell is the REAL journal under the guard sellAll itself applies — an intent id
   * already accounted returns without selling (pinned by source below). What makes the
   * second pass hit that guard is the deterministic id, which is the whole design. */
  const sells = [];
  const sell = (intentId, code) => {
    const existing = journal.getIntent(intentId);
    if (existing?.state === "accounted") return "already-accounted";
    const signature = `reconciled-sell-${sells.length}-${"9".repeat(50)}`;
    journal.ensureIntent({ id: intentId, kind: "desk_exit", eventId: intentId.slice(10), mint,
      inputMint: mint, outputMint: WSOL, amountRaw: "123456",
      context: { position: held, why: `desk exit (${code}) recovered by reconciliation`, fraction: 1, deskCode: code } });
    journal.recordSigned(intentId, { attempt: 1, requestId: `r-${intentId}`, signedTx: Buffer.from(intentId),
      signature, blockhash: "b", lastValidBlockHeight: 9, quotedOutputRaw: "6000000", minOutputRaw: "6000000", order: {} });
    journal.markConfirmed(intentId, 1, { signature, totalInputAmount: "123456", totalOutputAmount: "6000000",
      networkFeeLamports: "7000" }, { status: "Success", code: 0, signature });
    journal.markAccounted(intentId, { cursor: 0, primed: true, state: freshState(T0), positions: {} });
    sells.push(intentId);
    return "sold";
  };
  const runPass = () => {
    const verdict = reconcileVerdict({ call: deskAnswer.calls.find((c) => c.call_id === held.callId),
      now: deskAnswer.now, deskSilentMs: SILENT_MS, floorNo: "50" });
    return verdict.action === "desk_exit" ? sell(`desk-exit:${verdict.eventId}`, verdict.code) : verdict.action;
  };
  const first = runPass();
  const second = runPass();
  ok("pass 1 sells", first === "sold", first);
  ok("pass 2 is refused by the journal on the same intent id", second === "already-accounted", second);
  ok("exactly ONE sell across two identical passes", sells.length === 1, `${sells.length} sell(s): ${sells.join(", ")}`);
  ok("the intent id is the desk-exit path plus the reconcile event id",
    sells[0] === `desk-exit:reconcile:50:55:${closedAt}`, sells[0]);
  ok("...so sellAll derives kind desk_exit and eventId reconcile:50:55:<closed_at>",
    sells[0].startsWith("desk-exit:") && sells[0].slice(10) === `reconcile:50:55:${closedAt}`, sells[0].slice(10));
  const stored = journal.getIntent(sells[0]);
  ok("the stored intent is a desk_exit carrying the desk's code",
    stored.kind === "desk_exit" && stored.context.deskCode === "stop_hit" && stored.state === "accounted",
    `${stored.kind} / ${stored.context.deskCode} / ${stored.state}`);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const sellAllSrc = src.slice(src.indexOf("async function sellAll"), src.indexOf("async function handleDeskExitEvent"));
  ok("sellAll's own guard is the one exercised above (an accounted intent is not re-sold)",
    /if \(existingIntent\?\.state === "accounted"\) return log\(`EXIT \$\{pos\.symbol\} already accounted`\);/.test(sellAllSrc));
  ok("...and a confirmed-but-unaccounted intent is applied, never re-submitted",
    /if \(existingIntent\?\.state === "confirmed"\) \{\s*\n\s*applyConfirmedExit\(existingIntent\);/.test(sellAllSrc));
}

/* ── 3. A DESK THAT RESTATES A LEVEL IS FOLLOWED ───────────────────────────── */
console.log("\n3. THE DESK'S RESTATED LEVELS ARE ADOPTED");
{
  const pos = openPosition({ call: { mint: "M", symbol: "M", entry_ref: 0.00035, stop: 0.865, target: 1.257,
    deskStop: 0.0003214, deskTarget: 0.00044, opened_at: T0, openedAtMs: T0, hold_band: "nano", hold_max_ms: 30 * MIN },
  sol: 0.0175, fillPrice: 1, cfg: DEFAULTS });
  const changes = refreshDeskLevels(pos, { call_id: 55, status: "live", entry_ref: 0.00035,
    stop: 0.00034, target: 0.0005, hold_band: "micro", hold_max_ms: 60 * MIN, opened_at: T0 });
  ok("a raised stop is written onto the position",
    pos.deskStop === 0.00034, `deskStop ${pos.deskStop}`);
  ok("target and band window follow too",
    pos.deskTarget === 0.0005 && pos.holdMaxMs === 60 * MIN && pos.holdBand === "micro",
    `target ${pos.deskTarget}, holdMaxMs ${pos.holdMaxMs}, band ${pos.holdBand}`);
  ok("only what actually moved is reported",
    changes.map((c) => c.field).sort().join(",") === "deskStop,deskTarget,holdBand,holdMaxMs",
    changes.map((c) => `${c.field} ${c.from}→${c.to}`).join("; "));
  /* AND THE MIRROR EVALUATES THE RESTATED LEVEL, which is the whole reason to adopt it:
   * 0.000335 sits under the desk's NEW stop and above the old one. */
  const verdict = evaluateMirror(pos, { mark: 0.000335, now: T0 + 5 * MIN });
  ok("the mirror sells at the restated stop, at a mark the ORIGINAL stop would have held",
    verdict.action === "sell" && verdict.code === "stop_hit", `${verdict.action} / ${verdict.code} — ${verdict.reason}`);
  /* An absent or zero field is a route that did not say. It must never erase a level the
   * bot already holds — the mirror would silently lose its price lane. */
  const before = { deskEntryRef: pos.deskEntryRef, deskStop: pos.deskStop, deskTarget: pos.deskTarget };
  const none = refreshDeskLevels(pos, { call_id: 55, status: "live", stop: 0, target: null, hold_band: "" });
  ok("absent/zero fields change nothing",
    none.length === 0 && pos.deskStop === before.deskStop && pos.deskTarget === before.deskTarget && pos.deskEntryRef === before.deskEntryRef,
    `${none.length} change(s); deskStop ${pos.deskStop}, deskTarget ${pos.deskTarget}`);
}

/* ── 4. THE GATES, BY SOURCE ───────────────────────────────────────────────── */
console.log("\n4. RECONCILIATION RUNS ONLY WHERE THE CONTRACT SAYS");
{
  const fn = src.slice(src.indexOf("async function reconcileHeldCalls()"), src.indexOf("/* THE FEED, READ BEFORE THE BOOK IS VALUED."));
  /* The gates are EXECUTED here, not read off the source: reconcileGate is the pure
   * function reconcileHeldCalls delegates them to, so every refusal below is the one the
   * live pass takes. `why` names the gate, so a failure says which rule broke. */
  const open = { execute: true, inFlight: false, deskUnreachableSince: null, now: T0,
    lastReconcileAt: T0 - 5 * MIN, reconcileMs: MIN, heldCallIds: [55] };
  ok("the open case runs and asks about the held call",
    reconcileGate(open).run === true && reconcileGate(open).ids.join(",") === "55",
    `${reconcileGate(open).why} ids=${reconcileGate(open).ids}`);
  const refuses = (patch) => reconcileGate({ ...open, ...patch });
  ok("EXECUTE only", refuses({ execute: false }).run === false && refuses({ execute: false }).why === "paper",
    refuses({ execute: false }).why);
  ok("never while the feed is unreachable (mirror mode already owns that case)",
    refuses({ deskUnreachableSince: T0 - MIN }).why === "desk-unreachable", refuses({ deskUnreachableSince: T0 - MIN }).why);
  ok("at most once per RECONCILE_MS",
    refuses({ lastReconcileAt: T0 - 59_999 }).why === "throttled" && refuses({ lastReconcileAt: T0 - 60_000 }).run === true,
    `at 59,999ms ${refuses({ lastReconcileAt: T0 - 59_999 }).why}; at 60,000ms ${refuses({ lastReconcileAt: T0 - 60_000 }).why}`);
  ok("only positions with a POSITIVE callId are asked about",
    refuses({ heldCallIds: [null, undefined, 0, -3, "x", 1.5] }).why === "nothing-held" &&
      refuses({ heldCallIds: [null, 0, 55] }).ids.join(",") === "55",
    `${refuses({ heldCallIds: [null, undefined, 0, -3, "x", 1.5] }).why}; mixed → [${refuses({ heldCallIds: [null, 0, 55] }).ids}]`);
  ok("nothing held at all is not a request", refuses({ heldCallIds: [] }).why === "nothing-held");
  ok("no overlapping passes", refuses({ inFlight: true }).why === "in-flight", refuses({ inFlight: true }).why);
  ok("duplicate call ids are asked about once",
    refuses({ heldCallIds: [55, 55, 76] }).ids.join(",") === "55,76", `[${refuses({ heldCallIds: [55, 55, 76] }).ids}]`);
  const many = refuses({ heldCallIds: Array.from({ length: 40 }, (_, i) => i + 1) });
  ok("at most RECONCILE_MAX_IDS ids per request (more is a 400 at the desk)",
    many.ids.length === RECONCILE_MAX_IDS && many.ids.at(-1) === 25, `${many.ids.length} ids, last ${many.ids.at(-1)}`);
  ok("reconcileHeldCalls delegates its gates to that exact function",
    /const gate = reconcileGate\(\{ execute: EXECUTE, inFlight: reconcileInFlight, deskUnreachableSince,/.test(fn) &&
      /if \(!gate\.run\) return gate\.why;/.test(fn) && /const ids = gate\.ids;/.test(fn));
  /* A position whose call id was never proven is not in the request, so it must never be
   * logged as absent from the answer — that would print a permanent falsehood about a
   * call the bot never asked after. */
  ok("only the positions actually asked about are reconciled",
    /held\.filter\(\(position\) => ids\.includes\(Number\(position\?\.callId\)\)\)/.test(fn));
  const fetcher = src.slice(src.indexOf("async function fetchHeldCallState"), src.indexOf("/** Act on the desk's answer"));
  ok("the route is GET /api/floor/:n/executor/calls?ids= with the executor bearer",
    /\/api\/floor\/\$\{FLOOR\}\/executor\/calls\?ids=\$\{ids\.join\(","\)\}/.test(fetcher) &&
      /authorization: `Bearer \$\{SECRET\}`/.test(fetcher), "");
  ok("8 s timeout, redirects refused, a non-2xx is a failure",
    /AbortSignal\.timeout\(RECONCILE_ROUTE_TIMEOUT_MS\)/.test(fetcher) && /RECONCILE_ROUTE_TIMEOUT_MS = 8_000/.test(src) &&
      /redirect: "error"/.test(fetcher) && /if \(!response\.ok\) throw new Error\(`calls HTTP \$\{response\.status\}`\)/.test(fetcher));
  /* A FLAKY SECOND ROUTE MUST NOT MIRROR A DESK THAT IS TALKING. The unreachability clock
   * belongs to the feed GET; starting it here would let /executor/calls 404ing on an old
   * desk build engage mirror mode against a perfectly healthy floor. */
  ok("a failure of the call-state route never starts the desk-unreachability clock",
    !/noteDeskUnreachable/.test(fn) && !/noteDeskUnreachable/.test(fetcher) &&
      /could not read the desk's call state/.test(fn));
  ok("staleness is measured on the DESK's clock when it sends one",
    /const deskNow = Number\(payload\.now\) > 0 \? Number\(payload\.now\) : Date\.now\(\);/.test(fn));
  const one = src.slice(src.indexOf("async function reconcileOneHeldCall"), src.indexOf("async function reconcileHeldCalls()"));
  ok("a CLOSED call sells the whole position through the existing desk-exit path",
    /await sellAll\(pos, `desk exit \(\$\{verdict\.code\}\) recovered by reconciliation`, 1,\s*\n\s*`desk-exit:\$\{verdict\.eventId\}`, null, \{ deskCode: verdict\.code \}\);/.test(one));
  ok("...logged distinctly as a RECOVERED desk exit, naming the failed event path",
    /RECOVERED DESK EXIT \$\{pos\.symbol\}/.test(one) && /the exit EVENT never reached the bot/.test(one));
  ok("a silent desk engages the mirror for that position and logs the staleness in minutes",
    /engagePositionMirror\(pos, callId, verdict\.staleMs\)/.test(one) &&
      /\$\{\(staleMs \/ 60_000\)\.toFixed\(1\)\} minutes ago/.test(src));
  ok("a fresher mark stands that position's mirror down",
    /standDownPositionMirror\(pos, `the desk marked it \$\{Math\.round\(verdict\.staleMs \/ 1000\)\}s ago`\);/.test(one) &&
      /deskSilentPositions\.delete\(pos\.mint\)/.test(src));
  ok("an absent call logs once per call id and holds",
    /if \(!reconcileAbsentLogged\.has\(callId\)\) \{/.test(one) && /absence is not an exit signal/.test(one));
  ok("the desk's restated levels are adopted on every answered call",
    /const changes = refreshDeskLevels\(pos, call\);/.test(one));
  const tick = src.slice(src.indexOf("async function tick()"), src.indexOf("log(`up — floor"));
  const order = ["await consumeFeed();", "await reconcileHeldCalls();", "await manageOpen();", "await mirrorTick();"];
  const at = order.map((s) => tick.indexOf(s));
  ok("tick order: feed → reconcile → valuation → mirror",
    at.every((p, i) => p > 0 && (i === 0 || p > at[i - 1])), at.join(" < "));
  ok("RECONCILE_MS defaults to 60 s", /const RECONCILE_MS = Number\(process\.env\.RECONCILE_MS \?\? 60_000\);/.test(src));
  ok("DESK_SILENT_MS defaults to 10 min", /const DESK_SILENT_MS = Number\(process\.env\.DESK_SILENT_MS \?\? 600_000\);/.test(src));
}

/* ── 5. ENV BOUNDS (INIT_ONLY, real poller) ────────────────────────────────── */
console.log("\n5. THE TWO NEW ENV NAMES ARE BOUNDED LIKE POLL_MS");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-reconcile-env-"));
  const keypair = Keypair.generate();
  const keyFile = path.join(dir, "burner.json");
  fs.writeFileSync(keyFile, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  const stateDb = path.join(dir, "state.sqlite");
  const base = { ...process.env, CC_SECRET: "a".repeat(64), CC_FLOOR: "50", KEYPAIR: keyFile, STATE_DB: stateDb,
    LOCK_FILE: `${stateDb}.lock`, INIT_ONLY: "1", NODE_NO_WARNINGS: "1" };
  const live = { ...base, EXECUTE: "1", SOLANA_RPC: "https://primary-private-rpc.invalid",
    SOLANA_RPC_SECONDARY: "https://independent-rpc.invalid", JUPITER_API_KEY: "test-key",
    LIVE_TRADING_ACK: keypair.publicKey.toBase58(), LIVE_STATE_INIT_ACK: keypair.publicKey.toBase58() };
  const run = (env) => spawnSync(process.execPath, [POLLER], { env, encoding: "utf8", timeout: 15_000 });
  const paper0 = run({ ...base, EXECUTE: "0", RECONCILE_MS: "0", DESK_SILENT_MS: "0" });
  ok("paper accepts RECONCILE_MS=0 and DESK_SILENT_MS=0", paper0.status === 0,
    `exit ${paper0.status} ${paper0.stderr.trim().slice(0, 140)}`);
  const paperNeg = run({ ...base, EXECUTE: "0", RECONCILE_MS: "-1" });
  ok("paper refuses a negative RECONCILE_MS",
    paperNeg.status !== 0 && /RECONCILE_MS must be between 0 and Infinity/.test(paperNeg.stderr), paperNeg.stderr.trim().slice(0, 140));
  for (const [name, low, high, min, max] of [
    ["RECONCILE_MS", "14999", "600001", 15_000, 600_000],
    ["DESK_SILENT_MS", "119999", "3600001", 120_000, 3_600_000]]) {
    const under = run({ ...live, [name]: low });
    ok(`live refuses ${name} under ${min}`,
      under.status !== 0 && new RegExp(`${name} must be between ${min} and ${max}`).test(under.stderr), under.stderr.trim().slice(0, 140));
    const over = run({ ...live, [name]: high });
    ok(`live refuses ${name} over ${max}`,
      over.status !== 0 && new RegExp(`${name} must be between ${min} and ${max}`).test(over.stderr), over.stderr.trim().slice(0, 140));
    const inside = run({ ...live, [name]: String(min) });
    /* The floor value itself must PASS the bound. It will still refuse further down the
     * live gate ladder (an .invalid RPC proves no mainnet genesis), so the assertion is
     * that the message is not this bound's — not that a live boot succeeds. */
    ok(`live accepts ${name} exactly at ${min} (refusal, if any, is a later gate)`,
      !new RegExp(`${name} must be between`).test(inside.stderr), inside.stderr.trim().split("\n")[0]?.slice(0, 140) || "(no stderr)");
  }
  const runner = fs.readFileSync(path.join(here, "launchd-runner.mjs"), "utf8");
  const allow = runner.slice(runner.indexOf("const ALLOWED_ENV"), runner.indexOf("const SAFE_INHERITED_ENV"));
  for (const name of ["RECONCILE_MS", "DESK_SILENT_MS"])
    ok(`the launchd allowlist carries ${name}`, allow.includes(`"${name}"`));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── the real-poller harness (same shape as test-desk-led-exits.mjs) ────────── */
async function runPoller({ dir, wallet, stateFile, marker, api, env = {}, timeoutMs = 12_000 }) {
  const keypairFile = path.join(dir, "burner.json");
  fs.writeFileSync(keypairFile, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
  const child = spawn(process.execPath, [POLLER], { cwd: dir, env: {
    ...process.env, CC_API: api, CC_SECRET: "reconcile-test-secret", CC_FLOOR: "50", EXECUTE: "0",
    KEYPAIR: keypairFile, STATE_DB: stateFile, LOCK_FILE: `${stateFile}.lock`,
    PAUSE_ENTRIES_FILE: path.join(dir, "pause"), HARD_STOP_FILE: path.join(dir, "hard-stop"),
    POLL_MS: "1000", MARK_MS: "0", MAX_CALL_AGE_MIN: "1", JUPITER_API_KEY: "", DS_OFFLINE: "1",
    NODE_NO_WARNINGS: "1", ...env,
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", found = false;
  const wanted = Array.isArray(marker) ? marker : [marker];
  const inspect = (chunk) => {
    output += chunk.toString();
    if (!found && wanted.every((m) => output.includes(m))) { found = true; child.kill("SIGTERM"); }
  };
  child.stdout.on("data", inspect); child.stderr.on("data", inspect);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  await once(child, "exit");
  clearTimeout(timer);
  return { output, found };
}

/* ── 6. THE QUARANTINE GAP: A FLAGGED POSITION NOW HAS AN EXIT PATH ────────── */
console.log("\n6. THE MIRROR RUNS FOR A QUARANTINED POSITION (AND STILL NOT FOR A LATCHED ONE)");
{
  /* The gap wave 2 closes on the executor side. The mirror guard skipped any position
   * carrying accountingIncomplete, balanceReconciliationRequired, manualExitRequired or
   * exitExecutionRequired — so under wave 1, with the bot's own stop gone, a legacy or
   * quarantined position had NO exit path at all while the desk was unreachable, not even
   * its band clock. The three quarantines all invalidate the bot's OWN accounting basis;
   * the mirror's clock lane needs only opened_at and the band window and its price lane
   * only the desk's absolute USD levels and the desk's USD mark. Neither reads that basis.
   * One book, four positions, one dead desk, DESK_UNREACHABLE_MS=0. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-reconcile-quarantine-"));
  const wallet = Keypair.generate();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const openedAt = Date.now() - 31 * MIN;
  const mints = {};
  const positions = {};
  const mkPosition = (symbol, extra, { withEntryIntent = true } = {}) => {
    const mint = Keypair.generate().publicKey.toBase58();
    mints[symbol] = mint;
    const entryIntentId = `entry:${symbol.toLowerCase()}`;
    positions[mint] = { mint, symbol, qtyRaw: "123456", paidSol: 0.005, costBasisLamports: "5000000",
      entryInputLamports: "4995000", solUsdAtEntry: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
      entryIntentId, entry: 1, stop: 0.6, target: 2, callId: 76, high: 1, openedAtMs: openedAt,
      riskF: 0.02, takeProfitX: 2, honorDeskTarget: true,
      deskEntryRef: 0.00035, deskStop: 0.0003214, deskTarget: 0.00044, deskOpenedAt: openedAt,
      holdBand: "nano", holdMaxMs: 30 * MIN, ...extra };
    /* The durable entry intent is part of the fixture, not decoration: without it the
     * journal quarantines the position at boot (accountingIncomplete) — which is exactly
     * what the QUARANTINE fixture below WANTS, and exactly what would confound the other
     * three. Same shape as the survivor fixture in test-recovery-accounting.mjs. */
    if (withEntryIntent) journal.ensureIntent({ id: entryIntentId, kind: "entry", eventId: symbol, feedId: 76,
      mint, inputMint: WSOL, outputMint: mint, amountRaw: "4995000",
      context: {
        event: { mint, call_id: 76, entry_ref: 0.00035, stop: 0.0003214, target: 0.00044, hold_band: "nano", hold_max_ms: 30 * MIN },
        entryReference: { marketMark: 0.00036, marketMarkAt: openedAt, entryLow: 0.0003, entryHigh: 0.0004, stopRatio: 0.8928, targetRatio: 1.2222 },
        entryPreflight: { inputAmountRaw: "4995000", forwardOutputRaw: "123456", solUsd: 150,
          solUsdSource: "pyth-sol-usd-shard0-v1", tokenDecimals: 6, solUsdPublishTime: Math.floor(openedAt / 1000),
          solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.01, observedAt: openedAt },
      } });
    return mint;
  };
  // (a) the real legacy quarantine: no durable entry intent → the journal flags it at boot.
  mkPosition("QUARANTINE", {}, { withEntryIntent: false });
  // (b) custody unreadable on two RPCs.
  mkPosition("CUSTODY", { balanceReconciliationRequired: true, balanceReconciliationReason: "primary and secondary disagree" });
  // (c) an exit that already exceeded the price-impact cap.
  mkPosition("MANUAL", { manualExitRequired: true, manualExitReason: "price impact 61% exceeds cap" });
  // (d) an exit already latched — NOT a quarantine, and already has its own exit path.
  mkPosition("LATCHED", { exitExecutionRequired: true, exitExecutionReason: "desk exit (stop_hit)",
    exitExecutionIntentId: "desk-exit:50:exit:1", exitExecutionObservedAt: openedAt, exitExecutionDeskCode: "stop_hit" });
  journal.saveRuntime({ cursor: 0, primed: true,
    state: { ...freshState(Date.now()), openCount: 4, bookHeat: 0.08 }, positions });
  journal.close();

  const run = await runPoller({ dir, wallet, stateFile, api: "https://127.0.0.1:1",
    env: { DESK_UNREACHABLE_MS: "0" },
    marker: ["PAPER EXIT QUARANTINE — mirror exit", "PAPER EXIT CUSTODY — mirror exit", "PAPER EXIT MANUAL — mirror exit"] });
  const out = run.output;
  ok("all three quarantined positions were evaluated and sold by the mirror's clock lane", run.found,
    out.split("\n").filter((l) => /PAPER EXIT/.test(l)).join(" | ").slice(0, 400) || out.slice(-400));
  for (const symbol of ["QUARANTINE", "CUSTODY", "MANUAL"])
    ok(`${symbol}: the closed nano window sold with the desk's own code`,
      new RegExp(`PAPER EXIT ${symbol} — mirror exit \\(thesis_expired\\): the nano window closed after 3[0-9]m`).test(out),
      out.split("\n").find((l) => l.includes(`PAPER EXIT ${symbol}`))?.slice(30) || "(no line)");
  ok("the transcript says out loud that a quarantined position was evaluated anyway",
    /mirror QUARANTINE: quarantined \(accountingIncomplete\) and evaluated ANYWAY/.test(out),
    out.split("\n").find((l) => /evaluated ANYWAY/.test(l))?.slice(30, 200) || "(no line)");
  ok("...and names the custody and manual-review flags too",
    /mirror CUSTODY: quarantined \(balanceReconciliationRequired\)/.test(out) &&
      /mirror MANUAL: quarantined \(manualExitRequired\)/.test(out));
  /* The one flag that is NOT a quarantine keeps its skip: a latched exit already IS an
   * exit path (manageOpen retries it first on every pass), and a second sellAll under a
   * `mirror-exit:` id would open a SECOND exit intent for a position already selling. */
  ok("a LATCHED position is still not mirrored — it already has an exit path",
    !/PAPER EXIT LATCHED — mirror exit/.test(out) && !/mirror LATCHED: quarantined/.test(out),
    out.split("\n").filter((l) => /LATCHED/.test(l))[0]?.slice(30, 160) || "(no LATCHED line)");
  ok("...and that path ran instead: the latch's own reason, from manageOpen",
    /PAPER EXIT LATCHED — desk exit \(stop_hit\)/.test(out),
    out.split("\n").find((l) => /PAPER EXIT LATCHED/.test(l))?.slice(30) || "(no line)");
  const reopened = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const quarantined = reopened.snapshot().positions[mints.QUARANTINE];
  ok("fixture check: QUARANTINE really was flagged by the journal, not by the test",
    quarantined?.accountingIncomplete === true && quarantined?.solUsdSource === "legacy-unverified",
    `accountingIncomplete ${quarantined?.accountingIncomplete}, solUsdSource ${quarantined?.solUsdSource}`);
  reopened.close();
  /* The fences that actually guard a live sell are downstream in sellAll and untouched. */
  const sellAllSrc = src.slice(src.indexOf("async function sellAll"), src.indexOf("async function handleDeskExitEvent"));
  ok("HARD_STOP still refuses every automated exit", /if \(hardStop\(\)\) throw new Error\("HARD STOP is present/.test(sellAllSrc));
  ok("paper still sells nothing", /if \(!EXECUTE\) return log\(`PAPER EXIT \$\{pos\.symbol\}/.test(sellAllSrc));
  ok("the balance-verification fence still guards the signed sell",
    /const balance = await inspectTrackedBalance\(pos\);\s*\n\s*if \(!balance\.verified\) \{/.test(sellAllSrc) &&
      /durable position retained; manual reconciliation required/.test(sellAllSrc));
  const mirror = src.slice(src.indexOf("async function mirrorTick()"), src.indexOf("/* ── EXIT RECONCILIATION"));
  ok("the guard now skips only exitExecutionRequired",
    /if \(pos\.exitExecutionRequired\) continue;/.test(mirror) &&
      !/pos\.accountingIncomplete\) continue;/.test(mirror), "");
  ok("the mirror also covers per-position engagement, not only the global outage",
    /if \(!globalMirror && !deskSilentPositions\.has\(posKey\)\) continue;/.test(mirror) &&
      /if \(!globalMirror && deskSilentPositions\.size === 0\) return;/.test(mirror));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 7. PAPER RUNS NO RECONCILIATION, AND SAYS SO ──────────────────────────── */
console.log("\n7. PAPER NEVER ASKS (THE PASS IS EXECUTE-ONLY)");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-reconcile-paper-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  journal.saveRuntime({ cursor: 0, primed: true, state: { ...freshState(Date.now()), openCount: 1, bookHeat: 0.02 },
    positions: { [mint]: { mint, symbol: "PAPERHELD", qtyRaw: "123456", paidSol: 0.005, costBasisLamports: "5000000",
      entryInputLamports: "4995000", solUsdAtEntry: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
      entryIntentId: "entry:paperheld", entry: 1, stop: 0.6,
      target: 2, callId: 76, high: 1, openedAtMs: Date.now() - MIN, riskF: 0.02,
      takeProfitX: 2, honorDeskTarget: true } } });
  journal.close();
  let feedPolls = 0;
  const callsRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url?.includes("/executor/calls")) callsRequests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.includes("/executor/feed")) {
      feedPolls++;
      /* A marker that can only appear after several real ticks, so "no /executor/calls
       * request" is an observation about a running poller and not about a process that
       * was killed before it could make one. */
      return response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 0, events: [],
        decisions: [{ call_id: 900 + feedPolls, symbol: "TICKMARK", verdict: "declined",
          reason: `tick ${feedPolls}`, delivered_at: Date.now() + feedPolls }] }));
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let run;
  try {
    run = await runPoller({ dir, wallet, stateFile, api: `http://127.0.0.1:${server.address().port}`,
      marker: "NOT OFFERED TICKMARK: tick 4", env: { RECONCILE_MS: "0" } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
  ok("the paper poller ran at least four full ticks with a held call", run.found,
    `${feedPolls} feed poll(s)`);
  ok("...and asked the desk about its held calls ZERO times, even at RECONCILE_MS=0",
    callsRequests.length === 0, `${callsRequests.length} request(s): ${callsRequests.join(", ") || "(none)"}`);
  ok("the boot banner states the cadence and that paper is disabled",
    /exit reconciliation: DISABLED in paper \(the pass runs under EXECUTE only\) — a call the desk has CLOSED is sold as a RECOVERED desk exit/.test(run.output),
    run.output.split("\n").find((l) => /exit reconciliation:/.test(l))?.slice(30, 200) || "(no line)");
  /* And it states the identity rule, because an operator reading the transcript after a
   * CRITICAL CALL IDENTITY MISMATCH should already know the bot was checking. */
  ok("...and that every answer has to name the held mint",
    /every answer must name the held mint or it is refused \(a call id is not an identity\)/.test(run.output),
    run.output.split("\n").find((l) => /exit reconciliation:/.test(l))?.slice(-90) || "(no line)");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 8. A RECOVERED EXIT IS REPORTED LIKE ANY OTHER SELL ───────────────────── */
console.log("\n8. THE RECOVERED EXIT REACHES /executor/fill AS THE DESK EXIT IT IS");
{
  /* Wave 1's boot rebuild is the honest way to observe this without a live wallet: an
   * ACCOUNTED desk_exit intent whose id came from reconciliation, with no journal ack, is
   * re-queued at boot and posted. What it must carry is the desk's code and the reconcile
   * event id — otherwise the site's board would show the bot leaving for no stated
   * reason, which is half of the Shrek complaint. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-reconcile-report-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const closedAt = Date.now() - 4 * MIN;
  const intentId = `desk-exit:reconcile:50:76:${closedAt}`;
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  journal.saveRuntime({ cursor: 0, primed: true, state: freshState(Date.now()), positions: {} });
  const sold = { mint, symbol: "RECOVERED", qtyRaw: "123456", paidSol: 0.005, costBasisLamports: "5000000",
    entryInputLamports: "4995000", solUsdAtEntry: 150, entryIntentId: "entry:recovered", entry: 1, stop: 0.6,
    target: 2, callId: 76, high: 1, openedAtMs: closedAt - 20 * MIN, riskF: 0.02 };
  const signature = "reconciled-signature-" + "4".repeat(50);
  journal.ensureIntent({ id: intentId, kind: "desk_exit", eventId: `reconcile:50:76:${closedAt}`, mint,
    inputMint: mint, outputMint: WSOL, amountRaw: "123456",
    context: { wallet: wallet.publicKey.toBase58(), position: sold,
      why: "desk exit (stop_hit) recovered by reconciliation", fraction: 1, deskCode: "stop_hit",
      riskStateBefore: freshState(Date.now()) } });
  journal.recordSigned(intentId, { attempt: 1, requestId: "r", signedTx: Buffer.from("s"), signature,
    blockhash: "b", lastValidBlockHeight: 9, quotedOutputRaw: "6000000", minOutputRaw: "6000000", order: {} });
  journal.markConfirmed(intentId, 1, { signature, totalInputAmount: "123456", totalOutputAmount: "6000000",
    networkFeeLamports: "7000" }, { status: "Success", code: 0, signature });
  journal.markAccounted(intentId, { ...journal.snapshot(), state: freshState(Date.now()), positions: {} });
  ok("fixture: the reconciled exit is accounted and unacknowledged",
    journal.getIntent(intentId).state === "accounted" && journal.getMeta(`fill_reported:${intentId}`) == null,
    journal.getIntent(intentId).state);
  journal.close();

  const posted = [];
  const server = http.createServer((request, response) => {
    let body = ""; request.on("data", (c) => { body += c; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/executor/fill")) { posted.push(JSON.parse(body)); return response.end(JSON.stringify({ ok: true })); }
      if (request.url?.includes("/executor/feed"))
        return response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 0, events: [] }));
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let run;
  try {
    run = await runPoller({ dir, wallet, stateFile, api: `http://127.0.0.1:${server.address().port}`,
      marker: `reported sell fill of call 76 (${intentId})` });
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const report = posted.find((p) => p.intentId === intentId);
  ok("the reconciled sell was posted to /executor/fill", run.found && Boolean(report),
    `${posted.length} POST(s): ${posted.map((p) => p.intentId).join(", ") || "(none)"}`);
  ok("it is a desk_exit carrying the desk's code and the reconcile event id",
    report?.side === "sell" && report?.kind === "desk_exit" && report?.deskCode === "stop_hit" &&
      report?.eventId === `reconcile:50:76:${closedAt}`,
    `${report?.kind} / ${report?.deskCode} / ${report?.eventId}`);
  ok("with real numbers: 6,000,000 lamports out net of a 7,000 fee, realized against a 5,000,000 basis",
    report && Math.abs(report.sol - 0.005993) < 1e-12 && Math.abs(report.realizedSol - 0.000993) < 1e-12 &&
      report.qtyRaw === "123456" && report.callId === 76,
    `sol ${report?.sol}, realized ${report?.realizedSol}, qty ${report?.qtyRaw}`);
  ok("and the reason names reconciliation, so the board cannot read it as a delivered event",
    report?.reason === "desk exit (stop_hit) recovered by reconciliation", report?.reason);
  assert.equal(typeof report?.signature, "string");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 9. THE ROW MUST PROVE IT IS ABOUT THE COIN THE BOT HOLDS ──────────────── */
console.log("\n9. A CALL ID IS NOT AN IDENTITY: THE RECONCILE PATH REFUSES A FOREIGN MINT");
{
  /* THE HOLE THIS CLOSES. reconcileOneHeldCall bound on the call id ALONE — it took
   * `byCallId.get(Number(pos.callId))`, adopted that row's absolute levels and, on a
   * closed row, sold the WHOLE position. The delivered-event path has refused a foreign
   * mint since long before wave 2 (journal.mjs deskExitDecisionForPosition:
   * `if (String(event.mint || "") !== position.mint) return {action:"ignore"}`, commented
   * there as "mint equality alone is never sufficient"), and this path asserted neither
   * half. It is reachable without malice: `calls.id` is INTEGER PRIMARY KEY AUTOINCREMENT,
   * so a desk database restored from a backup re-issues ids the bot is already holding —
   * the exact condition the change's own CRITICAL FEED ROLLBACK branch exists to detect —
   * and a bot restarted against a different CC_FLOOR reaches the same wrong answer with no
   * rollback at all. Shrek's numbers, two coins, one id. */
  const heldMint = "Shrek1111111111111111111111111111111111111";
  const otherMint = "Other2222222222222222222222222222222222222";
  const held = { mint: heldMint, symbol: "SHREK", callId: 55,
    deskEntryRef: 0.00035, deskStop: 0.0003214, deskTarget: 0.00044, deskOpenedAt: T0,
    holdBand: "nano", holdMaxMs: 30 * MIN };
  const same = callIdentityVerdict(held, { call_id: 55, mint: heldMint, status: "live" });
  ok("a row naming the held mint is accepted", same.ok === true && same.mismatch === false,
    `ok ${same.ok} / mismatch ${same.mismatch} — ${same.reason}`);
  const foreign = callIdentityVerdict(held, { call_id: 55, mint: otherMint, status: "closed" });
  ok("a row naming a DIFFERENT mint is refused, and flagged as a contradiction",
    foreign.ok === false && foreign.mismatch === true && foreign.answeredMint === otherMint,
    `ok ${foreign.ok} / mismatch ${foreign.mismatch} / answered ${foreign.answeredMint}`);
  const silent = callIdentityVerdict(held, { call_id: 55, status: "closed" });
  ok("a row with NO mint proves nothing and is refused too — but it is not a contradiction",
    silent.ok === false && silent.mismatch === false, `ok ${silent.ok} / mismatch ${silent.mismatch} — ${silent.reason}`);
  const mintless = callIdentityVerdict({ symbol: "NOMINT", callId: 55 }, { call_id: 55, mint: heldMint });
  ok("a position with no mint can prove nothing either", mintless.ok === false && mintless.mismatch === false,
    `${mintless.ok} — ${mintless.reason}`);

  /* THE SAME ROW, THROUGH THE VERDICT THE POLLER ACTUALLY CALLS. Without the position it
   * is a desk exit — which is exactly what the bot used to do with it. */
  const closedForeign = { call_id: 55, mint: otherMint, status: "closed", close_reason: "stop_hit",
    close_mark: 0.0003026, closed_at: T0 + 9 * MIN, opened_at: T0, entry_ref: 0.0009, stop: 0.0008 };
  const blind = reconcileVerdict({ call: closedForeign, now: T0 + 20 * MIN, deskSilentMs: SILENT_MS, floorNo: "50" });
  ok("id-only, with no position to compare, that row still reads as a desk exit (the old behaviour)",
    blind.action === "desk_exit", `${blind.action}`);
  const guarded = reconcileVerdict({ call: closedForeign, position: held, now: T0 + 20 * MIN,
    deskSilentMs: SILENT_MS, floorNo: "50" });
  ok("with the held position supplied it is an IDENTITY MISMATCH, never a desk exit",
    guarded.action === "identity_mismatch" && guarded.answeredMint === otherMint,
    `${guarded.action} — answered ${guarded.answeredMint} vs held ${guarded.heldMint}`);
  const staleForeign = reconcileVerdict({ position: held, now: T0 + 40 * MIN, deskSilentMs: SILENT_MS,
    floorNo: "50", call: { call_id: 55, mint: otherMint, status: "live", opened_at: T0, last_mark_ts: T0 } });
  ok("...and a foreign LIVE row does not engage the mirror either",
    staleForeign.action === "identity_mismatch", staleForeign.action);
  const unproven = reconcileVerdict({ position: held, now: T0 + 20 * MIN, deskSilentMs: SILENT_MS,
    floorNo: "50", call: { call_id: 55, status: "closed", close_reason: "stop_hit", closed_at: T0 } });
  ok("a row that names no mint is identity_unproven — hold, exactly like an absent row",
    unproven.action === "identity_unproven", `${unproven.action} — ${unproven.reason}`);
  const good = reconcileVerdict({ position: held, now: T0 + 20 * MIN, deskSilentMs: SILENT_MS,
    floorNo: "50", call: { ...closedForeign, mint: heldMint } });
  ok("the identical row about the HELD mint is the desk exit it always was",
    good.action === "desk_exit" && good.code === "stop_hit", `${good.action} / ${good.code}`);

  /* AND NOTHING FROM A REFUSED ROW TOUCHES THE POSITION. The levels on the foreign row
   * are wildly different (entry 0.0009, stop 0.0008); adopting them would put the mirror
   * on another coin's stop, which is the second half of the same defect. */
  const beforeStop = held.deskStop;
  const act = (pos, call) => {
    const verdict = reconcileVerdict({ call, position: pos, now: T0 + 20 * MIN,
      deskSilentMs: SILENT_MS, floorNo: "50" });
    if (verdict.action === "identity_mismatch" || verdict.action === "identity_unproven")
      return { sold: false, adopted: [], action: verdict.action };
    const adopted = refreshDeskLevels(pos, call);
    return { sold: verdict.action === "desk_exit", adopted, action: verdict.action };
  };
  const refused = act(held, closedForeign);
  ok("the foreign row sells nothing and adopts no level",
    refused.sold === false && refused.adopted.length === 0 && held.deskStop === beforeStop,
    `sold ${refused.sold}, ${refused.adopted.length} level(s) adopted, deskStop ${held.deskStop}`);
  const accepted = act(held, { call_id: 55, mint: heldMint, status: "live", opened_at: T0,
    last_mark_ts: T0 + 19 * MIN, stop: 0.00034 });
  ok("...while the desk's own row still restates the stop and is watched",
    accepted.action === "watch" && held.deskStop === 0.00034,
    `${accepted.action}, deskStop ${held.deskStop}`);

  /* THE ORDER IN THE LIVE PASS, BY SOURCE: both refusals return BEFORE the levels are
   * refreshed and before any sell. A pure verdict that is never consulted first is not a
   * guard. */
  const one = src.slice(src.indexOf("async function reconcileOneHeldCall"), src.indexOf("async function reconcileHeldCalls()"));
  ok("reconcileOneHeldCall hands the held position to the verdict",
    /reconcileVerdict\(\{ call, position: pos, now: deskNow,/.test(one), "");
  const atMismatch = one.indexOf('if (verdict.action === "identity_mismatch")');
  const atUnproven = one.indexOf('if (verdict.action === "identity_unproven")');
  const atRefresh = one.indexOf("const changes = refreshDeskLevels(pos, call);");
  const atSell = one.indexOf("await sellAll(");
  ok("both identity refusals come before refreshDeskLevels and before the sell",
    atMismatch > 0 && atUnproven > atMismatch && atRefresh > atUnproven && atSell > atRefresh,
    `mismatch@${atMismatch} < unproven@${atUnproven} < refresh@${atRefresh} < sell@${atSell}`);
  ok("a mismatch returns without selling, and says so at the top of the transcript",
    /return "identity-mismatch";/.test(one) && /CRITICAL CALL IDENTITY MISMATCH \$\{pos\.symbol\}/.test(one) &&
      /this needs an operator/.test(one), "");
  ok("...and is a durable flag, not just a log line: new exposure is blocked while it stands",
    /pos\.deskIdentityMismatch = true;/.test(one) && /pos\.riskDataUnavailable = true;/.test(one),
    "riskDataUnavailable is journal.positionEntryBlock's flag and heartbeat-health's blockedPositions");
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("function recordPositionFailure"));
  ok("a readable exit quote does NOT clear an identity contradiction",
    /if \(pos\.deskIdentityMismatch !== true\) \{\s*\n\s*delete pos\.riskDataUnavailable;/.test(manage), "");
  ok("a row that names the held mint again lifts the alarm",
    /CALL IDENTITY RESTORED \$\{pos\.symbol\}/.test(one) && /delete pos\.deskIdentityMismatch;/.test(one), "");
  ok("an unproven identity is logged once per call id, like absence",
    /if \(!reconcileIdentityUnprovenLogged\.has\(callId\)\) \{/.test(one), "");

  /* THE ROLLBACK GATE. While the authenticated latest_id sits behind the durable cursor
   * the desk's database is not the one the bot has been trading against — entries are
   * frozen for exactly that reason — and /executor/calls reads that same database, whose
   * ids are AUTOINCREMENT. consumeFeed calls noteDeskReachable() BEFORE the rollback
   * branch (a desk that answers IS reachable; mirroring a talking desk would be the bot
   * second-guessing it), so unreachability does not cover this and the flag must. */
  const rollbackOpen = { execute: true, inFlight: false, deskUnreachableSince: null, now: T0,
    lastReconcileAt: T0 - 5 * MIN, reconcileMs: MIN, heldCallIds: [55] };
  ok("no reconciliation while the authenticated feed is in rollback",
    reconcileGate({ ...rollbackOpen, feedRollback: true }).run === false &&
      reconcileGate({ ...rollbackOpen, feedRollback: true }).why === "feed-rollback",
    reconcileGate({ ...rollbackOpen, feedRollback: true }).why);
  ok("...and the same pass runs the moment the rollback clears",
    reconcileGate({ ...rollbackOpen, feedRollback: false }).run === true,
    reconcileGate({ ...rollbackOpen, feedRollback: false }).why);
  const reconcileFn = src.slice(src.indexOf("async function reconcileHeldCalls()"), src.indexOf("/* THE FEED, READ BEFORE THE BOOK IS VALUED."));
  ok("the live pass feeds it the same flag that freezes entries",
    /feedRollback: feedRollbackActive\(\),/.test(reconcileFn) &&
      /if \(feedRollbackActive\(\)\)\s*\n\s*return log\(`SKIP \$\{ev\.symbol\}: authenticated feed latest_id rolled behind durable cursor/.test(src),
    "");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
