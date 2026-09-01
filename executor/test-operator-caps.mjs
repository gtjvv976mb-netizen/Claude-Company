/**
 * OPERATOR-RAISED CAPS — possible, and deliberately awkward.
 *
 * Frozen canary caps were right for a first release and wrong forever: a tenant who
 * funds 1 SOL still trading half-dollar clips has no way to say otherwise. The property
 * worth keeping is not "small" — it is that NOTHING raises real-money exposure by
 * accident. A typed sentence naming this wallet and these exact numbers cannot be
 * produced by a config typo, a copied .env, or anything arriving through the feed —
 * which is the channel that matters, since a compromised server speaks through it.
 */
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
  ...process.env,
  CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
  KEYPAIR: keyFile,
  STATE_DB: path.join(dir, "state.sqlite"), LOCK_FILE: path.join(dir, "state.lock"),
  SOLANA_RPC: "https://primary-private-rpc.invalid",
  SOLANA_RPC_SECONDARY: "https://independent-rpc.invalid",
  JUPITER_API_KEY: "test-key", LIVE_TRADING_ACK: wallet, INIT_ONLY: "1",
  LIVE_STATE_INIT_ACK: wallet,
};
const run = (extra = {}) => spawnSync(process.execPath, [poller], {
  env: { ...base, ...extra }, encoding: "utf8", timeout: 15_000,
});
const ack = (t, d, l) =>
  `I raise the live caps for ${wallet} to ${t} SOL per trade, ${d} SOL per day, ${l} SOL daily loss`;

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok   ${name}`); };

console.log("\nA RAISE WITHOUT THE SENTENCE IS REFUSED");
ok("env alone cannot raise a cap", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /typed acknowledgement/);
  // and it must PRINT the exact sentence, or the gate is a riddle
  assert.match(r.stderr, /I raise the live caps for/);
});

ok("a partial raise names why it is refused", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.05" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ALL THREE set explicitly/);
});

console.log("\nTHE SENTENCE MUST MATCH THESE NUMBERS AND THIS WALLET");
ok("a sentence for different numbers is refused", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15",
    LIVE_CAPS_ACK: ack("0.10", "0.5", "0.15") });   // trade size changed after acknowledging
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /typed acknowledgement/);
});

ok("a sentence naming another wallet is refused", () => {
  const other = Keypair.generate().publicKey.toBase58();
  const r = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15",
    LIVE_CAPS_ACK: `I raise the live caps for ${other} to 0.05 SOL per trade, 0.5 SOL per day, 0.15 SOL daily loss` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /typed acknowledgement/);
});

console.log("\nTHE HARD CEILING IS STILL A CODE CHANGE");
ok("no sentence can exceed OPERATOR_MAX", () => {
  const r = run({ MAX_SOL_PER_TRADE: "5", DAILY_SOL_CAP: "50", DAILY_LOSS_LIMIT_SOL: "20",
    LIVE_CAPS_ACK: ack("5", "50", "20") });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MAX_SOL_PER_TRADE must be between/);
});

console.log("\nAN INCOHERENT RAISE IS CAUGHT BEFORE IT TRADES");
ok("a daily cap below the per-trade size is refused", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.2", DAILY_SOL_CAP: "0.1", DAILY_LOSS_LIMIT_SOL: "0.1",
    LIVE_CAPS_ACK: ack("0.2", "0.1", "0.1") });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /below MAX_SOL_PER_TRADE/);
});

console.log("\nAND A PROPER RAISE IS ACCEPTED");
ok("all three set, sentence exact — the caps move", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15",
    LIVE_CAPS_ACK: ack("0.05", "0.5", "0.15") });
  assert.match(r.stdout, /OPERATOR-RAISED CAPS acknowledged/);
  assert.match(r.stdout, /0\.05 SOL\/trade/);
});

ok("the canary caps still apply when nothing is raised", () => {
  const r = run({});
  assert.doesNotMatch(r.stdout, /OPERATOR-RAISED/);
});

ok("lowering a cap needs no ceremony", () => {
  const r = run({ MAX_SOL_PER_TRADE: "0.001" });
  assert.doesNotMatch(r.stderr, /typed acknowledgement/);
});

console.log(`\n${pass} live-cap gates passed\n`);
fs.rmSync(dir, { recursive: true, force: true });
