import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
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

async function runUntil({ dir, wallet, stateFile, marker }) {
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
      CC_API: "https://127.0.0.1:1",
      CC_SECRET: "recovery-test-secret",
      CC_FLOOR: "50",
      EXECUTE: "0",
      KEYPAIR: keypairFile,
      STATE_DB: stateFile,
      LOCK_FILE: path.join(dir, "executor.lock"),
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
        id: 77, event_id: "50:entry:77", mint, symbol: "STALE",
        ts: 1, entry_ref: 1, stop: 0.6, target: 2,
        take_profit_x: 0, fixed_sol: 0,
      },
      plan: { action: "buy", sol: 0.005, f: 0.02 },
      takeProfitRule: { takeProfitX: 2, honorDeskTarget: true },
      positionConfig: { stopBufferPct: 0 },
      entryReference: { marketMark: 1, marketMarkAt: Date.now(), stopRatio: 0.6, targetRatio: 2 },
      entryPreflight: { solUsd: 150 },
      openedAtMs: Date.now(),
      riskStateBefore: plannedState,
    },
  }, { input: "5000000", output: "123456", signature: "confirmed-entry-signature" });
  journal.close();

  await runUntil({ dir, wallet, stateFile, marker: "BOUGHT STALE" });
  const recovered = new ExecutionJournal(stateFile, { wallet: wallet.publicKey.toBase58() });
  const snapshot = recovered.snapshot();
  assert.equal(recovered.getIntent("entry:50:entry:77").state, "accounted");
  assert.equal(snapshot.positions[mint].qtyRaw, "123456");
  assert.equal(snapshot.positions[mint].entryIntentId, "entry:50:entry:77");
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
    entryIntentId: "entry:50:entry:76", entry: 1, stop: 0.6, target: 2,
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
  assert.equal(snapshot.state.wins, 3);
  assert.equal(snapshot.state.openCount, 0);
  recovered.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} recovery-accounting checks passed\n`);
