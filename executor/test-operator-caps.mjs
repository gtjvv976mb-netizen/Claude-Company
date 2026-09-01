/** Raised live caps require the current wallet/value-bound policy ceremony. */
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
 * What must stay true is not "small" but "nothing raises exposure by accident". The
 * poller validates the exact persisted result; install.sh is the only supported path
 * and obtains the sentence from a local TTY. The v2 wording revokes the old f7-era
 * acknowledgement so a retained legacy environment cannot silently regain authority. */
const ackFor = (t, d, l, acknowledgedWallet = wallet) =>
  `I acknowledge WALL-ST-E caps v2 for ${acknowledgedWallet}: ${t} SOL per trade, ${d} SOL per day, ${l} SOL rolling realized-loss entry brake`;

ok("env alone cannot raise a cap — the ceremony is required", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5", DAILY_LOSS_LIMIT_SOL: "0.15" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
  assert.match(result.stderr, /I acknowledge WALL-ST-E caps v2/);
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
ok("the revoked legacy acknowledgement is refused", () => {
  const legacy = `I raise the live caps for ${wallet} to 0.05 SOL per trade, 0.5 SOL per day, 0.15 SOL daily loss`;
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: legacy });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("a sentence naming a different wallet is refused", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: ackFor("0.05", "0.5", "0.15", "other-wallet") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
for (const [name, values, message] of [
  ["per-trade", ["0.050001", "0.5", "0.15"], /MAX_SOL_PER_TRADE must be between/],
  ["daily deploy", ["0.05", "0.500001", "0.15"], /DAILY_SOL_CAP must be between/],
  ["realized-loss brake", ["0.05", "0.5", "0.150001"], /DAILY_LOSS_LIMIT_SOL must be between/],
]) ok(`${name} cannot exceed its evidence-backed hard maximum`, () => {
  const [trade, daily, loss] = values;
  const result = run({ MAX_SOL_PER_TRADE: trade, DAILY_SOL_CAP: daily,
    DAILY_LOSS_LIMIT_SOL: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
});
ok("over-precise literals cannot round down onto an operator maximum", () => {
  for (const [trade, daily, loss] of [
    ["0.050000000000000000000000001", "0.5", "0.15"],
    ["0.05", "0.50000000000000000000000001", "0.15"],
    ["0.05", "0.5", "0.15000000000000000000000001"],
  ]) {
    const result = run({ MAX_SOL_PER_TRADE: trade, DAILY_SOL_CAP: daily,
      DAILY_LOSS_LIMIT_SOL: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plain decimal with at most 9 fractional digits/);
  }
});
ok("every explicit money cap must meet the live minimum", () => {
  for (const name of ["MAX_SOL_PER_TRADE", "DAILY_SOL_CAP", "DAILY_LOSS_LIMIT_SOL"]) {
    for (const value of ["", "0", "0.0000009", "0.00000099999999999999999999"]) {
      const result = run({ [name]: value });
      assert.notEqual(result.status, 0, `${name}=${JSON.stringify(value)} was accepted`);
      assert.match(result.stderr, value === "0" || value === "0.0000009"
        ? new RegExp(`${name} must be between 0\\.000001`)
        : new RegExp(`${name} must be a plain decimal with at most 9 fractional digits`));
    }
  }
});
ok("live max-open positions must be an integer from one through four", () => {
  for (const value of ["", "0", "1.5", "4.0", "4.0000000000000001", "5"]) {
    const result = run({ MAX_OPEN_POSITIONS: value });
    assert.notEqual(result.status, 0, `MAX_OPEN_POSITIONS=${JSON.stringify(value)} was accepted`);
    assert.match(result.stderr, /MAX_OPEN_POSITIONS must be an integer between 1 and 4/);
  }
});
ok("the daily deploy cap cannot sit below one allowed trade", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.04",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: ackFor("0.05", "0.04", "0.15") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MAX_SOL_PER_TRADE/);
});
ok("daily deployment coherence is exact at one-lamport precision", () => {
  const trade = "0.010000001";
  const daily = "0.010000000";
  const loss = "0.01";
  const result = run({ MAX_SOL_PER_TRADE: trade, DAILY_SOL_CAP: daily,
    DAILY_LOSS_LIMIT_SOL: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MAX_SOL_PER_TRADE/);
});
ok("a fully lowered tuple still requires daily deploy to cover one trade", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.004", DAILY_SOL_CAP: "0.003",
    DAILY_LOSS_LIMIT_SOL: "0.004" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_SOL_CAP \(0\.003\) is below MAX_SOL_PER_TRADE \(0\.004\)/);
});
ok("a matching v2 acknowledgement raises to the exact supported maxima", () => {
  const result = run({ MAX_SOL_PER_TRADE: "0.05", DAILY_SOL_CAP: "0.5",
    DAILY_LOSS_LIMIT_SOL: "0.15", LIVE_CAPS_ACK: ackFor("0.05", "0.5", "0.15") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPERATOR-RAISED CAPS acknowledged: 0\.05 SOL\/trade, 0\.5 SOL\/day deploy, 0\.15 SOL rolling realized-loss entry brake/);
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
    DAILY_LOSS_LIMIT_SOL: "0.005", MAX_OPEN_POSITIONS: "1",
    SOL_USD_CACHE_MAX_AGE_MS: "60000" });
  assert.equal(result.status, 0, result.stderr);
});
ok("the default canary configuration initializes without a network request", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized journal/);
});

console.log(`\n${pass} versioned live-cap gates passed\n`);
fs.rmSync(dir, { recursive: true, force: true });
