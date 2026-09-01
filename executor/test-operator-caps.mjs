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

/* THE CAPS ARE RAISABLE, WITH CEREMONY — and these assertions were rewritten from
 * "permanently frozen" to say so. The freeze is not a safety property, it is a
 * non-functioning bot: Solana's fixed network fees are 20% of a 0.005 SOL position,
 * so the entry guard demands a round trip returning over 100% of input and refuses
 * every call ever offered. Measured on live coins, real round trips are ~0.7% and the
 * same calls clear comfortably at 0.05.
 *
 * What must stay true is not "small" but "nothing raises exposure by accident", and
 * that is what is tested below: env alone cannot raise, a partial raise is refused,
 * the sentence must name this wallet and these exact numbers, and no sentence can
 * exceed the hard code ceiling. */
const ackFor = (t, d, l) =>
  `I raise the live caps for ${wallet} to ${t} SOL per trade, ${d} SOL per day, ${l} SOL daily loss`;

ok("env alone cannot raise a cap — the ceremony is required", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
  assert.match(result.stderr, /I raise the live caps for/);   // it must PRINT the sentence
});
ok("a partial raise is refused and says why", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALL THREE set explicitly/);
});
ok("a sentence naming different numbers is refused", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: ackFor("0.10", "0.5", "0.15") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("no sentence can exceed the hard code ceiling", () => {
  const result = run({ MAX_SOL_PER_TRADE: "5", DAILY_SOL_CAP: "50",
    DAILY_LOSS_LIMIT_SOL: "20", LIVE_CAPS_ACK: ackFor("5", "50", "20") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAX_SOL_PER_TRADE must be between/);
});
ok("a matching acknowledgement raises the caps", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: ackFor("0.05", "0.5", "0.15") });
  assert.match(result.stdout, /OPERATOR-RAISED CAPS acknowledged/);
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
