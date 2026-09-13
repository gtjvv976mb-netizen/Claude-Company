import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import {
  CURRENT_TX_ATTEMPT_PROTOCOL, SNIPE_TX_ATTEMPT_PROTOCOL, TX_ATTEMPT_PROTOCOLS, ExecutionJournal, acquireProcessLock,
  positionEntryBlock, trackedBalanceDecision, INTENT_KINDS, POSITION_SCOPED_KINDS,
} from "./journal.mjs";
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
  assert.equal(a.protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
});
j.close();

j = new ExecutionJournal(file, { wallet, create: false });
ok("restart recovers the identical signature and bytes", () => {
  const a = j.latestAttempt(spec.id);
  assert.equal(a.signature, "signature-1");
  assert.equal(a.signedTx.toString(), "exact signed bytes");
  assert.equal(a.protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
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
    solUsdAtEntry: 150, solUsdSource: "pyth-sol-usd-shard0-v1",
    entryIntentId: spec.id, openedAtMs: 1, entry: 1, stop: 0.6,
    callId: 7, takeProfitX: 2, honorDeskTarget: true, riskF: 0.02 } },
};
j.markAccounted(spec.id, runtime);
const accountedRisk = j.rollingRisk();
j.markAccounted(spec.id, runtime);
/* rollingRisk() stamps riskWindowAsOf with Date.now() on every call; two calls a
   millisecond apart are not "different risk", and the CI runner lost exactly that race
   (…895 vs …894, 2026-09-05) and blocked a deploy. Compare the risk, bound the clock. */
const sansClock = (r) => { const { riskWindowAsOf, ...rest } = r; return rest; };
ok("the lifetime ledger sums every deployment, with the fee, and starts with nothing realized", () => {
  const life = j.lifetimeRisk();
  assert.equal(life.deployments, 1);
  assert.equal(life.exits, 0);
  assert.ok(Math.abs(life.deployedSol - accountedRisk.deployedTodaySol) < 1e-12, `${life.deployedSol} vs ${accountedRisk.deployedTodaySol}`);
  assert.ok(Math.abs(life.realizedSol - accountedRisk.realizedTodaySol) < 1e-12);
  assert.ok(life.firstAt > 0 && life.lastAt >= life.firstAt);
});
ok("accounting replay is idempotent and cannot duplicate risk events", () => {
  const again = j.rollingRisk();
  assert.deepEqual(sansClock(again), sansClock(accountedRisk));
  assert.ok(Math.abs(again.riskWindowAsOf - accountedRisk.riskWindowAsOf) < 5_000, "risk window clocks within 5s");
});
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

/* RE-ANCHORED (step 26). riskDataUnavailable used to be in POSITION_BLOCK_FLAGS and this
   pinned it there. It is out on purpose: under desk-led-v4 the exit MARK decides nothing
   (a desk_exit never consults it), so one coin the bot could not quote — the everyday
   state of a drained pump.fun pool — froze every entry on the book. It remains the
   heartbeat/monitor health signal. What blocks now is custody and identity: the desk
   answering about ANOTHER COIN under a held call id took its place in the list, so the
   property "a durable contradiction about the book freezes new exposure" still holds. */
ok("custody and identity contradictions block new exposure; an unreadable quote does not", () => {
  assert.match(positionEntryBlock({ exitExecutionRequired: true,
    exitExecutionReason: "stop fired" }), /stop fired/);
  assert.match(positionEntryBlock({ balanceReconciliationRequired: true,
    balanceReconciliationReason: "two RPCs disagree" }), /two RPCs disagree/);
  assert.match(positionEntryBlock({ deskIdentityMismatch: true,
    deskIdentityMismatchReason: "the desk's row names another coin" }), /another coin/);
  assert.equal(positionEntryBlock({ riskDataUnavailable: true,
    riskDataUnavailableReason: "mark outage" }), null);
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

const anchoredHistoryFile = path.join(dir, "anchored-incomplete-history.sqlite");
const firstSeenAt = 1_800_000_000_000;
const riskHistoryWindowMs = 24 * 60 * 60_000;
let anchored = new ExecutionJournal(anchoredHistoryFile, {
  wallet, now: () => firstSeenAt,
});
anchored.saveRuntime({ cursor: 1, primed: true, state: {
  ...freshState(firstSeenAt), deployedTodaySol: 0.005, realizedTodaySol: -0.001,
}, positions: {} });
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, {
  wallet, create: false, now: () => firstSeenAt,
});
const anchoredDeadline = anchored.riskHistoryStatus(firstSeenAt).incompleteUntil;
ok("first legacy discovery sets an exact durable risk-history deadline", () => {
  assert.equal(anchoredDeadline, firstSeenAt + riskHistoryWindowMs);
  assert.equal(anchored.riskHistoryStatus(firstSeenAt).complete, false);
  assert.equal(anchored.getMeta("risk_history_incomplete_first_seen_at"), firstSeenAt);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, {
  wallet, create: false, now: () => firstSeenAt + 12 * 60 * 60_000,
});
ok("legacy risk-history quarantine deadline is anchored once across reopen", () => {
  assert.equal(anchored.riskHistoryStatus(firstSeenAt + 12 * 60 * 60_000).incompleteUntil,
    anchoredDeadline);
  assert.equal(anchored.getMeta("risk_history_incomplete_first_seen_at"), firstSeenAt);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, {
  wallet, create: false, now: () => firstSeenAt + 2 * 60 * 60_000,
});
ok("clock rollback neither extends nor prematurely clears the anchored quarantine", () => {
  const status = anchored.riskHistoryStatus(firstSeenAt + 2 * 60 * 60_000);
  assert.equal(status.complete, false);
  assert.equal(status.incompleteUntil, anchoredDeadline);
  assert.equal(anchored.getMeta("risk_history_incomplete_first_seen_at"), firstSeenAt);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, {
  wallet, create: false, now: () => firstSeenAt + 25 * 60 * 60_000,
});
ok("persisting legacy counters do not renew an elapsed risk-history quarantine", () => {
  const status = anchored.riskHistoryStatus(firstSeenAt + 25 * 60 * 60_000);
  assert.equal(status.complete, true);
  assert.equal(status.incompleteUntil, anchoredDeadline);
});
anchored.close();

const freshCompleteFile = path.join(dir, "fresh-complete-history.sqlite");
let freshComplete = new ExecutionJournal(freshCompleteFile, {
  wallet, now: () => firstSeenAt,
});
freshComplete.saveRuntime({ cursor: 1, primed: true,
  state: freshState(firstSeenAt), positions: {} });
freshComplete.close();
freshComplete = new ExecutionJournal(freshCompleteFile, {
  wallet, create: false, now: () => firstSeenAt + 12 * 60 * 60_000,
});
ok("fresh complete journals remain free of risk-history migration quarantine", () => {
  assert.deepEqual(freshComplete.riskHistoryStatus(), {
    complete: true, incompleteUntil: null,
  });
  assert.equal(freshComplete.getMeta("risk_history_incomplete_first_seen_at"), null);
  assert.equal(freshComplete.getMeta("risk_history_incomplete_until"), null);
});
freshComplete.close();

// Recreate the exact pre-invariant shape by removing the new nullable column from
// an otherwise real journal. Reopening must add it without laundering old signed
// bytes into the current protocol era.
const legacyProtocolFile = path.join(dir, "legacy-attempt-protocol.sqlite");
let legacyProtocol = new ExecutionJournal(legacyProtocolFile, { wallet });
const legacyProtocolSpec = {
  ...spec,
  id: "entry:50:entry:legacy-protocol",
  eventId: "50:entry:legacy-protocol",
  feedId: 103,
  mint: Keypair.generate().publicKey.toBase58(),
};
legacyProtocol.ensureIntent(legacyProtocolSpec);
legacyProtocol.recordSigned(legacyProtocolSpec.id, {
  attempt: 1, requestId: "legacy-protocol", signedTx: Buffer.from("pre-invariant bytes"),
  signature: "legacy-protocol-signature", blockhash: "legacy-protocol-blockhash",
  lastValidBlockHeight: 999, quotedOutputRaw: "1000", minOutputRaw: "900",
  order: { router: "metis" },
});
legacyProtocol.close();
raw = new DatabaseSync(legacyProtocolFile);
raw.exec("ALTER TABLE tx_attempts DROP COLUMN protocol");
assert.equal(raw.prepare("PRAGMA table_info(tx_attempts)").all()
  .some((column) => column.name === "protocol"), false);
raw.close();

legacyProtocol = new ExecutionJournal(legacyProtocolFile, { wallet, create: false });
ok("legacy attempt migration adds nullable protocol provenance without backfilling", () => {
  const column = legacyProtocol.db.prepare("PRAGMA table_info(tx_attempts)").all()
    .find((value) => value.name === "protocol");
  assert.equal(column.notnull, 0);
  assert.equal(column.dflt_value, null);
  assert.equal(legacyProtocol.db.prepare("SELECT protocol FROM tx_attempts WHERE intent_id=?")
    .get(legacyProtocolSpec.id).protocol, null);
  assert.equal(legacyProtocol.latestAttempt(legacyProtocolSpec.id).protocol, null);
});
const migratedProtocolSpec = {
  ...spec,
  id: "entry:50:entry:migrated-protocol",
  eventId: "50:entry:migrated-protocol",
  feedId: 104,
  mint: Keypair.generate().publicKey.toBase58(),
};
legacyProtocol.ensureIntent(migratedProtocolSpec);
legacyProtocol.recordSigned(migratedProtocolSpec.id, {
  attempt: 1, requestId: "migrated-protocol", signedTx: Buffer.from("current bytes"),
  signature: "migrated-protocol-signature", blockhash: "migrated-protocol-blockhash",
  lastValidBlockHeight: 999, quotedOutputRaw: "1000", minOutputRaw: "900",
  order: { router: "metis" }, protocol: "caller-spoofed-protocol",
});
ok("recordSigned marks new attempts with the exported current protocol", () => {
  assert.equal(legacyProtocol.latestAttempt(migratedProtocolSpec.id).protocol,
    CURRENT_TX_ATTEMPT_PROTOCOL);
  assert.equal(legacyProtocol.db.prepare("SELECT protocol FROM tx_attempts WHERE intent_id=?")
    .get(migratedProtocolSpec.id).protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
});
const snipeProtocolSpec = {
  ...spec, id: "snipe-entry:protocol", kind: "snipe_entry", eventId: null, feedId: null,
  mint: Keypair.generate().publicKey.toBase58(),
};
legacyProtocol.ensureIntent(snipeProtocolSpec);
legacyProtocol.recordSigned(snipeProtocolSpec.id, {
  attempt: 1, requestId: "snipe-protocol", signedTx: Buffer.from("curve bytes"),
  signature: "snipe-protocol-signature", blockhash: "snipe-protocol-blockhash",
  lastValidBlockHeight: 999, quotedOutputRaw: "1000", minOutputRaw: "900",
  order: { side: "buy" }, protocol: SNIPE_TX_ATTEMPT_PROTOCOL,
});
ok("recordSigned honours the sniper's own marker, which is in the taught set and is not the desk's", () => {
  assert.equal(legacyProtocol.latestAttempt(snipeProtocolSpec.id).protocol, SNIPE_TX_ATTEMPT_PROTOCOL);
  assert.notEqual(SNIPE_TX_ATTEMPT_PROTOCOL, CURRENT_TX_ATTEMPT_PROTOCOL);
  assert.ok(TX_ATTEMPT_PROTOCOLS.includes(SNIPE_TX_ATTEMPT_PROTOCOL));
});
legacyProtocol.close();

/* ── THE SNIPER'S INTENTS MUST NOT BLOCK THE DESK'S SAFETY EXITS ───────────────────── */
/* hasConflictingIntent lets a PROVEN safety exit step past unresolved intents on OTHER
 * mints, because the one thing that must never queue behind unrelated work is the sell
 * that protects a position. It did that with an inline list of four kinds, written when
 * four was all there were. snipe_entry and snipe_exit were added later and never
 * classified, so they fell into the unknown-kind bucket — which blocks GLOBALLY.
 *
 * One unresolved sniper intent, on any coin, would have blocked EVERY desk safety exit on
 * EVERY mint for as long as it stayed unresolved. It never bit because nothing has ever
 * written a snipe intent; arming the sniper is what would have made it bite. */
{
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-conflict-"));
  const cj = new ExecutionJournal(path.join(cdir, "state.sqlite"), { wallet });
  const WSOL = "So11111111111111111111111111111111111111112";
  const heldMint = Keypair.generate().publicKey.toBase58();     // what the desk holds
  const snipedMint = Keypair.generate().publicKey.toBase58();   // an unrelated coin

  /* An unresolved sniper intent on the OTHER coin. The state is written directly because
     what is under test is the conflict QUERY, not how a row reaches 'signed'. */
  const snipe = cj.ensureIntent({
    id: `snipe-entry:${snipedMint}`, kind: "snipe_entry", eventId: `9:snipe:${snipedMint}`,
    feedId: 901, mint: snipedMint, inputMint: WSOL, outputMint: snipedMint,
    amountRaw: "400000000", context: { callId: 9 },
  });
  cj.db.prepare("UPDATE intents SET state='submitted' WHERE id=?").run(snipe.id);

  /* The desk's safety exit on the coin it actually holds: reducing the named position
     into wrapped SOL, which is what earns the right to step past other mints. */
  const deskExit = {
    id: `risk-exit:${heldMint}`, kind: "risk_exit", eventId: `9:risk:${heldMint}`,
    feedId: 902, mint: heldMint, inputMint: heldMint, outputMint: WSOL,
    amountRaw: "1000000", context: { callId: 9, position: { mint: heldMint } },
  };
  ok("a desk safety exit is NOT blocked by an unresolved sniper intent on another mint", () => {
    const blocker = cj.hasConflictingIntent(deskExit);
    assert.equal(blocker, null,
      `the desk's stop on ${heldMint.slice(0, 8)}… was blocked by ${blocker} — a sniper intent ` +
      `on the unrelated coin ${snipedMint.slice(0, 8)}…`);
  });

  ok("...but it IS still blocked by an unresolved intent on the SAME mint", () => {
    const same = cj.ensureIntent({
      id: `snipe-entry:${heldMint}`, kind: "snipe_entry", eventId: `9:snipe:${heldMint}`,
      feedId: 903, mint: heldMint, inputMint: WSOL, outputMint: heldMint,
      amountRaw: "400000000", context: { callId: 9 },
    });
    cj.db.prepare("UPDATE intents SET state='submitted' WHERE id=?").run(same.id);
    assert.equal(cj.hasConflictingIntent(deskExit), same.id,
      "two unresolved transactions on ONE mint must still serialise — that lock is the point");
  });

  ok("a candidate that is NOT a proven safety exit still takes the global lock", () => {
    /* The relaxation is earned by the route and the position snapshot, not by the kind.
       An 'exit' that does not reduce the named position into wrapped SOL gets nothing. */
    const notReally = { ...deskExit, id: "risk-exit:fake", eventId: "9:risk:fake",
      feedId: 904, outputMint: snipedMint };
    assert.ok(cj.hasConflictingIntent(notReally),
      "a candidate calling itself an exit while routing somewhere other than wrapped SOL " +
      "stepped past the global lock");
  });

  ok("every intent kind is classified deliberately, so a seventh cannot default to global", () => {
    const unclassified = [...INTENT_KINDS].filter((k) => !POSITION_SCOPED_KINDS.includes(k));
    assert.deepEqual(unclassified, [],
      `${JSON.stringify(unclassified)} are unclassified, so they block EVERY safety exit on ` +
      "EVERY mint. If that is deliberate for a new kind, say so here and list it.");
    console.log(`       ${POSITION_SCOPED_KINDS.length} kinds, all position-scoped: ${POSITION_SCOPED_KINDS.join(", ")}`);
  });
  cj.close();
  fs.rmSync(cdir, { recursive: true, force: true });
}

/* ── THE SNIPER'S BOOK SURVIVES A RESTART ──────────────────────────────────────────── */
/* S.snipes was persisted nowhere. An executing lane restarted mid-position forgot it held
 * anything — no cost basis, no armed flags, no confirmed high, and nothing running that
 * would ever sell it. For an OBSERVING lane it silently truncated the shadow book at every
 * restart, which is the evidence the decision to arm is supposed to rest on. */
{
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-snipes-"));
  const sfile = path.join(sdir, "state.sqlite");
  const mintA = Keypair.generate().publicKey.toBase58();
  const mintB = Keypair.generate().publicKey.toBase58();
  const snipe = (mint) => ({ mint, lane: "snipe", venue: "pumpfun", entry: 1,
    openedAt: 1_700_000_000_000, sizeSol: 0.005, feeSolPerLeg: 0.0005,
    qtyRaw: "2198264641494", entryInputLamports: "5000000", high: 1.4, armedBreakeven: true });

  let sj = new ExecutionJournal(sfile, { wallet });
  ok("a fresh journal has an empty snipe book, not a missing one", () => {
    assert.deepEqual(sj.snapshot().snipes, {},
      "snapshot() must always carry the key, or the poller's S.snipes ||= {} hides a load failure");
  });

  sj.saveRuntime({ snipes: { [mintA]: snipe(mintA), [mintB]: snipe(mintB) } });
  sj.close();

  sj = new ExecutionJournal(sfile, { wallet });
  ok("two open snipes come back across a close and reopen", () => {
    const back = sj.snapshot().snipes;
    assert.deepEqual(Object.keys(back).sort(), [mintA, mintB].sort());
    assert.equal(back[mintA].qtyRaw, "2198264641494", "the mark's first operand did not survive");
    assert.equal(back[mintA].entryInputLamports, "5000000", "the mark's second operand did not survive");
    assert.equal(back[mintA].armedBreakeven, true, "an armed flag did not survive — the stop would re-arm from scratch");
    assert.equal(back[mintA].high, 1.4, "the confirmed high did not survive — the trail would follow a new high");
  });

  ok("closing one snipe REAPS its row, so a boot cannot resurrect it", () => {
    /* A row left behind is re-opened as a live position by the next boot, and the lane
       then tries to sell something it no longer holds. */
    sj.saveRuntime({ snipes: { [mintB]: snipe(mintB) } });
    sj.close();
    sj = new ExecutionJournal(sfile, { wallet });
    assert.deepEqual(Object.keys(sj.snapshot().snipes), [mintB]);
  });

  ok("the two books stay separate on disk — a snipe never lands in positions", () => {
    /* openList() is Object.values(S.positions). If a snipe reached that table it would be
       visible to all six of its consumers, which is the leak clause 1 exists to prevent. */
    assert.deepEqual(sj.snapshot().positions, {},
      "a snipe was written into the desk's position book");
    assert.equal(sj.db.prepare("SELECT COUNT(*) c FROM positions").get().c, 0);
    assert.equal(sj.db.prepare("SELECT COUNT(*) c FROM snipes").get().c, 1);
  });

  ok("a row that cannot be MARKED is refused rather than stored", () => {
    /* qtyRaw and entryInputLamports are the two operands of the mark. A row missing either
       comes back after a restart as a position nothing can price — which is the same as
       having no exit for it. */
    for (const missing of ["qtyRaw", "entryInputLamports"]) {
      const bad = { ...snipe(mintA) }; delete bad[missing];
      assert.throws(() => sj.saveRuntime({ snipes: { [mintA]: bad } }),
        new RegExp(`invalid ${missing}`), `a snipe with no ${missing} was accepted`);
    }
    const wrongKey = snipe(mintA);
    assert.throws(() => sj.saveRuntime({ snipes: { [mintB]: wrongKey } }), /contains mint/);
    assert.throws(() => sj.saveRuntime({ snipes: { [mintA]: { ...snipe(mintA), entry: 0 } } }),
      /non-positive entry/);
  });
  sj.close();
  fs.rmSync(sdir, { recursive: true, force: true });
}

j.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} journal safety checks passed\n`);
