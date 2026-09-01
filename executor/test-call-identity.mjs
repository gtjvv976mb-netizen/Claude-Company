import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import {
  ExecutionJournal, LEGACY_CALL_IDENTITY_POLICY, deskExitDecisionForPosition,
  positionEntryBlock, requirePositiveCallId,
} from "./journal.mjs";
import { freshState } from "./strategy.mjs";

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok   ${name}`);
};

const makePosition = (mint, entryIntentId, callId = 77) => ({
  mint, symbol: "IDENTITY", qtyRaw: "1000", paidSol: 0.005,
  costBasisLamports: "5000000", entryInputLamports: "4995000",
  solUsdAtEntry: 200, solUsdSource: "pyth-sol-usd-shard0-v1",
  entryIntentId, callId, openedAtMs: Date.now(),
  entry: 1, stop: 0.8, takeProfitX: 2, honorDeskTarget: true, riskF: 0.01,
});

const removeCallIdentity = (file, mint) => {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT data FROM positions WHERE mint=?").get(mint);
  const value = JSON.parse(row.data);
  delete value.callId;
  delete value.callIdentityIncomplete;
  delete value.callIdentityIncompleteReason;
  delete value.callIdentityPolicy;
  db.prepare("UPDATE positions SET data=? WHERE mint=?").run(JSON.stringify(value), mint);
  db.close();
};

ok("held positions require both mint and exact originating call_id", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const position = makePosition(mint, "entry:77");
  assert.deepEqual(deskExitDecisionForPosition(position, { mint, call_id: 77 }),
    { action: "exit", reason: "exact-call", callId: 77 });
  assert.deepEqual(deskExitDecisionForPosition(position, { mint, call_id: 78 }),
    { action: "ignore", reason: "different-call", callId: 78, positionCallId: 77 });
  assert.deepEqual(deskExitDecisionForPosition(position,
    { mint: Keypair.generate().publicKey.toBase58(), call_id: 77 }),
  { action: "ignore", reason: "different-mint" });
  assert.throws(() => deskExitDecisionForPosition(position, { mint }), /call_id is invalid/);
  assert.equal(requirePositiveCallId("77"), 77);
  assert.throws(() => requirePositiveCallId(0), /call_id is invalid/);
});

ok("an explicitly quarantined legacy position takes only the risk-reducing fallback", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const position = makePosition(mint, "legacy-entry");
  delete position.callId;
  position.callIdentityIncomplete = true;
  position.callIdentityIncompleteReason = "legacy identity unavailable";
  position.callIdentityPolicy = LEGACY_CALL_IDENTITY_POLICY;
  assert.deepEqual(deskExitDecisionForPosition(position, { mint, call_id: 90 }),
    { action: "exit", reason: "legacy-risk-reduction", callId: 90 });
  assert.match(positionEntryBlock(position), /legacy identity unavailable/);
  delete position.callIdentityPolicy;
  assert.throws(() => deskExitDecisionForPosition(position, { mint, call_id: 90 }),
    /no durable call identity/);
});

ok("upgrade recovers callId only from the exact durable entry intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-call-id-recover-"));
  const file = path.join(dir, "state.sqlite");
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const entryIntentId = "entry:50:entry:77";
  let journal = new ExecutionJournal(file, { wallet });
  journal.ensureIntent({
    id: entryIntentId, kind: "entry", eventId: "50:entry:77", feedId: 77,
    mint, inputMint: Keypair.generate().publicKey.toBase58(), outputMint: mint,
    amountRaw: "5000000", context: { event: { mint, call_id: 77 } },
  });
  journal.saveRuntime({ cursor: 77, primed: true, state: freshState(Date.now()),
    positions: { [mint]: makePosition(mint, entryIntentId) } });
  journal.close();
  removeCallIdentity(file, mint);

  journal = new ExecutionJournal(file, { wallet, create: false });
  const recovered = journal.snapshot().positions[mint];
  assert.equal(recovered.callId, 77);
  assert.equal(recovered.callIdentityIncomplete, undefined);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ok("unprovable legacy identity is persisted, visible, and blocks new exposure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-call-id-legacy-"));
  const file = path.join(dir, "state.sqlite");
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  let journal = new ExecutionJournal(file, { wallet });
  journal.saveRuntime({ cursor: 77, primed: true, state: freshState(Date.now()),
    positions: { [mint]: makePosition(mint, "missing-legacy-entry") } });
  journal.close();
  removeCallIdentity(file, mint);

  journal = new ExecutionJournal(file, { wallet, create: false });
  const legacy = journal.snapshot().positions[mint];
  assert.equal(legacy.callId, undefined);
  assert.equal(legacy.callIdentityIncomplete, true);
  assert.equal(legacy.callIdentityPolicy, LEGACY_CALL_IDENTITY_POLICY);
  assert.match(positionEntryBlock(legacy), /no provable originating call_id/);
  assert.deepEqual(deskExitDecisionForPosition(legacy, { mint, call_id: 91 }),
    { action: "exit", reason: "legacy-risk-reduction", callId: 91 });
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ok("newly saved positions cannot omit or corrupt call identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-call-id-invalid-"));
  const file = path.join(dir, "state.sqlite");
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const journal = new ExecutionJournal(file, { wallet });
  const missing = makePosition(mint, "entry:missing");
  delete missing.callId;
  assert.throws(() => journal.saveRuntime({ cursor: 1, primed: true,
    state: freshState(Date.now()), positions: { [mint]: missing } }), /no durable callId/);
  assert.throws(() => journal.saveRuntime({ cursor: 1, primed: true,
    state: freshState(Date.now()), positions: {
      [mint]: { ...missing, callId: 0 },
    } }), /invalid callId/);
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} call-identity safety checks passed\n`);
