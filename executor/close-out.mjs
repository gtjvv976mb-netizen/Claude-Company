/**
 * Close out the probe's confirmed buy the way the poller's applyConfirmedEntry does,
 * then sell it back. The probe crashed after its fill landed (it read a field the
 * fill does not carry), leaving the entry `confirmed` but never `accounted`; the
 * journal correctly refuses any exit on that mint until it is. This is that
 * accounting step — the same quarantine branch the poller uses for an entry with
 * no call_id and no sizing plan — followed by the sell.
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { JupiterV2Executor, WSOL, MAX_GROSS_RENT_LAMPORTS } from "./jupiter.mjs";
import { ExecutionJournal, LEGACY_CALL_IDENTITY_POLICY } from "./journal.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import { DEFAULTS, freshState, openPosition } from "./strategy.mjs";

const MINT = process.env.TEST_MINT;
const LAMPORTS = 1e9;
const log = (...a) => console.log(new Date().toISOString(), "CLOSEOUT", ...a);
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("./burner.json", "utf8"))));
const WALLET = kp.publicKey.toBase58();
const conn = new Connection(process.env.SOLANA_RPC, "confirmed");
const secondary = new Connection(process.env.SOLANA_RPC_SECONDARY, "confirmed");
const journal = new ExecutionJournal("./.roundtrip-test.sqlite", { wallet: WALLET });

// ── 1. account the confirmed entry ─────────────────────────────────────────
// Idempotent: a re-run after a failed sell finds the entry already accounted.
const pending = journal.pendingIntents().find((i) => i.kind === "entry" && i.mint === MINT);
const entry = pending || (() => {
  const row = journal.db.prepare(
    "SELECT id FROM intents WHERE kind='entry' AND mint=? AND state='accounted' ORDER BY created_at DESC LIMIT 1").get(MINT);
  return row ? journal.getIntent(row.id) : null;
})();
if (!entry) throw new Error("no entry intent (pending or accounted) for this mint");
if (entry.state !== "confirmed" && entry.state !== "accounted")
  throw new Error(`entry is ${entry.state}, not confirmed/accounted`);
const alreadyAccounted = entry.state === "accounted";
const input = String(entry.actualInputRaw), output = String(entry.actualOutputRaw);
const fee = String(entry.networkFeeLamports);
log(`entry ${entry.id.slice(0, 40)}… confirmed: in ${input} out ${output} fee ${fee}`);

const ctx = entry.context || {};
const costBasisLamports = BigInt(input) + BigInt(fee);
const paidSol = Number(costBasisLamports) / LAMPORTS;
const ref = ctx.entryReference || {};
const stopRatio = Number(ref.stopRatio) > 0 && Number(ref.stopRatio) < 1 ? Number(ref.stopRatio) : 0.01;
const pos = openPosition({
  call: { mint: MINT, symbol: "TEST", ts: Number(ctx.openedAtMs) || Date.now(),
    stop: stopRatio, target: Number(ref.targetRatio) > 0 ? Number(ref.targetRatio) : null },
  sol: paidSol, fillPrice: 1, cfg: { stopBufferPct: DEFAULTS.stopBufferPct },
});
Object.assign(pos, {
  qtyRaw: output, paidSol, costBasisLamports: costBasisLamports.toString(),
  entryInputLamports: input, riskF: 0,
  openedAtMs: Number(ctx.openedAtMs) || entry.createdAt || Date.now(),
  entryIntentId: entry.id,
  // no originating call_id → the poller's legacy-identity quarantine, verbatim
  callIdentityIncomplete: true,
  callIdentityIncompleteReason: "probe entry has no originating call_id; new entries blocked until it closes",
  callIdentityPolicy: LEGACY_CALL_IDENTITY_POLICY,
  takeProfitX: 2, honorDeskTarget: false,
  marketMarkAtEntry: Number(ref.marketMark) > 0 ? Number(ref.marketMark) : undefined,
  marketMarkObservedAt: Number(ref.marketMarkAt) > 0 ? Number(ref.marketMarkAt) : undefined,
  solUsdAtEntry: Number(ctx.entryPreflight?.solUsd) > 0 ? Number(ctx.entryPreflight.solUsd) : 1,
  solUsdSource: ctx.entryPreflight?.solUsdSource === PYTH_SOL_USD_CACHE_SOURCE
    ? PYTH_SOL_USD_CACHE_SOURCE : "legacy-unverified",
  // no sizing plan → accounting quarantine; automatic price exits disarmed
  accountingIncomplete: true,
  accountingIncompleteReason: "probe entry has no durable sizing context; automatic price exits are quarantined",
});
const state = { ...freshState(Date.now()), openCount: 1, bookHeat: 0,
  deployedTodaySol: paidSol };
if (alreadyAccounted) log(`entry already accounted — position ${output} raw, cost ${paidSol.toFixed(6)} SOL`);
else {
  journal.markAccounted(entry.id, { state, positions: { [MINT]: pos } });
  log(`entry ACCOUNTED — position ${output} raw, cost ${paidSol.toFixed(6)} SOL (quarantined, exit-only)`);
}

// ── 2. sell it all back ─────────────────────────────────────────────────────
const jupiter = new JupiterV2Executor({
  connection: conn, secondaryConnection: secondary, keypair: kp, journal,
  apiKey: process.env.JUPITER_API_KEY, baseUrl: process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v2",
  hardStop: () => false, submissionGate: () => {}, log,
  config: { slippageBps: 300, maxPriceImpactPct: 5, maxExitPriceImpactPct: 50, maxFeeBps: 100,
    // Matches the poller's live gate. An emergency exit must never refuse a fee the
  // automated entry would have paid: the one real live round trip paid 92 lamports of
  // priority on the entry and 280,276 on the EXIT, so the exit leg is the hungry one.
  maxNetworkFeeLamports: 2_000_000, expectedNetworkFeeLamports: 500_000, maxNetworkFeePct: 10, maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
    maxAttempts: 3, maxExitAttempts: 12, blockHeightWindow: 600, maxQuoteShortfallPct: 15,
    finalityTimeoutMs: 60_000 },
});
const before = await conn.getBalance(kp.publicKey);
log(`selling ${output} raw units back to SOL`);
const exit = await jupiter.executeIntent({
  id: `roundtrip-exit:${MINT}:${Date.now()}`, kind: "risk_exit", eventId: null, feedId: null,
  mint: MINT, inputMint: MINT, outputMint: WSOL, amountRaw: output,
  context: { wallet: WALLET, position: pos, reason: "round-trip probe close" },
});
log(`SELL CONFIRMED  signature ${exit.signature}`);
log(`  returned ${exit.actualOutputRaw} lamports, fee ${exit.networkFeeLamports}`);
const after = await conn.getBalance(kp.publicKey);
log(`SOL ${(before / LAMPORTS).toFixed(6)} → ${(after / LAMPORTS).toFixed(6)}`);
log(`PROOF buy : https://solscan.io/tx/${entry.signature}`);
log(`PROOF sell: https://solscan.io/tx/${exit.signature}`);
journal.close();
