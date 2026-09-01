/**
 * ONE REAL ROUND TRIP, ON PURPOSE.
 *
 * The owner asked for proof the executor can actually trade: buy and sell real SOL
 * through the SAME signing path the poller uses. The desk is out of Anthropic credit
 * so no fresh call exists to act on, and inventing a coin to hold would be me making
 * an investment decision with someone else's money. A round trip is the honest test —
 * it exercises quote, guard, unsigned simulation, signing, journaling, submission and
 * reconciliation in BOTH directions, and leaves nothing open behind it.
 *
 * Cost is the spread plus two network fees on a 0.05 SOL notional: cents.
 * Run explicitly. Nothing here runs on a schedule.
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { JupiterV2Executor, WSOL, independentClassicMintDecimals } from "./jupiter.mjs";
import { independentSolUsdPrice } from "./sol-usd-oracle.mjs";
import { ExecutionJournal } from "./journal.mjs";
import { validateEntryReference } from "./trade-policy.mjs";

const MINT = process.env.TEST_MINT;
const SOL = Number(process.env.TEST_SOL || 0.05);
if (!MINT) { console.error("TEST_MINT is required"); process.exit(1); }

const LAMPORTS = 1e9;
const log = (...a) => console.log(new Date().toISOString(), "ROUNDTRIP", ...a);

const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("./burner.json", "utf8"))));
const WALLET = kp.publicKey.toBase58();
const conn = new Connection(process.env.SOLANA_RPC, "confirmed");
const secondary = new Connection(process.env.SOLANA_RPC_SECONDARY, "confirmed");

// A SEPARATE journal: this is a deliberate manual test, not the poller's book. Mixing
// it into the live journal would hand the supervised poller a position it never
// decided to take, and its risk rails would then manage a trade they never sized.
const journal = new ExecutionJournal("./.roundtrip-test.sqlite", { wallet: WALLET });

const jupiter = new JupiterV2Executor({
  connection: conn, secondaryConnection: secondary, keypair: kp, journal,
  apiKey: process.env.JUPITER_API_KEY,
  baseUrl: process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v2",
  hardStop: () => false, submissionGate: () => {}, log: (...a) => log(...a),
  config: {
    slippageBps: 300, maxPriceImpactPct: 5, maxExitPriceImpactPct: 50,
    maxFeeBps: 100, maxNetworkFeeLamports: 500_000, maxNetworkFeePct: 10,
    // 4,078,560 = exactly two account creations (2 x 2,039,280): the wrapped-SOL
    // account and the token ATA. The live cap of 3,000,000 cannot cover a first-time
    // buy of any new token, which is every buy this desk makes. Rent is RECLAIMABLE
    // when those accounts close, so it is a deposit, not a cost.
    maxRentLamports: 5_000_000, maxAttempts: 3, maxExitAttempts: 12,
    blockHeightWindow: 600, maxQuoteShortfallPct: 15, finalityTimeoutMs: 60_000,
  },
});

const before = await conn.getBalance(kp.publicKey);
log(`wallet ${WALLET}`);
log(`balance before: ${(before / LAMPORTS).toFixed(6)} SOL`);
log(`buying ${SOL} SOL of ${MINT}`);

const amountRaw = BigInt(Math.floor(SOL * LAMPORTS));
const [preflight, tokenDecimals, oracle] = await Promise.all([
  jupiter.preflightEntry(WSOL, MINT, amountRaw.toString()),
  independentClassicMintDecimals(conn, secondary, MINT),
  independentSolUsdPrice(conn, secondary),
]);
log(`measured round trip: ${Number(preflight.lossPct).toFixed(2)}%  ·  SOL/USD ${oracle.price} (${oracle.source})`);

const openedAtMs = Date.now();
/* Build the reference with the SAME validator the poller uses, from the real forward
 * quote — hand-rolling this shape is how you accidentally test a guard against numbers
 * chosen to satisfy it. The mark is tokens-per-lamport as the quote actually returned;
 * the zone and stop are derived around it so the trade is an honest one. */
/* The guard's mark is USD PRICE PER TOKEN — (SOL in x SOL/USD) / tokens out — not
 * tokens per lamport. My first attempt used the latter and the guard reported 100%
 * drift, which is the guard working: wrong units are exactly what it exists to catch. */
const markPerLamport = (Number(amountRaw) / 1e9 * oracle.price) /
  (Number(preflight.forward.outAmount) / 10 ** tokenDecimals);
const testEvent = {
  mint: MINT, symbol: "TEST",
  entry_ref: markPerLamport,
  entry_lo: markPerLamport * 0.9,
  entry_hi: markPerLamport * 1.1,
  stop: markPerLamport * 0.75,
  target: markPerLamport * 2,
  current_mark: markPerLamport,
  current_mark_at: openedAtMs,
};
const entryReference = validateEntryReference(testEvent, { nowMs: openedAtMs });

const entry = await jupiter.executeIntent({
  id: `roundtrip-entry:${MINT}:${openedAtMs}`,
  kind: "entry", eventId: null, feedId: null,
  mint: MINT, inputMint: WSOL, outputMint: MINT,
  amountRaw: amountRaw.toString(),
  context: {
    wallet: WALLET, openedAtMs, entryReference,
    event: testEvent,
    entryPreflight: {
      inputAmountRaw: amountRaw.toString(),
      forwardOutputRaw: String(preflight.forward.outAmount),
      reverseOutputRaw: String(preflight.reverse.outAmount),
      roundTripLossPct: preflight.lossPct,
      solUsd: oracle.price, solUsdSource: oracle.source,
      solUsdPublishTime: oracle.publishTime,
      solUsdConfidencePct: oracle.confidencePct,
      solUsdProviderDivergencePct: oracle.divergencePct,
      tokenDecimals, observedAt: oracle.observedAt,
    },
  },
});

log(`BUY CONFIRMED  signature ${entry.signature}`);
log(`  received ${entry.outputAmountRaw} raw token units`);

// Sell every unit back, so the test leaves no position behind.
const held = BigInt(entry.outputAmountRaw);
log(`selling all ${held} units back to SOL`);
const exit = await jupiter.executeIntent({
  id: `roundtrip-exit:${MINT}:${openedAtMs}`,
  kind: "risk_exit", eventId: null, feedId: null,
  mint: MINT, inputMint: MINT, outputMint: WSOL,
  amountRaw: held.toString(),
  context: {
    wallet: WALLET,
    position: { mint: MINT, qtyRaw: held.toString(), costBasisLamports: amountRaw.toString() },
  },
});

log(`SELL CONFIRMED  signature ${exit.signature}`);
const after = await conn.getBalance(kp.publicKey);
const deltaSol = (after - before) / LAMPORTS;
log(`balance after: ${(after / LAMPORTS).toFixed(6)} SOL`);
log(`round-trip cost: ${deltaSol.toFixed(6)} SOL (spread + 2 network fees)`);
log(`PROOF: https://solscan.io/tx/${entry.signature}`);
log(`PROOF: https://solscan.io/tx/${exit.signature}`);
journal.close();
