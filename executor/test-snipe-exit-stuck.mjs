/**
 * A POSITION THE LANE CANNOT SELL, AND A SELL THAT KEEPS FAILING.
 *
 * 2026-09-30, about 15:49 UTC. The launch lane bought 26QftJYy…pump on its curve; the coin
 * then completed the curve and moved to PumpSwap. The lane's exit fired, the port refused it
 * — "the curve has graduated — the position must leave through a pool route, which this path
 * does not build" — and the lane did what its retry rule said: kept the row and tried again on
 * the next tick. Every tick. 6,196 times in eleven hours, two refused simulations each, with
 * the heartbeat's open[] carrying no error at all and only counts.exitFailures to show for it.
 *
 * Three things were missing, and this file pins each:
 *
 *   1. A GRADUATION GUARD. The trend lane sells at 75 SOL of real reserve because a completed
 *      curve cannot be sold by this executor; the launch lane now does the same.
 *   2. A BACKOFF. A sell the port refuses is retried in 2s, 4s, 8s, 16s, 30s — not every tick.
 *   3. A TERMINAL STATE. A refusal that names a graduated curve is not retried at all: the row
 *      is marked exitBlocked="graduated", the log says SELL BY HAND once, the curve is no
 *      longer read, and the row closes only when the wallet no longer holds the coin — the
 *      owner's by-hand sale — as a reconcile with no invented realised figure.
 *
 *   node test-snipe-exit-stuck.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const laneMod = await import("./snipe-lane.mjs");
const { createSnipeLane, snipeLaneConfig, snipeArmSentence, exitRetryDelayMs, GRADUATION_GUARD_SOL, BLOCKED_RECONCILE_MS } = laneMod;
const { openSnipe, snipeList, snipeFor } = await import("./snipe-book.mjs");
const { constantProductExactIn, constantProductExactOut, constantProductSellExactIn } = await import("./snipe-curve.mjs");

const WALLET = "D7ppNxdmcoVtEHsHjV47D8q2nGdoUjhdgPpKYmX9gwps";
const MINT = "5xXJ1Aqjw2vbBxUTYkeruvnFxm69qmDz9LfeNWSupump";
const WSOL = "So11111111111111111111111111111111111111112";
const { PUMPFUN_VENUE, PUMPFUN_CURVE_TYPE } = await import("./snipe-venue-pumpfun.mjs");
const VENUE_PROGRAM = PUMPFUN_VENUE.programId;
const CURVE_TYPE = PUMPFUN_CURVE_TYPE;
const control = () => ({ hardStop: false, pauseEntries: false });

/* THE REAL VENUE, with only its READ side swapped for a JSON codec. The arming checklist judges
   the venue's identity, its quote oracle and its proved layout, and those stay the real ones;
   what a test needs to set by hand is the curve a held position is read against — `complete`
   and the real reserve — so curveFromAccount decodes JSON bytes instead of the program's
   layout. Nothing in this file encodes or signs: the port below is a stub and the lane's
   encoders are never reached. */
const VENUE = Object.freeze({
  ...PUMPFUN_VENUE,
  accountsFor(mint) { return [`curve:${mint}`, `global:${mint}`, `mint:${mint}`]; },
  accountsForHeld(mint) { return [`curve:${mint}`, `global:${mint}`, `mint:${mint}`]; },
  decodeTokenAmount() { return null; },
  curveFromAccount(account, { feeBps = null, mint = null } = {}) {
    if (!account?.data) return null;
    let raw;
    try { raw = JSON.parse(Buffer.from(account.data).toString("utf8")); } catch { return null; }
    if (raw.curveType !== CURVE_TYPE) return null;
    return Object.freeze({
      kind: "bonding-curve", venue: PUMPFUN_VENUE.id, curveType: raw.curveType, mint,
      vBaseRaw: BigInt(raw.vBaseRaw), vQuoteRaw: BigInt(raw.vQuoteRaw),
      realBaseRaw: BigInt(raw.realBaseRaw), realQuoteRaw: BigInt(raw.realQuoteRaw),
      complete: raw.complete === true, creator: raw.creator ?? null,
      feeBps: feeBps === null ? null : Number(feeBps),
    });
  },
  quoteExactIn(curve, quoteInRaw) { return constantProductExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, quoteInRaw, feeBps: curve.feeBps ?? 0 }); },
  quoteExactOut(curve, baseOutRaw) { return constantProductExactOut({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseOutRaw, feeBps: curve.feeBps ?? 0 }); },
  sellExactIn(curve, baseInRaw) {
    return constantProductSellExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseInRaw, feeBps: curve.feeBps ?? 0, realQuoteRaw: curve.realQuoteRaw ?? null });
  },
  isComplete(curve) { return curve.complete === true; },
  quoteReserveLamports(curve) { return BigInt(curve.realQuoteRaw); },
});

/* The reconcile test's real fill: 8,890,325,990,118 base for 200,293,000 lamports on this
   curve, so the mark reads a little under 1x and the determiner HOLDS a young position. */
const CURVE = { curveType: CURVE_TYPE, vBaseRaw: "1039482477559425", vQuoteRaw: "22894697634",
  realBaseRaw: "760000000000000", realQuoteRaw: "22000000000", complete: false, creator: null };
const curveAccount = (state) => ({ owner: VENUE_PROGRAM, data: Buffer.from(JSON.stringify(state), "utf8") });
const mintAccount = { ok: true, decimals: 6, mintAuthority: null, freezeAuthority: null, extensionDetail: [], botRefusals: [] };

const NOW0 = 1_759_250_000_000;

/**
 * An armed lane over two scripted endpoints, with a port whose sell does what the test says,
 * a clock the test moves, and a wallet that answers however the test says.
 */
function armedLane({ curveState = CURVE, blind = false, sell, holdingsReader, ageMs = 1_000, cfg = {} } = {}) {
  const lines = [];
  let t = NOW0;
  const clock = () => t;
  const calls = { sell: 0, reads: 0, holdings: 0 };
  const port = {
    wallet: WALLET,
    prepareBuy() { throw new Error("not in this test"); },
    async buy() { throw new Error("not in this test"); },
    async sell(args) { calls.sell++; return sell(args); },
  };
  const table = () => (blind ? [null, null, null] : [curveAccount(typeof curveState === "function" ? curveState() : curveState), {}, mintAccount]);
  const readers = ["primary", "secondary"].map((id) => ({
    id, async read() { calls.reads++; return { slot: 1000 + Math.floor((t - NOW0) / 400), accounts: table() }; },
  }));
  const base = snipeLaneConfig({ SNIPE_LANE: "execute", SNIPE_MAX_SOL_PER_TRADE: "0.05", SNIPE_DAILY_SOL_CAP: "0.2", SNIPE_STOP_FRAC: "0.7" });
  const S = {};
  const lane = createSnipeLane({
    venue: VENUE, readers, control, state: S, clock,
    cfg: { ...base, liveAck: snipeArmSentence(WALLET, 0.05, 0.2), ...cfg },
    executor: port, log: (m) => lines.push(String(m)),
    ...(holdingsReader === undefined ? {} : {
      holdingsReader: { async read(mint) { calls.holdings++; return holdingsReader.read(mint); } },
    }),
  });
  openSnipe(S, {
    mint: MINT, venue: VENUE.id, openedAt: NOW0 - ageMs, entry: 1,
    sizeSol: 0.200308, feeSolPerLeg: 0.000015,
    qtyRaw: "8890325990118", entryInputLamports: "200293000", entryFeeLamports: "15000",
    costBasisLamports: "200308000",
    curve: { vBaseRaw: CURVE.vBaseRaw, vQuoteRaw: CURVE.vQuoteRaw },
    forward: [], samples: 0, marks: [], high: 1, signature: "oeAKmkg4yNidn8DH4zf5CvbS",
  });
  return { lane, S, lines, calls, advance: (ms) => { t += ms; }, now: () => t };
}

const GRADUATED = Object.assign(new Error("the curve has graduated — the position must leave through a pool route, which this path does not build; sell by hand"), { clause: "refused" });
const SIM_FAILED = Object.assign(new Error("simulation failed on both providers: custom program error 6003"), { clause: "simulation_failed" });
const holdings = (qtyRaw) => ({ async read() { return { qtyRaw }; } });

console.log("\nthe backoff schedule");
{
  const got = [1, 2, 3, 4, 5, 6, 50].map(exitRetryDelayMs);
  ok("2s, 4s, 8s, 16s, 30s, and 30s for ever after", JSON.stringify(got) === JSON.stringify([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]), got.join(","));
  ok("attempt 0 and junk read as the base delay", exitRetryDelayMs(0) === 1_000 && exitRetryDelayMs("x") === 1_000);
}

console.log("\n1. a sell that FAILS is retried on a backoff, not every tick");
{
  /* Blind readers (no curve) and a one-millisecond hold: every tick decides to sell on the clock,
     exactly the shape the 6,196 failures had. */
  const w = armedLane({ blind: true, sell: async () => { throw SIM_FAILED; }, holdingsReader: holdings("8890325990118"), cfg: { holdMaxMs: 1 } });
  const t1 = await w.lane.tick();
  ok("the first tick tries the sell, fails, and latches", w.calls.sell === 1 && t1[0].latched === true && t1[0].closed === false,
    `sells ${w.calls.sell}, ${JSON.stringify({ action: t1[0].action, latched: t1[0].latched })}`);
  const row1 = snipeFor(w.S, MINT);
  ok("the row records the attempt and when to try again", row1.exitAttempts === 1 && row1.nextExitAtMs === w.now() + 2_000
    && /simulation_failed/.test(row1.exitError), `attempts ${row1.exitAttempts}, retry in ${row1.nextExitAtMs - w.now()}ms`);
  ok("...and the tick says when", t1[0].retryAtMs === w.now() + 2_000);
  ok("...and the log says in how many seconds, not 'next tick'", w.lines.some((m) => /EXIT FAILED .* retried in 2s \(attempt 1\)/.test(m)),
    w.lines.find((m) => /EXIT FAILED/.test(m))?.slice(0, 120));
  w.advance(1_000);
  const t2 = await w.lane.tick();
  ok("one second later the tick does NOT call the port", w.calls.sell === 1 && t2[0].action === "sell_wait" && t2[0].latched === true,
    `sells ${w.calls.sell}, action ${t2[0].action}`);
  ok("...but the position is still read and recorded", w.calls.reads >= 4 && snipeList(w.S).length === 1, `reads ${w.calls.reads}`);
  w.advance(1_001);
  const t3 = await w.lane.tick();
  ok("after the backoff it tries again", w.calls.sell === 2 && t3[0].latched === true, `sells ${w.calls.sell}`);
  const row3 = snipeFor(w.S, MINT);
  ok("...with a longer wait the second time", row3.exitAttempts === 2 && row3.nextExitAtMs === w.now() + 4_000,
    `attempts ${row3.exitAttempts}, retry in ${row3.nextExitAtMs - w.now()}ms`);
  ok("the first latch time is kept, not rewritten by every failure", row3.exitLatchedAt === row1.exitLatchedAt);
  ok("the failures are counted", w.lane.stats().exitFailures === 2 && w.lane.stats().exitBlocked === 0);
  for (let i = 0; i < 6; i++) { w.advance(60_000); await w.lane.tick(); }
  ok("the wait never exceeds 30 seconds", snipeFor(w.S, MINT).nextExitAtMs - w.now() === 30_000 && w.calls.sell === 8,
    `retry in ${snipeFor(w.S, MINT).nextExitAtMs - w.now()}ms after ${w.calls.sell} sells`);
}

console.log("\n2. a refusal that names a GRADUATED curve is terminal: marked, said once, never retried");
{
  const wallet = { qty: "8890325990118" };
  const w = armedLane({ blind: true, sell: async () => { throw GRADUATED; }, holdingsReader: { async read() { return { qtyRaw: wallet.qty }; } }, cfg: { holdMaxMs: 1 } });
  const t1 = await w.lane.tick();
  ok("the sell is tried once and refused", w.calls.sell === 1 && t1[0].action === "blocked" && t1[0].blocked === "graduated" && t1[0].closed === false,
    JSON.stringify({ action: t1[0].action, blocked: t1[0].blocked }));
  const row = snipeFor(w.S, MINT);
  ok("the row is marked blocked, with the port's own words", row.exitBlocked === "graduated" && /graduated/.test(row.exitError)
    && row.exitBlockedAt === w.now() && row.exitLatched === true, `exitBlocked ${row.exitBlocked}`);
  ok("...and no retry time is set on it", row.nextExitAtMs === undefined, `nextExitAtMs ${row.nextExitAtMs}`);
  ok("it is counted once as blocked AND once as a failed sell", w.lane.stats().exitBlocked === 1 && w.lane.stats().exitFailures === 1,
    `blocked ${w.lane.stats().exitBlocked}, failures ${w.lane.stats().exitFailures}`);
  const said = w.lines.filter((m) => /SELL BY HAND/.test(m));
  ok("the log says SELL BY HAND, once, with the reason", said.length === 1 && /graduated/.test(said[0]) && /stops retrying/.test(said[0]), said[0]?.slice(0, 120));
  const readsBefore = w.calls.reads;
  for (let i = 0; i < 50; i++) { w.advance(1_000); await w.lane.tick(); }
  ok("fifty more ticks call the port ZERO times", w.calls.sell === 1, `sells ${w.calls.sell}`);
  ok("...and read the curve ZERO times", w.calls.reads === readsBefore, `reads ${w.calls.reads - readsBefore}`);
  ok("...and ask the wallet about once a minute, not once a tick", w.calls.holdings >= 1 && w.calls.holdings <= 2, `holdings reads ${w.calls.holdings}`);
  ok("the row is still open, still blocked", snipeList(w.S).length === 1 && snipeFor(w.S, MINT).exitBlocked === "graduated");
  ok("the heartbeat's own list carries the state", w.lane.openPositions()[0].exitBlocked === "graduated" && w.lane.openPositions()[0].exitAttempts === 0
    && /graduated/.test(w.lane.openPositions()[0].exitError));
  ok("SELL BY HAND was still said only once", w.lines.filter((m) => /SELL BY HAND/.test(m)).length === 1);

  /* THE OWNER SELLS IT BY HAND. The wallet now holds none; the next minute's check closes it. */
  wallet.qty = "0";
  w.advance(BLOCKED_RECONCILE_MS + 1);
  const t2 = await w.lane.tick();
  ok("once the wallet holds none of it the row closes as a reconcile", t2[0].action === "reconciled" && t2[0].closed === true && snipeList(w.S).length === 0,
    JSON.stringify({ action: t2[0].action, open: snipeList(w.S).length }));
  ok("...counted as a reconcile, with the port still untouched", w.lane.stats().reconciled === 1 && w.calls.sell === 1);
  /* The book row is gone and the shadow recorder never held one (the position was filed
     straight into the book, as a landed buy files it), so what is left to read is what the
     lane SAID — which is also what the operator reads. */
  const said2 = w.lines.find((m) => /RECONCILED/.test(m)) ?? "";
  ok("...and it says the by-hand sale closed what the lane could not, with no result claimed",
    /by-hand sale closed what the lane could not/.test(said2) && /realised result is not read here/.test(said2), said2.slice(0, 120));
  ok("...and never says SOLD or EXITED for a sale it did not make", !w.lines.some((m) => /: (SOLD|EXITED)/.test(m)));
}

console.log("\n3. a curve that reads COMPLETE is blocked before any sell is tried");
{
  const w = armedLane({ curveState: { ...CURVE, complete: true, realQuoteRaw: "0", vBaseRaw: "1", vQuoteRaw: "1" },
    sell: async () => { throw new Error("must not be called"); }, holdingsReader: holdings("8890325990118") });
  const t1 = await w.lane.tick();
  ok("the tick blocks the row without calling the port", w.calls.sell === 0 && t1[0].action === "blocked" && t1[0].blocked === "graduated",
    `sells ${w.calls.sell}, action ${t1[0].action}`);
  ok("exitFailures stays at zero — nothing failed, nothing was possible", w.lane.stats().exitFailures === 0 && w.lane.stats().exitBlocked === 1);
  ok("the row says why", /graduated/.test(snipeFor(w.S, MINT).exitError) && snipeFor(w.S, MINT).exitBlocked === "graduated");
  ok("the log says SELL BY HAND", w.lines.some((m) => /SELL BY HAND/.test(m)));
  const reads = w.calls.reads;
  w.advance(1_000); await w.lane.tick();
  ok("the next tick reads nothing and sells nothing", w.calls.reads === reads && w.calls.sell === 0);
}

console.log("\n4. the graduation guard sells BEFORE the curve completes");
{
  const fills = [];
  const sell = async (args) => { fills.push(args); return { quoteOutRaw: "199000000", feeLamports: "5000", signature: "guardSig", slot: 1001, confirmedAtMs: NOW0 }; };
  const under = armedLane({ curveState: { ...CURVE, realQuoteRaw: String((GRADUATION_GUARD_SOL - 1) * 1e9) }, sell, holdingsReader: holdings("1") });
  const h = await under.lane.tick();
  ok(`at ${GRADUATION_GUARD_SOL - 1} SOL of reserve a young, flat position is held`, under.calls.sell === 0 && h[0].action === "hold" && snipeList(under.S).length === 1,
    `action ${h[0].action}, sells ${under.calls.sell}`);
  const over = armedLane({ curveState: { ...CURVE, realQuoteRaw: String(GRADUATION_GUARD_SOL * 1e9) }, sell, holdingsReader: holdings("1") });
  const g = await over.lane.tick();
  ok(`at ${GRADUATION_GUARD_SOL} SOL of reserve the same position is SOLD`, over.calls.sell === 1 && g[0].action === "sell" && g[0].closed === true && snipeList(over.S).length === 0,
    `action ${g[0].action}, closed ${g[0].closed}, sells ${over.calls.sell}`);
  ok("...for the guard's own reason, which names the number and the why", /graduation guard: 75\.0 SOL/.test(String(fills[0]?.reason)) && /cannot be sold by this executor/.test(String(fills[0]?.reason)),
    String(fills[0]?.reason).slice(0, 110));
  ok("...the whole position", String(fills[0]?.qtyRaw) === "8890325990118");
  const exited = over.lines.find((m) => /EXITED/.test(m)) ?? "";
  ok("...and the close carries the fill's own numbers", /199000000 lamports back/.test(exited) && /sig guardSig/.test(exited) && /graduation guard/.test(exited),
    exited.slice(0, 140));
  ok("...counted as an exit, not a failure or a block", over.lane.stats().exited === 1 && over.lane.stats().exitFailures === 0 && over.lane.stats().exitBlocked === 0);
  ok("the guard is the trend lane's number, in one place", GRADUATION_GUARD_SOL === 75);
}

console.log("\n5. an OBSERVING lane is untouched by all of this");
{
  /* The guard and the block are for money. The shadow book measures what the market did. */
  const S = {};
  let t = NOW0;
  const readers = ["a", "b"].map((id) => ({ id, async read() { return { slot: 1000, accounts: [curveAccount({ ...CURVE, complete: true }), {}, mintAccount] }; } }));
  const lane = createSnipeLane({ venue: VENUE, readers, control, state: S, clock: () => t,
    cfg: { ...snipeLaneConfig({ SNIPE_LANE: "observe" }), forwardSamples: 3 }, log: () => {} });
  openSnipe(S, { mint: MINT, venue: VENUE.id, openedAt: NOW0 - 1_000, entry: 1, sizeSol: 0.200308, feeSolPerLeg: 0.000015,
    qtyRaw: "8890325990118", entryInputLamports: "200293000", entryFeeLamports: "15000", forward: [], samples: 0, marks: [], high: 1 });
  const o = await lane.tick();
  ok("a complete curve in the shadow book is recorded, not blocked", o[0].action !== "blocked" && lane.stats().exitBlocked === 0, `action ${o[0].action}`);
}

console.log("\n6. the wiring: the heartbeat carries the row's exit state and the desk keeps it");
{
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  const open = poller.slice(poller.indexOf("out.open = lane.openPositions()"), poller.indexOf("out.counts = {"));
  ok("the poller publishes exitAttempts, exitError, exitBlocked and exitLatchedAt on each open row",
    /exitAttempts: Number\(p\.exitAttempts\)/.test(open) && /exitError: p\.exitError \?/.test(open)
    && /exitBlocked: p\.exitBlocked \?/.test(open) && /exitLatchedAt: Number\(p\.exitLatchedAt\)/.test(open));
  ok("...and the blocked count beside the failed-sell count", /exitBlocked: Number\(s\.exitBlocked\) \|\| 0/.test(poller));
  const office = fs.readFileSync(new URL("../src/office.js", import.meta.url), "utf8");
  const san = office.slice(office.indexOf("export function sanitizeExecutorSnipe"), office.indexOf("export function", office.indexOf("export function sanitizeExecutorSnipe") + 10));
  ok("the desk's sanitizer passes all four, bounded, and the count", /exitAttempts: count\(p\.exitAttempts\)/.test(san) && /exitError: p\.exitError == null \? null : String\(p\.exitError\)\.slice\(0, 240\)/.test(san)
    && /exitBlocked: \/\^\[a-z_\]\{1,40\}\$\/\.test/.test(san) && /exitLatchedAt: timestamp\(p\.exitLatchedAt\)/.test(san) && /exitBlocked: count\(c\.exitBlocked\)/.test(san));
  const tab = fs.readFileSync(new URL("../viewer/office3d.html", import.meta.url), "utf8");
  ok("the HAWK-AI tab says SELL BY HAND on the row", /SELL BY HAND — \$\{p\.exitBlocked\}/.test(tab) && /sell failing \(\$\{p\.exitAttempts\}/.test(tab));
  const page = fs.readFileSync(new URL("../viewer/agent.html", import.meta.url), "utf8");
  ok("the agent page says it too", /id="sellfail"/.test(page) && /SELL BY HAND — \$\{p\.exitBlocked\}/.test(page));
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  const blocked = lane.slice(lane.indexOf("async function stepBlocked"), lane.indexOf("async function consume"));
  for (const forbidden of ["executor.sell", "readAcrossEndpoints", "readers", "new Connection", "fetch("])
    ok(`the blocked path never touches ${forbidden}`, !blocked.includes(forbidden));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-exit-stuck  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
