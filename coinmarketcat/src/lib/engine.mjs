/**
 * HAWK-AI IN THE BROWSER: THE LANE.
 *
 * This is executor/snipe-lane.mjs's job done where the wallet is Phantom instead of a
 * burner key. The decision code is the executor's own, imported: `snipeContract` decides
 * whether a launch may be bought and at what ceiling; `snipePolicy` decides when a
 * position leaves; `buyIx` / `sellIx` encode the bytes; `curveExitMarkX` prices what is
 * held; `createSnipeShadow` keeps the research book in the executor's own row schema, so
 * `node vendor/executor/grade-entry-gates.mjs --file <export>` grades this lane's rows exactly as it
 * grades WALL-ST-E's. What this file owns is the plumbing around a signer that is a
 * person, and one entry rule the record supports:
 *
 *   · TWO SIGNERS, ONE SHAPE. `bridge` is Phantom: one approval window per trade, by
 *     design — Phantom has no auto-approve and this lane does not route around it; in
 *     that mode the extension never sees a key. `sessionSigner` is the AUTOPILOT WALLET
 *     (the session wallet module, which only the background host imports): the same
 *     { isReady(), wallet(), signTransaction() } shape, answered by a key the extension
 *     generated, keeps encrypted, and unlocks for a while — no window. `config.signerMode`
 *     picks which one BUYS; a SELL is always signed by whichever of the two holds the
 *     position, so switching modes never strands one. On autopilot the budget is also the
 *     balance: a buy the autopilot wallet cannot cover (ticket, fee, rent, one sell's fee
 *     and the rent floor) is refused before anything is signed. This file never touches a
 *     key either way; test-hawk-no-key.mjs scans it on every run.
 *
 *   · WATCH FIRST, THEN BUY. Every launch is evaluated at first notice exactly as the
 *     executor evaluates it — same contract, same ceiling — and opens a WOULD-HAVE
 *     position in the book, sampled forward for the shadow book. In an armed lane, that
 *     would-have position is the watch: only once it is `entryWaitMs` old AND still marks
 *     at or above `entryFollowThroughX` of its own would-have fill does the lane re-read
 *     the curve, run the contract again with the instruction it will sign, and ask
 *     Phantom. The record behind that: entries under three seconds won 0 of 9 and
 *     averaged −18.5%, entries past ten seconds won 4 of 10 and averaged +34%, and the
 *     shadow book's positive class — a launch nobody followed — is exactly a curve whose
 *     mark fell below the would-have fill. NONE OF THAT IS EVIDENCE OF AN EDGE; ρ for
 *     seconds-late was +0.08 at n=64. It is a rule that keeps this lane out of the one
 *     bucket that never won, and the shadow book grades it on every row.
 *
 *   · A BUY THAT WAITS TOO LONG IS NOT A BUY. A Phantom window that sits past
 *     `approvalTimeoutMs` is abandoned and the mint is marked attempted.
 *
 *   · A SELL THAT IS DECLINED IS ASKED AGAIN. The determiner re-fires on every tick; the
 *     lane asks Phantom again after `sellReaskMs`, and says so through `notify`. A stop
 *     that needs a click is a weaker stop than a key's, and the console says that.
 *
 *   · EVERYTHING IS DEPENDENCY-INJECTED — `rpc`, `bridge`, `store`, `clock`, `timers`,
 *     `fetchImpl` — so the whole lane runs in Node against a scripted chain and a
 *     scripted wallet (test-hawk-engine.mjs), and the service worker is a thin host.
 *
 *   · A LAUNCH QUOTED IN A STOCK (pump.fun "Custom Pairs": a curve priced in an xStock
 *     such as GLDx) is refused exactly as before unless the user listed that stock in
 *     `config.quoteMints`. A listed stock's mint account rides on the SAME
 *     getMultipleAccounts as the curve; `describeMint` reads its token program, decimals
 *     and pause switch (never `auditMintAccount`, which rightly refuses an xStock as a
 *     BASE mint), and the contract gets those facts as `quote`, with the ticket, day cap
 *     and minimum in the stock's raw units. The quote-token accounting is this file's:
 *     the quote ATA under the mint's own program on both legs, a simulate guard on that
 *     ATA's delta, a fill read from token balances in the stock's decimals, a day ledger
 *     per stock, and book rows that say what they were paid in. The first live buy in
 *     each stock is a CANARY at that stock's minPerTrade until one stock fill has been
 *     read back off the chain (config.mjs STOCK_CANARY_RULE), and the popup says so.
 *
 *   · A SECOND VENUE, OFF BY DEFAULT: new pools anywhere on Solana that pair a token with
 *     an xStock, found on public new-pool feeds and traded through Jupiter
 *     (src/lib/xstock-lane.mjs). It is built here and handed this file's own pieces — the
 *     clock, the day ledger, the signers, `simulateGuard`, `signSendConfirm` and the fill
 *     reader — so a Jupiter trade passes the same fences a pump.fun one does. It keeps its
 *     own book (S.xstock.snipes), ticks on its own loop so a slow Jupiter answer never
 *     delays a pump.fun sell, and shares with this lane the one-window-at-a-time slot, the
 *     live-position count and every day cap. With it off, nothing below behaves differently.
 *
 * Raw amounts are carried as digit strings everywhere they are stored, because the
 * snipe book refuses a BigInt (JSON.stringify throws on it) — see snipe-book.mjs.
 */
import {
  PUMPFUN_VENUE, decodeGlobalFeeRecipients, feeRecipientsForCurve, noticesFromLogs,
} from "../../vendor/executor/snipe-venue-pumpfun.mjs";
import { snipeContract, planSnipeCeiling } from "../../vendor/executor/snipe-entry.mjs";
import { curveExitMarkX, frictionXFor, snipeCurveState } from "../../vendor/executor/snipe-curve.mjs";
import * as snipePolicyModule from "../../vendor/executor/snipe-policy.mjs";
import { bindDeterminer, SNIPE_LANE_DEFAULTS } from "../../vendor/executor/snipe-lane.mjs";
import { openSnipe, updateSnipe, closeSnipe, snipeList, snipeFor, ensureSnipeBook } from "../../vendor/executor/snipe-book.mjs";
import { createSnipeShadow, snipeScorecard, shadowReport, quoteMintsOf } from "../../vendor/executor/snipe-shadow.mjs";
import { readSocials } from "../../vendor/executor/snipe-socials.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, describeMint } from "../../vendor/executor/token2022.mjs";
import {
  HAWK_BROWSER_VERSION, CONFIG_DEFAULTS, normalizeConfig, laneConfigFor, policyConfigFor, feeModelFor,
  browserArmability, browserArmSentence, quoteEntryFor, STOCK_CANARY_RULE, RECORD, autopilotBuyNeedLamports,
} from "./config.mjs";
import {
  buildUnsignedTransaction, createAtaIdempotentIx, toTransactionInstruction, associatedTokenAddress,
  fillFromTransaction, tokenAmountOf, toBase64, fromBase64, signatureOf, sameMessage, TxError,
  WSOL, unitsToRaw, rawToUnits,
} from "./tx.mjs";
import { SIGN_ERRORS, BridgeError } from "./protocol.mjs";
import { createXstockLane, freshXstockState, XSTOCK_VENUE_ID } from "./xstock-lane.mjs";

const LAMPORTS = 1_000_000_000n;
const ZERO_KEY = "11111111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
/** How often an autopilot lane re-reads its wallet's balance for the checklist. Every
 *  buy reads it again at the moment of asking, whatever this says. */
const AUTOPILOT_BALANCE_EVERY_MS = 15_000;
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const sol = (lamports) => Number(BigInt(lamports)) / Number(LAMPORTS);
const short = (mint) => (typeof mint === "string" && mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : String(mint));
/** A quote mint that is not SOL: the curve is priced in a token the wallet pays with. */
const isStockMint = (m) => typeof m === "string" && m.length > 30 && m !== WSOL;
/** A raw amount in a token's own units, exact, with its symbol: 1000000 at 8 is "0.01 GLDx". */
const units = (raw, decimals, symbol) => `${rawToUnits(raw, decimals)} ${symbol}`;

export const ENGINE_VERSION = HAWK_BROWSER_VERSION;
export { RECORD, STOCK_CANARY_RULE };

/** The state the store persists. Every raw amount is a digit string. */
export function freshState() {
  return {
    version: ENGINE_VERSION,
    snipes: {},          // the open book, snipe-book.mjs's shape, keyed by mint; live and would-have rows alike
    positions: {},       // the desk book — always empty here, read by the cross-book check
    attempts: {},        // mint → { at, outcome, detail }
    spend: [],           // { at, sol, kind, quoteMint?, quoteRaw?, quoteDecimals? } — the rolling 24-hour ledger;
                         // a stock-quoted trade charges its stock to quoteRaw and its SOL fee and rent to sol
    stockCanary: {},     // stock mint → { state: "proven" | "blocked", at, signature, detail } — absent = the next buy is a canary
    quoteMintFacts: {},  // stock mint → what describeMint last read: { decimals, program, paused, symbol, scaledUiMultiplier, at }
    closes: [],          // the book of closed trades, newest first (live and paper, flagged)
    refusals: [],        // { at, mint, gate, message }, newest first
    shadow: {},          // mint → shadow row, the executor's own schema (snipe-shadow.mjs)
    log: [],             // { at, line }, newest first
    counters: { notices: 0, cleared: 0, refused: 0, entered: 0, wouldHaveEntered: 0, sold: 0, entryFailures: 0, sellFailures: 0, signRequests: 0, signRejected: 0, signTimeouts: 0, liveAttempts: 0, waitedOut: 0 },
    xstock: freshXstockState(),   // the second venue's own book, candidates and canary (xstock-lane.mjs)
  };
}

/** A store that lives in memory: what the tests use, and what the service worker wraps. */
export function memoryStore(initial = null) {
  let saved = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    async load() { return saved ? JSON.parse(JSON.stringify(saved)) : null; },
    async save(state) { saved = JSON.parse(JSON.stringify(state)); },
    get snapshot() { return saved; },
  };
}

export function createHawkEngine({
  rpc = null,                 // createRpc() or a scripted double; may be swapped with setRpc()
  secondaryRpc = null,        // optional second reader; when present the curve must agree
  bridge,                     // Phantom: { isReady(), wallet(), signTransaction({txBase64,...}) }
  sessionSigner = null,       // the autopilot wallet, the same shape (createSessionSigner); null = Phantom only
  store = memoryStore(),
  feedFactory = null,         // ({ onLogs, onState }) => { start(), stop(), state, counters }
  clock = () => Date.now(),
  timers = { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  fetchImpl = globalThis.fetch,
  log = () => {},
  notify = () => {},
  adapter = PUMPFUN_VENUE,
  socialsReader = readSocials,
  config: initialConfig = {},
  jupiter = null,             // the xStock venue's Jupiter client; null builds one on fetchImpl (xstock-lane.mjs)
  poolDiscovery = null,       // the xStock venue's new-pool poller; null builds one on fetchImpl
} = {}) {
  if (!bridge || typeof bridge.signTransaction !== "function" || typeof bridge.wallet !== "function")
    throw new Error("createHawkEngine needs a bridge with wallet() and signTransaction()");
  if (sessionSigner !== null && (typeof sessionSigner.signTransaction !== "function" || typeof sessionSigner.wallet !== "function" || typeof sessionSigner.isReady !== "function"))
    throw new Error("createHawkEngine's sessionSigner needs isReady(), wallet() and signTransaction()");
  const determiner = bindDeterminer(snipePolicyModule);
  let config = normalizeConfig({ ...CONFIG_DEFAULTS, ...initialConfig });
  let S = freshState();
  let loaded = false;
  let feed = null;
  let feedState = "stopped";
  let feedDetail = null;
  let ticker = null;
  let ticking = false;
  let entryInFlight = null;         // the mint whose Phantom window is open
  const sellInFlight = new Set();
  let control = { hardStop: false, pauseEntries: false };
  const listeners = new Set();
  let saveQueued = false;
  let shadow = null;

  /* ── logging, persistence, status ──────────────────────────────────────────────────── */
  function say(line) {
    const at = clock();
    S.log.unshift({ at, line });
    if (S.log.length > 200) S.log.length = 200;
    try { log(line); } catch { /* the host's problem */ }
    emit();
  }
  function emit() { for (const cb of listeners) { try { cb(status()); } catch { /* listener's problem */ } } }
  async function persist() {
    if (saveQueued) return;
    saveQueued = true;
    await Promise.resolve();
    saveQueued = false;
    try { await store.save(S); } catch (error) { try { log(`persist failed: ${error?.message ?? error}`); } catch { /* nothing */ } }
  }
  function buildShadow() {
    shadow = createSnipeShadow({
      capacity: config.shadowCapacity, laneMode: config.lane === "off" ? "observe" : config.lane,
      sink: (row) => {
        S.shadow[row.mint] = row;
        const keys = Object.keys(S.shadow);
        if (keys.length > config.shadowCapacity) for (const k of keys.slice(0, keys.length - config.shadowCapacity)) delete S.shadow[k];
      },
    });
    /* Rows persisted by an earlier session are reloaded into the recorder so the
       scorecard is over the whole retained book, not this process's lifetime. */
    for (const row of Object.values(S.shadow)) {
      try { shadow.record({ mint: row.mint, venueId: row.venueId, notice: row.notice, createSlot: row.createSlot, observedSlot: row.observedSlot, endpointVerdict: row.endpointVerdict, endpoints: row.endpoints, curve: row.curve ? { ...row.curve } : null, verdict: { ok: row.gate?.ok, gate: row.gate?.refusedAt, detail: { ...row.ceiling, quote: row.ceiling?.quoteMint ? { mint: row.ceiling.quoteMint } : undefined, message: row.gate?.message, measured: row.gate?.measured, launchSharePct: row.gate?.launchSharePct }, trace: row.gate?.trace }, hops: [], frictionX: row.ceiling?.frictionX, ticketLamports: row.ceiling?.ticketLamports }); }
      catch { /* an unreadable old row is dropped, not fatal */ }
      const restored = shadow.row(row.mint);
      if (restored) S.shadow[row.mint] = { ...restored, forward: row.forward ?? [], outcome: row.outcome ?? null, timing: row.timing ?? restored.timing };
    }
  }
  async function load() {
    if (loaded) return;
    loaded = true;
    let saved = null;
    try { saved = await store.load(); } catch { saved = null; }
    if (isPlainObject(saved) && saved.version === ENGINE_VERSION) {
      const fx = freshXstockState();
      S = { ...freshState(), ...saved, counters: { ...freshState().counters, ...(saved.counters ?? {}) },
        xstock: { ...fx, ...(isPlainObject(saved.xstock) ? saved.xstock : {}), counters: { ...fx.counters, ...(saved.xstock?.counters ?? {}) } } };
      ensureSnipeBook(S);
      for (const pos of snipeList(S)) if (pos.pendingSell) say(`resumed with ${short(pos.mint)} still waiting for a sell approval`);
    }
    buildShadow();
  }

  /* ── the rolling day ───────────────────────────────────────────────────────────────── */
  function pruneSpend(now) { S.spend = S.spend.filter((e) => now - e.at < DAY_MS); }
  function deployedTodaySol(now = clock()) { pruneSpend(now); return S.spend.reduce((a, e) => a + e.sol, 0); }
  function charge(kind, lamports, now = clock()) { S.spend.push({ at: now, sol: sol(lamports), kind }); pruneSpend(now); }
  /** The stock's own day, exact: the BigInt sum of what this lane spent in it. */
  function deployedTodayQuoteRaw(quoteMint, now = clock()) {
    pruneSpend(now);
    let total = 0n;
    for (const e of S.spend) if (e.quoteMint === quoteMint && /^\d+$/.test(String(e.quoteRaw ?? ""))) total += BigInt(e.quoteRaw);
    return total;
  }
  /** One ledger line for a stock-quoted trade: the stock to its own day, the SOL it paid
   *  for the network fee and rent to the SOL day. */
  function chargeStock(kind, { quoteMint, quoteRaw, quoteDecimals, lamports }, now = clock()) {
    S.spend.push({ at: now, sol: sol(lamports), kind, quoteMint, quoteRaw: BigInt(quoteRaw).toString(), quoteDecimals });
    pruneSpend(now);
  }

  /* ── the contract's view of the book and the controls ──────────────────────────────── */
  const REAL_ATTEMPTS = new Set(["signing", "entered", "failed", "unbooked", "refused"]);
  function recentAttempts(now, { realOnly = false } = {}) {
    const out = {};
    for (const [mint, a] of Object.entries(S.attempts)) {
      if (now - a.at >= ATTEMPT_WINDOW_MS) { delete S.attempts[mint]; continue; }
      if (realOnly && !REAL_ATTEMPTS.has(a.outcome)) continue;
      out[mint] = { mint, ...a };
    }
    return out;
  }
  function bookView(now, { excludeMint = null, realOnly = false } = {}) {
    const snipes = {};
    for (const [mint, row] of Object.entries(S.snipes)) if (mint !== excludeMint) snipes[mint] = row;
    /* A mint the xStock venue holds is a mint this lane may not open: the contract's
       already_holding reads it from `positions`. Empty unless that venue holds something. */
    const xstockHeld = S.xstock?.snipes ?? {};
    const positions = Object.keys(xstockHeld).length ? { ...S.positions, ...xstockHeld } : S.positions;
    return Object.freeze({ snipes, positions, attempts: recentAttempts(now, { realOnly }), deployedTodaySol: deployedTodaySol(now) });
  }
  const controlView = () => Object.freeze({ hardStop: control.hardStop === true, pauseEntries: control.pauseEntries === true });
  const venueFeeBps = () => {
    const observed = Number(adapter.feeObservation?.totalFeeBps);
    return Number.isFinite(observed) ? observed : null;
  };
  const feeReserveLamports = () => BigInt(Math.round((Number(SNIPE_LANE_DEFAULTS.networkFeeReserveSol) || 0) * Number(LAMPORTS)));

  /* ── who signs ───────────────────────────────────────────────────────────────────────
     Phantom (`bridge`) or the autopilot wallet (`sessionSigner`), by config.signerMode,
     for BUYS; a sell goes to whichever of the two holds the position. */
  const NO_AUTOPILOT = Object.freeze({
    isReady: () => false, wallet: () => null,
    async signTransaction() { throw new BridgeError(SIGN_ERRORS.NO_WALLET, "no autopilot wallet is wired into this lane"); },
  });
  const onAutopilot = () => config.signerMode === "autopilot";
  const readyOf = (signer) => (typeof signer?.isReady === "function" ? signer.isReady() === true : true);
  const isAutopilot = (signer) => sessionSigner !== null && signer === sessionSigner;
  function activeSigner() { return onAutopilot() ? (sessionSigner ?? NO_AUTOPILOT) : bridge; }
  /** The signer whose wallet holds `wallet`, or null. The autopilot wallet's address is
   *  known locked or unlocked; Phantom's only while it is connected. */
  function signerHolding(wallet) {
    if (!wallet) return null;
    if (sessionSigner && sessionSigner.wallet() === wallet) return sessionSigner;
    if (bridge.wallet() === wallet) return bridge;
    return null;
  }
  /** The autopilot wallet as the checklist and the popup see it: its address, whether it
   *  is unlocked now, until when, and the balance last read off the chain. */
  const autopilotBalance = { wallet: null, lamports: null, at: 0 };
  let lastSignerSnapshot = null;
  function autopilotView() {
    if (!sessionSigner) return null;
    const publicKey = sessionSigner.wallet() ?? null;
    const unlocked = readyOf(sessionSigner);
    const fresh = publicKey !== null && autopilotBalance.wallet === publicKey && autopilotBalance.lamports !== null;
    return {
      publicKey, unlocked, expiresAt: unlocked ? lastSignerSnapshot?.expiresAt ?? null : null,
      balanceLamports: fresh ? autopilotBalance.lamports.toString() : null, balanceSol: fresh ? sol(autopilotBalance.lamports) : null,
      balanceAt: fresh ? autopilotBalance.at : null,
    };
  }
  async function refreshAutopilotBalance({ force = false } = {}) {
    if (!sessionSigner || !rpc) return null;
    const wallet = sessionSigner.wallet();
    if (!wallet) { autopilotBalance.wallet = null; autopilotBalance.lamports = null; return null; }
    if (!force && autopilotBalance.wallet === wallet && clock() - autopilotBalance.at < AUTOPILOT_BALANCE_EVERY_MS) return autopilotBalance.lamports;
    try {
      const lamports = BigInt(await rpc.getBalance(wallet));
      autopilotBalance.wallet = wallet; autopilotBalance.lamports = lamports; autopilotBalance.at = clock();
    } catch { /* the last read stands; an unread balance keeps the checklist red, not green */ }
    return autopilotBalance.lamports;
  }
  /** What the host calls at start and after every keystore call: re-read the keystore,
   *  then the autopilot wallet's balance. */
  async function refreshSigner() {
    if (sessionSigner && typeof sessionSigner.refresh === "function") {
      try { lastSignerSnapshot = await sessionSigner.refresh(); }
      catch (error) { say(`the autopilot wallet could not be read: ${error?.message ?? error}`); }
    }
    await refreshAutopilotBalance({ force: true });
    emit();
    return autopilotView();
  }
  function armabilityNow() {
    const signer = activeSigner();
    return browserArmability({
      config, wallet: signer.wallet(), hasBridge: readyOf(bridge),
      autopilot: onAutopilot() ? autopilotView() : null,
    });
  }
  function armed() {
    if (config.lane !== "execute") return false;
    const signer = activeSigner();
    const wallet = signer.wallet();
    if (!wallet || !rpc) return false;
    /* Phantom: the console tab answers. Autopilot: the wallet is unlocked now — judged
       against the clock, so an unlock that ran out stops the next buy without a read. */
    if (!readyOf(signer)) return false;
    /* With no stock listed and Phantom signing this is the executor's snipeArmSentence
       byte for byte; with stocks listed it names every one, its canary, its cap and its
       mint address; on autopilot it says that nothing will ask before it signs. */
    if (config.liveAck !== browserArmSentence(wallet, config.maxSolPerTrade, config.dailySolCap, config.quoteMints, { autopilot: onAutopilot(), xstockVenue: config.xstockVenue === true })) return false;
    /* The checklist the popup prints under "Before this lane may spend money" is the
       condition, not a decoration: a matching sentence with a red item (a stock listed
       with no stop chosen, an autopilot wallet that cannot cover a ticket) does not arm. */
    return armabilityNow().armable;
  }
  /** The contract sees "execute" only at the moment a live entry is attempted with the
   *  instruction it will sign. Every first-notice evaluation is an observe evaluation. */
  const observeCfg = () => laneConfigFor(config, { lane: config.lane === "off" ? "off" : "observe" });
  const executeCfg = () => laneConfigFor(config, { lane: "execute" });

  /* ── reads ─────────────────────────────────────────────────────────────────────────── */
  const digest = (account) => {
    const d = account?.data;
    if (d == null) return null;
    return Array.isArray(d) ? `${d[0].length}:${d[0].slice(0, 24)}:${d[0].slice(-24)}` : String(d).slice(0, 48);
  };
  /** One getMultipleAccounts on the primary and, when configured, the secondary. The
   *  verdict vocabulary is the shadow book's: agree | single | disagree | one_missing | both_missing. */
  async function readAccounts(addresses) {
    if (!rpc) throw new Error("no RPC is configured");
    const readers = [rpc, secondaryRpc].filter(Boolean);
    const results = await Promise.allSettled(readers.map((r) => r.getMultipleAccounts(addresses)));
    const views = results.map((r, i) => {
      const id = i === 0 ? "primary" : "secondary";
      if (r.status !== "fulfilled") return { id, slot: null, present: false, digest: null, error: String(r.reason?.message ?? r.reason), accounts: [] };
      const accounts = r.value.accounts ?? [];
      return { id, slot: r.value.slot ?? null, present: Boolean(accounts[0]?.data), digest: digest(accounts[0]), error: null, accounts };
    });
    const answered = views.filter((v) => v.error === null);
    const endpoints = views.map(({ accounts: _a, ...e }) => e);
    if (!answered.length) throw new Error(`no endpoint answered the account read: ${views.map((v) => v.error).join("; ")}`);
    const present = answered.filter((v) => v.present);
    if (!present.length) return { verdict: "both_missing", slot: answered[0].slot, accounts: answered[0].accounts, all: answered, endpoints };
    if (answered.length === 1) return { verdict: readers.length === 1 ? "single" : "single", slot: present[0].slot, accounts: present[0].accounts, all: answered, endpoints };
    if (present.length === 1) return { verdict: "one_missing", slot: present[0].slot, accounts: present[0].accounts, all: answered, endpoints };
    const [a, b] = present;
    const same = a.accounts.length === b.accounts.length && a.accounts.every((acc, i) => digest(acc) === digest(b.accounts[i]));
    const chosen = a.slot >= b.slot ? a : b;
    return { verdict: same ? "agree" : "disagree", slot: chosen.slot, accounts: chosen.accounts, all: answered, endpoints };
  }
  function decodeCurve(read, mint) {
    if (!(read.verdict === "agree" || read.verdict === "single" || read.verdict === "one_missing")) return null;
    try { return adapter.curveFromAccount(read.accounts[0], { feeBps: venueFeeBps(), mint }) ?? null; } catch { return null; }
  }

  /* ── the stock a curve is quoted in ──────────────────────────────────────────────────
     The listed stocks' mint accounts ride on the same getMultipleAccounts as the curve,
     after the adapter's own addresses, so knowing a curve's quote costs no extra round
     trip; with nothing listed the read is exactly what it always was. */
  const listedQuoteMints = () => (config.quoteMints ?? []).map((q) => q.mint);
  /** The curve's quote when it is a token rather than SOL, else null. */
  const stockQuoteOf = (curve) => (curve && curve.quoteIsSol !== true && isStockMint(curve.quoteMint) ? curve.quoteMint : null);
  /** Describe a quote mint (never audit it: the base-mint kill set refuses every xStock),
   *  and remember what was read so the popup can show decimals and the pause switch. */
  function describeQuote(account, quoteMint) {
    const facts = describeMint(account, quoteMint);
    S.quoteMintFacts[quoteMint] = {
      decimals: facts.decimals, program: facts.program, paused: facts.paused, symbol: facts.metadataSymbol ?? null,
      transferHookProgram: facts.transferHookProgram, scaledUiMultiplier: facts.scaledUiMultiplier, at: clock(),
    };
    return facts;
  }
  /** The stock's canary state: "proven" once one of its fills was read back and booked,
   *  "blocked" when a buy landed and could not be read or booked, else "canary". */
  const canaryState = (quoteMint) => S.stockCanary[quoteMint]?.state ?? "canary";
  /**
   * The `quote` argument the contract validates with quoteTicketFor, built from the mint
   * account in hand and the user's list — or null with a `note` saying why not, which the
   * refusal line carries beside the contract's own message. `ticket` is "full" (the
   * configured maxPerTrade) or "canary" (minPerTrade).
   */
  function quoteArgFor({ quoteMint, account, ticket = "full" }) {
    const entry = quoteEntryFor(config, quoteMint);
    if (!entry) return { quote: null, entry: null, note: null };
    let facts;
    try { facts = describeQuote(account, quoteMint); }
    catch (error) { return { quote: null, entry, note: `the ${entry.symbol} mint account could not be described: ${error.message}` }; }
    if (facts.metadataSymbol && facts.metadataSymbol !== entry.symbol)
      return { quote: null, entry, note: `the list names ${short(quoteMint)} ${entry.symbol}, but that mint calls itself ${facts.metadataSymbol} — check the mint address in Options` };
    if (facts.initialized !== true) return { quote: null, entry, note: `the ${entry.symbol} mint is not initialized` };
    /* describeMint reports a hook and leaves the decision to the caller. A hook program
       that is not the zero key runs third-party code on every transfer of the quote,
       buy and sell alike; this lane does not pay through one. */
    if (facts.transferHookProgram !== null)
      return { quote: null, entry, note: `the ${entry.symbol} mint's transfer hook points at program ${facts.transferHookProgram} — every fill would run it; refused` };
    try {
      const ticketRaw = unitsToRaw(ticket === "canary" ? entry.minPerTrade : entry.maxPerTrade, facts.decimals, `the ${entry.symbol} ticket`);
      const minTicketRaw = unitsToRaw(entry.minPerTrade, facts.decimals, `the ${entry.symbol} minimum`);
      const dailyCapRaw = unitsToRaw(entry.dailyCap, facts.decimals, `the ${entry.symbol} day cap`);
      return {
        entry, note: null, facts,
        quote: {
          mint: quoteMint, decimals: facts.decimals, tokenProgram: facts.program, symbol: entry.symbol,
          ticketRaw, minTicketRaw, dailyCapRaw, deployedTodayRaw: deployedTodayQuoteRaw(quoteMint),
          paused: facts.paused, transferHookProgram: facts.transferHookProgram,
        },
      };
    } catch (error) { return { quote: null, entry, note: error.message }; }
  }

  /* ── the entry: first notice ───────────────────────────────────────────────────────── */
  function creatorFacts(notice, curve) {
    return Object.freeze({ creator: notice?.creator ?? curve?.creator ?? null, shareOfSupplyPct: undefined, priorLaunches: undefined });
  }
  function pickRecipient(list, label) {
    const hit = (list ?? []).find((k) => typeof k === "string" && k !== ZERO_KEY);
    if (!hit) throw new TxError("prepare_failed", `the Global account names no ${label}`);
    return hit;
  }
  function prepareBuy({ mint, wallet, curve, read, baseOutRaw, maxQuoteInRaw, quote = null }) {
    const global = read.accounts[1], mintAccount = read.accounts[2];
    if (!global?.data) throw new TxError("prepare_failed", "the Global account was not in the read");
    if (!mintAccount?.owner) throw new TxError("prepare_failed", "the mint account was not in the read");
    const baseTokenProgram = String(mintAccount.owner);
    if (baseTokenProgram !== TOKEN_PROGRAM && baseTokenProgram !== TOKEN_2022_PROGRAM)
      throw new TxError("prepare_failed", `the mint is owned by ${baseTokenProgram}, not a token program`);
    /* THE QUOTE'S TOKEN PROGRAM IS THE QUOTE MINT'S OWNER, read, never assumed. The venue
       derives five quote ATAs (fee recipient, buyback, curve, user, creator vault) from it;
       an xStock is Token-2022, and a Token program here names five accounts that do not
       exist. SOL keeps the Token program it always had. */
    const quoteTokenProgram = quote ? quote.tokenProgram : TOKEN_PROGRAM;
    if (quoteTokenProgram !== TOKEN_PROGRAM && quoteTokenProgram !== TOKEN_2022_PROGRAM)
      throw new TxError("prepare_failed", `the quote mint is owned by ${quoteTokenProgram}, not a token program`);
    const sets = decodeGlobalFeeRecipients(global.data);
    const feeRecipient = pickRecipient(feeRecipientsForCurve(curve, sets), "fee recipient");
    const buybackFeeRecipient = pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient");
    const associatedBaseUser = associatedTokenAddress(wallet, mint, baseTokenProgram);
    const associatedQuoteUser = quote ? associatedTokenAddress(wallet, quote.mint, quoteTokenProgram) : null;
    const instruction = adapter.buyIx({
      mint, user: wallet, curve, curveReadSlot: read.slot, buildingForSlot: read.slot,
      feeRecipient, buybackFeeRecipient, baseTokenProgram, quoteTokenProgram,
      associatedBaseUser, associatedBaseUserOwner: wallet, globalFeeRecipients: sets,
      amountRaw: BigInt(baseOutRaw), maxQuoteInRaw: BigInt(maxQuoteInRaw),
    });
    return Object.freeze({ instruction, associatedBaseUser, associatedQuoteUser, baseTokenProgram, quoteTokenProgram, feeRecipient, buybackFeeRecipient, sets });
  }
  function frictionFor(verdict) {
    const entryInputRaw = verdict.detail.maxQuoteInRaw ?? null;
    if (entryInputRaw === null || !(entryInputRaw > 0n)) return null;
    /* A stock-quoted ticket's fees are lamports beside a size in the stock: they cannot
       be netted, so its friction is the venue's alone — 1.0 before the venue fee. The
       row carries the SOL it paid as networkFeeLamports instead. */
    const stock = verdict.detail.quote?.isSol === false;
    const fee = stock ? 0n : feeReserveLamports();
    try { return frictionXFor({ entryInputLamports: entryInputRaw, entryFeeLamports: fee, expectedExitFeeLamports: fee }); }
    catch { return null; }
  }

  async function handleNotice(notice) {
    await load();
    if (config.lane === "off") return null;
    const mint = notice?.mint;
    if (typeof mint !== "string" || !mint) return null;
    const now = clock();
    S.counters.notices++;
    if (S.attempts[mint] && now - S.attempts[mint].at < ATTEMPT_WINDOW_MS) return null;   // seen already
    if (snipeFor(S, mint)) return null;
    const cfg = observeCfg();
    const noticeAtMs = Number(notice?.noticeAt) || now;
    const hops = [{ hop: "notice", atMs: noticeAtMs }];

    const socialsPromise = cfg.requireSocials === true
      ? Promise.resolve(socialsReader({ uri: notice?.raw?.uri ?? notice?.uri ?? null, timeoutMs: Number(cfg.socialsTimeoutMs) || undefined, fetchImpl }))
        .catch((error) => Object.freeze({ ok: false, clause: "fetch_failed", message: String(error?.message ?? error).slice(0, 160) }))
      : null;

    const baseAddresses = adapter.accountsFor(mint).map(String);
    const listed = listedQuoteMints();
    let read;
    try { read = await readAccounts([...baseAddresses, ...listed]); }
    catch (error) {
      read = { verdict: "both_missing", slot: null, accounts: [], all: [], endpoints: [{ id: "primary", slot: null, present: false, digest: null, error: String(error?.message ?? error) }] };
    }
    hops.push({ hop: "accounts", atMs: clock() });
    const curve = decodeCurve(read, mint);
    hops.push({ hop: "decode", atMs: clock() });
    /* A curve quoted in a listed stock: that stock's mint account is already in the read. */
    const curveStock = stockQuoteOf(curve);
    let quote = null, quoteNote = null;
    if (curveStock && listed.includes(curveStock)) {
      ({ quote, note: quoteNote } = quoteArgFor({ quoteMint: curveStock, account: read.accounts[baseAddresses.length + listed.indexOf(curveStock)] ?? null }));
    }
    hops.push({ hop: "prepare", atMs: clock() });

    const verdict = snipeContract({
      notice: { mint, creator: notice?.creator ?? null, slot: notice?.slot ?? null, noticeAt: noticeAtMs, source: notice?.source ?? null, wallet: null },
      curve, adapter, cfg, book: bookView(now), nowMs: clock(), control: controlView(),
      mint: read.accounts[2] ?? null, creator: creatorFacts(notice, curve), fees: feeModelFor(config, { quoteAtaCreate: quote !== null }),
      instruction: null,
      socials: socialsPromise ? await socialsPromise : null,
      quote,
    });
    hops.push({ hop: "gate", atMs: clock() });
    const frictionX = frictionFor(verdict);
    hops.push({ hop: "ceiling", atMs: clock() });
    hops.push({ hop: "record", atMs: clock() });
    try {
      shadow.record({
        mint, venueId: adapter.id,
        notice: { firstSource: notice?.source ?? null, firstKind: "logs", firstSeenAtMs: noticeAtMs, firstSlot: notice?.slot ?? null, creator: notice?.creator ?? null },
        createSlot: notice?.slot ?? null, observedSlot: read.slot, endpointVerdict: read.verdict, endpoints: read.endpoints,
        /* A stock-quoted launch is its own population: the row says which stock, so the
           scorecard never pools it with SOL launches. A SOL row is exactly as before. */
        curve: curve ? (curveStock ? { ...snipeCurveState(curve), quoteMint: curveStock, quoteDecimals: quote?.decimals ?? S.quoteMintFacts[curveStock]?.decimals ?? null } : snipeCurveState(curve)) : null,
        verdict, hops, frictionX, ticketLamports: verdict.detail.ticketLamports ?? null,
      });
    } catch (error) { say(`${short(mint)}: the shadow book refused the row — ${error?.message ?? error}`); }

    if (!verdict.ok) {
      const message = quoteNote && verdict.gate === "quote_not_sol" ? `${verdict.detail.message} (${quoteNote})` : verdict.detail.message;
      S.counters.refused++;
      S.refusals.unshift({ at: now, mint, gate: verdict.gate, message, name: notice?.raw?.name ?? null, symbol: notice?.raw?.symbol ?? null, launchSharePct: verdict.detail.launchSharePct ?? null, quoteMint: curveStock });
      if (S.refusals.length > 60) S.refusals.length = 60;
      S.attempts[mint] = { at: now, outcome: "refused", detail: verdict.gate };
      say(`${short(mint)}: refused at ${verdict.gate} — ${message}`);
      await persist();
      return { verdict, entered: false };
    }
    S.counters.cleared++;
    const openPaper = snipeList(S).filter((p) => p.live !== true).length;
    if (openPaper >= config.shadowMaxOpen) {
      S.attempts[mint] = { at: now, outcome: "unsampled", detail: `${openPaper} would-have positions already sampling` };
      say(`${short(mint)}: cleared every gate, recorded, not sampled — ${openPaper} rows already sampling`);
      await persist();
      return { verdict, entered: false, recorded: true };
    }
    return openWouldBePosition({ mint, notice, curve, verdict, frictionX, read, now });
  }

  /** The row fields that say a position was paid in a stock, from the contract's own
   *  verdict. Empty for SOL, so a SOL row is byte-for-byte what it always was. */
  function stockRowFields(verdict) {
    const q = verdict.detail.quote;
    if (!q || q.isSol !== false) return null;
    return { quoteMint: q.mint, quoteDecimals: q.decimals, quoteSymbol: q.symbol, quoteTokenProgram: q.tokenProgram };
  }

  function openWouldBePosition({ mint, notice, curve, verdict, frictionX, read, now }) {
    const entryInputLamports = verdict.detail.maxQuoteInRaw;
    const qtyRaw = verdict.detail.baseOutRaw;
    const feeLamports = feeReserveLamports();
    const stock = stockRowFields(verdict);
    try {
      const creator = notice?.creator ?? curve?.creator ?? null;
      /* A stock row's size is in the stock (the book reads its decimals off the row) and
         its fee leg is 0: the SOL it would pay travels beside it as networkFeeLamports. */
      const sizeSol = stock ? Number(entryInputLamports) / 10 ** stock.quoteDecimals : sol(entryInputLamports);
      const feeSolPerLeg = stock ? 0 : sol(feeLamports);
      const position = determiner.open({ mint, entry: 1, openedAt: now, creator, sizeSol, feeSolPerLeg });
      const filed = openSnipe(S, {
        ...position, mint, venue: adapter.id, entry: 1, openedAt: now,
        sizeSol, feeSolPerLeg,
        qtyRaw: qtyRaw.toString(), entryInputLamports: entryInputLamports.toString(), entryFeeLamports: stock ? "0" : feeLamports.toString(),
        creator, openedAtSlot: read.slot ?? null, noticeAt: Number(notice?.noticeAt) || now,
        frictionXAtOpen: frictionX, samples: 0, live: false, liveAttempted: false, uri: notice?.raw?.uri ?? null,
        name: notice?.raw?.name ?? null, symbol: notice?.raw?.symbol ?? null,
        ...(stock
          ? { ...stock, networkFeeLamports: feeLamports.toString(), costBasisQuoteRaw: entryInputLamports.toString() }
          : { costBasisLamports: (entryInputLamports + feeLamports).toString() }),
      });
      S.counters.wouldHaveEntered++;
      S.attempts[mint] = { at: now, outcome: "shadow", detail: "would have entered; watching" };
      const ceiling = stock
        ? `${units(entryInputLamports, stock.quoteDecimals, stock.quoteSymbol)} (network fee ~${sol(feeLamports).toFixed(4)} SOL beside it)`
        : `${sol(entryInputLamports).toFixed(4)} SOL`;
      say(`${short(mint)}${notice?.raw?.symbol ? ` (${notice.raw.symbol})` : ""}: cleared — would have entered for at most ${ceiling}; ${armed() ? `watching ${Math.round(config.entryWaitMs / 1000)}s before ${onAutopilot() ? "the autopilot wallet signs" : "asking Phantom"}` : "watching"}`);
      persist();
      return { verdict, entered: true, paper: true, position: filed };
    } catch (error) {
      say(`${short(mint)}: the book refused the would-have-fill (${error.clause ?? error.name}): ${error.message}`);
      persist();
      return { verdict, entered: false };
    }
  }

  /* ── the entry: the live attempt, after the wait ───────────────────────────────────── */
  async function attemptLiveEntry({ pos, now }) {
    const mint = pos.mint;
    const signer = activeSigner();
    const wallet = signer.wallet();
    S.counters.liveAttempts++;
    entryInFlight = mint;
    updateSnipe(S, { ...pos, mint, liveAttempted: true, liveAttemptAt: now });
    emit();
    try {
      /* A stock-quoted watch re-reads its stock's mint on the same call as the curve: the
         pause switch is read at the moment of asking, not at first notice. */
      const stockMint = isStockMint(pos.quoteMint) ? pos.quoteMint : null;
      const refuse = async (gate, message) => {
        S.attempts[mint] = { at: now, outcome: "refused", detail: gate };
        say(`live ${short(mint)}: refused at the re-read, ${gate} — ${message}`);
        await persist();
        return { entered: false, refusedAt: gate, message };
      };
      if (stockMint && canaryState(stockMint) === "blocked") {
        const c = S.stockCanary[stockMint];
        return await refuse("stock_canary_blocked", `an earlier ${pos.quoteSymbol ?? short(stockMint)} buy (${c.signature ?? "no signature"}) landed but ${c.detail} — no further ${pos.quoteSymbol ?? "stock"} buys until you check it and clear the block in the popup`);
      }
      const read = await readAccounts([...adapter.accountsFor(mint).map(String), ...(stockMint ? [stockMint] : [])]);
      const curve = decodeCurve(read, mint);
      const cfg = { ...executeCfg(), noticeMaxMs: Math.max(Number(executeCfg().noticeMaxMs) || 0, Number(config.entryWaitMs) + 20_000) };
      /* THE CANARY. Until one buy in this stock has been read back off the chain, the
         ticket is its minPerTrade, and the contract judges that ticket, not the full one. */
      const canary = stockMint ? canaryState(stockMint) !== "proven" : false;
      let quote = null, quoteNote = null;
      if (stockMint) {
        if (stockQuoteOf(curve) !== null && stockQuoteOf(curve) !== stockMint) quoteNote = `the curve now names ${stockQuoteOf(curve)} as its quote, not ${stockMint}`;
        else ({ quote, note: quoteNote } = quoteArgFor({ quoteMint: stockMint, account: read.accounts[3] ?? null, ticket: canary ? "canary" : "full" }));
      }
      let prepared = null, prepareError = null;
      if (curve) {
        try {
          const ticket = quote ? quote.ticketRaw : BigInt(Math.round(cfg.maxSolPerTrade * Number(LAMPORTS)));
          const plan = planSnipeCeiling({ curve: snipeCurveState(curve), adapter, solLamports: ticket, cfg });
          if (plan?.deliverable && plan.baseOutRaw > 0n && plan.maxQuoteInRaw > 0n)
            prepared = prepareBuy({ mint, wallet, curve, read, baseOutRaw: plan.baseOutRaw, maxQuoteInRaw: plan.maxQuoteInRaw, quote });
        } catch (error) { prepared = null; prepareError = String(error?.message ?? error); }
      }
      const socials = cfg.requireSocials === true
        ? await Promise.resolve(socialsReader({ uri: pos.uri ?? null, timeoutMs: Number(cfg.socialsTimeoutMs) || undefined, fetchImpl })).catch((error) => Object.freeze({ ok: false, clause: "fetch_failed", message: String(error?.message ?? error).slice(0, 160) }))
        : null;
      const verdict = snipeContract({
        notice: { mint, creator: pos.creator ?? null, slot: pos.openedAtSlot ?? null, noticeAt: Number(pos.noticeAt) || Number(pos.openedAt), source: "watch", wallet },
        curve, adapter, cfg, book: bookView(now, { excludeMint: mint, realOnly: true }), nowMs: clock(), control: controlView(),
        mint: read.accounts[2] ?? null, creator: creatorFacts({ creator: pos.creator }, curve), fees: feeModelFor(config, { quoteAtaCreate: quote !== null }),
        instruction: prepared?.instruction ?? null, socials, quote,
      });
      if (!verdict.ok) {
        const why = prepareError && verdict.gate === "instruction_mismatch" ? `${verdict.detail.message} (the buy could not be built: ${prepareError})`
          : quoteNote && verdict.gate === "quote_not_sol" ? `${verdict.detail.message} (${quoteNote})` : verdict.detail.message;
        S.attempts[mint] = { at: now, outcome: "refused", detail: verdict.gate };
        say(`live ${short(mint)}: refused at the re-read, ${verdict.gate} — ${why}`);
        await persist();
        return { verdict, entered: false };
      }
      if (!prepared) {
        S.attempts[mint] = { at: now, outcome: "failed", detail: "no prepared instruction" };
        say(`live ${short(mint)}: cleared the re-read but nothing was prepared to sign — skipped`);
        await persist();
        return { verdict, entered: false };
      }
      if (quote) {
        /* THE SOL DAY STILL BINDS A STOCK BUY. The contract caps the stock in the stock;
           the network fee and the rent of up to two new token accounts are SOL, and they
           are charged to the SOL day like any other lamport this lane spends. */
        const fees = feeModelFor(config, { quoteAtaCreate: true });
        const solCost = BigInt(fees.signatureFeeLamports) + BigInt(fees.prioritizationFeeLamports) + BigInt(fees.rentFeeLamports);
        const deployed = deployedTodaySol(now);
        if (deployed + sol(solCost) > Number(config.dailySolCap) + 1e-12)
          return await refuse("daily_capacity_sol", `this ${quote.symbol} buy pays up to ${sol(solCost).toFixed(6)} SOL of network fee and rent, which would take the SOL day to ${(deployed + sol(solCost)).toFixed(6)} against a ${config.dailySolCap} SOL cap`);
        /* THE WALLET MUST HOLD THE STOCK IT WOULD PAY. Read before Phantom is asked, so a
           wallet that cannot fund the ceiling is a refusal here, not a failed transaction. */
        const held = await rpc.getTokenAccountBalance(prepared.associatedQuoteUser);
        const ceiling = BigInt(verdict.detail.maxQuoteInRaw);
        if (BigInt(held) < ceiling)
          return await refuse("quote_balance_short", `the wallet holds ${units(held, quote.decimals, quote.symbol)} in its ${quote.symbol} account, under the ${units(ceiling, quote.decimals, quote.symbol)} this buy may spend — nothing was ${isAutopilot(signer) ? "signed" : "asked of Phantom"}`);
      }
      if (isAutopilot(signer)) {
        /* THE BUDGET IS THE BALANCE. Read at the moment of asking: the wallet must cover the
           SOL ceiling (a stock buy pays its ticket in the stock), the buy's fee and rent,
           one sell's fee so the position can always leave, and the rent floor. Short of
           that the buy is refused here, by name, before anything is built for signing —
           and were this check wrong, the chain would refuse the spend anyway. */
        const need = autopilotBuyNeedLamports(config, { ticketLamports: quote ? 0n : BigInt(verdict.detail.maxQuoteInRaw), quoteAtaCreate: quote !== null });
        let balance = null;
        try { balance = BigInt(await rpc.getBalance(wallet)); autopilotBalance.wallet = wallet; autopilotBalance.lamports = balance; autopilotBalance.at = clock(); }
        catch { balance = null; }
        if (balance === null) return await refuse("autopilot_balance_unread", "the autopilot wallet's balance could not be read — nothing was signed");
        if (balance < need.total)
          return await refuse("autopilot_balance_short", `the autopilot wallet holds ${sol(balance)} SOL; this buy needs up to ${sol(need.total)} SOL ` +
            `(${quote ? `no SOL ticket — it pays in ${quote.symbol} — ` : `a ${sol(need.ticket)} SOL ceiling, `}${sol(need.buyFees)} SOL of fee and rent, ${sol(need.sellFee)} SOL for the sell, the ${sol(need.reserve)} SOL rent floor). The budget is the balance; nothing was signed`);
      }
      return await enterForReal({ mint, pos, curve, verdict, frictionX: frictionFor(verdict), read, prepared, wallet, now, quote, canary, signer });
    } catch (error) {
      S.counters.entryFailures++;
      S.attempts[mint] = { at: now, outcome: "failed", detail: String(error?.message ?? error) };
      say(`live ${short(mint)}: the live attempt failed before anything was signed — ${error?.message ?? error}`);
      await persist();
      return { entered: false, error: String(error?.message ?? error) };
    } finally {
      entryInFlight = null;
      emit();
    }
  }

  /** Simulate the unsigned bytes on the node and refuse anything the plan did not ask for.
   *  `quote` ({ mint, ata, decimals, symbol }) marks a stock-quoted trade: its spend and
   *  its proceeds are read off the wallet's stock account, and SOL may move by the network
   *  fee and rent caps and nothing more. */
  async function simulateGuard({ txBase64, wallet, ata, mint, side, expected, quote = null }) {
    const addresses = quote ? [wallet, ata, quote.ata] : [wallet, ata];
    const pre = await rpc.getMultipleAccounts(addresses);
    const preLamports = BigInt(pre.accounts[0]?.lamports ?? 0);
    const preBase = tokenAmountOf(pre.accounts[1] ?? null, { mint, owner: wallet }) ?? 0n;
    const sim = await rpc.simulateTransaction(txBase64, { addresses });
    if (sim?.err) throw new TxError("simulation_failed", `simulation failed: ${JSON.stringify(sim.err)}` + (Array.isArray(sim.logs) ? ` — ${sim.logs.slice(-3).join(" | ")}` : ""));
    const post = sim?.accounts;
    if (!Array.isArray(post) || post.length !== addresses.length) throw new TxError("simulation_failed", "simulation omitted the requested accounts");
    const spend = preLamports - BigInt(post[0]?.lamports ?? 0);
    const base = tokenAmountOf(post[1] ? { owner: post[1].owner, data: post[1].data } : null, { mint, owner: wallet }) ?? 0n;
    if (quote) {
      const preQuote = tokenAmountOf(pre.accounts[2] ?? null, { mint: quote.mint, owner: wallet }) ?? 0n;
      const postQuote = tokenAmountOf(post[2] ? { owner: post[2].owner, data: post[2].data } : null, { mint: quote.mint, owner: wallet }) ?? 0n;
      const feeCap = BigInt(SNIPE_LANE_DEFAULTS.maxNetworkFeeLamports), rentCap = BigInt(SNIPE_LANE_DEFAULTS.maxRentLamports);
      const u = (raw) => units(raw, quote.decimals, quote.symbol);
      if (side === "buy") {
        const took = preQuote - postQuote;
        if (took > expected.maxQuoteInRaw) throw new TxError("simulation_failed", `the buy would take ${u(took)} against the ${u(expected.maxQuoteInRaw)} ceiling`);
        if (took <= 0n) throw new TxError("simulation_failed", `the buy would take no ${quote.symbol} from the wallet — it is not paying in the quote it names`);
        if (spend > feeCap + rentCap) throw new TxError("simulation_failed", `the buy would spend ${spend} lamports of SOL; a ${quote.symbol}-quoted buy pays SOL for the network fee and rent only (caps ${feeCap} + ${rentCap}) — an unexplained drain`);
        const delta = base - preBase;
        if (delta < expected.baseOutRaw) throw new TxError("simulation_failed", `the buy would deliver ${delta} base against the ${expected.baseOutRaw} the instruction asked for`);
        return { spend, quoteDeltaRaw: -took, units: Number(sim.unitsConsumed) || null, post };
      }
      const delta = preBase - base;
      if (delta !== expected.qtyRaw) throw new TxError("simulation_failed", `the sell would move ${delta} base, not the ${expected.qtyRaw} the position holds`);
      const got = postQuote - preQuote;
      if (got < expected.minQuoteOutRaw) throw new TxError("simulation_failed", `the sell would return ${u(got)}, under the ${u(expected.minQuoteOutRaw)} floor`);
      const allowance = feeCap + (pre.accounts[2] ? 0n : rentCap);
      if (spend > allowance) throw new TxError("simulation_failed", `the sell would spend ${spend} lamports of SOL against a ${allowance} allowance for the fee${pre.accounts[2] ? "" : " and the re-created " + quote.symbol + " account"}`);
      return { spend, quoteDeltaRaw: got, units: Number(sim.unitsConsumed) || null, post };
    }
    if (side === "buy") {
      const allowance = expected.maxQuoteInRaw + BigInt(SNIPE_LANE_DEFAULTS.maxNetworkFeeLamports) + BigInt(SNIPE_LANE_DEFAULTS.maxRentLamports);
      if (spend > allowance) throw new TxError("simulation_failed", `the buy would spend ${spend} lamports against a ceiling of ${expected.maxQuoteInRaw} plus the fee and rent caps — an unexplained drain`);
      const delta = base - preBase;
      if (delta < expected.baseOutRaw) throw new TxError("simulation_failed", `the buy would deliver ${delta} base against the ${expected.baseOutRaw} the instruction asked for`);
    } else {
      const delta = preBase - base;
      if (delta !== expected.qtyRaw) throw new TxError("simulation_failed", `the sell would move ${delta} base, not the ${expected.qtyRaw} the position holds`);
      const proceeds = -spend;
      if (proceeds < expected.minQuoteOutRaw - BigInt(SNIPE_LANE_DEFAULTS.maxNetworkFeeLamports))
        throw new TxError("simulation_failed", `the sell would return ${proceeds} lamports, under the ${expected.minQuoteOutRaw} floor less the fee cap`);
    }
    return { spend, units: Number(sim.unitsConsumed) || null };
  }

  /** Ask the signer (Phantom's window, or the autopilot wallet), check what came back is
   *  what was asked, send it, wait for the chain. */
  async function signSendConfirm({ txBase64, purpose, mint, summary, lastValidBlockHeight, timeoutMs, wallet, signer = bridge }) {
    S.counters.signRequests++;
    let signed;
    try { signed = await signer.signTransaction({ txBase64, purpose, mint, summary, timeoutMs, wallet }); }
    catch (error) {
      if (error?.code === SIGN_ERRORS.REJECTED) S.counters.signRejected++;
      if (error?.code === SIGN_ERRORS.TIMEOUT) S.counters.signTimeouts++;
      throw error;
    }
    const unsignedBytes = fromBase64(txBase64);
    const signedBytes = fromBase64(signed?.signedBase64 ?? signed);
    if (!sameMessage(unsignedBytes, signedBytes)) throw new TxError("tampered", `the transaction ${isAutopilot(signer) ? "the autopilot wallet" : "Phantom"} returned is not the one it was asked to sign — refusing to send it`);
    const signature = signatureOf(signedBytes);
    const signedB64 = toBase64(signedBytes);
    const sends = await Promise.allSettled([rpc, secondaryRpc].filter(Boolean).map((r) => r.sendTransaction(signedB64)));
    if (sends.every((s) => s.status === "rejected")) say(`${purpose} ${signature}: no provider accepted it (${sends.map((s) => s.reason?.message ?? s.reason).join("; ")}) — awaiting expiry`);
    const verdict = await awaitConfirmed({ signature, lastValidBlockHeight });
    if (verdict.outcome === "failed") throw new TxError("failed_on_chain", `${purpose} ${signature} failed on chain: ${JSON.stringify(verdict.err)}`, { signature });
    if (verdict.outcome === "expired") throw new TxError("expired", `${purpose} ${signature} expired unlanded`, { signature });
    if (verdict.outcome === "pending") throw new TxError("ambiguous", `${purpose} ${signature} has no status after the confirm window — check the explorer before acting`, { signature });
    let tx = null;
    for (let i = 0; i < 8 && !tx; i++) {
      try { tx = await rpc.getTransaction(signature); } catch { tx = null; }
      if (!tx) await sleep(500);
    }
    if (!tx) throw new TxError("ambiguous", `${purpose} ${signature} confirmed but could not be read back`, { signature });
    return { signature, tx };
  }
  const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));
  async function awaitConfirmed({ signature, lastValidBlockHeight, timeoutMs = 60_000 }) {
    const deadline = clock() + timeoutMs;
    for (;;) {
      let status = null;
      try { status = await rpc.getSignatureStatus(signature); } catch { status = null; }
      if (status) {
        if (status.err) return { outcome: "failed", err: status.err };
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return { outcome: "confirmed" };
      }
      let height = null;
      try { height = await rpc.getBlockHeight(); } catch { height = null; }
      if (Number.isFinite(height) && Number.isFinite(lastValidBlockHeight) && height > lastValidBlockHeight + 8) return { outcome: "expired" };
      if (clock() > deadline) return { outcome: "pending" };
      await sleep(700);
    }
  }

  async function enterForReal({ mint, pos, curve, verdict, frictionX, read, prepared, wallet, now, quote = null, canary = false, signer = bridge }) {
    if (quote) return enterStockForReal({ mint, pos, curve, verdict, frictionX, read, prepared, wallet, now, quote, canary, signer });
    const auto = isAutopilot(signer);
    S.attempts[mint] = { at: now, outcome: "signing", detail: auto ? "the autopilot wallet is signing" : "waiting for Phantom" };
    emit();
    const baseOutRaw = BigInt(verdict.detail.baseOutRaw), maxQuoteInRaw = BigInt(verdict.detail.maxQuoteInRaw);
    try {
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const tx = buildUnsignedTransaction({
        payer: wallet, blockhash, computeUnitLimit: config.computeUnitLimit, priorityFeeLamports: config.priorityFeeLamports,
        instructions: [
          createAtaIdempotentIx({ payer: wallet, ata: prepared.associatedBaseUser, owner: wallet, mint, tokenProgram: prepared.baseTokenProgram }),
          toTransactionInstruction(prepared.instruction),
        ],
      });
      const txBase64 = toBase64(tx.serialize());
      await simulateGuard({ txBase64, wallet, ata: prepared.associatedBaseUser, mint, side: "buy", expected: { baseOutRaw, maxQuoteInRaw } });
      const summary = `BUY ${pos.symbol ?? short(mint)} — up to ${sol(maxQuoteInRaw).toFixed(4)} SOL for ${baseOutRaw} base units`;
      if (!auto) notify({ kind: "buy", mint, title: "COINMARKETCAT: approve the buy in Phantom", body: summary });
      const { signature, tx: landed } = await signSendConfirm({ txBase64, purpose: "buy", mint, summary, lastValidBlockHeight, timeoutMs: config.approvalTimeoutMs, wallet, signer });
      const fill = fillFromTransaction(landed, { wallet, mint, side: "buy" });
      const openedAt = clock();
      const entryInputLamports = BigInt(fill.quoteInRaw);
      const paidFee = BigInt(fill.feeLamports);
      const creator = pos.creator ?? curve?.creator ?? null;
      const position = determiner.open({ mint, entry: 1, openedAt, creator, sizeSol: sol(entryInputLamports), feeSolPerLeg: sol(paidFee) });
      /* The would-have row steps aside for the fill: one mint, one position. Its shadow
         row keeps sampling off the live position's ticks. */
      const paper = snipeFor(S, mint);
      if (paper) closeSnipe(S, mint, { reason: "superseded by the live fill", closedAt: openedAt });
      let filed;
      try {
        filed = openSnipe(S, {
          ...position, mint, venue: adapter.id, entry: 1, openedAt, sizeSol: sol(entryInputLamports), feeSolPerLeg: sol(paidFee),
          qtyRaw: fill.qtyRaw, entryInputLamports: entryInputLamports.toString(), entryFeeLamports: paidFee.toString(),
          creator, openedAtSlot: Number.isFinite(Number(fill.slot)) ? Number(fill.slot) : read.slot,
          frictionXAtOpen: frictionX, samples: 0, live: true, entrySignature: signature, wallet,
          name: pos.name ?? null, symbol: pos.symbol ?? null, uri: pos.uri ?? null, noticeAt: pos.noticeAt ?? null,
          msSinceNotice: openedAt - (Number(pos.noticeAt) || Number(pos.openedAt)),
          associatedBaseUser: prepared.associatedBaseUser, baseTokenProgram: prepared.baseTokenProgram,
          costBasisLamports: (entryInputLamports + paidFee).toString(),
          shadowSampledAt: paper?.shadowSampledAt ?? null, shadowSamples: paper?.shadowSamples ?? 0,
        });
      } catch (error) {
        S.counters.entryFailures++;
        S.attempts[mint] = { at: now, outcome: "unbooked", detail: `bought (${signature}) but the book refused the fill: ${error.message}` };
        say(`live ${short(mint)}: BOUGHT BUT THE BOOK REFUSED THE FILL (${error.clause ?? error.name}): ${error.message} — sig ${signature}; sell this by hand`);
        notify({ kind: "attention", mint, title: "COINMARKETCAT: a fill the book refused", body: `${short(mint)} was bought (${signature}) but could not be booked. Sell it by hand.` });
        charge("entry", entryInputLamports + paidFee, openedAt);
        await persist();
        return { verdict, entered: false, signature };
      }
      S.counters.entered++;
      S.attempts[mint] = { at: now, outcome: "entered", detail: signature };
      charge("entry", entryInputLamports + paidFee, openedAt);
      say(`live ${short(mint)}: ENTERED — ${fill.qtyRaw} base for ${entryInputLamports} lamports plus ${paidFee} fee, ${Math.round(filed.msSinceNotice / 1000)}s after the notice, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signature}`);
      if (auto) {
        notify({ kind: "buy", mint, title: "COINMARKETCAT autopilot: bought", body: `${pos.symbol ?? short(mint)} for ${sol(entryInputLamports).toFixed(4)} SOL, signed by the autopilot wallet without a window.` });
        refreshAutopilotBalance({ force: true }).catch(() => {});
      }
      await persist();
      return { verdict, entered: true, paper: false, position: filed, signature };
    } catch (error) {
      S.counters.entryFailures++;
      const code = error?.code ?? error?.clause ?? error?.name ?? "error";
      S.attempts[mint] = { at: now, outcome: "failed", detail: `${code}: ${error?.message ?? error}` };
      if (code === SIGN_ERRORS.REJECTED) say(`live ${short(mint)}: you declined the buy in Phantom — the would-have row keeps watching`);
      else if (code === SIGN_ERRORS.TIMEOUT) say(`live ${short(mint)}: the Phantom window sat ${config.approvalTimeoutMs}ms without an answer — abandoned; the would-have row keeps watching`);
      else say(`live ${short(mint)}: ENTRY FAILED (${code}): ${error?.message ?? error}`);
      if (code === "failed_on_chain") charge("failed_entry_fee", BigInt(SNIPE_LANE_DEFAULTS.signatureFeeLamports) + BigInt(config.priorityFeeLamports), now);
      await persist();
      return { verdict, entered: false, error: String(error?.message ?? error), code };
    }
  }

  /**
   * A BUY PAID IN A STOCK. The same path as a SOL buy — build, simulate, one Phantom
   * window, the same-message check, send, confirm, read back, book, charge — with the
   * stock's own accounting at every step:
   *   · two idempotent account creates, the launch token's and the stock's, each under
   *     its own mint's program (an xStock account is Token-2022, 179 bytes);
   *   · the simulate guard reads the stock account's delta: the buy may take at most the
   *     ceiling, must take something, and may move SOL by the fee and rent caps only;
   *   · the fill is read from the transaction's token balances in the stock's decimals,
   *     and every lamport that left the wallet must be the fee or the rent;
   *   · the stock is charged to its own day, the SOL fee and rent to the SOL day;
   *   · the book row is quoted in the stock (feeSolPerLeg 0, networkFeeLamports beside);
   *   · THE CANARY: the first buy in a stock is proven by reading it back. A landed buy
   *     whose fill cannot be read or booked BLOCKS further buys in that stock, loudly,
   *     until the user clears it in the popup.
   */
  async function enterStockForReal({ mint, pos, curve, verdict, frictionX, read, prepared, wallet, now, quote, canary, signer = bridge }) {
    const auto = isAutopilot(signer);
    S.attempts[mint] = { at: now, outcome: "signing", detail: auto ? "the autopilot wallet is signing" : "waiting for Phantom" };
    emit();
    const baseOutRaw = BigInt(verdict.detail.baseOutRaw), maxQuoteInRaw = BigInt(verdict.detail.maxQuoteInRaw);
    const u = (raw) => units(raw, quote.decimals, quote.symbol);
    const fees = feeModelFor(config, { quoteAtaCreate: true });
    const modelledLamports = BigInt(fees.signatureFeeLamports) + BigInt(fees.prioritizationFeeLamports) + BigInt(fees.rentFeeLamports);
    let signature = null;
    try {
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const tx = buildUnsignedTransaction({
        payer: wallet, blockhash, computeUnitLimit: config.computeUnitLimit, priorityFeeLamports: config.priorityFeeLamports,
        instructions: [
          createAtaIdempotentIx({ payer: wallet, ata: prepared.associatedBaseUser, owner: wallet, mint, tokenProgram: prepared.baseTokenProgram }),
          createAtaIdempotentIx({ payer: wallet, ata: prepared.associatedQuoteUser, owner: wallet, mint: quote.mint, tokenProgram: prepared.quoteTokenProgram }),
          toTransactionInstruction(prepared.instruction),
        ],
      });
      const txBase64 = toBase64(tx.serialize());
      await simulateGuard({ txBase64, wallet, ata: prepared.associatedBaseUser, mint, side: "buy", expected: { baseOutRaw, maxQuoteInRaw },
        quote: { mint: quote.mint, ata: prepared.associatedQuoteUser, decimals: quote.decimals, symbol: quote.symbol } });
      const summary = `BUY ${pos.symbol ?? short(mint)} — up to ${u(maxQuoteInRaw)} for ${baseOutRaw} base units` +
        `${canary ? ` (the ${quote.symbol} canary: sized at its minimum until one ${quote.symbol} buy is read back)` : ""}; network fee and rent in SOL`;
      if (!auto) notify({ kind: "buy", mint, title: "COINMARKETCAT: approve the buy in Phantom", body: summary });
      const signed = await signSendConfirm({ txBase64, purpose: "buy", mint, summary, lastValidBlockHeight, timeoutMs: config.approvalTimeoutMs, wallet, signer });
      signature = signed.signature;
      const landed = signed.tx;
      /* From here the buy has LANDED. A failure below is not "the entry failed"; it is a
         position the wallet holds that this book may not know about. */
      let fill;
      try { fill = fillFromTransaction(landed, { wallet, mint, side: "buy", quoteMint: quote.mint, quoteDecimals: quote.decimals }); }
      catch (error) {
        return await blockStock({ mint, quote, signature, now, verdict, maxQuoteInRaw, modelledLamports,
          detail: `its fill could not be read back (${error?.message ?? error})` });
      }
      const openedAt = clock();
      const quoteInRaw = BigInt(fill.quoteInRaw);
      const paidLamports = BigInt(fill.feeLamports) + BigInt(fill.rentLamports);
      const sizeSol = Number(quoteInRaw) / 10 ** quote.decimals;
      const creator = pos.creator ?? curve?.creator ?? null;
      const position = determiner.open({ mint, entry: 1, openedAt, creator, sizeSol, feeSolPerLeg: 0 });
      const paper = snipeFor(S, mint);
      if (paper) closeSnipe(S, mint, { reason: "superseded by the live fill", closedAt: openedAt });
      let filed;
      try {
        filed = openSnipe(S, {
          ...position, mint, venue: adapter.id, entry: 1, openedAt, sizeSol, feeSolPerLeg: 0,
          qtyRaw: fill.qtyRaw, entryInputLamports: quoteInRaw.toString(), entryFeeLamports: "0",
          quoteMint: quote.mint, quoteDecimals: quote.decimals, quoteSymbol: quote.symbol, quoteTokenProgram: prepared.quoteTokenProgram,
          networkFeeLamports: paidLamports.toString(), costBasisQuoteRaw: quoteInRaw.toString(),
          creator, openedAtSlot: Number.isFinite(Number(fill.slot)) ? Number(fill.slot) : read.slot,
          frictionXAtOpen: frictionX, samples: 0, live: true, entrySignature: signature, wallet, canary,
          name: pos.name ?? null, symbol: pos.symbol ?? null, uri: pos.uri ?? null, noticeAt: pos.noticeAt ?? null,
          msSinceNotice: openedAt - (Number(pos.noticeAt) || Number(pos.openedAt)),
          associatedBaseUser: prepared.associatedBaseUser, associatedQuoteUser: prepared.associatedQuoteUser, baseTokenProgram: prepared.baseTokenProgram,
          shadowSampledAt: paper?.shadowSampledAt ?? null, shadowSamples: paper?.shadowSamples ?? 0,
        });
      } catch (error) {
        chargeStock("entry", { quoteMint: quote.mint, quoteRaw: quoteInRaw, quoteDecimals: quote.decimals, lamports: paidLamports }, openedAt);
        return await blockStock({ mint, quote, signature, now, verdict, charged: true,
          detail: `the book refused its fill (${error.clause ?? error.name}: ${error.message})` });
      }
      S.counters.entered++;
      S.attempts[mint] = { at: now, outcome: "entered", detail: signature };
      chargeStock("entry", { quoteMint: quote.mint, quoteRaw: quoteInRaw, quoteDecimals: quote.decimals, lamports: paidLamports }, openedAt);
      if (canaryState(quote.mint) !== "proven") {
        S.stockCanary[quote.mint] = { state: "proven", at: openedAt, signature, mint, quoteInRaw: quoteInRaw.toString(), qtyRaw: fill.qtyRaw };
        say(`the ${quote.symbol} canary buy was read back off the chain (sig ${signature}): later ${quote.symbol} buys may use the full ${quoteEntryFor(config, quote.mint)?.maxPerTrade ?? "configured"} ${quote.symbol} ticket`);
      }
      say(`live ${short(mint)}: ENTERED — ${fill.qtyRaw} base for ${u(quoteInRaw)}${canary ? " (the canary)" : ""}, plus ${paidLamports} lamports of network fee and rent in SOL, ${Math.round(filed.msSinceNotice / 1000)}s after the notice, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signature}`);
      if (auto) {
        notify({ kind: "buy", mint, title: "COINMARKETCAT autopilot: bought", body: `${pos.symbol ?? short(mint)} for ${u(quoteInRaw)}, signed by the autopilot wallet without a window.` });
        refreshAutopilotBalance({ force: true }).catch(() => {});
      }
      await persist();
      return { verdict, entered: true, paper: false, position: filed, signature };
    } catch (error) {
      S.counters.entryFailures++;
      const code = error?.code ?? error?.clause ?? error?.name ?? "error";
      S.attempts[mint] = { at: now, outcome: "failed", detail: `${code}: ${error?.message ?? error}` };
      if (code === SIGN_ERRORS.REJECTED) say(`live ${short(mint)}: you declined the ${quote.symbol} buy in Phantom — the would-have row keeps watching`);
      else if (code === SIGN_ERRORS.TIMEOUT) say(`live ${short(mint)}: the Phantom window sat ${config.approvalTimeoutMs}ms without an answer — abandoned; the would-have row keeps watching`);
      else say(`live ${short(mint)}: ENTRY FAILED (${code}): ${error?.message ?? error}`);
      if (code === "failed_on_chain") charge("failed_entry_fee", BigInt(SNIPE_LANE_DEFAULTS.signatureFeeLamports) + BigInt(config.priorityFeeLamports), now);
      await persist();
      return { verdict, entered: false, error: String(error?.message ?? error), code };
    }
  }

  /** A stock buy that landed and could not be read back or booked. The wallet holds a
   *  position this book does not: say so everywhere, charge the day as if the ceiling was
   *  spent (unless the real figures were charged already), and block the stock. */
  async function blockStock({ mint, quote, signature, now, verdict, detail, maxQuoteInRaw = 0n, modelledLamports = 0n, charged = false }) {
    S.counters.entryFailures++;
    if (!charged) chargeStock("entry_unread", { quoteMint: quote.mint, quoteRaw: maxQuoteInRaw, quoteDecimals: quote.decimals, lamports: modelledLamports }, clock());
    S.stockCanary[quote.mint] = { state: "blocked", at: clock(), signature, mint, detail };
    S.attempts[mint] = { at: now, outcome: "unbooked", detail: `bought (${signature}) but ${detail}` };
    say(`live ${short(mint)}: BOUGHT WITH ${quote.symbol} BUT ${detail} — sig ${signature}; sell it by hand. ` +
      `${quote.symbol} buys are BLOCKED until you check that signature and clear the block in the popup`);
    notify({ kind: "attention", mint, title: `COINMARKETCAT: a ${quote.symbol} buy the book could not take`, body: `${short(mint)} was bought (${signature}) but ${detail}. Sell it by hand. ${quote.symbol} buys are blocked until you clear them.` });
    await persist();
    return { verdict, entered: false, signature, blocked: true };
  }

  /** The user checked a blocked stock's signature and clears the block: the next buy in
   *  that stock is a canary again. A proven stock stays proven. */
  async function clearStockCanary(quoteMint, { venue = null } = {}) {
    await load();
    if (venue === XSTOCK_VENUE_ID) { const done = await xstock.clearBlock(quoteMint); emit(); return done; }
    const c = S.stockCanary[quoteMint];
    if (!c || c.state !== "blocked") return false;
    delete S.stockCanary[quoteMint];
    say(`${quoteEntryFor(config, quoteMint)?.symbol ?? short(quoteMint)}: the block is cleared by the operator — the next buy in it is a canary at its minPerTrade`);
    await persist();
    emit();
    return true;
  }

  /* ── the held position ─────────────────────────────────────────────────────────────── */
  async function tick() {
    await load();
    if (ticking) return [];
    ticking = true;
    try {
      /* On autopilot the checklist reads the wallet's balance; keep it no older than 15 s. */
      if (onAutopilot()) await refreshAutopilotBalance();
      const out = [];
      for (const pos of snipeList(S)) {
        try { out.push(await stepOne(pos)); }
        catch (error) { say(`${short(pos.mint)}: tick failed — ${error?.message ?? error}`); }
      }
      return out;
    } finally { ticking = false; }
  }

  async function stepOne(pos) {
    const mint = pos.mint;
    const now = clock();
    const live = pos.live === true;
    /* Would-have rows are read at the shadow book's cadence, live rows at the lane's. */
    if (!live && pos.lastTickAt && now - Number(pos.lastTickAt) < Number(config.forwardIntervalMs) - 50) return { mint, action: "hold", skipped: true };
    const eff = observeCfg();
    const entryAddresses = adapter.accountsFor(mint).map(String);
    const creatorAddresses = typeof adapter.accountsForHeld === "function" ? adapter.accountsForHeld(mint, { creator: pos.creator ?? null }).map(String) : entryAddresses;
    /* A stock-quoted position reads its stock's mint on the same call, after the
       deployer's accounts: a paused stock cannot settle a sell, and the lane says so. */
    const stockMint = isStockMint(pos.quoteMint) ? pos.quoteMint : null;
    const heldAddresses = stockMint ? [...creatorAddresses, stockMint] : creatorAddresses;
    const read = await readAccounts(heldAddresses);
    const curve = decodeCurve(read, mint);
    let markX = null;
    if (curve) {
      try { markX = curveExitMarkX({ curve, qtyRaw: pos.qtyRaw, entryInputLamports: pos.entryInputLamports, adapter }); } catch { markX = null; }
    }
    let quotePaused = null;
    if (stockMint) {
      try { quotePaused = describeQuote(read.accounts[creatorAddresses.length] ?? null, stockMint).paused === true; }
      catch { quotePaused = null; }       // unreadable this tick: not a fact either way
    }

    /* The creator's balance against a baseline taken at the first readable tick; a fall
       of creatorExitFrac or more is the creator leaving, which sells the whole position. */
    let creatorExited = false, creatorNote = null;
    let creatorBaselineRaw = pos.creatorBaselineRaw ?? null;
    if (pos.creator && creatorAddresses.length > entryAddresses.length) {
      const first = entryAddresses.length;
      const amountFrom = (accounts) => {
        let total = null;
        for (let i = first; i < creatorAddresses.length; i++) {
          const amt = adapter.decodeTokenAmount?.(accounts?.[i], { mint, owner: pos.creator });
          if (amt === null || amt === undefined) continue;
          total = (total ?? 0n) + amt;
        }
        return total;
      };
      const perEndpoint = (read.all ?? []).map((v) => amountFrom(v.accounts));
      const answered = perEndpoint.filter((v) => v !== null);
      const unanimous = answered.length === perEndpoint.length && answered.length > 0 && answered.every((v) => v === answered[0]);
      if (unanimous) {
        const nowRaw = answered[0];
        if (creatorBaselineRaw === null) { creatorBaselineRaw = String(nowRaw); creatorNote = nowRaw === 0n ? "creator held nothing at the first readable tick" : null; }
        else {
          const base = BigInt(creatorBaselineRaw);
          if (base > 0n) {
            const frac = Number((base - nowRaw) * 10000n / base) / 10000;
            if (frac >= Number(eff.creatorExitFrac)) {
              creatorExited = true;
              creatorNote = `the deployer's balance fell ${(frac * 100).toFixed(1)}% (${base} -> ${nowRaw}) — sold or moved out`;
            }
          }
        }
      } else if (answered.length) creatorNote = "endpoints disagree on the deployer's balance — not acting on one node's word";
    }
    if (read.verdict === "disagree") markX = null;

    const step = determiner.step({
      position: pos, markX, nowMs: now, cfg: eff, hardStop: control.hardStop === true,
      creatorSold: creatorExited, creatorSoldDetail: creatorExited ? creatorNote : null, rugFlag: false,
      sample: { markX, nowMs: now, slot: read.slot },
    });
    const samples = Number(pos.samples ?? 0) + 1;
    let shadowSamples = Number(pos.shadowSamples ?? 0);
    let shadowSampledAt = pos.shadowSampledAt ?? null;
    if (shadowSampledAt === null || now - Number(shadowSampledAt) >= Number(config.forwardIntervalMs) - 50) {
      shadowSamples++;
      shadowSampledAt = now;
      try {
        shadow.observe(mint, {
          atMs: now, slot: read.slot,
          slotDelta: Number.isFinite(pos.openedAtSlot) && Number.isFinite(read.slot) ? read.slot - pos.openedAtSlot : null,
          msAfterFill: now - Number(pos.openedAt), markX, realQuoteRaw: curve?.realQuoteRaw ?? null, complete: curve?.complete === true,
          endpointVerdict: read.verdict, action: step?.action ?? null, reason: step?.reason ?? null, creatorBaselineRaw, creatorNote,
        });
      } catch { /* a sample the book refused is one row short, not a decision */ }
    }
    const aged = now - Number(pos.openedAt) >= Number(eff.holdMaxMs);
    const wantsSell = step?.action === "sell" || aged;
    const reason = step?.action === "sell" ? step.reason : aged ? `hold clock: ${Math.round(Number(eff.holdMaxMs) / 1000)}s in the position` : null;
    const carried = { ...pos, ...(isPlainObject(step?.position) ? step.position : {}), mint, samples, shadowSamples, shadowSampledAt, creatorBaselineRaw, lastMarkX: markX, lastTickAt: now, complete: curve?.complete === true,
      ...(stockMint ? { quotePaused } : {}) };
    if (stockMint && live && quotePaused === true && pos.quotePaused !== true) {
      say(`live ${short(mint)}: the ${pos.quoteSymbol ?? "quote"} mint is PAUSED by its issuer — no transfer of it can settle, so this position cannot be sold until it is unpaused. The lane keeps reading it every tick`);
      notify({ kind: "attention", mint, title: `COINMARKETCAT: ${pos.quoteSymbol ?? "the quote"} is paused`, body: `${pos.symbol ?? short(mint)} is held against ${pos.quoteSymbol ?? "a stock"}, which its issuer has paused. Nothing can be sold until it is unpaused.` });
    } else if (stockMint && live && quotePaused === false && pos.quotePaused === true) say(`live ${short(mint)}: the ${pos.quoteSymbol ?? "quote"} mint is unpaused — sells can settle again`);

    if (!live) {
      /* THE WATCH. In an armed lane a would-have row that has waited long enough and
         still marks at or above its own fill is the launch this lane buys. */
      const waited = now - Number(pos.openedAt) >= Number(config.entryWaitMs);
      const followed = Number(config.entryFollowThroughX) <= 0 || (markX !== null && markX >= Number(config.entryFollowThroughX));
      /* One live position at a time by default, across both venues. */
      const openLive = snipeList(S).filter((p) => p.live === true).length + xstock.liveCount();
      if (armed() && !pos.liveAttempted && !wantsSell && waited && entryInFlight === null && openLive < config.maxOpenPositions && !control.pauseEntries && !control.hardStop) {
        if (followed) {
          updateSnipe(S, carried);
          return attemptLiveEntry({ pos: snipeFor(S, mint), now });
        }
        if (markX !== null) {
          S.counters.waitedOut++;
          updateSnipe(S, { ...carried, liveAttempted: true, waitedOut: `marked ${markX.toFixed(3)}x after ${Math.round((now - Number(pos.openedAt)) / 1000)}s — nobody followed` });
          say(`${short(mint)}: waited ${Math.round(config.entryWaitMs / 1000)}s and it marks ${markX.toFixed(3)}x of the would-have fill — nobody followed; not buying`);
          return { mint, action: "hold", markX, closed: false, waitedOut: true };
        }
      }
      const windowDone = shadowSamples >= Number(config.forwardSamples);
      if (!wantsSell && !windowDone) { updateSnipe(S, carried); if (samples % 5 === 1) persist(); emit(); return { mint, action: "hold", markX, closed: false }; }
      const realized = markX === null ? null : BigInt(Math.floor(markX * Number(BigInt(pos.entryInputLamports)))) - BigInt(Math.round(Number(pos.feeSolPerLeg) * Number(LAMPORTS)));
      const closeReason = wantsSell ? reason : `window closed: ${shadowSamples} forward samples`;
      const closed = closeSnipe(S, mint, { reason: closeReason, closedAt: now, markX, realizedLamports: realized === null ? null : realized.toString(), paper: true });
      try { shadow.close(mint, { action: wantsSell ? "would_have_exited" : "window_closed", reason: closeReason, atMs: now, slot: read.slot }); } catch { /* recorded without an outcome */ }
      recordClose({ closed, pos, realized, now, signature: null });
      say(`shadow ${short(mint)}: ${wantsSell ? "would have SOLD" : "window closed"} — ${closeReason} (mark ${markX === null ? "unread" : markX.toFixed(4)}x)`);
      await persist();
      return { mint, action: wantsSell ? "sell" : "hold", markX, closed: true, paper: true };
    }

    if (!wantsSell) { updateSnipe(S, carried); if (samples % 5 === 1) persist(); emit(); return { mint, action: "hold", markX, closed: false }; }
    updateSnipe(S, carried);
    return sellForReal({ pos: snipeFor(S, mint), curve, read, markX, reason, now, quotePaused });
  }

  async function sellForReal({ pos, curve, read, markX, reason, now, quotePaused = null }) {
    const mint = pos.mint;
    if (sellInFlight.has(mint)) return { mint, action: "sell", markX, closed: false, pending: true };
    if (pos.pendingSell && now - Number(pos.pendingSell.askedAt) < Number(config.sellReaskMs)) return { mint, action: "sell", markX, closed: false, pending: true };
    if (!curve) { say(`live ${short(mint)}: the determiner says sell (${reason}) but the curve is unreadable this tick — asking again next tick`); return { mint, action: "sell", markX, closed: false, pending: true }; }
    const stock = isStockMint(pos.quoteMint)
      ? { mint: pos.quoteMint, decimals: pos.quoteDecimals, symbol: pos.quoteSymbol ?? short(pos.quoteMint), tokenProgram: pos.quoteTokenProgram ?? TOKEN_PROGRAM }
      : null;
    if (stock && quotePaused === true) {
      /* A paused quote mint moves nothing: asking Phantom would sign a transaction that
         cannot land. Held, said once per re-ask interval, re-read every tick. */
      if (!pos.pausedSellNotedAt || now - Number(pos.pausedSellNotedAt) >= Number(config.sellReaskMs)) {
        updateSnipe(S, { ...pos, mint, pausedSellNotedAt: now });
        say(`live ${short(mint)}: the determiner says sell (${reason}) but ${stock.symbol} is paused by its issuer — the sell cannot settle; holding and re-reading every tick`);
      }
      return { mint, action: "sell", markX, closed: false, pending: true, paused: true };
    }
    const heldByAutopilot = sessionSigner !== null && Boolean(pos.wallet) && sessionSigner.wallet() === pos.wallet;
    if (curve.complete === true) {
      if (!pos.graduated) {
        updateSnipe(S, { ...pos, mint, graduated: true });
        say(heldByAutopilot
          ? `live ${short(mint)}: the curve has graduated to a pool — this lane sells on the curve only, and the tokens are in the autopilot wallet. Press Forget on the row, then Sweep back sends them to Phantom: SELL THEM BY HAND there`
          : `live ${short(mint)}: the curve has graduated to a pool — this lane sells on the curve only. SELL IT BY HAND on pump.fun or Jupiter, then press Forget on the row`);
        notify({ kind: "attention", mint, title: "COINMARKETCAT: sell by hand", body: heldByAutopilot
          ? `${pos.symbol ?? short(mint)} graduated to a pool. The lane cannot sell it: Forget the row, Sweep back to Phantom, and sell it there.`
          : `${pos.symbol ?? short(mint)} graduated to a pool. The lane cannot sell it; sell it yourself.` });
        await persist();
      }
      return { mint, action: "sell", markX, closed: false, graduated: true };
    }
    /* THE SELL IS SIGNED BY WHOEVER HOLDS THE POSITION, whatever the mode is now. */
    const signer = pos.wallet ? signerHolding(pos.wallet) : bridge;
    const wallet = signer ? signer.wallet() : null;
    if (!signer || !wallet || (pos.wallet && wallet !== pos.wallet)) { say(`live ${short(mint)}: Phantom is not connected as the wallet that holds this position (${pos.wallet ?? "?"})`); return { mint, action: "sell", markX, closed: false, pending: true }; }
    const auto = isAutopilot(signer);
    if (auto && !readyOf(signer)) {
      /* A LOCKED AUTOPILOT WALLET CANNOT SELL. Said once per re-ask interval, loudly: the
         determiner still says sell, and only the passphrase can let it. */
      if (!pos.lockedSellNotedAt || now - Number(pos.lockedSellNotedAt) >= Number(config.sellReaskMs)) {
        updateSnipe(S, { ...pos, mint, lockedSellNotedAt: now });
        say(`live ${short(mint)}: the determiner says sell (${reason}) but the autopilot wallet that holds it is LOCKED — unlock it in the popup and it sells on the next tick`);
        notify({ kind: "sell", mint, title: "COINMARKETCAT: unlock the autopilot wallet to sell", body: `${pos.symbol ?? short(mint)} should be sold (${reason}), and the autopilot wallet holding it is locked. Unlock it in the popup.` });
      }
      return { mint, action: "sell", markX, closed: false, pending: true, locked: true };
    }
    sellInFlight.add(mint);
    try {
      const ata = pos.associatedBaseUser ?? associatedTokenAddress(wallet, mint, pos.baseTokenProgram ?? TOKEN_PROGRAM);
      const held = await rpc.getTokenAccountBalance(ata);
      if (held <= 0n) {
        const closed = closeSnipe(S, mint, { reason: "gone: the wallet holds none of this mint — sold or moved by hand", closedAt: now, markX, realizedLamports: null, paper: false });
        try { shadow.close(mint, { action: "reconciled", reason: closed.reason, atMs: now, slot: read.slot }); } catch { /* fine */ }
        recordClose({ closed, pos, realized: null, now, signature: null });
        say(`live ${short(mint)}: the wallet holds none of it — closed as sold by hand; the realized figure reads "not read"`);
        await persist();
        return { mint, action: "sell", markX, closed: true };
      }
      const qty = BigInt(pos.qtyRaw);
      const amountRaw = held < qty ? held : qty;
      const sq = adapter.sellExactIn(curve, amountRaw);
      const quoted = BigInt(sq?.quoteOutRaw ?? 0n);
      const tolBps = BigInt(Math.round(Number(config.sellToleranceFrac) * 10_000));
      const minQuoteOutRaw = quoted - (quoted * tolBps) / 10_000n;
      const global = read.accounts[1], mintAccount = read.accounts[2];
      if (!global?.data || !mintAccount?.owner) throw new TxError("prepare_failed", "the Global or mint account was not in the read");
      const sets = decodeGlobalFeeRecipients(global.data);
      const baseTokenProgram = String(mintAccount.owner);
      /* The quote's token program is the one the buy read off the stock's mint; the
         wallet's stock account may have been closed between the legs, so the sell
         re-creates it idempotently before sell_v2 pays into it. */
      const quoteAta = stock ? (pos.associatedQuoteUser ?? associatedTokenAddress(wallet, stock.mint, stock.tokenProgram)) : null;
      const instruction = adapter.sellIx({
        mint, user: wallet, curve, curveReadSlot: read.slot, buildingForSlot: read.slot,
        feeRecipient: pickRecipient(feeRecipientsForCurve(curve, sets), "fee recipient"),
        buybackFeeRecipient: pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient"),
        baseTokenProgram, quoteTokenProgram: stock ? stock.tokenProgram : TOKEN_PROGRAM, associatedBaseUser: ata, associatedBaseUserOwner: wallet,
        globalFeeRecipients: sets, amountRaw, minQuoteOutRaw,
      });
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const instructions = stock
        ? [createAtaIdempotentIx({ payer: wallet, ata: quoteAta, owner: wallet, mint: stock.mint, tokenProgram: stock.tokenProgram }), toTransactionInstruction(instruction)]
        : [toTransactionInstruction(instruction)];
      const tx = buildUnsignedTransaction({ payer: wallet, blockhash, computeUnitLimit: config.computeUnitLimit, priorityFeeLamports: config.priorityFeeLamports, instructions });
      const txBase64 = toBase64(tx.serialize());
      await simulateGuard({ txBase64, wallet, ata, mint, side: "sell", expected: { qtyRaw: amountRaw, minQuoteOutRaw },
        quote: stock ? { mint: stock.mint, ata: quoteAta, decimals: stock.decimals, symbol: stock.symbol } : null });
      const summary = stock
        ? `SELL ${pos.symbol ?? short(mint)} — ${reason}; floor ${units(minQuoteOutRaw, stock.decimals, stock.symbol)}; network fee in SOL`
        : `SELL ${pos.symbol ?? short(mint)} — ${reason}; floor ${sol(minQuoteOutRaw).toFixed(4)} SOL`;
      updateSnipe(S, { ...snipeFor(S, mint), mint, pendingSell: { reason, askedAt: clock(), attempts: Number(pos.pendingSell?.attempts ?? 0) + 1 } });
      if (!auto) notify({ kind: "sell", mint, title: "COINMARKETCAT: APPROVE THE SELL IN PHANTOM", body: summary });
      say(`live ${short(mint)}: ${auto ? "the autopilot wallet is selling" : "asking Phantom to sell"} — ${reason}`);
      emit();
      const { signature, tx: landed } = await signSendConfirm({ txBase64, purpose: "sell", mint, summary, lastValidBlockHeight, timeoutMs: Number(config.sellReaskMs) * 4, wallet, signer });
      const fill = stock
        ? fillFromTransaction(landed, { wallet, mint, side: "sell", quoteMint: stock.mint, quoteDecimals: stock.decimals })
        : fillFromTransaction(landed, { wallet, mint, side: "sell" });
      /* SOL: proceeds net of the fee, in lamports. A stock: proceeds in the stock, the
         SOL fee and any rent beside them, never netted across units. */
      const realized = stock ? BigInt(fill.quoteOutRaw) : BigInt(fill.quoteOutRaw) - BigInt(fill.feeLamports);
      const exitLamports = stock ? BigInt(fill.feeLamports) + BigInt(fill.rentLamports) : null;
      const closedAt = clock();
      const closed = closeSnipe(S, mint, { reason, closedAt, markX, realizedLamports: realized.toString(), sellSignature: signature, paper: false, soldRaw: fill.qtyRaw });
      try { shadow.close(mint, { action: "exited", reason, atMs: closedAt, slot: read.slot }); } catch { /* fine */ }
      S.counters.sold++;
      if (exitLamports !== null && exitLamports > 0n) charge("exit_fee", exitLamports, closedAt);
      recordClose({ closed, pos, realized, now: closedAt, signature, exitLamports });
      say(stock
        ? `live ${short(mint)}: SOLD — ${reason}; ${units(fill.quoteOutRaw, stock.decimals, stock.symbol)} back, ${exitLamports} lamports of network fee in SOL, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signature}`
        : `live ${short(mint)}: SOLD — ${reason}; ${fill.quoteOutRaw} lamports gross, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signature}`);
      if (auto) {
        notify({ kind: "sold", mint, title: "COINMARKETCAT autopilot: sold", body: `${pos.symbol ?? short(mint)} — ${reason}. Signed by the autopilot wallet without a window.` });
        refreshAutopilotBalance({ force: true }).catch(() => {});
      }
      await persist();
      return { mint, action: "sell", markX, closed: true, signature };
    } catch (error) {
      S.counters.sellFailures++;
      const code = error?.code ?? error?.clause ?? error?.name ?? "error";
      if (code === SIGN_ERRORS.REJECTED || code === SIGN_ERRORS.TIMEOUT)
        say(`live ${short(mint)}: the sell was ${code === SIGN_ERRORS.REJECTED ? "declined" : "not answered"} in Phantom — the determiner still says ${reason}; asking again in ${Math.round(Number(config.sellReaskMs) / 1000)}s`);
      else say(`live ${short(mint)}: SELL FAILED (${code}): ${error?.message ?? error} — asking again next tick`);
      const current = snipeFor(S, mint);
      /* The attempt was counted when the window opened; a failure adds its reason, not a second count. */
      if (current) updateSnipe(S, { ...current, mint, pendingSell: { reason, askedAt: clock(), attempts: Number(current.pendingSell?.attempts ?? 1), lastError: `${code}: ${error?.message ?? error}` } });
      await persist();
      return { mint, action: "sell", markX, closed: false, error: String(error?.message ?? error), code };
    } finally { sellInFlight.delete(mint); emit(); }
  }

  function recordClose({ closed, pos, realized, now, signature, exitLamports = null }) {
    if (isStockMint(pos.quoteMint)) {
      /* A stock-quoted close is booked in the stock. Its SOL fees are reported beside the
         P&L, never folded into it: there is no SOL price for an xStock in this lane, and a
         P&L in two units added together is a number nobody can read. */
      const dec = pos.quoteDecimals;
      const basis = BigInt(pos.costBasisQuoteRaw ?? pos.entryInputLamports);
      const pnl = realized === null ? null : realized - basis;
      const feeLamportsPaid = pos.live === true ? BigInt(pos.networkFeeLamports ?? 0) + (exitLamports ?? 0n) : null;
      S.closes.unshift({
        at: now, mint: pos.mint, symbol: pos.symbol ?? null, name: pos.name ?? null, live: pos.live === true, reason: closed.reason,
        openedAt: pos.openedAt, heldMs: now - Number(pos.openedAt), sizeSol: pos.sizeSol,
        quoteMint: pos.quoteMint, quoteDecimals: dec, quoteSymbol: pos.quoteSymbol ?? null, canary: pos.canary === true,
        costBasisQuoteRaw: basis.toString(), realizedQuoteRaw: realized === null ? null : realized.toString(),
        pnlQuoteRaw: pnl === null ? null : pnl.toString(), pnlQuote: pnl === null ? null : Number(rawToUnits(pnl, dec)),
        costBasisLamports: null, realizedLamports: null, pnlLamports: null, pnlSol: null,
        feeLamportsPaid: feeLamportsPaid === null ? null : feeLamportsPaid.toString(), feeSolPaid: feeLamportsPaid === null ? null : sol(feeLamportsPaid),
        markX: closed.markX ?? null, entrySignature: pos.entrySignature ?? null, sellSignature: signature,
        msSinceNotice: pos.msSinceNotice ?? null, waitedOut: pos.waitedOut ?? null,
        /* A close from the xStock venue says so, and names the pool; a pump.fun row is unchanged. */
        ...(pos.venue === XSTOCK_VENUE_ID ? { venue: XSTOCK_VENUE_ID, pool: pos.pool ?? null, dex: pos.dex ?? null } : {}),
      });
      if (S.closes.length > 300) S.closes.length = 300;
      return;
    }
    const basis = BigInt(pos.costBasisLamports ?? (BigInt(pos.entryInputLamports) + BigInt(pos.entryFeeLamports ?? 0)));
    const pnl = realized === null ? null : realized - basis;
    S.closes.unshift({
      at: now, mint: pos.mint, symbol: pos.symbol ?? null, name: pos.name ?? null, live: pos.live === true, reason: closed.reason,
      openedAt: pos.openedAt, heldMs: now - Number(pos.openedAt), sizeSol: pos.sizeSol, costBasisLamports: basis.toString(),
      realizedLamports: realized === null ? null : realized.toString(), pnlLamports: pnl === null ? null : pnl.toString(),
      pnlSol: pnl === null ? null : sol(pnl), markX: closed.markX ?? null, entrySignature: pos.entrySignature ?? null, sellSignature: signature,
      msSinceNotice: pos.msSinceNotice ?? null, waitedOut: pos.waitedOut ?? null,
    });
    if (S.closes.length > 300) S.closes.length = 300;
  }

  /* ── the feed ──────────────────────────────────────────────────────────────────────── */
  function onLogs({ logs, signature, slot, err, receivedAt }) {
    if (err) return;
    let notices = [];
    try { notices = noticesFromLogs({ logs, signature, slot, receivedAt: receivedAt ?? clock(), source: "logsSubscribe" }); }
    catch { return; }
    for (const notice of notices) handleNotice(notice).catch((error) => say(`${short(notice.mint)}: notice failed — ${error?.message ?? error}`));
  }
  function startFeed() {
    if (feed || !feedFactory || config.lane === "off") return;
    try {
      feed = feedFactory({ onLogs, onState: (state, detail) => { feedState = state; feedDetail = detail; say(`feed ${state}${detail ? `: ${detail}` : ""}`); } });
      feed.start();
    } catch (error) { feed = null; feedState = "dead"; feedDetail = String(error?.message ?? error); say(`feed could not start: ${feedDetail}`); }
  }
  function stopFeed() { if (feed) { try { feed.stop(); } catch { /* gone */ } feed = null; } feedState = "stopped"; feedDetail = null; }

  /* ── lifecycle ─────────────────────────────────────────────────────────────────────── */
  async function start() {
    await load();
    if (sessionSigner) await refreshSigner();
    /* Two loops on one interval: the pump.fun lane's tick and the xStock venue's. Each is
       non-reentrant on its own, so a Jupiter wait never holds up a pump.fun sell. */
    if (!ticker) ticker = timers.setInterval(() => { tick().catch(() => {}); xstockTick().catch(() => {}); }, Number(config.tickMs) || 1000);
    startFeed();
    emit();
  }
  /** The xStock venue's own tick: discovery on its cadence, then its positions. A no-op
   *  unless config.xstockVenue is on and the lane is not off. */
  async function xstockTick() {
    await load();
    return xstock.tick();
  }
  function stop() {
    if (ticker) { timers.clearInterval(ticker); ticker = null; }
    stopFeed();
    emit();
  }
  async function setConfig(next) {
    await load();
    const before = config;
    config = normalizeConfig({ ...config, ...next });
    if (before.lane !== config.lane || before.shadowCapacity !== config.shadowCapacity) buildShadow();
    if (before.lane !== config.lane) say(`lane: ${before.lane} → ${config.lane}`);
    if (before.xstockVenue !== config.xstockVenue)
      say(config.xstockVenue ? "the xStock venue is ON: new pools pairing a token with a watched stock are polled from the chosen feeds; the arm sentence now names it" : "the xStock venue is off: no pools are polled and nothing is opened there (positions it holds are still managed)");
    if (before.signerMode !== config.signerMode) {
      say(`signer: ${before.signerMode} → ${config.signerMode}${config.signerMode === "autopilot" ? " — buys are signed by the autopilot wallet without a window" : " — every trade is one Phantom approval"}`);
      if (config.signerMode === "autopilot") await refreshAutopilotBalance({ force: true });
    }
    stopFeed();
    if (config.lane !== "off") startFeed();
    emit();
    await persist();
    return config;
  }
  function setRpc(primary, secondary = null) { rpc = primary; secondaryRpc = secondary; emit(); }
  async function forgetPosition(mint) {
    await load();
    if (xstock.holds(mint)) return xstock.forget(mint);
    const pos = snipeFor(S, mint);
    if (!pos) return false;
    const now = clock();
    const closed = closeSnipe(S, mint, { reason: "forgotten: closed by the operator, sold by hand", closedAt: now, markX: pos.lastMarkX ?? null, realizedLamports: null, paper: pos.live !== true });
    try { shadow.close(mint, { action: "reconciled", reason: closed.reason, atMs: now, slot: null }); } catch { /* fine */ }
    recordClose({ closed, pos, realized: null, now, signature: null });
    say(`${short(mint)}: forgotten — the realized figure reads "not read"`);
    await persist();
    return true;
  }
  /** The shadow book as JSONL, the file vendor/executor/grade-entry-gates.mjs --file reads. */
  function exportShadow() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  }
  /** The SOL card: every row a book held before stock quotes existed, and every SOL row since. */
  function scorecard() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    try { return snipeScorecard(rows); } catch (error) { return { error: String(error?.message ?? error) }; }
  }
  /** One card per quote the book holds, SOL first: a GLDx launch is never graded with SOL ones. */
  function scorecardByQuote() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    try { return Object.fromEntries(quoteMintsOf(rows).map((q) => [q, snipeScorecard(rows, { quoteMint: q })])); }
    catch (error) { return { error: String(error?.message ?? error) }; }
  }
  function report() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    try { return shadowReport(rows); } catch (error) { return { error: String(error?.message ?? error) }; }
  }

  /** Each listed stock as the popup shows it: its numbers, today's spend in it, what the
   *  chain last said about its mint, and where it stands on the canary rule. */
  function stockStatus(now) {
    return (config.quoteMints ?? []).map((q) => {
      const facts = S.quoteMintFacts[q.mint] ?? null;
      const decimals = Number.isInteger(facts?.decimals) ? facts.decimals : null;
      const raw = deployedTodayQuoteRaw(q.mint, now);
      const c = S.stockCanary[q.mint] ?? null;
      const state = c?.state ?? "canary";
      return {
        mint: q.mint, symbol: q.symbol, maxPerTrade: q.maxPerTrade, minPerTrade: q.minPerTrade, dailyCap: q.dailyCap,
        decimals, deployedTodayRaw: raw.toString(), deployedToday: decimals === null ? (raw === 0n ? 0 : null) : Number(rawToUnits(raw, decimals)),
        canary: state, canarySignature: c?.signature ?? null, canaryDetail: c?.detail ?? null,
        nextLiveTicket: state === "proven" ? q.maxPerTrade : state === "blocked" ? null : q.minPerTrade,
        paused: facts ? facts.paused === true : null, program: facts?.program ?? null, metadataSymbol: facts?.symbol ?? null,
        scaledUiMultiplier: facts?.scaledUiMultiplier ?? null, readAt: facts?.at ?? null,
      };
    });
  }

  function status() {
    /* `wallet` is the lane's wallet — the one the arm sentence binds and buys come from:
       Phantom's, or on autopilot the autopilot wallet's. `phantomWallet` and `bridgeReady`
       are always Phantom's and the console tab's, whatever the mode. */
    const signer = activeSigner();
    const wallet = signer.wallet();
    const hasBridge = readyOf(bridge);
    const arm = armabilityNow();
    /* Both venues' positions, one list: the popup, the console page and the sweep's
       "holds a live position" refusal all read it. A row from the xStock venue carries venue. */
    const xs = xstock.status();
    const open = [...snipeList(S).map((p) => ({ ...p })), ...xs.open];
    const now = clock();
    const liveCloses = S.closes.filter((c) => c.live);
    /* A close's P&L is in the unit it was paid in: SOL, or its stock. Wins and losses
       count both; the SOL total sums SOL rows only, and each stock sums apart. */
    const pnlOf = (c) => (isStockMint(c.quoteMint) ? c.pnlQuote ?? null : c.pnlSol ?? null);
    const realizedSol = liveCloses.filter((c) => !isStockMint(c.quoteMint)).reduce((a, c) => a + (c.pnlSol ?? 0), 0);
    const realizedByQuote = {};
    for (const c of liveCloses) {
      if (!isStockMint(c.quoteMint)) continue;
      const r = realizedByQuote[c.quoteMint] ??= { symbol: c.quoteSymbol, decimals: c.quoteDecimals, raw: 0n, trades: 0, unread: 0, feeLamports: 0n };
      r.trades++;
      if (c.pnlQuoteRaw === null || c.pnlQuoteRaw === undefined) r.unread++; else r.raw += BigInt(c.pnlQuoteRaw);
      if (c.feeLamportsPaid) r.feeLamports += BigInt(c.feeLamportsPaid);
    }
    for (const r of Object.values(realizedByQuote)) {
      r.ui = Number(rawToUnits(r.raw, r.decimals)); r.raw = r.raw.toString();
      r.feeSol = sol(r.feeLamports); r.feeLamports = r.feeLamports.toString();
    }
    const stocks = stockStatus(now);
    return {
      version: ENGINE_VERSION,
      lane: config.lane, executing: armed(), armable: arm.armable, armability: arm,
      wallet, bridgeReady: hasBridge,
      signerMode: config.signerMode, signerReady: readyOf(signer), phantomWallet: bridge.wallet() ?? null,
      autopilot: autopilotView(),
      autopilotHeld: sessionSigner && sessionSigner.wallet() ? open.filter((p) => p.live === true && p.wallet === sessionSigner.wallet()).length : 0,
      control: controlView(),
      feed: { state: feedState, detail: feedDetail, counters: feed?.counters ?? null },
      rpc: rpc ? rpc.url ?? "configured" : null,
      entryInFlight, deployedTodaySol: deployedTodaySol(now), dailySolCap: config.dailySolCap, maxSolPerTrade: config.maxSolPerTrade,
      entryWaitMs: config.entryWaitMs, entryFollowThroughX: config.entryFollowThroughX,
      quoteMints: stocks,
      deployedTodayQuote: Object.fromEntries(stocks.map((q) => [q.mint, { raw: q.deployedTodayRaw, ui: q.deployedToday, cap: q.dailyCap, symbol: q.symbol }])),
      stockCanaryRule: STOCK_CANARY_RULE,
      open, closes: S.closes.slice(0, 60), refusals: S.refusals.slice(0, 20), log: S.log.slice(0, 40), counters: { ...S.counters },
      book: {
        liveTrades: liveCloses.length, liveWins: liveCloses.filter((c) => (pnlOf(c) ?? 0) > 0).length, liveLosses: liveCloses.filter((c) => (pnlOf(c) ?? 0) < 0).length,
        unread: liveCloses.filter((c) => pnlOf(c) === null).length, realizedSol, realizedByQuote,
      },
      shadow: { rows: shadow ? shadow.rows().length : Object.keys(S.shadow).length, scorecard: scorecard(), scorecardByQuote: scorecardByQuote() },
      policy: policyConfigFor(config),
      record: RECORD,
      xstock: { ...xs, open: undefined },
    };
  }

  /* ── the second venue ────────────────────────────────────────────────────────────────
     Everything it may touch, handed over by name. It signs, simulates and reads fills only
     through the functions below, which are the ones this lane uses for pump.fun. */
  const xstock = createXstockLane({
    clock, timers, fetchImpl, sleep: (ms) => sleep(ms), jupiter, discovery: poolDiscovery,
    state: () => S, config: () => config, rpc: () => rpc,
    say, notify: (n) => { try { notify(n); } catch { /* the host's problem */ } }, emit, persist,
    armed, onAutopilot, control: controlView,
    activeSigner, isAutopilot, signerHolding, readyOf,
    claimEntry(mint) { if (entryInFlight !== null) return false; entryInFlight = mint; emit(); return true; },
    releaseEntry() { entryInFlight = null; emit(); },
    entryInFlight: () => entryInFlight,
    liveCount: () => snipeList(S).filter((p) => p.live === true).length + xstock.liveCount(),
    pumpfunHolds: (mint) => Boolean(snipeFor(S, mint)),
    deployedTodaySol, deployedTodayQuoteRaw, charge, chargeStock,
    simulateGuard, signSendConfirm, recordClose,
    determiner, observeCfg, laneCfg: executeCfg,
  });

  return Object.freeze({
    start, stop, tick, xstockTick, handleNotice, onLogs, setConfig, setRpc, forgetPosition, clearStockCanary, status, exportShadow, scorecard, scorecardByQuote, report, load,
    refreshSigner,
    get config() { return config; },
    get state() { return S; },
    setControl(next) { control = { ...control, ...next }; say(`control: hard stop ${control.hardStop ? "ON" : "off"}, entries ${control.pauseEntries ? "PAUSED" : "open"}`); emit(); },
    onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  });
}
