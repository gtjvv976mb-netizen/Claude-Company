import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import { ExecutionJournal, acquireProcessLock, positionEntryBlock, trackedBalanceDecision } from "./journal.mjs";
import { freshState } from "./strategy.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-journal-"));
const file = path.join(dir, "state.sqlite");
const wallet = Keypair.generate().publicKey.toBase58();
let tests = 0;
const ok = (name, fn) => {
  fn();
  tests++;
  console.log(`  ok   ${name}`);
};

let j = new ExecutionJournal(file, { wallet });
ok("journal is owner-only", () => assert.equal(fs.statSync(file).mode & 0o077, 0));
ok("journal binds its wallet", () => assert.equal(j.getMeta("wallet"), wallet));

const spec = {
  id: "entry:50:entry:101", kind: "entry", eventId: "50:entry:101", feedId: 101,
  mint: Keypair.generate().publicKey.toBase58(),
  inputMint: Keypair.generate().publicKey.toBase58(),
  outputMint: Keypair.generate().publicKey.toBase58(),
  amountRaw: "5000000", context: { callId: 7 },
};
const intent = j.ensureIntent(spec);
ok("intent begins planned", () => assert.equal(intent.state, "planned"));
ok("same feed intent is idempotent", () => assert.equal(j.ensureIntent(spec).id, spec.id));
ok("same id cannot change amount", () => assert.throws(
  () => j.ensureIntent({ ...spec, amountRaw: "5000001" }), /changed amountRaw/));

j.recordSigned(spec.id, {
  attempt: 1, requestId: "request-1", signedTx: Buffer.from("exact signed bytes"),
  signature: "signature-1", blockhash: "blockhash-1", lastValidBlockHeight: 999,
  quotedOutputRaw: "1000", minOutputRaw: "900", order: { router: "metis" },
});
ok("signed bytes are durable before submission", () => {
  const a = j.latestAttempt(spec.id);
  assert.equal(a.state, "signed");
  assert.equal(a.signedTx.toString(), "exact signed bytes");
});
j.close();

j = new ExecutionJournal(file, { wallet, create: false });
ok("restart recovers the identical signature and bytes", () => {
  const a = j.latestAttempt(spec.id);
  assert.equal(a.signature, "signature-1");
  assert.equal(a.signedTx.toString(), "exact signed bytes");
  assert.equal(j.pendingIntents()[0].id, spec.id);
});
j.markSubmitted(spec.id, 1);
j.recordExecuteResponse(spec.id, 1, { status: "Success", code: 0, signature: "signature-1" });
j.markConfirmed(spec.id, 1, {
  totalInputAmount: "5000000", totalOutputAmount: "987", networkFeeLamports: "5000",
  signature: "signature-1",
}, { status: "Success", code: 0, signature: "signature-1" });
ok("actual fill totals, not quote output, are recorded", () => {
  const value = j.getIntent(spec.id);
  assert.equal(value.actualOutputRaw, "987");
  assert.notEqual(value.actualOutputRaw, "1000");
});

const runtime = {
  cursor: 101, primed: true,
  state: freshState(1),
  positions: { [spec.mint]: { mint: spec.mint, symbol: "TEST", qtyRaw: "987",
    paidSol: 0.005005, costBasisLamports: "5005000", entryInputLamports: "5000000",
    solUsdAtEntry: 150, entryIntentId: spec.id, openedAtMs: 1, entry: 1, stop: 0.6,
    takeProfitX: 2, honorDeskTarget: true, riskF: 0.02 } },
};
j.markAccounted(spec.id, runtime);
const accountedRisk = j.rollingRisk();
j.markAccounted(spec.id, runtime);
ok("accounting replay is idempotent and cannot duplicate risk events", () =>
  assert.deepEqual(j.rollingRisk(), accountedRisk));
j.close();
j = new ExecutionJournal(file, { wallet, create: false });
ok("fill accounting and cursor commit together", () => {
  const snap = j.snapshot();
  assert.equal(j.getIntent(spec.id).state, "accounted");
  assert.equal(snap.cursor, 101);
  assert.equal(snap.positions[spec.mint].qtyRaw, "987");
  assert.equal(snap.positions[spec.mint].costBasisLamports, "5005000");
  assert.equal(snap.state.deployedTodaySol, 0.005005);
});
ok("rolling deployment expires only after its exact 24-hour boundary", () => {
  const occurredAt = j.getIntent(spec.id).confirmedAt;
  assert.equal(j.rollingRisk(occurredAt + 24 * 60 * 60_000 - 1).deployedTodaySol, 0.005005);
  assert.equal(j.rollingRisk(occurredAt + 24 * 60 * 60_000).deployedTodaySol, 0);
});
const failedSpec = {
  ...spec, id: "entry:50:entry:failed-fee", eventId: "50:entry:failed-fee", feedId: 102,
};
j.ensureIntent(failedSpec);
j.recordSigned(failedSpec.id, {
  attempt: 1, requestId: "failed-fee", signedTx: Buffer.from("failed signed bytes"),
  signature: "failed-signature", blockhash: "failed-blockhash", lastValidBlockHeight: 999,
  quotedOutputRaw: "1000", minOutputRaw: "900", order: { router: "metis" },
});
j.markFinalizedFailure(failedSpec.id, 1, "finalized program error", {
  networkFeeLamports: "5000", finalizedAtMs: Date.now(),
}, { status: "Failed" });
ok("a finalized failed attempt debits deployment and realized-loss rails", () => {
  const risk = j.rollingRisk();
  assert.equal(risk.deployedTodaySol, 0.00501);
  assert.equal(risk.realizedTodaySol, -0.000005);
});
ok("a different wallet cannot reuse the journal", () => assert.throws(
  () => new ExecutionJournal(file, { wallet: Keypair.generate().publicKey.toBase58(), create: false }),
  /journal belongs to wallet/));

ok("the full durable position is exit-eligible when the primary sees it", () => {
  assert.deepEqual(trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "1000" }),
    { verified: true, amountRaw: "1000" });
  assert.deepEqual(trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "1200" }),
    { verified: true, amountRaw: "1000" });
});
ok("a partial primary read cannot shrink and retire the durable position", () => {
  const result = trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "500",
    secondaryRaw: "1000" });
  assert.equal(result.verified, false);
  assert.match(result.reason, /RPC balance disagreement/);
});
ok("even two zero reads require reconciliation rather than deleting the position", () => {
  const result = trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "0",
    secondaryRaw: "0" });
  assert.equal(result.verified, false);
  assert.match(result.reason, /both RPCs report below tracked balance/);
});

const lockFile = path.join(dir, "executor.lock");
const release = acquireProcessLock(lockFile);
ok("single-process lock rejects a live owner", () => assert.throws(
  () => acquireProcessLock(lockFile), /lock already exists \(active pid/));
release();
fs.writeFileSync(lockFile, "99999999\n", { mode: 0o600 });
const releaseReclaimed = acquireProcessLock(lockFile);
ok("a crash-stale lock is atomically reclaimed without allowing two owners", () =>
  assert.ok(fs.existsSync(lockFile)));
releaseReclaimed();

const corruptFile = path.join(dir, "corrupt.sqlite");
let corrupt = new ExecutionJournal(corruptFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: {
  [spec.mint]: { ...runtime.positions[spec.mint] },
} });
corrupt.close();
let raw = new DatabaseSync(corruptFile);
raw.prepare("UPDATE positions SET data='{' WHERE mint=?").run(spec.mint);
raw.close();
ok("corrupt position JSON refuses startup instead of erasing risk", () => assert.throws(
  () => new ExecutionJournal(corruptFile, { wallet, create: false }), /position .* corrupt JSON/));

const malformedFile = path.join(dir, "malformed.sqlite");
corrupt = new ExecutionJournal(malformedFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: {
  [spec.mint]: { ...runtime.positions[spec.mint] },
} });
corrupt.close();
raw = new DatabaseSync(malformedFile);
raw.prepare("UPDATE positions SET data=? WHERE mint=?")
  .run(JSON.stringify({ ...runtime.positions[spec.mint], qtyRaw: "0" }), spec.mint);
raw.close();
ok("valid JSON with an invalid position schema also refuses startup", () => assert.throws(
  () => new ExecutionJournal(malformedFile, { wallet, create: false }), /invalid qtyRaw/));

const riskFile = path.join(dir, "bad-risk.sqlite");
corrupt = new ExecutionJournal(riskFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: {} });
corrupt.close();
raw = new DatabaseSync(riskFile);
raw.prepare("UPDATE meta SET value=? WHERE key='risk_state'")
  .run(JSON.stringify({ ...freshState(1), deployedTodaySol: -1000, realizedTodaySol: 1000 }));
raw.close();
ok("valid JSON cannot corrupt rolling risk rails into negative deploy capacity", () => assert.throws(
  () => new ExecutionJournal(riskFile, { wallet, create: false }), /deployedTodaySol is invalid/));

ok("every durable reconciliation/monitor/exit flag blocks new exposure", () => {
  assert.match(positionEntryBlock({ riskDataUnavailable: true,
    riskDataUnavailableReason: "mark outage" }), /mark outage/);
  assert.match(positionEntryBlock({ exitExecutionRequired: true,
    exitExecutionReason: "stop fired" }), /stop fired/);
});

const incompleteFile = path.join(dir, "incomplete-history.sqlite");
let incomplete = new ExecutionJournal(incompleteFile, { wallet });
incomplete.saveRuntime({ cursor: 1, primed: true, state: {
  ...freshState(1), deployedTodaySol: 0.005, realizedTodaySol: -0.001,
}, positions: {} });
incomplete.close();
incomplete = new ExecutionJournal(incompleteFile, { wallet, create: false });
ok("legacy nonzero counters without ledger events trigger a 24-hour entry quarantine", () => {
  const status = incomplete.riskHistoryStatus();
  assert.equal(status.complete, false);
  assert.ok(status.incompleteUntil > Date.now() + 23 * 60 * 60_000);
});
incomplete.close();

j.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} journal safety checks passed\n`);
