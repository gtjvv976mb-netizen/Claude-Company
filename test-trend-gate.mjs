/* THE TREND LANE PAYS ONLY WHEN THE ANSWER CAN BE USED.
 *
 * Measured in the live 24h: 32 TrendScan calls, $3.47 — 9% of the day — and 122 calls /
 * $13.65 over 7d, paid while BOTH breakers were open and every pass was abandoned as
 * researchless. Every check in the lane sat downstream of the paid Grok scan: the
 * handoff looked at the book only after the scan was bought, and nothing looked at the
 * analyst breaker at all; fresh and promote checked the book and not the breaker; and
 * `trend` was missing from OPPORTUNISTIC, so the lane spent to the full cap while its
 * siblings yielded at 55%. This proves each of those closed: the paid call is counted
 * at the socket (a stubbed fetch), the spend is counted in llm_spend, and a workup is
 * counted on the bus — never inferred from a return value alone. */
import os from "node:os";
import path from "node:path";
/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE — this file opens calls and clears
   llm_spend. The runner's throwaway path wins; this only covers the unguarded run. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), `cc-trend-gate-${process.pid}.db`);
/* The runner blanks XAI_API_KEY so no test can spend. This one must get PAST hasGrok()
   to reach the gate, so it sets a key that is never sent: every request is answered by
   the stub below, and a request to any other host is an assertion failure. */
process.env.XAI_API_KEY = "test-key-never-sent";

import assert from "node:assert/strict";
import fs from "node:fs";
import db from "./src/lib/store.js";
import { bus } from "./src/lib/bus.js";
import { cfg } from "./src/config.js";
import { creditBreakerState, noteCreditRefusal, resetCreditBreakers, setCreditBreakerClock,
  acquireCredit, assertDailyBudget, BudgetExhausted, OPPORTUNISTIC_SHARE,
  CREDIT_BREAKER_COOLDOWN_MS } from "./src/lib/llm.js";
import { openCall, closeCall } from "./src/calls.js";
import { bookState, MAX_LIVE_CALLS } from "./src/mandate.js";
import { scanTrends } from "./src/trends.js";
import { freshScan, promoteWatches, trendHandoff } from "./src/penthouse.js";

let pass = 0;
const ok = async (name, fn) => { await fn(); console.log("  ok  ", name); pass++; };

/* THE RULERS. A paid Grok scan is one POST to api.x.ai — counted where it leaves the
   process. Any other host is a fetch this test did not expect (a sweep, a DexScreener
   search) and fails loudly rather than reaching the network. */
let xaiCalls = 0, otherCalls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://api.x.ai")) {
    xaiCalls++;
    return { ok: true, status: 200, json: async () => ({
      model: "grok-4.6",
      output_text: JSON.stringify({ themes: [] }),
      // 1.08e9 ticks = $0.108, the measured per-scan cost ($3.47 / 32).
      usage: { input_tokens: 100, output_tokens: 50, cost_in_usd_ticks: 1_080_000_000 },
    }) };
  }
  otherCalls.push(u);
  throw new Error(`unexpected network call in test: ${u}`);
};
let workups = 0;
bus.on("event", (e) => { if (e.type === "token:start") workups++; });
const trendRows = () => db.prepare(
  "SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd FROM llm_spend WHERE seat = 'TrendScan'").get();

let clock = 1_000_000;
setCreditBreakerClock(() => clock);
const openAnthropic = () => { noteCreditRefusal("anthropic", "credit balance is too low"); clock += 1_000; };
const TREND_CANDIDATE = [{ mint: "TrendGateCand111111111111111111111111111111", symbol: "TGC", theme: "a test story" }];

console.log(`\nTHE SCAN — breaker first (daily cap $${cfg.dailyBudgetUsd}, book max ${MAX_LIVE_CALLS})`);
db.prepare("DELETE FROM llm_spend").run();

await ok("with the analyst breaker OPEN the scan is not bought: 0 xai calls, spend rows unchanged", async () => {
  resetCreditBreakers(); openAnthropic();
  const before = trendRows();
  const r = await scanTrends();
  console.log(`        breaker=${creditBreakerState("anthropic").state} -> ok=${r.ok} skipped=${r.skipped} xaiCalls=${xaiCalls} ` +
    `TrendScan rows ${before.n}->${trendRows().n} ($${before.usd}->$${trendRows().usd})`);
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "credit_breaker_open");
  assert.equal(xaiCalls, 0, "grokTrendScan must not reach the socket");
  assert.deepEqual(trendRows(), before, "no xai spend row may appear");
  assert.equal(r.candidates.length, 0);
});

await ok("a DUE probe does not buy a scan either — the scan is not the probe, the cycle is", async () => {
  resetCreditBreakers(); openAnthropic();
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  const s = creditBreakerState("anthropic");
  const r = await scanTrends();
  console.log(`        state=${s.state} probeReadyInMs=${s.probeReadyInMs} -> skipped=${r.skipped} xaiCalls=${xaiCalls}`);
  assert.equal(s.probeReadyInMs, 0, "fixture: the probe must be due");
  assert.equal(r.skipped, "credit_breaker_open");
  assert.equal(xaiCalls, 0);
});

await ok("half_open with a probe in flight: still not bought", async () => {
  resetCreditBreakers(); openAnthropic();
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  assert.equal(acquireCredit("anthropic").allowed, true, "fixture: take the probe slot");
  const s = creditBreakerState("anthropic");
  const r = await scanTrends();
  console.log(`        state=${s.state} -> skipped=${r.skipped} xaiCalls=${xaiCalls}`);
  assert.equal(s.state, "half_open");
  assert.equal(r.skipped, "credit_breaker_open");
  assert.equal(xaiCalls, 0);
});

await ok("the gate reads ANTHROPIC — an xAI outage is refused by xAI's own breaker, not by this gate", async () => {
  resetCreditBreakers();
  noteCreditRefusal("xai", "your team has used all available credits"); clock += 1_000;
  const r = await scanTrends();
  console.log(`        anthropic=${creditBreakerState("anthropic").state} xai=${creditBreakerState("xai").state} ` +
    `-> skipped=${r.skipped ?? "(none)"} error="${String(r.error).slice(0, 60)}" xaiCalls=${xaiCalls}`);
  assert.notEqual(r.skipped, "credit_breaker_open", "the anthropic gate must not fire for an xAI outage");
  assert.equal(r.ok, false);
  assert.equal(xaiCalls, 0, "xAI's own breaker refuses without sending");
});

console.log("\nTHE SCAN — healthy: bought exactly once per interval");
await ok("healthy and the book empty: one scanTrends = one paid Grok call = one TrendScan spend row", async () => {
  resetCreditBreakers();
  xaiCalls = 0;
  const before = trendRows();
  const r1 = await scanTrends();
  const calls1 = xaiCalls;
  const mid = trendRows();
  const r2 = await scanTrends();
  const after = trendRows();
  console.log(`        interval 1: ok=${r1.ok} xaiCalls=${calls1} rows ${before.n}->${mid.n} ($${mid.usd.toFixed(3)})`);
  console.log(`        interval 2: ok=${r2.ok} xaiCalls=${xaiCalls} rows ${mid.n}->${after.n} ($${after.usd.toFixed(3)})`);
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(calls1, 1, "one interval, one scan");
  assert.equal(xaiCalls, 2, "two intervals, two scans — exactly one each");
  assert.equal(mid.n - before.n, 1, "one spend row per interval");
  assert.equal(after.n - mid.n, 1, "one spend row per interval");
  assert.ok(Math.abs(after.usd - before.usd - 2 * 0.108) < 1e-9, `metered $${(after.usd - before.usd).toFixed(3)}`);
  assert.deepEqual(otherCalls, [], "no other host was touched");
});

console.log("\nTHE BOOK — full: every opportunistic lane skips before a workup");
await ok("a full book makes scanTrends/freshScan/promoteWatches/trendHandoff all return skipped", async () => {
  resetCreditBreakers();
  /* Fill whatever the configured book is, as test-mandate.mjs does — the env cannot be
     set from here because ESM hoists the imports above it. The gate is under test, not
     the number. */
  const opened = [];
  for (let i = 0; i < MAX_LIVE_CALLS; i++) {
    const c = openCall({ mint: `TrendGateBook${String(i).padStart(2, "0")}111111111111111111111111111`,
      symbol: `TGB${i}`, entryRef: 1, stop: 0.7, target: 2, thesis: "t", invalidation: "i" });
    assert.ok(c, `fixture: call ${i} must open`);
    opened.push(c);
  }
  const b = bookState();
  assert.equal(b.full, true, `fixture: live=${b.live} max=${b.max}`);
  xaiCalls = 0; workups = 0;
  const before = trendRows();
  const s = await scanTrends();
  const f = await freshScan();
  const p = await promoteWatches();
  const h = await trendHandoff(TREND_CANDIDATE);
  console.log(`        book live=${b.live}/${b.max} -> scan=${s.skipped} fresh=${f.skipped} promote=${p.skipped} ` +
    `handoff=${h.skipped} (halted="${h.halted}", workedUp=${h.workedUp}) xaiCalls=${xaiCalls} workups=${workups}`);
  assert.equal(s.skipped, "position_open");
  assert.equal(f.skipped, "position_open");
  assert.equal(p.skipped, "position_open");
  assert.equal(h.skipped, "position_open");
  assert.equal(h.workedUp, 0);
  assert.match(h.halted, new RegExp(`book full at ${MAX_LIVE_CALLS}`), "the handoff still names what it is waiting on");
  assert.equal(xaiCalls, 0, "no scan was bought");
  assert.equal(workups, 0, "no workup started");
  assert.deepEqual(trendRows(), before);
  assert.deepEqual(otherCalls, [], "not even the free sweep ran");
  for (const c of opened) closeCall(c.id, "test", 1.2);
  assert.equal(bookState().full, false, "closing the calls reopens the book");
});

console.log("\nTHE BREAKER — open, book empty: fresh/promote/handoff skip before a workup");
await ok("freshScan, promoteWatches and trendHandoff return credit_breaker_open with no workup and no fetch", async () => {
  resetCreditBreakers(); openAnthropic();
  assert.equal(bookState().full, false, "fixture: the book is empty");
  xaiCalls = 0; workups = 0;
  const f = await freshScan();
  const p = await promoteWatches();
  const h = await trendHandoff(TREND_CANDIDATE);
  console.log(`        breaker=${creditBreakerState("anthropic").state} -> fresh=${f.skipped} promote=${p.skipped} ` +
    `handoff=${h.skipped} (workedUp=${h.workedUp}) workups=${workups} otherFetches=${otherCalls.length}`);
  assert.equal(f.skipped, "credit_breaker_open");
  assert.equal(p.skipped, "credit_breaker_open");
  assert.equal(h.skipped, "credit_breaker_open");
  assert.equal(h.workedUp, 0);
  assert.match(f.halted, /analyst breaker open/, "the fresh lane says why, on the field index.js prints");
  assert.equal(workups, 0, "no workup may start");
  assert.deepEqual(otherCalls, [], "no sweep, no search — nothing left the process");
});

await ok("...and once the breaker closes the same lanes go past the gate again", async () => {
  resetCreditBreakers();
  const p = await promoteWatches();
  console.log(`        breaker=${creditBreakerState("anthropic").state} -> promote=${JSON.stringify(p)}`);
  assert.notEqual(p.skipped, "credit_breaker_open");
  assert.notEqual(p.skipped, "position_open");
});

console.log("\nTHE RESERVE — trend yields like fresh and promote");
/* Stamped 90 MINUTES AGO so the hourly pace (its own tests, test-247.mjs) does not
   also trip; this section is about the daily lane split. Same fixture as
   test-budget-reserve.mjs. */
const setSpend = (usd) => {
  db.prepare("DELETE FROM llm_spend").run();
  db.prepare("INSERT INTO llm_spend (ts, seat, model, usd, in_tok, out_tok) VALUES (?,?,?,?,?,?)")
    .run(Date.now() - 90 * 60000, "test", "claude-opus-5", usd, 0, 0);
};
const allowed = (cap, lane) => {
  try { assertDailyBudget(cap, { lane }); return true; }
  catch (e) { if (e instanceof BudgetExhausted) return false; throw e; }
};
await ok("past the opportunistic share, trend is refused with fresh and promote; cycle and floor still run", async () => {
  const CAP = 25, share = CAP * OPPORTUNISTIC_SHARE;
  setSpend(share + 0.01);
  const got = Object.fromEntries(["trend", "fresh", "promote", "cycle", "floor"].map((l) => [l, allowed(CAP, l)]));
  console.log(`        $${(share + 0.01).toFixed(2)} of $${CAP} spent (share ${(OPPORTUNISTIC_SHARE * 100).toFixed(0)}%) -> ${JSON.stringify(got)}`);
  assert.deepEqual(got, { trend: false, fresh: false, promote: false, cycle: true, floor: true });
  setSpend(1);
  assert.equal(allowed(CAP, "trend"), true, "early in the day trend may spend");
});

await ok("the SCAN itself yields — past the share, scanTrends is refused before Grok is paid", async () => {
  resetCreditBreakers();
  const cap = cfg.dailyBudgetUsd, share = cap * OPPORTUNISTIC_SHARE;
  setSpend(share + 0.01);
  xaiCalls = 0;
  const r = await scanTrends();
  console.log(`        $${(share + 0.01).toFixed(2)} of $${cap} -> ok=${r.ok} skipped=${r.skipped} xaiCalls=${xaiCalls} error="${String(r.error).slice(0, 70)}"`);
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "budget");
  assert.equal(xaiCalls, 0, "the reserve is read before the money leaves");
  setSpend(0);
});

console.log("\nTHE ORDER, AT SOURCE LEVEL");
const trends = fs.readFileSync(new URL("./src/trends.js", import.meta.url), "utf8");
const scanFn = trends.slice(trends.indexOf("export async function scanTrends"));
await ok("scanTrends reads the breaker, the book and the reserve BEFORE the paid grokTrendScan", async () => {
  const breaker = scanFn.indexOf('creditBreakerState("anthropic")');
  const book = scanFn.indexOf("bookState()");
  const budget = scanFn.indexOf('assertDailyBudget(cfg.dailyBudgetUsd, { lane: "trend" })');
  const paid = scanFn.indexOf("await grokTrendScan(");
  console.log(`        breaker@${breaker} book@${book} reserve@${budget} < grokTrendScan@${paid}`);
  assert.ok(breaker > 0 && book > 0 && budget > 0 && paid > 0);
  assert.ok(breaker < paid && book < paid && budget < paid);
});

const pent = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
const gateFn = pent.slice(pent.indexOf("function laneGate()"), pent.indexOf("let promoteBusy"));
await ok("laneGate reads both the book and the anthropic breaker, strictly closed", async () => {
  assert.match(gateFn, /bookState\(\)/);
  assert.match(gateFn, /creditBreakerState\("anthropic"\)/);
  assert.match(gateFn, /state !== "closed"/);
});
for (const [fnName, lane] of [["promoteWatches", "promote"], ["trendHandoff", "trend"], ["freshScan", "fresh"]]) {
  await ok(`${fnName} calls laneGate() before its lane: "${lane}" workup`, async () => {
    const start = pent.indexOf(`export async function ${fnName}`);
    const gate = pent.indexOf("laneGate()", start);
    const workup = pent.indexOf(`lane: "${lane}"`, start);
    console.log(`        ${fnName}@${start} gate@${gate} workup@${workup}`);
    assert.ok(start > 0 && gate > start && workup > gate, `gate at ${gate} must precede the workup at ${workup}`);
  });
}
const llm = fs.readFileSync(new URL("./src/lib/llm.js", import.meta.url), "utf8");
await ok('OPPORTUNISTIC names "trend"', async () => {
  assert.match(llm, /const OPPORTUNISTIC = new Set\(\["fresh", "promote", "trend"\]\)/);
});

console.log(`\n${pass} passed — the trend lane pays only for an answer the desk can use\n`);
