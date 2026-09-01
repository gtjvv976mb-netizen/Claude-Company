import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import { JupiterV2Executor, WSOL } from "./jupiter.mjs";

let pass = 0;
const ok = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ok   ${name}`);
};

const makeJournal = (wallet) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-intent-blocking-"));
  const journal = new ExecutionJournal(path.join(dir, "state.sqlite"), { wallet });
  return { dir, journal };
};

const closeJournal = ({ dir, journal }) => {
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
};

const intent = ({ id, kind, mint, inputMint, outputMint, amountRaw = "1000", wallet }) => ({
  id, kind, eventId: id, feedId: null, mint, inputMint, outputMint, amountRaw,
  context: {
    wallet,
    ...((kind === "risk_exit" || kind === "desk_exit") ? {
      position: { mint, qtyRaw: amountRaw, costBasisLamports: "5000000" },
    } : {}),
  },
});

const signed = (id) => ({
  requestId: `request:${id}`,
  signedTx: Buffer.from(`signed:${id}`),
  signature: `signature:${id}`,
  blockhash: `blockhash:${id}`,
  lastValidBlockHeight: 999,
  quotedOutputRaw: "900",
  minOutputRaw: "800",
  order: {},
});

await ok("unresolved work freezes entries but not a different position's safety exit", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const mintA = Keypair.generate().publicKey.toBase58();
    const mintB = Keypair.generate().publicKey.toBase58();
    const mintC = Keypair.generate().publicKey.toBase58();
    const blocker = intent({ id: "entry:blocker", kind: "entry", mint: mintA,
      inputMint: WSOL, outputMint: mintA, amountRaw: "5000000", wallet });
    journal.ensureIntent(blocker);
    journal.recordSigned(blocker.id, { ...signed(blocker.id), attempt: 1 });
    journal.markAmbiguous(blocker.id, 1, "waiting for independent chain evidence");

    const builds = [];
    const executor = new JupiterV2Executor({
      connection: {}, keypair, journal, apiKey: "test",
      config: { maxAttempts: 3 },
    });
    executor._buildSigned = async (candidate) => {
      builds.push(candidate.id);
      return signed(candidate.id);
    };
    executor._resume = async (candidate) => journal.getIntent(candidate.id);

    const unrelatedExit = intent({ id: "risk_exit:mint-b", kind: "risk_exit", mint: mintB,
      inputMint: mintB, outputMint: WSOL, wallet });
    const exitResult = await executor.executeIntent(unrelatedExit);
    assert.equal(exitResult.state, "signed");
    assert.deepEqual(builds, [unrelatedExit.id]);

    const samePositionExit = intent({ id: "risk_exit:mint-a", kind: "risk_exit", mint: mintA,
      inputMint: mintA, outputMint: WSOL, wallet });
    await assert.rejects(() => executor.executeIntent(samePositionExit),
      /unresolved intent entry:blocker conflicts/);

    const newEntry = intent({ id: "entry:new", kind: "entry", mint: mintC,
      inputMint: WSOL, outputMint: mintC, amountRaw: "5000000", wallet });
    await assert.rejects(() => executor.executeIntent(newEntry),
      /unresolved intent .* conflicts with entry/);
    const disguisedEntry = intent({ id: "risk_exit:disguised-entry", kind: "risk_exit", mint: mintC,
      inputMint: WSOL, outputMint: mintC, amountRaw: "5000000", wallet });
    await assert.rejects(() => executor.executeIntent(disguisedEntry),
      /exit intent must reduce its durable named position/);
    assert.equal(builds.length, 1, "blocked candidates must never reach transaction construction");
    assert.equal(journal.hasBlockingIntent() != null, true,
      "the poller's global new-exposure freeze remains intact");
  } finally { closeJournal(holder); }
});

await ok("in-process races serialize one position while allowing another position's exit", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  let releaseFirst;
  let firstBuildStarted;
  const started = new Promise((resolve) => { firstBuildStarted = resolve; });
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    const mintA = Keypair.generate().publicKey.toBase58();
    const mintB = Keypair.generate().publicKey.toBase58();
    const mintC = Keypair.generate().publicKey.toBase58();
    const firstExit = intent({ id: "risk_exit:first", kind: "risk_exit", mint: mintA,
      inputMint: mintA, outputMint: WSOL, wallet });
    const executor = new JupiterV2Executor({ connection: {}, keypair, journal, apiKey: "test" });
    executor._buildSigned = async (candidate) => {
      if (candidate.id === firstExit.id) {
        firstBuildStarted();
        await held;
      }
      return signed(candidate.id);
    };
    executor._resume = async (candidate) => journal.getIntent(candidate.id);

    const first = executor.executeIntent(firstExit);
    await started;
    const sameMint = intent({ id: "desk_exit:same", kind: "desk_exit", mint: mintA,
      inputMint: mintA, outputMint: WSOL, wallet });
    await assert.rejects(() => executor.executeIntent(sameMint), /in-flight intent .* serialized/);

    const entry = intent({ id: "entry:during-exit", kind: "entry", mint: mintC,
      inputMint: WSOL, outputMint: mintC, amountRaw: "5000000", wallet });
    await assert.rejects(() => executor.executeIntent(entry), /in-flight intent .* serialized/);

    const otherMint = intent({ id: "risk_exit:other", kind: "risk_exit", mint: mintB,
      inputMint: mintB, outputMint: WSOL, wallet });
    assert.equal((await executor.executeIntent(otherMint)).state, "signed");
    releaseFirst();
    assert.equal((await first).state, "signed");
    assert.equal(journal.attempts(firstExit.id).length, 1);
    assert.equal(journal.attempts(otherMint.id).length, 1);
  } finally {
    releaseFirst?.();
    closeJournal(holder);
  }
});

await ok("an exit that starts during entry construction freezes that entry before signed bytes are journaled", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  let releaseEntry;
  let entryBuildStarted;
  const started = new Promise((resolve) => { entryBuildStarted = resolve; });
  const held = new Promise((resolve) => { releaseEntry = resolve; });
  let pendingEntry;
  try {
    const entryMint = Keypair.generate().publicKey.toBase58();
    const exitMint = Keypair.generate().publicKey.toBase58();
    const entrySpec = intent({ id: "entry:held-build", kind: "entry", mint: entryMint,
      inputMint: WSOL, outputMint: entryMint, amountRaw: "5000000", wallet });
    const executor = new JupiterV2Executor({ connection: {}, keypair, journal, apiKey: "test" });
    executor._buildSigned = async (candidate) => {
      if (candidate.id === entrySpec.id) {
        entryBuildStarted();
        await held;
      }
      return signed(candidate.id);
    };
    executor._resume = async (candidate) => journal.getIntent(candidate.id);

    pendingEntry = executor.executeIntent(entrySpec);
    await started;
    const safetyExit = intent({ id: "risk_exit:during-entry", kind: "risk_exit", mint: exitMint,
      inputMint: exitMint, outputMint: WSOL, wallet });
    assert.equal((await executor.executeIntent(safetyExit)).state, "signed");
    releaseEntry();
    await assert.rejects(() => pendingEntry, /submission scope changed during build/);
    assert.equal(journal.attempts(entrySpec.id).length, 0,
      "the newly blocked entry's undisclosed signed bytes must not cross the journal boundary");
    assert.equal(journal.attempts(safetyExit.id).length, 1);
  } finally {
    releaseEntry?.();
    await pendingEntry?.catch(() => {});
    closeJournal(holder);
  }
});

await ok("ambiguous recovery retries chain evidence without resubmitting or replacing bytes", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    const spec = intent({ id: "entry:ambiguous-error", kind: "entry", mint,
      inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet });
    journal.ensureIntent(spec);
    journal.recordSigned(spec.id, { ...signed(spec.id), attempt: 1 });
    journal.markSubmitted(spec.id, 1);
    journal.markAmbiguous(spec.id, 1, "secondary RPC has not caught up");

    const chainError = { InstructionError: [1, { Custom: 6001 }] };
    const errorStatus = { err: chainError, confirmationStatus: "finalized", confirmations: null };
    const failedTransaction = {
      transaction: {
        signatures: [`signature:${spec.id}`],
        message: { staticAccountKeys: [keypair.publicKey] },
      },
      meta: { err: chainError, fee: 5000 },
    };
    let secondaryReady = false;
    let executeCalls = 0;
    const executor = new JupiterV2Executor({
      connection: {
        getSignatureStatuses: async () => ({ value: [errorStatus] }),
        getTransaction: async () => failedTransaction,
      },
      secondaryConnection: {
        getSignatureStatuses: async () => ({ value: [secondaryReady ? errorStatus : null] }),
        getTransaction: async () => secondaryReady ? failedTransaction : null,
      },
      keypair, journal, apiKey: "test", now: () => 1000, sleep: async () => {},
      fetchFn: async () => { executeCalls++; throw new Error("recovery must not POST signed bytes"); },
      config: { finalityTimeoutMs: 0 },
    });

    await executor.recoverPending();
    assert.equal(journal.getIntent(spec.id).state, "ambiguous");
    assert.equal(executeCalls, 0);
    secondaryReady = true;
    await executor.recoverPending();
    assert.equal(journal.getIntent(spec.id).state, "failed");
    assert.equal(journal.attempts(spec.id).length, 1, "recovery must retain the original signature only");
    assert.equal(executeCalls, 0);
  } finally { closeJournal(holder); }
});

await ok("an accounting-quarantined confirmed exit cannot consume the bounded recovery slot", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const quarantinedMint = Keypair.generate().publicKey.toBase58();
    const pendingMint = Keypair.generate().publicKey.toBase58();
    const quarantined = intent({ id: "risk_exit:a-confirmed-quarantine", kind: "risk_exit",
      mint: quarantinedMint, inputMint: quarantinedMint, outputMint: WSOL,
      amountRaw: "1000", wallet });
    journal.ensureIntent(quarantined);
    journal.recordSigned(quarantined.id, { ...signed(quarantined.id), attempt: 1 });
    journal.markSubmitted(quarantined.id, 1);
    journal.markConfirmed(quarantined.id, 1, {
      signature: `signature:${quarantined.id}`,
      totalInputAmount: "1000", totalOutputAmount: "4000000",
      networkFeeLamports: "5000", finalizedAtMs: 1000,
    }, { status: "RecoveredFromFinalizedChain" });

    const pending = intent({ id: "risk_exit:z-pending", kind: "risk_exit",
      mint: pendingMint, inputMint: pendingMint, outputMint: WSOL,
      amountRaw: "1000", wallet });
    journal.ensureIntent(pending);
    journal.recordSigned(pending.id, { ...signed(pending.id), attempt: 1 });
    let statusReads = 0;
    const executor = new JupiterV2Executor({
      connection: {
        getSignatureStatuses: async () => { statusReads++; return { value: [null] }; },
        getBlockHeight: async () => 50,
      },
      secondaryConnection: {
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 50,
      },
      keypair, journal, apiKey: "test", now: () => 1000, sleep: async () => {},
      config: { finalityTimeoutMs: 0 },
    });
    await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
    assert.ok(statusReads > 0,
      "the one bounded slot must reach real chain-recovery work behind confirmed accounting quarantine");
    assert.equal(journal.getIntent(pending.id).state, "signed");
    assert.equal(journal.getIntent(quarantined.id).state, "confirmed");
  } finally { closeJournal(holder); }
});

await ok("bounded recovery rotates across independently unresolved safety exits", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const firstMint = Keypair.generate().publicKey.toBase58();
    const secondMint = Keypair.generate().publicKey.toBase58();
    for (const spec of [
      intent({ id: "risk_exit:a-wedged", kind: "risk_exit", mint: firstMint,
        inputMint: firstMint, outputMint: WSOL, amountRaw: "1000", wallet }),
      intent({ id: "risk_exit:b-fresh-stop", kind: "risk_exit", mint: secondMint,
        inputMint: secondMint, outputMint: WSOL, amountRaw: "1000", wallet }),
    ]) {
      journal.ensureIntent(spec);
      journal.recordSigned(spec.id, { ...signed(spec.id), attempt: 1 });
    }
    const observedSignatures = [];
    const primary = {
      getSignatureStatuses: async ([signature]) => {
        observedSignatures.push(signature);
        return { value: [null] };
      },
      getBlockHeight: async () => 50,
    };
    const executor = new JupiterV2Executor({
      connection: primary,
      secondaryConnection: {
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 50,
      },
      keypair, journal, apiKey: "test", now: () => 1000, sleep: async () => {},
      config: { finalityTimeoutMs: 0 },
    });
    await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
    await executor.recoverPending({ observationOnly: true, maxIntents: 1 });
    assert.deepEqual(observedSignatures.slice(0, 2), [
      "signature:risk_exit:a-wedged", "signature:risk_exit:b-fresh-stop",
    ], "one unresolved exit may consume one pass, never every future pass");
  } finally { closeJournal(holder); }
});

await ok("an ambiguous formerly-submitted signature can never expire into replacement authority", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    const spec = intent({ id: "entry:ambiguous-pruned", kind: "entry", mint,
      inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet });
    journal.ensureIntent(spec);
    journal.recordSigned(spec.id, { ...signed(spec.id), attempt: 1, lastValidBlockHeight: 100 });
    journal.markSubmitted(spec.id, 1);
    journal.markAmbiguous(spec.id, 1, "RPC histories unavailable");

    const absentRpc = {
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 101,
      isBlockhashValid: async () => ({ value: false }),
    };
    let executeCalls = 0;
    const executor = new JupiterV2Executor({
      connection: absentRpc,
      secondaryConnection: { ...absentRpc },
      keypair, journal, apiKey: "test", now: () => 1000,
      sleep: async () => { throw new Error("ambiguous recovery must use a one-shot probe"); },
      fetchFn: async () => { executeCalls++; throw new Error("ambiguous recovery must not submit"); },
      config: { finalityTimeoutMs: 30_000 },
    });
    await executor.recoverPending();
    assert.equal(journal.getIntent(spec.id).state, "ambiguous");
    assert.match(journal.getIntent(spec.id).error, /ambiguous signature is absent/);
    assert.equal(journal.attempts(spec.id).length, 1);
    assert.equal(executeCalls, 0);
  } finally { closeJournal(holder); }
});

await ok("presence-seeking finality reads use the secondary when the primary is merely behind", async () => {
  const keypair = Keypair.generate();
  const transaction = { transaction: { signatures: ["secondary-signature"] }, meta: { err: null } };
  const executor = new JupiterV2Executor({
    connection: {
      getSignatureStatuses: async () => ({ value: [null] }),
      getTransaction: async () => null,
    },
    secondaryConnection: {
      getSignatureStatuses: async () => ({ value: [{
        err: null, confirmationStatus: "finalized", confirmations: null,
      }] }),
      getTransaction: async () => transaction,
    },
    keypair, journal: {}, apiKey: "test", now: () => 1000, sleep: async () => {},
    config: { finalityTimeoutMs: 0 },
  });
  const result = await executor._waitFinalized("secondary-signature");
  assert.equal(result.outcome, "finalized");
  assert.equal(result.transaction, transaction);
});

await ok("a malformed durable exit is reconciled read-only and never resumed", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    const malformed = intent({ id: "risk_exit:malformed-durable", kind: "risk_exit", mint,
      inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet });
    journal.ensureIntent(malformed);
    journal.recordSigned(malformed.id, { ...signed(malformed.id), attempt: 1 });
    let executeCalls = 0;
    const executor = new JupiterV2Executor({
      connection: {
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 600,
      },
      keypair, journal, apiKey: "test", now: () => 1000, sleep: async () => {},
      fetchFn: async () => { executeCalls++; throw new Error("malformed intent must not submit"); },
      config: { finalityTimeoutMs: 30_000 },
    });
    await executor.recoverPending();
    assert.equal(journal.getIntent(malformed.id).state, "signed");
    assert.equal(journal.attempts(malformed.id).length, 1);
    assert.equal(executeCalls, 0);
  } finally { closeJournal(holder); }
});

await ok("a desk exit is durable while its exact buy is unresolved and consumed with accounting", async () => {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const holder = makeJournal(wallet);
  const { journal } = holder;
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    const spec = intent({ id: "entry:deferred-exit", kind: "entry", mint,
      inputMint: WSOL, outputMint: mint, amountRaw: "5000000", wallet });
    spec.context.event = { call_id: 77, mint };
    journal.ensureIntent(spec);
    journal.recordSigned(spec.id, { ...signed(spec.id), attempt: 1 });
    assert.equal(journal.blockingEntryForDeskExit({ mint, callId: 77 })?.id, spec.id);
    assert.equal(journal.blockingEntryForDeskExit({ mint, callId: 78 }), null,
      "an exit for another call must not attach to this buy merely because the mint matches");
    assert.throws(() => journal.blockingEntryForDeskExit({ mint, callId: null }),
      /desk exit call_id is invalid/,
      "an unmatchable exit must pin the feed instead of being acknowledged as not held");
    const deferred = journal.deferDeskExitForEntry({
      entryIntentId: spec.id, eventId: "50:exit:91", feedId: 91, callId: 77,
      mint, reason: "desk exit (rug)", observedAt: Date.now(),
    });
    assert.equal(deferred.entryIntentId, spec.id);
    assert.throws(() => journal.deferDeskExitForEntry({ ...deferred, callId: 78 }),
      /does not match|changed/);

    const confirmed = journal.markConfirmed(spec.id, 1, {
      totalInputAmount: "5000000", totalOutputAmount: "1000",
      networkFeeLamports: "5000", signature: `signature:${spec.id}`,
      finalizedAtMs: Date.now(),
    }, { status: "Success", code: 0 });
    assert.equal(confirmed.state, "confirmed");
    const now = Date.now();
    const position = {
      mint, symbol: "SAFE", qtyRaw: "1000", paidSol: 0.005005,
      costBasisLamports: "5005000", entryInputLamports: "5000000",
      solUsdAtEntry: 200, solUsdSource: "pyth-sol-usd-shard0-v1",
      entryIntentId: spec.id, openedAtMs: now,
      callId: 77,
      entry: 1, stop: 0.8, takeProfitX: 2, honorDeskTarget: true, riskF: 0.01,
      exitExecutionRequired: true, exitExecutionReason: deferred.reason,
      exitExecutionIntentId: `desk-exit:${deferred.eventId}`,
      exitExecutionObservedAt: deferred.observedAt,
    };
    journal.markAccounted(spec.id, {
      cursor: 91, primed: true,
      state: { dayStart: now, deployedTodaySol: 0, realizedTodaySol: 0,
        openCount: 1, wins: 0, losses: 0, bookHeat: 0.01,
        spendableSol: 0.1, equitySol: 0.1 },
      positions: { [mint]: position },
    }, { consumeDeferredDeskExit: true });
    assert.equal(journal.deferredDeskExitForEntry(spec.id), null);
    assert.equal(journal.snapshot().positions[mint].exitExecutionRequired, true,
      "the exit latch and buy accounting cross the crash boundary together");
  } finally { closeJournal(holder); }
});

console.log(`\n${pass} intent-blocking safety checks passed\n`);
