// Sell back the BONK bought by the round-trip probe, using the ON-CHAIN amount.
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { JupiterV2Executor, WSOL, MAX_GROSS_RENT_LAMPORTS } from "./jupiter.mjs";
import { ExecutionJournal } from "./journal.mjs";
const MINT = process.env.TEST_MINT, RAW = process.env.SELL_RAW;
const log = (...a) => console.log(new Date().toISOString(), "SELLBACK", ...a);
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("./burner.json", "utf8"))));
const conn = new Connection(process.env.SOLANA_RPC, "confirmed");
const secondary = new Connection(process.env.SOLANA_RPC_SECONDARY, "confirmed");
const journal = new ExecutionJournal("./.roundtrip-test.sqlite", { wallet: kp.publicKey.toBase58() });
const jupiter = new JupiterV2Executor({
  connection: conn, secondaryConnection: secondary, keypair: kp, journal,
  apiKey: process.env.JUPITER_API_KEY, baseUrl: process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v2",
  hardStop: () => false, submissionGate: () => {}, log,
  config: { slippageBps: 300, maxPriceImpactPct: 5, maxExitPriceImpactPct: 50, maxFeeBps: 100,
    // Matches the poller's live gate. An emergency exit must never refuse a fee the
  // automated entry would have paid: the one real live round trip paid 92 lamports of
  // priority on the entry and 280,276 on the EXIT, so the exit leg is the hungry one.
  maxNetworkFeeLamports: 2_000_000, expectedNetworkFeeLamports: 500_000, maxNetworkFeePct: 10, maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
    maxAttempts: 3, maxExitAttempts: 12, blockHeightWindow: 600, maxQuoteShortfallPct: 15, finalityTimeoutMs: 60_000 },
});
const before = await conn.getBalance(kp.publicKey);
log(`selling ${RAW} raw units of ${MINT}`);
const exit = await jupiter.executeIntent({
  id: `roundtrip-exit:${MINT}:${Date.now()}`, kind: "risk_exit", eventId: null, feedId: null,
  mint: MINT, inputMint: MINT, outputMint: WSOL, amountRaw: RAW,
  context: { wallet: kp.publicKey.toBase58(), position: { mint: MINT, qtyRaw: RAW } },
});
log(`SELL CONFIRMED signature ${exit.signature}`);
log(`fill fields: ${Object.keys(exit).join(", ")}`);
const after = await conn.getBalance(kp.publicKey);
log(`SOL ${(before/1e9).toFixed(6)} -> ${(after/1e9).toFixed(6)}`);
journal.close();
