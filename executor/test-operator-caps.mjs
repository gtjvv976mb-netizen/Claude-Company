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

/* ── THE BOUNDARY IS READ OUT OF THE POLLER, NEVER COPIED INTO THE FIXTURE ─────
 * Every "just over the ceiling" value below used to be a literal calibrated by hand to
 * the operator maxima of the day — 0.050001, 0.500001, 0.150001. On 2026-09-07 the
 * owner raised the per-trade size to 0.4 and removed the daily deployment cap
 * (dailySolCap parks at 1000, three orders of magnitude over the ~2 SOL that exists,
 * because the rail is woven through four files that each want a number). Those literals
 * did not fail loudly when the ceiling moved; they landed quietly INSIDE the new range,
 * so a test named "cannot exceed its hard maximum" was passing a value the poller is
 * supposed to accept. A hardcoded threshold stops testing anything the moment the
 * threshold moves, while the property — one lamport past the ceiling is refused — holds
 * at every ceiling. So derive the fixtures from OPERATOR_MAX itself.
 *
 * poller.mjs runs its boot checks on import and calls process.exit, so it cannot be
 * imported for its constants; the literal is parsed out of the source and a miss is a
 * hard failure rather than a silent default. Nothing here can pass by accident if the
 * maxima ever fall back to the canary: the ceremony assertions below only fire when the
 * requested tuple is genuinely a raise over LIVE_LIMITS. */
const pollerSource = fs.readFileSync(poller, "utf8");
const operatorMax = (key) => {
  const block = /const OPERATOR_MAX = Object\.freeze\(\{([^}]*)\}\)/.exec(pollerSource);
  assert.ok(block, "OPERATOR_MAX literal not found in poller.mjs — re-anchor this test");
  const field = new RegExp(`\\b${key}:\\s*(\\d[\\d_]*(?:\\.\\d+)?)`).exec(block[1]);
  assert.ok(field, `OPERATOR_MAX.${key} not found in poller.mjs — re-anchor this test`);
  return field[1].replace(/_/g, "");
};
const MAX = Object.freeze({
  trade: operatorMax("maxSolPerTrade"),
  daily: operatorMax("dailySolCap"),
  loss: operatorMax("dailyLossLimitSol"),
});
const LAMPORTS = 1_000_000_000n;
const toUnits = (value) => {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  assert.ok(match, `${value} is not a plain SOL decimal`);
  return BigInt(match[1]) * LAMPORTS + BigInt((match[2] || "").padEnd(9, "0") || "0");
};
const fromUnits = (units) => {
  const frac = (units % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${units / LAMPORTS}.${frac}` : `${units / LAMPORTS}`;
};
/** Exactly one lamport past a ceiling — the smallest amount that must still be refused. */
const over = (ceiling) => {
  const value = fromUnits(toUnits(ceiling) + 1n);
  assert.ok(toUnits(value) > toUnits(ceiling), `${value} must sit above ${ceiling}`);
  return value;
};
/** One lamport under — a legitimate value, used where a fixture needs a DIFFERENT number. */
const under = (ceiling) => fromUnits(toUnits(ceiling) - 1n);
/** More than 9 fractional digits, and a double that rounds exactly ONTO the ceiling. */
const overPrecise = (ceiling) => {
  const [whole, frac = ""] = ceiling.split(".");
  const literal = `${whole}.${frac.padEnd(26, "0")}1`;
  assert.ok(literal.split(".")[1].length > 9, `${literal} must exceed 9 fractional digits`);
  assert.equal(Number(literal), Number(ceiling),
    `${literal} must round onto ${ceiling}, or it proves nothing about rounding`);
  return literal;
};
/** How the poller echoes a cap back (units → Number), so the log assertion stays exact. */
const displayed = (value) => String(Number(toUnits(value)) / 1e9);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* THE CAPS ARE RAISABLE, WITH CEREMONY — and these assertions were rewritten from
 * "permanently frozen" to say so. The freeze is not a safety property, it is a
 * non-functioning bot: Solana's fixed network fees are 20% of a 0.005 SOL position,
 * so the entry guard demands a round trip returning over 100% of input and refuses
 * every call ever offered. Measured on live coins, real round trips are ~0.7% and the
 * same calls clear comfortably at the raised size.
 *
 * What must stay true is not "small" but "nothing raises exposure by accident". The
 * poller validates the exact persisted result; install.sh is the only supported path
 * and obtains the sentence from a local TTY. The v2 wording revokes the old f7-era
 * acknowledgement so a retained legacy environment cannot silently regain authority. */
const ackFor = (t, d, l, acknowledgedWallet = wallet) =>
  `I acknowledge WALL-ST-E caps v2 for ${acknowledgedWallet}: ${t} SOL per trade, ${d} SOL per day, ${l} SOL rolling realized-loss entry brake`;

ok("env alone cannot raise a cap — the ceremony is required", () => {
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: MAX.daily, DAILY_LOSS_LIMIT_SOL: MAX.loss });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
  assert.match(result.stderr, /I acknowledge WALL-ST-E caps v2/);
});
ok("a partial raise is refused and says why", () => {
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALL THREE set explicitly/);
});
ok("a sentence naming different numbers is refused", () => {
  // The sentence is one lamport off the per-trade cap actually requested.
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: MAX.daily,
    DAILY_LOSS_LIMIT_SOL: MAX.loss, LIVE_CAPS_ACK: ackFor(under(MAX.trade), MAX.daily, MAX.loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("the revoked legacy acknowledgement is refused", () => {
  const legacy = `I raise the live caps for ${wallet} to ${MAX.trade} SOL per trade, ${MAX.daily} SOL per day, ${MAX.loss} SOL daily loss`;
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: MAX.daily,
    DAILY_LOSS_LIMIT_SOL: MAX.loss, LIVE_CAPS_ACK: legacy });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("a sentence naming a different wallet is refused", () => {
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: MAX.daily,
    DAILY_LOSS_LIMIT_SOL: MAX.loss, LIVE_CAPS_ACK: ackFor(MAX.trade, MAX.daily, MAX.loss, "other-wallet") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
for (const [name, values, message] of [
  ["per-trade", [over(MAX.trade), MAX.daily, MAX.loss], /MAX_SOL_PER_TRADE must be between/],
  ["daily deploy", [MAX.trade, over(MAX.daily), MAX.loss], /DAILY_SOL_CAP must be between/],
  ["realized-loss brake", [MAX.trade, MAX.daily, over(MAX.loss)], /DAILY_LOSS_LIMIT_SOL must be between/],
]) ok(`${name} cannot exceed its evidence-backed hard maximum`, () => {
  const [trade, daily, loss] = values;
  const result = run({ MAX_SOL_PER_TRADE: trade, DAILY_SOL_CAP: daily,
    DAILY_LOSS_LIMIT_SOL: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
});
ok("over-precise literals cannot round down onto an operator maximum", () => {
  for (const [trade, daily, loss] of [
    [overPrecise(MAX.trade), MAX.daily, MAX.loss],
    [MAX.trade, overPrecise(MAX.daily), MAX.loss],
    [MAX.trade, MAX.daily, overPrecise(MAX.loss)],
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
ok("live max-open positions must be a whole number inside the sentinel", () => {
  for (const value of ["", "0", "1.5", "24.0", "24.0000000000000001", "25"]) {
    const result = run({ MAX_OPEN_POSITIONS: value });
    assert.notEqual(result.status, 0, `MAX_OPEN_POSITIONS=${JSON.stringify(value)} was accepted`);
    assert.match(result.stderr, /MAX_OPEN_POSITIONS must be an integer between 1 and 24/);
  }
});
ok("the daily deploy cap cannot sit below one allowed trade", () => {
  // Half the per-trade cap: a day that would refuse its own first trade, at any ceiling.
  const daily = fromUnits(toUnits(MAX.trade) / 2n);
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: daily,
    DAILY_LOSS_LIMIT_SOL: MAX.loss, LIVE_CAPS_ACK: ackFor(MAX.trade, daily, MAX.loss) });
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
  const result = run({ MAX_SOL_PER_TRADE: MAX.trade, DAILY_SOL_CAP: MAX.daily,
    DAILY_LOSS_LIMIT_SOL: MAX.loss, LIVE_CAPS_ACK: ackFor(MAX.trade, MAX.daily, MAX.loss) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp("OPERATOR-RAISED CAPS acknowledged: " +
    `${esc(displayed(MAX.trade))} SOL/trade, ${esc(displayed(MAX.daily))} SOL/day deploy, ` +
    `${esc(displayed(MAX.loss))} SOL rolling realized-loss entry brake`));
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
