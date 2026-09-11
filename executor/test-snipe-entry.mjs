/**
 * THE t=0 GATE, DRIVEN FROM BOTH DIRECTIONS.
 *
 * A gate list is easy to make green. Refuse everything and every hostile case passes its
 * assertion; the suite goes green and the lane never enters a launch in its life. So this
 * file asserts three separable things, and the third is the one that catches that:
 *
 *  1. EVERY GATE CAN SAY NO, BY NAME. One hostile fact per gate, twenty-two of them, each
 *     asserted to refuse at exactly its own code — not merely "some refusal happened".
 *     A gate that fired under a neighbour's name would be reported as the wrong fact in
 *     every log line and every shadow row it ever wrote.
 *
 *  2. EVERY GATE CAN SAY YES. The clean launch — built from three REAL pump.fun mints read
 *     off mainnet this pass (see below) and the standard curve shape
 *     test-pumpfun-curve.mjs already pins — clears all twenty-two.
 *
 *  3. THE STACK AS A WHOLE ADMITS SOME LAUNCHES AND REFUSES OTHERS. 240 synthetic launches
 *     from a seeded generator go through the full stack and the hit rate is asserted to be
 *     strictly inside the open band (10%, 95%), with at least four DIFFERENT gates doing
 *     the refusing and none of them accounting for four fifths of the funnel. That
 *     is the assertion a too-tight gate fails: "refuses everything" and "works" are
 *     indistinguishable from any single hostile case, and only a population tells them
 *     apart. The per-gate table is printed, so a gate that has quietly become the whole
 *     funnel is visible rather than inferred.
 *
 * AND THE PARITY ASSERTION. The entry ceiling's whole claim is that it is TIGHTER than a
 * slippage tolerance — so the claim is checked as an inequality against the repo's own
 * tolerance arithmetic (`jupiter.mjs:570`: minOut = quotedOut * (10_000 - slippageBps) /
 * 10_000) over 240 random reserve states, at the live 300 bps, and again at 0 bps where
 * the two are directly comparable. The test also proves the comparison is not vacuous by
 * showing a deliberately loosened ceiling FAILS it.
 *
 * MEASURED AGAINST MAINNET THIS PASS, free read-only getAccountInfo, no key, no send:
 *   9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump  classic SPL  mint/freeze authority null  6dp  ext []
 *   FgJReZeYfmKZeWrCaGYL8gLnUixwBhjdHuRknC6ypump  Token-2022   mint/freeze authority null  6dp  ext [metadataPointer, tokenMetadata]
 *   HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump  Token-2022   mint/freeze authority null  6dp  ext [metadataPointer, tokenMetadata]
 * Both extensions are inside the allowlist and both authorities are already renounced, so
 * the kill set does NOT refuse an ordinary pump.fun mint. That is the ruler validated
 * against a case whose answer was not known in advance — and it is why the clean fixture
 * below carries those exact facts rather than invented ones. UNVERIFIED, and said out
 * loud: whether a mint reads this way AT t=0, one slot after the create, is something
 * only the observe log can answer.
 *
 * NOTHING HERE SIGNS, SENDS, LOADS A KEY OR TOUCHES THE NETWORK. The venue adapter is a
 * FIXTURE whose "instruction layout" is two little-endian u64s this file invents for the
 * round trip; it is not any real venue's layout, it is labelled as such in its own
 * layoutProof.provedBy, and the source-text assertions at the end check that no such
 * fixture leaked into the module under test.
 *
 *   node executor/test-snipe-entry.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import {
  constantProductExactIn, constantProductExactOut, constantProductSellExactIn,
  snipeCurveState, snipeFloor,
} from "./snipe-curve.mjs";
import { MAX_GROSS_RENT_LAMPORTS } from "./network-fee-budget.mjs";
import {
  SNIPE_ENTRY_VERSION, SNIPE_GATES, SNIPE_GATE_COST, SNIPE_PROXY_GATES,
  SNIPE_ALLOWED_EXTENSIONS, SNIPE_MINT_KILL_FLAGS, SnipeEntryRefusal,
  snipeContract, planSnipeCeiling, assertSnipeInstruction, jupiterEquivalentWorstCost,
} from "./snipe-entry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const readRepo = (p) => fs.readFileSync(path.join(repo, p), "utf8");

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass += 1; };
const f = (n, d = 4) => (n === null || n === undefined ? "null" : Number(n).toFixed(d));

/* ════ FIXTURES ═══════════════════════════════════════════════════════════════════════ */

const SOL = 1_000_000_000n;                       // lamports per SOL
const TOK = 1_000_000n;                           // a 6-decimal token's base units
const MINT = "FgJReZeYfmKZeWrCaGYL8gLnUixwBhjdHuRknC6ypump";     // real, read above
const CREATOR = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";    // pump.fun bonding curve
const OTHER_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

/* The standard pump.fun curve shape test-pumpfun-curve.mjs pins: 30 virtual SOL against
   1,073,000,000 tokens with 793,100,000 real ones left, which that file's hand-worked
   fixture prices at 85.005 SOL to graduate. A 1% venue fee — NOT a verified rate, and it
   does not need to be: every arithmetic assertion below holds for any fee the adapter
   reports, and no number in this file depends on 100 bps being pump.fun's real fee. */
const STANDARD_CURVE = Object.freeze({
  kind: "bonding-curve", curveType: "standard", creator: CREATOR, complete: false,
  feeBps: 100,
  vQuoteRaw: 30n * SOL, vBaseRaw: 1_073_000_000n * TOK,
  realQuoteRaw: 0n, realBaseRaw: 793_100_000n * TOK,
});

/* THE LIVE RAILS, verbatim from poller.mjs LIVE_LIMITS (:154-205) and strategy.mjs
   DEFAULTS (:131-134). Every derived number printed below follows from these; if one
   moves, the printed values move and the assertions that name them fail loudly. */
const LIVE_CFG = Object.freeze({
  lane: "observe",
  maxSolPerTrade: 0.005,
  dailySolCap: 0.01,
  minSolPerTrade: 0.005,
  maxFeeShareOfStop: 0.25,
  networkFeeReserveSol: 500_000 / 1e9,
  maxPriceImpactPct: 5,
  maxEntryRoundTripLossPct: 12,
  maxNetworkFeeLamports: 2_000_000,
  maxNetworkFeePct: 10,
  maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
  noticeMaxMs: 4_000,
});

const NOW = 1_757_000_000_000;
const NOTICE = Object.freeze({ mint: MINT, creator: CREATOR, slot: 300_100_000, noticeAt: NOW - 400, source: "logsSubscribe" });
const BOOK = Object.freeze({ snipes: [], positions: [], attempts: [], deployedTodaySol: 0 });
const CONTROL = Object.freeze({ hardStop: false, pauseEntries: false });
const FEES = Object.freeze({ signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 0 });

/* The mint, exactly as mainnet answered for FgJReZeY…pump. */
const CLEAN_MINT = Object.freeze({
  ok: true, program: "spl-token-2022", isToken2022: true, decimals: 6,
  supply: "1000000000000000", mintAuthority: null, freezeAuthority: null,
  extensions: ["metadataPointer", "tokenMetadata"],
  extensionDetail: [{ extension: "metadataPointer" }, { extension: "tokenMetadata" }],
  botRefusals: [], flags: [],
});
const mintWith = (over) => ({ ...CLEAN_MINT, ...over });

/* ── the venue adapter, a FIXTURE ─────────────────────────────────────────────────────
 * Its quoting delegates to snipe-curve.mjs so the adapter path and the built-in path are
 * the same arithmetic. Its "instruction layout" is two little-endian u64s invented here
 * for the round trip and is NOT any venue's real layout — which is the point: the module
 * under test must refuse an adapter that cannot prove one, and must do a genuine
 * bytes-out/bytes-back comparison when it can. */
const fixtureEncode = (baseOutRaw, maxQuoteInRaw) => {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(baseOutRaw, 0);
  data.writeBigUInt64LE(maxQuoteInRaw, 8);
  return { programId: PROGRAM, keys: [], data };
};
const FIXTURE_PROOF_SIGNATURE = bs58.encode(Buffer.alloc(64, 7));

function makeAdapter(over = {}) {
  const a = {
    id: "fixture-curve",
    programId: PROGRAM,
    supportsExactOut: true,
    supportedCurveTypes: ["standard", "boosted", "mini"],
    quote: { mint: WSOL, decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE },
    watch: () => { throw new Error("the fixture adapter does not stream"); },
    accountsFor: () => [],
    curveFromAccount: (data) => data,
    quoteExactIn: (curve, quoteInRaw) => constantProductExactIn({
      vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, quoteInRaw, feeBps: Number(curve.feeBps ?? 0) }),
    quoteExactOut: (curve, baseOutRaw) => constantProductExactOut({
      vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseOutRaw, feeBps: Number(curve.feeBps ?? 0) }),
    sellExactIn: (curve, baseInRaw) => constantProductSellExactIn({
      vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseInRaw, feeBps: Number(curve.feeBps ?? 0),
      realQuoteRaw: curve.realQuoteRaw ?? null }),
    buyIx: ({ baseOutRaw, maxQuoteInRaw }) => [fixtureEncode(baseOutRaw, maxQuoteInRaw)],
    sellIx: () => { throw new Error("fixture sell encoder"); },
    decodeBuyIx: (ix) => {
      const data = Buffer.isBuffer(ix?.data) ? ix.data : Buffer.from(ix?.data ?? []);
      if (data.length !== 16) throw new Error(`fixture buy instruction is ${data.length} bytes, not 16`);
      return { baseOutRaw: data.readBigUInt64LE(0), maxQuoteInRaw: data.readBigUInt64LE(8) };
    },
    exitRoute: () => ({ via: "curve", reason: "the curve is the exit until it graduates" }),
    isComplete: (curve) => curve.complete === true,
    quoteReserveLamports: (curve) => curve.realQuoteRaw ?? 0n,
    layoutVerified: false,
    ...over,
  };
  return a;
}
/* The proved variant. `provedBy` says in the record itself that this is a fixture, so a
   grep for a real proof can never turn this up as one. */
const PROVED_ADAPTER = makeAdapter({
  layoutVerified: true,
  layoutProof: {
    cluster: "mainnet-beta", programId: PROGRAM,
    provedBy: "executor/test-snipe-entry.mjs — FIXTURE LAYOUT, NOT A REAL VENUE PROOF",
    roundTrips: [
      { method: "buyIx", signature: FIXTURE_PROOF_SIGNATURE, slot: 300_100_001, instructionIndex: 0 },
      { method: "sellIx", signature: FIXTURE_PROOF_SIGNATURE, slot: 300_100_002, instructionIndex: 0 },
      { method: "decodeBuyIx", signature: FIXTURE_PROOF_SIGNATURE, slot: 300_100_003, instructionIndex: 0 },
    ],
  },
});
const UNPROVED_ADAPTER = makeAdapter();

const baseArgs = (over = {}) => ({
  notice: { ...NOTICE }, curve: { ...STANDARD_CURVE }, adapter: UNPROVED_ADAPTER,
  cfg: { ...LIVE_CFG }, book: { ...BOOK }, nowMs: NOW,
  control: { ...CONTROL }, mint: mintWith({}), creator: { shareOfSupplyPct: 0.8, priorLaunches: 0 },
  fees: { ...FEES }, instruction: null,
  ...over,
});

/* A classic 82-byte SPL mint, built by hand so the RAW limb of the kill set is exercised
   against real `auditMintAccount` bytes rather than a parsed summary. */
function classicMintBytes({ mintAuthority = null, freezeAuthority = null, decimals = 6 } = {}) {
  const data = Buffer.alloc(82);
  if (mintAuthority) { data.writeUInt32LE(1, 0); Buffer.from(bs58.decode(mintAuthority)).copy(data, 4); }
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  data[44] = decimals;
  data[45] = 1;
  if (freezeAuthority) { data.writeUInt32LE(1, 46); Buffer.from(bs58.decode(freezeAuthority)).copy(data, 50); }
  return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data };
}

/* ════ 1. THE SHAPE OF THE LIST ═══════════════════════════════════════════════════════ */

ok("SNIPE_GATES is a frozen, ordered, duplicate-free list of 22 codes", () => {
  assert.equal(Object.isFrozen(SNIPE_GATES), true, "SNIPE_GATES is not frozen");
  assert.equal(SNIPE_GATES.length, 22, `SNIPE_GATES has ${SNIPE_GATES.length} entries`);
  assert.equal(new Set(SNIPE_GATES).size, 22, "SNIPE_GATES repeats a code");
  console.log(`       ${SNIPE_GATES.join(" > ")}`);
});

ok("the cheapest check runs first: cost tiers are non-decreasing down the list", () => {
  let prev = -1;
  const shape = [];
  for (const gate of SNIPE_GATES) {
    const cost = SNIPE_GATE_COST[gate];
    assert.equal(Number.isInteger(cost), true, `${gate} has no cost tier (${cost})`);
    assert.equal(cost >= prev, true,
      `${gate} is cost ${cost} but follows a cost-${prev} gate — an RPC round trip would run before a free check`);
    shape.push(cost);
    prev = cost;
  }
  const tiers = shape.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
  console.log(`       tiers: ${Object.entries(tiers).map(([c, n]) => `cost ${c} x${n}`).join(", ")}`);
  assert.equal(shape[0], 0, `the first gate is cost ${shape[0]}, not 0`);
  assert.equal(shape[shape.length - 1], 4, `the last gate is cost ${shape[shape.length - 1]}, not 4`);
});

ok("the snipe codes are DISJOINT from the desk's frozen GATE_CLASS table (33 SAFETY / 21 JUDGMENT)", () => {
  /* Read as text, not imported: importing src/calls.js drags the desk's config and db
     into an executor test. The technique is test-entry-contract-parity.mjs's. */
  const source = readRepo("src/calls.js");
  const body = source.slice(source.indexOf("export const GATE_CLASS"), source.indexOf("export const gateClass"));
  const rows = [...body.matchAll(/^ {2}([a-z_0-9]+):\s*"(SAFETY|JUDGMENT)"/gm)].map((m) => [m[1], m[2]]);
  const safety = rows.filter(([, k]) => k === "SAFETY").map(([c]) => c);
  const judgment = rows.filter(([, k]) => k === "JUDGMENT").map(([c]) => c);
  assert.equal(safety.length, 33, `GATE_CLASS holds ${safety.length} SAFETY gates, not the measured 33 — the frozen set moved`);
  assert.equal(judgment.length, 21, `GATE_CLASS holds ${judgment.length} JUDGMENT gates, not the measured 21`);
  const known = new Set(rows.map(([c]) => c));
  const collisions = SNIPE_GATES.filter((g) => known.has(g));
  assert.deepEqual(collisions, [],
    `snipe gate(s) ${collisions.join(", ")} collide with the desk's table — a snipe refusal would re-point a desk gate`);
  /* gateClass() answers SAFETY for anything unregistered (calls.js:579), so every code
     here is SAFETY by default-deny today. That is the correct direction; wiring any of
     them as a desk-side withhold is a separate, explicit registration. */
  console.log(`       ${SNIPE_GATES.length} snipe codes, ${known.size} desk codes, 0 collisions;` +
    " every snipe code is SAFETY by gateClass()'s default-deny until registered");
});

ok("the mint allowlist is the desk's own set, derived rather than retyped", () => {
  const deskSource = readRepo("src/data/solana.js");
  const block = deskSource.slice(deskSource.indexOf("export const BOT_ALLOWED_EXTENSIONS"));
  /* Entries only — the trailing `// 6 — and ONLY when the state is "initialized"` comment
     inside that block is prose, and a looser regex swallowed it as a ninth extension. */
  const listed = [...block.slice(0, block.indexOf("]))")).matchAll(/^\s*"([a-zA-Z]+)",/gm)].map((m) => m[1]).sort();
  const mine = [...SNIPE_ALLOWED_EXTENSIONS].sort();
  assert.deepEqual(mine, listed,
    `the snipe allowlist is [${mine.join(", ")}] and the desk's BOT_ALLOWED_EXTENSIONS is [${listed.join(", ")}]`);
  assert.equal(mine.length, 8, `the allowlist holds ${mine.length} extensions`);
  console.log(`       ${mine.length} extensions, identical in both files: ${mine.join(", ")}`);
  for (const flag of ["mint_authority_live", "freeze_authority_live", "ext_transferHook", "ext_permanentDelegate"])
    assert.equal(SNIPE_MINT_KILL_FLAGS.includes(flag), true, `${flag} is not in the declared kill set`);
});

/* ════ 2. THE DERIVED FLOOR, PRINTED ══════════════════════════════════════════════════ */

ok("at the live cap the derived floor is stopFrac 0.8000 / floorMarkX 0.2000 and the ticket is exactly fundable", () => {
  const floor = snipeFloor({ cfg: LIVE_CFG, sol: LIVE_CFG.maxSolPerTrade });
  console.log(`       0.005 SOL -> stopFrac ${f(floor.stopFrac, 6)} · floorMarkX ${f(floor.floorMarkX, 6)} · ` +
    `minViableSol ${f(floor.minViableSol, 6)}`);
  assert.equal(f(floor.stopFrac, 6), "0.800000", `stopFrac came back ${floor.stopFrac}`);
  assert.equal(f(floor.floorMarkX, 6), "0.200000", `floorMarkX came back ${floor.floorMarkX}`);
  assert.equal(floor.minViableSol <= LIVE_CFG.maxSolPerTrade + 1e-12, true,
    `minViableSol ${floor.minViableSol} exceeds the ${LIVE_CFG.maxSolPerTrade} SOL cap`);
  const tighter = snipeFloor({ cfg: LIVE_CFG, sol: 0.004 });
  assert.equal(tighter.minViableSol > 0.004, true,
    `a 0.004 SOL ticket reported minViableSol ${tighter.minViableSol}, which would make the stop gate vacuous`);
  console.log(`       0.004 SOL -> minViableSol ${f(tighter.minViableSol, 6)} (NOT fundable — gate stop_floor)`);
});

/* ════ 3. THE CLEAN LAUNCH CLEARS EVERY GATE ══════════════════════════════════════════ */

ok("a clean launch clears all 22 gates, and the trace names every one", () => {
  const v = snipeContract(baseArgs());
  assert.equal(v.ok, true, `the clean launch was refused at ${v.gate}: ${v.detail.message}`);
  assert.equal(v.gate, null, `gate came back ${v.gate}`);
  assert.equal(v.trace.length, 22, `the trace holds ${v.trace.length} steps`);
  assert.deepEqual(v.trace.map((s) => s.gate), [...SNIPE_GATES], "the trace ran the gates out of order");
  assert.equal(v.trace.every((s) => s.ok), true, "a step in a passing trace is not ok");
  console.log(`       ${v.detail.mint.slice(0, 8)}… buys ${v.detail.baseOutRaw} base units for at most ` +
    `${v.detail.maxQuoteInRaw} lamports · impact ${f(v.detail.impactPct)}% · round trip ` +
    `${f(v.detail.roundTripLossPct)}% · launch share ${f(v.detail.launchSharePct)}% · halvings ${v.detail.halvings}`);
  assert.equal(v.detail.maxQuoteInRaw <= 5_000_000n, true,
    `the ceiling ${v.detail.maxQuoteInRaw} exceeds the 5,000,000 lamport ticket`);
  assert.equal(v.detail.halvings, 0, `the clean launch needed ${v.detail.halvings} halvings`);
  assert.equal(Object.isFrozen(v), true, "the verdict is not frozen");
});

ok("the clean launch also clears the last gate with real bytes to decode back", () => {
  const planned = snipeContract(baseArgs({ adapter: PROVED_ADAPTER }));
  const ix = fixtureEncode(planned.detail.baseOutRaw, planned.detail.maxQuoteInRaw);
  const v = snipeContract(baseArgs({ adapter: PROVED_ADAPTER, instruction: ix }));
  assert.equal(v.ok, true, `refused at ${v.gate}: ${v.detail.message}`);
  assert.equal(v.detail.instruction.baseOutRaw, planned.detail.baseOutRaw,
    `the decoded quantity is ${v.detail.instruction.baseOutRaw}`);
  assert.equal(v.detail.instruction.maxQuoteInRaw, planned.detail.maxQuoteInRaw,
    `the decoded ceiling is ${v.detail.instruction.maxQuoteInRaw}`);
  console.log(`       bytes out and back: ${v.detail.instruction.baseOutRaw} base units, ` +
    `${v.detail.instruction.maxQuoteInRaw} lamports, program ${v.detail.instruction.programId.slice(0, 8)}…`);
});

/* ════ 4. EVERY GATE REFUSES ITS OWN HOSTILE FACT, BY NAME ════════════════════════════ */

/* Each row is a fact that is hostile in exactly one way. The expected gate is written
   down BEFORE the run, and the assertion names the gate that actually answered. */
const HOSTILE = [
  ["lane_off", "the lane switch is off", { cfg: { ...LIVE_CFG, lane: "off" } }],
  ["venue_not_enabled", "the adapter cannot state an absolute max cost",
    { adapter: makeAdapter({ supportsExactOut: false }) }],
  ["hard_stop", "the HARD STOP sentinel is present", { control: { hardStop: true, pauseEntries: false } }],
  ["pause_entries", "the PAUSE ENTRIES sentinel is present", { control: { hardStop: false, pauseEntries: true } }],
  ["daily_capacity", "the day has 0.002 SOL left and the ticket is 0.005",
    { book: { ...BOOK, deployedTodaySol: 0.008 } }],
  ["notice_stale", "the notice is 10s old against a 4s bound", { notice: { ...NOTICE, noticeAt: NOW - 10_000 } }],
  ["already_holding", "the mint is already in the snipe book", { book: { ...BOOK, snipes: [{ mint: MINT }] } }],
  ["already_attempted", "an attempt for this mint exists in the window",
    { book: { ...BOOK, attempts: new Set([MINT]) } }],
  ["curve_unreadable", "the curve account did not decode", { curve: { vBaseRaw: "not-an-integer", vQuoteRaw: 1n } }],
  ["curve_type_unsupported", "the REAL quote reserve is unknown, so the mark is an upper bound",
    { curve: { ...STANDARD_CURVE, realQuoteRaw: null } }],
  ["curve_already_complete", "the curve has already graduated", { curve: { ...STANDARD_CURVE, complete: true } }],
  ["exit_route_unimplemented", "the venue names no executable route out",
    { adapter: makeAdapter({ exitRoute: () => ({ via: "none", reason: "no verified sell layout" }) }) }],
  ["mint_refused", "a live freeze authority could brick the exit",
    { mint: mintWith({ freezeAuthority: CREATOR }) }],
  ["impact_over_cap", "a 0.005 SOL ticket moves a 0.001 SOL curve at every rung",
    { curve: { ...STANDARD_CURVE, vQuoteRaw: SOL / 1_000n, vBaseRaw: 1_000_000n * TOK,
      realBaseRaw: 700_000n * TOK, realQuoteRaw: 0n, feeBps: 0 } }],
  ["round_trip_over_cap", "a 7% venue fee costs more than 12% round trip",
    { curve: { ...STANDARD_CURVE, feeBps: 700 } }],
  ["stop_floor", "a 0.004 SOL ticket cannot fund the stop the fee rail implies",
    { cfg: { ...LIVE_CFG, maxSolPerTrade: 0.004 } }],
  ["size_under_minimum", "the ladder had to halve below the minimum viable size",
    { curve: { ...STANDARD_CURVE, vQuoteRaw: 75n * SOL / 1_000n, vBaseRaw: 1_000_000n * TOK,
      realBaseRaw: 700_000n * TOK, realQuoteRaw: 0n, feeBps: 0 } }],
  ["creator_profile", "the deployer holds 40% of supply against a 5% bar",
    { cfg: { ...LIVE_CFG, maxCreatorSharePct: 5 }, creator: { shareOfSupplyPct: 40, priorLaunches: 0 } }],
  ["launch_share", "two thirds of the opening quote is already bought, against a 10% bar",
    { cfg: { ...LIVE_CFG, maxLaunchSharePct: 10 },
      curve: { ...STANDARD_CURVE, vQuoteRaw: 50n * SOL, realQuoteRaw: 20n * SOL } }],
  ["network_fee_over_cap", "605,000 lamports of fees on a ~5,000,000 lamport basis is over 10%",
    { fees: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 600_000, rentFeeLamports: 0 } }],
  ["rent_over_cap", "5,000,000 lamports of rent exceeds the 4,200,000 ceiling",
    { fees: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 5_000_000 } }],
  ["instruction_mismatch", "the venue's layout is not proved, so nothing may be encoded",
    { instruction: fixtureEncode(1n, 1n) }],
];

ok(`each of the ${HOSTILE.length} hostile facts is refused at its OWN gate`, () => {
  const fired = new Set();
  for (const [gate, why, over] of HOSTILE) {
    const v = snipeContract(baseArgs(over));
    assert.equal(v.ok, false, `${gate}: the hostile launch (${why}) PASSED every gate`);
    assert.equal(v.gate, gate,
      `expected gate ${gate} for "${why}" but the stack answered ${v.gate}: ${v.detail.message}`);
    assert.equal(v.trace[v.trace.length - 1].gate, gate, `the trace ends at ${v.trace[v.trace.length - 1].gate}`);
    assert.equal(v.trace.slice(0, -1).every((s) => s.ok), true, `a gate before ${gate} also failed`);
    fired.add(gate);
    console.log(`       ${gate.padEnd(24)} ${v.detail.message.slice(0, 96)}`);
  }
  assert.equal(fired.size, SNIPE_GATES.length,
    `only ${fired.size} of ${SNIPE_GATES.length} gates were exercised; never fired: ` +
    SNIPE_GATES.filter((g) => !fired.has(g)).join(", "));
});

ok("the kill set reads the RAW mint account too, through the executor's own auditMintAccount", () => {
  const clean = snipeContract(baseArgs({ mint: classicMintBytes() }));
  assert.equal(clean.ok, true, `a clean classic mint was refused at ${clean.gate}: ${clean.detail.message}`);
  const frozen = snipeContract(baseArgs({ mint: classicMintBytes({ freezeAuthority: CREATOR }) }));
  assert.equal(frozen.gate, "mint_refused", `a live freeze authority answered ${frozen.gate}`);
  assert.equal(frozen.detail.source, "auditMintAccount", `the refusal came from ${frozen.detail.source}`);
  const inflatable = snipeContract(baseArgs({ mint: classicMintBytes({ mintAuthority: CREATOR }) }));
  assert.equal(inflatable.gate, "mint_refused", `a live mint authority answered ${inflatable.gate}`);
  assert.equal(inflatable.detail.flag, "mint_authority_live", `flagged ${inflatable.detail.flag}`);
  const missing = snipeContract(baseArgs({ mint: null }));
  assert.equal(missing.gate, "mint_refused", `an unread mint answered ${missing.gate}`);
  /* A malformed ticket names its own fact rather than surfacing four gates later as an
     internal-invariant message. */
  const badTicket = snipeContract(baseArgs({ cfg: { ...LIVE_CFG, maxSolPerTrade: "many" } }));
  assert.equal(badTicket.gate, "daily_capacity", `a malformed ticket size answered ${badTicket.gate}`);
  assert.match(badTicket.detail.message, /not a usable ticket size/, badTicket.detail.message);
  console.log(`       raw bytes: clean PASS · freeze authority ${frozen.detail.flag ?? "refused"} · ` +
    `mint authority ${inflatable.detail.flag} · unread mint refused (unverified is not safe)`);
});

ok("every hostile EXTENSION in the desk's vocabulary is refused under ext_<name>", () => {
  for (const ext of ["transferHook", "permanentDelegate", "transferFeeConfig", "nonTransferable", "pausable", "scaledUiAmount"]) {
    const v = snipeContract(baseArgs({ mint: mintWith({
      extensions: ["metadataPointer", ext], extensionDetail: [{ extension: "metadataPointer" }, { extension: ext }] }) }));
    assert.equal(v.gate, "mint_refused", `${ext} answered ${v.gate}`);
    assert.equal(v.detail.flag, `ext_${ext}`, `${ext} was flagged ${v.detail.flag}`);
  }
  /* The desk's measured FALSE POSITIVE, inherited rather than re-introduced: the presence
     of defaultAccountState is not the hazard, a default state other than "initialized" is. */
  const initialised = snipeContract(baseArgs({ mint: mintWith({
    extensions: ["defaultAccountState"],
    extensionDetail: [{ extension: "defaultAccountState", state: { accountState: "initialized" } }] }) }));
  assert.equal(initialised.ok, true,
    `a defaultAccountState of "initialized" was refused at ${initialised.gate}: ${initialised.detail.message}`);
  const frozenByDefault = snipeContract(baseArgs({ mint: mintWith({
    extensions: ["defaultAccountState"],
    extensionDetail: [{ extension: "defaultAccountState", state: { accountState: "frozen" } }] }) }));
  assert.equal(frozenByDefault.gate, "mint_refused", `frozen-by-default answered ${frozenByDefault.gate}`);
  assert.equal(frozenByDefault.detail.flag, "ext_defaultAccountState", `flagged ${frozenByDefault.detail.flag}`);
  console.log("       6 hazardous extensions refused by name; defaultAccountState refused only when the state is not \"initialized\"");
});

ok("the two proxy gates MEASURE on every notice and kill only when a threshold is set", () => {
  const noThreshold = snipeContract(baseArgs({ creator: { shareOfSupplyPct: 92, priorLaunches: 14 } }));
  assert.equal(noThreshold.ok, true,
    `a 92%-holding deployer was refused with no threshold configured (${noThreshold.gate})`);
  assert.equal(noThreshold.detail.measured.creator_profile, 92,
    `the measurement was recorded as ${noThreshold.detail.measured.creator_profile}`);
  assert.equal(noThreshold.detail.measured.launch_share, 0,
    `launch share was recorded as ${noThreshold.detail.measured.launch_share}`);
  /* A threshold with nothing to judge is a refusal, not a pass: unverified is not safe. */
  const unmeasured = snipeContract(baseArgs({ cfg: { ...LIVE_CFG, maxCreatorSharePct: 5 }, creator: {} }));
  assert.equal(unmeasured.gate, "creator_profile", `an unmeasured, thresholded proxy answered ${unmeasured.gate}`);
  const priorLaunches = snipeContract(baseArgs({
    cfg: { ...LIVE_CFG, maxCreatorPriorLaunches: 2 }, creator: { shareOfSupplyPct: 1, priorLaunches: 9 } }));
  assert.equal(priorLaunches.gate, "creator_profile", `9 prior launches against a bar of 2 answered ${priorLaunches.gate}`);
  assert.deepEqual([...SNIPE_PROXY_GATES], ["creator_profile", "launch_share"],
    `the declared proxy gates are ${SNIPE_PROXY_GATES.join(", ")}`);
  console.log("       measured always, killing never — until an operator sets a bar the scorecard has justified");
});

/* ════ 5. THE CEILING IS NEVER LOOSER THAN A SLIPPAGE TOLERANCE ═══════════════════════ */

/* A seeded LCG. Deterministic, so a failure is reproducible and the "random" states are
   the same 240 states on every machine. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 4_294_967_296; };
}

ok("PARITY: the entry ceiling is never looser than Jupiter's own worst admissible cost (240 states)", () => {
  const rnd = lcg(20260911);
  let checked = 0; let worstRatio = 0; let tightestHeadroom = Infinity;
  for (let i = 0; i < 240; i += 1) {
    const vQuote = BigInt(Math.floor(1 + rnd() * 60_000)) * (SOL / 1_000n);   // 0.001 .. 60 SOL
    const vBase = BigInt(Math.floor(1_000 + rnd() * 1_073_000_000)) * TOK;
    const realBase = (vBase * BigInt(Math.floor(rnd() * 74))) / 100n;
    const feeBps = Math.floor(rnd() * 200);
    const state = snipeCurveState({ vQuoteRaw: vQuote, vBaseRaw: vBase, realQuoteRaw: 0n, realBaseRaw: realBase, feeBps });
    const plan = planSnipeCeiling({ curve: state, adapter: PROVED_ADAPTER, solLamports: 5_000_000n,
      cfg: { ...LIVE_CFG, maxPriceImpactPct: 1e9, maxEntryRoundTripLossPct: 1e9 } });
    if (!plan.deliverable) continue;
    checked += 1;

    /* Jupiter's envelope at the LIVE 300 bps, and at 0 bps where the two are directly
       comparable (minOut = quotedOut, so the worst cost IS the whole spend). */
    const live = jupiterEquivalentWorstCost({ amountRaw: plan.spendLamports,
      quotedOutRaw: plan.baseOutRaw, slippageBps: 300, baseOutRaw: plan.baseOutRaw });
    const zero = jupiterEquivalentWorstCost({ amountRaw: plan.spendLamports,
      quotedOutRaw: plan.baseOutRaw, slippageBps: 0, baseOutRaw: plan.baseOutRaw });
    assert.equal(zero.worstCostLamports, plan.spendLamports,
      `at 0 bps Jupiter's worst cost should be the whole spend ${plan.spendLamports}, got ${zero.worstCostLamports}`);
    assert.equal(plan.maxQuoteInRaw <= live.worstCostLamports, true,
      `state #${i}: our ceiling ${plan.maxQuoteInRaw} EXCEEDS Jupiter's 300bps worst cost ${live.worstCostLamports}`);
    assert.equal(plan.maxQuoteInRaw <= zero.worstCostLamports, true,
      `state #${i}: our ceiling ${plan.maxQuoteInRaw} EXCEEDS the spend ${zero.worstCostLamports} at 0 bps`);
    const ratio = Number(plan.maxQuoteInRaw) / Number(live.worstCostLamports);
    if (ratio > worstRatio) worstRatio = ratio;
    tightestHeadroom = Math.min(tightestHeadroom, Number(live.worstCostLamports - plan.maxQuoteInRaw));
  }
  assert.equal(checked >= 200, true, `only ${checked} of 240 states produced a deliverable plan`);
  console.log(`       ${checked} states · our ceiling is at most ${f(worstRatio * 100, 4)}% of Jupiter's 300bps worst cost` +
    ` · tightest margin ${tightestHeadroom} lamports`);
  assert.equal(worstRatio < 1, true, `the ceiling reached ${f(worstRatio * 100, 4)}% of the tolerance's worst cost`);
});

ok("the parity assertion is not vacuous: a loosened ceiling FAILS it", () => {
  const state = snipeCurveState(STANDARD_CURVE);
  const plan = planSnipeCeiling({ curve: state, adapter: PROVED_ADAPTER, solLamports: 5_000_000n, cfg: LIVE_CFG });
  const zero = jupiterEquivalentWorstCost({ amountRaw: plan.spendLamports,
    quotedOutRaw: plan.baseOutRaw, slippageBps: 0, baseOutRaw: plan.baseOutRaw });
  const loosened = (plan.maxQuoteInRaw * 10_300n) / 10_000n;     // the "just add 3% slippage" ceiling
  assert.equal(loosened > zero.worstCostLamports, true,
    `a 3%-loosened ceiling ${loosened} did NOT exceed ${zero.worstCostLamports}, so the parity test proves nothing`);
  console.log(`       real ceiling ${plan.maxQuoteInRaw} <= ${zero.worstCostLamports}; ` +
    `+3% "tolerance" ceiling ${loosened} > ${zero.worstCostLamports} — the inequality can fail`);
});

ok("planSnipeCeiling reads NO slippage term, and refuses a tolerance outright", () => {
  const state = snipeCurveState(STANDARD_CURVE);
  const at = (slippageBps) => planSnipeCeiling({ curve: state, adapter: PROVED_ADAPTER,
    solLamports: 5_000_000n, cfg: { ...LIVE_CFG, slippageBps } });
  const a = at(0); const b = at(300); const c = at(5_000);
  assert.equal(a.maxQuoteInRaw, b.maxQuoteInRaw, `0 bps gave ${a.maxQuoteInRaw}, 300 bps gave ${b.maxQuoteInRaw}`);
  assert.equal(b.maxQuoteInRaw, c.maxQuoteInRaw, `300 bps gave ${b.maxQuoteInRaw}, 5000 bps gave ${c.maxQuoteInRaw}`);
  assert.equal(a.baseOutRaw, c.baseOutRaw, `the quantity moved with slippage: ${a.baseOutRaw} vs ${c.baseOutRaw}`);
  assert.throws(() => planSnipeCeiling({ curve: state, adapter: PROVED_ADAPTER, solLamports: 5_000_000n,
    cfg: LIVE_CFG, tolerance: 100 }), /a ceiling is not a slippage tolerance/,
  "planSnipeCeiling accepted a tolerance");
  console.log(`       ceiling ${b.maxQuoteInRaw} lamports at 0, 300 and 5000 bps alike; a tolerance argument throws`);
});

/* ════ 6. THE INSTRUCTION ROUND TRIP ══════════════════════════════════════════════════ */

ok("assertSnipeInstruction REFUSES every unproved venue — and says why", () => {
  const ix = fixtureEncode(1_000n, 2_000n);
  const expected = { baseOutRaw: 1_000n, maxQuoteInRaw: 2_000n };
  const cases = [
    ["layout_unverified", UNPROVED_ADAPTER],
    ["layout_proof_missing", makeAdapter({ layoutVerified: true })],
    ["layout_proof_cluster", makeAdapter({ layoutVerified: true,
      layoutProof: { ...PROVED_ADAPTER.layoutProof, cluster: "devnet" } })],
    ["layout_proof_program_mismatch", makeAdapter({ layoutVerified: true,
      layoutProof: { ...PROVED_ADAPTER.layoutProof, programId: OTHER_PROGRAM } })],
    ["layout_proof_incomplete", makeAdapter({ layoutVerified: true,
      layoutProof: { ...PROVED_ADAPTER.layoutProof, roundTrips: PROVED_ADAPTER.layoutProof.roundTrips.slice(0, 1) } })],
  ];
  for (const [clause, adapter] of cases) {
    let thrown = null;
    try { assertSnipeInstruction(ix, expected, adapter); } catch (error) { thrown = error; }
    assert.notEqual(thrown, null, `${clause}: the unproved adapter was ACCEPTED`);
    assert.equal(thrown instanceof SnipeEntryRefusal, true, `${clause}: threw ${thrown?.name}`);
    assert.equal(thrown.gate, "instruction_mismatch", `${clause}: gate ${thrown.gate}`);
    assert.equal(thrown.detail.clause, clause, `expected clause ${clause}, got ${thrown.detail.clause}`);
  }
  console.log(`       ${cases.length} unproved-layout shapes refused: ${cases.map(([c]) => c).join(", ")}`);
});

ok("assertSnipeInstruction decodes our own bytes back and refuses any drift", () => {
  const expected = { baseOutRaw: 176_740_000_000n, maxQuoteInRaw: 4_999_999n };
  const good = assertSnipeInstruction(fixtureEncode(expected.baseOutRaw, expected.maxQuoteInRaw), expected, PROVED_ADAPTER);
  assert.equal(good.baseOutRaw, expected.baseOutRaw, `decoded ${good.baseOutRaw}`);
  assert.equal(good.maxQuoteInRaw, expected.maxQuoteInRaw, `decoded ${good.maxQuoteInRaw}`);
  assert.equal(Object.isFrozen(good), true, "the accepted record is not frozen");

  assert.throws(() => assertSnipeInstruction(fixtureEncode(expected.baseOutRaw + 1n, expected.maxQuoteInRaw),
    expected, PROVED_ADAPTER), /encoded quantity is 176740000001 base units/, "a quantity drift was accepted");
  assert.throws(() => assertSnipeInstruction(fixtureEncode(expected.baseOutRaw, expected.maxQuoteInRaw + 1n),
    expected, PROVED_ADAPTER), /encoded ceiling is 5000000 lamports/, "a ceiling drift was accepted");
  assert.throws(() => assertSnipeInstruction({ ...fixtureEncode(expected.baseOutRaw, expected.maxQuoteInRaw),
    programId: OTHER_PROGRAM }, expected, PROVED_ADAPTER), /targets program/, "a foreign program was accepted");
  assert.throws(() => assertSnipeInstruction(fixtureEncode(expected.baseOutRaw, expected.maxQuoteInRaw),
    { ...expected, slippageBps: 300 }, PROVED_ADAPTER), /a ceiling is not a tolerance/,
  "a slippage term in the envelope was accepted");
  console.log(`       one raw unit of drift in either number is a refusal (${expected.baseOutRaw} / ${expected.maxQuoteInRaw})`);
});

ok("in EXECUTE mode an entry with no bytes to check is refused", () => {
  const v = snipeContract(baseArgs({ adapter: PROVED_ADAPTER, cfg: { ...LIVE_CFG, lane: "execute" }, instruction: null }));
  assert.equal(v.gate, "instruction_mismatch", `execute with no instruction answered ${v.gate}`);
  /* …and in execute mode an UNPROVED venue is refused far earlier, at the venue contract. */
  const unproved = snipeContract(baseArgs({ cfg: { ...LIVE_CFG, lane: "execute" } }));
  assert.equal(unproved.gate, "venue_not_enabled", `execute on an unproved venue answered ${unproved.gate}`);
  assert.equal(unproved.detail.clause, "layout_unverified", `clause ${unproved.detail.clause}`);
  console.log(`       execute: unproved venue -> venue_not_enabled/${unproved.detail.clause}; ` +
    "proved venue with no bytes -> instruction_mismatch");
});

/* ════ 7. THE HIT RATE — IS THIS GATE A FUNNEL OR A WALL? ═════════════════════════════ */

ok("HIT RATE: over 240 synthetic launches the stack admits some and refuses others", () => {
  const rnd = lcg(20260912);
  const counts = new Map();
  let passed = 0; const total = 240;
  for (let i = 0; i < total; i += 1) {
    /* A spread of launches, not a spread of disasters: reserves, fees, notice age, mint
       facts and deployer profile all move, and roughly a third of the rows carry one
       hostile fact. Nothing here is tuned to a target rate — the generator was written
       before the rate was read, and the rate is asserted only to be strictly inside the
       open interval. */
    const hostile = rnd();
    const vQuote = BigInt(Math.floor(5_000 + rnd() * 60_000)) * (SOL / 1_000n);   // 5 .. 65 SOL
    const vBase = BigInt(Math.floor(500_000_000 + rnd() * 600_000_000)) * TOK;
    const realBase = (vBase * BigInt(Math.floor(20 + rnd() * 54))) / 100n;
    const realQuote = (vQuote * BigInt(Math.floor(rnd() * 40))) / 100n;
    const curve = { kind: "bonding-curve", curveType: "standard", creator: CREATOR,
      complete: hostile < 0.04, feeBps: Math.floor(rnd() * 120),
      vQuoteRaw: vQuote, vBaseRaw: vBase, realQuoteRaw: realQuote, realBaseRaw: realBase };
    const over = {
      curve,
      notice: { ...NOTICE, noticeAt: NOW - Math.floor(rnd() * 6_000) },
      creator: { shareOfSupplyPct: rnd() * 60, priorLaunches: Math.floor(rnd() * 6) },
      cfg: { ...LIVE_CFG, noticeMaxMs: 5_000, maxCreatorSharePct: 45, maxLaunchSharePct: 45 },
      book: { ...BOOK, deployedTodaySol: rnd() < 0.08 ? 0.008 : 0 },
    };
    if (hostile >= 0.04 && hostile < 0.10) over.mint = mintWith({ freezeAuthority: CREATOR });
    else if (hostile >= 0.10 && hostile < 0.14) over.mint = mintWith({
      extensions: ["transferHook"], extensionDetail: [{ extension: "transferHook" }] });
    const v = snipeContract(baseArgs(over));
    if (v.ok) passed += 1;
    else counts.set(v.gate, (counts.get(v.gate) ?? 0) + 1);
  }
  const rate = passed / total;
  const table = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`       ${passed}/${total} launches cleared every gate — hit rate ${f(rate * 100, 2)}%`);
  for (const [gate, n] of table)
    console.log(`         ${gate.padEnd(24)} refused ${String(n).padStart(3)}  (${f((n / total) * 100, 1)}%)`);

  /* THE TWO FAILURE DIRECTIONS, both asserted. A gate stack that admits nothing is
     indistinguishable from one that works until you count; a stack that admits
     everything is not a gate at all. */
  assert.equal(passed > 0, true,
    `the stack refused ALL ${total} synthetic launches — a gate that refuses everything is not a gate ` +
    `(refusals: ${table.map(([g, n]) => `${g} ${n}`).join(", ")})`);
  assert.equal(passed < total, true, `the stack admitted ALL ${total} launches — nothing was refused`);
  assert.equal(rate > 0.10 && rate < 0.95, true,
    `the hit rate is ${f(rate * 100, 2)}%, outside the (10%, 95%) band this population should land in`);
  assert.equal(counts.size >= 4, true,
    `only ${counts.size} distinct gate(s) refused anything (${table.map(([g]) => g).join(", ")}) — ` +
    "one gate has become the whole funnel");
  const [topGate, topCount] = table[0] ?? ["none", 0];
  assert.equal(topCount < total * 0.8, true,
    `${topGate} alone refused ${topCount} of ${total} launches`);
});

/* ════ 8. PURITY, DETERMINISM, AND THE SOURCE-LEVEL FENCE ═════════════════════════════ */

const stable = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Set ? [...x] : x));

ok("snipeContract is pure: no clock of its own, no mutation, same answer twice", () => {
  const args = baseArgs({ adapter: PROVED_ADAPTER });
  const before = stable(args);
  const a = snipeContract(args);
  const b = snipeContract(args);
  assert.equal(stable(args), before, `the arguments were mutated: ${stable(args)}`);
  assert.equal(stable(a), stable(b), "two identical calls disagreed");
  /* No Date.now() anywhere: the same facts an hour later give the same verdict, and a
     missing clock is a refusal rather than a silent `Date.now()`. */
  const noClock = snipeContract(baseArgs({ nowMs: null }));
  assert.equal(noClock.gate, "notice_stale", `a missing clock answered ${noClock.gate}`);
  assert.match(noClock.detail.message, /no clock was supplied/, noClock.detail.message);
  const source = readRepo("executor/snipe-entry.mjs");
  assert.equal(/Date\.now\(\)/.test(source), false, "snipe-entry.mjs calls Date.now()");
  assert.equal(/Math\.random/.test(source), false, "snipe-entry.mjs calls Math.random()");
  assert.equal(/process\.env/.test(source), false, "snipe-entry.mjs reads process.env");
  assert.equal(/\bawait\b|\bfetch\(|node:fs/.test(source), false, "snipe-entry.mjs does I/O");
  console.log("       no clock, no randomness, no env, no I/O, no argument mutation");
});

ok("the desk path is not imported, and no venue layout is hardcoded here", () => {
  const source = readRepo("executor/snipe-entry.mjs");
  for (const forbidden of ["trade-policy.mjs", "desk-mirror.mjs", "./strategy.mjs", "poller.mjs"])
    assert.equal(source.includes(`from "./${forbidden.replace("./", "")}"`), false,
      `snipe-entry.mjs imports ${forbidden} — the desk path stays byte-identical`);
  /* A DEFINITION, not the word. The module's header says at length WHY there is no
     discriminator here; a regex that cannot tell prose from a constant would force that
     explanation out of the file it explains. */
  assert.equal(/discriminator\s*[:=]|sighash\s*[:=]/i.test(source), false,
    "snipe-entry.mjs DEFINES an instruction discriminator; no venue layout is verified in this repo");
  assert.equal(/Buffer\.from\(\[/.test(source), false, "snipe-entry.mjs carries a hardcoded byte array");
  /* The one sanctioned desk import is minViableSolPerTrade, and it arrives INDIRECTLY
     through snipe-curve.mjs's snipeFloor — this file imports strategy.mjs not at all. */
  assert.equal(source.includes("minViableSolPerTrade"), false,
    "snipe-entry.mjs reaches for minViableSolPerTrade directly instead of through snipeFloor");
  const curveSource = readRepo("executor/snipe-curve.mjs");
  assert.equal(curveSource.includes("minViableSolPerTrade"), true,
    "snipe-curve.mjs no longer holds the single sanctioned definition of the fee floor");
  console.log(`       ${SNIPE_ENTRY_VERSION}: no desk imports, no discriminators, the fee floor reached only through snipeFloor`);
});

ok("the ladder is honest about being inert at the live cap, and says so in the refusal", () => {
  /* A curve where 0.005 SOL is over the impact cap and 0.0025 SOL is not. The ladder
     finds the smaller rung — and then the wallet fact refuses it, because half the live
     cap is under the fee floor. Both halves of that are printed, because "the ladder
     exists" and "the ladder can help at this size" are different claims. */
  const curve = { ...STANDARD_CURVE, vQuoteRaw: 75n * SOL / 1_000n, vBaseRaw: 1_000_000n * TOK,
    realBaseRaw: 700_000n * TOK, realQuoteRaw: 0n, feeBps: 0 };
  const plan = planSnipeCeiling({ curve: snipeCurveState(curve), adapter: PROVED_ADAPTER,
    solLamports: 5_000_000n, cfg: LIVE_CFG });
  assert.equal(plan.halvings, 1, `the ladder stopped at ${plan.halvings} halving(s)`);
  assert.equal(plan.cleared, true, "the ladder never cleared the cost caps");
  const v = snipeContract(baseArgs({ curve }));
  assert.equal(v.gate, "size_under_minimum", `the halved rung answered ${v.gate}`);
  console.log(`       impact at 0.005 SOL ${f(plan.rungs[0].impactPct)}% > 5% · at 0.0025 SOL ` +
    `${f(plan.rungs[1].impactPct)}% <= 5% · but 0.002500 SOL < ${f(v.detail.minViableSol, 6)} SOL minimum viable`);
  console.log("       so at the live cap MAX_ROUTE_HALVINGS is inert: a cost-shaped refusal cannot become a smaller fill");
});

console.log(`\n${pass} passed — the t=0 gate refuses by name, admits a real launch, and its ceiling is tighter than a tolerance\n`);
