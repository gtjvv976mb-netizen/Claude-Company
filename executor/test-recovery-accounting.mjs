import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import { WSOL } from "./jupiter.mjs";
import { freshState } from "./strategy.mjs";

const POLLER = fileURLToPath(new URL("./poller.mjs", import.meta.url));
let passed = 0;

const pollerSource = fs.readFileSync(POLLER, "utf8");
const tickSource = pollerSource.slice(pollerSource.indexOf("async function tick()"));
assert.ok(tickSource.indexOf("await manageOpen();") <
  tickSource.indexOf("/executor/feed?after=${S.cursor}"),
"existing positions must be managed before new feed entries in every tick");

function recordConfirmed(journal, spec, { input, output, signature }) {
  journal.ensureIntent(spec);
  journal.recordSigned(spec.id, {
    attempt: 1,
    requestId: `request-${spec.id}`,
    signedTx: Buffer.from(`signed-${spec.id}`),
    signature,
    blockhash: "test-blockhash",
    lastValidBlockHeight: 999,
    quotedOutputRaw: output,
    minOutputRaw: output,
    order: { test: true },
  });
  journal.markConfirmed(spec.id, 1, {
    signature, totalInputAmount: input, totalOutputAmount: output,
    networkFeeLamports: spec.kind === "entry" ? "5000" : "7000",
  }, { status: "Success", code: 0, signature });
}

async function runUntil({ dir, wallet, stateFile, marker, api = "https://127.0.0.1:1" }) {
  const keypairFile = path.join(dir, "burner.json");
  const pauseFile = path.join(dir, "pause-entries");
  const hardStopFile = path.join(dir, "hard-stop");
  fs.writeFileSync(keypairFile, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
  fs.writeFileSync(pauseFile, "paused\n", { mode: 0o600 });
  fs.writeFileSync(hardStopFile, "stopped\n", { mode: 0o600 });

  const child = spawn(process.execPath, [POLLER], {
    cwd: dir,
    env: {
      ...process.env,
      CC_API: api,
      CC_SECRET: "recovery-test-secret",
      CC_FLOOR: "50",
      EXECUTE: "0",
      KEYPAIR: keypairFile,
      STATE_DB: stateFile,
      LOCK_FILE: `${stateFile}.lock`,
      PAUSE_ENTRIES_FILE: pauseFile,
      HARD_STOP_FILE: hardStopFile,
      POLL_MS: "60000",
      MAX_CALL_AGE_MIN: "1",
      JUPITER_API_KEY: "",
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let found = false;
  const inspect = (chunk) => {
    output += chunk.toString();
    if (!found && output.includes(marker)) {
      found = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(found, true, `poller never emitted ${JSON.stringify(marker)}:\n${output}`);
  assert.ok(code === 0 || signal === "SIGTERM", `poller exited ${code ?? signal}:\n${output}`);
  return output;
}

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

await check("confirmed entry is accounted before stale-age, pause and hard-stop gates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-recover-entry-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const state = { ...freshState(Date.now()), deployedTodaySol: 0.04 };
  const plannedState = { ...freshState(Date.now()), deployedTodaySol: 0.01 };
  journal.saveRuntime({ cursor: 0, primed: true, state, positions: {} });
  recordConfirmed(journal, {
    id: "entry:50:entry:77",
    kind: "entry",
    eventId: "50:entry:77",
    feedId: 77,
    mint,
    inputMint: WSOL,
    outputMint: mint,
    amountRaw: "5000000",
    context: {
      wallet: wallet.publicKey.toBase58(),
      event: {
        id: 77, call_id: 77, event_id: "50:entry:77", mint, symbol: "STALE",
        ts: 1, entry_ref: 1, stop: 0.6, target: 2,
        take_profit_x: 0, fixed_sol: 0,
      },
      plan: { action: "buy", sol: 0.005, f: 0.02 },
      takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
      positionConfig: { stopBufferPct: 0 },
      entryReference: { marketMark: 1, marketMarkAt: Date.now(), stopRatio: 0.6, targetRatio: 2 },
      entryPreflight: { solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1" },
      openedAtMs: Date.now(),
      riskStateBefore: plannedState,
    },
  }, { input: "5000000", output: "123456", signature: "confirmed-entry-signature" });
  journal.close();

  await runUntil({ dir, wallet, stateFile, marker: "RECOVERED + QUARANTINED STALE" });
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const snapshot = recovered.snapshot();
  assert.equal(recovered.getIntent("entry:50:entry:77").state, "accounted");
  assert.equal(snapshot.positions[mint].qtyRaw, "123456");
  assert.equal(snapshot.positions[mint].entryIntentId, "entry:50:entry:77");
  assert.equal(snapshot.positions[mint].callId, 77);
  assert.equal(snapshot.positions[mint].accountingIncomplete, true);
  assert.equal(snapshot.positions[mint].solUsdSource, "legacy-unverified");
  assert.match(snapshot.positions[mint].accountingIncompleteReason, /no provable independent SOL\/USD/);
  assert.equal(snapshot.state.deployedTodaySol, 0.005005,
    "rolling deployment must come from the finalized input plus exact fee");
  recovered.close();

  // A second restart sees an accounted intent, not another fill to apply.
  await runUntil({ dir, wallet, stateFile, marker: "poll error:" });
  const replayed = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  assert.equal(replayed.getIntent("entry:50:entry:77").state, "accounted");
  assert.equal(replayed.snapshot().state.deployedTodaySol, 0.005005);
  replayed.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("confirmed exit is accounted before hard-stop and current-balance checks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-recover-exit-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const position = {
    mint, symbol: "EXIT", qtyRaw: "123456", paidSol: 0.005,
    costBasisLamports: "5000000", entryInputLamports: "4995000", solUsdAtEntry: 150,
    solUsdSource: "pyth-sol-usd-shard0-v1",
    entryIntentId: "entry:50:entry:76", entry: 1, stop: 0.6, target: 2,
    callId: 76,
    high: 1, openedAtMs: Date.now(), riskF: 0.02,
    takeProfitX: 2, honorDeskTarget: true,
  };
  const state = { ...freshState(Date.now()), deployedTodaySol: 0.005,
    realizedTodaySol: 0.4, wins: 4, openCount: 1, bookHeat: 0.02 };
  const plannedState = { ...freshState(Date.now()), deployedTodaySol: 0.005,
    realizedTodaySol: 0.02, wins: 2, openCount: 1, bookHeat: 0.02 };
  journal.saveRuntime({ cursor: 76, primed: true, state, positions: { [mint]: position } });
  recordConfirmed(journal, {
    id: "risk-exit:entry:50:entry:76",
    kind: "risk_exit",
    eventId: null,
    mint,
    inputMint: mint,
    outputMint: WSOL,
    amountRaw: "123456",
    context: {
      wallet: wallet.publicKey.toBase58(),
      position,
      why: "confirmed before crash",
      fraction: 1,
      riskStateBefore: plannedState,
    },
  }, { input: "123456", output: "6000000", signature: "confirmed-exit-signature" });
  journal.close();

  await runUntil({ dir, wallet, stateFile, marker: "SOLD EXIT" });
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const snapshot = recovered.snapshot();
  assert.equal(recovered.getIntent("risk-exit:entry:50:entry:76").state, "accounted");
  assert.equal(snapshot.positions[mint], undefined);
  assert.ok(Math.abs(snapshot.state.realizedTodaySol - 0.000993) < 1e-12);
  assert.equal(snapshot.state.wins, 5,
    "a stale pre-sign snapshot must not erase already-accounted wins");
  assert.equal(snapshot.state.openCount, 0);
  recovered.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("independently recovered exits merge monotonic win/loss counters", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-recover-concurrent-exits-"));
  const wallet = Keypair.generate();
  const winnerMint = Keypair.generate().publicKey.toBase58();
  const loserMint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const position = (mint, symbol, callId) => ({
    mint, symbol, qtyRaw: "123456", paidSol: 0.005,
    costBasisLamports: "5000000", entryInputLamports: "4995000", solUsdAtEntry: 150,
    solUsdSource: "pyth-sol-usd-shard0-v1", entryIntentId: `entry:${symbol}`, callId,
    entry: 1, stop: 0.6, target: 2, high: 1, openedAtMs: Date.now(),
    riskF: 0.02, takeProfitX: 2, honorDeskTarget: true,
  });
  const winner = position(winnerMint, "WINNER", 81);
  const loser = position(loserMint, "LOSER", 82);
  const commonBefore = { ...freshState(Date.now()), wins: 10, losses: 5,
    openCount: 2, bookHeat: 0.04 };
  journal.saveRuntime({ cursor: 82, primed: true, state: commonBefore,
    positions: { [winnerMint]: winner, [loserMint]: loser } });
  for (const [id, held, output] of [
    ["risk-exit:concurrent:a-winner", winner, "6000000"],
    ["risk-exit:concurrent:b-loser", loser, "4000000"],
  ]) {
    recordConfirmed(journal, {
      id, kind: "risk_exit", eventId: null, mint: held.mint,
      inputMint: held.mint, outputMint: WSOL, amountRaw: held.qtyRaw,
      context: { wallet: wallet.publicKey.toBase58(), position: held,
        why: "concurrent recovery", fraction: 1, riskStateBefore: commonBefore },
    }, { input: held.qtyRaw, output, signature: `confirmed-${id}` });
  }
  journal.close();

  await runUntil({ dir, wallet, stateFile, marker: "SOLD LOSER" });
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const snapshot = recovered.snapshot();
  assert.equal(recovered.getIntent("risk-exit:concurrent:a-winner").state, "accounted");
  assert.equal(recovered.getIntent("risk-exit:concurrent:b-loser").state, "accounted");
  assert.equal(snapshot.state.wins, 11);
  assert.equal(snapshot.state.losses, 6);
  assert.equal(snapshot.state.openCount, 0);
  assert.deepEqual(snapshot.positions, {});
  recovered.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("full-Pyth finalized entries with incomplete metadata become exit-only quarantines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-recover-partial-modern-"));
  const wallet = Keypair.generate();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const observedAt = Date.now();
  const baseContext = (mint, symbol, callId) => ({
    wallet: wallet.publicKey.toBase58(),
    event: { id: callId, call_id: callId, event_id: `entry:${callId}`, mint, symbol,
      ts: observedAt, entry_ref: 1, stop: 0.6, target: 2 },
    plan: { action: "buy", sol: 0.005, f: 0.02 },
    takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
    positionConfig: { stopBufferPct: 0 },
    entryReference: { marketMark: 1, marketMarkAt: observedAt,
      entryLow: 0.9, entryHigh: 1.1, stopRatio: 0.6, targetRatio: 2 },
    entryPreflight: { inputAmountRaw: "5000000", forwardOutputRaw: "123456",
      reverseOutputRaw: "4900000", roundTripLossPct: 2,
      solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1", tokenDecimals: 6,
      solUsdPublishTime: Math.floor(observedAt / 1000), solUsdConfidencePct: 0.01,
      solUsdProviderDivergencePct: 0.01, observedAt },
    openedAtMs: observedAt,
    riskStateBefore: freshState(observedAt),
  });
  const cases = [
    { id: "entry:quarantine:1-call", symbol: "NOCALL", mutate: (context) => {
      delete context.event.call_id;
    }, reason: /call identity/ },
    { id: "entry:quarantine:2-plan", symbol: "NOPLAN", mutate: (context) => {
      delete context.plan;
    }, reason: /sizing context/ },
    { id: "entry:quarantine:3-rule", symbol: "NORULE", mutate: (context) => {
      delete context.takeProfitRule;
    }, reason: /take-profit rule/ },
    { id: "entry:quarantine:4-reference", symbol: "NOREF", mutate: (context) => {
      delete context.entryReference.stopRatio;
    }, reason: /market reference/ },
    { id: "entry:quarantine:5-mismatch", symbol: "MISMATCH", mutate: (context) => {
      context.event.mint = Keypair.generate().publicKey.toBase58();
    }, reason: /call identity/ },
  ];
  const expected = [];
  journal.saveRuntime({ cursor: 0, primed: true, state: freshState(observedAt), positions: {} });
  for (const [index, testCase] of cases.entries()) {
    const mint = Keypair.generate().publicKey.toBase58();
    const context = baseContext(mint, testCase.symbol, 90 + index);
    testCase.mutate(context);
    expected.push({ ...testCase, mint });
    recordConfirmed(journal, {
      id: testCase.id, kind: "entry", eventId: testCase.id, feedId: 90 + index,
      mint, inputMint: WSOL, outputMint: mint, amountRaw: "5000000", context,
    }, { input: "5000000", output: "123456", signature: `confirmed-${testCase.id}` });
  }
  journal.close();

  await runUntil({ dir, wallet, stateFile, marker: "RECOVERED + QUARANTINED MISMATCH" });
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const snapshot = recovered.snapshot();
  for (const item of expected) {
    assert.equal(recovered.getIntent(item.id).state, "accounted");
    const held = snapshot.positions[item.mint];
    assert.ok(held, `${item.symbol} finalized custody must be represented in the book`);
    assert.equal(held.qtyRaw, "123456");
    assert.equal(held.accountingIncomplete, true);
    assert.equal(held.solUsdSource, "pyth-sol-usd-shard0-v1",
      "valid oracle provenance remains truthful while other metadata is quarantined");
    assert.match(held.accountingIncompleteReason, item.reason);
  }
  assert.equal(snapshot.positions[expected[0].mint].callIdentityIncomplete, true);
  assert.equal(snapshot.positions[expected[4].mint].callIdentityIncomplete, true);
  recovered.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("one malformed confirmed intent cannot starve unrelated exits or the feed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-recover-isolation-"));
  const wallet = Keypair.generate();
  const heldMint = Keypair.generate().publicKey.toBase58();
  const malformedMint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const position = {
    mint: heldMint, symbol: "SURVIVOR", qtyRaw: "123456", paidSol: 0.005,
    costBasisLamports: "5000000", entryInputLamports: "4995000", solUsdAtEntry: 150,
    solUsdSource: "pyth-sol-usd-shard0-v1", entryIntentId: "entry:survivor", callId: 76,
    entry: 1, stop: 0.6, target: 2, high: 1, openedAtMs: Date.now() - 24 * 3600_000,
    riskF: 0.02, takeProfitX: 2, honorDeskTarget: true,
  };
  const observedAt = Date.now();
  journal.ensureIntent({
    id: "entry:survivor", kind: "entry", eventId: "survivor", feedId: 76,
    mint: heldMint, inputMint: WSOL, outputMint: heldMint, amountRaw: "4995000",
    context: {
      event: { mint: heldMint, call_id: 76, stop: 0.6, target: 2 },
      entryReference: { marketMark: 1, marketMarkAt: observedAt,
        entryLow: 0.9, entryHigh: 1.1, stopRatio: 0.6, targetRatio: 2 },
      entryPreflight: { inputAmountRaw: "4995000", forwardOutputRaw: "123456",
        solUsd: 150, solUsdSource: "pyth-sol-usd-shard0-v1", tokenDecimals: 6,
        solUsdPublishTime: Math.floor(observedAt / 1000), solUsdConfidencePct: 0.01,
        solUsdProviderDivergencePct: 0.01, observedAt },
    },
  });
  journal.saveRuntime({ cursor: 0, primed: true,
    state: { ...freshState(Date.now()), openCount: 1, bookHeat: 0.02 },
    positions: { [heldMint]: position } });
  recordConfirmed(journal, {
    id: "entry:malformed-confirmed", kind: "entry", eventId: "malformed", feedId: 1,
    mint: malformedMint, inputMint: WSOL, outputMint: WSOL, amountRaw: "5000000",
    context: { wallet: wallet.publicKey.toBase58() },
  }, { input: "5000000", output: "999", signature: "malformed-confirmed-signature" });
  journal.close();

  const output = await runUntil({ dir, wallet, stateFile, marker: "poll error:" });
  assert.match(output, /ACCOUNTING QUARANTINE entry:malformed-confirmed/);
  assert.match(output, /PAPER EXIT SURVIVOR/,
    "the unrelated age exit must still be evaluated after the accounting failure");
  assert.ok(output.indexOf("ACCOUNTING QUARANTINE") < output.indexOf("PAPER EXIT SURVIVOR"));
  assert.ok(output.indexOf("PAPER EXIT SURVIVOR") < output.indexOf("poll error:"),
    "the authenticated feed phase must still be reached after managing the position");
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  assert.equal(recovered.getIntent("entry:malformed-confirmed").state, "confirmed",
    "malformed accounting remains visible and blocks new exposure");
  recovered.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("authenticated feed rollback freezes entries without starving local position exits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-feed-rollback-"));
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const stateFile = path.join(dir, "state.sqlite");
  const journal = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const position = {
    mint, symbol: "ROLLBACK-SURVIVOR", qtyRaw: "123456", paidSol: 0.005,
    costBasisLamports: "5000000", entryInputLamports: "4995000", solUsdAtEntry: 150,
    solUsdSource: "pyth-sol-usd-shard0-v1", entryIntentId: "entry:rollback-survivor",
    callId: 10, entry: 1, stop: 0.6, target: 2, high: 1,
    openedAtMs: Date.now() - 24 * 3600_000, riskF: 0.02,
    takeProfitX: 2, honorDeskTarget: true,
    exitExecutionRequired: true,
    exitExecutionReason: "required rollback safety exit",
    exitExecutionIntentId: "risk-exit:entry:rollback-survivor",
    exitExecutionObservedAt: Date.now(),
  };
  journal.saveRuntime({ cursor: 10, primed: true,
    state: { ...freshState(Date.now()), openCount: 1, bookHeat: 0.02 },
    positions: { [mint]: position } });
  journal.close();

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.includes("/executor/feed"))
      response.end(JSON.stringify({ cluster: "mainnet-beta", latest_id: 9, events: [] }));
    else response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let output;
  try {
    output = await runUntil({ dir, wallet, stateFile,
      marker: "CRITICAL FEED ROLLBACK", api: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.match(output, /PAPER EXIT ROLLBACK-SURVIVOR/);
  assert.ok(output.indexOf("PAPER EXIT ROLLBACK-SURVIVOR") <
    output.indexOf("CRITICAL FEED ROLLBACK"),
  "local risk evaluation must complete before rejecting the rolled-back feed");
  const reopened = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const alarm = reopened.getMeta("feed_rollback");
  assert.equal(alarm.active, true);
  assert.equal(alarm.cursor, 10);
  assert.equal(alarm.latestId, 9);
  assert.ok(Number.isSafeInteger(alarm.observedAt));
  assert.equal(reopened.snapshot().cursor, 10,
    "rollback must never move the durable cursor backward");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} recovery-accounting checks passed\n`);
