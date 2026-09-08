/**
 * THE ENTRY WINDOW, MEASURED INSTEAD OF ARGUED.
 *
 * ENTRY_WINDOW_FLOOR_MS is the shortest time a published call stays enterable. It was
 * 60_000 and its own comment said the number was UNVERIFIED: it was a POLL-RATE
 * argument — "a poll is seconds apart, a call must survive several" — and nobody had
 * timed the pipeline the window actually has to cover. A nano call carries
 * holdMinMs 60_000 (src/bands.js), so on the old floor the whole journey from alert row
 * to signature had exactly one minute: two Jupiter quotes, a two-RPC mint audit, Pyth,
 * the /order build, and then, on BOTH RPC providers, the lookup/mint/slot-anchor/
 * snapshot/rent+height/simulate/post-snapshot/epoch fences — with the window rechecked
 * at the submission gate immediately before signing (poller.mjs entryEventSubmissionGate).
 *
 * This file measures that pipeline three ways and sets the floor from the result:
 *
 *   1. Wall clock, 50 runs against a LOCAL Jupiter stub and dummy RPCs, zero injected
 *      latency: what the bot's own code costs when the network is free. p50/p95 printed.
 *   2. Serial depth, from the latency slope: re-run the same pipeline with every stub
 *      request delayed by a known amount and divide. This is the ruler that matters —
 *      requests fan out in Promise.all all over this path, so the count of requests
 *      (also printed) is NOT the number that multiplies latency. The slope is.
 *   3. The same critical path priced at the bot's OWN declared per-request deadlines
 *      (Jupiter /order 12s, RPC transport 4s, slot anchor 2s, epoch fence 2s), one
 *      attempt per hop — the longest a preflight can run before this executor's own
 *      transport fences abort it. Those deadlines are not decoration: poller.mjs's
 *      solBalance comment records "Solana RPC HTTP request timed out after 4000ms" and
 *      "RPC could not obtain a processed-slot freshness anchor" appearing throughout
 *      the live log, with roughly half the readiness rehearsals failing on transport.
 *
 * The deadline-priced path is the number the window has to cover, because a call that
 * expires mid-preflight is not a slow trade, it is a dead one — the refusal is
 * deterministic and never retried.
 */
import fs from "node:fs";
import http from "node:http";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  JupiterV2Executor, PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS, TOKEN_PROGRAM, WSOL,
  WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS, associatedTokenAddress, coherentAccountSnapshot,
  fencedProcessedEpochHeight, independentClassicMintDecimals, processedSlotFreshnessAnchor,
} from "./jupiter.mjs";
import {
  PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID,
  SOLANA_RPC_HTTP_REQUEST_TIMEOUT_MS, independentSolUsdPrice,
} from "./sol-usd-oracle.mjs";
import { ENTRY_WINDOW_FLOOR_MS, entryWindowMs } from "./entry-contract.mjs";
import { CAP_BANDS } from "../src/bands.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};
const ms = (n) => `${Math.round(n).toLocaleString("en-US")}ms`;

const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const jupiterSource = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
const operatorReadme = fs.readFileSync(new URL("./README.md", import.meta.url), "utf8");

/* ────────────────────────────────────────────────────────────────────────────────
   1. ONE FLOOR, ONE DEFINITION — the poller no longer keeps its own copy
   ──────────────────────────────────────────────────────────────────────────────── */
console.log("\nTHE FLOOR IS THE CONTRACT'S CONSTANT, NOT A SECOND LITERAL");
{
  ok("poller.mjs imports ENTRY_WINDOW_FLOOR_MS from the entry contract",
    /import \{[^}]*\bENTRY_WINDOW_FLOOR_MS\b[^}]*\} from "\.\/entry-contract\.mjs"/s.test(poller));
  ok("...and MIN_CALL_EXPIRY_MS *is* that constant, not a literal beside it",
    /const MIN_CALL_EXPIRY_MS = ENTRY_WINDOW_FLOOR_MS;/.test(poller) &&
    !/const MIN_CALL_EXPIRY_MS = \d/.test(poller),
    "an identity, so the two cannot drift by a digit");
  ok("callExpiryMs still passes it as the floor of the band's own clock",
    /const callExpiryMs = \(ev\) => entryWindowMs\(\{\s*\n\s*holdMinMs: ev\?\.hold_min_ms, floorMs: MIN_CALL_EXPIRY_MS/.test(poller));
  /* The preflight-age cap is the SAME budget seen from the other end: the quotes and
     the Pyth read are stamped at the top of the pipeline and re-checked against this
     cap at the submission gate. A cap shorter than the window refuses, at the last
     fence, a preflight the same pipeline legitimately took that long to produce. */
  ok("maxEntryPreflightAgeMs is the same constant, not a parallel 60_000",
    /maxEntryPreflightAgeMs: ENTRY_WINDOW_FLOOR_MS,/.test(poller) &&
    !/maxEntryPreflightAgeMs: \d/.test(poller));
  ok("...and an operator can still tighten it from the environment",
    /number\("MAX_ENTRY_PREFLIGHT_AGE_MS",\s*\n\s*process\.env\.MAX_ENTRY_PREFLIGHT_AGE_MS \|\| LIVE_LIMITS\.maxEntryPreflightAgeMs/.test(poller),
    "MAX_ENTRY_PREFLIGHT_AGE_MS, capped at the live limit when EXECUTE=1");
  /* THE OPERATOR'S TABLE IS PART OF THE CEILING. executor/README.md's env table is where
     an operator actually reads this number, and it still said 60000 after the code moved
     — a stale row sends someone to set a value the poller would silently clamp. Read out
     of the table so the documentation cannot drift from the constant again. */
  const documentedCeiling = Number((operatorReadme.match(
    /\|\s*`MAX_ENTRY_PREFLIGHT_AGE_MS`\s*\|\s*`(\d+)`/) || [])[1]);
  ok("the operator README documents the same ceiling the code enforces",
    documentedCeiling === ENTRY_WINDOW_FLOOR_MS,
    `README ${ms(documentedCeiling)} vs code ${ms(ENTRY_WINDOW_FLOOR_MS)}`);
}

console.log("\nTHE WINDOW A NANO CALL GETS");
{
  const MAX_CALL_AGE_MS = 45 * 60_000;          // poller.mjs's MAX_CALL_AGE_MIN default
  const nanoHold = CAP_BANDS.nano.holdMinMs;
  const expected = Math.max(60_000, ENTRY_WINDOW_FLOOR_MS);
  /* The desk's helper and the bot's callExpiryMs are the same function; the bot only
     supplies its own floor and fallback. So calling it with the poller's arguments IS
     callExpiryMs, and calling it with the contract's defaults is the desk's answer. */
  const botWindow = entryWindowMs({ holdMinMs: nanoHold, floorMs: ENTRY_WINDOW_FLOOR_MS,
    fallbackMs: MAX_CALL_AGE_MS });
  const deskWindow = entryWindowMs({ holdMinMs: nanoHold });
  ok(`callExpiryMs(nano) is max(60_000, ENTRY_WINDOW_FLOOR_MS)`,
    botWindow === expected, `${ms(botWindow)} (band holds ${ms(nanoHold)} minimum)`);
  ok("the desk's window helper returns the same number",
    deskWindow === botWindow, `desk ${ms(deskWindow)} vs bot ${ms(botWindow)}`);
  ok("the owner-tuned band ladder is untouched",
    CAP_BANDS.nano.holdMinMs === 60_000 && CAP_BANDS.micro.holdMinMs === 20 * 60_000,
    "src/bands.js nano holdMinMs 60_000, micro 20m");
  /* Only nano sits under the floor. If the floor ever grew past a band's own hold the
     ladder would flatten and the desk's taxonomy would stop meaning anything. */
  for (const [band, b] of Object.entries(CAP_BANDS)) {
    if (band === "nano") continue;
    ok(`${band} still gets its own hold, not the floor`,
      entryWindowMs({ holdMinMs: b.holdMinMs, floorMs: ENTRY_WINDOW_FLOOR_MS,
        fallbackMs: MAX_CALL_AGE_MS }) === Math.min(b.holdMinMs, MAX_CALL_AGE_MS * 8),
      `${ms(b.holdMinMs)}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────────
   2. THE TIMING PROBE — the paper preflight, 50 times, against a local stub
   ──────────────────────────────────────────────────────────────────────────────── */
const wallet = Keypair.generate();
const mint = Keypair.generate().publicKey.toBase58();
const recentBlockhash = Keypair.generate().publicKey.toBase58();
const SNAPSHOT_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SLOT = 900;
const SIM_FEE = 5_000;

/* Every stub request — RPC and Jupiter alike — waits this long before answering. At 0
   the probe measures the bot's own code; raised, the slope over it measures how many
   requests are actually SERIAL on the path. */
const injected = { latencyMs: 0 };
let requests = 0;
const stubHop = async () => {
  requests++;
  if (injected.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, injected.latencyMs));
};

const classicMintAccount = (decimals = 6) => {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { owner: new PublicKey(TOKEN_PROGRAM), data };
};
/* A PriceUpdateV2 the real parser accepts: full-verification variant, pinned feed id,
   fresh publish time, tight confidence. Byte layout from executor/sol-usd-oracle.mjs. */
const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from("22f123639d7ef4cd", "hex");
const pythAccount = (nowMs) => {
  const price = 10_200_000_000n, confidence = 1_000_000n, exponent = -8;
  const publishTime = Math.floor(nowMs / 1_000) - 5;
  const bytes = Buffer.alloc(134);
  PRICE_UPDATE_V2_DISCRIMINATOR.copy(bytes, 0);
  bytes[40] = 1;
  let offset = 41;
  Buffer.from(PYTH_SOL_USD_FEED_ID, "hex").copy(bytes, offset); offset += 32;
  bytes.writeBigInt64LE(price, offset); offset += 8;
  bytes.writeBigUInt64LE(confidence, offset); offset += 8;
  bytes.writeInt32LE(exponent, offset); offset += 4;
  bytes.writeBigInt64LE(BigInt(publishTime), offset); offset += 8;
  bytes.writeBigInt64LE(BigInt(publishTime - 1), offset); offset += 8;
  bytes.writeBigInt64LE(price, offset); offset += 8;
  bytes.writeBigUInt64LE(confidence, offset); offset += 8;
  bytes.writeBigUInt64LE(443_000_000n, offset);
  return { owner: new PublicKey(PYTH_RECEIVER_PROGRAM), data: bytes };
};

/** A dummy RPC: no network, no wallet, no chain — every answer is a fixture, and every
 *  call pays the injected latency so the slope can see it. */
const dummyRpc = () => ({
  async getBalance() { await stubHop(); return 400_000_000; },
  async getAccountInfo(key) {
    await stubHop();
    return key.toBase58() === PYTH_SOL_USD_ACCOUNT ? pythAccount(Date.now()) : classicMintAccount();
  },
  async getAddressLookupTable() { await stubHop(); return { value: null }; },
  async getSlot() { await stubHop(); return SLOT; },
  async getMinimumBalanceForRentExemption() { await stubHop(); return 2_039_280; },
  async getBlockHeight() { await stubHop(); return 600; },
  async getEpochInfo(config) {
    await stubHop();
    return { absoluteSlot: Math.max(SLOT, Number(config?.minContextSlot) || 0), blockHeight: 600 };
  },
  async simulateTransaction(tx, options) {
    await stubHop();
    const staticAddresses = tx.message.staticAccountKeys.map((key) => key.toBase58());
    const preBalances = staticAddresses.map(() => 20_000_000);
    const postBalances = [...preBalances];
    postBalances[0] -= SIM_FEE;
    const accounts = (options?.accounts?.addresses || []).map((address) => ({
      lamports: postBalances[staticAddresses.indexOf(address)],
      owner: SystemProgram.programId.toBase58(), data: ["", "base64"],
      executable: false, rentEpoch: 0,
    }));
    return { context: { slot: Math.max(SLOT, Number(options?.minContextSlot) || 0) },
      value: { err: null, accounts, preBalances, postBalances, fee: SIM_FEE, logs: [] } };
  },
});

const unsignedProbeTx = () => new VersionedTransaction(new TransactionMessage({
  payerKey: wallet.publicKey, recentBlockhash,
  instructions: [new TransactionInstruction({
    programId: new PublicKey(SNAPSHOT_MEMO_PROGRAM), keys: [], data: Buffer.from("W"),
  })],
}).compileToV0Message());

/* THE LOCAL JUPITER STUB. Real loopback HTTP through the executor's own fetch path, so
   the /order legs pay a genuine connect + JSON round trip rather than a resolved
   promise. The quote it returns is deliberately ordinary: 1% round-trip loss, well
   inside maxEntryRoundTripLossPct, so preflightEntry runs to completion every time. */
const jupiterStub = http.createServer(async (req, res) => {
  await stubHop();
  const params = new URL(req.url, "http://127.0.0.1").searchParams;
  const inAmount = String(params.get("amount"));
  const outAmount = params.get("inputMint") === WSOL
    ? String(Math.floor(Number(inAmount) / 1_000))
    : String(Math.floor(Number(inAmount) * 1_000 * 0.99));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    mode: "manual", inputMint: params.get("inputMint"), outputMint: params.get("outputMint"),
    inAmount, outAmount, otherAmountThreshold: String(Math.floor(Number(outAmount) * 0.97)),
    swapMode: "ExactIn", slippageBps: 300, priceImpact: 0.5, feeBps: 50, feeMint: WSOL,
    platformFee: { amount: "5", feeBps: 10, feeMint: WSOL },
    signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 0,
    router: "metis", transaction: Buffer.alloc(600).toString("base64"),
    lastValidBlockHeight: "900", requestId: "stub", taker: wallet.publicKey.toBase58(),
  }));
});
await new Promise((resolve) => jupiterStub.listen(0, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${jupiterStub.address().port}`;

const primary = dummyRpc();
const secondary = dummyRpc();
const executor = new JupiterV2Executor({
  connection: primary, secondaryConnection: secondary,
  keypair: { publicKey: wallet.publicKey },
  // Nothing in the measured legs touches the journal or a secret key; a Proxy that
  // throws proves it rather than asserting it.
  journal: new Proxy({}, { get() { throw new Error("the timing probe touched the journal"); } }),
  apiKey: "stub-key",
  fetchFn: async (url, init) => {
    const target = new URL(String(url));
    return fetch(`${stubBase}${target.pathname}${target.search}`, init);
  },
  config: { maxEntryRoundTripLossPct: 12 },
});

const amountRaw = "40000000";                    // 0.04 SOL, the desk's declared clip
const custodyKeys = [
  wallet.publicKey,
  new PublicKey(associatedTokenAddress(wallet.publicKey.toBase58(), WSOL, TOKEN_PROGRAM)),
  new PublicKey(associatedTokenAddress(wallet.publicKey.toBase58(), mint, TOKEN_PROGRAM)),
];

/* One provider's half of _prepareUnsignedProvider (jupiter.mjs), in its own order. The
   snapshot, slot-anchor and epoch fences are the REAL exported functions; the four legs
   that only exist inside validateTransaction/_simulateUnsigned against a genuine Jupiter
   route (lookup tables, the two mint-program reads, rent+height, the swap simulation)
   are driven as direct stub calls at the same position, so the serial shape is intact. */
async function providerFences(connection) {
  await connection.getAddressLookupTable();
  await Promise.all([
    connection.getAccountInfo(new PublicKey(mint), "confirmed"),
    connection.getAccountInfo(new PublicKey(mint), "confirmed"),
  ]);
  const anchor = await processedSlotFreshnessAnchor(connection);
  const pre = await coherentAccountSnapshot(connection, custodyKeys, {
    transaction: unsignedProbeTx(), commitment: "processed", minContextSlot: anchor,
  });
  await Promise.all([
    connection.getMinimumBalanceForRentExemption(165, "processed"),
    connection.getBlockHeight("confirmed"),
  ]);
  await connection.simulateTransaction(unsignedProbeTx(), {
    commitment: "processed", sigVerify: false, replaceRecentBlockhash: false,
    accounts: { encoding: "base64", addresses: [] }, innerInstructions: true,
    minContextSlot: pre.slot,
  });
  const post = await coherentAccountSnapshot(connection, custodyKeys, {
    transaction: unsignedProbeTx(), commitment: "processed", minContextSlot: pre.slot,
  });
  await fencedProcessedEpochHeight(connection, post.slot);
}

/** Alert row to the moment before the signature, in poller.mjs onEntry's order. */
async function paperPreflight() {
  await primary.getBalance(wallet.publicKey, "confirmed");        // solBalance: one read
  await Promise.all([                                            // onEntry's Promise.all
    executor.preflightEntry(WSOL, mint, amountRaw),               //   two Jupiter quotes
    independentClassicMintDecimals(primary, secondary, mint),     //   two-RPC mint audit
    independentSolUsdPrice(primary, secondary),                   //   Pyth on both RPCs
  ]);
  await executor.order({ inputMint: WSOL, outputMint: mint, amountRaw, taker: true });
  await Promise.all([providerFences(primary), providerFences(secondary)]);
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1,
  Math.max(0, Math.ceil(p * sorted.length) - 1))];
async function timePipeline(runs, latencyMs) {
  injected.latencyMs = latencyMs;
  const samples = [];
  let perRun = 0;
  for (let i = 0; i < runs; i++) {
    requests = 0;
    const started = performance.now();
    await paperPreflight();
    samples.push(performance.now() - started);
    perRun = requests;
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95),
    min: samples[0], max: samples[samples.length - 1], requests: perRun };
}

const RUNS = 50;
/* TWO LATENCY POINTS, NOT ONE. The naive ruler — (time at L minus time at 0) / L —
   reads 13.3 hops here, and it is WRONG: every injected wait overshoots its timer by
   about a millisecond, so at L=10 a twelfth of the reading is overshoot. Taking the
   slope BETWEEN two injected latencies cancels the per-hop overshoot and lands on 12.0
   every run. Suspect the ruler first. */
const SLOPE_LO_MS = 8, SLOPE_HI_MS = 24, SLOPE_RUNS = 15;
console.log(`\nTIMING PROBE — ${RUNS} RUNS OF THE PAPER PREFLIGHT AGAINST THE LOCAL JUPITER STUB`);
await paperPreflight();                                          // warm the JIT and the socket
const free = await timePipeline(RUNS, 0);
const lo = await timePipeline(SLOPE_RUNS, SLOPE_LO_MS);
const hi = await timePipeline(SLOPE_RUNS, SLOPE_HI_MS);
injected.latencyMs = 0;
jupiterStub.close();

const slope = (hi.p50 - lo.p50) / (SLOPE_HI_MS - SLOPE_LO_MS);
const naiveSlope = (lo.p50 - free.p50) / SLOPE_LO_MS;
const serialDepth = Math.round(slope);
console.log(`  network requests per entry attempt : ${free.requests}`);
console.log(`  at  0ms latency  p50 ${free.p50.toFixed(1)}ms  p95 ${free.p95.toFixed(1)}ms  ` +
  `(min ${free.min.toFixed(1)} / max ${free.max.toFixed(1)})`);
console.log(`  at ${SLOPE_LO_MS}ms latency  p50 ${lo.p50.toFixed(1)}ms  p95 ${lo.p95.toFixed(1)}ms`);
console.log(`  at ${SLOPE_HI_MS}ms latency  p50 ${hi.p50.toFixed(1)}ms  p95 ${hi.p95.toFixed(1)}ms`);
console.log(`  measured SERIAL depth: ${serialDepth} hops ` +
  `(two-point slope ${slope.toFixed(2)}; the single-point ruler says ${naiveSlope.toFixed(2)} — timer overshoot)`);

/* ────────────────────────────────────────────────────────────────────────────────
   3. THE SAME PATH PRICED AT THE BOT'S OWN DEADLINES
   ──────────────────────────────────────────────────────────────────────────────── */
/* Each hop's ceiling is read out of the source that enforces it, so this table cannot
   drift from the code the way a copied number would. */
const orderMethod = jupiterSource.slice(jupiterSource.indexOf("  async order({"));
const JUPITER_ORDER_TIMEOUT_MS = Number((orderMethod.match(
  /AbortSignal\.timeout\((\d[\d_]*)\)/) || [])[1]?.replace(/_/g, ""));
const FINAL_HEIGHT_REQUEST_TIMEOUT_MS = Number((jupiterSource.match(
  /const FINAL_HEIGHT_REQUEST_TIMEOUT_MS = (\d[\d_]*)/) || [])[1]?.replace(/_/g, ""));
const RPC = SOLANA_RPC_HTTP_REQUEST_TIMEOUT_MS;

/* The critical path, in order, with the deadline each hop may legally consume before
   this executor aborts it. Parallel siblings collapse into one hop — they are not
   additive, which is exactly what the measured slope above proves. */
const CRITICAL_PATH = [
  ["solBalance getBalance", RPC],
  ["preflight quote: forward /order", JUPITER_ORDER_TIMEOUT_MS],
  ["preflight quote: reverse /order", JUPITER_ORDER_TIMEOUT_MS],
  ["/order build (taker)", JUPITER_ORDER_TIMEOUT_MS],
  ["validateTransaction lookup tables", RPC],
  ["mintTokenProgram x2 (parallel)", RPC],
  ["processedSlotFreshnessAnchor getSlot", PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS],
  ["coherentAccountSnapshot (pre-simulation)", WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS],
  ["rent exemption + block height (parallel)", RPC],
  ["simulateTransaction (unsigned swap)", RPC],
  ["coherentAccountSnapshot (post-simulation)", WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS],
  ["fencedProcessedEpochHeight getEpochInfo", FINAL_HEIGHT_REQUEST_TIMEOUT_MS],
];
const deadlinePricedMs = CRITICAL_PATH.reduce((sum, [, budget]) => sum + budget, 0);
const POLL_MS = Number((poller.match(/const POLL_MS = Number\(process\.env\.POLL_MS \|\| (\d[\d_]*)\)/) ||
  [])[1]?.replace(/_/g, ""));

console.log("\n  the same path priced at the executor's own per-request deadlines:");
for (const [leg, budget] of CRITICAL_PATH) console.log(`    ${String(budget).padStart(6)}ms  ${leg}`);
console.log(`    ${String(deadlinePricedMs).padStart(6)}ms  TOTAL, one attempt per hop`);
console.log(`  + ${POLL_MS}ms feed poll (POLL_MS default) = ${ms(deadlinePricedMs + POLL_MS)} ` +
  `from alert row to the last fence before signing`);
console.log(`  ENTRY_WINDOW_FLOOR_MS = ${ms(ENTRY_WINDOW_FLOOR_MS)}`);

console.log("\nTHE FLOOR COVERS THE PIPELINE IT HAS TO PAY FOR");
{
  ok("every hop's deadline was read out of the source, none guessed",
    [JUPITER_ORDER_TIMEOUT_MS, FINAL_HEIGHT_REQUEST_TIMEOUT_MS, POLL_MS].every(
      (n) => Number.isFinite(n) && n > 0),
    `Jupiter /order ${ms(JUPITER_ORDER_TIMEOUT_MS)}, epoch fence ${ms(FINAL_HEIGHT_REQUEST_TIMEOUT_MS)}, ` +
    `RPC ${ms(RPC)}, slot anchor ${ms(PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS)}, ` +
    `snapshot ${ms(WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS)}, poll ${ms(POLL_MS)}`);
  /* VALIDATE THE RULER. The deadline table is only worth anything if it prices the same
     path the clock measured. The slope says how many requests are serial; the table says
     how many it charges for. If they disagree, the table is wrong — not the code. */
  ok("the priced path is the measured path: same number of serial hops",
    serialDepth === CRITICAL_PATH.length,
    `slope measured ${serialDepth}, table prices ${CRITICAL_PATH.length} ` +
    `(of ${free.requests} requests in flight)`);
  ok("the bot's own code is a rounding error next to the network",
    free.p95 < 1_000, `p95 ${free.p95.toFixed(1)}ms of compute against ${ms(deadlinePricedMs)} of deadlines`);
  /* THE VERDICT THAT SETS THE NUMBER. 60_000 could not cover this: the deadline-priced
     path alone is longer than a minute, so on the old floor a nano call could expire
     while the bot was still legitimately inside the fences that protect it. */
  ok("the floor covers the deadline-priced pipeline plus one feed poll",
    ENTRY_WINDOW_FLOOR_MS >= deadlinePricedMs + POLL_MS,
    `floor ${ms(ENTRY_WINDOW_FLOOR_MS)} >= ${ms(deadlinePricedMs)} + ${ms(POLL_MS)} = ${ms(deadlinePricedMs + POLL_MS)}`);
  ok("...and the old 60_000 could not, which is why the number moved",
    deadlinePricedMs + POLL_MS > 60_000,
    `${ms(deadlinePricedMs + POLL_MS)} needed vs the 60,000ms poll-rate guess`);
  /* The floor is still a floor, not a new hold: it must stay far under the next band's
     own window or the ladder stops meaning anything. */
  ok("the floor stays well under the micro band's window",
    ENTRY_WINDOW_FLOOR_MS < CAP_BANDS.micro.holdMinMs / 2,
    `${ms(ENTRY_WINDOW_FLOOR_MS)} vs micro ${ms(CAP_BANDS.micro.holdMinMs)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
