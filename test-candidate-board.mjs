/**
 * PRE-DECISION CANDIDATE SNAPSHOT
 *
 * The dashboard may show the free-screen shortlist, but it must never turn that
 * convenience into a second set of "calls". These checks pin the snapshot to the
 * exact pre-judgement cycle, five candidates per board cell, with empty cap drawers
 * still represented honestly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

if (!process.env.CLAUDE_CO_DB)
  throw new Error("test runner must provide CLAUDE_CO_DB");

const { CAP_BANDS } = await import("./src/categories.js");
const db = (await import("./src/lib/store.js")).default;
const {
  CANDIDATES_PER_CELL,
  latestCandidateBoard,
  recordCandidateBoard,
} = await import("./src/candidate-board.js");

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name} — ${error.message}`);
    throw error;
  }
};

const candidate = (n, overrides = {}) => ({
  mint: `Mint${String(n).padStart(2, "0")}111111111111111111111111111111111`,
  score: 100 - n,
  launchpad: "pump.fun",
  rankWhy: [`rank reason ${n}`],
  pair: {
    baseSymbol: `C${n}`,
    baseName: `Candidate ${n}`,
    marketCap: 50_000 + n,
    liquidityUsd: 25_000 + n,
    volume: { h24: 75_000 + n },
    txns: { h24: { buys: 100 + n, sells: 50 + n } },
    priceChange: { h1: n },
    ageHours: n / 2,
    imageUrl: `https://img.example/${n}.png`,
    url: `https://dex.example/pair/${n}`,
  },
  ...overrides,
});

console.log("\nEMPTY BOARD — every market-cap drawer remains visible");
check("empty state is explicitly pre-decision and not reviewed", () => {
  const result = latestCandidateBoard();
  assert.equal(result.source, "pre-decision");
  assert.equal(result.decisionStatus, "not-reviewed");
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(Object.keys(result.bands), Object.keys(CAP_BANDS));
  assert.ok(Object.values(result.bands).every((band) => band.candidates.length === 0));
});

console.log("\nCAPTURE — the dashboard gets the exact first five from each cell");
const micro = Array.from({ length: 7 }, (_, i) => candidate(i + 1));
const low = [
  candidate(20, { pair: { ...candidate(20).pair, marketCap: 200_000 } }),
  candidate(21, {
    pair: {
      ...candidate(21).pair,
      marketCap: null,
      liquidityUsd: null,
      imageUrl: "http://insecure.example/image.png",
      url: "javascript:alert(1)",
    },
    rankWhy: ["useful", "", null, { not: "display text" }],
  }),
];
const utility = candidate(30, { pair: { ...candidate(30).pair, marketCap: 2_000_000 } });
const first = recordCandidateBoard("cycle-001", {
  cells: [
    { band: "micro", type: "memecoin", coins: micro },
    { band: "low", type: "memecoin", coins: low },
    { band: "high", type: "utility", coins: [utility] },
    { band: "fictional", type: "memecoin", coins: [candidate(99)] },
  ],
  offBoard: 9,
  filled: 3,
  possible: 15,
}, { considered: 42, capturedAt: 1_000_000 });

check("persistence caps every cell at the product contract of five", () => {
  assert.equal(CANDIDATES_PER_CELL, 5);
  assert.equal(first.inserted, 8); // five micro + two low + one utility
  const result = latestCandidateBoard();
  assert.equal(result.cycle, "cycle-001");
  assert.equal(result.candidateCount, 7);
  assert.equal(result.bands.micro.candidates.length, 5);
  assert.deepEqual(result.bands.micro.candidates.map((c) => c.symbol), ["C1", "C2", "C3", "C4", "C5"]);
  assert.deepEqual(result.bands.micro.candidates.map((c) => c.rank), [1, 2, 3, 4, 5]);
  assert.equal(result.bands.low.candidates.length, 2);
  assert.equal(result.bands.medium.candidates.length, 0);
  assert.equal(result.bands.high.candidates.length, 0); // utility is a different drawer
  assert.equal(result.considered, 42);
  assert.equal(result.offBoard, 9);
});

check("missing numbers stay unknown and unsafe links do not reach the UI", () => {
  const item = latestCandidateBoard().bands.low.candidates[1];
  assert.equal(item.marketCapUsd, null);
  assert.equal(item.liquidityUsd, null);
  assert.equal(item.imageUrl, null);
  assert.equal(item.pairUrl, null);
  assert.deepEqual(item.rankWhy, ["useful"]);
});

check("coin type is a real board dimension, not an unvalidated query string", () => {
  const result = latestCandidateBoard({ coinType: "utility", perBand: 99 });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.bands.high.candidates[0].mint, utility.mint);
  assert.throws(() => latestCandidateBoard({ coinType: "anything" }), /unknown candidate coin type/);
});

console.log("\nCYCLE IDENTITY — replace atomically, newest sweep wins");
recordCandidateBoard("cycle-001", {
  cells: [{ band: "medium", type: "memecoin", coins: [candidate(40)] }],
  offBoard: 0, filled: 1, possible: 15,
}, { considered: 1, capturedAt: 1_100_000 });

check("re-recording one cycle removes its stale candidates", () => {
  const result = latestCandidateBoard();
  assert.equal(result.candidateCount, 1);
  assert.equal(result.bands.micro.candidates.length, 0);
  assert.equal(result.bands.medium.candidates[0].symbol, "C40");
});

recordCandidateBoard("cycle-002", {
  cells: [], offBoard: 4, filled: 0, possible: 15,
}, { considered: 4, capturedAt: 1_200_000, retentionMs: 60_000 });

check("a newer empty sweep never leaks candidates from an older cycle", () => {
  const result = latestCandidateBoard();
  assert.equal(result.cycle, "cycle-002");
  assert.equal(result.candidateCount, 0);
  assert.ok(Object.values(result.bands).every((band) => band.candidates.length === 0));
});

check("retention removes old runs and their candidate rows", () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_board_runs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_board_candidates").get().n, 0);
});

check("a malformed duplicate cell rolls back without damaging the latest snapshot", () => {
  const badBoard = {
    cells: [
      { band: "micro", type: "memecoin", coins: [candidate(50)] },
      { band: "micro", type: "memecoin", coins: [candidate(51)] },
    ],
  };
  assert.throws(
    () => recordCandidateBoard("cycle-bad", badBoard, { capturedAt: 1_300_000 }),
    /duplicate candidate board cell/,
  );
  assert.equal(latestCandidateBoard().cycle, "cycle-002");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_board_runs WHERE cycle='cycle-bad'").get().n, 0);
});

check("the production cycle records the board before paid judgement starts", () => {
  const source = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  const boardAt = source.indexOf("const board = buildBoard(scored");
  const recordAt = source.indexOf("recordCandidateBoard(cycle, board", boardAt);
  const paidSelectionAt = source.indexOf("selectAcrossBoard(board", boardAt);
  const firstWorkupAt = source.indexOf("workup(cycle", boardAt);
  assert.ok(boardAt > 0 && recordAt > boardAt,
    "the persisted artifact must be built from the current free-screen board");
  assert.ok(paidSelectionAt > recordAt && firstWorkupAt > recordAt,
    "no paid/choosing-seat decision may precede the saved candidate snapshot");
});

console.log(`\n${pass} passed, 0 failed\n`);
