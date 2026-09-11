/**
 * THE OBSERVE LANE, DRIVEN END TO END AGAINST FAKES — offline, no clock of its own, no
 * keypair, no socket.
 *
 * What this file is trying to catch, stated before the assertions so the assertions can be
 * judged against it:
 *
 *   1. A HOSTILE LAUNCH THAT IS REFUSED BY THE WRONG GATE. A refusal is not enough: the
 *      gate list is ordered cheapest-first and the first failure NAMES the refusal, so a
 *      launch with a live freeze authority that gets refused for being stale is a gate
 *      stack reporting the wrong fact about the world. Every hostile case below asserts
 *      the gate BY NAME and prints it.
 *   2. A CLEAN LAUNCH THAT PRODUCES NO CEILING. The whole point of the shadow row is the
 *      exact quantity and the exact lamport ceiling it would have signed; a row that says
 *      "would have entered" with a null ceiling records nothing.
 *   3. ANYTHING SIGNING. Asserted four ways, because one way is a promise: the facade
 *      refuses each encoder by name, the underlying adapter's own call counters are read
 *      after a full run and must be zero, the row and the lane stats carry signed/sent
 *      counts, and both module sources are scanned (comments stripped) for a keypair, a
 *      signature or a send.
 *   4. A DECISION THAT DOES NOT REPLAY. The same input is run through two independently
 *      constructed lanes with the same injected clock and the rows are compared as JSON,
 *      byte for byte. A determiner that reached for Date.now() would show up here.
 *
 * THE HOUSE RULES THIS FILE IS WRITTEN TO
 *
 *   · EVERY ASSERTION PRINTS THE ACTUAL VALUE. A pass that does not say what it measured
 *     cannot be checked by the person reading the transcript.
 *   · EVERY GUARD IS ASSERTED IN BOTH DIRECTIONS. The honesty guard is run on a real
 *     report (must pass) and on the same report with a hit rate spliced into it (must
 *     throw). The daily-cap charge is driven ON and OFF and the row counts of each are
 *     printed. A guard that cannot say no is not a guard.
 *   · THE RULER IS VALIDATED AGAINST A CASE WHOSE ANSWER IS KNOWN FIRST. The scorecard is
 *     run over four hand-built rows whose tp/fp/fn/tn and precision are worked out in the
 *     comment beside them, and the queue-depth delta is asserted against slots this file
 *     chose, so "4" is a number with a known right answer rather than whatever came out.
 *   · THE MIRRORED CONSTANTS ARE READ FROM THEIR SOURCES AS TEXT. Every rail this lane
 *     re-declares is checked against poller.mjs / strategy.mjs / src/launch-shadow.js on
 *     disk, so a copy that drifts fails here instead of quietly becoming a fork.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";

import {
  LANE_REFUSED_VENUE_METHODS, SNIPE_ENV, SNIPE_LANE_DEFAULTS, SNIPE_LANE_MODES, SNIPE_LANE_VERSION,
  SnipeLaneError, bindDeterminer, createSnipeLane, observeOnlyVenue, readAcrossEndpoints, snipeLaneConfig,
} from "./snipe-lane.mjs";
import {
  PROMOTION_MIN_FLAGGED, PROMOTION_MIN_ROWS, PROMOTION_PRECISION_BAR, SHADOW_FORBIDDEN_MEASURES,
  SHADOW_HOPS, SNIPE_PROXIES, SNIPE_SHADOW_VERSION, ShadowHonestyError, assertReportHonest,
  createSnipeShadow, followedAfterFill, hopTiming, positiveOutcome, renderShadowReport,
  shadowReport, snipeScorecard,
} from "./snipe-shadow.mjs";
import { SNIPE_GATES } from "./snipe-entry.mjs";
import { createSnipeFeed } from "./snipe-feed.mjs";
import {
  constantProductExactIn, constantProductExactOut, constantProductSellExactIn,
} from "./snipe-curve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LANE_SRC = fs.readFileSync(path.join(HERE, "snipe-lane.mjs"), "utf8");
const SHADOW_SRC = fs.readFileSync(path.join(HERE, "snipe-shadow.mjs"), "utf8");
const POLLER_SRC = fs.readFileSync(path.join(HERE, "poller.mjs"), "utf8");
const STRATEGY_SRC = fs.readFileSync(path.join(HERE, "strategy.mjs"), "utf8");
const LAUNCH_SHADOW_SRC = fs.readFileSync(path.join(ROOT, "src", "launch-shadow.js"), "utf8");

/* Source scans read CODE, not prose. A first draft of a scan like this failed on a header
   comment EXPLAINING that the module never signs — a ruler measuring the wrong thing,
   which is the one failure mode this repo's rules name outright. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const LANE_CODE = stripComments(LANE_SRC);
const SHADOW_CODE = stripComments(SHADOW_SRC);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);
const jsonSafe = (k, v) => (typeof v === "bigint" ? `${v}n` : v);

/* ── fixtures ──────────────────────────────────────────────────────────────────────── */

/** A deterministic, structurally valid 32-byte base58 key. The book decodes every mint and
 *  creator with bs58 and refuses anything that is not 32 non-zero bytes, so a fixture key
 *  has to be a real key shape rather than a readable string. */
const keyFor = (seed) => {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 7 + i * 31 + 11) % 251 + 1;
  return bs58.encode(bytes);
};

const WSOL = "So11111111111111111111111111111111111111112";
const VENUE_PROGRAM = keyFor(99);
const FAKE_CURVE_TYPE = "fake-constant-product";

/* The live pump.fun opening state, used because its answers are already known elsewhere in
   the repo: vTok 1,073,000,000,000,000 / vSol 30,000,000,000 / rTok 793,100,000,000,000 are
   the three numbers test-pumpfun-curve.mjs pins by hand. */
const HEALTHY_CURVE = Object.freeze({
  curveType: FAKE_CURVE_TYPE,
  vBaseRaw: "1073000000000000",
  vQuoteRaw: "30000000000",
  realBaseRaw: "793100000000000",
  realQuoteRaw: "110014725",
  complete: false,
  creator: keyFor(5),
});

/** A curve account whose bytes are the JSON of the state — the adapter below is the only
 *  thing that reads them, and a digest over these bytes is what the two endpoints are
 *  compared on. */
const curveAccount = (state) => ({
  owner: VENUE_PROGRAM,
  data: Buffer.from(JSON.stringify(state), "utf8"),
});

/** The jsonParsed mint record `src/data/solana.js mintInfo()` returns — the shape
 *  snipe-entry.mjs's judgeMint reads by flag name. */
const mintAccount = (over = {}) => ({
  ok: true, decimals: 6, mintAuthority: null, freezeAuthority: null,
  extensionDetail: [], botRefusals: [], ...over,
});

/** Counters on the three encoders, read at the end of the run. */
const encoderCalls = { buyIx: 0, buildBuy: 0, sellIx: 0, decodeBuyIx: 0 };

/** A minimal venue adapter over snipe-curve.mjs's own arithmetic. It exists so the lane
 *  can be driven without a chain; it is NOT layout-verified and does not pretend to be. */
const FAKE_VENUE = Object.freeze({
  id: "fake-curve",
  programId: VENUE_PROGRAM,
  quote: Object.freeze({ mint: WSOL, decimals: 9, symbol: "SOL", oracle: "pyth-sol-usd-cache" }),
  supportsExactOut: true,
  layoutVerified: false,
  supportedCurveTypes: Object.freeze([FAKE_CURVE_TYPE]),
  feeObservation: Object.freeze({ totalFeeBps: 125 }),

  async *watch() { /* the lane never calls this; the feed owns the transport */ },
  accountsFor(mint) { return [`curve:${mint}`, `global:${mint}`, `mint:${mint}`]; },
  curveFromAccount(account, { feeBps = null, mint = null } = {}) {
    if (!account?.data) return null;
    let raw;
    try { raw = JSON.parse(Buffer.from(account.data).toString("utf8")); } catch { return null; }
    if (raw.curveType !== FAKE_CURVE_TYPE) return null;
    return Object.freeze({
      kind: "bonding-curve", venue: "fake-curve", curveType: raw.curveType, mint,
      vBaseRaw: BigInt(raw.vBaseRaw), vQuoteRaw: BigInt(raw.vQuoteRaw),
      realBaseRaw: BigInt(raw.realBaseRaw), realQuoteRaw: BigInt(raw.realQuoteRaw),
      complete: raw.complete === true, creator: raw.creator ?? null,
      feeBps: feeBps === null ? null : Number(feeBps),
    });
  },
  quoteExactIn(curve, quoteInRaw) {
    return constantProductExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, quoteInRaw, feeBps: curve.feeBps ?? 0 });
  },
  quoteExactOut(curve, baseOutRaw) {
    return constantProductExactOut({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseOutRaw, feeBps: curve.feeBps ?? 0 });
  },
  sellExactIn(curve, baseInRaw) {
    return constantProductSellExactIn({
      vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseInRaw,
      feeBps: curve.feeBps ?? 0, realQuoteRaw: curve.realQuoteRaw ?? null,
    });
  },
  buyIx() { encoderCalls.buyIx++; return []; },
  buildBuy() { encoderCalls.buildBuy++; return []; },
  sellIx() { encoderCalls.sellIx++; return []; },
  decodeBuyIx() { encoderCalls.decodeBuyIx++; return {}; },
  exitRoute() { return { via: "curve", routable: true, reason: "the fixture venue quotes its own sell" }; },
  isComplete(curve) { return curve.complete === true; },
  quoteReserveLamports(curve) { return BigInt(curve.realQuoteRaw); },
});

/** Two endpoints over a scripted account table. `plan` is per-endpoint, so a test can make
 *  one node lie, one node lag, or both go dark. */
function makeReaders(plan) {
  return plan.map(({ id, slot, accounts, throws = false }) => ({
    id,
    async read(mint) {
      if (throws) throw new Error(`endpoint ${id} is unreachable`);
      const table = typeof accounts === "function" ? accounts(mint) : accounts;
      return { slot, accounts: table };
    },
  }));
}

const NOW0 = 1_700_000_000_000;
/** A clock that advances one millisecond per read: deterministic, replayable, and it still
 *  produces distinguishable hop timings. */
const makeClock = (start = NOW0) => { let t = start; return () => (t += 1); };

const noticeRecord = (mint, over = {}) => Object.freeze({
  feedVersion: "snipe-feed-v1",
  mint, creator: keyFor(5), venueId: "fake-curve",
  firstSource: "logs-a", firstKind: "logs", firstSeenAtMs: NOW0, firstSlot: 446_023_100,
  sources: Object.freeze([Object.freeze({ source: "logs-a", kind: "logs", arrivedAtMs: NOW0, slot: 446_023_100, lagMsFromFirst: 0, slotsBehindFirst: 0 })]),
  corroborations: 0, clockRegression: false, reemittedAfterEviction: false, raw: null,
  ...over,
});

const OK_CONTROL = () => ({ hardStop: false, pauseEntries: false });

/** Build a lane over one scripted world. Everything it touches is a fixture. */
function laneFor({
  curve = HEALTHY_CURVE, mint = mintAccount(), slots = [446_023_104, 446_023_104],
  cfg = {}, control = OK_CONTROL, clock = makeClock(), plan = null, book = null, log = () => {},
  venue = FAKE_VENUE,
} = {}) {
  const accountsFor = (m) => [curveAccount(curve), { data: Buffer.from("global") }, mint];
  const readers = makeReaders(plan ?? [
    { id: "endpoint-a", slot: slots[0], accounts: accountsFor },
    { id: "endpoint-b", slot: slots[1], accounts: accountsFor },
  ]);
  return createSnipeLane({
    venue, readers, control, clock, log,
    cfg: { lane: "observe", ...cfg },
    state: {},
    book: book ?? { deployedTodaySol: 0, attempts: {} },
  });
}

/* ════════════════════════════════════════════════════════════════════════════════════ */

section("1. NOTHING RUNS AT IMPORT, AND NOTHING CAN SIGN");

ok("the lane declares its version", SNIPE_LANE_VERSION === "snipe-lane-v1", SNIPE_LANE_VERSION);
ok("the shadow declares its version", SNIPE_SHADOW_VERSION === "snipe-shadow-v1", SNIPE_SHADOW_VERSION);
{
  /* Importing a module that starts a timer or opens a socket is a lane that is running
     before anybody armed it. The scans are over code with comments stripped. */
  const timers = /\b(setInterval|setTimeout)\s*\(/.exec(LANE_CODE);
  ok("snipe-lane.mjs starts no timer", timers === null, `match: ${timers ? timers[0] : "none"}`);
  const conn = /new\s+Connection\s*\(/.exec(LANE_CODE);
  ok("snipe-lane.mjs constructs no Connection", conn === null, `match: ${conn ? conn[0] : "none"}`);

  const forbidden = [/\bKeypair\b/, /\bsendRawTransaction\b/, /\bsendTransaction\b/, /\bpartialSign\b/,
    /\bsignTransaction\b/, /\bfromSecretKey\b/, /\bSECRET\b/, /\bburner\b/];
  for (const src of [["snipe-lane.mjs", LANE_CODE], ["snipe-shadow.mjs", SHADOW_CODE]])
    for (const re of forbidden) {
      const hit = re.exec(src[1]);
      ok(`${src[0]} contains no ${re.source}`, hit === null, `match: ${hit ? hit[0] : "none"}`);
    }

  /* The shadow recorder is pure of I/O: the sink is injected and this file opens nothing. */
  const io = /\b(readFileSync|writeFileSync|createWriteStream|fetch\s*\(|require\s*\(\s*["']fs)/.exec(SHADOW_CODE);
  ok("snipe-shadow.mjs performs no I/O of its own", io === null, `match: ${io ? io[0] : "none"}`);
  const clockUse = /\bDate\.now\s*\(/.exec(SHADOW_CODE);
  ok("snipe-shadow.mjs reads no clock of its own", clockUse === null, `match: ${clockUse ? clockUse[0] : "none"}`);
}

{
  const facade = observeOnlyVenue(FAKE_VENUE);
  for (const method of LANE_REFUSED_VENUE_METHODS) {
    let threw = null;
    try { facade[method]({}); } catch (error) { threw = error; }
    ok(`the facade refuses ${method}()`, threw instanceof SnipeLaneError && threw.clause === "signing_refused",
      `${threw?.name} clause ${threw?.clause}`);
  }
  ok("the facade still satisfies the observe venue contract", facade.observeOnly === true
    && typeof facade.quoteExactOut === "function", `id ${facade.id}, observeOnly ${facade.observeOnly}`);
  ok("the facade does not inflate the venue's layout claim", facade.layoutVerified === false,
    `layoutVerified ${facade.layoutVerified}`);
  ok("no encoder ran while building the facade",
    encoderCalls.buyIx + encoderCalls.buildBuy + encoderCalls.sellIx === 0,
    JSON.stringify(encoderCalls));
}

{
  /* Constructing a lane must not start a feed. */
  let started = 0;
  const feed = { async start() { started++; return {}; }, notices() { return (async function* () {})(); }, async stop() { return {}; } };
  const lane = createSnipeLane({
    venue: FAKE_VENUE, feed, control: OK_CONTROL, cfg: { lane: "observe" }, clock: makeClock(),
    readers: makeReaders([{ id: "a", slot: 1, accounts: [] }, { id: "b", slot: 1, accounts: [] }]),
  });
  ok("createSnipeLane does not start the feed", started === 0, `feed.start() calls: ${started}`);
  ok("the lane reports observe mode", lane.mode === "observe", lane.mode);
  ok("the lane's own counters start at zero signed and zero sent",
    lane.stats().signed === 0 && lane.stats().sent === 0 && lane.stats().keypairsLoaded === 0,
    JSON.stringify({ signed: lane.stats().signed, sent: lane.stats().sent, keypairs: lane.stats().keypairsLoaded }));
}

section("2. THE CONFIG IS ITS OWN OBJECT, AND EXECUTE IS REFUSED BY NAME");

{
  const cfg = snipeLaneConfig({});
  ok("an empty environment leaves the lane OFF", cfg.lane === "off", `lane ${cfg.lane}`);
  ok("every env name carries the SNIPE_ prefix",
    Object.keys(SNIPE_ENV).every((n) => n.startsWith("SNIPE_")),
    `${Object.keys(SNIPE_ENV).length} names, e.g. ${Object.keys(SNIPE_ENV).slice(0, 3).join(", ")}`);

  const observe = snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_NOTICE_MAX_MS: "1500" });
  ok("SNIPE_LANE=observe arms the observe lane", observe.lane === "observe", `lane ${observe.lane}`);
  ok("a SNIPE_ number reaches the config", observe.noticeMaxMs === 1500, `noticeMaxMs ${observe.noticeMaxMs}`);

  const refuses = (name, env, clause) => {
    let threw = null;
    try { snipeLaneConfig(env); } catch (error) { threw = error; }
    ok(name, threw instanceof SnipeLaneError && threw.clause === clause,
      `${threw?.name ?? "no throw"} clause ${threw?.clause ?? "—"}`);
  };
  refuses("SNIPE_LANE=execute is refused", { SNIPE_LANE: "execute" }, "execute_not_implemented");
  refuses("SNIPE_EXECUTE=1 is refused even in observe", { SNIPE_LANE: "observe", SNIPE_EXECUTE: "1" }, "execute_not_implemented");
  refuses("a malformed number is refused, not coerced", { SNIPE_MAX_SOL_PER_TRADE: "abc" }, "mode_invalid");
  refuses("an unknown lane name is refused", { SNIPE_LANE: "armed" }, "mode_invalid");
  /* "0" is truthy as a string — the classic way an OFF switch turns something on. */
  const off = snipeLaneConfig({ SNIPE_CHARGE_DAILY_CAP: "0" });
  ok("SNIPE_CHARGE_DAILY_CAP=0 reads as false, not as a truthy string",
    off.chargeDailyCap === false, `chargeDailyCap ${off.chargeDailyCap}`);
  const on = snipeLaneConfig({ SNIPE_CHARGE_DAILY_CAP: "1" });
  ok("SNIPE_CHARGE_DAILY_CAP=1 reads as true", on.chargeDailyCap === true, `chargeDailyCap ${on.chargeDailyCap}`);

  let laneThrew = null;
  try {
    createSnipeLane({ venue: FAKE_VENUE, control: OK_CONTROL, cfg: { lane: "execute" },
      readers: makeReaders([{ id: "a", slot: 1, accounts: [] }, { id: "b", slot: 1, accounts: [] }]) });
  } catch (error) { laneThrew = error; }
  ok("createSnipeLane refuses lane=execute outright",
    laneThrew instanceof SnipeLaneError && laneThrew.clause === "execute_not_implemented",
    `${laneThrew?.name} clause ${laneThrew?.clause}`);
}

{
  /* THE MIRRORED RAILS, read from their sources as text. A copy that is tested against its
     source is a copy; one that is not is a fork waiting to happen. */
  const live = POLLER_SRC.slice(POLLER_SRC.indexOf("const LIVE_LIMITS"), POLLER_SRC.indexOf("const LIVE_LIMITS") + 4000);
  const railIn = (src, name) => {
    const m = new RegExp(`\\b${name}:\\s*([0-9_.]+)`).exec(src);
    return m ? Number(m[1].replace(/_/g, "")) : null;
  };
  for (const name of ["maxSolPerTrade", "dailySolCap", "maxPriceImpactPct", "maxEntryRoundTripLossPct",
    "maxNetworkFeeLamports", "maxNetworkFeePct"]) {
    const there = railIn(live, name);
    ok(`${name} mirrors poller.mjs LIVE_LIMITS`, there !== null && there === SNIPE_LANE_DEFAULTS[name],
      `poller ${there} vs lane ${SNIPE_LANE_DEFAULTS[name]}`);
  }
  const expectedFee = railIn(live, "expectedNetworkFeeLamports");
  ok("networkFeeReserveSol is expectedNetworkFeeLamports / 1e9, as poller.mjs:1407 derives it",
    expectedFee === Math.round(SNIPE_LANE_DEFAULTS.networkFeeReserveSol * 1e9),
    `poller ${expectedFee} lamports vs lane ${SNIPE_LANE_DEFAULTS.networkFeeReserveSol} SOL`);
  for (const name of ["maxFeeShareOfStop", "minSolPerTrade"]) {
    const there = railIn(STRATEGY_SRC, name);
    ok(`${name} mirrors strategy.mjs DEFAULTS`, there !== null && there === SNIPE_LANE_DEFAULTS[name],
      `strategy ${there} vs lane ${SNIPE_LANE_DEFAULTS[name]}`);
  }
  /* THE TWO FEE NUMBERS ARE NOT THE SAME NUMBER. The budget gate judges the measured
     estimate; the cost model sizes the position. Both are sourced from poller.mjs. */
  const peakAsWritten = SNIPE_LANE_DEFAULTS.priorityFeeLamports.toLocaleString("en-US");
  ok("the modelled priority fee is the measured live peak, quoted in poller.mjs",
    POLLER_SRC.includes(peakAsWritten),
    `"${peakAsWritten}" appears in poller.mjs: ${POLLER_SRC.includes(peakAsWritten)}`);
  ok("the fee MODEL is far under the COST model, which is why the book is not silenced at gate 19",
    SNIPE_LANE_DEFAULTS.signatureFeeLamports + SNIPE_LANE_DEFAULTS.priorityFeeLamports
      < SNIPE_LANE_DEFAULTS.networkFeeReserveSol * 1e9,
    `model ${SNIPE_LANE_DEFAULTS.signatureFeeLamports + SNIPE_LANE_DEFAULTS.priorityFeeLamports} lamports `
    + `vs cost model ${SNIPE_LANE_DEFAULTS.networkFeeReserveSol * 1e9}`);

  /* The promotion floors are the desk's, reused rather than invented. */
  const floorIn = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(LAUNCH_SHADOW_SRC);
    return m ? Number(m[1]) : null;
  };
  ok("PROMOTION_PRECISION_BAR is src/launch-shadow.js's", floorIn("PROMOTION_PRECISION_BAR") === PROMOTION_PRECISION_BAR,
    `desk ${floorIn("PROMOTION_PRECISION_BAR")} vs shadow ${PROMOTION_PRECISION_BAR}`);
  ok("PROMOTION_MIN_ROWS is src/launch-shadow.js's", floorIn("PROMOTION_MIN_ROWS") === PROMOTION_MIN_ROWS,
    `desk ${floorIn("PROMOTION_MIN_ROWS")} vs shadow ${PROMOTION_MIN_ROWS}`);
  ok("PROMOTION_MIN_FLAGGED is src/launch-shadow.js's", floorIn("PROMOTION_MIN_FLAGGED") === PROMOTION_MIN_FLAGGED,
    `desk ${floorIn("PROMOTION_MIN_FLAGGED")} vs shadow ${PROMOTION_MIN_FLAGGED}`);
}

{
  /* Two endpoints, unconditionally — §2.6's build item. */
  const one = makeReaders([{ id: "only", slot: 1, accounts: [] }]);
  let threw = null;
  try { createSnipeLane({ venue: FAKE_VENUE, control: OK_CONTROL, cfg: { lane: "observe" }, readers: one }); }
  catch (error) { threw = error; }
  ok("one endpoint is refused", threw instanceof SnipeLaneError && threw.clause === "single_endpoint",
    `clause ${threw?.clause}`);

  const twice = makeReaders([{ id: "same", slot: 1, accounts: [] }, { id: "same", slot: 1, accounts: [] }]);
  threw = null;
  try { createSnipeLane({ venue: FAKE_VENUE, control: OK_CONTROL, cfg: { lane: "observe" }, readers: twice }); }
  catch (error) { threw = error; }
  ok("two names for one node are refused", threw instanceof SnipeLaneError && threw.clause === "duplicate_endpoint",
    `clause ${threw?.clause}`);

  threw = null;
  try {
    createSnipeLane({ venue: FAKE_VENUE, cfg: { lane: "observe" },
      readers: makeReaders([{ id: "a", slot: 1, accounts: [] }, { id: "b", slot: 1, accounts: [] }]) });
  } catch (error) { threw = error; }
  ok("a lane with no control reader is refused — unchecked is not the same fact as absent",
    threw instanceof SnipeLaneError && threw.clause === "control_unchecked", `clause ${threw?.clause}`);

  threw = null;
  try { bindDeterminer({ nothing: true }); } catch (error) { threw = error; }
  ok("a determiner presenting neither shape is refused",
    threw instanceof SnipeLaneError && threw.clause === "determiner_unbound", `clause ${threw?.clause}`);
  const bound = bindDeterminer();
  ok("the determiner on disk binds", bound.shape === "snipeStep" || bound.shape === "snipePolicy",
    `shape ${bound.shape}, version ${bound.version}`);
}

section("3. A CLEAN LAUNCH PRODUCES A ROW WITH A CEILING");

let cleanRow = null;
{
  const lane = laneFor();
  const mint = keyFor(1);
  const { row, verdict } = await lane.handleNotice(noticeRecord(mint));
  cleanRow = row;
  ok("the clean launch clears every gate", verdict.ok === true,
    `gate ${verdict.gate ?? "none"}${verdict.gate ? ` — ${verdict.detail.message}` : ""}`);
  ok(`all ${SNIPE_GATES.length} gates ran`, row.gate.trace.length === SNIPE_GATES.length,
    `${row.gate.trace.length} of ${SNIPE_GATES.length}, every one ok: ${row.gate.trace.every((s) => s.ok)}`);
  ok("the row carries a contracted quantity", BigInt(row.ceiling.baseOutRaw) > 0n, `baseOutRaw ${row.ceiling.baseOutRaw}`);
  ok("the row carries an absolute lamport ceiling", BigInt(row.ceiling.maxQuoteInRaw) > 0n,
    `maxQuoteInRaw ${row.ceiling.maxQuoteInRaw} lamports`);
  ok("the ceiling never exceeds the ticket — a ceiling above the ticket is not a ceiling",
    BigInt(row.ceiling.maxQuoteInRaw) <= BigInt(row.ceiling.ticketLamports),
    `${row.ceiling.maxQuoteInRaw} <= ${row.ceiling.ticketLamports}`);

  /* frictionX at the live cap: 1 + (500,000 + 500,000) / entryInput. With the fee carried
     BESIDE a 5,000,000-lamport input that is exactly 1.2000 — F2's measured number. */
  const expected = 1 + 1_000_000 / Number(row.ceiling.maxQuoteInRaw);
  ok("frictionX is computed from the lamports actually paid",
    Math.abs(row.ceiling.frictionX - expected) < 1e-12,
    `frictionX ${row.ceiling.frictionX.toFixed(6)} vs hand-worked ${expected.toFixed(6)}`);
  ok("frictionX at the live cap is ~1.20x — round-trip friction is 20% of a 0.005 SOL ticket",
    row.ceiling.frictionX > 1.19 && row.ceiling.frictionX < 1.21, `frictionX ${row.ceiling.frictionX.toFixed(6)}`);

  ok("the row says nothing was signed", row.signed === false && row.sent === false,
    `signed ${row.signed}, sent ${row.sent}`);
  ok("the would-have-position reached the observe book", lane.openPositions().length === 1,
    `${lane.openPositions().length} open, mint ${lane.openPositions()[0]?.mint?.slice(0, 8)}…`);
  const pos = lane.positionFor(mint);
  ok("the filed row is stamped lane=snipe by the book, not by the lane", pos.lane === "snipe", `lane ${pos.lane}`);
  ok("the filed row carries the ceiling as its swap input",
    pos.entryInputLamports === row.ceiling.maxQuoteInRaw,
    `entryInputLamports ${pos.entryInputLamports} = maxQuoteInRaw ${row.ceiling.maxQuoteInRaw}`);
  ok("no encoder was called on the clean path",
    encoderCalls.buyIx + encoderCalls.buildBuy + encoderCalls.sellIx === 0, JSON.stringify(encoderCalls));
  ok("the lane's stats still say zero signed, zero sent",
    lane.stats().signed === 0 && lane.stats().sent === 0 && lane.stats().cleared === 1,
    `cleared ${lane.stats().cleared}, signed ${lane.stats().signed}, sent ${lane.stats().sent}`);
}

section("4. THE SLOT DELTA — HOW FAR BACK IN THE QUEUE THIS MACHINE SITS");

{
  /* The answer is known in advance: the notice says the create landed at slot 446,023,100
     and both endpoints answered at 446,023,104, so the delta is 4. */
  ok("the row prints the create-to-first-mark slot delta", cleanRow.slotDeltaToFirstMark === 4,
    `create ${cleanRow.createSlot} -> read ${cleanRow.observedSlot} = ${cleanRow.slotDeltaToFirstMark} slots`);

  const unknown = laneFor();
  const { row } = await unknown.handleNotice(noticeRecord(keyFor(2), { firstSlot: null }));
  ok("an unmeasured delta is null, never 0 — they are opposite findings",
    row.slotDeltaToFirstMark === null, `slotDeltaToFirstMark ${JSON.stringify(row.slotDeltaToFirstMark)}`);

  const report = shadowReport([cleanRow, row]);
  ok("the queue-depth table counts the measured and the unmeasured separately",
    report.queueDepthSlots.n === 1 && report.queueDepthSlots.unmeasured === 1,
    `n ${report.queueDepthSlots.n}, unmeasured ${report.queueDepthSlots.unmeasured}, median ${report.queueDepthSlots.median}`);
  const text = renderShadowReport(report);
  ok("the rendered report prints the per-entry slot delta", /delta\s+4\s+slots/.test(text),
    (text.split("\n").find((l) => /delta/.test(l)) ?? "").trim().slice(0, 96));
}

section("5. HOSTILE LAUNCHES ARE REFUSED BY THE GATE THAT NAMES THE FACT");

{
  const cases = [
    {
      name: "a live freeze authority",
      gate: "mint_refused",
      build: () => laneFor({ mint: mintAccount({ freezeAuthority: keyFor(70) }) }),
    },
    {
      name: "a live mint authority",
      gate: "mint_refused",
      build: () => laneFor({ mint: mintAccount({ mintAuthority: keyFor(71) }) }),
    },
    {
      name: "a transfer hook",
      gate: "mint_refused",
      build: () => laneFor({ mint: mintAccount({ extensionDetail: [{ extension: "transferHook" }] }) }),
    },
    {
      name: "a curve that has already graduated",
      gate: "curve_already_complete",
      build: () => laneFor({ curve: { ...HEALTHY_CURVE, complete: true } }),
    },
    {
      name: "a curve nobody can decode",
      gate: "curve_unreadable",
      build: () => laneFor({ curve: { ...HEALTHY_CURVE, curveType: "something-else" } }),
    },
    {
      name: "two endpoints disagreeing at one slot",
      gate: "curve_unreadable",
      /* Three different transport facts land on ONE gate code on purpose — the frozen gate
         list is additive-only and a new code here would sit outside GATE_CLASS, where
         src/calls.js gateClass() answers SAFETY for anything it has not heard of and would
         turn a node hiccup into an un-waivable rug check. The distinction rides on the row
         instead, which is where it is actually read, so the row is asserted to carry it. */
      endpointVerdict: "disagree",
      build: () => laneFor({
        plan: [
          { id: "endpoint-a", slot: 446_023_104, accounts: () => [curveAccount(HEALTHY_CURVE), {}, mintAccount()] },
          { id: "endpoint-b", slot: 446_023_104, accounts: () => [curveAccount({ ...HEALTHY_CURVE, realQuoteRaw: "999999999" }), {}, mintAccount()] },
        ],
      }),
    },
    {
      name: "both endpoints dark",
      gate: "curve_unreadable",
      endpointVerdict: "both_missing",
      build: () => laneFor({ plan: [
        { id: "endpoint-a", slot: null, accounts: [], throws: true },
        { id: "endpoint-b", slot: null, accounts: [], throws: true },
      ] }),
    },
    {
      name: "a curve so thin the impact cap cannot be met at any rung",
      gate: "impact_over_cap",
      build: () => laneFor({ curve: { ...HEALTHY_CURVE, vQuoteRaw: "3000000", realQuoteRaw: "1000000" } }),
    },
    {
      name: "the HARD STOP sentinel",
      gate: "hard_stop",
      build: () => laneFor({ control: () => ({ hardStop: true, pauseEntries: false }) }),
    },
    {
      name: "the PAUSE ENTRIES sentinel",
      gate: "pause_entries",
      build: () => laneFor({ control: () => ({ hardStop: false, pauseEntries: true }) }),
    },
    {
      name: "a sentinel nobody checked",
      gate: "hard_stop",
      build: () => laneFor({ control: () => ({}) }),
    },
    {
      name: "the lane switched off",
      gate: "lane_off",
      build: () => laneFor({ cfg: { lane: "off" } }),
    },
    {
      name: "a notice older than the staleness bound",
      gate: "notice_stale",
      build: () => laneFor(),
      /* 60s old against the 30s default bound. The bound is a BOUND, not a latency claim
         — §7.8 says this lane's notice-to-signature time is unmeasured and the observe log
         is what will eventually justify a real number. */
      notice: { firstSeenAtMs: NOW0 - 60_000 },
    },
    {
      name: "a venue that cannot name an exit route",
      gate: "exit_route_unimplemented",
      /* THE POSTURE OF EVERY REAL VENUE IN THIS REPO TODAY. snipe-venue-pumpfun.mjs's
         exitRoute answers `routable: false` for any live curve because its sell
         instruction layout is unproved — WE MAY NOT ENTER WHAT WE CANNOT EXIT. */
      build: () => laneFor({
        venue: { ...FAKE_VENUE, exitRoute: () => ({ via: null, routable: false, reason: "layout unverified" }) },
      }),
    },
  ];

  let i = 100;
  for (const c of cases) {
    i += 1;
    const lane = c.build();
    const { row, verdict } = await lane.handleNotice(noticeRecord(keyFor(i), c.notice ?? {}));
    ok(`${c.name} -> ${c.gate}`, verdict.ok === false && verdict.gate === c.gate,
      `refused at ${verdict.gate ?? "NOTHING"} (cost ${row.gate.refusedAtCost}): ${String(verdict.detail.message).slice(0, 92)}`);
    ok(`  …and ${c.name} filed a row anyway`, row.mint === keyFor(i) && row.wouldHaveSigned === false,
      `${row.gate.trace.length} of ${SNIPE_GATES.length} gates ran before the refusal`);
    ok(`  …and nothing was opened for ${c.name}`, lane.openPositions().length === 0,
      `${lane.openPositions().length} open positions`);
    if (c.endpointVerdict)
      ok(`  …and the row names the transport fact behind ${c.gate}`,
        row.endpointVerdict === c.endpointVerdict,
        `endpointVerdict ${row.endpointVerdict} (wanted ${c.endpointVerdict}); endpoints `
        + `[${row.endpoints.map((e) => `${e.id}:${e.present ? e.digest : e.error ?? "absent"}`).join(", ")}]`);
  }
}

{
  /* The endpoint classification is carried on the row even though every one of those
     transport cases lands on the same gate. Three distinct facts, one refusal code —
     because inventing a code here would put it outside GATE_CLASS, where src/calls.js
     gateClass() answers SAFETY for anything it has not heard of. */
  const disagree = await readAcrossEndpoints({
    mint: keyFor(3), addresses: [],
    readers: makeReaders([
      { id: "a", slot: 500, accounts: () => [curveAccount(HEALTHY_CURVE)] },
      { id: "b", slot: 500, accounts: () => [curveAccount({ ...HEALTHY_CURVE, realQuoteRaw: "7" })] },
    ]),
  });
  ok("two nodes, one slot, different bytes -> disagree", disagree.verdict === "disagree",
    `verdict ${disagree.verdict}, digests [${disagree.endpoints.map((e) => e.digest).join(", ")}]`);

  const lagging = await readAcrossEndpoints({
    mint: keyFor(3), addresses: [],
    readers: makeReaders([
      { id: "a", slot: 500, accounts: () => [curveAccount(HEALTHY_CURVE)] },
      { id: "b", slot: 507, accounts: () => [curveAccount({ ...HEALTHY_CURVE, realQuoteRaw: "7" })] },
    ]),
  });
  ok("two nodes at different slots is progress, not a fault — the newer slot is taken",
    lagging.verdict === "agree" && lagging.slot === 507, `verdict ${lagging.verdict}, slot ${lagging.slot}`);

  const halfDark = await readAcrossEndpoints({
    mint: keyFor(3), addresses: [],
    readers: makeReaders([
      { id: "a", slot: 500, accounts: () => [curveAccount(HEALTHY_CURVE)] },
      { id: "b", slot: 500, accounts: () => [null] },
    ]),
  });
  ok("one node's gap is one_missing, not a chain fact", halfDark.verdict === "one_missing",
    `verdict ${halfDark.verdict}`);
}

section("6. THE DAILY CAP, DRIVEN IN BOTH DIRECTIONS");

{
  /* dailySolCap 0.006 admits exactly one 0.005 SOL ticket. With the charge ON the second
     notice must be refused at daily_capacity; with it OFF the book keeps recording, which
     is the whole reason the switch exists. */
  const charged = laneFor({ cfg: { dailySolCap: 0.006, chargeDailyCap: true } });
  const a = await charged.handleNotice(noticeRecord(keyFor(11)));
  const b = await charged.handleNotice(noticeRecord(keyFor(12)));
  ok("with the charge ON, the first would-have-entry clears", a.verdict.ok === true, `gate ${a.verdict.gate ?? "none"}`);
  ok("with the charge ON, the second is refused at daily_capacity",
    b.verdict.ok === false && b.verdict.gate === "daily_capacity",
    `gate ${b.verdict.gate} — ${String(b.verdict.detail.message).slice(0, 88)}`);

  const uncharged = laneFor({ cfg: { dailySolCap: 0.006, chargeDailyCap: false } });
  const c = await uncharged.handleNotice(noticeRecord(keyFor(13)));
  const d = await uncharged.handleNotice(noticeRecord(keyFor(14)));
  ok("with the charge OFF, both are recorded — the book is not silenced after two notices",
    c.verdict.ok === true && d.verdict.ok === true,
    `rows ${uncharged.rows().length}, cleared ${uncharged.stats().cleared}, `
    + `would-have-deployed ${uncharged.stats().wouldHaveDeployedSol.toFixed(6)} SOL`);
  ok("…and the would-have-deployed total is reported either way",
    charged.stats().wouldHaveDeployedSol > 0 && uncharged.stats().wouldHaveDeployedSol > 0,
    `charged ${charged.stats().wouldHaveDeployedSol.toFixed(6)} SOL vs `
    + `uncharged ${uncharged.stats().wouldHaveDeployedSol.toFixed(6)} SOL`);
}

section("7. THE FORWARD PATH, THE DETERMINER, AND THE POSITIVE CLASS");

{
  /* One launch nobody follows: the real quote reserve never moves after the fill. */
  let reserve = 110_014_725;
  const lane = createSnipeLane({
    venue: FAKE_VENUE, control: OK_CONTROL, clock: makeClock(), cfg: { lane: "observe", forwardSamples: 3 },
    state: {}, book: { deployedTodaySol: 0, attempts: {} },
    readers: makeReaders([
      { id: "a", slot: 900, accounts: () => [curveAccount({ ...HEALTHY_CURVE, realQuoteRaw: String(reserve) }), {}, mintAccount()] },
      { id: "b", slot: 900, accounts: () => [curveAccount({ ...HEALTHY_CURVE, realQuoteRaw: String(reserve) }), {}, mintAccount()] },
    ]),
  });
  const mint = keyFor(21);
  await lane.handleNotice(noticeRecord(mint, { firstSlot: 896 }));
  ok("the position is open before the first tick", lane.openPositions().length === 1,
    `${lane.openPositions().length} open`);

  const t1 = await lane.tick();
  ok("a tick prices the position and the determiner holds",
    t1.length === 1 && t1[0].action === "hold" && Number.isFinite(t1[0].markX),
    `action ${t1[0].action}, markX ${t1[0].markX?.toFixed(6)}`);
  ok("markX at the fill is just under 1.0 — the venue fee is inside the round trip",
    t1[0].markX > 0.9 && t1[0].markX < 1.0, `markX ${t1[0].markX.toFixed(6)}`);

  await lane.tick();
  await lane.tick();
  ok("the forward window closes after forwardSamples ticks", lane.openPositions().length === 0,
    `${lane.openPositions().length} open after 3 ticks`);
  const row = lane.rows().find((r) => r.mint === mint);
  ok("the row carries the forward path", row.forward.length === 3,
    `${row.forward.length} samples, markX [${row.forward.map((f) => f.markX.toFixed(4)).join(", ")}]`);
  ok("the closed row carries the determiner's last word and the outcome it was judged on",
    row.outcome?.action === "window_closed" && row.outcome.samples === 3 && row.outcome.followed === false,
    `outcome ${JSON.stringify(row.outcome && { action: row.outcome.action, samples: row.outcome.samples, followed: row.outcome.followed })}`);
  ok("nobody followed this launch, so it is POSITIVE by the pre-stated class",
    followedAfterFill(row) === false && positiveOutcome(row) === true,
    `reserve at fill ${row.curve.realQuoteRaw}, max seen ${row.forward.map((f) => f.realQuoteRaw).join("/")}`);

  /* And the other direction: a launch somebody DID follow must be judged NEGATIVE. If the
     class could only ever say "positive" it would not be a class. */
  const followedRow = { ...row, forward: [...row.forward, { ...row.forward[0], realQuoteRaw: String(reserve + 1) }] };
  ok("a launch the reserve advanced past is NEGATIVE",
    followedAfterFill(followedRow) === true && positiveOutcome(followedRow) === false,
    `at fill ${followedRow.curve.realQuoteRaw}, later ${followedRow.forward.at(-1).realQuoteRaw}`);
}

{
  /* BLIND is not a sell signal: an unreadable mark reaches the determiner as null and the
     clock is what decides. Both endpoints go dark after the fill. */
  let dark = false;
  const accounts = () => (dark ? [null, null, null] : [curveAccount(HEALTHY_CURVE), {}, mintAccount()]);
  const lane = createSnipeLane({
    venue: FAKE_VENUE, control: OK_CONTROL, clock: makeClock(), cfg: { lane: "observe", forwardSamples: 2 },
    state: {}, book: { deployedTodaySol: 0, attempts: {} },
    readers: makeReaders([{ id: "a", slot: 900, accounts }, { id: "b", slot: 900, accounts }]),
  });
  await lane.handleNotice(noticeRecord(keyFor(22), { firstSlot: 898 }));
  dark = true;
  const stepped = await lane.tick();
  ok("an unreadable mark is not a sell — it is the absence of information",
    stepped[0].action === "hold" && stepped[0].markX === null,
    `action ${stepped[0].action}, markX ${JSON.stringify(stepped[0].markX)}`);
  const row = lane.rows().find((r) => r.mint === keyFor(22));
  ok("the blind sample is recorded with its endpoint verdict",
    row.forward[0].endpointVerdict === "both_missing" && row.forward[0].markX === null,
    `verdict ${row.forward[0].endpointVerdict}, markX ${JSON.stringify(row.forward[0].markX)}`);
}

section("8. THE SCORECARD, AGAINST A CASE WHOSE ANSWER IS KNOWN");

{
  /* Four hand-built rows. `creator_profile` flags at >= 10% of supply; the positive class
     is "nobody followed" (the forward reserve never rose above the fill's).
     row 1: measured 40, nobody followed   -> flagged, positive -> tp
     row 2: measured 40, somebody followed -> flagged, negative -> fp
     row 3: measured  1, nobody followed   -> not flagged, positive -> fn
     row 4: measured  1, somebody followed -> not flagged, negative -> tn
     So tp 1, fp 1, fn 1, tn 1; precision 1/(1+1) = 0.500 and recall 1/(1+1) = 0.500. */
  const mkRow = (sharePct, followed) => Object.freeze({
    mint: keyFor(sharePct + (followed ? 1 : 0)),
    wouldHaveSigned: true, signed: false, sent: false, laneMode: "observe",
    slotDeltaToFirstMark: 3, createSlot: 10, observedSlot: 13,
    curve: Object.freeze({ realQuoteRaw: "1000", reserveKnown: true }),
    forward: Object.freeze([Object.freeze({ realQuoteRaw: followed ? "1001" : "1000" })]),
    timing: Object.freeze({ hops: Object.freeze([]), noticeToDecisionMs: 7 }),
    gate: Object.freeze({ ok: true, refusedAt: null, trace: Object.freeze([]),
      measured: Object.freeze({ creator_profile: sharePct, launch_share: 0 }) }),
    endpointVerdict: "agree",
  });
  const rows = [mkRow(40, false), mkRow(40, true), mkRow(1, false), mkRow(1, true)];
  const card = snipeScorecard(rows);
  const cp = card.proxies.creator_profile;
  ok("the scorecard counts tp/fp/fn/tn as worked by hand",
    cp.tp === 1 && cp.fp === 1 && cp.fn === 1 && cp.tn === 1,
    `tp ${cp.tp} fp ${cp.fp} fn ${cp.fn} tn ${cp.tn}`);
  ok("precision is the hand-worked 0.500", cp.precision === 0.5, `precision ${cp.precision}`);
  ok("recall is the hand-worked 0.500", cp.recall === 0.5, `recall ${cp.recall}`);
  ok("it promotes nothing on four rows", cp.promotable === false, cp.why);
  ok("the positives are the two launches nobody followed", card.positives === 2,
    `${card.positives} positives of ${card.judged} judged`);

  /* A proxy that flagged perfectly still cannot be promoted under the sample floor — the
     floor is the point, and a precision of 1.000 on four rows is one lucky coin. */
  const perfect = snipeScorecard([mkRow(40, false), mkRow(1, true)]);
  ok("a perfect proxy on two rows is still not promotable",
    perfect.proxies.creator_profile.precision === 1 && perfect.proxies.creator_profile.promotable === false,
    `precision ${perfect.proxies.creator_profile.precision} — ${perfect.proxies.creator_profile.why}`);

  /* A row the outcome cannot be judged on is EXCLUDED, not counted as a negative. */
  const unjudgeable = { ...mkRow(40, false), forward: Object.freeze([]) };
  const excluded = snipeScorecard([...rows, unjudgeable]);
  ok("an unjudgeable row is excluded rather than scored as a negative",
    excluded.judged === 4 && excluded.proxies.creator_profile.n === 4,
    `judged ${excluded.judged} of ${rows.length + 1} rows supplied`);

  ok("the proxy set matches the two gates the lane deliberately does not kill on",
    Object.keys(SNIPE_PROXIES).sort().join(",") === "creator_profile,launch_share",
    Object.keys(SNIPE_PROXIES).join(", "));
}

section("9. THE REPORT REFUSES TO CLAIM A RESULT");

{
  const lane = laneFor();
  for (const n of [31, 32, 33]) await lane.handleNotice(noticeRecord(keyFor(n)));
  const report = lane.report();

  ok("the report is honest by its own guard", assertReportHonest(report) === true,
    `${report.rows} rows, ${report.clearedEveryGate} cleared`);
  ok("the report counts nothing signed or sent", report.signedOrSent === 0, `signedOrSent ${report.signedOrSent}`);
  ok("the report names every measure it refuses",
    report.doesNotReport.length === SHADOW_FORBIDDEN_MEASURES.length,
    report.doesNotReport.map((m) => m.measure).join(", "));
  ok("the report says adverse selection is unmeasured by construction",
    /UNMEASURED BY CONSTRUCTION/.test(report.adverseSelection),
    report.adverseSelection.slice(0, 88) + "…");
  ok("the sample floor is not met on three rows, and the report says so",
    report.sample.sufficient === false, report.sample.why);

  /* THE GUARD MUST BE ABLE TO SAY NO. Splice a hit rate in and it must throw, naming the
     measure and the path. This is the assertion that makes the refusal structural. */
  for (const [key, wanted] of [["hitRate", "hit rate"], ["pnl", "P&L"], ["roi", "ROI / return"]]) {
    let threw = null;
    try { assertReportHonest({ ...report, [key]: 0.42 }); } catch (error) { threw = error; }
    ok(`a spliced ${key} is refused`, threw instanceof ShadowHonestyError && threw.measure === wanted,
      `${threw?.name}: ${String(threw?.message).slice(0, 92)}`);
  }
  let nested = null;
  try { assertReportHonest({ ...report, gates: { ...report.gates, winRate: 0.9 } }); }
  catch (error) { nested = error; }
  ok("a hit rate hidden one level down is still refused",
    nested instanceof ShadowHonestyError && nested.where === "report.gates.winRate", `where ${nested?.where}`);
  ok("a STRING beside the same name is allowed — the report says the words on purpose",
    assertReportHonest({ ...report, hitRate: "not reported" }) === true, "string value passed");

  const text = lane.render();
  const offending = text.split("\n")
    .filter((line) => /hit rate|p&l|win rate|roi|expectancy/i.test(line))
    .filter((line) => /\d/.test(line));
  ok("no rendered line attaches a number to a refused measure", offending.length === 0,
    offending.length ? offending[0].slice(0, 96) : `${text.split("\n").length} lines checked`);
  ok("the rendered report still names them", /NOT REPORTED/.test(text),
    (text.split("\n").find((l) => /NOT REPORTED/.test(l)) ?? "").trim().slice(0, 88));
}

section("10. THE HOPS, AND THE FEED WIRED END TO END");

{
  const timing = hopTiming([{ hop: "notice", atMs: 1000 }, { hop: "accounts", atMs: 1040 },
    { hop: "decode", atMs: 1041 }, { hop: "gate", atMs: 1043 }]);
  ok("hop timing decomposes rather than totalling",
    timing.hops.length === 4 && timing.hops[1].msFromPrev === 40 && timing.noticeToDecisionMs === 43,
    `legs [${timing.hops.map((h) => `${h.hop} +${h.msFromPrev}`).join(", ")}], total ${timing.noticeToDecisionMs}ms`);
  const backwards = hopTiming([{ hop: "notice", atMs: 1000 }, { hop: "accounts", atMs: 900 }]);
  ok("a backwards stamp is reported as a clock regression, not clamped",
    backwards.clockRegression === true && backwards.hops[1].msFromPrev === -100,
    `msFromPrev ${backwards.hops[1].msFromPrev}, clockRegression ${backwards.clockRegression}`);
  ok("the row's hops are the ones the lane actually stamped",
    cleanRow.timing.hops.map((h) => h.hop).join(",") === SHADOW_HOPS.join(","),
    cleanRow.timing.hops.map((h) => h.hop).join(" -> "));
}

{
  /* The real feed, two sources, one mint, driven offline. The lane must consume what the
     feed deduped, and the corroborating leg must reach the row. */
  const clock = makeClock(NOW0);
  const mint = keyFor(41);
  let emitA = null, emitB = null;
  const source = (id) => ({
    id, kind: "logs", venueId: "fake-curve",
    start(ctx) { if (id === "logs-a") emitA = ctx.emit; else emitB = ctx.emit; return { stop() {} }; },
  });
  const feed = createSnipeFeed({ sources: [source("logs-a"), source("logs-b")], clock });
  const lane = createSnipeLane({
    venue: FAKE_VENUE, feed, control: OK_CONTROL, clock, cfg: { lane: "observe" }, state: {},
    book: { deployedTodaySol: 0, attempts: {} },
    readers: makeReaders([
      { id: "a", slot: 446_023_110, accounts: () => [curveAccount(HEALTHY_CURVE), {}, mintAccount()] },
      { id: "b", slot: 446_023_110, accounts: () => [curveAccount(HEALTHY_CURVE), {}, mintAccount()] },
    ]),
  });
  await lane.start();
  emitA({ mint, creator: keyFor(5), slot: 446_023_106 });
  emitB({ mint, creator: keyFor(5), slot: 446_023_106 });
  await new Promise((r) => setImmediate(r));
  await lane.stop();

  const rows = lane.rows();
  ok("the feed deduped the two sources into one notice and one row", rows.length === 1,
    `${rows.length} row(s), corroborations ${rows[0]?.notice.corroborations}`);
  /* THE LANE ACTS ON FIRST ARRIVAL, so the row it filed carries ONE leg — the second
     source's corroboration lands in the feed's ledger AFTER the decision was taken. That
     is the design (a t=0 lane that waited for a second source would have given away the
     slots it exists to win), and it is asserted rather than papered over: the ledger has
     both legs, the row has the one it decided on, and a later reconciliation can join
     them on the mint. */
  const ledgerRecord = feed.record(mint);
  ok("the feed's ledger holds both legs", ledgerRecord.sources.length === 2,
    ledgerRecord.sources.map((s) => s.source).join(" then "));
  ok("the row carries the leg the decision was actually taken on",
    rows[0].notice.sources.length === 1 && rows[0].notice.firstSource === "logs-a",
    `row leg [${rows[0].notice.sources.map((s) => s.source).join(", ")}] vs ledger `
    + `[${ledgerRecord.sources.map((s) => s.source).join(", ")}]`);
  ok("the wired lane produced a ceiling", BigInt(rows[0].ceiling.maxQuoteInRaw) > 0n,
    `baseOut ${rows[0].ceiling.baseOutRaw} for at most ${rows[0].ceiling.maxQuoteInRaw} lamports`);
  ok("the wired lane still signed nothing",
    lane.stats().signed === 0 && encoderCalls.buyIx + encoderCalls.buildBuy + encoderCalls.sellIx === 0,
    `encoders ${JSON.stringify(encoderCalls)}`);
}

section("11. THE SAME INPUT REPLAYS TO BYTE-IDENTICAL DECISIONS");

{
  /* SOMEBODY ELSE BUYS. The curve is moved by the real constant-product arithmetic rather
     than by nudging one field, so the marks that follow are the marks a chain would have
     produced — and a mark that did not move would mean the ruler is reading a constant. */
  const afterBuy = (state, lamports) => {
    const q = constantProductExactIn({
      vBase: BigInt(state.vBaseRaw), vQuote: BigInt(state.vQuoteRaw), quoteInRaw: BigInt(lamports), feeBps: 0,
    });
    return {
      ...state,
      vBaseRaw: String(q.vBaseAfterRaw),
      vQuoteRaw: String(q.vQuoteAfterRaw),
      realBaseRaw: String(BigInt(state.realBaseRaw) - q.baseOutRaw),
      realQuoteRaw: String(BigInt(state.realQuoteRaw) + q.quoteInAfterFeeRaw),
    };
  };

  const run = async () => {
    const clock = makeClock(NOW0);
    let state = HEALTHY_CURVE;
    const accounts = () => [curveAccount(state), {}, mintAccount()];
    const lane = createSnipeLane({
      venue: FAKE_VENUE, control: OK_CONTROL, clock, state: {},
      cfg: { lane: "observe", forwardSamples: 2 },
      book: { deployedTodaySol: 0, attempts: {} },
      readers: makeReaders([
        { id: "a", slot: 446_023_120, accounts },
        { id: "b", slot: 446_023_120, accounts },
      ]),
    });
    for (const n of [51, 52]) await lane.handleNotice(noticeRecord(keyFor(n), { firstSlot: 446_023_116 }));
    state = afterBuy(state, 2_000_000_000);    // somebody follows, so the marks move
    await lane.tick();
    state = afterBuy(state, 2_000_000_000);
    await lane.tick();
    return { rows: lane.rows(), stats: lane.stats() };
  };

  const first = await run();
  const second = await run();
  const a = JSON.stringify(first.rows, jsonSafe);
  const b = JSON.stringify(second.rows, jsonSafe);
  ok("two independent runs over the same input produce byte-identical rows", a === b,
    `${a.length} bytes each; first divergence at ${a === b ? "none" : [...a].findIndex((ch, i) => ch !== b[i])}`);
  ok("…and identical counters", JSON.stringify(first.stats) === JSON.stringify(second.stats),
    `cleared ${first.stats.cleared}, forward samples ${first.stats.forwardSamples}, ticks ${first.stats.ticks}`);
  ok("the replayed run recorded both mints with a forward path",
    first.rows.length === 2 && first.rows.every((r) => r.forward.length >= 1),
    first.rows.map((r) => `${r.mint.slice(0, 6)}…:${r.forward.length}`).join(", "));
  ok("the forward marks moved when the reserve moved — the ruler is not frozen",
    first.rows[0].forward[0].markX !== first.rows[0].forward[1].markX,
    `markX ${first.rows[0].forward.map((f) => f.markX.toFixed(6)).join(" -> ")}`);

  /* The shadow recorder itself must not mutate a row a consumer is holding. */
  const shadow = createSnipeShadow({ capacity: 4 });
  const held = shadow.record({ mint: keyFor(61), verdict: { ok: true, gate: null, detail: {}, trace: [] } });
  shadow.observe(keyFor(61), { markX: 1.5, realQuoteRaw: "12" });
  ok("a recorded row handed to a consumer never changes under them",
    held.forward.length === 0 && shadow.row(keyFor(61)).forward.length === 1,
    `held ${held.forward.length} vs book ${shadow.row(keyFor(61)).forward.length}`);
  ok("the recorder is bounded and counts what it evicted", (() => {
    for (const n of [62, 63, 64, 65, 66]) shadow.record({ mint: keyFor(n), verdict: { ok: false, gate: "lane_off", detail: {}, trace: [] } });
    return shadow.stats().held === 4 && shadow.stats().evicted === 2;
  })(), JSON.stringify(shadow.stats()));
}

section("12. THE LANE MODES AND THE STATS SURFACE");

{
  ok("the lane admits exactly three mode names", SNIPE_LANE_MODES.join(",") === "off,observe,execute",
    SNIPE_LANE_MODES.join(", "));
  const lane = laneFor();
  await lane.handleNotice(noticeRecord(keyFor(71)));
  const s = lane.stats();
  ok("the stats name the venue, the endpoints and the mode",
    s.venue === "fake-curve" && s.endpoints.length === 2 && s.mode === "observe",
    `${s.mode} on ${s.venue} over [${s.endpoints.join(", ")}]`);
  ok("the stats count the gates the lane runs", s.gates === SNIPE_GATES.length, `${s.gates} gates`);
  let threw = null;
  try { await lane.start(); } catch (error) { threw = error; }
  ok("start() without a feed is refused rather than silently idling",
    threw instanceof SnipeLaneError && threw.clause === "feed_missing", `clause ${threw?.clause}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
