import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import {
  ATA_PROGRAM, JUPITER_EVENT_AUTHORITY, JUPITER_V6, JupiterV2Executor,
  TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL, decodeJupiterExactIn, validateOrderEnvelope,
  validateSimulationEffects, validateTransaction, verifyFinalizedFill, priceImpactCapForIntent,
} from "./jupiter.mjs";

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

const wallet = Keypair.generate();
const mint = Keypair.generate().publicKey.toBase58();
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
const wrap = SystemProgram.transfer({
  fromPubkey: wallet.publicKey, toPubkey: sourceAta, lamports: 5_000_000,
});
const makeTx = (instructions = [wrap, jupiterIx], payer = wallet.publicKey) => new VersionedTransaction(
  new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(),
);
const validationConnection = {
  getAddressLookupTable: async () => ({ value: null }),
  getAccountInfo: async () => ({ owner: new PublicKey(TOKEN_PROGRAM) }),
  getMultipleAccountsInfo: async (keys) => keys.map(() => null),
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
  delegatedAmount = 0n, state = 1, closeAuthority = null }) => {
  const data = Buffer.alloc(165);
  new PublicKey(tokenMint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    new PublicKey(delegate).toBuffer().copy(data, 76);
  }
  data[108] = state;
  data.writeBigUInt64LE(BigInt(delegatedAmount), 121);
  if (closeAuthority) {
    data.writeUInt32LE(1, 129);
    new PublicKey(closeAuthority).toBuffer().copy(data, 133);
  }
  return {
    lamports: 2_039_280, owner: simulated ? TOKEN_PROGRAM : new PublicKey(TOKEN_PROGRAM),
    data: simulated ? [data.toString("base64"), "base64"] : data,
    executable: false, rentEpoch: 0,
  };
};

await ok("one locally authorized Jupiter route passes instruction validation", async () => {
  const result = await validateTransaction(makeTx(), expectedTx, cfg, validationConnection);
  assert.equal(result.jupiterRoutes, 1);
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
    getMultipleAccountsInfo: async (keys) => keys.map((key) => key.equals(auxiliary)
      ? tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 1 }) : null),
  };
  await assert.rejects(() => validateTransaction(makeTx([wrap, route]), expectedTx, cfg, connection),
    /unexpected wallet-owned token account/);
});
await ok("Token-2022 mints and truncated writable-account RPC data fail closed", async () => {
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg, {
    ...validationConnection,
    getAccountInfo: async (key) => ({ owner: new PublicKey(
      key.toBase58() === mint ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    ) }),
  }), /Token-2022/);
  await assert.rejects(() => validateTransaction(makeTx(), expectedTx, cfg, {
    ...validationConnection,
    getMultipleAccountsInfo: async () => [],
  }), /omitted writable-account capability data/);
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
  assert.equal(validateSimulationEffects(before, after, expected, cfg), true);
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
  let executeSucceeded = false;
  let chainSignature = "";
  const signedBodies = [];
  const connection = {
    getAddressLookupTable: async () => ({ value: null }),
    getAccountInfo: async () => ({ owner: new PublicKey(TOKEN_PROGRAM) }),
    getMultipleAccountsInfo: async (keys) => keys.map((key) =>
      key.toBase58() === wallet.publicKey.toBase58() ? systemAccount(20_000_000) : null),
    simulateTransaction: async () => ({ value: {
      err: null,
      accounts: [
        systemAccount(12_960_720, true),
        null,
        tokenAccount({ tokenMint: mint, owner: wallet.publicKey, amount: 987, simulated: true }),
      ],
      innerInstructions: [],
    } }),
    getSignatureStatuses: async () => ({ value: [executeSucceeded ? {
      err: null, confirmationStatus: "finalized", confirmations: null,
    } : null] }),
    getTransaction: async () => finalized(chainSignature),
    // Coherent with the order fixture's lastValidBlockHeight of 999: the expiry bound
    // added 2026-09-01 refuses to sign an order more than blockHeightWindow (600)
    // blocks ahead of the REAL chain. 999 - 600 = 399 ahead — a plausible fresh order.
    getBlockHeight: async () => 600,
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
    connection, keypair: wallet, journal, apiKey: "test-key", fetchFn,
    now: () => 1000, sleep: async () => {},
    config: { ...cfg, finalityTimeoutMs: 0, maxAttempts: 3 },
  });
  const spec = {
    id: "entry:50:entry:9", kind: "entry", eventId: "50:entry:9", feedId: 9,
    mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000", context: {},
  };
  await assert.rejects(() => executor.executeIntent(spec), /unresolved/);
  const fill = await executor.executeIntent(spec);
  assert.equal(fill.state, "confirmed");
  assert.equal(fill.actualOutputRaw, "987");
  assert.equal(fill.networkFeeLamports, "5000");
  assert.equal(orderCalls, 1, "must not obtain a replacement order while signature is live");
  assert.equal(executeCalls, 2);
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
  const executor = new JupiterV2Executor({
    connection: {
      getSignatureStatuses: async () => ({ value: [{
        err: null, confirmationStatus: "finalized", confirmations: null,
      }] }),
      getTransaction: async () => finalized("sig-paused"),
    },
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
  const errorStatus = { err: { InstructionError: [1, { Custom: 6001 }] },
    confirmationStatus: "finalized", confirmations: null };
  const rpc = {
    getSignatureStatuses: async () => ({ value: [errorStatus] }),
    getTransaction: async () => ({
      transaction: { signatures: ["sig-error-both"] },
      meta: { err: errorStatus.err, fee: 5000 },
    }),
    // The signed-attempt expiry bound in _resume reads the chain first; 50 < 100
    // keeps this test about finalized-error consensus, not expiry.
    getBlockHeight: async () => 50,
  };
  const executor = new JupiterV2Executor({
    connection: rpc, secondaryConnection: rpc, keypair: wallet, journal, apiKey: "test",
    hardStop: () => true, now: () => 1000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  await executor.recoverPending();
  assert.equal(journal.getIntent(spec.id).state, "failed");
  assert.equal(journal.rollingRisk().realizedTodaySol, -0.000005);
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
