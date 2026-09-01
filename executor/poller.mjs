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
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ExecutionJournal, acquireProcessLock, positionEntryBlock, trackedBalanceDecision } from "./journal.mjs";
import {
  JupiterV2Executor, TOKEN_PROGRAM, WSOL, associatedTokenAddress,
  classicWalletTokenAmount, priceImpactPercent,
} from "./jupiter.mjs";
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
const LAMPORTS = 1_000_000_000;
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
  maxRentLamports: 3_000_000,
  maxEntryRoundTripLossPct: 12,
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

const number = (name, value, { min = 0, max = Infinity } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} must be between ${min} and ${max}`);
  return n;
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
const pauseEntries = () => fs.existsSync(PAUSE_ENTRIES_FILE);
const hardStop = () => fs.existsSync(HARD_STOP_FILE);

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
 * The canary ceilings above stay the default, and every operator can still only
 * LOWER them by config. Raising is possible, and deliberately awkward: an operator
 * must set all three money caps explicitly AND type an acknowledgement naming this
 * wallet and these exact numbers. A changed number invalidates the sentence.
 *
 * Why that shape. The canary caps exist because a first release should be too small
 * to hurt while real fills prove the pipeline — but frozen forever they are their own
 * defect: a tenant who funds 1 SOL still trades in half-dollar clips and has no way
 * to say otherwise. So the property to preserve is not "small", it is "nothing raises
 * real-money exposure by accident". A typed sentence cannot be produced by a config
 * typo, by a copied .env, or by anything arriving through the feed — which is the
 * threat model that matters, since the feed is the one channel a compromised server
 * could speak through. OPERATOR_MAX remains a hard code-level ceiling above it all.
 * maxOpenPositions stays frozen: it multiplies every other cap. */
const OPERATOR_MAX = Object.freeze({
  maxSolPerTrade: 0.25,
  dailySolCap: 2.5,
  dailyLossLimitSol: 1,
});
const capsAckSentence = (wallet, trade, daily, loss) =>
  `I raise the live caps for ${wallet} to ${trade} SOL per trade, ${daily} SOL per day, ${loss} SOL daily loss`;

let LIVE_CEILINGS = LIVE_LIMITS;
if (EXECUTE) {
  const req = {
    trade: process.env.MAX_SOL_PER_TRADE,
    daily: process.env.DAILY_SOL_CAP,
    loss: process.env.DAILY_LOSS_LIMIT_SOL,
  };
  const wantsRaise =
    (req.trade != null && Number(req.trade) > LIVE_LIMITS.maxSolPerTrade) ||
    (req.daily != null && Number(req.daily) > LIVE_LIMITS.dailySolCap) ||
    (req.loss != null && Number(req.loss) > LIVE_LIMITS.dailyLossLimitSol);
  if (wantsRaise) {
    if (!req.trade || !req.daily || !req.loss)
      fatal("raising any live cap requires ALL THREE set explicitly: MAX_SOL_PER_TRADE, " +
        "DAILY_SOL_CAP, DAILY_LOSS_LIMIT_SOL — a partial raise hides the numbers the " +
        "acknowledgement exists to make you look at");
    const t = number("MAX_SOL_PER_TRADE", req.trade, { min: 0.000001, max: OPERATOR_MAX.maxSolPerTrade });
    const d = number("DAILY_SOL_CAP", req.daily, { min: 0.000001, max: OPERATOR_MAX.dailySolCap });
    const l = number("DAILY_LOSS_LIMIT_SOL", req.loss, { min: 0.000001, max: OPERATOR_MAX.dailyLossLimitSol });
    if (d < t) fatal(`DAILY_SOL_CAP (${d}) is below MAX_SOL_PER_TRADE (${t}) — the day would refuse the first trade`);
    const expected = capsAckSentence(WALLET, String(req.trade).trim(), String(req.daily).trim(), String(req.loss).trim());
    if ((process.env.LIVE_CAPS_ACK || "").trim() !== expected)
      fatal("raised live caps need a typed acknowledgement. Set LIVE_CAPS_ACK to exactly:\n\n    " +
        expected + "\n");
    LIVE_CEILINGS = Object.freeze({ ...LIVE_LIMITS, maxSolPerTrade: t, dailySolCap: d, dailyLossLimitSol: l });
    log(`OPERATOR-RAISED CAPS acknowledged: ${t} SOL/trade, ${d} SOL/day deploy, ${l} SOL/day loss ` +
      `(hard maxima ${OPERATOR_MAX.maxSolPerTrade}/${OPERATOR_MAX.dailySolCap}/${OPERATOR_MAX.dailyLossLimitSol} are a code change, by design)`);
  }
}

const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: number("MAX_SOL_PER_TRADE",
    process.env.MAX_SOL_PER_TRADE || (EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : DEFAULTS.maxSolPerTrade),
    { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : 100 }),
  dailySolCap: number("DAILY_SOL_CAP",
    process.env.DAILY_SOL_CAP || (EXECUTE ? LIVE_CEILINGS.dailySolCap : DEFAULTS.dailySolCap),
    { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailySolCap : 1000 }),
  dailyLossLimitSol: number("DAILY_LOSS_LIMIT_SOL",
    process.env.DAILY_LOSS_LIMIT_SOL || (EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : DEFAULTS.dailyLossLimitSol),
    { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : 1000 }),
  maxOpenPositions: number("MAX_OPEN_POSITIONS",
    process.env.MAX_OPEN_POSITIONS || DEFAULTS.maxOpenPositions,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxOpenPositions : 100 }),
  trailPct: number("TRAIL_PCT", process.env.TRAIL_PCT || DEFAULTS.trailPct, { min: 0.01, max: 0.95 }),
  fDefault: number("F_DEFAULT", process.env.F_DEFAULT || DEFAULTS.fDefault, { min: 0.00001, max: 1 }),
  fNameMax: number("F_NAME_MAX", process.env.F_NAME_MAX || DEFAULTS.fNameMax, { min: 0.00001, max: 1 }),
  bookHeatMax: number("BOOK_HEAT_MAX", process.env.BOOK_HEAT_MAX || DEFAULTS.bookHeatMax, { min: 0.00001, max: 1 }),
  maxAgeHours: number("MAX_AGE_HOURS", process.env.MAX_AGE_HOURS || DEFAULTS.maxAgeHours, { min: 0.01, max: 720 }),
  scaleOutPct: 0,
};

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

const conn = new Connection(RPC, "confirmed");
const secondaryConn = EXECUTE ? new Connection(SECONDARY_RPC, "confirmed") : null;
if (EXECUTE) {
  let genesis, secondaryGenesis;
  try { [genesis, secondaryGenesis] = await Promise.all([conn.getGenesisHash(), secondaryConn.getGenesisHash()]); }
  catch (error) { fatal(`RPC mainnet check failed: ${error.message}`); }
  if (genesis !== MAINNET_GENESIS) fatal(`RPC is not Solana mainnet-beta (genesis ${genesis})`);
  if (secondaryGenesis !== MAINNET_GENESIS)
    fatal(`secondary RPC is not Solana mainnet-beta (genesis ${secondaryGenesis})`);
}

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
async function heldRaw(mint, connection = conn) {
  const ata = associatedTokenAddress(WALLET, mint, TOKEN_PROGRAM);
  const account = await connection.getAccountInfo(new PublicKey(ata), "confirmed");
  return classicWalletTokenAmount(account, {
    mint, wallet: WALLET, allowMissing: true, label: `canonical ATA ${ata}`,
  });
}
async function solBalance() { return (await conn.getBalance(kp.publicKey, "confirmed")) / LAMPORTS; }

async function inspectTrackedBalance(pos) {
  const tracked = BigInt(String(pos.qtyRaw || "0"));
  if (tracked <= 0n) return { verified: false, reason: "durable tracked balance is invalid",
    trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null };
  let primaryHeld;
  try { primaryHeld = await heldRaw(pos.mint); }
  catch (error) {
    return { verified: false, reason: `primary canonical-ATA balance unavailable: ${error.message}`,
      trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null };
  }
  let secondaryHeld = null;
  if (primaryHeld < tracked && secondaryConn) {
    try { secondaryHeld = await heldRaw(pos.mint, secondaryConn); }
    catch (error) { log(`${pos.symbol}: secondary canonical-ATA balance check failed: ${error.message}`); }
  }
  return trackedBalanceDecision({
    trackedRaw: tracked.toString(), primaryRaw: primaryHeld.toString(),
    secondaryRaw: secondaryHeld?.toString() ?? null,
  });
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

function latchExit(pos, why, intentId) {
  if (!EXECUTE) return;
  pos.exitExecutionRequired = true;
  pos.exitExecutionReason ||= String(why || "risk exit");
  pos.exitExecutionIntentId ||= intentId;
  pos.exitExecutionObservedAt ||= Date.now();
  save();
}

function validEntryEvent(ev) {
  try { new PublicKey(ev.mint); } catch { throw new Error("invalid Solana mint in feed event"); }
  if (!Number.isFinite(Number(ev.ts)) || Number(ev.ts) <= 0) throw new Error("entry event has no valid timestamp");
  if (Number(ev.ts) > Date.now() + MAX_FUTURE_SKEW_MS) throw new Error("entry event timestamp is too far in the future");
}

function entrySubmissionGate(intent) {
  if (intent?.kind !== "entry") return;
  if (pauseEntries()) throw new Error("PAUSE ENTRIES file appeared before submission");
  const event = intent.context?.event;
  validEntryEvent(event);
  if (Date.now() - Number(event.ts) > MAX_CALL_AGE_MS)
    throw new Error("entry call became stale before submission");
  validateEntryReference(event, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
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
  if (context?.riskStateBefore && typeof context.riskStateBefore === "object")
    next.state = structuredClone(context.riskStateBefore);
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
  const event = context.event;
  const plan = context.plan;
  if (context.wallet && context.wallet !== WALLET)
    throw new Error(`entry intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== WSOL || intent.outputMint !== intent.mint)
    throw new Error(`entry intent ${intent.id} has an invalid durable mint route`);
  if (!event || String(event.mint || "") !== String(intent.mint))
    throw new Error(`entry intent ${intent.id} has no matching durable event context`);
  if (!plan || !Number.isFinite(Number(plan.sol)) || Number(plan.sol) <= 0)
    throw new Error(`entry intent ${intent.id} has no durable sizing context`);

  const costBasisLamports = BigInt(input) + BigInt(networkFee);
  const paidSol = Number(costBasisLamports) / LAMPORTS;
  const existing = S.positions[intent.mint];
  if (existing) {
    if (existing.entryIntentId !== intent.id || String(existing.qtyRaw) !== output ||
        String(existing.costBasisLamports) !== costBasisLamports.toString() ||
        Math.abs(Number(existing.paidSol) - paidSol) > 1e-12)
      throw new Error(`entry intent ${intent.id} conflicts with the recorded position`);
    const next = structuredClone(S);
    journal.markAccounted(intent.id, next);
    S = next;
    return true;
  }

  const rule = context.takeProfitRule || {};
  const takeProfitX = Number(rule.takeProfitX);
  if (!Number.isFinite(takeProfitX) || takeProfitX <= 0 || typeof rule.honorDeskTarget !== "boolean")
    throw new Error(`entry intent ${intent.id} has no durable take-profit rule`);
  const stopBufferPct = Number(context.positionConfig?.stopBufferPct);
  const entryReference = context.entryReference;
  if (!entryReference || !(Number(entryReference.stopRatio) > 0) || Number(entryReference.stopRatio) >= 1 ||
      (entryReference.targetRatio != null && !(Number(entryReference.targetRatio) > 0)))
    throw new Error(`entry intent ${intent.id} has no valid durable market reference`);
  const pos = openPosition({
    call: {
      ...event,
      stop: Number(entryReference.stopRatio),
      target: entryReference.targetRatio == null ? null : Number(entryReference.targetRatio),
    },
    sol: paidSol,
    fillPrice: 1,
    cfg: { stopBufferPct: Number.isFinite(stopBufferPct) ? stopBufferPct : CFG.stopBufferPct },
  });
  pos.qtyRaw = output;
  pos.paidSol = paidSol;
  pos.costBasisLamports = costBasisLamports.toString();
  pos.entryInputLamports = input;
  pos.riskF = Number.isFinite(Number(plan.f)) ? Number(plan.f) : null;
  const durableOpenedAt = Number(context.openedAtMs ?? intent.createdAt);
  pos.openedAtMs = Number.isFinite(durableOpenedAt) && durableOpenedAt > 0
    ? durableOpenedAt : Date.now();
  pos.entryIntentId = intent.id;
  pos.takeProfitX = takeProfitX;
  pos.honorDeskTarget = rule.honorDeskTarget;
  pos.marketMarkAtEntry = Number(entryReference.marketMark);
  pos.marketMarkObservedAt = Number(entryReference.marketMarkAt);
  const solUsdAtEntry = Number(context.entryPreflight?.solUsd);
  if (!Number.isFinite(solUsdAtEntry) || solUsdAtEntry <= 0)
    throw new Error(`entry intent ${intent.id} has no durable SOL/USD reference`);
  pos.solUsdAtEntry = solUsdAtEntry;

  const next = recoveryRuntime(context);
  next.positions[intent.mint] = pos;
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next);
  S = next;
  log(`BOUGHT ${event.symbol || intent.mint.slice(0, 6)} — ${paidSol.toFixed(6)} SOL → ${output} raw — https://solscan.io/tx/${intent.signature}`);
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
    if (intent.kind === "entry") applyConfirmedEntry(intent);
    else if (["desk_exit", "risk_exit"].includes(intent.kind)) applyConfirmedExit(intent);
    else throw new Error(`confirmed intent ${intent.id} has unsupported kind ${intent.kind}`);
    count++;
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

  const preliminaryAmountRaw = BigInt(Math.floor(plan.sol * LAMPORTS));
  const preflight = await jupiter.preflightEntry(WSOL, ev.mint, preliminaryAmountRaw.toString());
  entrySubmissionGate({ kind: "entry", context: { event: ev } });
  const executableReturnRatio = Number(BigInt(preflight.reverse.outAmount) * 1_000_000n /
    preliminaryAmountRaw) / 1_000_000;
  const worstFeeRatio = 2 * jupiter.cfg.maxNetworkFeeLamports / Number(preliminaryAmountRaw);
  const slippageHaircut = (1 - jupiter.cfg.slippageBps / 10_000) ** 2;
  const conservativeReturnRatio = executableReturnRatio * slippageHaircut - worstFeeRatio;
  if (conservativeReturnRatio <= entryReference.stopRatio)
    throw new Error(`entry round trip plus worst-case fees is already at/below the authored stop`);
  const conservativeLossPct = Math.max(preflight.lossPct, (1 - conservativeReturnRatio) * 100);
  plan = planEntry({ call: normalizedCall,
    cfg: { ...perCall, measuredRoundTripLossPct: conservativeLossPct }, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol} after executable-cost check: ${plan.reason}`);
  const amountRaw = BigInt(Math.floor(plan.sol * LAMPORTS));
  log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
  const openedAtMs = Date.now();
  const fill = await jupiter.executeIntent({
    id: intentId,
    kind: "entry",
    eventId: ev.event_id || null,
    feedId: ev.id,
    mint: ev.mint,
    inputMint: WSOL,
    outputMint: ev.mint,
    amountRaw: amountRaw.toString(),
    context: {
      event: ev, plan, takeProfitRule, openedAtMs, entryReference,
      entryPreflight: {
        forwardOutputRaw: String(preflight.forward.outAmount),
        reverseOutputRaw: String(preflight.reverse.outAmount),
        roundTripLossPct: preflight.lossPct,
        solUsd: preflight.solUsd,
        observedAt: openedAtMs,
      },
      positionConfig: { stopBufferPct: perCall.stopBufferPct },
      riskStateBefore: structuredClone(S.state),
    },
  });
  applyConfirmedEntry(fill);
}

async function sellAll(pos, why, fraction = 1, suppliedIntentId = null) {
  const intentId = suppliedIntentId || `risk-exit:${pos.entryIntentId || `${pos.mint}:${pos.openedAtMs || pos.openedAt}`}`;
  latchExit(pos, why, intentId);
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedExit(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`EXIT ${pos.symbol} already accounted`);
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
      riskStateBefore: structuredClone(S.state),
    },
  });
  applyConfirmedExit(fill);
}

async function manageOpen() {
  let currentSolUsd = null;
  let solUsdError = null;
  if (EXECUTE && openList().length && jupiter) {
    try { currentSolUsd = await jupiter.solUsdPrice(); }
    catch (error) { solUsdError = error; }
  }

  /* ONE DENOMINATOR OUTAGE MUST NOT DISARM EVERY STOP.
   * The SOL/USD leg is fetched once per tick; when it failed, the code discarded the
   * token→WSOL quote it ALREADY HELD for every position and left mark=null, which
   * pricePolicy treats as "hold". So during a Jupiter USDC-route outage — precisely
   * when rugs cluster — stops, trails and take-profits were all silently off for
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
    S.solUsdCache = { v: currentSolUsd, ts: Date.now() };
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
    const maxAge = Number(process.env.SOL_USD_CACHE_MAX_AGE_MS || 30 * 60e3);
    /* age >= 0: a backward clock step (RTC-less reboot, NTP correction — the same
     * restart class the persistence exists for) makes the age negative, which passed
     * `<= maxAge` unconditionally and voided the staleness cap for hours. The journal
     * already defends rolling windows against backward clocks; this line holds the
     * same standard. */
    const cacheAge = Date.now() - (cache?.ts ?? 0);
    if (cache?.v > 0 && cacheAge >= 0 && cacheAge <= maxAge) {
      currentSolUsd = cache.v;
      solUsdError = null;
      log(`SOL/USD leg failed — using the cached rate $${cache.v} from ${Math.round((Date.now() - cache.ts) / 60000)}m ago so stops stay armed`);
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
      if (pos.accountingIncomplete) {
        log(`${pos.symbol}: legacy accounting/SOL-USD basis is incomplete — automatic price exits remain disarmed`);
        continue;
      }
      let mark = null;
      if (jupiter && pos.qtyRaw && BigInt(pos.qtyRaw) > 0n) {
        let quote = null;
        try { quote = await jupiter.quote(pos.mint, WSOL, pos.qtyRaw); }
        catch (error) {
          pos.riskDataUnavailable = true;
          pos.riskDataUnavailableReason = `mark/exit quote unavailable: ${error.message}`;
          pos.riskDataUnavailableAt = Date.now();
          save();
          log(`mark ${pos.symbol}: ${error.message} — new entries blocked`);
        }
        if (quote) {
          priceImpactPercent(quote);
          if (solUsdError || !(currentSolUsd > 0)) {
            pos.riskDataUnavailable = true;
            pos.riskDataUnavailableReason = `SOL/USD mark unavailable: ${solUsdError?.message || "invalid quote"}`;
            pos.riskDataUnavailableAt = Date.now();
            save();
          } else {
            const entryInputSol = Number(BigInt(pos.entryInputLamports)) / LAMPORTS;
            mark = ((Number(BigInt(quote.outAmount)) / LAMPORTS) / entryInputSol) *
              (currentSolUsd / Number(pos.solUsdAtEntry));
            delete pos.riskDataUnavailable;
            delete pos.riskDataUnavailableReason;
            delete pos.riskDataUnavailableAt;
            save();
          }
        }
      }
      const decision = stepPosition({ pos, mark, deskExit: null, cfg: policyConfigForPosition(pos, CFG) });
      if (pos.exitExecutionRequired) {
        await sellAll(pos, pos.exitExecutionReason || decision.reason, 1, pos.exitExecutionIntentId || null);
      } else if (decision.action === "sell") await sellAll(pos, decision.reason);
      else if (decision.action === "sell_part") await sellAll(pos, decision.reason, decision.fraction);
      else save();
    } catch (error) {
      // A sellAll above may have swapped S for a clone; write the failure onto the
      // LIVE object or the flags evaporate with the detached one.
      const live = openList().find((p) => p.mint === posKey);
      const pos = live ?? { symbol: posKey };
      if (!live) { log(`manage ${pos.symbol}: ${error.message} — position left the book mid-pass`); continue; }
      if (pos.exitExecutionRequired) {
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
function sendHeartbeat() {
  if (Date.now() - lastHeartbeatAt < 60_000) return;
  lastHeartbeatAt = Date.now();
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
      })),
      ts: Date.now(),
    }),
  }).catch(() => {});
}

async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  sendHeartbeat();
  try {
    if (EXECUTE) await jupiter.recoverPending();
    accountConfirmedIntents();
    // Existing risk outranks new opportunity. A stop, age exit, balance ambiguity, or
    // emergency-impact block must update the durable book before an entry from this
    // feed tick can pass sizing and loss gates.
    await manageOpen();
    try {
      const response = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`, {
        headers: { authorization: `Bearer ${SECRET}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) log("feed authentication rejected — check CC_SECRET / CC_FLOOR");
      else if (!response.ok) log(`feed HTTP ${response.status}`);
      else {
        const payload = await response.json();
        if (payload.cluster !== "mainnet-beta") throw new Error("feed cluster is not mainnet-beta");
        if (!Array.isArray(payload.events)) throw new Error("feed omitted its events array");
        const events = payload.events;
        const latestId = Number(payload.latest_id);
        if (!Number.isSafeInteger(latestId) || latestId < 0)
          throw new Error("feed omitted a safe non-negative latest_id");
        const returnedIds = events.map((event) => Number(event?.id));
        let previousId = S.cursor;
        for (const id of returnedIds) {
          if (!Number.isSafeInteger(id) || id <= previousId || id > latestId)
            throw new Error("feed event ids are not strictly increasing above the cursor or exceed latest_id");
          previousId = id;
        }
        if (!S.primed) {
          S.primed = true;
          S.cursor = Math.max(S.cursor, latestId);
          save();
          log(`primed at cursor ${S.cursor} — ${events.length} historic event(s) skipped; trading forward only`);
        } else {
          // Exit safety is not held hostage by an earlier bad entry. Pre-latch/process
          // every exit in the validated batch before the sequential cursor pass.
          for (const ev of events.filter((event) => event.type === "exit")) {
            const pos = S.positions[ev.mint];
            if (!pos) continue;
            try {
              await sellAll(pos, `desk exit (${ev.code || "exit"})`, 1,
                `desk-exit:${ev.event_id || `${FLOOR}:${ev.id}`}`);
            } catch (error) {
              log(`EXIT PREPASS ${ev.symbol || ev.id}: ${error.message} — exit remains latched`);
            }
          }
          const blockingIntent = journal.hasBlockingIntent();
          if (blockingIntent) {
            log(`journal intent ${blockingIntent} is unresolved — exits stay latched and new exposure is frozen`);
            return;
          }
          for (const ev of events) {
            try {
              if (ev.type === "entry") await onEntry(ev);
              else if (ev.type === "exit") {
                const pos = S.positions[ev.mint];
                if (pos) await sellAll(pos, `desk exit (${ev.code || "exit"})`, 1,
                  `desk-exit:${ev.event_id || `${FLOOR}:${ev.id}`}`);
                else log(`EXIT ${ev.symbol} — not held`);
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
    } catch (error) { log(`poll error: ${error.message}`); }
  } catch (error) {
    log(`tick safety stop: ${error.message}`);
  } finally {
    ticking = false;
  }
}

log(`up — floor ${FLOOR} — wallet ${WALLET} — ${EXECUTE ? "LIVE MAINNET" : "PAPER"}`);
log(`caps: ${CFG.maxSolPerTrade} SOL/trade, ${CFG.dailySolCap} SOL/rolling 24h deploy, ${CFG.dailyLossLimitSol} SOL/rolling 24h loss, ${CFG.maxOpenPositions} open`);
log(`journal: ${STATE_DB}; entries pause: ${PAUSE_ENTRIES_FILE}; hard stop: ${HARD_STOP_FILE}`);
log(`resuming ${openList().length} position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);
