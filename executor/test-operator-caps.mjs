/** The published canary ceilings cannot be raised by environment or old acknowledgements. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-caps-"));
const keyFile = path.join(dir, "burner.json");
const keypair = Keypair.generate();
fs.writeFileSync(keyFile, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
const wallet = keypair.publicKey.toBase58();
const poller = path.join(path.dirname(fileURLToPath(import.meta.url)), "poller.mjs");
const base = {
  ...process.env, CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
  KEYPAIR: keyFile, STATE_DB: path.join(dir, "state.sqlite"), LOCK_FILE: path.join(dir, "state.sqlite.lock"),
  SOLANA_RPC: "https://primary-private-rpc.invalid",
  SOLANA_RPC_SECONDARY: "https://independent-rpc.invalid",
  JUPITER_API_KEY: "test-key", LIVE_TRADING_ACK: wallet, INIT_ONLY: "1", LIVE_STATE_INIT_ACK: wallet,
};
const run = (extra = {}) => spawnSync(process.execPath, [poller], {
  env: { ...base, ...extra }, encoding: "utf8", timeout: 15_000,
});
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok   ${name}`); };

ok("MAX_SOL_PER_TRADE cannot exceed the 0.005 SOL canary ceiling", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAX_SOL_PER_TRADE must be between .*0\.005/);
});
ok("DAILY_SOL_CAP cannot exceed the 0.01 SOL rolling ceiling", () => {
  const result = run({ DAILY_SOL_CAP: "0.5" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_SOL_CAP must be between .*0\.01/);
});
ok("DAILY_LOSS_LIMIT_SOL cannot exceed the 0.01 SOL rolling ceiling", () => {
  const result = run({ DAILY_LOSS_LIMIT_SOL: "0.15" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_LOSS_LIMIT_SOL must be between .*0\.01/);
});
ok("a legacy raised-cap acknowledgement grants no exception", () => {
  const sentence = `I raise the live caps for ${wallet} to 0.05 SOL per trade, 0.5 SOL per day, 0.15 SOL daily loss`;
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: sentence });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /OPERATOR-RAISED/);
});
ok("SOL/USD cache age is validated and cannot exceed the 30-minute live ceiling", () => {
  for (const value of ["1800001", "not-a-number"]) {
    const result = run({ SOL_USD_CACHE_MAX_AGE_MS: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOL_USD_CACHE_MAX_AGE_MS must be between 1000 and 1800000/);
  }
});
ok("lowering a cap remains allowed", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.001", DAILY_SOL_CAP: "0.005",
    DAILY_LOSS_LIMIT_SOL: "0.005", SOL_USD_CACHE_MAX_AGE_MS: "60000" });
  assert.equal(result.status, 0, result.stderr);
});
ok("the default canary configuration initializes without a network request", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized journal/);
});

console.log(`\n${pass} immutable live-cap gates passed\n`);
fs.rmSync(dir, { recursive: true, force: true });
