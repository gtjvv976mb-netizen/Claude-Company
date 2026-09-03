import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import { validateEntryPreflightContext } from "./entry-quote-guard.mjs";
import {
  ATA_PROGRAM, JUPITER_EVENT_AUTHORITY, JUPITER_V6, JupiterV2Executor,
  EXECUTION_READINESS_AMOUNT_LAMPORTS, EXECUTION_READINESS_RESERVE_LAMPORTS,
  EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS,
  MAINNET_USDC, MAX_GROSS_RENT_LAMPORTS, MIN_SIGNABLE_BLOCKS_REMAINING,
  TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL,
  coherentAccountSnapshot, decodeJupiterExactIn,
  fencedProcessedEpochHeight,
  isClosedAccountTombstone, validateOrderEnvelope,
  validateSimulationEffects, validateTransaction, verifyFinalizedFill, priceImpactCapForIntent,
  classicMintDecimals, independentClassicMintDecimals, processedSlotFreshnessAnchor,
  writableAccountSafetyFingerprint,
} from "./jupiter.mjs";
import {
  createSolanaRpcDeadlineFetch, solanaRpcConnectionConfig,
} from "./sol-usd-oracle.mjs";

let pass = 0;
const ok = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ok   ${name}`);
};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const cfg = {
  slippageBps: 300, maxPriceImpactPct: 5, maxFeeBps: 100,
  maxNetworkFeeLamports: 3_000_000, maxComputeUnits: 1_400_000,
};

await ok("Solana Connection HTTP deadlines abort every transport without accumulating requests", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  let aborts = 0;
  const seenSignals = new Set();
  const seenMethods = new Set();
  const hangingFetch = (_input, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal;
    assert.ok(signal instanceof AbortSignal, "web3 transport must receive the owned abort signal");
    const payload = JSON.parse(String(init.body));
    seenMethods.add(payload.method);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    seenSignals.add(signal);
    const aborted = () => {
      inFlight--;
      aborts++;
      reject(signal.reason);
    };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
  const connection = new Connection("https://rpc.invalid", solanaRpcConnectionConfig({
    fetchFn: hangingFetch, requestTimeoutMs: 15,
  }));
  const rpcWallet = Keypair.generate();
  const rpcAddress = Keypair.generate().publicKey;
  const rpcSignature = bs58.encode(Buffer.alloc(64));
  const rpcTransaction = new VersionedTransaction(new TransactionMessage({
    payerKey: rpcWallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message());
  const requestWave = () => [
    connection.getGenesisHash(),
    // Address-table and mint/custody reads all traverse getAccountInfo.
    connection.getAddressLookupTable(rpcAddress),
    connection.getAccountInfo(rpcAddress, "confirmed"),
    connection.getMinimumBalanceForRentExemption(165, "processed"),
    connection.getBlockHeight("confirmed"),
    connection.simulateTransaction(rpcTransaction, {
      commitment: "processed", sigVerify: false, replaceRecentBlockhash: false,
    }),
    connection.getSignatureStatuses([rpcSignature], { searchTransactionHistory: true }),
    connection.getTransaction(rpcSignature, {
      commitment: "finalized", maxSupportedTransactionVersion: 0,
    }),
  ];

  for (let wave = 0; wave < 2; wave++) {
    const results = await Promise.allSettled(requestWave());
    assert.ok(results.every((result) => result.status === "rejected" &&
      /Solana RPC HTTP request timed out after 15ms/.test(result.reason?.message)));
    assert.equal(inFlight, 0, "every timed-out HTTP attempt must observe cancellation before settlement");
  }
  assert.equal(aborts, 16);
  assert.equal(seenSignals.size, 16, "each HTTP attempt needs its own AbortController");
  assert.equal(peakInFlight, 8,
    "a later wave must not stack on transports abandoned by the prior timeout");
  assert.deepEqual([...seenMethods].sort(), [
    "getAccountInfo", "getBlockHeight", "getGenesisHash", "getMinimumBalanceForRentExemption",
    "getSignatureStatuses", "getTransaction", "simulateTransaction",
  ]);

  assert.throws(() => solanaRpcConnectionConfig({ requestTimeoutMs: 4_001 }),
    /request timeout is invalid/);
  assert.equal(solanaRpcConnectionConfig({ requestTimeoutMs: 1 }).disableRetryOnRateLimit, true,
    "web3.js must not create a hidden 429 retry queue outside executor recovery policy");

  let lateAborts = 0;
  const quickFetch = createSolanaRpcDeadlineFetch({
    requestTimeoutMs: 15,
    fetchFn: async (_input, init = {}) => {
      init.signal.addEventListener("abort", () => { lateAborts++; }, { once: true });
      return new Response("ok");
    },
  });
  assert.equal((await quickFetch("https://rpc.invalid")).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lateAborts, 0, "a completed request must clear its deadline timer");

  let bodyReads = 0;
  let bodyAborts = 0;
  const stalledBodyFetch = createSolanaRpcDeadlineFetch({
    requestTimeoutMs: 15,
    fetchFn: async (_input, init = {}) => ({
      status: 200, statusText: "OK", headers: new Headers(),
      arrayBuffer: async () => new Promise((resolve, reject) => {
        bodyReads++;
        const aborted = () => { bodyAborts++; reject(init.signal.reason); };
        if (init.signal.aborted) aborted();
        else init.signal.addEventListener("abort", aborted, { once: true });
      }),
    }),
  });
  await assert.rejects(() => stalledBodyFetch("https://rpc.invalid"),
    /Solana RPC HTTP request timed out after 15ms/);
  assert.equal(bodyReads, 1);
  assert.equal(bodyAborts, 1,
    "headers alone must not release the deadline while the JSON response body is hung");
});

const wallet = Keypair.generate();
const mint = Keypair.generate().publicKey.toBase58();
// Every custody/mint read traverses getAccountInfo; the mint audit needs real bytes.
const classicMintFixture = ({ decimals = 6 } = {}) => {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { owner: new PublicKey(TOKEN_PROGRAM), data };
};
// A pump.fun-style Token-2022 mint: MetadataPointer + TokenMetadata, no authorities.
const token2022MintFixture = (extraEntries = []) => {
  const entry = (type, length, fill) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type, 0);
    header.writeUInt16LE(length, 2);
    return Buffer.concat([header, Buffer.alloc(length, fill)]);
  };
  const data = Buffer.concat([classicMintFixture().data, Buffer.alloc(83), Buffer.from([1]),
    entry(18, 64, 1), entry(19, 120, 2), ...extraEntries.map(([type, length]) => entry(type, length, 3))]);
  return { owner: new PublicKey(TOKEN_2022_PROGRAM), data };
};
const orderBase = {
  mode: "manual", inputMint: WSOL, outputMint: mint, inAmount: "5000000",
  outAmount: "1000", otherAmountThreshold: "970", swapMode: "ExactIn",
  slippageBps: 300, priceImpact: 0.5, feeBps: 50, gasless: false,
  feeMint: WSOL, platformFee: { amount: "5", feeBps: 10, feeMint: WSOL },
  signatureFeeLamports: 5000, prioritizationFeeLamports: 10000, rentFeeLamports: 0,
  signatureFeePayer: wallet.publicKey.toBase58(),
  prioritizationFeePayer: wallet.publicKey.toBase58(),
  rentFeePayer: wallet.publicKey.toBase58(), router: "metis",
  transaction: "base64", lastValidBlockHeight: "999", requestId: "request-1",
  taker: wallet.publicKey.toBase58(),
};
const entryGuardContext = (now = 1000) => ({
  event: { stop: 0.8, target: 1.5 },
  entryReference: { marketMark: 1, entryLow: 0.9, entryHigh: 1.1 },
  entryPreflight: { inputAmountRaw: "5000000", forwardOutputRaw: "1000",
    tokenDecimals: 3, solUsd: 200, observedAt: now,
    solUsdSource: "pyth-sol-usd-shard0-v1", solUsdPublishTime: Math.floor(now / 1_000),
    solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.1 },
});

await ok("order envelope is exact-in, Metis-only and capped", async () => {
  assert.equal(validateOrderEnvelope(orderBase, {
    inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet: wallet.publicKey.toBase58(),
  }, cfg), orderBase);
});
await ok("wrong mint, amount, router, fees and payer fail closed", async () => {
  const expected = { inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet: wallet.publicKey.toBase58() };
  assert.throws(() => validateOrderEnvelope({ ...orderBase, outputMint: WSOL }, expected, cfg), /output mint/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase, inAmount: "5000001" }, expected, cfg), /raw input/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase, router: "jupiterz" }, expected, cfg), /Metis-only/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase, feeBps: 101 }, expected, cfg), /exceeds cap/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase,
    platformFee: { ...orderBase.platformFee, feeBps: 51 } }, expected, cfg), /platform fee/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase, signatureFeePayer: mint }, expected, cfg), /not the local wallet/);
});
await ok("price-impact evidence and relative network fees fail closed", async () => {
  const expected = { inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    wallet: wallet.publicKey.toBase58() };
  const { priceImpact: _missing, ...missingImpact } = orderBase;
  assert.throws(() => validateOrderEnvelope(missingImpact, expected, cfg), /price impact is missing/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase, priceImpactPct: 0.02 }, expected, cfg),
    /conflicting price-impact fields/);
  assert.throws(() => validateOrderEnvelope({ ...orderBase,
    signatureFeeLamports: 250_001, prioritizationFeeLamports: 250_000 }, expected, cfg),
  /estimated network fees exceed 10%/);
});
await ok("entry and emergency-exit impact caps are distinct", async () => {
  assert.equal(priceImpactCapForIntent("entry", { maxPriceImpactPct: 5,
    maxExitPriceImpactPct: 50 }), 5);
  assert.equal(priceImpactCapForIntent("risk_exit", { maxPriceImpactPct: 5,
    maxExitPriceImpactPct: 50 }), 50);
  const stressed = { ...orderBase, priceImpact: 25 };
  const expected = { inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    wallet: wallet.publicKey.toBase58() };
  assert.throws(() => validateOrderEnvelope(stressed, expected, cfg), /price impact 25% exceeds cap 5%/);
  assert.equal(validateOrderEnvelope(stressed, expected,
    { ...cfg, maxPriceImpactPct: 50 }), stressed);
});

const recentBlockhash = Keypair.generate().publicKey.toBase58();
const ata = (owner, tokenMint, tokenProgram = TOKEN_PROGRAM) => PublicKey.findProgramAddressSync([
  owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(tokenMint).toBuffer(),
], new PublicKey(ATA_PROGRAM))[0];
const sourceAta = ata(wallet.publicKey, WSOL);
const destinationAta = ata(wallet.publicKey, mint);
const routeV2Data = ({ amount = 5_000_000n, quoted = 1_000n, slippage = 300,
  platformFee = 10 } = {}) => {
  const data = Buffer.alloc(39);
  Buffer.from("bb64facc31c4af14", "hex").copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(quoted, 16);
  data.writeUInt16LE(slippage, 24);
  data.writeUInt16LE(platformFee, 26);
  data.writeUInt16LE(0, 28);
  data.writeUInt32LE(1, 30);
  data[34] = 0;                 // Swap enum variant (simulation validates it)
  data.writeUInt16LE(10_000, 35);
  data[37] = 0;
  data[38] = 1;
  return data;
};
const jupiterIx = new TransactionInstruction({
  programId: new PublicKey(JUPITER_V6),
  keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    { pubkey: sourceAta, isSigner: false, isWritable: true },
    { pubkey: destinationAta, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(WSOL), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_EVENT_AUTHORITY), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
  ],
  data: routeV2Data(),
});
const destinationAta2022 = ata(wallet.publicKey, mint, TOKEN_2022_PROGRAM);
const jupiterIx2022 = new TransactionInstruction({
  programId: new PublicKey(JUPITER_V6),
  keys: jupiterIx.keys.map((key, index) => index === 2 ? { ...key, pubkey: destinationAta2022 }
    : index === 6 ? { ...key, pubkey: new PublicKey(TOKEN_2022_PROGRAM) } : key),
  data: routeV2Data(),
});
const wrap = SystemProgram.transfer({
  fromPubkey: wallet.publicKey, toPubkey: sourceAta, lamports: 5_000_000,
});
const makeTx = (instructions = [wrap, jupiterIx], payer = wallet.publicKey) => new VersionedTransaction(
  new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(),
);
const validationConnection = {
  getAddressLookupTable: async () => ({ value: null }),
  getAccountInfo: async () => classicMintFixture(),
  getSlot: async (commitment) => {
    assert.equal(commitment, "processed");
    return 699;
  },
  getMultipleAccountsInfoAndContext: async () => {
    throw new Error("atomic validation snapshot unexpectedly used getMultipleAccounts");
  },
  simulateTransaction: async (tx, options) => atomicCapabilitySnapshot(tx, options, {
    slot: 700,
    accountFor: (address) => address === wallet.publicKey.toBase58()
      ? systemAccount(20_000_000) : null,
  }),
};
const expectedTx = {
  wallet: wallet.publicKey.toBase58(), inputMint: WSOL, outputMint: mint,
  amountRaw: "5000000", quotedOutputRaw: "1000", minOutputRaw: "970",
  slippageBps: 300, platformFeeBps: 10,
};
const systemAccount = (lamports, simulated = false) => ({
  lamports,
  owner: simulated ? SystemProgram.programId.toBase58() : SystemProgram.programId,
  data: simulated ? ["", "base64"] : Buffer.alloc(0),
  executable: false, rentEpoch: 0,
});
const tokenAccount = ({ tokenMint, owner, amount, simulated = false, delegate = null,
  delegatedAmount = 0n, state = 1, closeAuthority = null, isNative = false,
  lamports = 2_039_280 }) => {
  const data = Buffer.alloc(165);
  new PublicKey(tokenMint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    new PublicKey(delegate).toBuffer().copy(data, 76);
  }
  data[108] = state;
  if (isNative) {
    data.writeUInt32LE(1, 109);
    data.writeBigUInt64LE(2_039_280n, 113);
  }
  data.writeBigUInt64LE(BigInt(delegatedAmount), 121);
  if (closeAuthority) {
    data.writeUInt32LE(1, 129);
    new PublicKey(closeAuthority).toBuffer().copy(data, 133);
  }
  return {
    lamports, owner: simulated ? TOKEN_PROGRAM : new PublicKey(TOKEN_PROGRAM),
    data: simulated ? [data.toString("base64"), "base64"] : data,
    executable: false, rentEpoch: 0,
  };
};

const SNAPSHOT_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const simulatedAccount = (account, lamports = account?.lamports) => {
  if (account == null) return null;
  const owner = account.owner?.toBase58?.() || String(account.owner);
  const data = Buffer.isBuffer(account.data)
    ? [account.data.toString("base64"), "base64"] : account.data;
  return { ...account, owner, data, lamports };
};
const atomicCapabilitySnapshot = (tx, options, { slot, accountFor, fee = 5_000 } = {}) => {
  assert.equal(options.sigVerify, false);
  assert.equal(options.replaceRecentBlockhash, false);
  assert.equal(options.innerInstructions, false);
  assert.equal(options.accounts.encoding, "base64");
  assert.ok(Number.isSafeInteger(options.minContextSlot));
  assert.ok(slot >= options.minContextSlot);
  assert.equal(tx.message.recentBlockhash, recentBlockhash);
  assert.equal(tx.message.addressTableLookups.length, 0);
  assert.equal(tx.message.compiledInstructions.length, 1);
  assert.ok(tx.signatures.every((signature) =>
    Buffer.from(signature).every((byte) => byte === 0)), "snapshot probe must stay unsigned");
  const staticAddresses = tx.message.staticAccountKeys.map((key) => key.toBase58());
  assert.equal(new Set(staticAddresses).size, staticAddresses.length);
  const memoIndex = staticAddresses.indexOf(SNAPSHOT_MEMO_PROGRAM);
  assert.ok(memoIndex > 0);
  const memo = tx.message.compiledInstructions[0];
  assert.equal(memo.programIdIndex, memoIndex);
  assert.deepEqual(memo.accountKeyIndexes, []);
  assert.equal(Buffer.from(memo.data).toString("utf8"), "W");
  const payer = staticAddresses[0];
  const accountAt = (address) => {
    if (address === SNAPSHOT_MEMO_PROGRAM) return systemAccount(1);
    return accountFor?.(address, options.commitment) ??
      (address === payer ? systemAccount(20_000_000) : null);
  };
  for (const address of options.accounts.addresses) {
    const index = staticAddresses.indexOf(address);
    assert.ok(index >= 0, "every requested address must be a direct static probe key");
    if (index !== 0) assert.equal(tx.message.isAccountWritable(index), false);
  }
  const preBalances = staticAddresses.map((address) => accountAt(address)?.lamports ?? 0);
  const postBalances = [...preBalances];
  postBalances[0] -= fee;
  assert.ok(postBalances[0] >= 0);
  const accounts = options.accounts.addresses.map((address) => {
    const account = accountAt(address);
    if (account == null) return null;
    const lamports = address === payer ? account.lamports - fee : account.lamports;
    assert.ok(Number.isSafeInteger(lamports) && lamports >= 0);
    return simulatedAccount(account, lamports);
  });
  return { context: { slot }, value: {
    err: null, accounts, logs: [], fee, preBalances, postBalances,
  } };
};

await ok("one atomic Memo snapshot covers more than five accounts and advances its retry floor", async () => {
  const keys = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
  const index = new Map(keys.map((key, i) => [key.toBase58(), i]));
  let wholeAttempt = 0;
  const seenFloors = [];
  const connection = {
    simulateTransaction: async (tx, options) => {
      wholeAttempt++;
      seenFloors.push({ attempt: wholeAttempt, floor: options.minContextSlot });
      if (wholeAttempt === 1) {
        const error = new Error("synthetic lagging backend");
        error.data = { contextSlot: 101 };
        throw error;
      }
      const response = atomicCapabilitySnapshot(tx, options, {
        slot: wholeAttempt === 2 ? 102 : 103,
        accountFor: (address) => index.has(address)
          ? systemAccount(wholeAttempt * 100 + index.get(address)) : null,
      });
      if (wholeAttempt === 2) response.value.accounts = [];
      return response;
    },
  };
  const source = makeTx();
  const sourceBytes = Buffer.from(source.serialize());
  const snapshot = await coherentAccountSnapshot(connection, keys, { transaction: source });
  assert.equal(snapshot.slot, 103);
  assert.deepEqual(snapshot.accounts.map((account) => account.lamports),
    Array.from({ length: 12 }, (_, i) => 300 + i),
  "rows from the discarded malformed attempt must never leak into the retry");
  assert.deepEqual(seenFloors, [
    { attempt: 1, floor: 0 },
    { attempt: 2, floor: 101 },
    { attempt: 3, floor: 102 },
  ], "returned error and response context slots must monotonically advance the retry floor");
  assert.deepEqual(Buffer.from(source.serialize()), sourceBytes,
    "snapshotting must not mutate or sign the Jupiter source transaction");
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.accounts));
});

await ok("failed and hanging atomic snapshot simulations fail closed within bounded attempts", async () => {
  const keys = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  let attempt = 0;
  const failed = {
    simulateTransaction: async (tx, options) => {
      attempt++;
      const response = atomicCapabilitySnapshot(tx, options, {
        slot: options.minContextSlot + 1, accountFor: () => null,
      });
      response.value.err = { InstructionError: [0, "InvalidInstructionData"] };
      return response;
    },
  };
  await assert.rejects(() => coherentAccountSnapshot(failed, keys, { transaction: makeTx() }),
    /could not produce one coherent exact-slot account snapshot after 3 attempts/);
  assert.equal(attempt, 3);
  const hanging = {
    simulateTransaction: async () => new Promise(() => {}),
  };
  await assert.rejects(() => coherentAccountSnapshot(hanging, [keys[0]], {
    transaction: makeTx(), attempts: 1, requestTimeoutMs: 5,
  }), /could not produce one coherent exact-slot account snapshot/);
});

await ok("processed epoch height retries lagging backends and proves its returned bank slot", async () => {
  const replies = [
    new Error("Minimum context slot has not been reached"),
    { absoluteSlot: 699, blockHeight: 650 },
    { absoluteSlot: 705, blockHeight: null },
    { absoluteSlot: 705, blockHeight: 651 },
  ];
  const configs = [];
  const delays = [];
  const evidence = await fencedProcessedEpochHeight({
    getEpochInfo: async (config) => {
      configs.push(config);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  }, 700, { sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(evidence, { absoluteSlot: 705, blockHeight: 651 });
  assert.ok(Object.isFrozen(evidence));
  assert.deepEqual(configs, [
    { commitment: "processed", minContextSlot: 700 },
    { commitment: "processed", minContextSlot: 700 },
    { commitment: "processed", minContextSlot: 700 },
    { commitment: "processed", minContextSlot: 705 },
  ], "a malformed newer-bank response must monotonically advance the retry floor");
  assert.deepEqual(delays, [100, 200, 300]);
});

await ok("processed epoch height has no unfenced or impossible-height fallback", async () => {
  let reads = 0;
  await assert.rejects(() => fencedProcessedEpochHeight({
    getEpochInfo: async (config) => {
      reads++;
      assert.equal(config.commitment, "processed");
      return { absoluteSlot: 700, blockHeight: 701 };
    },
  }, 700, { retryDelayMs: 0 }),
  /could not produce a processed epoch height at or above slot 700 after 4 attempts/);
  assert.equal(reads, 4);
  await assert.rejects(() => fencedProcessedEpochHeight({
    getEpochInfo: async () => new Promise(() => {}),
  }, 700, { attempts: 1, requestTimeoutMs: 5, retryDelayMs: 0 }),
  /could not produce a processed epoch height/);
  await assert.rejects(() => fencedProcessedEpochHeight({ getBlockHeight: async () => 650 }, 700),
    /lacks context-fenced epoch-height support/);
});

await ok("atomic snapshot probes reject duplicate keys, signed sources and oversized packets", async () => {
  const key = Keypair.generate().publicKey;
  await assert.rejects(() => coherentAccountSnapshot(validationConnection, [key, key], {
    transaction: makeTx(),
  }), /addresses must be unique/);
  const signed = makeTx();
  signed.signatures[0] = new Uint8Array(64).fill(1);
  await assert.rejects(() => coherentAccountSnapshot(validationConnection, [key], {
    transaction: signed,
  }), /not unsigned/);
  /* 40 keys no longer fits one probe (1232-byte packet) — and no longer needs to.
   * The set is split across probes that must all land on ONE exact slot. */
  const many = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
  const chunked = await coherentAccountSnapshot(validationConnection, many, { transaction: makeTx() });
  assert.equal(chunked.accounts.length, 40, "every requested row comes back");
  assert.equal(chunked.slot, 700, "one slot for the whole set");
  // A chunk that lands on a newer bank proves the set is not coherent: refused, never stitched.
  let calls = 0;
  const movingBank = { ...validationConnection,
    simulateTransaction: async (tx, options) => atomicCapabilitySnapshot(tx, options, {
      slot: 700 + (calls++ % 2), accountFor: () => null }) };
  await assert.rejects(() => coherentAccountSnapshot(movingBank, many, {
    transaction: makeTx(), attempts: 2,
  }), /could not produce one coherent exact-slot account snapshot/);
});

await ok("atomic snapshots require internally consistent same-response balance evidence", async () => {
  const key = Keypair.generate().publicKey;
  const mutations = [
    (response) => { delete response.value.err; },
    (response) => { delete response.value.preBalances; },
    (response) => { response.value.fee = null; },
    (response) => { response.value.fee = "5000"; },
    (response) => { response.value.fee = 0; response.value.postBalances[0] = response.value.preBalances[0]; },
    (response) => { response.value.postBalances[0]++; },
    (response, tx) => {
      const index = tx.message.staticAccountKeys.findIndex((candidate) => candidate.equals(key));
      response.value.postBalances[index]++;
    },
    (response) => { response.value.accounts[0].lamports++; },
  ];
  for (const mutate of mutations) {
    const connection = {
      simulateTransaction: async (tx, options) => {
        const response = atomicCapabilitySnapshot(tx, options, {
          slot: 700, accountFor: (address) => address === key.toBase58()
            ? systemAccount(123_456) : null,
        });
        mutate(response, tx);
        return response;
      },
    };
    await assert.rejects(() => coherentAccountSnapshot(connection, [key], {
      transaction: makeTx(), attempts: 1,
    }), /could not produce one coherent exact-slot account snapshot/);
  }
});

await ok("writable safety fingerprints ignore balances but retain authority capabilities", async () => {
  const addresses = [wallet.publicKey.toBase58(), destinationAta.toBase58()];
  const first = [systemAccount(20_000_000), tokenAccount({
    tokenMint: mint, owner: wallet.publicKey, amount: 1, delegatedAmount: 0n,
  })];
  first[0].rentEpoch = 1;
  const second = [systemAccount(99_000_000), tokenAccount({
    tokenMint: mint, owner: wallet.publicKey, amount: 999_999, delegatedAmount: 77n,
  })];
  second[0].rentEpoch = 999;
  assert.equal(writableAccountSafetyFingerprint(addresses, first),
    writableAccountSafetyFingerprint(addresses, second));
  const delegate = Keypair.generate().publicKey;
  const changed = [second[0], tokenAccount({
    tokenMint: mint, owner: wallet.publicKey, amount: 999_999,
    delegate, delegatedAmount: 77n,
  })];
  assert.notEqual(writableAccountSafetyFingerprint(addresses, first),
    writableAccountSafetyFingerprint(addresses, changed));
});

await ok("only the exact numeric-zero closed-account tombstone is treated as missing", async () => {
  const exact = systemAccount(0);
  assert.equal(isClosedAccountTombstone(exact), true);
  assert.equal(isClosedAccountTombstone({ ...exact, lamports: "0" }), false);
  assert.equal(isClosedAccountTombstone({ ...exact, lamports: 1 }), false);
  assert.equal(isClosedAccountTombstone({ ...exact, executable: true }), false);
  assert.equal(isClosedAccountTombstone({ ...exact, owner: new PublicKey(TOKEN_PROGRAM) }), false);
  assert.equal(isClosedAccountTombstone({ ...exact, data: Buffer.from([0]) }), false);
});

const exitAmountRaw = "1000";
const exitQuotedOutputRaw = "5000000";
const exitMinOutputRaw = "4850000";
const exitRoute = new TransactionInstruction({
  programId: new PublicKey(JUPITER_V6),
  keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    { pubkey: destinationAta, isSigner: false, isWritable: true },
    { pubkey: sourceAta, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(WSOL), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_EVENT_AUTHORITY), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
  ],
  data: routeV2Data({ amount: 1_000n, quoted: 5_000_000n }),
});
const makeExitMarkHarness = ({ payer = wallet.publicKey, presigned = false,
  chainHeight = 600, postOutputRaw = "4900000", secondaryPostOutputRaw = postOutputRaw,
  secondarySimulationError = null, orderOverrides = {}, finalChainHeight = chainHeight,
  secondaryWritableOverride = null, primaryPostWritableOverride = null,
  primaryWritableOverride = null,
  simulationContextSlot = 702, instructions = [exitRoute] } = {}) => {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash, instructions,
  }).compileToV0Message());
  if (presigned) transaction.signatures[0] = new Uint8Array(64).fill(7);
  const order = {
    ...orderBase,
    inputMint: mint,
    outputMint: WSOL,
    inAmount: exitAmountRaw,
    outAmount: exitQuotedOutputRaw,
    otherAmountThreshold: exitMinOutputRaw,
    priceImpact: 25,
    feeMint: mint,
    platformFee: { amount: "5", feeBps: 10, feeMint: WSOL },
    transaction: Buffer.from(transaction.serialize()).toString("base64"),
    ...orderOverrides,
  };
  const calls = { order: 0, execute: 0, simulate: 0, journal: 0, secretKey: 0 };
  const connectionFor = (simulatedOutputRaw, simulationError = null, writableOverride = null,
    postWritableOverride = null) => {
    let heightReads = 0;
    let didSimulate = false;
    return {
    getAddressLookupTable: async () => ({ value: null }),
    getAccountInfo: async () => classicMintFixture(),
    getSlot: async (commitment) => {
      assert.equal(commitment, "processed");
      return 701;
    },
    getMultipleAccountsInfoAndContext: async () => {
      throw new Error("atomic snapshot path unexpectedly used getMultipleAccounts");
    },
    getBlockHeight: async (commitment) => {
      assert.equal(commitment, "confirmed");
      assert.equal(heightReads++, 0, "final height must use same-bank epoch evidence");
      return chainHeight;
    },
    getEpochInfo: async (config) => {
      assert.deepEqual(config, { commitment: "processed", minContextSlot: 702 });
      return { absoluteSlot: Math.max(702, finalChainHeight), blockHeight: finalChainHeight };
    },
    getMinimumBalanceForRentExemption: async (_size, commitment) => {
      assert.equal(commitment, "processed");
      return 2_039_280;
    },
    simulateTransaction: async (tx, options) => {
      const accountFor = (address) => {
        if (address === wallet.publicKey.toBase58()) return systemAccount(20_000_000);
        let account = null;
        if (address === destinationAta.toBase58())
          account = tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: exitAmountRaw });
        else if (address === sourceAta.toBase58())
          account = tokenAccount({ tokenMint: WSOL, owner: wallet.publicKey, amount: "0" });
        if (writableOverride) account = writableOverride(address, account, options.commitment);
        if (didSimulate && postWritableOverride)
          account = postWritableOverride(address, account, options.commitment);
        return account;
      };
      if (options.innerInstructions === false) {
        const slot = options.commitment === "processed" ? 702 : 700;
        return atomicCapabilitySnapshot(tx, options, { slot, accountFor });
      }
      calls.simulate++;
      if (simulationError) throw simulationError;
      assert.equal(options.sigVerify, false);
      assert.equal(options.replaceRecentBlockhash, false);
      assert.ok(tx.signatures.every((signature) =>
        Buffer.from(signature).every((byte) => byte === 0)), "simulation must receive unsigned bytes");
      const output = BigInt(simulatedOutputRaw);
      assert.equal(options.minContextSlot, 702);
      didSimulate = true;
      return { context: { slot: simulationContextSlot }, value: {
        err: null,
        accounts: [
          systemAccount(20_000_000, true),
          tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: "0", simulated: true }),
          tokenAccount({ tokenMint: WSOL, owner: wallet.publicKey, amount: simulatedOutputRaw,
            lamports: Number(2_039_280n + output), simulated: true }),
        ],
        innerInstructions: [],
      } };
    },
  };
  };
  const connection = connectionFor(postOutputRaw, null, primaryWritableOverride, primaryPostWritableOverride);
  const secondaryConnection = connectionFor(secondaryPostOutputRaw, secondarySimulationError,
    secondaryWritableOverride);
  const fetchFn = async (url) => {
    if (String(url).includes("/order?")) {
      calls.order++;
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("swapMode"), "ExactIn");
      assert.equal(parsed.searchParams.get("taker"), wallet.publicKey.toBase58());
      return response(order);
    }
    calls.execute++;
    throw new Error("read-only exit mark attempted a non-order Jupiter request");
  };
  const keypair = {
    publicKey: wallet.publicKey,
    get secretKey() { calls.secretKey++; throw new Error("read-only exit mark attempted to sign"); },
  };
  const journal = new Proxy({}, { get() {
    calls.journal++;
    throw new Error("read-only exit mark touched the execution journal");
  } });
  const executor = new JupiterV2Executor({
    connection, secondaryConnection, keypair, journal, apiKey: "test-key", fetchFn,
    hardStop: () => true, now: () => 1_000, sleep: async () => {}, config: cfg,
  });
  const spec = { mint, amountRaw: exitAmountRaw,
    position: { mint, qtyRaw: exitAmountRaw, costBasisLamports: "5000000" } };
  return { executor, spec, calls, connection, secondaryConnection, fetchFn };
};
const mintAccount = ({ decimals = 6, initialized = true, owner = TOKEN_PROGRAM } = {}) => {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  return { owner: new PublicKey(owner), data };
};

await ok("classic mint decimals are read from the on-chain mint layout", async () => {
  assert.equal(await classicMintDecimals({
    getAccountInfo: async () => mintAccount({ decimals: 6 }),
  }, mint), 6);
  await assert.rejects(() => classicMintDecimals({
    getAccountInfo: async () => mintAccount({ decimals: 19 }),
  }, mint), /outside the live canary range/);
  await assert.rejects(() => classicMintDecimals({
    getAccountInfo: async () => ({ owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(12) }),
  }, mint), /classic SPL mint layout/);
});

await ok("entry mint metadata requires two valid, matching RPC views", async () => {
  const connection = (value, rejection = null) => ({
    async getAccountInfo() { if (rejection) throw rejection; return value; },
  });
  assert.equal(await independentClassicMintDecimals(
    connection(mintAccount({ decimals: 6 })), connection(mintAccount({ decimals: 6 })), mint), 6);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(mintAccount({ decimals: 6 })), connection(mintAccount({ decimals: 9 })), mint),
  /disagree on decimals/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(mintAccount()), connection(mintAccount({ owner: PublicKey.default.toBase58() })), mint),
  /rejected.*not owned by classic SPL Token/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(mintAccount()), {
      getAccountInfo: async () => ({ owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(12) }),
    }, mint), /rejected.*classic SPL mint layout/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(mintAccount()), connection(mintAccount({ initialized: false })), mint),
  /rejected.*not initialized/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(mintAccount()), connection(null, new Error("secret RPC endpoint")), mint),
  /successful reads from both RPC providers/);
  const same = connection(mintAccount());
  await assert.rejects(() => independentClassicMintDecimals(same, same, mint),
    /two distinct RPC connections/);
});

await ok("one locally authorized Jupiter route passes instruction validation", async () => {
  const result = await validateTransaction(makeTx(), expectedTx, cfg, validationConnection);
  assert.equal(result.jupiterRoutes, 1);
});
await ok("initial merged snapshots require one valid processed-slot freshness anchor", async () => {
  let slotReads = 0;
  let snapshots = 0;
  const invalid = {
    ...validationConnection,
    getSlot: async (commitment) => {
      slotReads++;
      assert.equal(commitment, "processed");
      return 0;
    },
    simulateTransaction: async () => {
      snapshots++;
      throw new Error("an invalid anchor must stop before the snapshot");
    },
  };
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg, invalid),
    /invalid processed-slot freshness anchor/);
  assert.equal(slotReads, 1);
  assert.equal(snapshots, 0);

  const unavailable = {
    ...validationConnection,
    getSlot: async () => { throw new Error("synthetic provider outage"); },
  };
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg, unavailable),
    /could not obtain a processed-slot freshness anchor/);

  let hangingReads = 0;
  const startedAt = Date.now();
  await assert.rejects(() => processedSlotFreshnessAnchor({
    getSlot: async () => {
      hangingReads++;
      return new Promise(() => {});
    },
  }, { requestTimeoutMs: 5 }), /could not obtain a processed-slot freshness anchor/);
  assert.equal(hangingReads, 1, "the timeout must not retry or duplicate the provider read");
  assert.ok(Date.now() - startedAt < 500,
    "a never-settling provider must fail closed near the injected timeout");

  let invalidTimeoutReads = 0;
  await assert.rejects(() => processedSlotFreshnessAnchor({
    getSlot: async () => { invalidTimeoutReads++; return 700; },
  }, { requestTimeoutMs: Number.MAX_SAFE_INTEGER }),
  /freshness-anchor request timeout is invalid/);
  assert.equal(invalidTimeoutReads, 0, "an unbounded timeout must be rejected before RPC access");
});
await ok("real finalized v2 headers decode while legacy v1 routes fail closed", async () => {
  const data = Buffer.from(bs58.decode("37MZM8vwf4KFuQQxitaiaxCSbqJvxP37NUwZZG8Y3qFRiyEpohx2Wt"));
  const decoded = decodeJupiterExactIn(data, {
    amountRaw: "10000000", quotedOutputRaw: "11736363105", minOutputRaw: "11266908580",
    slippageBps: 400, maxSlippageBps: 400, platformFeeBps: 0,
  });
  assert.equal(decoded.name, "route_v2");
  assert.equal(decoded.routeSteps, 1);
  assert.throws(() => decodeJupiterExactIn(Buffer.from(bs58.decode(
    "PrpFmsY4d26dKbdKP4k8r1oY7poHQrRonwQkVzfM9BJN2c7Z")), {
    amountRaw: "2050366", quotedOutputRaw: "84017404281", minOutputRaw: "83177230238",
    slippageBps: 100, maxSlippageBps: 400, platformFeeBps: 0,
  }), /unsupported Jupiter instruction/);
  const legacy = Buffer.from(bs58.decode("PrpFmsY4d26dKbdKP4k8r1oY7poHQrRonwQkVzfM9BJN2c7Z"));
  const decoy = Buffer.alloc(19);
  decoy.writeBigUInt64LE(5_000_000n, 0);
  decoy.writeBigUInt64LE(1_000n, 8);
  decoy.writeUInt16LE(300, 16);
  decoy[18] = 10;
  assert.throws(() => decodeJupiterExactIn(Buffer.concat([legacy, decoy]), {
    amountRaw: "5000000", quotedOutputRaw: "1000", minOutputRaw: "970",
    slippageBps: 300, maxSlippageBps: 300, platformFeeBps: 10,
  }), /unsupported Jupiter instruction/);
  const shared = decodeJupiterExactIn(Buffer.from(bs58.decode(
    "CQ7Z1iuQV9mhH6jaUxM9fL8LgcD3gp1KpjLK9RubQRhTNtLHp7n5wdDTcQbpafjRHvbQ66")), {
    amountRaw: "100943579", quotedOutputRaw: "2249197", minOutputRaw: "2107497",
    slippageBps: 630, maxSlippageBps: 630, platformFeeBps: 87,
  });
  assert.equal(shared.name, "shared_accounts_route_v2");
  assert.equal(shared.routeSteps, 3);
});
await ok("arbitrary Jupiter bytes and either minimum-output mismatch fail closed", async () => {
  const arbitrary = new TransactionInstruction({
    programId: new PublicKey(JUPITER_V6), keys: jupiterIx.keys, data: Buffer.from([1, 2, 3]),
  });
  await assert.rejects(() => validateTransaction(makeTx([wrap, arbitrary]), expectedTx, cfg, validationConnection),
    /unsupported Jupiter instruction|truncated/);
  await assert.rejects(() => validateTransaction(makeTx(), { ...expectedTx, minOutputRaw: "900" }, cfg,
    validationConnection), /minimum output does not match/);
  await assert.rejects(() => validateTransaction(makeTx(), { ...expectedTx, minOutputRaw: "999" }, cfg,
    validationConnection), /minimum output does not match/);
});
await ok("wrong payer and arbitrary SOL transfer are rejected", async () => {
  await assert.rejects(() => validateTransaction(makeTx([wrap, jupiterIx], Keypair.generate().publicKey),
    expectedTx, cfg, validationConnection), /signer set|fee payer/);
  const theft = SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1,
  });
  await assert.rejects(() => validateTransaction(makeTx([theft, jupiterIx]), expectedTx,
    cfg, validationConnection), /arbitrary System Program transfer/);
});
await ok("token approve/authority capability is rejected", async () => {
  const approve = new TransactionInstruction({
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
    data: Buffer.from([4]),
  });
  await assert.rejects(() => validateTransaction(makeTx([wrap, approve, jupiterIx]), expectedTx,
    cfg, validationConnection), /token opcode 4/);
});
await ok("an unrelated wallet-owned token account cannot be writable", async () => {
  const auxiliary = Keypair.generate().publicKey;
  const route = new TransactionInstruction({
    programId: new PublicKey(JUPITER_V6),
    keys: [...jupiterIx.keys, { pubkey: auxiliary, isSigner: false, isWritable: true }],
    data: jupiterIx.data,
  });
  const connection = {
    ...validationConnection,
    simulateTransaction: async (tx, options) => atomicCapabilitySnapshot(tx, options, {
      slot: 700,
      accountFor: (address) => address === auxiliary.toBase58()
        ? tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 1 })
        : address === wallet.publicKey.toBase58() ? systemAccount(20_000_000) : null,
    }),
  };
  await assert.rejects(() => validateTransaction(makeTx([wrap, route]), expectedTx, cfg, connection),
    /unexpected wallet-owned token account/);
});
await ok("a wallet-owned capability beyond a provider's five-account tier is rejected atomically", async () => {
  const auxiliaries = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  const hidden = auxiliaries.at(-1);
  const route = new TransactionInstruction({
    programId: new PublicKey(JUPITER_V6),
    keys: [...jupiterIx.keys, ...auxiliaries.map((pubkey) => ({
      pubkey, isSigner: false, isWritable: true,
    }))],
    data: jupiterIx.data,
  });
  let snapshots = 0;
  const connection = {
    ...validationConnection,
    simulateTransaction: async (tx, options) => {
      snapshots++;
      assert.ok(options.accounts.addresses.length > 5);
      return atomicCapabilitySnapshot(tx, options, {
        slot: 700,
        accountFor: (address) => address === hidden.toBase58()
          ? tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 1 })
          : address === wallet.publicKey.toBase58() ? systemAccount(20_000_000) : null,
      });
    },
  };
  await assert.rejects(() => validateTransaction(makeTx([wrap, route]), expectedTx, cfg, connection),
    /unexpected wallet-owned token account/);
  assert.equal(snapshots, 1, "every adversarial capability must come from one bank response");
});
await ok("Token-2022 mints pass only with an audited extension list; truncated writable-account RPC data fails closed", async () => {
  const token2022Connection = (mintAccount) => ({
    ...validationConnection,
    getAccountInfo: async (key) => key.toBase58() === mint ? mintAccount : classicMintFixture(),
  });
  // A transfer-fee mint is refused by name before any custody check.
  await assert.rejects(() => validateTransaction(makeTx([wrap, jupiterIx2022]), expectedTx, cfg,
    token2022Connection(token2022MintFixture([[1, 108]]))), /Token-2022 extension TransferFeeConfig is refused/);
  // A mint that still has no account bytes on this RPC is refused, never guessed at.
  await assert.rejects(() => validateTransaction(makeTx([wrap, jupiterIx2022]), expectedTx, cfg,
    token2022Connection({ owner: new PublicKey(TOKEN_2022_PROGRAM) })), /unsupported account encoding/);
  // A route keyed to the classic ATA of a Token-2022 mint is a custody mismatch, not a pass.
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg,
    token2022Connection(token2022MintFixture())), (error) => !/Token-2022/.test(error.message));
  // The pump.fun shape (MetadataPointer + TokenMetadata) validates with Token-2022 custody.
  const validation = await validateTransaction(makeTx([wrap, jupiterIx2022]), expectedTx, cfg,
    token2022Connection(token2022MintFixture()));
  assert.equal(validation.inputProgram, TOKEN_PROGRAM);
  assert.equal(validation.outputProgram, TOKEN_2022_PROGRAM);
  assert.equal(validation.outputAta, destinationAta2022.toBase58());
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg, {
    ...validationConnection,
    simulateTransaction: async (tx, options) => {
      const response = atomicCapabilitySnapshot(tx, options, {
        slot: 700, accountFor: () => null,
      });
      response.value.accounts = [];
      return response;
    },
  }), /coherent exact-slot account snapshot/);
});
await ok("compute priority fees are capped relative to the signed trade basis", async () => {
  const expensivePriority = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 });
  await assert.rejects(() => validateTransaction(makeTx([expensivePriority, wrap, jupiterIx]),
    expectedTx, cfg, validationConnection), /priority fee exceeds 10%/);
});
await ok("simulation must show the exact SOL spend and minimum token receipt", async () => {
  const expected = {
    wallet: wallet.publicKey.toBase58(), inputMint: WSOL, outputMint: mint,
    // quotedOutputRaw joined the contract with the quote-vs-chain cross-check: the
    // simulated 987 sits inside the 15% band above a 970 quote — an honest fill.
    amountRaw: "5000000", quotedOutputRaw: "970", minOutputRaw: "970", inputProgram: TOKEN_PROGRAM,
    outputProgram: TOKEN_PROGRAM,
  };
  const before = { wallet: systemAccount(20_000_000), input: null, output: null };
  const after = { wallet: systemAccount(12_960_720, true), input: null,
    output: tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987, simulated: true }) };
  assert.deepEqual(validateSimulationEffects(before, after, expected, cfg), { actualOutputRaw: "987" });
  const tombstone = systemAccount(0, true);
  assert.deepEqual(validateSimulationEffects({ ...before, input: tombstone },
    { ...after, input: tombstone }, expected, cfg), { actualOutputRaw: "987" });
  assert.throws(() => validateSimulationEffects({ ...before, input: { ...tombstone, lamports: "0" } },
    { ...after, input: tombstone }, expected, cfg), /supported token account/);
  await assert.rejects(async () => validateSimulationEffects(before, {
    ...after,
    output: tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 969, simulated: true }),
  }, expected, cfg), /below the signed minimum/);
  const authority = Keypair.generate().publicKey;
  assert.throws(() => validateSimulationEffects(before, {
    ...after,
    output: tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987,
      delegate: authority, delegatedAmount: 1n, simulated: true }),
  }, expected, cfg), /delegated spending authority/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after,
    output: tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987,
      state: 2, simulated: true }),
  }, expected, cfg), /initialized and unfrozen/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after,
    output: tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987,
      closeAuthority: authority, simulated: true }),
  }, expected, cfg), /close authority/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after,
    input: tokenAccount({ tokenMint: WSOL, owner: wallet.publicKey, amount: 0,
      delegate: authority, delegatedAmount: 1n, simulated: true }),
  }, expected, cfg), /wrapped-SOL source account has delegated spending authority/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after, wallet: { ...after.wallet, owner: TOKEN_PROGRAM },
  }, expected, cfg), /no longer System Program owned/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after, wallet: { ...after.wallet, data: [Buffer.from([1]).toString("base64"), "base64"] },
  }, expected, cfg), /unexpected account data/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after, wallet: { ...after.wallet, executable: true },
  }, expected, cfg), /executable flag is invalid/);
  assert.throws(() => validateSimulationEffects(before, {
    ...after, wallet: { ...after.wallet, lamports: Number.MAX_SAFE_INTEGER + 1 },
  }, expected, cfg), /invalid lamport balance/);
});

await ok("read-only exit mark returns the chain-simulated SOL delta without signing or execution", async () => {
  const { executor, spec, calls } = makeExitMarkHarness();
  const mark = await executor.preflightExitMark(spec);
  assert.deepEqual(mark, {
    inputMint: mint,
    outputMint: WSOL,
    inputAmountRaw: exitAmountRaw,
    actualOutputRaw: "4900000",
    quotedOutputRaw: exitQuotedOutputRaw,
    minOutputRaw: exitMinOutputRaw,
    priceImpactPct: 25,
    slippageBps: 300,
    router: "metis",
    measurement: "simulated_net_wallet_custody_delta",
    finalized: false,
    providers: 2,
    providerDivergencePct: 0,
    chainHeight: 600,
    lastValidBlockHeight: 999,
    observedAt: 1_000,
  });
  assert.ok(Object.isFrozen(mark));
  assert.equal("transaction" in mark, false);
  assert.equal("requestId" in mark, false);
  assert.deepEqual(calls, { order: 1, execute: 0, simulate: 2, journal: 0, secretKey: 0 });
});

await ok("read-only exit mark fails closed on malicious bytes, expiry and simulated custody", async () => {
  const wrongPayer = makeExitMarkHarness({ payer: Keypair.generate().publicKey });
  await assert.rejects(() => wrongPayer.executor.preflightExitMark(wrongPayer.spec), /signer set|fee payer/);
  assert.deepEqual(wrongPayer.calls, { order: 1, execute: 0, simulate: 0, journal: 0, secretKey: 0 });

  const prefilledSignature = makeExitMarkHarness({ presigned: true });
  await assert.rejects(() => prefilledSignature.executor.preflightExitMark(prefilledSignature.spec), /not unsigned/);
  assert.deepEqual(prefilledSignature.calls,
    { order: 1, execute: 0, simulate: 0, journal: 0, secretKey: 0 });

  const expired = makeExitMarkHarness({ chainHeight: 999 });
  await assert.rejects(() => expired.executor.preflightExitMark(expired.spec), /already behind/);
  assert.deepEqual(expired.calls, { order: 1, execute: 0, simulate: 0, journal: 0, secretKey: 0 });

  const noProceeds = makeExitMarkHarness({ postOutputRaw: "0" });
  await assert.rejects(() => noProceeds.executor.preflightExitMark(noProceeds.spec), /proceeds are not positive/);
  assert.deepEqual(noProceeds.calls, { order: 1, execute: 0, simulate: 2, journal: 0, secretKey: 0 });

  const badEnvelope = makeExitMarkHarness({ orderOverrides: { router: "jupiterz" } });
  await assert.rejects(() => badEnvelope.executor.preflightExitMark(badEnvelope.spec), /Metis-only/);
  assert.deepEqual(badEnvelope.calls, { order: 1, execute: 0, simulate: 0, journal: 0, secretKey: 0 });

  const forgedPrimary = makeExitMarkHarness({
    postOutputRaw: "4950000", secondaryPostOutputRaw: "4900000",
  });
  await assert.rejects(() => forgedPrimary.executor.preflightExitMark(forgedPrimary.spec),
    /independent RPC simulations diverge/);
  assert.equal(forgedPrimary.calls.simulate, 2);

  const secondaryOutage = makeExitMarkHarness({
    secondarySimulationError: new Error("private secondary endpoint unavailable"),
  });
  await assert.rejects(() => secondaryOutage.executor.preflightExitMark(secondaryOutage.spec),
    /private secondary endpoint unavailable/);
  assert.equal(secondaryOutage.calls.simulate, 2);
});

await ok("both providers must agree on stable writable capabilities", async () => {
  const forged = makeExitMarkHarness({
    secondaryWritableOverride: (address, account) => address === sourceAta.toBase58()
      ? tokenAccount({ tokenMint: WSOL, owner: wallet.publicKey, amount: "0", isNative: true })
      : account,
  });
  await assert.rejects(() => forged.executor.preflightExitMark(forged.spec),
    /RPC providers disagree on writable-account safety capabilities/);
  assert.deepEqual(forged.calls,
    { order: 1, execute: 0, simulate: 2, journal: 0, secretKey: 0 });
});

await ok("a capability change after simulation invalidates the unsigned order", async () => {
  const changed = makeExitMarkHarness({
    primaryPostWritableOverride: (address, account) => address === sourceAta.toBase58()
      ? tokenAccount({ tokenMint: WSOL, owner: wallet.publicKey, amount: "0", isNative: true })
      : account,
  });
  await assert.rejects(() => changed.executor.preflightExitMark(changed.spec),
    /writable-account capabilities changed across simulation/);
  assert.deepEqual(changed.calls,
    { order: 1, execute: 0, simulate: 2, journal: 0, secretKey: 0 });
});

await ok("simulation context and the post-scan expiry margin remain hard fences", async () => {
  const staleSimulation = makeExitMarkHarness({ simulationContextSlot: 701 });
  await assert.rejects(() => staleSimulation.executor.preflightExitMark(staleSimulation.spec),
    /simulation returned a missing, invalid, or below-fence context slot/);
  assert.equal(staleSimulation.calls.execute, 0);
  assert.equal(staleSimulation.calls.secretKey, 0);
  assert.equal(staleSimulation.calls.journal, 0);

  const consumed = makeExitMarkHarness({ finalChainHeight: 968 });
  await assert.rejects(() => consumed.executor.preflightExitMark(consumed.spec),
    new RegExp(`only 31 blocks left.*minimum ${MIN_SIGNABLE_BLOCKS_REMAINING}`));
  assert.equal(consumed.calls.simulate, 2);
  assert.equal(consumed.calls.execute, 0);
  const exactMargin = makeExitMarkHarness({ finalChainHeight: 967 });
  const mark = await exactMargin.executor.preflightExitMark(exactMargin.spec);
  assert.equal(mark.chainHeight, 967, "exactly 32 remaining blocks remains signable");
  const regressed = makeExitMarkHarness({ chainHeight: 600, finalChainHeight: 599 });
  await assert.rejects(() => regressed.executor.preflightExitMark(regressed.spec),
    /block height regressed after the final capability fence/);
  assert.equal(regressed.calls.execute, 0);
});

await ok("gross rent is independently bound and capped without raising exposure limits", async () => {
  const expected = { inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    wallet: wallet.publicKey.toBase58() };
  assert.equal(validateOrderEnvelope({ ...orderBase, rentFeeLamports: 4_078_560 },
    expected, cfg).rentFeeLamports, 4_078_560);
  assert.throws(() => validateOrderEnvelope({ ...orderBase,
    rentFeeLamports: MAX_GROSS_RENT_LAMPORTS + 1 }, expected, cfg), /rent .* exceeds cap/);
  const unearned = makeExitMarkHarness({ orderOverrides: { rentFeeLamports: 4_078_560 } });
  await assert.rejects(() => unearned.executor.preflightExitMark(unearned.spec),
    /canonical ATA rent facts do not match Jupiter's rent estimate/);
  assert.equal(unearned.calls.simulate, 0);
});

/* THE UNWRAP EXIT — every stop this desk will ever fire. A sell to SOL creates the
 * wrapped-SOL ATA and CLOSES it in the same transaction, so Jupiter quotes rent NET
 * (0) while the chain's pre-state shows the ATA missing (gross 2,039,280). The guard
 * compared gross to net and refused every exit on mainnet. It must net out the
 * same-transaction close — and still refuse an exit that claims rent it never pays. */
await ok("an unwrap exit that creates and closes the wrapped-SOL ATA nets its rent to zero", async () => {
  const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const createWsolAta = new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },      // payer
      { pubkey: sourceAta, isSigner: false, isWritable: true },            // the WSOL ATA
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },    // owner
      { pubkey: new PublicKey(WSOL), isSigner: false, isWritable: false }, // mint
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),                                                // idempotent create
  });
  const closeWsolAta = new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },     // lamports back to wallet
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },     // authority
    ],
    data: Buffer.from([9]),                                                // CloseAccount
  });
  const unwrap = [createWsolAta, exitRoute, closeWsolAta];
  // Jupiter quotes NET rent 0 for create-and-close: the guard must let it through.
  const honest = makeExitMarkHarness({ instructions: unwrap, orderOverrides: { rentFeeLamports: 0 } });
  await assert.doesNotReject(async () => {
    try { await honest.executor.preflightExitMark(honest.spec); }
    catch (error) {
      if (/canonical ATA rent facts do not match/.test(error.message)) throw error;
      // any OTHER refusal is outside this test's claim
    }
  }, "net-zero rent on a same-transaction unwrap must not be refused as a rent mismatch");
  // Here the wrapped-SOL ATA already exists, so NOTHING is missing: a claim of one
  // account's rent is an over-claim and is still refused.
  const overclaim = makeExitMarkHarness({ instructions: unwrap, orderOverrides: { rentFeeLamports: 2_039_280 } });
  await assert.rejects(() => overclaim.executor.preflightExitMark(overclaim.spec),
    /canonical ATA rent facts do not match Jupiter's rent estimate/);

  /* When the wrapped-SOL ATA IS missing, the same create-and-close shape was quoted
   * NET (0) by Jupiter on the 2026-09-02 sell and GROSS (both accounts) on the
   * 2026-09-03 pump.fun buy. Both are chain-derived truths about the same accounts;
   * anything else is still a mismatch. */
  const wsolMissing = (address, account) => address === sourceAta.toBase58() ? null : account;
  for (const [rentFeeLamports, verdict] of [[0, "net"], [2_039_280, "gross"]]) {
    const harness = makeExitMarkHarness({ instructions: unwrap, orderOverrides: { rentFeeLamports },
      primaryWritableOverride: wsolMissing, secondaryWritableOverride: wsolMissing });
    await assert.doesNotReject(async () => {
      try { await harness.executor.preflightExitMark(harness.spec); }
      catch (error) { if (/canonical ATA rent facts do not match/.test(error.message)) throw error; }
    }, `a missing wrapped-SOL ATA quoted ${verdict} must not be refused as a rent mismatch`);
  }
  for (const rentFeeLamports of [1_000_000, 2_039_281, 4_078_560]) {
    const harness = makeExitMarkHarness({ instructions: unwrap, orderOverrides: { rentFeeLamports },
      primaryWritableOverride: wsolMissing, secondaryWritableOverride: wsolMissing });
    await assert.rejects(() => harness.executor.preflightExitMark(harness.spec),
      /canonical ATA rent facts do not match Jupiter's rent estimate \(chain: 0 net of same-transaction closes, 2039280 gross; Jupiter reports/);
  }
});

await ok("execution-readiness probe exercises both providers without signing, journaling or executing", async () => {
  const usdcAta = ata(wallet.publicKey, MAINNET_USDC);
  const readinessAmount = EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS;
  const amount = BigInt(readinessAmount);
  const quoted = 20_000n;
  const route = new TransactionInstruction({
    programId: new PublicKey(JUPITER_V6),
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: usdcAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(WSOL), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(MAINNET_USDC), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(JUPITER_EVENT_AUTHORITY), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(JUPITER_V6), isSigner: false, isWritable: false },
    ],
    data: routeV2Data({ amount, quoted }),
  });
  const wrapProbe = SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: sourceAta,
    lamports: readinessAmount,
  });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash, instructions: [wrapProbe, route],
  }).compileToV0Message());
  const order = {
    ...orderBase, inputMint: WSOL, outputMint: MAINNET_USDC,
    inAmount: String(amount), outAmount: String(quoted), otherAmountThreshold: "19400",
    feeMint: WSOL, platformFee: { amount: "1", feeBps: 10, feeMint: WSOL },
    signatureFeeLamports: 5000, prioritizationFeeLamports: 0,
    transaction: Buffer.from(transaction.serialize()).toString("base64"),
  };
  const calls = {
    order: 0, execute: 0, simulate: 0, snapshot: 0, getSlot: 0,
    height: 0, rent: 0, epoch: 0, journal: 0, secretKey: 0,
  };
  const provider = () => {
    let snapshotReads = 0;
    let slotReads = 0;
    return ({
    getAddressLookupTable: async () => ({ value: null }),
    getAccountInfo: async () => classicMintFixture(),
    getSlot: async (commitment) => {
      calls.getSlot++;
      slotReads++;
      assert.equal(commitment, "processed");
      assert.equal(slotReads, 1, "each provider gets exactly one initial freshness anchor");
      return 701;
    },
    getMultipleAccountsInfoAndContext: async () => {
      throw new Error("atomic readiness snapshot unexpectedly used getMultipleAccounts");
    },
    getBlockHeight: async (commitment) => {
      calls.height++;
      assert.equal(commitment, "confirmed");
      return 600;
    },
    getEpochInfo: async (config) => {
      calls.epoch++;
      assert.deepEqual(config, { commitment: "processed", minContextSlot: 702 });
      return { absoluteSlot: 702, blockHeight: 600 };
    },
    getMinimumBalanceForRentExemption: async (_size, commitment) => {
      calls.rent++;
      assert.equal(commitment, "processed");
      return 2_039_280;
    },
    simulateTransaction: async (tx, options) => {
      if (options.innerInstructions === false) {
        calls.snapshot++;
        snapshotReads++;
        assert.equal(options.commitment, "processed");
        if (snapshotReads === 1) {
          assert.equal(options.minContextSlot, 701,
            "the nonzero provider anchor must fence the initial merged snapshot");
          assert.ok(options.accounts.addresses.includes(wallet.publicKey.toBase58()));
          assert.ok(options.accounts.addresses.includes(sourceAta.toBase58()));
          assert.ok(options.accounts.addresses.includes(usdcAta.toBase58()));
        }
        return atomicCapabilitySnapshot(tx, options, {
          slot: 702,
          accountFor: (address) => address === wallet.publicKey.toBase58()
            ? systemAccount(100_000_000) : null,
        });
      }
      calls.simulate++;
      assert.equal(options.sigVerify, false);
      assert.equal(options.minContextSlot, 702);
      assert.ok(tx.signatures.every((signature) =>
        Buffer.from(signature).every((byte) => byte === 0)));
      return { context: { slot: 702 }, value: { err: null, accounts: [
        systemAccount(47_955_720, true),
        null,
        tokenAccount({ tokenMint: MAINNET_USDC, owner: wallet.publicKey,
          amount: quoted, simulated: true }),
      ] } };
    },
  });
  };
  const fetchFn = async (url) => {
    if (String(url).includes("/order?")) { calls.order++; return response(order); }
    calls.execute++;
    throw new Error("execution-readiness probe attempted /execute");
  };
  const keypair = {
    publicKey: wallet.publicKey,
    get secretKey() { calls.secretKey++; throw new Error("probe attempted to sign"); },
  };
  const journal = new Proxy({}, { get() {
    calls.journal++;
    throw new Error("probe touched the execution journal");
  } });
  const executor = new JupiterV2Executor({
    connection: provider(), secondaryConnection: provider(), keypair, journal,
    apiKey: "test", fetchFn, now: () => 5_000, config: cfg,
  });
  const result = await executor.probeExecutionReadiness({ amountLamports: readinessAmount });
  assert.deepEqual(result, {
    ready: true, observedAt: 5_000, route: "wsol-usdc", providers: 2,
    amountLamports: readinessAmount,
    providerDivergencePct: 0, chainHeight: 600, lastValidBlockHeight: 999,
    computeUnitLimit: 1_400_000, computeUnitPriceMicroLamports: "0",
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(calls, {
    order: 1, execute: 0, simulate: 2, snapshot: 4, getSlot: 2,
    height: 2, rent: 2, epoch: 2, journal: 0, secretKey: 0,
  });
  assert.equal(calls.snapshot, 4,
    "each provider needs one merged pre-state snapshot and one post-simulation snapshot");
  assert.equal(EXECUTION_READINESS_AMOUNT_LAMPORTS, 5_000_000);
  assert.equal(EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS, 50_000_000);
  assert.equal(MAX_GROSS_RENT_LAMPORTS, 4_200_000);
  assert.ok(100_000_000n > amount + BigInt(EXECUTION_READINESS_RESERVE_LAMPORTS));
  await assert.rejects(() => executor.probeExecutionReadiness({
    amountLamports: EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS + 1,
  }), /outside the supported live-cap range/);
});

await ok("a signable exit cannot cross the journaled-signature boundary on one RPC's approval", async () => {
  const harness = makeExitMarkHarness({
    secondarySimulationError: new Error("secondary rejects the exact unsigned exit"),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-dual-sign-boundary-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const executor = new JupiterV2Executor({
    connection: harness.connection, secondaryConnection: harness.secondaryConnection,
    keypair: wallet, journal, apiKey: "test", fetchFn: harness.fetchFn,
    now: () => 1_000, sleep: async () => {}, config: cfg,
  });
  const spec = {
    id: "risk-exit:dual-sign-boundary", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: exitAmountRaw,
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: exitAmountRaw, costBasisLamports: "5000000",
    } },
  };
  await assert.rejects(() => executor.executeIntent(spec), /secondary rejects the exact unsigned exit/);
  assert.equal(journal.getIntent(spec.id).state, "planned");
  assert.equal(journal.latestAttempt(spec.id), null,
    "one provider's safe simulation must never create broadcastable journaled bytes");
  assert.equal(harness.calls.execute, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const finalized = (signature, output = "987") => ({
  transaction: { signatures: [signature], message: { staticAccountKeys: [wallet.publicKey] } },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [20_000_000, 0],
    postBalances: [12_955_720, 2_039_280],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 1, owner: wallet.publicKey.toBase58(), mint,
      uiTokenAmount: { amount: output } }],
  },
});
const finalizedExit = (signature, output = "5000000") => ({
  transaction: { signatures: [signature], message: { staticAccountKeys: [wallet.publicKey] } },
  meta: {
    err: null, fee: 5000,
    preBalances: [20_000_000, 2_039_280, 2_039_280],
    postBalances: [Number(22_034_280n + BigInt(output)), 0, 2_039_280],
    preTokenBalances: [
      { accountIndex: 1, owner: wallet.publicKey.toBase58(), mint: WSOL,
        uiTokenAmount: { amount: "0" } },
      { accountIndex: 2, owner: wallet.publicKey.toBase58(), mint,
        uiTokenAmount: { amount: "1000" } },
    ],
    postTokenBalances: [
      { accountIndex: 2, owner: wallet.publicKey.toBase58(), mint,
        uiTokenAmount: { amount: "0" } },
    ],
  },
});
await ok("finalized accounting cross-checks actual owner token deltas", async () => {
  const intent = { amountRaw: "5000000", inputMint: WSOL, outputMint: mint,
    context: { wallet: wallet.publicKey.toBase58() } };
  const verified = verifyFinalizedFill(finalized("sig"), intent, {
    signature: "sig", totalInputAmount: "5000000", totalOutputAmount: "987",
  });
  assert.equal(verified.totalOutputAmount, "987");
  assert.equal(verified.networkFeeLamports, "5000");
  assert.throws(() => verifyFinalizedFill(finalized("sig", "986"), intent, {
    signature: "sig", totalInputAmount: "5000000", totalOutputAmount: "987",
  }), /output-token delta/);
  const missingSignature = finalized("sig");
  missingSignature.transaction.signatures = [];
  assert.throws(() => verifyFinalizedFill(missingSignature, intent, {
    signature: "sig", totalInputAmount: "5000000", totalOutputAmount: "987",
  }), /signature mismatch/);
  assert.throws(() => verifyFinalizedFill(finalized("different"), intent, {
    signature: "sig", totalInputAmount: "5000000", totalOutputAmount: "987",
  }), /signature mismatch/);
  const overDebit = finalized("sig");
  overDebit.meta.postBalances[0]--;
  assert.throws(() => verifyFinalizedFill(overDebit, intent, {
    signature: "sig", totalInputAmount: "5000000", totalOutputAmount: "987",
  }), /SOL spend does not match/);

  const exitIntent = { amountRaw: "1000", inputMint: mint, outputMint: WSOL,
    context: { wallet: wallet.publicKey.toBase58(),
      position: { qtyRaw: "1000", costBasisLamports: "5000000" } } };
  const exitTx = {
    transaction: { signatures: ["exit-sig"], message: { staticAccountKeys: [wallet.publicKey] } },
    meta: {
      err: null, fee: 5000,
      preBalances: [20_000_000, 2_039_280, 2_039_280],
      postBalances: [27_034_280, 0, 2_039_280],
      preTokenBalances: [
        { accountIndex: 1, owner: wallet.publicKey.toBase58(), mint: WSOL, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, owner: wallet.publicKey.toBase58(), mint, uiTokenAmount: { amount: "1000" } },
      ],
      postTokenBalances: [
        { accountIndex: 2, owner: wallet.publicKey.toBase58(), mint, uiTokenAmount: { amount: "0" } },
      ],
    },
  };
  assert.equal(verifyFinalizedFill(exitTx, exitIntent, {
    signature: "exit-sig", totalInputAmount: "1000", totalOutputAmount: "5000000",
  }).totalOutputAmount, "5000000");
  exitTx.meta.postBalances[0]++;
  assert.throws(() => verifyFinalizedFill(exitTx, exitIntent, {
    signature: "exit-sig", totalInputAmount: "1000", totalOutputAmount: "5000000",
  }), /SOL proceeds do not match/);
});

await ok("transport retry reuses byte-identical signed transaction and signature", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-live-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const unsigned = makeTx();
  const builtOrder = { ...orderBase, transaction: Buffer.from(unsigned.serialize()).toString("base64") };
  let orderCalls = 0;
  let executeCalls = 0;
  let submissionGateCalls = 0;
  let executeSucceeded = false;
  let chainSignature = "";
  const signedBodies = [];
  const connection = {
    getAddressLookupTable: async () => ({ value: null }),
    getAccountInfo: async () => classicMintFixture(),
    getSlot: async (commitment) => commitment === "processed" ? 702 : 700,
    getMultipleAccountsInfoAndContext: async () => {
      throw new Error("atomic execution snapshot unexpectedly used getMultipleAccounts");
    },
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    simulateTransaction: async (tx, options) => {
      if (options.innerInstructions === false) {
        return atomicCapabilitySnapshot(tx, options, {
          slot: options.commitment === "processed" ? 702 : 700,
          accountFor: (address) => address === wallet.publicKey.toBase58()
            ? systemAccount(20_000_000) : null,
        });
      }
      return { context: { slot: 702 }, value: {
        err: null,
        accounts: [
          systemAccount(12_960_720, true),
          null,
          tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987, simulated: true }),
        ],
        innerInstructions: [],
      } };
    },
    getSignatureStatuses: async () => ({ value: [executeSucceeded ? {
      err: null, confirmationStatus: "finalized", confirmations: null,
    } : null] }),
    getTransaction: async () => finalized(chainSignature),
    // Coherent with the order fixture's lastValidBlockHeight of 999: the expiry bound
    // added 2026-09-01 refuses to sign an order more than blockHeightWindow (600)
    // blocks ahead of the REAL chain. 999 - 600 = 399 ahead — a plausible fresh order.
    getBlockHeight: async () => 600,
    getEpochInfo: async (config) => {
      assert.deepEqual(config, { commitment: "processed", minContextSlot: 702 });
      return { absoluteSlot: 702, blockHeight: 600 };
    },
    isBlockhashValid: async () => ({ value: true }),
  };
  const secondaryConnection = {
    ...connection,
    getSignatureStatuses: (...args) => connection.getSignatureStatuses(...args),
    getTransaction: (...args) => connection.getTransaction(...args),
    getBlockHeight: async () => 600,
    isBlockhashValid: async () => ({ value: true }),
  };
  const fetchFn = async (url, options = {}) => {
    if (String(url).includes("/order?")) { orderCalls++; return response(builtOrder); }
    executeCalls++;
    const body = JSON.parse(options.body);
    signedBodies.push(body.signedTransaction);
    const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    chainSignature = bs58.encode(Buffer.from(tx.signatures[0]));
    assert.equal(journal.latestAttempt("entry:50:entry:9").state, "submitted");
    if (executeCalls === 1) throw new Error("synthetic timeout after submit");
    executeSucceeded = true;
    return response({
      status: "Success", code: 0, signature: chainSignature,
      totalInputAmount: "5000000", totalOutputAmount: "987",
      inputAmountResult: "5000000", outputAmountResult: "987",
    });
  };
  const executor = new JupiterV2Executor({
    connection, secondaryConnection, keypair: wallet, journal, apiKey: "test-key", fetchFn,
    submissionGate: () => { submissionGateCalls++; },
    now: () => 1000, sleep: async () => {},
    config: { ...cfg, finalityTimeoutMs: 0, maxAttempts: 3 },
  });
  const spec = {
    id: "entry:50:entry:9", kind: "entry", eventId: "50:entry:9", feedId: 9,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000", context: entryGuardContext(),
  };
  await assert.rejects(() => executor.executeIntent(spec), /unresolved/);
  const fill = await executor.executeIntent(spec);
  assert.equal(fill.state, "confirmed");
  assert.equal(fill.actualOutputRaw, "987");
  assert.equal(fill.networkFeeLamports, "5000");
  assert.equal(orderCalls, 1, "must not obtain a replacement order while signature is live");
  assert.equal(executeCalls, 2);
  assert.equal(submissionGateCalls, 4,
    "entry safety is rechecked before build, before signing, and before each disclosure");
  assert.equal(signedBodies[0], signedBodies[1], "retry must reuse exact signed bytes");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a post-submit entry pause still reconciles and records a landed buy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-paused-recovery-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:paused", kind: "entry", eventId: "50:entry:paused", feedId: 16,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "paused", signedTx: Buffer.from("signed"), signature: "sig-paused",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  journal.markSubmitted(spec.id, 1);
  let executeCalls = 0;
  const landedRpc = () => ({
    getSignatureStatuses: async () => ({ value: [{
      err: null, confirmationStatus: "finalized", confirmations: null,
    }] }),
    getTransaction: async () => finalized("sig-paused"),
  });
  const executor = new JupiterV2Executor({
    connection: landedRpc(), secondaryConnection: landedRpc(),
    keypair: wallet, journal, apiKey: "test",
    submissionGate: () => { throw new Error("entries paused after submission"); },
    fetchFn: async () => { executeCalls++; throw new Error("must not resubmit after the gate closes"); },
    now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  const recovered = journal.getIntent(spec.id);
  assert.equal(recovered.state, "confirmed");
  assert.equal(recovered.actualInputRaw, "5000000");
  assert.equal(recovered.actualOutputRaw, "987");
  assert.equal(executeCalls, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("one provider's phantom finalized exit cannot retire durable custody", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-phantom-finalized-exit-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:phantom-finality", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "1000",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "1000", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "phantom-finality", signedTx: Buffer.from("signed-exit"),
    signature: "sig-phantom-finality", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  journal.markSubmitted(spec.id, 1);
  const primary = {
    getSignatureStatuses: async () => ({ value: [{
      err: null, confirmationStatus: "finalized", confirmations: null,
    }] }),
    getTransaction: async () => finalizedExit("sig-phantom-finality"),
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getTransaction: async () => null,
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal,
    apiKey: "test", hardStop: () => true, now: () => 1_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "submitted",
    "one-provider success remains recoverable and cannot become accounting authority");
  assert.equal(journal.getIntent(spec.id).actualOutputRaw, null);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("one provider cannot backdate a finalized fill outside the rolling risk window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-finalized-time-disagree-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "entry:finalized-time-disagree", kind: "entry", eventId: "time-disagree", feedId: 17,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "time-disagree", signedTx: Buffer.from("signed-entry"),
    signature: "sig-time-disagree", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "987", minOutputRaw: "970", order: {},
  });
  const status = { err: null, confirmationStatus: "finalized", confirmations: null };
  const rpc = (blockTime) => ({
    getSignatureStatuses: async () => ({ value: [status] }),
    getTransaction: async () => ({ ...finalized("sig-time-disagree"), blockTime }),
  });
  const executor = new JupiterV2Executor({
    connection: rpc(100), secondaryConnection: rpc(1_000), keypair: wallet, journal,
    apiKey: "test", now: () => 1_000_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await assert.rejects(() => executor._acceptFinalized(
    journal.getIntent(spec.id), journal.latestAttempt(spec.id), null, null,
  ), /finalizedAtMs/);
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.equal(journal.db.prepare("SELECT COUNT(*) n FROM risk_events").get().n, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("dual-RPC finalized chain truth outranks false Jupiter success totals and signature", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-chain-truth-success-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "entry:chain-truth-success", kind: "entry", eventId: "chain-truth", feedId: 19,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "chain-truth", signedTx: Buffer.from("signed-entry"),
    signature: "sig-chain-truth", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "987", minOutputRaw: "970", order: {},
  });
  const status = { err: null, confirmationStatus: "finalized", confirmations: null };
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [status] }),
    getTransaction: async () => finalized("sig-chain-truth"),
  });
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal,
    apiKey: "test", now: () => 1_000, sleep: async () => {},
  });
  const recovered = await executor._acceptFinalized(
    journal.getIntent(spec.id), journal.latestAttempt(spec.id),
    { status: "Success", code: 0, signature: "jupiter-lied", totalInputAmount: "1",
      totalOutputAmount: "999999999" }, null,
  );
  assert.equal(recovered.state, "confirmed");
  assert.equal(recovered.signature, "sig-chain-truth");
  assert.equal(recovered.actualInputRaw, "5000000");
  assert.equal(recovered.actualOutputRaw, "987");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a closed entry gate reconciles never-submitted bytes to proven expiry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-paused-signed-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:paused-signed", kind: "entry", eventId: "50:entry:paused-signed", feedId: 17,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "paused-signed", signedTx: Buffer.from("signed"), signature: "sig-paused-signed",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  const rpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc, secondaryConnection: rpc, keypair: wallet, journal, apiKey: "test",
    submissionGate: () => { throw new Error("entry became stale"); },
    fetchFn: async () => { executeCalls++; throw new Error("closed gate must never submit"); },
    now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "expired");
  const exitId = "risk_exit:50:mint:after-expiry";
  journal.ensureIntent({
    id: exitId, kind: "risk_exit", eventId: "risk:after-expiry", feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987", context: {},
  });
  assert.equal(journal.hasBlockingIntent(exitId), null);
  assert.equal(executeCalls, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a lagging primary cannot strand an exit whose exact blockhash both RPCs reject", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-split-height-expiry-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:split-height", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "split-height", signedTx: Buffer.from("signed-exit"),
    signature: "sig-split-height", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  let executeCalls = 0;
  let secondaryHeightReads = 0;
  const primary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: false }),
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => { secondaryHeightReads++; return 101; },
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary,
    keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("expired bytes must remain undisclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(secondaryHeightReads > 0, true,
    "first disclosure must consult the independent secondary height even when primary succeeds");
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "expired",
    "two dead-blockhash views plus two absent histories must release an undisclosed stop despite a stale height");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("both RPCs must independently place an exit expiry inside the live block window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-split-height-window-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const expiry = 9_000_000_000_000_000;
  const spec = {
    id: "risk-exit:split-height-window", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "split-height-window", signedTx: Buffer.from("signed-exit"),
    signature: "sig-split-height-window", blockhash: recentBlockhash,
    lastValidBlockHeight: expiry, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  let executeCalls = 0;
  const rpc = (height) => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => height,
  });
  const executor = new JupiterV2Executor({
    connection: rpc(expiry - 500), secondaryConnection: rpc(100),
    keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("unbounded expiry must remain undisclosed"); },
    now: () => 1_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0, blockHeightWindow: 600 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "signed",
    "one forged near-expiry view cannot override the independent provider's impossible window");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a plausible authored expiry cannot disclose a blockhash both RPCs say is dead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-dead-blockhash-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:dead-blockhash", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "dead-blockhash", signedTx: Buffer.from("signed-exit"),
    signature: "sig-dead-blockhash", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  let executeCalls = 0;
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: false }),
  });
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("dead bytes must not be disclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "expired",
    "two-RPC-invalid, never-observed undisclosed bytes expire despite Jupiter's inflated height claim");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a height-method outage cannot strand a two-RPC-dead undisclosed blockhash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-dead-blockhash-height-outage-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:dead-height-outage", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "dead-height-outage", signedTx: Buffer.from("signed-exit"),
    signature: "sig-dead-height-outage", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  const rpc = (heightFails = false) => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => {
      if (heightFails) throw new Error("height method unavailable");
      return 50;
    },
    isBlockhashValid: async () => ({ value: false }),
  });
  const executor = new JupiterV2Executor({
    connection: rpc(true), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "expired",
    "exact dead-hash consensus plus dual history absence outranks an unrelated height-method outage");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("one unavailable history cannot authorize expiry despite two dead blockhash views", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-expiry-history-outage-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:history-outage", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "history-outage", signedTx: Buffer.from("signed-exit"),
    signature: "sig-history-outage", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  const primary = {
    getSignatureStatuses: async () => { throw new Error("primary history unavailable"); },
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal, apiKey: "test",
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
  assert.equal(journal.getIntent(spec.id).state, "signed",
    "replacement needs an explicit fulfilled-null read from both independent histories");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a disappearing signature observation is durably denied replacement authority", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-dead-blockhash-observed-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:dead-blockhash-observed", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "dead-blockhash-observed", signedTx: Buffer.from("signed-exit"),
    signature: "sig-dead-blockhash-observed", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  const observed = { err: null, confirmationStatus: "confirmed", confirmations: 1 };
  let primaryStatusReads = 0;
  const primary = {
    getSignatureStatuses: async () => ({
      value: [++primaryStatusReads === 1 ? observed : null],
    }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: false }),
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal, apiKey: "test",
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous",
    "the first observation must cross a durable no-replacement boundary");
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous",
    "later null/pruned histories cannot erase an earlier chain observation");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("one-provider finalized success durably removes signed replacement authority", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-finalized-observation-lag-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "entry:finalized-observation-lag", kind: "entry", eventId: "finalized-lag", feedId: 18,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "finalized-lag", signedTx: Buffer.from("signed-entry"),
    signature: "sig-finalized-lag", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "987", minOutputRaw: "970", order: {},
  });
  let primaryVisible = true;
  const finalizedStatus = { err: null, confirmationStatus: "finalized", confirmations: null };
  const primary = {
    getSignatureStatuses: async () => ({ value: [primaryVisible ? finalizedStatus : null] }),
    getTransaction: async () => primaryVisible ? finalized("sig-finalized-lag") : null,
    getBlockHeight: async () => 50,
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getTransaction: async () => null,
    getBlockHeight: async () => 50,
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal, apiKey: "test",
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
  assert.equal(journal.getIntent(spec.id).state, "ambiguous",
    "a lagging second provider may delay accounting but cannot leave observed bytes rebuildable");
  primaryVisible = false;
  await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a crash-window submitted attempt never POSTs a dead exact blockhash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-submitted-dead-blockhash-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:submitted-dead-blockhash", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "submitted-dead", signedTx: Buffer.from("signed-exit"),
    signature: "sig-submitted-dead", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  journal.markSubmitted(spec.id, 1); // crash may have occurred before the actual POST
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: false }),
  });
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("dead submitted bytes must not be POSTed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "submitted",
    "unexpired authored height cannot override two dead exact-blockhash views");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a legacy signed entry without independent provenance is never POSTed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-legacy-signed-gate-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:legacy-signed", kind: "entry",
    eventId: "50:entry:legacy-signed", feedId: 18,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    // This is the pre-independent-oracle shape: enough for the old runtime, but no
    // Pyth publish/confidence/dual-RPC proof and therefore no new submission authority.
    context: { wallet: wallet.publicKey.toBase58(), event: { mint, stop: 0.8, target: 1.5 },
      entryReference: { marketMark: 1, entryLow: 0.9, entryHigh: 1.1 },
      entryPreflight: { inputAmountRaw: "5000000", forwardOutputRaw: "1000", solUsd: 200 } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "legacy-signed", signedTx: Buffer.from("legacy-signed"),
    signature: "sig-legacy-signed", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "1000", minOutputRaw: "970", order: {},
  });
  const rpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
  };
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc, secondaryConnection: rpc, keypair: wallet, journal, apiKey: "test",
    submissionGate: (intent) => validateEntryPreflightContext(intent, {
      nowMs: 1_000, maxEntryPreflightAgeMs: 60_000,
    }),
    fetchFn: async () => { executeCalls++; throw new Error("legacy bytes must remain undisclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "signed",
    "unexpired never-disclosed bytes stay held until expiry can be proven");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("an unversioned signed-era attempt is observation-only and can never be replaced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-unversioned-signed-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:unversioned", kind: "entry", eventId: "unversioned", feedId: 19,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "unversioned", signedTx: Buffer.from("old-era-bytes"),
    signature: "sig-unversioned", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "1000", minOutputRaw: "970", order: {},
  });
  journal.db.prepare("UPDATE tx_attempts SET protocol=NULL WHERE intent_id=?").run(spec.id);
  const rpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc, secondaryConnection: rpc, keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("unversioned bytes must not be disclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /unversioned signed-era protocol missing/);
  await assert.rejects(() => executor.executeIntent(spec), /AMBIGUOUS/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a pre-coherent-snapshot v2 signed attempt is observation-only and never disclosed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-v2-signed-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:v2-signed", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "v2-signed", signedTx: Buffer.from("pre-coherent-snapshot-bytes"),
    signature: "sig-v2-signed", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  journal.db.prepare("UPDATE tx_attempts SET protocol=? WHERE intent_id=?")
    .run("jupiter-dual-rpc-unsigned-preflight-v2", spec.id);
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
    isBlockhashValid: async () => ({ value: true }),
  });
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("v2 bytes must never be disclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0,
    "bytes built before coherent snapshots cannot inherit current disclosure authority");
  assert.equal(journal.getIntent(spec.id).state, "signed");
  assert.equal(journal.latestAttempt(spec.id).protocol, "jupiter-dual-rpc-unsigned-preflight-v2");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("an unversioned submitted-era exit is observation-only and is never POSTed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-unversioned-submitted-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:unversioned-submitted", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "987",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "987", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "unversioned-submitted", signedTx: Buffer.from("old-era-exit"),
    signature: "sig-unversioned-submitted", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000",
    minOutputRaw: "4850000", order: {},
  });
  journal.db.prepare("UPDATE tx_attempts SET protocol=NULL WHERE intent_id=?").run(spec.id);
  journal.markSubmitted(spec.id, 1);
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 50,
  });
  let executeCalls = 0;
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("old submitted bytes must not be disclosed"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "submitted",
    "unexpired legacy submitted bytes remain observation-only pending chain evidence");
  await assert.rejects(() => executor.executeIntent(spec), /unresolved/);
  assert.equal(executeCalls, 0, "direct resume must enforce the same protocol boundary");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("an unversioned signed-era attempt may still reconcile a finalized fill", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-unversioned-finalized-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:unversioned-finalized", kind: "entry",
    eventId: "unversioned-finalized", feedId: 20,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "unversioned-finalized", signedTx: Buffer.from("old-era-bytes"),
    signature: "sig-unversioned-finalized", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "987", minOutputRaw: "970", order: {},
  });
  journal.db.prepare("UPDATE tx_attempts SET protocol=NULL WHERE intent_id=?").run(spec.id);
  let executeCalls = 0;
  const finalizedRpc = () => ({
    getSignatureStatuses: async () => ({ value: [{
      err: null, confirmationStatus: "finalized", confirmations: null,
    }] }),
    getTransaction: async () => finalized("sig-unversioned-finalized"),
  });
  const executor = new JupiterV2Executor({
    connection: finalizedRpc(), secondaryConnection: finalizedRpc(),
    keypair: wallet, journal, apiKey: "test",
    fetchFn: async () => { executeCalls++; throw new Error("must reconcile without disclosure"); },
    now: () => 1_000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(executeCalls, 0);
  assert.equal(journal.getIntent(spec.id).state, "confirmed");
  assert.equal(journal.getIntent(spec.id).actualOutputRaw, "987");
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("one-RPC expiry is ambiguous and cannot authorize a replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-expiry-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:10", kind: "entry", eventId: "50:entry:10", feedId: 10,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000", context: {},
  };
  journal.ensureIntent({ ...spec, context: { wallet: wallet.publicKey.toBase58() } });
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "expired", signedTx: Buffer.from("signed"), signature: "sig-expired",
    blockhash: "block", lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "900", order: {},
  });
  const executor = new JupiterV2Executor({
    connection: {
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 101,
    },
    keypair: wallet, journal, apiKey: "test", hardStop: () => true,
    now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  await assert.rejects(() => executor.executeIntent(spec), /AMBIGUOUS/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("processed or confirmed errors are not treated as finalized failures", async () => {
  const executor = new JupiterV2Executor({
    connection: {
      getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [1, "Custom"] },
        confirmationStatus: "confirmed", confirmations: 1 }] }),
    },
    keypair: wallet, journal: {}, apiKey: "test", now: () => 1000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  const result = await executor._waitFinalized("fork-local-error");
  assert.equal(result.outcome, "pending");
  assert.equal(result.observedStatus, true);
});

await ok("one RPC cannot turn a finalized error into replacement authority", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-error-consensus-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:error-one", kind: "entry", eventId: "50:entry:error-one", feedId: 14,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "error-one", signedTx: Buffer.from("signed"), signature: "sig-error-one",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  const executor = new JupiterV2Executor({
    connection: {
      getSignatureStatuses: async () => ({ value: [errorStatus] }),
      getTransaction: async () => null,
      // _resume now bounds a signed attempt against the chain before any disclosure;
      // height 50 < expiry 100 keeps this test on its consensus claim, not expiry.
      getBlockHeight: async () => 50,
    },
    secondaryConnection: { getSignatureStatuses: async () => ({ value: [null] }) },
    keypair: wallet, journal, apiKey: "test", hardStop: () => true,
    now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /consensus unavailable/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("matching finalized errors on both RPCs may safely fail the attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-error-agree-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:error-both", kind: "entry", eventId: "50:entry:error-both", feedId: 15,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "error-both", signedTx: Buffer.from("signed"), signature: "sig-error-both",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  journal.recordExecuteResponse(spec.id, 1, {
    status: "Success", code: 0, signature: "sig-error-both",
  });
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  const rpc = () => ({
    getSignatureStatuses: async () => ({ value: [errorStatus] }),
    getTransaction: async () => ({
      transaction: { signatures: ["sig-error-both"],
        message: { staticAccountKeys: [wallet.publicKey] } },
      meta: { err: errorStatus.err, fee: 5000 },
    }),
    // The signed-attempt expiry bound in _resume reads the chain first; 50 < 100
    // keeps this test about finalized-error consensus, not expiry.
    getBlockHeight: async () => 50,
  });
  const executor = new JupiterV2Executor({
    connection: rpc(), secondaryConnection: rpc(), keypair: wallet, journal, apiKey: "test",
    hardStop: () => true, now: () => 1000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "failed");
  assert.equal(journal.rollingRisk().realizedTodaySol, -0.000005);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("matching failure statuses cannot hide mismatched one-provider fee evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-error-fee-disagree-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "entry:50:entry:error-fee-disagree", kind: "entry", eventId: "error-fee", feedId: 21,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "error-fee", signedTx: Buffer.from("signed"),
    signature: "sig-error-fee", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "1000", minOutputRaw: "970", order: {},
  });
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  const rpc = (fee) => ({
    getSignatureStatuses: async () => ({ value: [errorStatus] }),
    getTransaction: async () => ({
      transaction: { signatures: ["sig-error-fee"],
        message: { staticAccountKeys: [wallet.publicKey] } },
      meta: { err: errorStatus.err, fee },
    }),
    getBlockHeight: async () => 50,
  });
  const executor = new JupiterV2Executor({
    connection: rpc(5000), secondaryConnection: rpc(6000), keypair: wallet, journal,
    apiKey: "test", hardStop: () => true, now: () => 1_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /different finalized network fees/);
  assert.equal(journal.db.prepare("SELECT COUNT(*) n FROM attempt_fee_events").get().n, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("matching failure fees cannot hide mismatched one-provider block times", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-error-time-disagree-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "entry:error-time-disagree", kind: "entry", eventId: "error-time", feedId: 22,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "error-time", signedTx: Buffer.from("signed"),
    signature: "sig-error-time", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "1000", minOutputRaw: "970", order: {},
  });
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  const rpc = (blockTime) => ({
    getSignatureStatuses: async () => ({ value: [errorStatus] }),
    getTransaction: async () => ({
      transaction: { signatures: ["sig-error-time"],
        message: { staticAccountKeys: [wallet.publicKey] } },
      meta: { err: errorStatus.err, fee: 5000 }, blockTime,
    }),
  });
  const executor = new JupiterV2Executor({
    connection: rpc(100), secondaryConnection: rpc(1_000), keypair: wallet, journal,
    apiKey: "test", now: () => 1_000_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  const consensus = await executor._confirmFinalizedFailure("sig-error-time",
    journal.getIntent(spec.id));
  assert.equal(consensus.confirmed, false);
  assert.match(consensus.reason, /different finalized block times/);
  assert.equal(journal.db.prepare("SELECT COUNT(*) n FROM attempt_fee_events").get().n, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("expiry-path failure evidence also requires matching metadata from both providers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-expiry-error-fee-disagree-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), {
    wallet: wallet.publicKey.toBase58(),
  });
  const spec = {
    id: "risk-exit:expiry-error-fee", kind: "risk_exit", eventId: null, feedId: null,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: "1000",
    context: { wallet: wallet.publicKey.toBase58(), position: {
      mint, qtyRaw: "1000", costBasisLamports: "5000000",
    } },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "expiry-error-fee", signedTx: Buffer.from("signed"),
    signature: "sig-expiry-error-fee", blockhash: recentBlockhash,
    lastValidBlockHeight: 100, quotedOutputRaw: "5000000", minOutputRaw: "4850000", order: {},
  });
  journal.markSubmitted(spec.id, 1);
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  let primaryStatusReads = 0;
  let secondaryStatusReads = 0;
  const failedTx = (fee) => ({
    transaction: { signatures: ["sig-expiry-error-fee"],
      message: { staticAccountKeys: [wallet.publicKey] } },
    meta: { err: errorStatus.err, fee },
  });
  const primary = {
    getSignatureStatuses: async () => ({ value: [++primaryStatusReads === 1 ? null : errorStatus] }),
    getTransaction: async () => failedTx(5000),
    getBlockHeight: async () => 101,
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [++secondaryStatusReads === 1 ? null : errorStatus] }),
    getTransaction: async () => failedTx(6000),
    getBlockHeight: async () => 101,
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal,
    apiKey: "test", hardStop: () => true, now: () => 1_000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /different finalized network fees/);
  assert.equal(journal.db.prepare("SELECT COUNT(*) n FROM attempt_fee_events").get().n, 0);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("durable Jupiter success can never expire into a replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-code0-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:11", kind: "entry", eventId: "50:entry:11", feedId: 11,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "success", signedTx: Buffer.from("signed"), signature: "sig-success",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  journal.recordExecuteResponse(spec.id, 1, {
    status: "Success", code: 0, signature: "sig-success",
    totalInputAmount: "5000000", totalOutputAmount: "987",
  });
  const rpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: rpc, secondaryConnection: rpc, keypair: wallet, journal, apiKey: "test",
    hardStop: () => true, now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /Jupiter reported confirmed success/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a submitted signature missing from pruned RPC history is permanently ambiguous", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-pruned-history-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:pruned", kind: "entry", eventId: "50:entry:pruned", feedId: 13,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "pruned", signedTx: Buffer.from("signed"), signature: "sig-pruned",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  journal.markSubmitted(spec.id, 1);
  const prunedRpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: prunedRpc, secondaryConnection: prunedRpc, keypair: wallet, journal,
    apiKey: "test", hardStop: () => true, now: () => 1000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "ambiguous");
  assert.match(journal.getIntent(spec.id).error, /submitted signature.*manual reconciliation/);
  await assert.rejects(() => executor.executeIntent(spec), /AMBIGUOUS/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a still-valid signed blockhash refuses replacement after height mismatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-blockhash-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet: wallet.publicKey.toBase58() });
  const spec = {
    id: "entry:50:entry:12", kind: "entry", eventId: "50:entry:12", feedId: 12,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  };
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1, requestId: "height-mismatch", signedTx: Buffer.from("signed"), signature: "sig-live",
    blockhash: recentBlockhash, lastValidBlockHeight: 100, quotedOutputRaw: "1000",
    minOutputRaw: "970", order: {},
  });
  const primary = {
    getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: true }),
  };
  const secondary = {
    getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ value: false }),
  };
  const executor = new JupiterV2Executor({
    connection: primary, secondaryConnection: secondary, keypair: wallet, journal, apiKey: "test",
    hardStop: () => true, now: () => 1000, sleep: async () => {}, config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "signed");
  assert.equal(journal.attempts(spec.id).length, 1);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${pass} live-execution safety checks passed\n`);
