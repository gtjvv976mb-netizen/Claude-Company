/**
 * DESK-LED EXITS (desk-led-v4, 2026-09-05).
 *
 * Shrek, call 55: the bot sold at 03:01:42Z on its own normalised stop at -13.5%; the
 * desk's determined stop_hit came at 03:10:24Z and its exit row landed on a position
 * that no longer existed ("EXIT Shrek — not held"). The owner's rule, verbatim: "all
 * exits should be followed not after or before, but as exactly as it was determined".
 *
 * What this suite pins, end to end:
 *   1. the bot has NO exit of its own — stepPosition holds at the stop, the target, 2x,
 *      the window and the age backstop unless a desk exit is supplied;
 *   2. the tick reads the FEED before it values the book, on every tick, POLL_MS 5 s;
 *   3. the desk-unreachability clock and MIRROR mode: engages only after
 *      DESK_UNREACHABLE_MS, evaluates the desk's absolute levels with the desk's ruler,
 *      maps to the desk's code, and the clock lane runs even when the price lane declines;
 *   4. the DexScreener consensus port is byte-for-byte the desk's function;
 *   5. mirror_exit is an exit everywhere it must be, and exempt from re-validation;
 *   6. every fill AND every exit is reported to POST /executor/fill with real numbers,
 *      404 is a failure, a 2xx writes the journal ack, and boot rebuilds the queue from
 *      accounted intents;
 *   7. the env bounds, the runtime-file lists and the allowlist carry the new names.
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
import { ExecutionJournal, EXIT_INTENT_KINDS } from "./journal.mjs";
import { WSOL, priceImpactCapForIntent } from "./jupiter.mjs";
import { DEFAULTS, POLICY_VERSION, freshState, openPosition, stepPosition } from "./strategy.mjs";
import { POLICY_DEFAULTS, pricePolicy } from "./trade-policy.mjs";
import {
  MIRROR_MARK_MS, deskCodeForReason, deskPolicyConfig, evaluateMirror, exitLatchKind,
  mirrorLatchExpiry, mirrorPosition, mirrorPriceable, refreshDeskLevels,
} from "./desk-mirror.mjs";
import { consensus as portedConsensus, consensusMark, pairsFor } from "./dexscreener-consensus.mjs";
import { validateExecutableExitOrder } from "./exit-trigger.mjs";
import { consensus as deskConsensus } from "../src/data/dexscreener.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLLER = path.join(here, "poller.mjs");
const src = fs.readFileSync(POLLER, "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const T0 = 1_757_000_000_000;
const MIN = 60_000;

/* ── 1. THE BOT HAS NO EXIT OF ITS OWN ─────────────────────────────────────── */
console.log("\n1. THE BOT HOLDS UNLESS THE DESK SAID SELL");
{
  // Shrek's real numbers: entry_ref 0.00035, stop 0.0003214 (-8.2%), target 0.00044.
  const shrek = { mint: "Shrek", symbol: "Shrek", entry_ref: 0.00035, stop: 0.865, target: 1.257,
    deskStop: 0.0003214, deskTarget: 0.00044, opened_at: T0, openedAtMs: T0 + 15_000,
    hold_band: "nano", hold_max_ms: 30 * MIN };
  const fresh = () => openPosition({ call: shrek, sol: 0.0175, fillPrice: 1, cfg: DEFAULTS });
  const marks = [["-13.5% (the bot's own stop, 03:01:42Z)", 0.865], ["the authored target", 1.257],
    ["2x", 2], ["a 60% crash", 0.4], ["a 5x run", 5]];
  for (const [label, mark] of marks) {
    const d = stepPosition({ pos: fresh(), mark, cfg: DEFAULTS, nowMs: T0 + 20 * MIN });
    ok(`holds at ${label}`, d.action === "hold", `${d.action} — ${d.reason}`);
  }
  const atWindow = stepPosition({ pos: fresh(), mark: 1, cfg: DEFAULTS, nowMs: T0 + 31 * MIN });
  ok("holds at the nano window (the desk closes it, not the bot)", atWindow.action === "hold", atWindow.reason);
  const atBackstop = stepPosition({ pos: fresh(), mark: 1, cfg: DEFAULTS, nowMs: T0 + 25 * 3600e3 });
  ok("holds past the 24h backstop", atBackstop.action === "hold", atBackstop.reason);
  const ratchet = fresh();
  for (const m of [1.35, 1.35, 1.5, 1.5, 2, 2]) stepPosition({ pos: ratchet, mark: m, cfg: DEFAULTS });
  ok("no level moves on the position across a confirmed run", ratchet.stop === 0.865 && ratchet.high === 1,
    `stop ${ratchet.stop}, high ${ratchet.high}`);
  const desk = stepPosition({ pos: fresh(), mark: 0.9, deskExit: { code: "stop_hit" }, cfg: DEFAULTS });
  ok("a desk exit sells everything at once", desk.action === "sell" && desk.fraction === 1 && /stop_hit/.test(desk.reason), desk.reason);
  ok("the shared pricePolicy is unchanged and still knows the stop (the desk runs it)",
    pricePolicy({ position: { entry: 0.00035, stop: 0.0003214, target: 0.00044, high: 0.00035, openedAtMs: T0 },
      mark: 0.0003, nowMs: T0 + MIN }).action === "sell");
  ok("policy version is desk-led-v4 on the strategy surface", POLICY_VERSION === "desk-led-v4", POLICY_VERSION);
}

/* ── 2. TICK ORDER, POLL_MS, MARK_MS — by source ───────────────────────────── */
console.log("\n2. THE FEED IS READ BEFORE THE BOOK IS VALUED, EVERY TICK");
{
  const tick = src.slice(src.indexOf("async function tick()"), src.indexOf("log(`up — floor"));
  const order = ["await boundedRecoveryBeforeRisk();", "accountConfirmedIntents();", "await consumeFeed();",
    "await manageOpen();", "await mirrorTick();", "flushFillReports().catch(() => {});",
    "flushUnreportedFills().catch(() => {});", "sendHeartbeat();"];
  const positions = order.map((s) => tick.indexOf(s));
  ok("tick order: recovery → accounting → feed → manageOpen → mirror → fill reports → take flags → heartbeat",
    positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), positions.join(" < "));
  ok("manageOpen is gated by MARK_MS", /Date\.now\(\) - lastManageOpenAt >= MARK_MS/.test(tick));
  ok("...but a latched exit is never throttled behind it",
    /const latchedExit = openList\(\)\.some\(\(position\) => position\.exitExecutionRequired === true\);\s*\n\s*if \(latchedExit \|\|/.test(tick));
  ok("POLL_MS defaults to 5 s", /const POLL_MS = Number\(process\.env\.POLL_MS \|\| 5_000\);/.test(src));
  ok("POLL_MS bounds are unchanged (1 s to 1 h)", /number\("POLL_MS", POLL_MS, \{ min: 1_000, max: 3_600_000 \}\);/.test(src));
  ok("MARK_MS defaults to 15 s", /const MARK_MS = Number\(process\.env\.MARK_MS \?\? 15_000\);/.test(src));
  ok("MARK_MS live bounds 5 s to 5 min, paper any >= 0",
    /number\("MARK_MS", MARK_MS, EXECUTE \? \{ min: 5_000, max: 300_000 \} : \{ min: 0 \}\);/.test(src));
  ok("DESK_UNREACHABLE_MS defaults to 10 min", /const DESK_UNREACHABLE_MS = Number\(process\.env\.DESK_UNREACHABLE_MS \?\? 600_000\);/.test(src));
  ok("DESK_UNREACHABLE_MS live bounds 2 min to 1 h, paper any >= 0",
    /number\("DESK_UNREACHABLE_MS", DESK_UNREACHABLE_MS, EXECUTE \? \{ min: 120_000, max: 3_600_000 \} : \{ min: 0 \}\);/.test(src));
  ok("MIRROR_MARK_MS is the desk's 45 s sub-tick", MIRROR_MARK_MS === 45_000, String(MIRROR_MARK_MS));
  const consume = src.slice(src.indexOf("async function consumeFeed()"), src.indexOf("let lastManageOpenAt"));
  ok("the exit prepass and the sequential pass survived the move",
    /events\.filter\(\(event\) => event\.type === "exit"\)/.test(consume) && /unsafeExitPrepass/.test(consume) &&
      /advanceFrozenBatchCursor/.test(consume) && /handleDeskExitEvent\(ev\)/.test(consume));
  ok("desk unreachability is noted on network error, non-2xx and 401",
    /noteDeskUnreachable\(error\.message\)/.test(consume) && /noteDeskUnreachable\(`feed HTTP \$\{response\.status\}`\)/.test(consume) &&
      /noteDeskUnreachable\("feed authentication rejected"\)/.test(consume));
  ok("...and cleared on a valid authenticated payload, BEFORE the rollback verdict",
    consume.indexOf("noteDeskReachable();") > 0 && consume.indexOf("noteDeskReachable();") < consume.indexOf("if (feedCursor.rollback) {"));
  ok("the CRITICAL FEED ROLLBACK line still promises latched exits continue",
    /CRITICAL FEED ROLLBACK:[\s\S]*entries remain frozen; local position\/risk exits continue/.test(consume));
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("function recordPositionFailure"));
  ok("manageOpen's only sellAll is the latched retry", (manage.match(/await sellAll\(/g) || []).length === 1,
    `${(manage.match(/await sellAll\(/g) || []).length}`);
  ok("manageOpen refuses a local sell verdict out loud", /REFUSED \$\{pos\.symbol\}: local policy asked to/.test(manage));
}

/* ── 3. MIRROR MODE, in-process ────────────────────────────────────────────── */
console.log("\n3. THE MIRROR EVALUATES THE DESK'S LEVELS WITH THE DESK'S RULER");
{
  const pos = openPosition({ call: { mint: "Shrek", symbol: "Shrek", entry_ref: 0.00035, stop: 0.865, target: 1.257,
    deskStop: 0.0003214, deskTarget: 0.00044, opened_at: T0, openedAtMs: T0 + 15_000,
    hold_band: "nano", hold_max_ms: 30 * MIN }, sol: 0.0175, fillPrice: 1, cfg: DEFAULTS });
  const m = mirrorPosition(pos);
  ok("mirrorPosition carries the desk's absolute levels, not the ratios",
    m.entry === 0.00035 && m.stop === 0.0003214 && m.target === 0.00044 && m.openedAtMs === T0 && m.holdBand === "nano" && m.holdMaxMs === 30 * MIN,
    JSON.stringify(m));
  ok("the high seeds at the desk's entry_ref like calls.js policyHwm", m.high === 0.00035, String(m.high));
  ok("priceable", mirrorPriceable(pos) === true);
  const stop = evaluateMirror(pos, { mark: 0.00032, now: T0 + 10 * MIN });
  ok("stop_hit at the desk's absolute stop (0.00032 < 0.0003214)", stop.action === "sell" && stop.code === "stop_hit", `${stop.code} — ${stop.reason}`);
  const aboveStop = evaluateMirror(pos, { mark: 0.000322, now: T0 + 10 * MIN });
  ok("holds one tick above the desk's stop", aboveStop.action === "hold", aboveStop.reason);
  const target = evaluateMirror(pos, { mark: 0.00044, now: T0 + 10 * MIN });
  ok("target_hit at the desk's absolute target", target.code === "target_hit", `${target.code}`);
  const take = evaluateMirror(pos, { mark: 0.0007, now: T0 + 10 * MIN });
  ok("take_profit at 2x entry_ref", take.code === "take_profit", `${take.code} — ${take.reason}`);
  const window = evaluateMirror(pos, { mark: null, now: T0 + 30 * MIN });
  ok("thesis_expired at the nano window with NO mark — the clock lane runs alone", window.code === "thesis_expired", `${window.code} — ${window.reason}`);
  const noMarkInside = evaluateMirror(pos, { mark: null, now: T0 + 5 * MIN });
  ok("no mark inside the window is a hold, never a false stop", noMarkInside.action === "hold", noMarkInside.reason);
  // Two-witness high: a lone spike never arms a stop on the mirror either.
  const spiky = openPosition({ call: { mint: "S", symbol: "S", entry_ref: 1, stop: 0.62, target: null, deskStop: 0.62,
    opened_at: T0, openedAtMs: T0 }, sol: 0.02, fillPrice: 1, cfg: DEFAULTS });
  evaluateMirror(spiky, { mark: 1.1, now: T0 + MIN });
  evaluateMirror(spiky, { mark: 1.9, now: T0 + 2 * MIN });
  const afterSpike = evaluateMirror(spiky, { mark: 1.1, now: T0 + 3 * MIN });
  ok("a lone 1.9x spike does not ratchet the mirror's stop", afterSpike.action === "hold" && spiky.mirrorHigh < 1.9,
    `${afterSpike.action}, mirrorHigh ${spiky.mirrorHigh}, pending ${spiky.mirrorPendingHigh}`);
  evaluateMirror(spiky, { mark: 1.6, now: T0 + 4 * MIN });
  evaluateMirror(spiky, { mark: 1.7, now: T0 + 5 * MIN });
  ok("a real run commits the LOWER of two consecutive witnesses", spiky.mirrorHigh === 1.6, String(spiky.mirrorHigh));
  const trailed = evaluateMirror(spiky, { mark: 1.15, now: T0 + 6 * MIN });
  ok("...and the ratcheted stop fires as stop_hit, the desk's code", trailed.action === "sell" && trailed.code === "stop_hit", `${trailed.code} — ${trailed.reason}`);
  // Defaults, not operator dials: the mirror must reproduce the desk.
  const cfgSeen = evaluateMirror(pos, { mark: 0.00036, now: T0 + MIN });
  ok("the mirror runs POLICY_DEFAULTS (policy version stamped)", cfgSeen.policyVersion === POLICY_VERSION && POLICY_DEFAULTS.takeProfitX === 2);
  for (const [reason, code] of [["take profit: 2.00x at or above the 2x rule", "take_profit"], ["age exit — 25h with no resolution", "thesis_expired"],
    ["the micro window closed after 61m — this desk sells on the clock", "thesis_expired"], ["desk target hit", "target_hit"],
    ["stop loss", "stop_hit"], ["ratcheted stop", "stop_hit"]])
    ok(`code for "${reason.slice(0, 28)}" is ${code}`, deskCodeForReason(reason) === code, deskCodeForReason(reason));
  // A legacy position: clock only.
  const legacy = { mint: "L", symbol: "L", entry: 1, stop: 0.6, target: 2, high: 1, openedAtMs: T0, holdBand: "nano", holdMaxMs: 30 * MIN };
  ok("a position without desk levels is not priceable", mirrorPriceable(legacy) === false);
  const legacyPrice = evaluateMirror(legacy, { mark: 0.1, now: T0 + MIN });
  ok("...so a 90% crash on its RATIO stop is ignored by the mirror (that stop sold Shrek)", legacyPrice.action === "hold", legacyPrice.reason);
  const legacyClock = evaluateMirror(legacy, { mark: 0.1, now: T0 + 31 * MIN });
  ok("...while its window still closes on the clock", legacyClock.code === "thesis_expired", `${legacyClock.code}`);
}

/* ── 4. THE DEXSCREENER PORT ───────────────────────────────────────────────── */
console.log("\n4. THE CONSENSUS PORT IS THE DESK'S FUNCTION");
{
  const pool = (dexId, priceUsd, usd, chainId = "solana") => ({ chainId, dexId, priceUsd: String(priceUsd), liquidity: { usd } });
  const fixtures = {
    "RAY 5,000x broken deepest pool": [pool("meteora", 4064.74, 7_070_000), pool("raydium", 0.81, 2_000_000), pool("orca", 0.82, 1_500_000), pool("pumpswap", 0.80, 900_000)],
    "graduated pump.fun dead curve": [pool("pumpfun", 0.0000415, 0), pool("pumpswap", 0.008676, 247_346)],
    "one pool": [pool("raydium", 1.5, 10_000)],
    "no liquidity reported anywhere": [pool("a", 1, 0), pool("b", 1.1, 0), pool("c", 3, 0)],
    "nothing on solana": [pool("uni", 1, 100, "ethereum")],
    "twelve pools, top eight vote": Array.from({ length: 12 }, (_, i) => pool(`d${i}`, 1 + i * 0.01, 1000 * (12 - i))),
    "a bad price rejected": [pool("a", 1, 5000), pool("b", 1.01, 4000), pool("c", 9, 3000)],
  };
  for (const [name, pairs] of Object.entries(fixtures)) {
    const a = portedConsensus(pairs), b = deskConsensus(pairs);
    ok(`${name}: identical result`, JSON.stringify(a) === JSON.stringify(b),
      `port ${a.ok ? `$${a.priceUsd} liq $${a.liquidityUsd} pools ${a.poolsUsed}` : a.error} / desk ${b.ok ? `$${b.priceUsd}` : b.error}`);
  }
  const ray = portedConsensus(fixtures["RAY 5,000x broken deepest pool"]);
  /* THE WEIGHTED MEDIAN FOLLOWS THE MONEY, EVEN WHEN THE MONEY LOOKS WRONG. This fixture
   * was written expecting $0.81 — the price three of four pools agree on. The desk answers
   * $4,064.74, and the desk is right by its own definition: that pool holds 7.07M of the
   * 11.47M total (61.6%), so it alone crosses the half-weight line. A liquidity-weighted
   * median IS the deepest pool whenever one pool holds the majority of the depth. The port
   * is asserted identical to the desk above; this asserts what that shared function DOES,
   * so nobody re-derives the expectation from intuition again. Whether the desk SHOULD cap
   * any single pool's vote is a live question for the owner — it would move every desk
   * mark, so it is not changed here. */
  ok("a single pool holding 61.6% of the depth IS the weighted median", ray.ok && ray.priceUsd === 4064.74 && ray.poolsUsed === 1,
    `${ray.priceUsd} from ${ray.poolsUsed} pool(s), ${ray.poolsRejected.length} rejected`);
  const grad = portedConsensus(fixtures["graduated pump.fun dead curve"]);
  ok("the dead curve is drained, pumpswap prices it", grad.ok && grad.priceUsd === 0.008676 && grad.drainedPoolsIgnored === 1, `$${grad.priceUsd}`);
  ok("the port keeps the desk's exact API (pairsFor, consensus)", typeof pairsFor === "function" && typeof portedConsensus === "function");
  ok("the port has no imports (standalone install, no src/)", !/^import /m.test(fs.readFileSync(path.join(here, "dexscreener-consensus.mjs"), "utf8")));
  ok("fetch timeout is 8 s", /FETCH_TIMEOUT_MS = 8_000/.test(fs.readFileSync(path.join(here, "dexscreener-consensus.mjs"), "utf8")));
  // DS_OFFLINE declines deterministically; no network.
  const saved = process.env.DS_OFFLINE;
  process.env.DS_OFFLINE = "1";
  const declined = await consensusMark("So11111111111111111111111111111111111111112");
  ok("DS_OFFLINE=1 declines (no fetch, clock lane only)", declined.ok === false && /DS_OFFLINE/.test(declined.error), declined.error);
  if (saved == null) delete process.env.DS_OFFLINE; else process.env.DS_OFFLINE = saved;
  // A fetch that fails never throws — a null mark, and the clock still runs.
  const failing = await consensusMark("Mint", { fetchJson: async () => ({ ok: false, error: "HTTP 503" }) });
  ok("a failed fetch is a decline, not an exception", failing.ok === false && failing.error === "HTTP 503", failing.error);
  const priced = await consensusMark("Mint", { fetchJson: async () => ({ ok: true, data: { pairs: fixtures["RAY 5,000x broken deepest pool"] } }) });
  ok("a good fetch yields the consensus priceUsd", priced.ok && priced.priceUsd === 4064.74 && priced.poolsUsed === 1, JSON.stringify(priced));
}

/* ── 5. mirror_exit IS AN EXIT EVERYWHERE ──────────────────────────────────── */
console.log("\n5. mirror_exit IS AN EXIT KIND, EXEMPT FROM RE-VALIDATION");
{
  ok("journal exports the exit kinds with mirror_exit", EXIT_INTENT_KINDS.includes("mirror_exit") && EXIT_INTENT_KINDS.includes("desk_exit"), EXIT_INTENT_KINDS.join(","));
  ok("price-impact cap for mirror_exit is the EXIT cap", priceImpactCapForIntent("mirror_exit", { maxPriceImpactPct: 5, maxExitPriceImpactPct: 50 }) === 50);
  ok("validateExecutableExitOrder returns null for mirror_exit",
    validateExecutableExitOrder({ kind: "mirror_exit", context: { trigger: { kind: "price", observedAt: 0 } } }, {}, { nowMs: 999_999 }) === null);
  const jup = fs.readFileSync(path.join(here, "jupiter.mjs"), "utf8");
  const safety = jup.slice(jup.indexOf("_isSafetyExit(intent) {"), jup.indexOf("_validateIntentSpec"));
  ok("jupiter's _isSafetyExit admits mirror_exit (else a live mirror sell is refused at _validateIntentSpec)",
    /intent\.kind === "mirror_exit"/.test(safety), safety.trim().split("\n").find((l) => /kind ===/.test(l))?.trim());
  const sell = src.slice(src.indexOf("async function sellAll"), src.indexOf("async function handleDeskExitEvent"));
  /* The prefix→kind mapping is now ONE expression (exitKindForIntentId), used by sellAll
   * for the intent and by latchExit for the latch's stamp, so a latch can never disagree
   * with the intent it will submit about which kind of determination it carries. */
  ok("sellAll maps mirror-exit:* ids to kind mirror_exit",
    /const kind = exitKindForIntentId\(suppliedIntentId\);/.test(sell) &&
      /id\.startsWith\("mirror-exit:"\) \? "mirror_exit" : "risk_exit";/.test(src) &&
      /id\.startsWith\("desk-exit:"\) \? "desk_exit"/.test(src));
  ok("...and latchExit stamps the latch with that same expression",
    /pos\.exitExecutionKind \|\|= exitKindForIntentId\(intentId\);/.test(src));
  ok("...and carries the desk's code into the intent context", /deskCode: meta\?\.deskCode \?\? pos\.exitExecutionDeskCode \?\? null/.test(sell));
  ok("desk exits pass their code through", /await sellAll\(pos, reason, 1, `desk-exit:\$\{eventId\}`, null, \{ deskCode: ev\.code \|\| null \}\)/.test(src));
  ok("mirror sells use the mirror-exit id and the desk's code",
    /await sellAll\(pos, `mirror exit \(\$\{verdict\.code\}\): \$\{verdict\.reason\}`, 1,\s*\n\s*`mirror-exit:/.test(src) && /\{ deskCode: verdict\.code \}/.test(src));
  ok("accounting accepts every exit kind", /else if \(EXIT_INTENT_KINDS\.includes\(intent\.kind\)\) applyConfirmedExit\(intent\);/.test(src));
  // The journal accepts the kind and treats it as a safety exit for the conflict lock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-desk-led-journal-"));
  const wallet = Keypair.generate().publicKey.toBase58();
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet });
  const mint = Keypair.generate().publicKey.toBase58();
  const spec = { id: "mirror-exit:entry:x", kind: "mirror_exit", mint, inputMint: mint, outputMint: WSOL, amountRaw: "10",
    context: { position: { mint, qtyRaw: "10", costBasisLamports: "100" }, why: "mirror exit (stop_hit)" } };
  ok("journal.ensureIntent accepts mirror_exit", journal.ensureIntent(spec).kind === "mirror_exit");
  const other = Keypair.generate().publicKey.toBase58();
  journal.ensureIntent({ id: "entry:other", kind: "entry", mint: other, inputMint: WSOL, outputMint: other, amountRaw: "5", context: {} });
  journal.recordSigned("entry:other", { attempt: 1, requestId: "r", signedTx: Buffer.from("x"), signature: "s".repeat(64),
    blockhash: "b", lastValidBlockHeight: 1, quotedOutputRaw: "1", minOutputRaw: "1", order: {} });
  ok("an unrelated unresolved entry does not block a mirror_exit (safety-exit lock)",
    journal.hasConflictingIntent(spec) === null, String(journal.hasConflictingIntent(spec)));
  ok("...while an entry candidate IS blocked by it", journal.hasConflictingIntent({ id: "entry:new", kind: "entry", mint: other, inputMint: WSOL, outputMint: other }) === "entry:other");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 6. FILL / EXIT REPORTING, REAL POLLER, LOCAL DESK ─────────────────────── */
console.log("\n6. EVERY FILL AND EVERY EXIT IS REPORTED WITH REAL NUMBERS");
function recordConfirmed(journal, spec, { input, output, signature, fee }) {
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, { attempt: 1, requestId: `request-${spec.id}`, signedTx: Buffer.from(`signed-${spec.id}`),
    signature, blockhash: "test-blockhash", lastValidBlockHeight: 999, quotedOutputRaw: output, minOutputRaw: output, order: { test: true } });
  journal.markConfirmed(spec.id, 1, { signature, totalInputAmount: input, totalOutputAmount: output, networkFeeLamports: fee },
    { status: "Success", code: 0, signature });
}
/* `marker` is a string, OR a list of strings that must ALL have appeared before the run
 * is stopped. The list form exists because a single marker stops the poller the instant
 * ONE side of the book has been reported, and the OTHER side's retry is then killed
 * mid-flight: the desk saw the POST and the poller never lived long enough to read the
 * answer, log it or write the ack. That killed run is not a bot that failed to report —
 * it is a stopwatch that stopped too early, and reading it as a missing buy report
 * would be measuring the ruler instead of the thing. Both sides are queued at accounting
 * and flushed on the same cadence, so waiting for both is the honest observation. */
async function runPoller({ dir, wallet, stateFile, marker, api, env = {}, timeoutMs = 9_000 }) {
  const keypairFile = path.join(dir, "burner.json");
  fs.writeFileSync(keypairFile, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
  const child = spawn(process.execPath, [POLLER], { cwd: dir, env: {
    ...process.env, CC_API: api, CC_SECRET: "desk-led-test-secret", CC_FLOOR: "50", EXECUTE: "0",
    KEYPAIR: keypairFile, STATE_DB: stateFile, LOCK_FILE: `${stateFile}.lock`,
    PAUSE_ENTRIES_FILE: path.join(dir, "pause"), HARD_STOP_FILE: path.join(dir, "hard-stop"),
    POLL_MS: "1000", MARK_MS: "0", MAX_CALL_AGE_MIN: "1", JUPITER_API_KEY: "", DS_OFFLINE: "1", NODE_NO_WARNINGS: "1", ...env,
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
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-desk-led-fill-"));
  const wallet = Keypair.generate();
  const buyMint = Keypair.generate().publicKey.toBase58();
  const sellMint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const openedAt = Date.now() - 60_000;
  const sold = { mint: sellMint, symbol: "SOLD", qtyRaw: "123456", paidSol: 0.005, costBasisLamports: "5000000",
    entryInputLamports: "4995000", solUsdAtEntry: 150, solUsdSource: "pyth-sol-usd-shard0-v1", entryIntentId: "entry:sold",
    entry: 1, stop: 0.6, target: 2, callId: 76, high: 1, openedAtMs: openedAt, riskF: 0.02, takeProfitX: 2, honorDeskTarget: true };
  journal.saveRuntime({ cursor: 0, primed: true, state: { ...freshState(Date.now()), openCount: 1, bookHeat: 0.02 }, positions: { [sellMint]: sold } });
  recordConfirmed(journal, { id: "entry:50:entry:77", kind: "entry", eventId: "50:entry:77", feedId: 77, mint: buyMint, inputMint: WSOL,
    outputMint: buyMint, amountRaw: "5000000", context: {
      wallet: wallet.publicKey.toBase58(),
      event: { id: 77, call_id: 77, event_id: "50:entry:77", mint: buyMint, symbol: "BUY", ts: openedAt, opened_at: openedAt - 5_000,
        entry_ref: 0.00035, stop: 0.0003214, target: 0.00044, hold_band: "nano", hold_max_ms: 30 * MIN },
      plan: { action: "buy", sol: 0.005, f: 0.02 }, takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
      positionConfig: { stopBufferPct: 0 },
      entryReference: { marketMark: 0.00036, marketMarkAt: openedAt, entryLow: 0.0003, entryHigh: 0.0004, stopRatio: 0.8928, targetRatio: 1.2222 },
      entryPreflight: { inputAmountRaw: "5000000", forwardOutputRaw: "123456", reverseOutputRaw: "4900000", roundTripLossPct: 2,
        solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1", tokenDecimals: 6, solUsdPublishTime: Math.floor(openedAt / 1000),
        solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.01, observedAt: openedAt },
      openedAtMs: openedAt, riskStateBefore: freshState(openedAt),
    } }, { input: "5000000", output: "123456", signature: "buy-signature-" + "1".repeat(50), fee: "5000" });
  recordConfirmed(journal, { id: "desk-exit:50:exit:99", kind: "desk_exit", eventId: "50:exit:99", mint: sellMint, inputMint: sellMint,
    outputMint: WSOL, amountRaw: "123456", context: { wallet: wallet.publicKey.toBase58(), position: sold,
      why: "desk exit (stop_hit)", fraction: 1, deskCode: "stop_hit", riskStateBefore: freshState(Date.now()) } },
  { input: "123456", output: "6000000", signature: "sell-signature-" + "2".repeat(50), fee: "7000" });
  journal.close();

  const fills = [];
  let fillAnswers = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => {
      if (request.url?.includes("/executor/fill")) {
        const parsed = JSON.parse(body);
        fills.push({ ...parsed, auth: request.headers.authorization });
        // The FIRST report of each side is answered 404 (no offered delivery yet): it must
        // stay queued and come back. Later answers are 200.
        const priorForIntent = fills.filter((f) => f.intentId === parsed.intentId).length;
        fillAnswers++;
        response.writeHead(priorForIntent === 1 ? 404 : 200, { "content-type": "application/json" });
        return response.end(JSON.stringify(priorForIntent === 1 ? { error: "no offered delivery" } : { ok: true, fill: parsed }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/executor/feed")) return response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 0, events: [] }));
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let run;
  try {
    run = await runPoller({ dir, wallet, stateFile, api: `http://127.0.0.1:${port}`,
      marker: ["reported sell fill of call 76 (desk-exit:50:exit:99) to the desk",
        "reported buy fill of call 77 (entry:50:entry:77) to the desk"] });
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const out = run.output;
  ok("the poller reported BOTH sides after their 404s (both markers seen)", run.found, out.slice(-600));
  const buys = fills.filter((f) => f.side === "buy"), sells = fills.filter((f) => f.side === "sell");
  ok("a buy report was posted", buys.length >= 1, `${buys.length} buy POST(s)`);
  ok("a sell report was posted", sells.length >= 1, `${sells.length} sell POST(s)`);
  const buy = buys.at(-1), sellReport = sells.at(-1);
  ok("bearer is the executor secret", buy?.auth === "Bearer desk-led-test-secret", buy?.auth);
  ok("buy body: callId 77, sizeSol = input+fee, lamportsIn, qtyRaw, entryMark, solUsd, at=openedAt, intentId",
    buy && buy.callId === 77 && buy.signature === "buy-signature-" + "1".repeat(50) && buy.wallet === wallet.publicKey.toBase58() &&
      buy.at === openedAt && Math.abs(buy.sizeSol - 0.005005) < 1e-12 && buy.lamportsIn === 5000000 && buy.qtyRaw === "123456" &&
      buy.entryMark === 0.00036 && buy.solUsd === 150 && buy.intentId === "entry:50:entry:77",
    JSON.stringify(buy));
  ok("sell body: callId 76, qtyRaw sold, sol = proceeds net of fee, realizedSol, fraction, reason, kind, deskCode, eventId, intentId",
    sellReport && sellReport.callId === 76 && sellReport.signature === "sell-signature-" + "2".repeat(50) && sellReport.qtyRaw === "123456" &&
      Math.abs(sellReport.sol - 0.005993) < 1e-12 && Math.abs(sellReport.realizedSol - 0.000993) < 1e-12 && sellReport.fraction === 1 &&
      sellReport.reason === "desk exit (stop_hit)" && sellReport.kind === "desk_exit" && sellReport.deskCode === "stop_hit" &&
      sellReport.eventId === "50:exit:99" && sellReport.intentId === "desk-exit:50:exit:99" && Number.isSafeInteger(sellReport.at) && sellReport.at > 0,
    JSON.stringify(sellReport));
  ok("a 404 is a failure: each side was posted again after it", buys.length >= 2 && sells.length >= 2,
    `buy ${buys.length}, sell ${sells.length} POSTs; ${fillAnswers} answers`);
  ok("...and the log says so", /could not report fill detail [^ ]+ \(fill HTTP 404\) — will retry/.test(out));
  const reopened = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const ackBuy = reopened.getMeta("fill_reported:entry:50:entry:77");
  const ackSell = reopened.getMeta("fill_reported:desk-exit:50:exit:99");
  ok("a 2xx writes the journal ack for the buy", Number.isSafeInteger(ackBuy) && ackBuy > 0, String(ackBuy));
  ok("a 2xx writes the journal ack for the sell", Number.isSafeInteger(ackSell) && ackSell > 0, String(ackSell));
  ok("the position sold before the report was posted is gone from the book (the queue cannot depend on it)",
    reopened.snapshot().positions[sellMint] === undefined);
  const rebuilt = reopened.accountedIntentsWithCallId({ sinceMs: Date.now() - 7 * 24 * 3600e3 });
  ok("journal.accountedIntentsWithCallId lists both accounted intents with their call ids",
    rebuilt.map((i) => `${i.id}:${i.callId}`).sort().join(",") === "desk-exit:50:exit:99:76,entry:50:entry:77:77",
    rebuilt.map((i) => `${i.id}:${i.callId}`).join(","));
  ok("...and excludes intents older than the window", reopened.accountedIntentsWithCallId({ sinceMs: Date.now() + 1 }).length === 0);
  reopened.close();
  ok("the take flag report is untouched (still posted to /executor/take)", /reported fill of call 77 to the desk/.test(out) && /\/api\/floor\/\$\{FLOOR\}\/executor\/take/.test(src));
  const reporting = src.slice(src.indexOf("const unreportedFillDetails = new Set();"), src.indexOf("/* Recovery is never allowed"));
  ok("the route, the timeout and the failure rule are in the source",
    /\/api\/floor\/\$\{FLOOR\}\/executor\/fill/.test(reporting) && /AbortSignal\.timeout\(8_000\)/.test(reporting) &&
      /if \(!response\.ok\) throw new Error\(`fill HTTP \$\{response\.status\}`\)/.test(reporting) &&
      /journal\.setMeta\(fillReportedKey\(intentId\), Date\.now\(\)\)/.test(reporting));
  /* Both accounting paths queue-and-flush; neither awaits. This used to count every bare
   * `unreportedFillDetails.add(intent.id)` in the file and demand exactly two — an
   * expectation the very next assertion contradicts, because the boot rebuild
   * (queueUnreportedFillDetailsFromJournal) is a legitimate THIRD add of the same shape.
   * What the contract actually says is WHERE the two accounting queues live and that
   * neither blocks accounting on the desk, so that is what is pinned: one add+flush pair
   * inside applyConfirmedEntry, one inside applyConfirmedExit, two in the whole file, and
   * no `await flushFillReports()` in either — a fill is a fact about the chain and must
   * never be delayed or undone by the desk being unreachable. */
  const queuePair = /unreportedFillDetails\.add\(intent\.id\);\s*\n\s*flushFillReports\(\)\.catch\(\(\) => \{\}\);/;
  const entryAccounting = src.slice(src.indexOf("function applyConfirmedEntry(intent)"), src.indexOf("function applyConfirmedExit(intent)"));
  const exitAccounting = src.slice(src.indexOf("function applyConfirmedExit(intent)"), src.indexOf("function accountConfirmedIntents()"));
  const pairs = (src.match(new RegExp(queuePair.source, "g")) || []).length;
  ok("queued at accounting on both sides, never awaited",
    pairs === 2 && queuePair.test(entryAccounting) && queuePair.test(exitAccounting) &&
      !/await flushFillReports\(\)/.test(entryAccounting + exitAccounting),
    `${pairs} add+flush pair(s); entry ${queuePair.test(entryAccounting)}, exit ${queuePair.test(exitAccounting)}`);
  ok("boot rebuilds from accounted intents with a callId in the last 7 days whose ack is absent",
    /queueUnreportedFillDetailsFromJournal\(\)/.test(src) && /FILL_REPORT_WINDOW_MS = 7 \* 24 \* 3600e3/.test(reporting) &&
      /journal\.accountedIntentsWithCallId\(\{ sinceMs: since \}\)/.test(reporting) && /if \(acknowledged == null\) unreportedFillDetails\.add/.test(reporting));
  ok("two flushes cannot overlap", /if \(reportingFillDetails \|\| !unreportedFillDetails\.size\) return;/.test(reporting));
  fs.rmSync(dir, { recursive: true, force: true });

  // BOOT REBUILD: the acks removed → both are re-queued and re-posted on the next boot.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-desk-led-rebuild-"));
  const stateFile2 = path.join(dir2, "state.sqlite");
  const j2 = new ExecutionJournal(stateFile2, { wallet: wallet.publicKey.toBase58() });
  j2.saveRuntime({ cursor: 0, primed: true, state: freshState(Date.now()), positions: {} });
  recordConfirmed(j2, { id: "desk-exit:50:exit:5", kind: "desk_exit", eventId: "50:exit:5", mint: sellMint, inputMint: sellMint,
    outputMint: WSOL, amountRaw: "123456", context: { wallet: wallet.publicKey.toBase58(), position: sold,
      why: "desk exit (target_hit)", fraction: 1, deskCode: "target_hit", riskStateBefore: freshState(Date.now()) } },
  { input: "123456", output: "9000000", signature: "sell-signature-" + "3".repeat(50), fee: "7000" });
  // Mark it accounted by hand so boot sees an ACCOUNTED intent with no ack (the crash
  // between accounting and the report).
  const runtime = j2.snapshot();
  j2.markAccounted("desk-exit:50:exit:5", { ...runtime, state: { ...freshState(Date.now()) }, positions: {} });
  ok("fixture: the intent is accounted and unacknowledged", j2.getIntent("desk-exit:50:exit:5").state === "accounted" && j2.getMeta("fill_reported:desk-exit:50:exit:5") == null);
  j2.close();
  const posted = [];
  const server2 = http.createServer((request, response) => {
    let body = ""; request.on("data", (c) => { body += c; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/executor/fill")) { posted.push(JSON.parse(body)); return response.end(JSON.stringify({ ok: true })); }
      if (request.url?.includes("/executor/feed")) return response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 0, events: [] }));
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  let run2;
  try {
    run2 = await runPoller({ dir: dir2, wallet, stateFile: stateFile2, api: `http://127.0.0.1:${server2.address().port}`,
      marker: "reported sell fill of call 76 (desk-exit:50:exit:5)" });
  } finally { await new Promise((resolve) => server2.close(resolve)); }
  ok("boot re-queues the unacknowledged accounted exit and posts it", run2.found && posted.some((p) => p.intentId === "desk-exit:50:exit:5" && p.side === "sell" && p.deskCode === "target_hit"),
    `${posted.length} POST(s): ${posted.map((p) => p.intentId).join(",")}`);
  ok("...and says how many it owed", /1 fill report\(s\) still owed to the desk — re-queued from the journal/.test(run2.output));
  ok("sol for a 9,000,000-lamport exit net of a 7,000 fee", Math.abs((posted.find((p) => p.intentId === "desk-exit:50:exit:5")?.sol ?? 0) - 0.008993) < 1e-12,
    String(posted.find((p) => p.intentId === "desk-exit:50:exit:5")?.sol));
  fs.rmSync(dir2, { recursive: true, force: true });
}

/* ── 7. THE MIRROR ENGAGES ONLY AFTER DESK_UNREACHABLE_MS ─────────────────── */
console.log("\n7. MIRROR MODE ENGAGES ONLY AFTER DESK_UNREACHABLE_MS, AND STANDS DOWN");
{
  const mkFixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-desk-led-mirror-"));
    const wallet = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    const stateFile = path.join(dir, "state.sqlite");
    const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
    const position = { mint, symbol: "WINDOWED", qtyRaw: "123456", paidSol: 0.005, costBasisLamports: "5000000",
      entryInputLamports: "4995000", solUsdAtEntry: 150, solUsdSource: "pyth-sol-usd-shard0-v1", entryIntentId: "entry:windowed",
      entry: 1, stop: 0.6, target: 2, callId: 76, high: 1, openedAtMs: Date.now() - 31 * MIN, riskF: 0.02, takeProfitX: 2, honorDeskTarget: true,
      deskEntryRef: 0.00035, deskStop: 0.0003214, deskTarget: 0.00044, deskOpenedAt: Date.now() - 31 * MIN, holdBand: "nano", holdMaxMs: 30 * MIN };
    /* THE DURABLE ENTRY INTENT IS PART OF THE FIXTURE, NOT DECORATION. A position whose
     * entryIntentId names no intent cannot prove its independent SOL/USD entry basis, so
     * ExecutionJournal._migrateLegacyPositions quarantines it at boot
     * (accountingIncomplete) — and a quarantined position is left to the desk and the
     * operator: manageOpen refuses to value it and mirrorTick skips it. Without this
     * intent the fixture measured the quarantine, not the mirror. Same shape as the
     * survivor fixture in test-recovery-accounting.mjs, which is the convention for a
     * fully-provenanced held position. */
    journal.ensureIntent({ id: "entry:windowed", kind: "entry", eventId: "windowed", feedId: 76,
      mint, inputMint: WSOL, outputMint: mint, amountRaw: "4995000",
      context: {
        event: { mint, call_id: 76, entry_ref: 0.00035, stop: 0.0003214, target: 0.00044, hold_band: "nano", hold_max_ms: 30 * MIN },
        entryReference: { marketMark: 0.00036, marketMarkAt: Date.now() - 31 * MIN,
          entryLow: 0.0003, entryHigh: 0.0004, stopRatio: 0.8928, targetRatio: 1.2222 },
        entryPreflight: { inputAmountRaw: "4995000", forwardOutputRaw: "123456", solUsd: 150,
          solUsdSource: "pyth-sol-usd-shard0-v1", tokenDecimals: 6, solUsdPublishTime: Math.floor((Date.now() - 31 * MIN) / 1000),
          solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.01, observedAt: Date.now() - 31 * MIN },
      } });
    journal.saveRuntime({ cursor: 0, primed: true, state: { ...freshState(Date.now()), openCount: 1, bookHeat: 0.02 }, positions: { [mint]: position } });
    journal.close();
    return { dir, wallet, stateFile };
  };
  // (a) dead desk, one-hour DESK_UNREACHABLE_MS: the clock starts, the mirror does NOT engage, nothing sells.
  {
    const f = mkFixture();
    const run = await runPoller({ ...f, api: "https://127.0.0.1:1", marker: "poll error:", env: { DESK_UNREACHABLE_MS: "3600000" } });
    ok("dead desk: the unreachability clock starts", /desk unreachable \(fetch failed\) — clock started; mirror mode engages after 3600s/.test(run.output), run.output.split("\n").find((l) => /desk unreachable/.test(l)));
    ok("...but the mirror does not engage inside the window", !/MIRROR MODE/.test(run.output));
    ok("...and the 31-minute-old nano position is HELD, not sold", !/PAPER EXIT WINDOWED/.test(run.output));
    const j = new ExecutionJournal(f.stateFile, { wallet: f.wallet.publicKey.toBase58() });
    const since = j.getMeta("desk_unreachable_since");
    ok("the clock is persisted in journal meta", Number.isSafeInteger(since) && since > 0, String(since));
    /* The fixture must be a fully-provenanced position, or every mirror assertion below
     * is really an assertion about the accounting quarantine (which mirrorTick skips). */
    const held = Object.values(j.snapshot().positions)[0];
    ok("fixture: the held position is NOT accounting-quarantined (else the mirror would skip it, not decide)",
      held?.accountingIncomplete !== true && held?.solUsdSource === "pyth-sol-usd-shard0-v1",
      `accountingIncomplete ${held?.accountingIncomplete}, solUsdSource ${held?.solUsdSource}`);
    j.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
  // (b) dead desk, DESK_UNREACHABLE_MS=0: the mirror engages and the window closes with the desk's code.
  {
    const f = mkFixture();
    const run = await runPoller({ ...f, api: "https://127.0.0.1:1", marker: "PAPER EXIT WINDOWED", env: { DESK_UNREACHABLE_MS: "0" } });
    ok("the mirror engages", /MIRROR MODE: desk unreachable for 0s/.test(run.output));
    ok("the price lane declined (DS_OFFLINE) and said so", /mirror WINDOWED: consensus mark declined \(DS_OFFLINE test mode\)/.test(run.output));
    ok("the clock lane sold the closed nano window with the desk's code",
      /PAPER EXIT WINDOWED — mirror exit \(thesis_expired\): the nano window closed after 31m/.test(run.output),
      run.output.split("\n").find((l) => /PAPER EXIT/.test(l)));
    ok("feed before valuation before mirror in the transcript",
      run.output.indexOf("poll error:") < run.output.indexOf("MIRROR MODE") && run.output.indexOf("MIRROR MODE") < run.output.indexOf("PAPER EXIT WINDOWED"));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
  // (c) a desk that comes back: the clock clears and the mirror stands down.
  {
    const f = mkFixture();
    let calls = 0;
    const server = http.createServer((request, response) => {
      if (request.url?.includes("/executor/feed")) {
        calls++;
        if (calls <= 2) { response.writeHead(503); return response.end("down"); }
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 0, events: [] }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let run;
    try {
      run = await runPoller({ ...f, api: `http://127.0.0.1:${server.address().port}`, marker: "MIRROR MODE stood down",
        env: { DESK_UNREACHABLE_MS: "0" } });
    } finally { await new Promise((resolve) => server.close(resolve)); }
    ok("a 503 starts the clock", /desk unreachable \(feed HTTP 503\)/.test(run.output));
    ok("the mirror engaged while the desk was down", /MIRROR MODE: desk unreachable/.test(run.output));
    ok("the first 200 stands the mirror down and clears the clock", /desk reachable again after \d+s — MIRROR MODE stood down; the desk determines exits/.test(run.output));
    ok("the 31-minute nano position was sold by the mirror while the desk was down (paper: retained)", /PAPER EXIT WINDOWED — mirror exit \(thesis_expired\)/.test(run.output));
    const j = new ExecutionJournal(f.stateFile, { wallet: f.wallet.publicKey.toBase58() });
    ok("the persisted clock is cleared", j.getMeta("desk_unreachable_since") === null, String(j.getMeta("desk_unreachable_since")));
    j.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
}

/* ── 8. ENV BOUNDS (INIT_ONLY, real poller) ────────────────────────────────── */
console.log("\n8. THE NEW ENV NAMES ARE BOUNDED LIKE POLL_MS");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-desk-led-env-"));
  const keypair = Keypair.generate();
  const keyFile = path.join(dir, "burner.json");
  fs.writeFileSync(keyFile, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  const stateDb = path.join(dir, "state.sqlite");
  const base = { ...process.env, CC_SECRET: "a".repeat(64), CC_FLOOR: "50", KEYPAIR: keyFile, STATE_DB: stateDb,
    LOCK_FILE: `${stateDb}.lock`, INIT_ONLY: "1", NODE_NO_WARNINGS: "1" };
  const live = { ...base, EXECUTE: "1", SOLANA_RPC: "https://primary-private-rpc.invalid", SOLANA_RPC_SECONDARY: "https://independent-rpc.invalid",
    JUPITER_API_KEY: "test-key", LIVE_TRADING_ACK: keypair.publicKey.toBase58(), LIVE_STATE_INIT_ACK: keypair.publicKey.toBase58() };
  const run = (env) => spawnSync(process.execPath, [POLLER], { env, encoding: "utf8", timeout: 15_000 });
  const paper0 = run({ ...base, EXECUTE: "0", MARK_MS: "0", DESK_UNREACHABLE_MS: "0" });
  ok("paper accepts MARK_MS=0 and DESK_UNREACHABLE_MS=0", paper0.status === 0, `exit ${paper0.status} ${paper0.stderr.trim().slice(0, 120)}`);
  const paperNeg = run({ ...base, EXECUTE: "0", MARK_MS: "-1" });
  ok("paper refuses a negative MARK_MS", paperNeg.status !== 0 && /MARK_MS must be between 0 and Infinity/.test(paperNeg.stderr), paperNeg.stderr.trim().slice(0, 120));
  const liveLow = run({ ...live, MARK_MS: "4999" });
  ok("live refuses MARK_MS under 5 s", liveLow.status !== 0 && /MARK_MS must be between 5000 and 300000/.test(liveLow.stderr), liveLow.stderr.trim().slice(0, 120));
  const liveHigh = run({ ...live, MARK_MS: "300001" });
  ok("live refuses MARK_MS over 5 min", liveHigh.status !== 0 && /MARK_MS must be between 5000 and 300000/.test(liveHigh.stderr), liveHigh.stderr.trim().slice(0, 120));
  const unreachLow = run({ ...live, DESK_UNREACHABLE_MS: "119999" });
  ok("live refuses DESK_UNREACHABLE_MS under 2 min", unreachLow.status !== 0 && /DESK_UNREACHABLE_MS must be between 120000 and 3600000/.test(unreachLow.stderr), unreachLow.stderr.trim().slice(0, 120));
  const unreachHigh = run({ ...live, DESK_UNREACHABLE_MS: "3600001" });
  ok("live refuses DESK_UNREACHABLE_MS over 1 h", unreachHigh.status !== 0 && /DESK_UNREACHABLE_MS must be between 120000 and 3600000/.test(unreachHigh.stderr), unreachHigh.stderr.trim().slice(0, 120));
  const pollLow = run({ ...base, EXECUTE: "0", POLL_MS: "999" });
  ok("POLL_MS floor is still 1 s", pollLow.status !== 0 && /POLL_MS must be between 1000 and 3600000/.test(pollLow.stderr), pollLow.stderr.trim().slice(0, 120));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 9. RUNTIME LISTS AND THE ALLOWLIST ────────────────────────────────────── */
console.log("\n9. THE NEW MODULES SHIP EVERYWHERE THE OLD ONES DO");
{
  const runner = fs.readFileSync(path.join(here, "launchd-runner.mjs"), "utf8");
  const heartbeat = fs.readFileSync(path.join(here, "heartbeat-health.mjs"), "utf8");
  const installer = fs.readFileSync(path.join(here, "install.sh"), "utf8");
  const release = fs.readFileSync(path.join(here, "macos-release.sh"), "utf8");
  const allow = runner.slice(runner.indexOf("const ALLOWED_ENV"), runner.indexOf("const SAFE_INHERITED_ENV"));
  for (const name of ["MARK_MS", "DESK_UNREACHABLE_MS", "DS_OFFLINE", "POLL_MS"])
    ok(`launchd allowlist carries ${name}`, allow.includes(`"${name}"`));
  const runtime = runner.slice(runner.indexOf("const RUNTIME_FILES"), runner.indexOf("const ALLOWED_ENV"));
  for (const file of ["dexscreener-consensus.mjs", "desk-mirror.mjs"]) {
    ok(`launchd RUNTIME_FILES carries ${file}`, runtime.includes(`"${file}"`));
    ok(`heartbeat fingerprint covers ${file}`, heartbeat.includes(`"${file}"`));
    ok(`install.sh stages ${file}`, new RegExp(`RUNTIME_FILES=\\([^)]*${file.replace(".", "\\.")}`).test(installer) && installer.includes(`trade-policy.mjs ${file}`) || installer.split(file).length >= 3,
      `${installer.split(file).length - 1} mention(s)`);
    ok(`macos-release.sh verifies ${file}`, release.includes(`executor/${file}`));
    ok(`${file} parses`, spawnSync(process.execPath, ["--check", path.join(here, file)], { encoding: "utf8" }).status === 0);
  }
  ok("monitor's default poll is 5 s too", /positiveInteger\(cfg\.POLL_MS, 5_000\)/.test(fs.readFileSync(path.join(here, "monitor.mjs"), "utf8")));
}

/* ── 10. A MIRROR LATCH IS A STAND-IN, AND IT EXPIRES ──────────────────────── */
console.log("\n10. THE MIRROR'S OWN DETERMINATION EXPIRES WHEN THE DESK COMES BACK");
{
  /* THE HOLE THIS CLOSES. Once the mirror determined a sell it latched
   * (exitExecutionRequired), and manageOpen retries a latch ahead of all other work on
   * every pass, forever. Nothing revalidated it. So the desk could come back, answer,
   * mark the call and report it LIVE — and the bot would still liquidate, on its own
   * stale stand-in reading, after the real determiner had said hold. That is a bot
   * exiting "not as it was determined" (Shrek, call 55, 2026-09-05) with an extra step.
   * Only the bot's own stand-in expires: a desk_exit is the desk's word and a risk_exit
   * is a custody/legacy path, and neither is ever droppable here. */
  const mirrorLatch = (over = {}) => ({ mint: "M", symbol: "MIR", callId: 76,
    exitExecutionRequired: true, exitExecutionKind: "mirror_exit", exitExecutionStandIn: true,
    exitExecutionIntentId: "mirror-exit:entry:mir", exitExecutionObservedAt: T0,
    exitExecutionReason: "mirror exit (stop_hit): stop loss", ...over });
  const back = { deskReachable: true, deskSilent: false, intentState: null };
  const dropped = mirrorLatchExpiry({ position: mirrorLatch(), ...back });
  ok("a mirror latch is dropped once the desk is reachable and marking that call again",
    dropped.drop === true, `drop ${dropped.drop} — ${dropped.why}`);
  const stillDown = mirrorLatchExpiry({ position: mirrorLatch(), ...back, deskReachable: false });
  ok("...but never while the desk is still unreachable", stillDown.drop === false, stillDown.why);
  const stillSilent = mirrorLatchExpiry({ position: mirrorLatch(), ...back, deskSilent: true });
  ok("...and never while the desk is still silent on THIS call (per-position mirror)",
    stillSilent.drop === false, stillSilent.why);
  for (const kind of ["desk_exit", "risk_exit"]) {
    const verdict = mirrorLatchExpiry({ position: mirrorLatch({ exitExecutionKind: kind,
      exitExecutionIntentId: kind === "desk_exit" ? "desk-exit:50:exit:9" : "risk-exit:entry:x" }), ...back });
    ok(`a ${kind} latch is a DETERMINATION and is never droppable`, verdict.drop === false, verdict.why);
  }
  const notStandIn = mirrorLatchExpiry({ position: mirrorLatch({ exitExecutionStandIn: false }), ...back });
  ok("a mirror latch explicitly stamped as not a stand-in stays", notStandIn.drop === false, notStandIn.why);
  /* A latch persisted by an older journal carries no stamp at all. The intent id is the
   * fallback identity, and `mirror-exit:` ids are written by mirrorTick and nothing else. */
  const legacyMirror = mirrorLatch({ exitExecutionKind: undefined, exitExecutionStandIn: undefined });
  delete legacyMirror.exitExecutionKind; delete legacyMirror.exitExecutionStandIn;
  ok("an unstamped legacy latch is identified by its intent id",
    exitLatchKind(legacyMirror) === "mirror_exit" && mirrorLatchExpiry({ position: legacyMirror, ...back }).drop === true,
    `${exitLatchKind(legacyMirror)} / drop ${mirrorLatchExpiry({ position: legacyMirror, ...back }).drop}`);
  const legacyDesk = { ...legacyMirror, exitExecutionIntentId: "desk-exit:50:exit:9" };
  ok("...and an unstamped desk latch is still never dropped",
    exitLatchKind(legacyDesk) === "desk_exit" && mirrorLatchExpiry({ position: legacyDesk, ...back }).drop === false,
    `${exitLatchKind(legacyDesk)} / ${mirrorLatchExpiry({ position: legacyDesk, ...back }).why}`);
  for (const state of ["signed", "submitted", "ambiguous", "confirmed", "accounted"]) {
    const verdict = mirrorLatchExpiry({ position: mirrorLatch(), ...back, intentState: state });
    ok(`a mirror latch whose sell is already ${state} is never dropped (recovery owns it)`,
      verdict.drop === false, verdict.why);
  }
  ok("a merely created intent does not pin the latch",
    mirrorLatchExpiry({ position: mirrorLatch(), ...back, intentState: "created" }).drop === true,
    mirrorLatchExpiry({ position: mirrorLatch(), ...back, intentState: "created" }).why);
  ok("no latch is not a drop", mirrorLatchExpiry({ position: { mint: "M" }, ...back }).drop === false,
    mirrorLatchExpiry({ position: { mint: "M" }, ...back }).why);

  /* The live retry branch, by source: the expiry is asked FIRST and the flag is re-read,
   * so the retry below can only ever execute a determination that still stands. The
   * retry's own shape is untouched — it is still the ONE sellAll in the valuation pass
   * (test-exit-mark-outage and test-review-hardening pin exactly that). */
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("function recordPositionFailure"));
  const atExpiry = manage.indexOf("if (pos.exitExecutionRequired) dropExpiredMirrorLatch(pos);");
  const atSell = manage.indexOf("await sellAll(");
  ok("manageOpen asks whether the latch has expired BEFORE it re-calls sellAll",
    atExpiry > 0 && atSell > atExpiry, `expiry@${atExpiry} < sellAll@${atSell}`);
  ok("...and the latched retry is still the only sellAll in the valuation pass",
    (manage.match(/await sellAll\(/g) || []).length === 1 &&
      /if \(pos\.exitExecutionRequired\) \{\s*\n\s*await sellAll\(/.test(manage),
    `${(manage.match(/await sellAll\(/g) || []).length} sellAll call(s)`);
  const drop = src.slice(src.indexOf("function dropExpiredMirrorLatch(pos) {"), src.indexOf("function validEntryEvent(ev) {"));
  ok("...judged on the live unreachability clock and the live per-position silence",
    /deskReachable: deskUnreachableSince == null,/.test(drop) &&
      /deskSilent: deskSilentPositions\.has\(pos\.mint\), intentState \}\);/.test(drop), "");
  ok("a dropped latch is cleared, persisted and announced",
    /MIRROR EXIT CANCELLED \$\{pos\.symbol\}/.test(drop) && /clearExitLatch\(pos\);/.test(drop) &&
      /save\(\);/.test(drop) && /the stand-in determination is dropped and the DESK determines this exit/.test(drop), "");
  ok("the latch stamps ride in clearExitLatch, so a cleared latch leaves nothing behind",
    /"exitExecutionDeskCode", "exitExecutionKind",\s*\n\s*"exitExecutionStandIn"\]\) delete pos\[key\];/.test(src), "");
  ok("a deferred DESK exit attached at fill is stamped desk_exit and never a stand-in",
    /pos\.exitExecutionKind = "desk_exit";\s*\n\s*pos\.exitExecutionStandIn = false;/.test(src), "");
  ok("the stand-in stamp is taken at latch time from the live mirror state",
    /pos\.exitExecutionStandIn = pos\.exitExecutionKind === "mirror_exit" &&\s*\n\s*\(mirrorActive\(\) \|\| deskSilentPositions\.has\(pos\.mint\)\);/.test(src), "");
}

/* ── 11. THE DESK'S RATCHET IS CARRIED, NOT RE-EARNED ──────────────────────── */
console.log("\n11. THE MIRROR INHERITS THE DESK'S HIGH-WATER MARK");
{
  /* THE HOLE THIS CLOSES. The desk's stops move: breakeven at 1.35x and a 25% trail from
   * 1.5x, both derived from its high-water mark (calls.js highWaterMark → policyHwm).
   * mirrorPosition seeded its high at entry_ref alone, so a call the desk had already run
   * to 2x — its stop trailed to 1.5x — went back to the AUTHORED stop the moment the
   * mirror took over, and the mirror then held through a level the desk had already
   * moved. Same defect as Shrek, call 55, pointing the other way in time. */
  const base = () => ({ mint: "H", symbol: "HIGH", callId: 76, deskEntryRef: 1, deskStop: 0.6,
    deskOpenedAt: T0, openedAtMs: T0, holdBand: "very_high", holdMaxMs: 24 * 3600e3 });
  const carried = { ...base(), deskHigh: 2 };
  ok("refreshDeskLevels adopts the desk's restated high_water as deskHigh", (() => {
    const pos = base();
    const changes = refreshDeskLevels(pos, { call_id: 76, mint: "H", status: "live", high_water: 2 });
    return pos.deskHigh === 2 && changes.some((c) => c.field === "deskHigh" && c.to === 2);
  })(), `deskHigh ${(() => { const p = base(); refreshDeskLevels(p, { high_water: 2 }); return p.deskHigh; })()}`);
  ok("mirrorPosition seeds the high from the desk's, not from entry_ref alone",
    mirrorPosition(carried).high === 2 && mirrorPosition(base()).high === 1,
    `with the desk's high ${mirrorPosition(carried).high}, without it ${mirrorPosition(base()).high}`);
  ok("...and never below the mirror's own two-witness high",
    mirrorPosition({ ...base(), deskHigh: 1.2, mirrorHigh: 1.8 }).high === 1.8,
    String(mirrorPosition({ ...base(), deskHigh: 1.2, mirrorHigh: 1.8 }).high));
  /* 1.4 is above the authored 0.6 stop and BELOW the trail the desk had already
   * ratcheted (2 × 0.75 = 1.5). The desk sells here; the mirror must too. */
  const deskSide = pricePolicy({ position: { entry: 1, stop: 0.6, target: null, high: 2, openedAtMs: T0 },
    mark: 1.4, nowMs: T0 + 10 * MIN, config: POLICY_DEFAULTS });
  ok("the DESK sells at 1.4 on its own ratcheted stop (2 × 0.75 = 1.5)",
    deskSide.action === "sell" && deskSide.reason === "ratcheted stop" && deskSide.position.stop === 1.5,
    `${deskSide.action} — ${deskSide.reason}, stop ${deskSide.position.stop}`);
  const withHigh = evaluateMirror({ ...carried }, { mark: 1.4, now: T0 + 10 * MIN });
  ok("the mirror carrying the desk's high sells the same stop with the desk's code",
    withHigh.action === "sell" && withHigh.code === "stop_hit" && /ratcheted stop/.test(withHigh.reason),
    `${withHigh.action} / ${withHigh.code} — ${withHigh.reason}, stop ${withHigh.position.stop}`);
  const withoutHigh = evaluateMirror(base(), { mark: 1.4, now: T0 + 10 * MIN });
  ok("...where a mirror that discarded it would hold through the desk's own stop",
    withoutHigh.action === "hold", `${withoutHigh.action} — ${withoutHigh.reason}, stop ${withoutHigh.position.stop}`);
  /* An absent high_water is a route that did not say — never an instruction to forget a
   * high the position already carries. Same rule as every other desk level. */
  const kept = { ...carried };
  const none = refreshDeskLevels(kept, { call_id: 76, mint: "H", status: "live", high_water: 0 });
  ok("a zero/absent high_water erases nothing", none.length === 0 && kept.deskHigh === 2,
    `${none.length} change(s), deskHigh ${kept.deskHigh}`);
}

/* ── 12. THE DESK'S DIALS ARE THE DESK'S ───────────────────────────────────── */
console.log("\n12. A TUNED DESK AND ITS MIRROR RUN THE SAME POLICY");
{
  /* THE HOLE THIS CLOSES (half of it). evaluateExit reads DESK_TAKE_PROFIT_X,
   * DESK_MAX_AGE_HOURS and DESK_TRAIL_PCT from the desk's environment; the mirror ran
   * POLICY_DEFAULTS, so tuning the desk silently desynchronised the very determination
   * the mirror exists to reproduce — the mirror would take profit at 2x on a desk that
   * had been moved to 3x. The mirror cannot read the desk's environment, so the desk must
   * RESTATE its dials the way it restates a stop; the consuming half lives here and is
   * exercised below. THE FEED/ROUTE HALF IS NOT YET WIRED (src/ is another owner's):
   * until /executor/calls carries take_profit_x, max_age_hours and trail_pct, a tuned
   * desk still diverges in production — see the open issue. */
  const calls = fs.readFileSync(path.join(here, "..", "src", "calls.js"), "utf8");
  ok("the desk really does read three policy dials out of its environment",
    /takeProfitX: Number\(process\.env\.DESK_TAKE_PROFIT_X \|\| POLICY_DEFAULTS\.takeProfitX\)/.test(calls) &&
      /maxAgeHours: Number\(process\.env\.DESK_MAX_AGE_HOURS \|\| POLICY_DEFAULTS\.maxAgeHours\)/.test(calls) &&
      /trailPct: Number\(process\.env\.DESK_TRAIL_PCT \|\| POLICY_DEFAULTS\.trailPct\)/.test(calls), "");
  const saved = process.env.DESK_TAKE_PROFIT_X;
  process.env.DESK_TAKE_PROFIT_X = "3";                     // a NON-DEFAULT desk
  try {
    // The desk's own config expression, verbatim from evaluateExit above.
    const deskConfig = { ...POLICY_DEFAULTS,
      takeProfitX: Number(process.env.DESK_TAKE_PROFIT_X || POLICY_DEFAULTS.takeProfitX),
      maxAgeHours: Number(process.env.DESK_MAX_AGE_HOURS || POLICY_DEFAULTS.maxAgeHours),
      trailPct: Number(process.env.DESK_TRAIL_PCT || POLICY_DEFAULTS.trailPct) };
    ok("fixture: the desk is tuned to 3x, not the 2x default",
      deskConfig.takeProfitX === 3 && POLICY_DEFAULTS.takeProfitX === 2,
      `desk ${deskConfig.takeProfitX}, default ${POLICY_DEFAULTS.takeProfitX}`);
    const tuned = () => ({ mint: "T", symbol: "TUNE", callId: 76, deskEntryRef: 1, deskStop: 0.6,
      deskOpenedAt: T0, openedAtMs: T0, holdBand: "very_high", holdMaxMs: 24 * 3600e3,
      // What the desk restates about itself. Consumed by deskPolicyConfig.
      deskTakeProfitX: 3 });
    ok("the position carries the desk's dial and the mirror reads it",
      deskPolicyConfig(tuned()).takeProfitX === 3 && Object.keys(deskPolicyConfig({})).length === 0,
      `${JSON.stringify(deskPolicyConfig(tuned()))} / bare ${JSON.stringify(deskPolicyConfig({}))}`);
    const deskAt = (mark) => pricePolicy({ position: { entry: 1, stop: 0.6, target: null, high: 1, openedAtMs: T0 },
      mark, nowMs: T0 + 10 * MIN, config: deskConfig });
    for (const [mark, wantSell] of [[2.5, false], [3, true]]) {
      const desk = deskAt(mark);
      const mirror = evaluateMirror(tuned(), { mark, now: T0 + 10 * MIN });
      ok(`at ${mark}x the tuned desk and its mirror AGREE (${wantSell ? "sell" : "hold"})`,
        (desk.action === "sell") === wantSell && (mirror.action === "sell") === wantSell &&
          (!wantSell || (desk.reason === mirror.reason && mirror.code === "take_profit")),
        `desk ${desk.action} (${desk.reason}) / mirror ${mirror.action} (${mirror.reason})`);
    }
    /* And this is the divergence itself, measured: a mirror that does NOT carry the dial
     * takes profit at 2x on a desk that has been moved to 3x, one full x early. */
    const blind = evaluateMirror({ ...tuned(), deskTakeProfitX: undefined }, { mark: 2.5, now: T0 + 10 * MIN });
    ok("a mirror without the desk's dial sells a full x early — the divergence this closes",
      blind.action === "sell" && blind.code === "take_profit" && deskAt(2.5).action === "hold",
      `mirror ${blind.action} (${blind.reason}) while the desk holds (${deskAt(2.5).reason})`);
  } finally {
    if (saved == null) delete process.env.DESK_TAKE_PROFIT_X; else process.env.DESK_TAKE_PROFIT_X = saved;
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
