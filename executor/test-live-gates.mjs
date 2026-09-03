import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-gates-"));
const keyFile = path.join(dir, "burner.json");
const stateDb = path.join(dir, "state.sqlite");
const keypair = Keypair.generate();
fs.writeFileSync(keyFile, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
const wallet = keypair.publicKey.toBase58();
const poller = path.join(path.dirname(fileURLToPath(import.meta.url)), "poller.mjs");
const base = {
  ...process.env,
  CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
  KEYPAIR: keyFile, STATE_DB: stateDb, LOCK_FILE: `${stateDb}.lock`,
  SOLANA_RPC: "https://primary-private-rpc.invalid",
  SOLANA_RPC_SECONDARY: "https://secondary-private-rpc.invalid", JUPITER_API_KEY: "test-key",
  SOLANA_RPC_SECONDARY: "https://independent-rpc.invalid",
  LIVE_TRADING_ACK: wallet, INIT_ONLY: "1",
};
const run = (extra = {}) => spawnSync(process.execPath, [poller], {
  env: { ...base, ...extra }, encoding: "utf8", timeout: 10_000,
});
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok   ${name}`); };

ok("a state database cannot be split across a different process lock", () => {
  const result = run({ LOCK_FILE: path.join(dir, "different.lock") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical STATE_DB lock/);
});

ok("wrong public-key acknowledgement rejects live mode before network", () => {
  const result = run({ LIVE_TRADING_ACK: "wrong" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIVE_TRADING_ACK must exactly equal/);
});

ok("group-readable key rejects live mode", () => {
  fs.chmodSync(keyFile, 0o644);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permissions must be 0600/);
  fs.chmodSync(keyFile, 0o600);
});

ok("missing, public, or same-provider secondary RPC rejects live mode", () => {
  for (const [secondary, pattern] of [
    ["", /explicit independent SOLANA_RPC_SECONDARY/],
    ["https://api.mainnet-beta.solana.com", /public Solana RPC/],
    ["https://primary-private-rpc.invalid/backup", /independent provider hostname/],
  ]) {
    const result = run({ SOLANA_RPC_SECONDARY: secondary });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
});

ok("live deployment and transaction ceilings cannot be raised by environment", () => {
  for (const [name, value] of [
    ["MAX_SOL_PER_TRADE", "0.005001"],
    ["DAILY_SOL_CAP", "0.010001"],
    ["DAILY_LOSS_LIMIT_SOL", "0.010001"],
    ["MAX_OPEN_POSITIONS", "5"],
    ["SLIPPAGE_BPS", "301"],
    ["MAX_PRICE_IMPACT_PCT", "5.01"],
    ["MAX_EXIT_PRICE_IMPACT_PCT", "50.01"],
    ["MAX_JUPITER_FEE_BPS", "101"],
    ["MAX_NETWORK_FEE_LAMPORTS", "2000001"],
    ["MAX_NETWORK_FEE_PCT", "10.01"],
    ["MAX_RENT_LAMPORTS", "4200001"],
    ["MAX_ENTRY_ROUND_TRIP_LOSS_PCT", "12.01"],
    ["MAX_TX_ATTEMPTS", "4"],
    ["SOL_USD_CACHE_MAX_AGE_MS", "1800001"],
  ]) {
    const result = run({ [name]: value, LIVE_STATE_INIT_ACK: wallet });
    assert.notEqual(result.status, 0, `${name} unexpectedly bypassed its live ceiling`);
    /* The three MONEY caps are raisable through the typed acknowledgement (see
     * test-operator-caps.mjs), so raising one by env alone refuses EARLIER — naming
     * the ceremony rather than the range. The invariant this test guards is unchanged
     * and is what is asserted: env alone can never bypass a live ceiling. */
    const MONEY = ["MAX_SOL_PER_TRADE", "DAILY_SOL_CAP", "DAILY_LOSS_LIMIT_SOL"];
    assert.match(result.stderr, MONEY.includes(name)
      ? /ALL THREE set explicitly|typed acknowledgement/
      : name === "MAX_OPEN_POSITIONS"
        ? /MAX_OPEN_POSITIONS must be an integer between 1 and 4/
      : new RegExp(`${name} must be between`));
  }
});

ok("live mode requires an explicit secondary RPC", () => {
  const result = run({ SOLANA_RPC_SECONDARY: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit independent SOLANA_RPC_SECONDARY/);
});

ok("different API-key paths on one RPC provider are not independent", () => {
  const result = run({ SOLANA_RPC: "https://same-rpc.invalid/key-a",
    SOLANA_RPC_SECONDARY: "https://same-rpc.invalid/key-b" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /independent provider hostname/);
});

ok("the public RPC is rejected in the secondary lane", () => {
  const result = run({ SOLANA_RPC_SECONDARY: "https://api.mainnet-beta.solana.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public Solana RPC/);
});

ok("missing live journal requires a one-time wallet-bound init acknowledgement", () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live journal is missing/);
});

ok("wallet-bound INIT_ONLY creates state without touching an RPC", () => {
  const result = run({ LIVE_STATE_INIT_ACK: wallet });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(stateDb));
  assert.match(result.stdout, /initialized journal/);
});

ok("journal cannot silently rebind to a replacement wallet", () => {
  const replacement = Keypair.generate();
  fs.writeFileSync(keyFile, JSON.stringify(Array.from(replacement.secretKey)), { mode: 0o600 });
  const result = run({ LIVE_TRADING_ACK: replacement.publicKey.toBase58() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /journal belongs to wallet/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} live startup gates passed\n`);
