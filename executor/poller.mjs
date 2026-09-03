/**
 * WALL-ST-E — CLAUDE COMPANY'S SELF-HOSTED POLLING EXECUTOR
 *
 * Default: paper decisions. EXECUTE=1 enables real mainnet swaps only after every
 * local gate below passes. The central desk remains keyless: this process polls a
 * read-only feed and signs with a dedicated burner that never leaves this machine.
 * First startup primes at the latest feed id and never replays old calls.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ExecutionJournal, LEGACY_CALL_IDENTITY_POLICY, acquireProcessLock,
  deskExitDecisionForPosition, positionEntryBlock, requirePositiveCallId, validateRiskState,
} from "./journal.mjs";
import {
  JupiterV2Executor, MAX_GROSS_RENT_LAMPORTS, WSOL, associatedTokenAddress,
  walletTokenAmount, independentClassicMintDecimals, independentMintProgram, mintTokenProgram,
  TOKEN_2022_PROGRAM, EXECUTION_READINESS_ROUTE,
} from "./jupiter.mjs";
import { token2022Enabled } from "./token2022.mjs";
import {
  RpcBalanceUnavailableError, verifyTrackedBalanceWithFailover,
} from "./balance-verification.mjs";
import {
  advanceFrozenBatchCursor, authenticatedFeedCursorState, waitForRecoveryBudget,
} from "./feed-drain.mjs";
import {
  clearExitMarkFailureWitness, clearPriceExitWitness, confirmExitMarkFailureWitness,
  confirmPriceExitWitness, executableExitMark, priceExitTrigger,
} from "./exit-trigger.mjs";
import { executorHeartbeatHealth, executorRuntimeFingerprint } from "./heartbeat-health.mjs";
import { validateEntryPreflightContext } from "./entry-quote-guard.mjs";
import {
  inspectOwnerControlFile, requireMacEntryPower, sleepAssertionFaultPath,
} from "./sleep-assertion.mjs";
import {
  independentSolUsdPrice, PYTH_SOL_USD_CACHE_SOURCE, solanaRpcConnectionConfig,
  usableSolUsdCache,
} from "./sol-usd-oracle.mjs";
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import { policyConfigForPosition, resolveTakeProfitRule, validateEntryReference } from "./trade-policy.mjs";

process.umask(0o077);

const API = (process.env.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const FEE_RESERVE = Number(process.env.FEE_RESERVE_SOL || 0.01);
const MAX_CALL_AGE_MS = Number(process.env.MAX_CALL_AGE_MIN || 45) * 60_000;
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MIN || 5) * 60_000;
const MAX_ENTRY_MARK_AGE_MS = Number(process.env.MAX_ENTRY_MARK_AGE_MIN || 15) * 60_000;
const MAX_ENTRY_DEVIATION_PCT = Number(process.env.MAX_ENTRY_DEVIATION_PCT || 10);
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SECONDARY_RPC = process.env.SOLANA_RPC_SECONDARY || "https://api.mainnet-beta.solana.com";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const JUPITER_API_BASE = (process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v2").replace(/\/$/, "");
const KEYPAIR_FILE = path.resolve(process.env.KEYPAIR || "./burner.json");
const STATE_DB = path.resolve(process.env.STATE_DB || "./.cc-executor.sqlite");
const LOCK_FILE = path.resolve(process.env.LOCK_FILE || `${STATE_DB}.lock`);
const PAUSE_ENTRIES_FILE = path.resolve(process.env.PAUSE_ENTRIES_FILE || `${STATE_DB}.pause-entries`);
const HARD_STOP_FILE = path.resolve(process.env.HARD_STOP_FILE || `${STATE_DB}.hard-stop`);
const SLEEP_ASSERTION_FAULT_FILE = sleepAssertionFaultPath(LOCK_FILE);
// Compute once, before the loop starts. A release changed on disk without restarting
// cannot make an old in-memory process impersonate the newly published runtime.
const RUNTIME_FINGERPRINT = executorRuntimeFingerprint(path.dirname(fileURLToPath(import.meta.url)));
const LAMPORTS = 1_000_000_000;
// newest floor verdict already logged; verdicts older than this are not repeated
let lastDecisionSeen = Date.now() - 6 * 3600e3;
/* The FULL 44-character mainnet-beta genesis hash. It shipped truncated to 32
 * characters, so the equality check could never pass against a real RPC — a bug only
 * a genuine live boot could surface, and exactly the kind fail-closed design is for:
 * the first live start REFUSED with the true genesis printed in the message, which is
 * how this was caught. Verified against the RPC's own answer. */
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LIVE_LIMITS = Object.freeze({
  maxSolPerTrade: 0.005,
  dailySolCap: 0.01,
  dailyLossLimitSol: 0.01,
  maxOpenPositions: 4,
  slippageBps: 300,
  maxPriceImpactPct: 5,
  maxExitPriceImpactPct: 50,
  maxFeeBps: 100,
  maxNetworkFeeLamports: 500_000,
  maxNetworkFeePct: 10,
  // Gross creation rent for one temporary WSOL ATA plus one destination ATA is
  // currently 4,078,560 lamports. The reviewed ceiling leaves only a narrow buffer;
  // core 0.005/0.01-SOL exposure caps are unchanged.
  maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
  maxEntryRoundTripLossPct: 12,
  maxEntryQuoteDriftPct: 5,
  maxEntryPreflightAgeMs: 60_000,
  maxExitTriggerAgeMs: 60_000,
  solUsdCacheMaxAgeMs: 30 * 60_000,
  maxAttempts: 3,
  /* Adversarial-review hardening, 2026-09-01 — each closes a hole where the only
   * number consulted was one the counterparty authored:
   * blockHeightWindow: a quoted lastValidBlockHeight further than this above the
   *   chain's real height is refused BEFORE signing. Unbounded, one inflated value
   *   wedged the journal forever and disarmed every exit behind it.
   * maxQuoteShortfallPct: if simulation delivers more than this % above the QUOTED
   *   output, the quote was low-balled (stale or adversarial) and the signed minOut
   *   floor is garbage — refuse. The chain is the one number Jupiter cannot author.
   * maxExitAttempts: exits get more tries than entries — a stop that fails three
   *   times during the exact dump that fired it must not be dead forever — but
   *   bounded, because every on-chain failure burns a real, accounted fee. */
  blockHeightWindow: 600,
  maxQuoteShortfallPct: 15,
  maxExitAttempts: 12,
});
const log = (...args) => console.log(new Date().toISOString(), "WALL-ST-E", ...args);
const fatal = (message) => { console.error(new Date().toISOString(), "WALL-ST-E REFUSES:", message); process.exit(1); };

// One durable journal has exactly one lock identity. Allowing LOCK_FILE to point
// elsewhere lets two differently configured pollers mutate the same SQLite state.
if (LOCK_FILE !== `${STATE_DB}.lock`)
  fatal("LOCK_FILE must be the canonical STATE_DB lock (STATE_DB plus .lock)");

const number = (name, value, { min = 0, max = Infinity } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} must be between ${min} and ${max}`);
  return n;
};
const SOL_SCALE = 1_000_000_000n;
const plainSolUnits = (value) => {
  const raw = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(raw);
  if (!match) return null;
  return BigInt(match[1]) * SOL_SCALE + BigInt((match[2] || "").padEnd(9, "0") || "0");
};
const solCap = (name, value, { min, max }) => {
  const raw = String(value);
  const units = plainSolUnits(raw);
  if (units === null)
    fatal(`${name} must be a plain decimal with at most 9 fractional digits`);
  const minUnits = plainSolUnits(min);
  const maxUnits = plainSolUnits(max);
  if (units < minUnits || units > maxUnits)
    fatal(`${name} must be between ${min} and ${max}`);
  return Object.freeze({ raw, units, value: Number(units) / 1_000_000_000 });
};
const openPositions = (value) => {
  const raw = String(value);
  if (!/^[1-4]$/.test(raw))
    fatal("MAX_OPEN_POSITIONS must be an integer between 1 and 4");
  return Number(raw);
};

if (!SECRET || !/^\d+$/.test(FLOOR) || Number(FLOOR) <= 0) fatal("CC_SECRET and a positive CC_FLOOR are required");
/* HTTPS always — with one carve-out that cannot weaken live. A loopback API lets a
 * full dry-run rehearsal run against a local office process (the only way to test the
 * feed contract end-to-end without touching production). Loopback traffic never
 * crosses a network, so there is nothing for TLS to protect; any OTHER plain-HTTP
 * host still refuses, and EXECUTE=1 refuses plain HTTP unconditionally — a live
 * canary has no business on a rehearsal feed. */
{
  let apiHost = "";
  try { apiHost = new URL(API).hostname; } catch { fatal("CC_API is not a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiHost);
  if (!API.startsWith("https://") && !(loopback && !EXECUTE))
    fatal(EXECUTE ? "live execution requires an HTTPS CC_API — no loopback carve-out"
                  : "CC_API must use HTTPS (plain HTTP is allowed only for loopback dry-run rehearsals)");
}
if (!fs.existsSync(KEYPAIR_FILE)) fatal(`no keypair at ${KEYPAIR_FILE}`);

function loadKeypair() {
  const st = fs.lstatSync(KEYPAIR_FILE);
  if (!st.isFile() || st.isSymbolicLink()) fatal("KEYPAIR must be a regular, non-symlink file");
  if (EXECUTE) {
    if ((st.mode & 0o077) !== 0) fatal(`live keypair permissions must be 0600 (chmod 600 ${KEYPAIR_FILE})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) fatal("live keypair must be owned by the service user");
  }
  let bytes;
  try { bytes = JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8")); }
  catch { fatal("KEYPAIR is not a readable Solana JSON keypair"); }
  try { return Keypair.fromSecretKey(new Uint8Array(bytes)); }
  catch { fatal("KEYPAIR does not contain a valid Solana secret key"); }
}

const kp = loadKeypair();
const WALLET = kp.publicKey.toBase58();
const controlActive = (file, label) => inspectOwnerControlFile(file, { label }).present;
const pauseEntries = () => controlActive(PAUSE_ENTRIES_FILE, "entry-pause sentinel") ||
  controlActive(SLEEP_ASSERTION_FAULT_FILE, "sleep assertion fault latch");
const hardStop = () => controlActive(HARD_STOP_FILE, "hard-stop sentinel");
const assertEntriesUnpaused = () => {
  const pause = inspectOwnerControlFile(PAUSE_ENTRIES_FILE, { label: "entry-pause sentinel" });
  if (pause.present) throw new Error(pause.valid
    ? "PAUSE ENTRIES file appeared before submission"
    : `PAUSE ENTRIES control is unsafe (${pause.reason})`);
  const fault = inspectOwnerControlFile(SLEEP_ASSERTION_FAULT_FILE, {
    label: "sleep assertion fault latch",
  });
  if (fault.present) throw new Error(fault.valid
    ? "sleep assertion fault is latched; explicit operator repair and review are required"
    : `sleep assertion fault latch is unsafe (${fault.reason})`);
};

if (EXECUTE) {
  if (process.env.LIVE_TRADING_ACK !== WALLET)
    fatal(`LIVE_TRADING_ACK must exactly equal this burner public key: ${WALLET}`);
  if (!JUPITER_API_KEY) fatal("JUPITER_API_KEY is required for live execution");
  if (!process.env.SOLANA_RPC || !RPC.startsWith("https://")) fatal("live execution requires an explicit private HTTPS SOLANA_RPC");
  if (!process.env.SOLANA_RPC_SECONDARY)
    fatal("live execution requires an explicit independent SOLANA_RPC_SECONDARY");
  let primaryRpcUrl, secondaryRpcUrl;
  try {
    primaryRpcUrl = new URL(RPC);
    secondaryRpcUrl = new URL(SECONDARY_RPC);
  } catch { fatal("both live RPC endpoints must be valid HTTPS URLs"); }
  const primaryHost = primaryRpcUrl.hostname.toLowerCase().replace(/\.$/, "");
  const secondaryHost = secondaryRpcUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (primaryRpcUrl.protocol !== "https:" || secondaryRpcUrl.protocol !== "https:")
    fatal("both live RPC endpoints must use HTTPS");
  if (primaryHost === "api.mainnet-beta.solana.com" || secondaryHost === "api.mainnet-beta.solana.com")
    fatal("the rate-limited public Solana RPC is not accepted for either live endpoint");
  if (primaryHost === secondaryHost)
    fatal("SOLANA_RPC_SECONDARY must use an independent provider hostname");
  if (!JUPITER_API_BASE.startsWith("https://")) fatal("JUPITER_API_BASE must use HTTPS");
  const legacy = path.resolve(process.env.STATE_FILE || "./.cc-state.json");
  if (fs.existsSync(legacy)) {
    let old;
    try { old = JSON.parse(fs.readFileSync(legacy, "utf8")); }
    catch { fatal(`legacy state is unreadable: ${legacy}`); }
    if (Object.keys(old?.positions || {}).length)
      fatal(`legacy JSON contains unproven positions; reconcile them manually before live mode (${legacy})`);
  }
  if (!fs.existsSync(STATE_DB) && process.env.LIVE_STATE_INIT_ACK !== WALLET)
    fatal(`live journal is missing; initialize it once with LIVE_STATE_INIT_ACK=${WALLET} and INIT_ONLY=1`);
}

/* ── OPERATOR-RAISED LIVE CAPS ────────────────────────────────────────────────
 * Reinstated after a rewrite dropped it. The canary ceilings stay the default and env
 * can still only LOWER them; raising is possible and deliberately awkward.
 *
 * It has to exist because the canary size cannot trade at all. Solana's network fees
 * are fixed, so two worst-case 500k-lamport fees are 20% of a 0.005 SOL position, and
 * the entry guard then demands a round trip returning over 100% of input —
 * unsatisfiable by construction. Measured on live coins: real round trips are ~0.7%,
 * and at 0.05 SOL the same call clears comfortably. Frozen forever, the canary is not
 * caution; it is a bot that can never buy anything.
 *
 * The property preserved is not "small" — it is that nothing raises real-money
 * exposure by accident. All three money caps must be set explicitly, and LIVE_CAPS_ACK
 * must be the current versioned sentence naming THIS wallet and THESE numbers; change
 * one and it stops matching. The v2 wording deliberately revokes the pre-hardening
 * acknowledgement retained by some old environments. OPERATOR_MAX stays at the
 * evidence-backed configuration that cleared the live preflight, and maxOpenPositions
 * stays frozen because it multiplies every other cap. */
const OPERATOR_MAX = Object.freeze({ maxSolPerTrade: 0.05, dailySolCap: 0.5, dailyLossLimitSol: 0.15 });
const capsAckSentence = (wallet, trade, daily, loss) =>
  `I acknowledge WALL-ST-E caps v2 for ${wallet}: ${trade} SOL per trade, ${daily} SOL per day, ${loss} SOL rolling realized-loss entry brake`;

let LIVE_CEILINGS = LIVE_LIMITS;
if (EXECUTE) {
  const req = {
    trade: process.env.MAX_SOL_PER_TRADE,
    daily: process.env.DAILY_SOL_CAP,
    loss: process.env.DAILY_LOSS_LIMIT_SOL,
  };
  const requested = {
    trade: req.trade == null ? null : solCap("MAX_SOL_PER_TRADE", req.trade,
      { min: 0.000001, max: OPERATOR_MAX.maxSolPerTrade }),
    daily: req.daily == null ? null : solCap("DAILY_SOL_CAP", req.daily,
      { min: 0.000001, max: OPERATOR_MAX.dailySolCap }),
    loss: req.loss == null ? null : solCap("DAILY_LOSS_LIMIT_SOL", req.loss,
      { min: 0.000001, max: OPERATOR_MAX.dailyLossLimitSol }),
  };
  const wantsRaise =
    (requested.trade && requested.trade.units > plainSolUnits(LIVE_LIMITS.maxSolPerTrade)) ||
    (requested.daily && requested.daily.units > plainSolUnits(LIVE_LIMITS.dailySolCap)) ||
    (requested.loss && requested.loss.units > plainSolUnits(LIVE_LIMITS.dailyLossLimitSol));
  if (wantsRaise) {
    if (!requested.trade || !requested.daily || !requested.loss)
      fatal("raising any live cap requires ALL THREE set explicitly: MAX_SOL_PER_TRADE, " +
        "DAILY_SOL_CAP, DAILY_LOSS_LIMIT_SOL — a partial raise hides the numbers the " +
        "acknowledgement exists to make you look at");
    if (requested.daily.units < requested.trade.units)
      fatal(`DAILY_SOL_CAP (${requested.daily.value}) is below MAX_SOL_PER_TRADE (${requested.trade.value}) — the day would refuse the first trade`);
    const expected = capsAckSentence(WALLET, requested.trade.raw,
      requested.daily.raw, requested.loss.raw);
    if ((process.env.LIVE_CAPS_ACK || "") !== expected)
      fatal("raised live caps need a typed acknowledgement. Set LIVE_CAPS_ACK to exactly:\n\n    " + expected + "\n");
    LIVE_CEILINGS = Object.freeze({ ...LIVE_LIMITS,
      maxSolPerTrade: requested.trade.value,
      dailySolCap: requested.daily.value,
      dailyLossLimitSol: requested.loss.value });
    log(`OPERATOR-RAISED CAPS acknowledged: ${requested.trade.value} SOL/trade, ${requested.daily.value} SOL/day deploy, ${requested.loss.value} SOL rolling realized-loss entry brake ` +
      `(hard maxima ${OPERATOR_MAX.maxSolPerTrade}/${OPERATOR_MAX.dailySolCap}/${OPERATOR_MAX.dailyLossLimitSol} are a code change, by design)`);
  }
}

const configuredTradeCap = solCap("MAX_SOL_PER_TRADE",
  process.env.MAX_SOL_PER_TRADE ?? (EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : DEFAULTS.maxSolPerTrade),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : 100 });
const configuredDailyCap = solCap("DAILY_SOL_CAP",
  process.env.DAILY_SOL_CAP ?? (EXECUTE ? LIVE_CEILINGS.dailySolCap : DEFAULTS.dailySolCap),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailySolCap : 1000 });
const configuredLossCap = solCap("DAILY_LOSS_LIMIT_SOL",
  process.env.DAILY_LOSS_LIMIT_SOL ?? (EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : DEFAULTS.dailyLossLimitSol),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : 1000 });
const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: configuredTradeCap.value,
  dailySolCap: configuredDailyCap.value,
  dailyLossLimitSol: configuredLossCap.value,
  maxOpenPositions: openPositions(process.env.MAX_OPEN_POSITIONS ?? DEFAULTS.maxOpenPositions),
  trailPct: number("TRAIL_PCT", process.env.TRAIL_PCT || DEFAULTS.trailPct, { min: 0.01, max: 0.95 }),
  fDefault: number("F_DEFAULT", process.env.F_DEFAULT || DEFAULTS.fDefault, { min: 0.00001, max: 1 }),
  fNameMax: number("F_NAME_MAX", process.env.F_NAME_MAX || DEFAULTS.fNameMax, { min: 0.00001, max: 1 }),
  bookHeatMax: number("BOOK_HEAT_MAX", process.env.BOOK_HEAT_MAX || DEFAULTS.bookHeatMax, { min: 0.00001, max: 1 }),
  maxAgeHours: number("MAX_AGE_HOURS", process.env.MAX_AGE_HOURS || DEFAULTS.maxAgeHours, { min: 0.01, max: 720 }),
  scaleOutPct: 0,
};
if (EXECUTE && configuredDailyCap.units < configuredTradeCap.units)
  fatal(`DAILY_SOL_CAP (${CFG.dailySolCap}) is below MAX_SOL_PER_TRADE (${CFG.maxSolPerTrade}) — the day would refuse the first trade`);

// Parse every transaction rail before INIT_ONLY can exit. This makes the
// installer validate the exact persistent environment that systemd will use.
const JUPITER_CFG = {
  slippageBps: number("SLIPPAGE_BPS", process.env.SLIPPAGE_BPS || LIVE_LIMITS.slippageBps,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.slippageBps : 1_000 }),
  maxPriceImpactPct: number("MAX_PRICE_IMPACT_PCT",
    process.env.MAX_PRICE_IMPACT_PCT || LIVE_LIMITS.maxPriceImpactPct,
    { min: 0.01, max: EXECUTE ? LIVE_LIMITS.maxPriceImpactPct : 50 }),
  maxExitPriceImpactPct: number("MAX_EXIT_PRICE_IMPACT_PCT",
    process.env.MAX_EXIT_PRICE_IMPACT_PCT || LIVE_LIMITS.maxExitPriceImpactPct,
    { min: 0.01, max: EXECUTE ? LIVE_LIMITS.maxExitPriceImpactPct : 100 }),
  maxFeeBps: number("MAX_JUPITER_FEE_BPS", process.env.MAX_JUPITER_FEE_BPS || LIVE_LIMITS.maxFeeBps,
    { min: 0, max: EXECUTE ? LIVE_LIMITS.maxFeeBps : 500 }),
  maxNetworkFeeLamports: number("MAX_NETWORK_FEE_LAMPORTS",
    process.env.MAX_NETWORK_FEE_LAMPORTS || LIVE_LIMITS.maxNetworkFeeLamports,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxNetworkFeeLamports : 100_000_000 }),
  maxNetworkFeePct: number("MAX_NETWORK_FEE_PCT",
    process.env.MAX_NETWORK_FEE_PCT || LIVE_LIMITS.maxNetworkFeePct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxNetworkFeePct : 25 }),
  maxRentLamports: number("MAX_RENT_LAMPORTS",
    process.env.MAX_RENT_LAMPORTS || LIVE_LIMITS.maxRentLamports,
    { min: 0, max: EXECUTE ? LIVE_LIMITS.maxRentLamports : 10_000_000 }),
  maxEntryRoundTripLossPct: number("MAX_ENTRY_ROUND_TRIP_LOSS_PCT",
    process.env.MAX_ENTRY_ROUND_TRIP_LOSS_PCT || LIVE_LIMITS.maxEntryRoundTripLossPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryRoundTripLossPct : 50 }),
  maxEntryQuoteDriftPct: number("MAX_ENTRY_QUOTE_DRIFT_PCT",
    process.env.MAX_ENTRY_QUOTE_DRIFT_PCT || LIVE_LIMITS.maxEntryQuoteDriftPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryQuoteDriftPct : 50 }),
  maxEntryPreflightAgeMs: number("MAX_ENTRY_PREFLIGHT_AGE_MS",
    process.env.MAX_ENTRY_PREFLIGHT_AGE_MS || LIVE_LIMITS.maxEntryPreflightAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxEntryPreflightAgeMs : 600_000 }),
  maxExitTriggerAgeMs: number("MAX_EXIT_TRIGGER_AGE_MS",
    process.env.MAX_EXIT_TRIGGER_AGE_MS || LIVE_LIMITS.maxExitTriggerAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxExitTriggerAgeMs : 600_000 }),
  maxAttempts: number("MAX_TX_ATTEMPTS", process.env.MAX_TX_ATTEMPTS || LIVE_LIMITS.maxAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxAttempts : 10 }),
  // Exit retries beyond maxAttempts: only when every prior attempt is terminally
  // proven dead, and never past this. See LIVE_LIMITS for why exits differ.
  maxExitAttempts: number("MAX_EXIT_TX_ATTEMPTS",
    process.env.MAX_EXIT_TX_ATTEMPTS || LIVE_LIMITS.maxExitAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxExitAttempts : 50 }),
  blockHeightWindow: number("BLOCK_HEIGHT_WINDOW",
    process.env.BLOCK_HEIGHT_WINDOW || LIVE_LIMITS.blockHeightWindow,
    { min: 150, max: EXECUTE ? LIVE_LIMITS.blockHeightWindow : 10_000 }),
  maxQuoteShortfallPct: number("MAX_QUOTE_SHORTFALL_PCT",
    process.env.MAX_QUOTE_SHORTFALL_PCT || LIVE_LIMITS.maxQuoteShortfallPct,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxQuoteShortfallPct : 100 }),
  finalityTimeoutMs: number("FINALITY_TIMEOUT_MS", process.env.FINALITY_TIMEOUT_MS || 30_000,
    { min: 1_000, max: 120_000 }),
};

// Parse this once at startup. Live operators may shorten the outage bridge, but
// cannot extend the reviewed 30-minute canary ceiling through a mutable env value.
const SOL_USD_CACHE_MAX_AGE_MS = number("SOL_USD_CACHE_MAX_AGE_MS",
  process.env.SOL_USD_CACHE_MAX_AGE_MS || LIVE_LIMITS.solUsdCacheMaxAgeMs,
  { min: 1_000, max: EXECUTE ? LIVE_LIMITS.solUsdCacheMaxAgeMs : 24 * 60 * 60_000 });

number("POLL_MS", POLL_MS, { min: 1_000, max: 3_600_000 });
number("FEE_RESERVE_SOL", FEE_RESERVE, { min: 0, max: 100 });
number("MAX_CALL_AGE_MIN", MAX_CALL_AGE_MS / 60_000, { min: 1, max: 10_080 });
number("MAX_FUTURE_SKEW_MIN", MAX_FUTURE_SKEW_MS / 60_000, { min: 0.1, max: 60 });
number("MAX_ENTRY_MARK_AGE_MIN", MAX_ENTRY_MARK_AGE_MS / 60_000, { min: 1, max: 60 });
number("MAX_ENTRY_DEVIATION_PCT", MAX_ENTRY_DEVIATION_PCT, { min: 0.1, max: 50 });

const releaseLock = (() => {
  try { return acquireProcessLock(LOCK_FILE); }
  catch (error) { fatal(error.message); }
})();
let journal;
try {
  journal = new ExecutionJournal(STATE_DB, {
    wallet: WALLET,
    create: !EXECUTE || fs.existsSync(STATE_DB) || process.env.LIVE_STATE_INIT_ACK === WALLET,
  });
} catch (error) {
  releaseLock();
  fatal(error.message);
}

let S = journal.snapshot();
S.state = { ...freshState(Date.now()), ...(S.state || {}) };
Object.assign(S.state, journal.rollingRisk(Date.now()));
S.positions ||= {};
let feedRollback = (() => {
  const value = journal.getMeta("feed_rollback");
  if (value == null) return null;
  if (value?.active === true && Number.isSafeInteger(Number(value.cursor)) &&
      Number.isSafeInteger(Number(value.latestId))) return value;
  // A corrupt durable alarm is itself reason to keep entries frozen until a valid
  // authenticated feed proves it has caught back up to the durable cursor.
  return { active: true, cursor: S.cursor, latestId: -1, observedAt: Date.now() };
})();
const feedRollbackActive = () => feedRollback?.active === true;
const persistFeedRollback = (latestId) => {
  feedRollback = {
    active: true, cursor: S.cursor, latestId: Number(latestId), observedAt: Date.now(),
  };
  journal.setMeta("feed_rollback", feedRollback);
};
const clearFeedRollback = () => {
  if (!feedRollbackActive()) return;
  feedRollback = null;
  journal.setMeta("feed_rollback", null);
};
const save = () => journal.saveRuntime(S);
save();
if (process.env.INIT_ONLY === "1") {
  log(`initialized journal for ${WALLET} at ${STATE_DB}; no network request or trade was made`);
  journal.close();
  releaseLock();
  process.exit(0);
}

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping on ${signal}`);
  try { journal.close(); } catch {}
  releaseLock();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", releaseLock);

// Both independent providers use an actually aborting HTTP transport. A logical
// Promise.race elsewhere may fail closed sooner, but no abandoned socket/request can
// survive this fixed ceiling or accumulate without bound across recovery passes.
const conn = new Connection(RPC, solanaRpcConnectionConfig());
const secondaryConn = EXECUTE
  ? new Connection(SECONDARY_RPC, solanaRpcConnectionConfig())
  : null;
/* A NETWORK BLIP IS NOT A WRONG CHAIN, AND IT WAS COSTING THE BOT ITS LIFE.
 *
 * This check exists so the bot can never trade against devnet, and that part is
 * absolutely right. But it treated "the RPC did not answer" exactly like "the RPC
 * answered, and it is not mainnet" — both went to fatal(), which is process.exit(1),
 * and launchd restarts. Measured over two days of the live log: 63 cap-acknowledgement
 * lines against 14 boots, and at 06:07 on 2026-09-03 four "RPC mainnet check failed:
 * fetch failed" refusals inside 31 seconds. The bot spent much of its life dead or
 * restarting, and every restart hurt twice — it was not polling while down, and when it
 * came back the calls waiting for it were already past MAX_CALL_AGE_MIN and skipped as
 * stale ("call is 143m old (max 45m)"). A trading bot that cannot survive a dropped
 * packet cannot trade.
 *
 * So the two facts are now separated. An ANSWER that is not mainnet is a configuration
 * error: refuse at once, exactly as before, because no amount of retrying turns a
 * devnet endpoint into mainnet. A FAILURE TO REACH the provider is weather: wait and
 * ask again. The process stays alive and nothing trades until BOTH providers have
 * proved mainnet, so the guard is not weakened by a single byte — it is merely allowed
 * to be answered late.
 */
async function proveMainnetOrWait() {
  const MAX_BACKOFF_MS = 30_000;
  for (let attempt = 1; ; attempt++) {
    let genesis, secondaryGenesis;
    try {
      [genesis, secondaryGenesis] = await Promise.all([
        conn.getGenesisHash(), secondaryConn.getGenesisHash(),
      ]);
    } catch (error) {
      const waitMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 5));
      // Once plainly, then every tenth attempt: a short outage still leaves a trace and
      // a long one does not bury the log.
      if (attempt === 1 || attempt % 10 === 0)
        log(`RPC unreachable for the mainnet check (attempt ${attempt}: ${error.message}) —` +
          ` waiting ${Math.round(waitMs / 1_000)}s and asking again.` +
          ` NOTHING is traded until both providers have proved mainnet.`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (genesis !== MAINNET_GENESIS) fatal(`RPC is not Solana mainnet-beta (genesis ${genesis})`);
    if (secondaryGenesis !== MAINNET_GENESIS)
      fatal(`secondary RPC is not Solana mainnet-beta (genesis ${secondaryGenesis})`);
    if (attempt > 1) log(`both RPC providers proved mainnet after ${attempt} attempts`);
    return;
  }
}

if (EXECUTE) await proveMainnetOrWait();

const jupiter = JUPITER_API_KEY ? new JupiterV2Executor({
  connection: conn,
  secondaryConnection: secondaryConn,
  keypair: kp,
  journal,
  apiKey: JUPITER_API_KEY,
  baseUrl: JUPITER_API_BASE,
  hardStop,
  submissionGate: (intent) => entrySubmissionGate(intent),
  log,
  config: JUPITER_CFG,
}) : null;

const openList = () => Object.values(S.positions);
// A mint's token program never changes after initialization, so one audited answer is
// cached for the life of the process. Both providers are asked first; if one is down,
// the lane that IS answering still audits the mint itself. A balance read must survive
// a single-provider outage — that failover is the whole point of the second lane — and
// entry pricing keeps its strict two-provider requirement elsewhere.
const MINT_PROGRAM_CACHE = new Map();
async function mintProgramFor(mint, connection = conn) {
  if (!MINT_PROGRAM_CACHE.has(mint)) {
    let program;
    if (secondaryConn) {
      try { program = await independentMintProgram(conn, secondaryConn, mint); }
      catch { program = await mintTokenProgram(connection, mint); }
    } else program = await mintTokenProgram(connection, mint);
    MINT_PROGRAM_CACHE.set(mint, program);
  }
  return MINT_PROGRAM_CACHE.get(mint);
}
async function heldRaw(mint, connection = conn) {
  let program, account;
  try { program = await mintProgramFor(mint, connection); }
  catch (error) { throw new RpcBalanceUnavailableError(error); }
  const ata = associatedTokenAddress(WALLET, mint, program);
  try { account = await connection.getAccountInfo(new PublicKey(ata), "confirmed"); }
  catch (error) { throw new RpcBalanceUnavailableError(error); }
  return walletTokenAmount(account, {
    program, mint, wallet: WALLET, allowMissing: true, label: `canonical ATA ${ata}`,
  });
}
/* ONE READ, NO RETRY, NO FAILOVER — ON THE PATH THAT DECIDES WHETHER WE CAN AFFORD
 * THE TRADE. A single RPC hiccup here dropped the whole call, and the log shows how
 * ordinary those hiccups are: "Solana RPC HTTP request timed out after 4000ms" and
 * "RPC could not obtain a processed-slot freshness anchor" appear throughout, and
 * roughly half the readiness rehearsals fail for transport reasons rather than trading
 * ones. Three lines below, inspectTrackedBalance already reads a token balance through
 * verifyTrackedBalanceWithFailover against BOTH providers; this read simply never
 * learned the same trick.
 *
 * Retry the primary once, then ask the independent secondary. Still throws when nothing
 * answers, because an unknown balance must never be treated as a sufficient one. */
async function solBalance() {
  const read = async (connection, label) => {
    const lamports = await connection.getBalance(kp.publicKey, "confirmed");
    if (!Number.isFinite(lamports)) throw new Error(`${label} returned a non-numeric balance`);
    return lamports / LAMPORTS;
  };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await read(conn, "primary RPC"); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (secondaryConn) {
    try {
      const balance = await read(secondaryConn, "secondary RPC");
      log("wallet balance: the primary RPC did not answer twice; the independent secondary did" +
        ` (${lastError?.message || lastError})`);
      return balance;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function inspectTrackedBalance(pos) {
  const balance = await verifyTrackedBalanceWithFailover({
    trackedRaw: String(pos.qtyRaw || "0"),
    readPrimary: () => heldRaw(pos.mint, conn),
    readSecondary: secondaryConn ? () => heldRaw(pos.mint, secondaryConn) : null,
  });
  if (balance.verified && balance.source === "secondary") {
    log(`${pos.symbol}: primary canonical-ATA read failed; custody verified by the independent secondary RPC`);
  }
  return balance;
}

function persistBalanceBlock(pos, balance) {
  pos.balanceReconciliationRequired = true;
  pos.balanceReconciliationReason = balance.reason;
  pos.balanceObservedAt = Date.now();
  pos.balanceObservedPrimaryRaw = balance.primaryRaw ?? null;
  pos.balanceObservedSecondaryRaw = balance.secondaryRaw ?? null;
  save();
}

function clearBalanceBlock(pos) {
  delete pos.balanceReconciliationRequired;
  delete pos.balanceReconciliationReason;
  delete pos.balanceObservedAt;
  delete pos.balanceObservedPrimaryRaw;
  delete pos.balanceObservedSecondaryRaw;
}

function latchExit(pos, why, intentId, trigger = null) {
  if (!EXECUTE) return;
  pos.exitExecutionRequired = true;
  pos.exitExecutionReason ||= String(why || "risk exit");
  pos.exitExecutionIntentId ||= intentId;
  pos.exitExecutionObservedAt ||= Date.now();
  if (trigger && !pos.exitExecutionTrigger) pos.exitExecutionTrigger = structuredClone(trigger);
  save();
}

function clearExitLatch(pos) {
  for (const key of ["exitExecutionRequired", "exitExecutionReason", "exitExecutionIntentId",
    "exitExecutionObservedAt", "exitExecutionTrigger", "exitExecutionLastError",
    "exitExecutionLastAttemptAt"]) delete pos[key];
}

function validEntryEvent(ev) {
  try { new PublicKey(ev.mint); } catch { throw new Error("invalid Solana mint in feed event"); }
  requirePositiveCallId(ev.call_id, "entry event call_id");
  if (!Number.isFinite(Number(ev.ts)) || Number(ev.ts) <= 0) throw new Error("entry event has no valid timestamp");
  if (Number(ev.ts) > Date.now() + MAX_FUTURE_SKEW_MS) throw new Error("entry event timestamp is too far in the future");
}

function entryEventSubmissionGate(intent) {
  if (intent?.kind !== "entry") return;
  assertEntriesUnpaused();
  const event = intent.context?.event;
  validEntryEvent(event);
  if (Date.now() - Number(event.ts) > MAX_CALL_AGE_MS)
    throw new Error("entry call became stale before submission");
  validateEntryReference(event, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  });
}

function entrySubmissionGate(intent) {
  entryEventSubmissionGate(intent);
  if (intent?.kind === "entry" && EXECUTE && process.env["WALLSTE_SUPERVISOR"] === "launchd") {
    requireMacEntryPower({ ownerPid: process.pid, lockFile: LOCK_FILE,
      pauseEntriesFile: PAUSE_ENTRIES_FILE });
    // The synchronous pmset/ps proof takes time. A concurrent power watcher or
    // operator pause that appeared during those reads must still close this gate.
    assertEntriesUnpaused();
  }
  validateEntryPreflightContext(intent, {
    nowMs: Date.now(), maxEntryPreflightAgeMs: JUPITER_CFG.maxEntryPreflightAgeMs,
    requireFresh: true,
  });
}

function confirmedAmounts(intent, label) {
  if (!intent || intent.state !== "confirmed")
    throw new Error(`${label} intent is not confirmed`);
  const input = String(intent.actualInputRaw ?? "");
  const output = String(intent.actualOutputRaw ?? "");
  const exactIn = String(intent.amountRaw ?? "");
  if (!/^\d+$/.test(input) || !/^\d+$/.test(output) || BigInt(input) <= 0n || BigInt(output) <= 0n)
    throw new Error(`${label} confirmed without positive actual fill totals`);
  if (!/^\d+$/.test(exactIn) || BigInt(input) !== BigInt(exactIn))
    throw new Error(`${label} actual input does not match its durable exact-in amount`);
  const networkFee = String(intent.networkFeeLamports ?? "");
  if (!/^\d+$/.test(networkFee)) throw new Error(`${label} confirmed without an exact network fee`);
  return { input, output, networkFee };
}

function recoveryRuntime(context) {
  const next = structuredClone(S);
  const liveState = structuredClone(next.state);
  if (context?.riskStateBefore && typeof context.riskStateBefore === "object") {
    const recovered = structuredClone(context.riskStateBefore);
    // A malformed pre-sign snapshot must not prevent custody accounting. Exact
    // financial rails are rebuilt from risk_events inside markAccounted anyway.
    try {
      validateRiskState(recovered, { now: Date.now() });
      next.state = recovered;
    } catch {}
  }
  // Unrelated exits may reconcile independently and carry equally old pre-sign
  // snapshots. Lifetime result counters are monotonic: restoring one snapshot may
  // never erase a result already accounted by another intent.
  for (const key of ["wins", "losses"]) {
    const live = Number(liveState?.[key]);
    const recovered = Number(next.state?.[key]);
    if (Number.isSafeInteger(live) && live >= 0 &&
        Number.isSafeInteger(recovered) && recovered >= 0)
      next.state[key] = Math.max(live, recovered);
  }
  return next;
}

/**
 * Finish the local half of a confirmed buy. This deliberately reads the event,
 * sizing decision and immutable take-profit rule from the intent journal rather
 * than from a replayed feed row or today's environment. markAccounted commits the
 * intent transition and the full runtime snapshot in one SQLite transaction; S is
 * replaced only after that commit succeeds, so a disk error cannot double-count.
 */
function applyConfirmedEntry(intent) {
  if (intent?.state === "accounted") return false;
  if (intent?.kind !== "entry") throw new Error(`intent ${intent?.id || "?"} is not an entry`);
  const { input, output, networkFee } = confirmedAmounts(intent, "entry");
  const context = intent.context || {};
  const authoredEvent = context.event;
  const plan = context.plan;
  if (context.wallet && context.wallet !== WALLET)
    throw new Error(`entry intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== WSOL || intent.outputMint !== intent.mint)
    throw new Error(`entry intent ${intent.id} has an invalid durable mint route`);

  /* A finalized fill is custody reality, even if it was created by the older
   * runtime. Never let missing pre-upgrade Pyth/call metadata make that holding
   * disappear from the book or throw at the top of every future tick. New entries
   * prove the complete durable context; older/malformed contexts are represented as
   * an explicit exit-only quarantine with conservative placeholders. */
  let verified = null;
  const metadataIssues = [];
  try {
    verified = validateEntryPreflightContext(intent, {
      nowMs: Number(context.entryPreflight?.observedAt) || Date.now(),
      maxEntryPreflightAgeMs: JUPITER_CFG.maxEntryPreflightAgeMs,
      requireFresh: false,
    });
  } catch (error) {
    metadataIssues.push(`no provable independent SOL/USD entry basis: ${error.message}`);
  }
  const matchingEvent = authoredEvent &&
    String(authoredEvent.mint || "") === String(intent.mint) ? authoredEvent : null;
  const candidateCallId = Number(matchingEvent?.call_id);
  const hasExactCallId = Number.isSafeInteger(candidateCallId) && candidateCallId > 0;
  if (!hasExactCallId) metadataIssues.push("no exact durable call identity");
  if (!plan || plan.action !== "buy" || !Number.isFinite(Number(plan.sol)) || Number(plan.sol) <= 0 ||
      !Number.isFinite(Number(plan.f)) || Number(plan.f) < 0)
    metadataIssues.push("no complete durable sizing context");

  const rule = context.takeProfitRule || {};
  const durableTakeProfitX = Number(rule.takeProfitX);
  if (!Number.isFinite(durableTakeProfitX) || durableTakeProfitX <= 0 ||
      typeof rule.honorDeskTarget !== "boolean")
    metadataIssues.push("no durable take-profit rule");
  const entryReference = context.entryReference;
  if (!entryReference || !(Number(entryReference.stopRatio) > 0) ||
      Number(entryReference.stopRatio) >= 1 ||
      (entryReference.targetRatio != null && !(Number(entryReference.targetRatio) > 0)))
    metadataIssues.push("no valid durable market reference");
  const oracleVerified = Boolean(verified);
  const independentlyVerified = oracleVerified && metadataIssues.length === 0;

  const costBasisLamports = BigInt(input) + BigInt(networkFee);
  const paidSol = Number(costBasisLamports) / LAMPORTS;
  const existing = S.positions[intent.mint];
  if (existing) {
    if (existing.entryIntentId !== intent.id || String(existing.qtyRaw) !== output ||
        String(existing.costBasisLamports) !== costBasisLamports.toString() ||
        (hasExactCallId && Number(existing.callId) !== candidateCallId) ||
        (independentlyVerified && existing.solUsdSource !== PYTH_SOL_USD_CACHE_SOURCE) ||
        (!independentlyVerified && existing.accountingIncomplete !== true) ||
        Math.abs(Number(existing.paidSol) - paidSol) > 1e-12)
      throw new Error(`entry intent ${intent.id} conflicts with the recorded position`);
    const next = structuredClone(S);
    journal.markAccounted(intent.id, next);
    S = next;
    return true;
  }

  const takeProfitX = Number.isFinite(durableTakeProfitX) && durableTakeProfitX > 0
    ? durableTakeProfitX : Math.max(1, Number(CFG.takeProfitX) || 2);
  const honorDeskTarget = typeof rule.honorDeskTarget === "boolean" ? rule.honorDeskTarget : false;
  const stopBufferPct = Number(context.positionConfig?.stopBufferPct);
  const stopRatio = Number(entryReference?.stopRatio) > 0 && Number(entryReference.stopRatio) < 1
    ? Number(entryReference.stopRatio) : 0.01;
  const targetRatio = Number(entryReference?.targetRatio) > 0
    ? Number(entryReference.targetRatio) : null;
  const event = matchingEvent || {
    mint: intent.mint,
    symbol: String(authoredEvent?.symbol || intent.mint.slice(0, 6)),
    ts: Number(context.openedAtMs || intent.confirmedAt || intent.createdAt || Date.now()),
  };
  const pos = openPosition({
    call: {
      ...event,
      mint: intent.mint,
      stop: stopRatio,
      target: targetRatio,
    },
    sol: paidSol,
    fillPrice: 1,
    cfg: { stopBufferPct: Number.isFinite(stopBufferPct) ? stopBufferPct : CFG.stopBufferPct },
  });
  pos.qtyRaw = output;
  pos.paidSol = paidSol;
  pos.costBasisLamports = costBasisLamports.toString();
  pos.entryInputLamports = input;
  pos.riskF = Number.isFinite(Number(plan?.f)) && Number(plan.f) >= 0 ? Number(plan.f) : 0;
  const durableOpenedAt = Number(context.openedAtMs ?? intent.createdAt);
  pos.openedAtMs = Number.isFinite(durableOpenedAt) && durableOpenedAt > 0
    ? durableOpenedAt : Date.now();
  pos.entryIntentId = intent.id;
  if (hasExactCallId) pos.callId = candidateCallId;
  else {
    pos.callIdentityIncomplete = true;
    pos.callIdentityIncompleteReason =
      "landed legacy entry has no provable originating call_id; new entries remain blocked until it closes";
    pos.callIdentityPolicy = LEGACY_CALL_IDENTITY_POLICY;
  }
  pos.takeProfitX = takeProfitX;
  pos.honorDeskTarget = honorDeskTarget;
  if (Number(entryReference?.marketMark) > 0)
    pos.marketMarkAtEntry = Number(entryReference.marketMark);
  if (Number(entryReference?.marketMarkAt) > 0)
    pos.marketMarkObservedAt = Number(entryReference.marketMarkAt);
  const solUsdAtEntry = Number(context.entryPreflight?.solUsd);
  pos.solUsdAtEntry = Number.isFinite(solUsdAtEntry) && solUsdAtEntry > 0 ? solUsdAtEntry : 1;
  // Preserve truthful oracle provenance even when some other strategy metadata is
  // incomplete. accountingIncomplete, not a false source label, is what disarms all
  // automatic price policy for the exit-only quarantine.
  pos.solUsdSource = oracleVerified ? PYTH_SOL_USD_CACHE_SOURCE : "legacy-unverified";
  if (!independentlyVerified) {
    pos.accountingIncomplete = true;
    pos.accountingIncompleteReason =
      `landed entry has incomplete durable non-custody metadata: ` +
      `${metadataIssues.join("; ") || "durable provenance unavailable"}; ` +
      "automatic price exits are quarantined";
  }

  // An exit can arrive while this exact buy is signed/submitted/ambiguous but not
  // yet a position. The feed cursor is allowed to drain past that exit only because
  // the journal kept it. Attach the latch in the SAME transaction that accounts the
  // buy, so a crash cannot create a position that forgot the desk had already left.
  const deferredExit = journal.deferredDeskExitForEntry(intent.id);
  if (deferredExit) {
    if (deferredExit.mint !== intent.mint ||
        (hasExactCallId && Number(deferredExit.callId) !== candidateCallId))
      throw new Error(`deferred desk exit for ${intent.id} does not match the confirmed entry`);
    pos.exitExecutionRequired = true;
    pos.exitExecutionReason = deferredExit.reason;
    pos.exitExecutionIntentId = `desk-exit:${deferredExit.eventId}`;
    pos.exitExecutionObservedAt = deferredExit.observedAt;
  }

  const next = recoveryRuntime(independentlyVerified ? context : null);
  next.positions[intent.mint] = pos;
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next, { consumeDeferredDeskExit: Boolean(deferredExit) });
  S = next;
  log(`${independentlyVerified ? "BOUGHT" : "RECOVERED + QUARANTINED"} ` +
    `${event.symbol || intent.mint.slice(0, 6)} — ${paidSol.toFixed(6)} SOL → ${output} raw — ` +
    `https://solscan.io/tx/${intent.signature}`);
  return true;
}

/** Apply a confirmed sell from its pre-submit position snapshot, never a balance read. */
function applyConfirmedExit(intent) {
  if (intent?.state === "accounted") return false;
  if (!intent || !["desk_exit", "risk_exit"].includes(intent.kind))
    throw new Error(`intent ${intent?.id || "?"} is not an exit`);
  const { input, output, networkFee } = confirmedAmounts(intent, "exit");
  if (intent.context?.wallet && intent.context.wallet !== WALLET)
    throw new Error(`exit intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== intent.mint || intent.outputMint !== WSOL)
    throw new Error(`exit intent ${intent.id} has an invalid durable mint route`);
  const before = intent.context?.position;
  if (!before || String(before.mint || "") !== String(intent.mint))
    throw new Error(`exit intent ${intent.id} has no matching durable position context`);
  const beforeRaw = BigInt(String(before.qtyRaw || "0"));
  const soldRaw = BigInt(input);
  if (beforeRaw <= 0n || soldRaw > beforeRaw)
    throw new Error(`exit intent ${intent.id} fill exceeds its durable position`);
  const current = S.positions[intent.mint];
  if (current && (String(current.qtyRaw) !== String(before.qtyRaw) ||
      (before.entryIntentId && current.entryIntentId !== before.entryIntentId)))
    throw new Error(`exit intent ${intent.id} conflicts with the recorded position`);

  const basisBeforeRaw = BigInt(String(before.costBasisLamports || "0"));
  if (basisBeforeRaw <= 0n) throw new Error(`exit intent ${intent.id} has invalid durable cost basis`);
  const paidPortionRaw = soldRaw >= beforeRaw ? basisBeforeRaw : basisBeforeRaw * soldRaw / beforeRaw;
  const netProceedsRaw = BigInt(output) - BigInt(networkFee);
  const netRaw = netProceedsRaw - paidPortionRaw;
  const outSol = Number(netProceedsRaw) / LAMPORTS;
  const net = Number(netRaw) / LAMPORTS;
  const fraction = Number(intent.context?.fraction ?? 1);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error(`exit intent ${intent.id} has invalid durable sell fraction`);
  const fullExit = fraction >= 1 || soldRaw >= beforeRaw;
  const next = recoveryRuntime(intent.context);
  if (fullExit) {
    delete next.positions[intent.mint];
    if (net >= 0) next.state.wins = (Number(next.state.wins) || 0) + 1;
    else next.state.losses = (Number(next.state.losses) || 0) + 1;
  } else {
    next.positions[intent.mint] = {
      ...structuredClone(before),
      qtyRaw: String(beforeRaw - soldRaw),
      costBasisLamports: String(basisBeforeRaw - paidPortionRaw),
      paidSol: Number(basisBeforeRaw - paidPortionRaw) / LAMPORTS,
      entryInputLamports: String(BigInt(before.entryInputLamports) -
        (soldRaw >= beforeRaw ? BigInt(before.entryInputLamports) :
          BigInt(before.entryInputLamports) * soldRaw / beforeRaw)),
    };
  }
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next);
  S = next;
  const symbol = before.symbol || intent.mint.slice(0, 6);
  log(`${fullExit ? "SOLD" : "SCALED"} ${symbol} for ${outSol.toFixed(6)} SOL` +
    `${fullExit ? ` (${net >= 0 ? "+" : ""}${net.toFixed(6)})` : ""} — https://solscan.io/tx/${intent.signature}`);
  return true;
}

function accountConfirmedIntents() {
  let count = 0;
  for (const intent of journal.pendingIntents()) {
    if (intent.state !== "confirmed") continue;
    try {
      if (intent.kind === "entry") applyConfirmedEntry(intent);
      else if (["desk_exit", "risk_exit"].includes(intent.kind)) applyConfirmedExit(intent);
      else throw new Error(`confirmed intent ${intent.id} has unsupported kind ${intent.kind}`);
      count++;
    } catch (error) {
      // One damaged accounting row must remain visible and block new exposure, but
      // it may never starve stop/desk-exit handling for every unrelated holding.
      // The confirmed state is deliberately retained for monitor/operator repair.
      log(`ACCOUNTING QUARANTINE ${intent.id}: ${error.message} — ` +
        "intent remains confirmed; unrelated position protection continues");
    }
  }
  return count;
}

async function onEntry(ev) {
  const intentId = `entry:${ev.event_id || `${FLOOR}:${ev.id}`}`;
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedEntry(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`ENTRY ${ev.symbol} already accounted`);
  validEntryEvent(ev);
  if (S.positions[ev.mint]) return log(`SKIP ${ev.symbol}: already holding`);
  const unresolvedPosition = openList().find((position) => positionEntryBlock(position));
  if (unresolvedPosition)
    return log(`SKIP ${ev.symbol}: ${unresolvedPosition.symbol} blocks new exposure — ${positionEntryBlock(unresolvedPosition)}`);
  const age = Date.now() - Number(ev.ts);
  if (age > MAX_CALL_AGE_MS)
    return log(`SKIP ${ev.symbol}: call is ${Math.round(age / 60_000)}m old (max ${MAX_CALL_AGE_MS / 60_000}m)`);
  if (feedRollbackActive())
    return log(`SKIP ${ev.symbol}: authenticated feed latest_id rolled behind durable cursor — entries frozen`);
  if (pauseEntries()) return log(`SKIP ${ev.symbol}: PAUSE ENTRIES file is present`);
  if (hardStop()) return log(`SKIP ${ev.symbol}: HARD STOP file is present`);
  const history = journal.riskHistoryStatus(Date.now());
  if (!history.complete)
    return log(`SKIP ${ev.symbol}: rolling risk history is quarantined until ${new Date(history.incompleteUntil).toISOString()}`);

  Object.assign(S.state, journal.rollingRisk(Date.now()));
  S.state.openCount = openList().length;
  S.state.spendableSol = EXECUTE ? Math.max(0, (await solBalance()) - FEE_RESERVE) : null;
  S.state.equitySol = EXECUTE ? await solBalance() : (S.state.equitySol ?? CFG.dailySolCap);
  S.state.bookHeat = openList().reduce((sum, pos) => sum + (pos.riskF || 0), 0);

  const entryReference = validateEntryReference(ev, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  });

  const takeProfitRule = resolveTakeProfitRule(ev.take_profit_x, CFG.takeProfitX);
  const fixed = Number(ev.fixed_sol) > 0 ? Math.min(Number(ev.fixed_sol), CFG.maxSolPerTrade) : CFG.fixedSol;
  const perCall = { ...CFG, ...takeProfitRule, fixedSol: fixed,
    networkFeeReserveSol: EXECUTE ? jupiter.cfg.maxNetworkFeeLamports / LAMPORTS : 0 };
  const normalizedCall = { ...ev, entry_ref: 1, stop: entryReference.stopRatio,
    target: entryReference.targetRatio };
  let plan = planEntry({ call: normalizedCall, cfg: perCall, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol}: ${plan.reason}`);

  if (!EXECUTE) {
    log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
    return log("PAPER — no transaction signed");
  }
  if (!jupiter) throw new Error("Jupiter client is unavailable");

  /* CC_TOKEN_2022=0 is the rollback switch, and it belongs HERE: it stops new
   * Token-2022 entries without touching a held position. Inside the shared mint audit
   * it would also refuse to read the balance of a coin already owned, which blocks that
   * position's stop and, because a blocked position gates the entry queue, every
   * classic entry too. */
  if (!token2022Enabled() && (await mintProgramFor(ev.mint)) === TOKEN_2022_PROGRAM)
    throw new Error("CC_TOKEN_2022=0 keeps this executor on classic SPL Token mints");
  const preliminaryAmountRaw = BigInt(Math.floor(plan.sol * LAMPORTS));
  const [preflight, tokenDecimals, solUsdOracle] = await Promise.all([
    jupiter.preflightEntry(WSOL, ev.mint, preliminaryAmountRaw.toString()),
    independentClassicMintDecimals(conn, secondaryConn, ev.mint),
    independentSolUsdPrice(conn, secondaryConn),
  ]);
  entryEventSubmissionGate({ kind: "entry", context: { event: ev } });
  const executableReturnRatio = Number(BigInt(preflight.reverse.outAmount) * 1_000_000n /
    preliminaryAmountRaw) / 1_000_000;
  const worstFeeRatio = 2 * jupiter.cfg.maxNetworkFeeLamports / Number(preliminaryAmountRaw);
  const slippageHaircut = (1 - jupiter.cfg.slippageBps / 10_000) ** 2;
  const conservativeReturnRatio = executableReturnRatio * slippageHaircut - worstFeeRatio;
  if (conservativeReturnRatio <= entryReference.stopRatio)
    /* Say the NUMBERS, not just the verdict. Four consecutive refusals on this line
     * told us nothing about which side was wrong: a desk authoring stops too tight
     * for a coin's real liquidity, or a reconstruction too pessimistic to ever pass.
     * "It keeps refusing" is not actionable; a measured round trip against a stop
     * ratio is. */
    throw new Error(`entry round trip plus worst-case fees is already at/below the authored stop ` +
      `(measured round trip ${Number(preflight.lossPct ?? 0).toFixed(2)}% → executable ${(executableReturnRatio * 100).toFixed(2)}%; ` +
      `slippage haircut ${((1 - slippageHaircut) * 100).toFixed(2)}%, worst-case fees ${(worstFeeRatio * 100).toFixed(2)}%; ` +
      `conservative return ${(conservativeReturnRatio * 100).toFixed(2)}% vs stop at ${(entryReference.stopRatio * 100).toFixed(2)}% of entry)`);
  const conservativeLossPct = Math.max(preflight.lossPct, (1 - conservativeReturnRatio) * 100);
  plan = planEntry({ call: normalizedCall,
    cfg: { ...perCall, measuredRoundTripLossPct: conservativeLossPct }, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol} after executable-cost check: ${plan.reason}`);
  const amountRaw = BigInt(Math.floor(plan.sol * LAMPORTS));
  log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
  const openedAtMs = Date.now();
  const intentContext = {
    event: ev, plan, takeProfitRule, openedAtMs, entryReference,
    entryPreflight: {
      inputAmountRaw: preliminaryAmountRaw.toString(),
      forwardOutputRaw: String(preflight.forward.outAmount),
      reverseOutputRaw: String(preflight.reverse.outAmount),
      roundTripLossPct: preflight.lossPct,
      // Never let the swap counterparty author its own USD fairness anchor.
      // Pyth is read through both independent Solana RPC providers and its
      // verification, feed id, confidence, freshness and consensus are checked.
      solUsd: solUsdOracle.price,
      solUsdSource: solUsdOracle.source,
      solUsdPublishTime: solUsdOracle.publishTime,
      solUsdConfidencePct: solUsdOracle.confidencePct,
      solUsdProviderDivergencePct: solUsdOracle.divergencePct,
      tokenDecimals,
      observedAt: solUsdOracle.observedAt,
    },
    positionConfig: { stopBufferPct: perCall.stopBufferPct },
    riskStateBefore: structuredClone(S.state),
  };
  // Apply the exact same complete gate used by restart recovery before an intent is
  // even journaled. The executor checks it again after final simulation and before
  // signing, and once more before any recovered signed bytes could be disclosed.
  entrySubmissionGate({ kind: "entry", amountRaw: amountRaw.toString(), context: intentContext });
  const fill = await jupiter.executeIntent({
    id: intentId,
    kind: "entry",
    eventId: ev.event_id || null,
    feedId: ev.id,
    mint: ev.mint,
    inputMint: WSOL,
    outputMint: ev.mint,
    amountRaw: amountRaw.toString(),
    context: intentContext,
  });
  applyConfirmedEntry(fill);
}

async function sellAll(pos, why, fraction = 1, suppliedIntentId = null, trigger = null) {
  const intentId = suppliedIntentId || `risk-exit:${pos.entryIntentId || `${pos.mint}:${pos.openedAtMs || pos.openedAt}`}`;
  latchExit(pos, why, intentId, trigger);
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedExit(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`EXIT ${pos.symbol} already accounted`);
  if (["signed", "submitted", "ambiguous"].includes(existingIntent?.state))
    return log(`EXIT ${pos.symbol} remains durably latched — ${existingIntent.state} attempt is ` +
      "handled by bounded recovery without blocking other position checks");
  if (!EXECUTE) return log(`PAPER EXIT ${pos.symbol} — ${why} — position retained; no transaction sent`);
  if (hardStop()) throw new Error("HARD STOP is present — automated exits are blocked; manage the wallet manually");

  const tracked = BigInt(pos.qtyRaw || 0);
  const balance = await inspectTrackedBalance(pos);
  if (!balance.verified) {
    persistBalanceBlock(pos, balance);
    return log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — durable position retained; manual reconciliation required`);
  }
  clearBalanceBlock(pos);
  const amount = fraction >= 1 ? tracked :
    (tracked * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (amount <= 0n) throw new Error(`${pos.symbol} durable exit amount rounded to zero`);
  log(`EXIT ${pos.symbol} — ${why}`);
  const fill = await jupiter.executeIntent({
    id: intentId,
    kind: suppliedIntentId?.startsWith("desk-exit:") ? "desk_exit" : "risk_exit",
    eventId: suppliedIntentId?.startsWith("desk-exit:") ? suppliedIntentId.slice(10) : null,
    mint: pos.mint,
    inputMint: pos.mint,
    outputMint: WSOL,
    amountRaw: amount.toString(),
    context: {
      position: structuredClone(pos), why, fraction,
      trigger: trigger ? structuredClone(trigger) : null,
      riskStateBefore: structuredClone(S.state),
    },
  });
  applyConfirmedExit(fill);
}

/** Execute an exit for a held position, or durably defer it for the exact buy that
 * is already beyond the no-return signing boundary but has not accounted yet. */
async function handleDeskExitEvent(ev) {
  try { new PublicKey(ev?.mint); }
  catch { throw new Error("invalid Solana mint in desk exit event"); }
  requirePositiveCallId(ev?.call_id, "desk exit call_id");
  const eventId = ev.event_id || `${FLOOR}:${ev.id}`;
  const reason = `desk exit (${ev.code || "exit"})`;
  const pos = S.positions[ev.mint];
  if (pos) {
    const decision = deskExitDecisionForPosition(pos, ev);
    if (decision.action === "ignore") {
      log(`EXIT ${ev.symbol || ev.mint}: call ${decision.callId} does not match held call ${decision.positionCallId}`);
      return "different-call";
    }
    if (decision.reason === "legacy-risk-reduction")
      log(`EXIT ${ev.symbol || ev.mint}: legacy call identity is unprovable — taking the risk-reducing same-mint exit`);
    await sellAll(pos, reason, 1, `desk-exit:${eventId}`);
    return "position";
  }
  const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
  if (!entry) return "not-held";
  journal.deferDeskExitForEntry({
    entryIntentId: entry.id, eventId, feedId: ev.id, callId: ev.call_id,
    mint: ev.mint, reason, observedAt: Date.now(),
  });
  log(`EXIT ${ev.symbol || ev.mint}: durably deferred until unresolved entry ${entry.id} is accounted`);
  return "deferred";
}

async function manageOpen() {
  let currentSolUsd = null;
  let solUsdObservation = null;
  let solUsdError = null;
  if (EXECUTE && openList().length) {
    try {
      solUsdObservation = await independentSolUsdPrice(conn, secondaryConn);
      currentSolUsd = solUsdObservation.price;
    }
    catch (error) { solUsdError = error; }
  }

  /* ONE DENOMINATOR OUTAGE MUST NOT DISARM EVERY STOP.
   * The SOL/USD leg is fetched once per tick; when it failed, the code discarded the
   * token→WSOL quote it ALREADY HELD for every position and left mark=null, which
   * pricePolicy treats as "hold". So during a Pyth push or RPC-consensus outage —
   * precisely when rugs cluster — stops, trails and take-profits were all silently off for
   * every open position at once, and the only backstop was the 12h age exit selling
   * the remnant. SOL/USD moves single-digit percent in hours while these stops care
   * about 20%+ token moves, so a cached rate is overwhelmingly better than no stop.
   * The cache is used for up to SOL_USD_CACHE_MAX_AGE_MS with the staleness logged;
   * past that, the old fail-closed hold applies.
   *
   * The window was 24h and the re-review caught why that is too generous: in a
   * combined SOL crash + quote-route outage, a day-old rate misprices every mark by
   * SOL's full daily move — which can be 20%+, the size of the very moves the stops
   * exist to catch. Thirty minutes still covers the routine outage while bounding
  * the mispricing to SOL's half-hour drift, normally low single digits. */
  if (currentSolUsd > 0) {
    S.solUsdCache = {
      v: currentSolUsd,
      ts: solUsdObservation.observedAt,
      publishTime: solUsdObservation.publishTime,
      source: PYTH_SOL_USD_CACHE_SOURCE,
    };
    /* The cache must survive a restart, because restarts CORRELATE with the outages
     * it exists for — a deploy, crash or box reboot during quote-route chaos is the
     * normal case, not the unlucky one. It lived only on the in-memory S, which
     * saveRuntime does not persist, so the first tick after any mid-outage restart
     * silently re-disarmed every stop the cache was built to keep armed. Durable
     * meta, best-effort: a failed write must never fail a tick. */
    try { journal.setMeta("sol_usd_cache", JSON.stringify(S.solUsdCache)); } catch {}
  } else if (solUsdError || !(currentSolUsd > 0)) {
    if (!S.solUsdCache) {
      try { const m = journal.getMeta("sol_usd_cache"); if (m) S.solUsdCache = JSON.parse(m); } catch {}
    }
    const cache = S.solUsdCache;
    // Never inherit a cache written by the old circular Jupiter SOL/USDC anchor, or
    // a Pyth cache without its immutable publish time. Both the local observation
    // and the oracle publication must remain inside the startup-validated window.
    const usableCache = usableSolUsdCache(cache, {
      nowMs: Date.now(), maxAgeMs: SOL_USD_CACHE_MAX_AGE_MS,
    });
    if (usableCache) {
      currentSolUsd = usableCache.price;
      solUsdError = null;
      log(`independent SOL/USD oracle failed — using the cached Pyth rate $${usableCache.price} ` +
        `published ${Math.round(usableCache.publishAgeMs / 60_000)}m ago so stops stay armed`);
    }
  }

  /* Iterate by KEY and re-resolve each position from the live state. The loop used to
   * hold the array snapshot: any exit inside it swaps S for a structuredClone
   * (applyConfirmedExit), leaving every later `pos` a detached object — trail
   * ratchets written to it were silently dropped by save(), and the custody
   * entry-block flag set on it never reached the state the entry gate reads. */
  for (const posKey of openList().map((p) => p.mint)) {
    const pos = openList().find((p) => p.mint === posKey);
    if (!pos) continue;                            // exited earlier in this same pass
    try {
      if (EXECUTE) {
        const wasBlocked = pos.balanceReconciliationRequired;
        const balance = await inspectTrackedBalance(pos);
        if (!balance.verified) {
          persistBalanceBlock(pos, balance);
          log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — position management remains disarmed`);
          continue;
        }
        clearBalanceBlock(pos);
        save();
        if (wasBlocked) log(`${pos.symbol}: full canonical-ATA balance verified again — custody gate re-armed`);
      }
      // A previously latched stop/rug/desk exit outranks fresh market-data work.
      // Retrying it first prevents an order-service outage from delaying an exit
      // whose decision has already crossed the durable execution boundary.
      if (pos.exitExecutionRequired) {
        await sellAll(pos, pos.exitExecutionReason || "required risk exit", 1,
          pos.exitExecutionIntentId || null, pos.exitExecutionTrigger || null);
        continue;
      }
      if (pos.accountingIncomplete) {
        // A quarantined legacy basis disarms price-derived policy, not an explicit
        // desk/rug exit already durably latched for risk reduction.
        log(`${pos.symbol}: legacy accounting/SOL-USD basis is incomplete — ` +
          "automatic price exits remain disarmed; explicit same-mint desk exits remain enabled");
        continue;
      }
      let mark = null;
      if (jupiter && pos.qtyRaw && BigInt(pos.qtyRaw) > 0n) {
        try {
          if (solUsdError || !(currentSolUsd > 0))
            throw new Error(`independent SOL/USD mark unavailable: ${solUsdError?.message || "no usable Pyth cache"}`);
          const observation = await jupiter.preflightExitMark({
            mint: pos.mint, amountRaw: pos.qtyRaw, position: pos,
          });
          mark = executableExitMark(pos, observation.actualOutputRaw, currentSolUsd);
          clearExitMarkFailureWitness(pos);
          delete pos.riskDataUnavailable;
          delete pos.riskDataUnavailableReason;
          delete pos.riskDataUnavailableAt;
          save();
        }
        catch (error) {
          pos.riskDataUnavailable = true;
          pos.riskDataUnavailableReason = `independent executable exit mark unavailable: ${error.message}`;
          pos.riskDataUnavailableAt = Date.now();
          const witness = confirmExitMarkFailureWitness(pos, {
            observedAt: pos.riskDataUnavailableAt, reason: pos.riskDataUnavailableReason,
          }, { maxGapMs: Math.max(60_000, POLL_MS * 4) });
          save();
          if (!witness.confirmed) {
            log(`mark ${pos.symbol}: ${error.message} — new entries blocked; ` +
              "waiting for one independent next-tick failure witness before risk reduction");
          } else {
            log(`mark ${pos.symbol}: executable mark failed on two consecutive ticks — ` +
              "latching a risk-reducing exit so the order service cannot suppress a stop");
            await sellAll(pos, "independent executable exit mark unavailable on two consecutive ticks",
              1, null, witness.trigger);
            continue;
          }
        }
      }
      const decision = stepPosition({ pos, mark, deskExit: null, cfg: policyConfigForPosition(pos, CFG) });
      if (decision.action === "sell") {
        const trigger = priceExitTrigger(pos, decision, mark, currentSolUsd, Date.now());
        const witness = confirmPriceExitWitness(pos, trigger, { maxGapMs: Math.max(60_000, POLL_MS * 4) });
        if (!witness.confirmed) {
          save();
          log(`${pos.symbol}: ${decision.reason} observed once — waiting for an independent next-tick witness`);
          continue;
        }
        await sellAll(pos, decision.reason, 1, null, witness.trigger);
      }
      else if (decision.action === "sell_part") await sellAll(pos, decision.reason, decision.fraction);
      else { clearPriceExitWitness(pos); save(); }
    } catch (error) {
      // A sellAll above may have swapped S for a clone; write the failure onto the
      // LIVE object or the flags evaporate with the detached one.
      const live = openList().find((p) => p.mint === posKey);
      const pos = live ?? { symbol: posKey };
      if (!live) { log(`manage ${pos.symbol}: ${error.message} — position left the book mid-pass`); continue; }
      if (pos.exitExecutionRequired) {
        if (error?.code === "EXIT_TRIGGER_NOT_MET") {
          clearExitLatch(pos);
          clearPriceExitWitness(pos);
          save();
          log(`EXIT CANCELLED ${pos.symbol}: ${error.message} — price trigger must earn two fresh witnesses again`);
          continue;
        }
        pos.exitExecutionLastError = error.message;
        pos.exitExecutionLastAttemptAt = Date.now();
        if (/price impact .* exceeds cap/i.test(error.message)) {
          pos.manualExitRequired = true;
          pos.manualExitReason = error.message;
          pos.manualExitObservedAt = Date.now();
        }
        save();
        log(`EXIT BLOCKED ${pos.symbol}: ${error.message} — fired exit remains latched; new entries blocked`);
      } else {
        pos.riskDataUnavailable = true;
        pos.riskDataUnavailableReason = `position management failed: ${error.message}`;
        pos.riskDataUnavailableAt = Date.now();
        save();
        log(`manage ${pos.symbol}: ${error.message} — new entries blocked`);
      }
    }
  }
}

let ticking = false;
/* Self-reported liveness for the floor's bot card. Outbound-only, same read-only
 * secret as the feed, fire-and-forget: a dead site must never delay a stop check,
 * so failures are silent and nothing awaits it in the trade path. It carries no
 * secret and opens no control channel — the server learns the bot's pulse, not its
 * reins. Throttled to once a minute. */
let lastHeartbeatAt = 0;
const runtimeHealth = {
  lastTickStartedAt: 0, lastTickCompletedAt: 0, lastFeedSuccessAt: 0,
  consecutiveFeedFailures: 0, consecutiveTickFailures: 0,
  executionReadiness: EXECUTE ? {
    ready: false, lastSuccessAt: 0, observedAt: 0, route: "wsol-usdc", providers: 0,
    amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS),
  } : null,
};
let readinessProbeInFlight = false;
let lastReadinessProbeAt = 0;
let lastReadinessError = null;
function maybeProbeExecutionReadiness() {
  if (!EXECUTE || !jupiter || readinessProbeInFlight ||
      Date.now() - lastReadinessProbeAt < 2 * 60_000) return;
  lastReadinessProbeAt = Date.now();
  readinessProbeInFlight = true;
  Promise.resolve(jupiter.probeExecutionReadiness({
    amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS),
  })).then((result) => {
    const succeededAt = Date.now();
    if (result?.ready === true && lastReadinessError !== null) {
      lastReadinessError = null;
      log(`READINESS proved: ${result.route} at ${CFG.maxSolPerTrade} SOL on ${result.providers} providers, nothing signed`);
    }
    runtimeHealth.executionReadiness = {
      ready: result?.ready === true,
      lastSuccessAt: result?.ready === true ? succeededAt : 0,
      observedAt: Number(result?.observedAt) || succeededAt,
      route: result?.route === "wsol-usdc" ? "wsol-usdc" : null,
      providers: Number(result?.providers) === 2 ? 2 : 0,
      amountLamports: Number(result?.amountLamports) || 0,
    };
  }).catch((error) => {
    /* SAY WHY IT IS NOT READY.
     *
     * This catch was empty, so a failing probe set providers to 0 and wrote nothing
     * anywhere. An operator watching "READINESS PROVIDERS 0/2" could not tell whether
     * the probe had never run, could not reach a provider, or had run and been refused
     * — and the commonest cause by far is simply an unfunded wallet, which the message
     * names outright. A refusal that cannot be read is the same defect as a refusal
     * that never happened. Repeats are collapsed so a persistent cause logs once. */
    const reason = String(error?.message || error).slice(0, 300);
    if (reason !== lastReadinessError) {
      lastReadinessError = reason;
      const need = Math.floor(CFG.maxSolPerTrade * LAMPORTS) +
        Number(jupiter.cfg.maxNetworkFeeLamports ?? 500_000) +
        Number(jupiter.cfg.maxRentLamports ?? 4_200_000) + 10_000_000;
      log(`READINESS not proved (${EXECUTION_READINESS_ROUTE} at ${CFG.maxSolPerTrade} SOL): ${reason}` +
        ` — this no-sign rehearsal needs about ${(need / LAMPORTS).toFixed(4)} SOL in the wallet ` +
        "(the trade size, the network-fee ceiling, two ATAs of rent and an untouched reserve)");
    }
    runtimeHealth.executionReadiness = {
      ready: false,
      lastSuccessAt: Number(runtimeHealth.executionReadiness?.lastSuccessAt) || 0,
      observedAt: Date.now(), route: "wsol-usdc", providers: 0,
      amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS),
      lastError: reason,
    };
  }).finally(() => { readinessProbeInFlight = false; });
}
const noteFeedFailure = () => { runtimeHealth.consecutiveFeedFailures++; };
const noteFeedSuccess = () => {
  runtimeHealth.lastFeedSuccessAt = Date.now();
  runtimeHealth.consecutiveFeedFailures = 0;
};
function sendHeartbeat() {
  if (Date.now() - lastHeartbeatAt < 60_000) return;
  lastHeartbeatAt = Date.now();
  let health;
  try {
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(),
      blockingIntent: Boolean(journal.hasBlockingIntent()), positions: openList(),
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures,
      feedRollback: feedRollbackActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps: {
        maxSolPerTrade: CFG.maxSolPerTrade,
        dailySolCap: CFG.dailySolCap,
        dailyLossLimitSol: CFG.dailyLossLimitSol,
        maxOpenPositions: CFG.maxOpenPositions,
      },
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  } catch {
    // Telemetry can lose detail; it can never stop the trading/reconciliation loop.
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(), blockingIntent: true,
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures + 1,
      feedRollback: feedRollbackActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps: {
        maxSolPerTrade: CFG.maxSolPerTrade,
        dailySolCap: CFG.dailySolCap,
        dailyLossLimitSol: CFG.dailyLossLimitSol,
        maxOpenPositions: CFG.maxOpenPositions,
      },
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  }
  fetch(`${API}/api/floor/${FLOOR}/executor/heartbeat`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      mode: EXECUTE ? "live" : "paper",
      wallet: WALLET,
      cursor: S.cursor,
      open: openList().length,
      // WHICH coins, not just how many — the call cards need to say "your bot is in
      // THIS one" rather than leaving a tenant to infer it from a count. Mint and
      // size only: no prices, no PnL, nothing the server could use against the
      // operator, and still nothing it can act on.
      held: openList().slice(0, 20).map((p) => ({
        mint: p.mint,
        sol: Number((Number(p.entryInputLamports || 0) / LAMPORTS).toFixed(4)),
        openedAt: Number(p.openedAtMs) || 0,
      })),
      health,
      ts: Date.now(),
    }),
  }).catch(() => {});
}

/* Recovery is never allowed to sit unbounded in front of fresh position safety.
 * At most one exit-first intent is probed before manageOpen, and the tick waits no
 * more than one second for that observation-only pass. The promise keeps its
 * in-process intent scope if the RPC is slower, so continuing cannot duplicate a
 * submission. A full identical-byte retry is scheduled only after the tick's risk,
 * feed and heartbeat work has completed, and never overlaps another recovery pass. */
let recoveryPassInFlight = null;
const startRecoveryPass = (options) => {
  if (!EXECUTE || !jupiter || recoveryPassInFlight) return recoveryPassInFlight;
  const pass = Promise.resolve(jupiter.recoverPending(options))
    .catch((error) => log(`bounded recovery pass: ${error.message}`))
    .finally(() => { if (recoveryPassInFlight === pass) recoveryPassInFlight = null; });
  recoveryPassInFlight = pass;
  return pass;
};
async function boundedRecoveryBeforeRisk() {
  if (!EXECUTE) return;
  const pass = recoveryPassInFlight || startRecoveryPass({ observationOnly: true, maxIntents: 1 });
  if (!pass) return;
  await waitForRecoveryBudget(pass,
    Math.min(1_000, Math.max(100, Math.floor(POLL_MS / 4))));
}
const scheduleBackgroundRecovery = () => {
  if (!EXECUTE || recoveryPassInFlight) return;
  startRecoveryPass({ maxIntents: 1 });
};

async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  runtimeHealth.lastTickStartedAt = Date.now();
  let tickFailed = false;
  try {
    await boundedRecoveryBeforeRisk();
    accountConfirmedIntents();
    // Existing risk outranks new opportunity. A stop, age exit, balance ambiguity, or
    // emergency-impact block must update the durable book before an entry from this
    // feed tick can pass sizing and loss gates.
    await manageOpen();
    try {
      const response = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`, {
        headers: { authorization: `Bearer ${SECRET}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        noteFeedFailure();
        log("feed authentication rejected — check CC_SECRET / CC_FLOOR");
      } else if (!response.ok) {
        noteFeedFailure();
        log(`feed HTTP ${response.status}`);
      }
      else {
        const payload = await response.json();
        if (payload.cluster !== "mainnet-beta") throw new Error("feed cluster is not mainnet-beta");
        if (!Array.isArray(payload.events)) throw new Error("feed omitted its events array");
        const events = payload.events;
        /* Say why a call was NOT offered. An empty feed is indistinguishable from a
         * desk that published nothing, and today it hid two published calls the floor
         * had declined. The feed now carries the floor's recent verdicts; log each
         * new refusal once. Pure observability — nothing here changes a decision. */
        if (Array.isArray(payload.decisions)) {
          for (const d of [...payload.decisions].reverse()) {
            const at = Number(d?.delivered_at) || 0;
            if (at <= lastDecisionSeen || d?.verdict === "offered") continue;
            log(`NOT OFFERED ${d?.symbol || d?.call_id}: ${d?.reason || d?.verdict}`);
          }
          lastDecisionSeen = Math.max(lastDecisionSeen,
            ...payload.decisions.map((d) => Number(d?.delivered_at) || 0));
        }
        const feedCursor = authenticatedFeedCursorState(S.cursor, payload.latest_id);
        const latestId = feedCursor.latestId;
        if (feedCursor.rollback) {
          persistFeedRollback(latestId);
          noteFeedFailure();
          log(`CRITICAL FEED ROLLBACK: authenticated latest_id ${latestId} is behind durable cursor ` +
            `${S.cursor} — entries remain frozen; local position/risk exits continue`);
          return;
        }
        const returnedIds = events.map((event) => Number(event?.id));
        let previousId = S.cursor;
        for (const id of returnedIds) {
          if (!Number.isSafeInteger(id) || id <= previousId || id > latestId)
            throw new Error("feed event ids are not strictly increasing above the cursor or exceed latest_id");
          previousId = id;
        }
        clearFeedRollback();
        noteFeedSuccess();
        if (!S.primed) {
          S.primed = true;
          S.cursor = Math.max(S.cursor, latestId);
          save();
          log(`primed at cursor ${S.cursor} — ${events.length} historic event(s) skipped; trading forward only`);
        } else {
          // Exit safety is not held hostage by an earlier bad entry. Pre-latch/process
          // every exit in the validated batch before the sequential cursor pass.
          let unsafeExitPrepass = false;
          for (const ev of events.filter((event) => event.type === "exit")) {
            try {
              await handleDeskExitEvent(ev);
            } catch (error) {
              const positionLatched = S.positions[ev.mint]?.exitExecutionRequired === true;
              let deferred = false;
              try {
                const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
                deferred = Boolean(entry && journal.deferredDeskExitForEntry(entry.id));
              } catch {}
              if (!positionLatched && !deferred) unsafeExitPrepass = true;
              log(`EXIT PREPASS ${ev.symbol || ev.id}: ${error.message} — ` +
                `${positionLatched || deferred ? "durable exit remains latched" : "exit was not durably recorded"}`);
            }
          }
          const blockingIntent = journal.hasBlockingIntent();
          if (blockingIntent) {
            /* The server returns at most 50 rows. Returning forever without moving
             * the cursor pins us to that first window, so a newer desk exit can be
             * invisible indefinitely. Every exit in THIS validated batch was already
             * pre-latched above. Cross the batch now: entries are conservatively
             * abandoned while exposure is frozen, and the next window (and its exits)
             * becomes visible on the next poll. Never jump straight to latest_id —
             * exits beyond this batch have not been seen yet. */
            if (unsafeExitPrepass) {
              log(`journal intent ${blockingIntent} is unresolved and an exit could not be recorded — ` +
                "cursor stays pinned; manual action required");
              return;
            }
            const nextCursor = advanceFrozenBatchCursor(S.cursor, events);
            if (nextCursor > S.cursor) {
              S.cursor = nextCursor;
              save();
              log(`journal intent ${blockingIntent} is unresolved — exits were preprocessed; ` +
                `new exposure stayed frozen and cursor advanced to ${S.cursor} to expose the next batch`);
            } else {
              log(`journal intent ${blockingIntent} is unresolved — exits stay latched and new exposure is frozen`);
            }
            return;
          }
          for (const ev of events) {
            try {
              if (ev.type === "entry") await onEntry(ev);
              else if (ev.type === "exit") {
                const disposition = await handleDeskExitEvent(ev);
                if (disposition === "not-held") log(`EXIT ${ev.symbol} — not held`);
              } else throw new Error(`unknown event type ${ev.type}`);
              S.cursor = Math.max(S.cursor, Number(ev.id));
              save();
            } catch (error) {
              const intent = ev.type === "entry"
                ? journal.getIntent(`entry:${ev.event_id || `${FLOOR}:${ev.id}`}`) : null;
              if (ev.type === "entry" && (!intent || ["planned", "failed", "expired"].includes(intent.state))) {
                // New exposure is optional; a permanently unsafe or pre-sign failed
                // entry must not become a head-of-line denial of every later exit.
                log(`SKIP ${ev.symbol || ev.id}: ${error.message} — entry acknowledged without a trade`);
                S.cursor = Number(ev.id);
                save();
                continue;
              }
              log(`ERROR on ${ev.symbol || ev.id}: ${error.message} — event remains pending`);
              break;
            }
          }
        }
      }
    } catch (error) { noteFeedFailure(); log(`poll error: ${error.message}`); }
  } catch (error) {
    tickFailed = true;
    log(`tick safety stop: ${error.message}`);
  } finally {
    runtimeHealth.lastTickCompletedAt = Date.now();
    runtimeHealth.consecutiveTickFailures = tickFailed
      ? runtimeHealth.consecutiveTickFailures + 1 : 0;
    maybeProbeExecutionReadiness();
    sendHeartbeat();
    ticking = false;
    scheduleBackgroundRecovery();
  }
}

log(`up — floor ${FLOOR} — wallet ${WALLET} — ${EXECUTE ? "LIVE MAINNET" : "PAPER"}`);
log(`caps: ${CFG.maxSolPerTrade} SOL/trade, ${CFG.dailySolCap} SOL/rolling 24h deploy, ${CFG.dailyLossLimitSol} SOL/rolling realized-loss entry brake, ${CFG.maxOpenPositions} open`);
log(`journal: ${STATE_DB}; entries pause: ${PAUSE_ENTRIES_FILE}; ` +
  `sleep fault: ${SLEEP_ASSERTION_FAULT_FILE}; hard stop: ${HARD_STOP_FILE}`);
log(`resuming ${openList().length} position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);
