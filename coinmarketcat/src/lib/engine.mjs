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
 *   · ONE APPROVAL PER TRADE. Phantom has no auto-approve, by design, and this lane does
 *     not try to route around it. A buy the contract clears becomes one Phantom window;
 *     a sell the determiner orders becomes one Phantom window. The extension never sees
 *     a key, and test-hawk-no-key.mjs scans this folder for one on every run.
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
import { createSnipeShadow, snipeScorecard, shadowReport } from "../../vendor/executor/snipe-shadow.mjs";
import { readSocials } from "../../vendor/executor/snipe-socials.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../../vendor/executor/token2022.mjs";
import {
  HAWK_BROWSER_VERSION, CONFIG_DEFAULTS, normalizeConfig, laneConfigFor, policyConfigFor, feeModelFor,
  browserArmability, snipeArmSentence, RECORD,
} from "./config.mjs";
import {
  buildUnsignedTransaction, createAtaIdempotentIx, toTransactionInstruction, associatedTokenAddress,
  fillFromTransaction, tokenAmountOf, toBase64, fromBase64, signatureOf, sameMessage, TxError,
} from "./tx.mjs";
import { SIGN_ERRORS } from "./protocol.mjs";

const LAMPORTS = 1_000_000_000n;
const ZERO_KEY = "11111111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const sol = (lamports) => Number(BigInt(lamports)) / Number(LAMPORTS);
const short = (mint) => (typeof mint === "string" && mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : String(mint));

export const ENGINE_VERSION = HAWK_BROWSER_VERSION;
export { RECORD };

/** The state the store persists. Every raw amount is a digit string. */
export function freshState() {
  return {
    version: ENGINE_VERSION,
    snipes: {},          // the open book, snipe-book.mjs's shape, keyed by mint; live and would-have rows alike
    positions: {},       // the desk book — always empty here, read by the cross-book check
    attempts: {},        // mint → { at, outcome, detail }
    spend: [],           // { at, sol, kind } — the rolling 24-hour deployment ledger
    closes: [],          // the book of closed trades, newest first (live and paper, flagged)
    refusals: [],        // { at, mint, gate, message }, newest first
    shadow: {},          // mint → shadow row, the executor's own schema (snipe-shadow.mjs)
    log: [],             // { at, line }, newest first
    counters: { notices: 0, cleared: 0, refused: 0, entered: 0, wouldHaveEntered: 0, sold: 0, entryFailures: 0, sellFailures: 0, signRequests: 0, signRejected: 0, signTimeouts: 0, liveAttempts: 0, waitedOut: 0 },
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
  bridge,                     // { isReady(), wallet(), signTransaction({txBase64,...}) }
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
} = {}) {
  if (!bridge || typeof bridge.signTransaction !== "function" || typeof bridge.wallet !== "function")
    throw new Error("createHawkEngine needs a bridge with wallet() and signTransaction()");
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
      try { shadow.record({ mint: row.mint, venueId: row.venueId, notice: row.notice, createSlot: row.createSlot, observedSlot: row.observedSlot, endpointVerdict: row.endpointVerdict, endpoints: row.endpoints, curve: row.curve ? { ...row.curve } : null, verdict: { ok: row.gate?.ok, gate: row.gate?.refusedAt, detail: { ...row.ceiling, message: row.gate?.message, measured: row.gate?.measured, launchSharePct: row.gate?.launchSharePct }, trace: row.gate?.trace }, hops: [], frictionX: row.ceiling?.frictionX, ticketLamports: row.ceiling?.ticketLamports }); }
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
      S = { ...freshState(), ...saved, counters: { ...freshState().counters, ...(saved.counters ?? {}) } };
      ensureSnipeBook(S);
      for (const pos of snipeList(S)) if (pos.pendingSell) say(`resumed with ${short(pos.mint)} still waiting for a sell approval`);
    }
    buildShadow();
  }

  /* ── the rolling day ───────────────────────────────────────────────────────────────── */
  function pruneSpend(now) { S.spend = S.spend.filter((e) => now - e.at < DAY_MS); }
  function deployedTodaySol(now = clock()) { pruneSpend(now); return S.spend.reduce((a, e) => a + e.sol, 0); }
  function charge(kind, lamports, now = clock()) { S.spend.push({ at: now, sol: sol(lamports), kind }); pruneSpend(now); }

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
    return Object.freeze({ snipes, positions: S.positions, attempts: recentAttempts(now, { realOnly }), deployedTodaySol: deployedTodaySol(now) });
  }
  const controlView = () => Object.freeze({ hardStop: control.hardStop === true, pauseEntries: control.pauseEntries === true });
  const venueFeeBps = () => {
    const observed = Number(adapter.feeObservation?.totalFeeBps);
    return Number.isFinite(observed) ? observed : null;
  };
  const feeReserveLamports = () => BigInt(Math.round((Number(SNIPE_LANE_DEFAULTS.networkFeeReserveSol) || 0) * Number(LAMPORTS)));
  function armed() {
    if (config.lane !== "execute") return false;
    const wallet = bridge.wallet();
    if (!wallet || !rpc) return false;
    if (typeof bridge.isReady === "function" && !bridge.isReady()) return false;
    return config.liveAck === snipeArmSentence(wallet, config.maxSolPerTrade, config.dailySolCap);
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

  /* ── the entry: first notice ───────────────────────────────────────────────────────── */
  function creatorFacts(notice, curve) {
    return Object.freeze({ creator: notice?.creator ?? curve?.creator ?? null, shareOfSupplyPct: undefined, priorLaunches: undefined });
  }
  function pickRecipient(list, label) {
    const hit = (list ?? []).find((k) => typeof k === "string" && k !== ZERO_KEY);
    if (!hit) throw new TxError("prepare_failed", `the Global account names no ${label}`);
    return hit;
  }
  function prepareBuy({ mint, wallet, curve, read, baseOutRaw, maxQuoteInRaw }) {
    const global = read.accounts[1], mintAccount = read.accounts[2];
    if (!global?.data) throw new TxError("prepare_failed", "the Global account was not in the read");
    if (!mintAccount?.owner) throw new TxError("prepare_failed", "the mint account was not in the read");
    const baseTokenProgram = String(mintAccount.owner);
    if (baseTokenProgram !== TOKEN_PROGRAM && baseTokenProgram !== TOKEN_2022_PROGRAM)
      throw new TxError("prepare_failed", `the mint is owned by ${baseTokenProgram}, not a token program`);
    const sets = decodeGlobalFeeRecipients(global.data);
    const feeRecipient = pickRecipient(feeRecipientsForCurve(curve, sets), "fee recipient");
    const buybackFeeRecipient = pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient");
    const associatedBaseUser = associatedTokenAddress(wallet, mint, baseTokenProgram);
    const instruction = adapter.buyIx({
      mint, user: wallet, curve, curveReadSlot: read.slot, buildingForSlot: read.slot,
      feeRecipient, buybackFeeRecipient, baseTokenProgram, quoteTokenProgram: TOKEN_PROGRAM,
      associatedBaseUser, associatedBaseUserOwner: wallet, globalFeeRecipients: sets,
      amountRaw: BigInt(baseOutRaw), maxQuoteInRaw: BigInt(maxQuoteInRaw),
    });
    return Object.freeze({ instruction, associatedBaseUser, baseTokenProgram, feeRecipient, buybackFeeRecipient, sets });
  }
  function frictionFor(verdict) {
    const entryInputRaw = verdict.detail.maxQuoteInRaw ?? null;
    if (entryInputRaw === null || !(entryInputRaw > 0n)) return null;
    try { return frictionXFor({ entryInputLamports: entryInputRaw, entryFeeLamports: feeReserveLamports(), expectedExitFeeLamports: feeReserveLamports() }); }
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

    let read;
    try { read = await readAccounts(adapter.accountsFor(mint).map(String)); }
    catch (error) {
      read = { verdict: "both_missing", slot: null, accounts: [], all: [], endpoints: [{ id: "primary", slot: null, present: false, digest: null, error: String(error?.message ?? error) }] };
    }
    hops.push({ hop: "accounts", atMs: clock() });
    const curve = decodeCurve(read, mint);
    hops.push({ hop: "decode", atMs: clock() });
    hops.push({ hop: "prepare", atMs: clock() });

    const verdict = snipeContract({
      notice: { mint, creator: notice?.creator ?? null, slot: notice?.slot ?? null, noticeAt: noticeAtMs, source: notice?.source ?? null, wallet: null },
      curve, adapter, cfg, book: bookView(now), nowMs: clock(), control: controlView(),
      mint: read.accounts[2] ?? null, creator: creatorFacts(notice, curve), fees: feeModelFor(config),
      instruction: null,
      socials: socialsPromise ? await socialsPromise : null,
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
        curve: curve ? snipeCurveState(curve) : null, verdict, hops, frictionX, ticketLamports: verdict.detail.ticketLamports ?? null,
      });
    } catch (error) { say(`${short(mint)}: the shadow book refused the row — ${error?.message ?? error}`); }

    if (!verdict.ok) {
      S.counters.refused++;
      S.refusals.unshift({ at: now, mint, gate: verdict.gate, message: verdict.detail.message, name: notice?.raw?.name ?? null, symbol: notice?.raw?.symbol ?? null, launchSharePct: verdict.detail.launchSharePct ?? null });
      if (S.refusals.length > 60) S.refusals.length = 60;
      S.attempts[mint] = { at: now, outcome: "refused", detail: verdict.gate };
      say(`${short(mint)}: refused at ${verdict.gate} — ${verdict.detail.message}`);
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

  function openWouldBePosition({ mint, notice, curve, verdict, frictionX, read, now }) {
    const entryInputLamports = verdict.detail.maxQuoteInRaw;
    const qtyRaw = verdict.detail.baseOutRaw;
    const feeLamports = feeReserveLamports();
    try {
      const creator = notice?.creator ?? curve?.creator ?? null;
      const position = determiner.open({ mint, entry: 1, openedAt: now, creator, sizeSol: sol(entryInputLamports), feeSolPerLeg: sol(feeLamports) });
      const filed = openSnipe(S, {
        ...position, mint, venue: adapter.id, entry: 1, openedAt: now,
        sizeSol: sol(entryInputLamports), feeSolPerLeg: sol(feeLamports),
        qtyRaw: qtyRaw.toString(), entryInputLamports: entryInputLamports.toString(), entryFeeLamports: feeLamports.toString(),
        creator, openedAtSlot: read.slot ?? null, noticeAt: Number(notice?.noticeAt) || now,
        frictionXAtOpen: frictionX, samples: 0, live: false, liveAttempted: false, uri: notice?.raw?.uri ?? null,
        name: notice?.raw?.name ?? null, symbol: notice?.raw?.symbol ?? null,
        costBasisLamports: (entryInputLamports + feeLamports).toString(),
      });
      S.counters.wouldHaveEntered++;
      S.attempts[mint] = { at: now, outcome: "shadow", detail: "would have entered; watching" };
      say(`${short(mint)}${notice?.raw?.symbol ? ` (${notice.raw.symbol})` : ""}: cleared — would have entered for at most ${sol(entryInputLamports).toFixed(4)} SOL; ${armed() ? `watching ${Math.round(config.entryWaitMs / 1000)}s before asking Phantom` : "watching"}`);
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
    const wallet = bridge.wallet();
    S.counters.liveAttempts++;
    entryInFlight = mint;
    updateSnipe(S, { ...pos, mint, liveAttempted: true, liveAttemptAt: now });
    emit();
    try {
      const read = await readAccounts(adapter.accountsFor(mint).map(String));
      const curve = decodeCurve(read, mint);
      const cfg = { ...executeCfg(), noticeMaxMs: Math.max(Number(executeCfg().noticeMaxMs) || 0, Number(config.entryWaitMs) + 20_000) };
      let prepared = null, prepareError = null;
      if (curve) {
        try {
          const plan = planSnipeCeiling({ curve: snipeCurveState(curve), adapter, solLamports: BigInt(Math.round(cfg.maxSolPerTrade * Number(LAMPORTS))), cfg });
          if (plan?.deliverable && plan.baseOutRaw > 0n && plan.maxQuoteInRaw > 0n)
            prepared = prepareBuy({ mint, wallet, curve, read, baseOutRaw: plan.baseOutRaw, maxQuoteInRaw: plan.maxQuoteInRaw });
        } catch (error) { prepared = null; prepareError = String(error?.message ?? error); }
      }
      const socials = cfg.requireSocials === true
        ? await Promise.resolve(socialsReader({ uri: pos.uri ?? null, timeoutMs: Number(cfg.socialsTimeoutMs) || undefined, fetchImpl })).catch((error) => Object.freeze({ ok: false, clause: "fetch_failed", message: String(error?.message ?? error).slice(0, 160) }))
        : null;
      const verdict = snipeContract({
        notice: { mint, creator: pos.creator ?? null, slot: pos.openedAtSlot ?? null, noticeAt: Number(pos.noticeAt) || Number(pos.openedAt), source: "watch", wallet },
        curve, adapter, cfg, book: bookView(now, { excludeMint: mint, realOnly: true }), nowMs: clock(), control: controlView(),
        mint: read.accounts[2] ?? null, creator: creatorFacts({ creator: pos.creator }, curve), fees: feeModelFor(config),
        instruction: prepared?.instruction ?? null, socials,
      });
      if (!verdict.ok) {
        const why = prepareError && verdict.gate === "instruction_mismatch" ? `${verdict.detail.message} (the buy could not be built: ${prepareError})` : verdict.detail.message;
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
      return await enterForReal({ mint, pos, curve, verdict, frictionX: frictionFor(verdict), read, prepared, wallet, now });
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

  /** Simulate the unsigned bytes on the node and refuse anything the plan did not ask for. */
  async function simulateGuard({ txBase64, wallet, ata, mint, side, expected }) {
    const pre = await rpc.getMultipleAccounts([wallet, ata]);
    const preLamports = BigInt(pre.accounts[0]?.lamports ?? 0);
    const preBase = tokenAmountOf(pre.accounts[1] ?? null, { mint, owner: wallet }) ?? 0n;
    const sim = await rpc.simulateTransaction(txBase64, { addresses: [wallet, ata] });
    if (sim?.err) throw new TxError("simulation_failed", `simulation failed: ${JSON.stringify(sim.err)}` + (Array.isArray(sim.logs) ? ` — ${sim.logs.slice(-3).join(" | ")}` : ""));
    const post = sim?.accounts;
    if (!Array.isArray(post) || post.length !== 2) throw new TxError("simulation_failed", "simulation omitted the requested accounts");
    const spend = preLamports - BigInt(post[0]?.lamports ?? 0);
    const base = tokenAmountOf(post[1] ? { owner: post[1].owner, data: post[1].data } : null, { mint, owner: wallet }) ?? 0n;
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

  /** Ask Phantom, check what came back is what was asked, send it, wait for the chain. */
  async function signSendConfirm({ txBase64, purpose, mint, summary, lastValidBlockHeight, timeoutMs, wallet }) {
    S.counters.signRequests++;
    let signed;
    try { signed = await bridge.signTransaction({ txBase64, purpose, mint, summary, timeoutMs, wallet }); }
    catch (error) {
      if (error?.code === SIGN_ERRORS.REJECTED) S.counters.signRejected++;
      if (error?.code === SIGN_ERRORS.TIMEOUT) S.counters.signTimeouts++;
      throw error;
    }
    const unsignedBytes = fromBase64(txBase64);
    const signedBytes = fromBase64(signed?.signedBase64 ?? signed);
    if (!sameMessage(unsignedBytes, signedBytes)) throw new TxError("tampered", "the transaction Phantom returned is not the one it was asked to sign — refusing to send it");
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

  async function enterForReal({ mint, pos, curve, verdict, frictionX, read, prepared, wallet, now }) {
    S.attempts[mint] = { at: now, outcome: "signing", detail: "waiting for Phantom" };
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
      notify({ kind: "buy", mint, title: "COINMARKETCAT: approve the buy in Phantom", body: summary });
      const { signature, tx: landed } = await signSendConfirm({ txBase64, purpose: "buy", mint, summary, lastValidBlockHeight, timeoutMs: config.approvalTimeoutMs, wallet });
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
      say(`live ${short(mint)}: ENTERED — ${fill.qtyRaw} base for ${entryInputLamports} lamports plus ${paidFee} fee, ${Math.round(filed.msSinceNotice / 1000)}s after the notice, sig ${signature}`);
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

  /* ── the held position ─────────────────────────────────────────────────────────────── */
  async function tick() {
    await load();
    if (ticking) return [];
    ticking = true;
    try {
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
    const heldAddresses = typeof adapter.accountsForHeld === "function" ? adapter.accountsForHeld(mint, { creator: pos.creator ?? null }).map(String) : entryAddresses;
    const read = await readAccounts(heldAddresses);
    const curve = decodeCurve(read, mint);
    let markX = null;
    if (curve) {
      try { markX = curveExitMarkX({ curve, qtyRaw: pos.qtyRaw, entryInputLamports: pos.entryInputLamports, adapter }); } catch { markX = null; }
    }

    /* The creator's balance against a baseline taken at the first readable tick; a fall
       of creatorExitFrac or more is the creator leaving, which sells the whole position. */
    let creatorExited = false, creatorNote = null;
    let creatorBaselineRaw = pos.creatorBaselineRaw ?? null;
    if (pos.creator && heldAddresses.length > entryAddresses.length) {
      const first = entryAddresses.length;
      const amountFrom = (accounts) => {
        let total = null;
        for (let i = first; i < heldAddresses.length; i++) {
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
    const carried = { ...pos, ...(isPlainObject(step?.position) ? step.position : {}), mint, samples, shadowSamples, shadowSampledAt, creatorBaselineRaw, lastMarkX: markX, lastTickAt: now, complete: curve?.complete === true };

    if (!live) {
      /* THE WATCH. In an armed lane a would-have row that has waited long enough and
         still marks at or above its own fill is the launch this lane buys. */
      const waited = now - Number(pos.openedAt) >= Number(config.entryWaitMs);
      const followed = Number(config.entryFollowThroughX) <= 0 || (markX !== null && markX >= Number(config.entryFollowThroughX));
      const openLive = snipeList(S).filter((p) => p.live === true).length;
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
    return sellForReal({ pos: snipeFor(S, mint), curve, read, markX, reason, now });
  }

  async function sellForReal({ pos, curve, read, markX, reason, now }) {
    const mint = pos.mint;
    if (sellInFlight.has(mint)) return { mint, action: "sell", markX, closed: false, pending: true };
    if (pos.pendingSell && now - Number(pos.pendingSell.askedAt) < Number(config.sellReaskMs)) return { mint, action: "sell", markX, closed: false, pending: true };
    if (!curve) { say(`live ${short(mint)}: the determiner says sell (${reason}) but the curve is unreadable this tick — asking again next tick`); return { mint, action: "sell", markX, closed: false, pending: true }; }
    if (curve.complete === true) {
      if (!pos.graduated) {
        updateSnipe(S, { ...pos, mint, graduated: true });
        say(`live ${short(mint)}: the curve has graduated to a pool — this lane sells on the curve only. SELL IT BY HAND on pump.fun or Jupiter, then press Forget on the row`);
        notify({ kind: "attention", mint, title: "COINMARKETCAT: sell by hand", body: `${pos.symbol ?? short(mint)} graduated to a pool. The lane cannot sell it; sell it yourself.` });
        await persist();
      }
      return { mint, action: "sell", markX, closed: false, graduated: true };
    }
    const wallet = bridge.wallet();
    if (!wallet || (pos.wallet && wallet !== pos.wallet)) { say(`live ${short(mint)}: Phantom is not connected as the wallet that holds this position (${pos.wallet ?? "?"})`); return { mint, action: "sell", markX, closed: false, pending: true }; }
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
      const quote = adapter.sellExactIn(curve, amountRaw);
      const quoted = BigInt(quote?.quoteOutRaw ?? 0n);
      const tolBps = BigInt(Math.round(Number(config.sellToleranceFrac) * 10_000));
      const minQuoteOutRaw = quoted - (quoted * tolBps) / 10_000n;
      const global = read.accounts[1], mintAccount = read.accounts[2];
      if (!global?.data || !mintAccount?.owner) throw new TxError("prepare_failed", "the Global or mint account was not in the read");
      const sets = decodeGlobalFeeRecipients(global.data);
      const baseTokenProgram = String(mintAccount.owner);
      const instruction = adapter.sellIx({
        mint, user: wallet, curve, curveReadSlot: read.slot, buildingForSlot: read.slot,
        feeRecipient: pickRecipient(feeRecipientsForCurve(curve, sets), "fee recipient"),
        buybackFeeRecipient: pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient"),
        baseTokenProgram, quoteTokenProgram: TOKEN_PROGRAM, associatedBaseUser: ata, associatedBaseUserOwner: wallet,
        globalFeeRecipients: sets, amountRaw, minQuoteOutRaw,
      });
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const tx = buildUnsignedTransaction({ payer: wallet, blockhash, computeUnitLimit: config.computeUnitLimit, priorityFeeLamports: config.priorityFeeLamports, instructions: [toTransactionInstruction(instruction)] });
      const txBase64 = toBase64(tx.serialize());
      await simulateGuard({ txBase64, wallet, ata, mint, side: "sell", expected: { qtyRaw: amountRaw, minQuoteOutRaw } });
      const summary = `SELL ${pos.symbol ?? short(mint)} — ${reason}; floor ${sol(minQuoteOutRaw).toFixed(4)} SOL`;
      updateSnipe(S, { ...snipeFor(S, mint), mint, pendingSell: { reason, askedAt: clock(), attempts: Number(pos.pendingSell?.attempts ?? 0) + 1 } });
      notify({ kind: "sell", mint, title: "COINMARKETCAT: APPROVE THE SELL IN PHANTOM", body: summary });
      say(`live ${short(mint)}: asking Phantom to sell — ${reason}`);
      emit();
      const { signature, tx: landed } = await signSendConfirm({ txBase64, purpose: "sell", mint, summary, lastValidBlockHeight, timeoutMs: Number(config.sellReaskMs) * 4, wallet });
      const fill = fillFromTransaction(landed, { wallet, mint, side: "sell" });
      const realized = BigInt(fill.quoteOutRaw) - BigInt(fill.feeLamports);
      const closedAt = clock();
      const closed = closeSnipe(S, mint, { reason, closedAt, markX, realizedLamports: realized.toString(), sellSignature: signature, paper: false, soldRaw: fill.qtyRaw });
      try { shadow.close(mint, { action: "exited", reason, atMs: closedAt, slot: read.slot }); } catch { /* fine */ }
      S.counters.sold++;
      recordClose({ closed, pos, realized, now: closedAt, signature });
      say(`live ${short(mint)}: SOLD — ${reason}; ${fill.quoteOutRaw} lamports gross, sig ${signature}`);
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

  function recordClose({ closed, pos, realized, now, signature }) {
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
    if (!ticker) ticker = timers.setInterval(() => { tick().catch(() => {}); }, Number(config.tickMs) || 1000);
    startFeed();
    emit();
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
    stopFeed();
    if (config.lane !== "off") startFeed();
    emit();
    await persist();
    return config;
  }
  function setRpc(primary, secondary = null) { rpc = primary; secondaryRpc = secondary; emit(); }
  async function forgetPosition(mint) {
    await load();
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
  function scorecard() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    try { return snipeScorecard(rows); } catch (error) { return { error: String(error?.message ?? error) }; }
  }
  function report() {
    const rows = shadow ? shadow.rows() : Object.values(S.shadow);
    try { return shadowReport(rows); } catch (error) { return { error: String(error?.message ?? error) }; }
  }

  function status() {
    const wallet = bridge.wallet();
    const hasBridge = typeof bridge.isReady === "function" ? bridge.isReady() : true;
    const arm = browserArmability({ config, wallet, hasBridge });
    const open = snipeList(S).map((p) => ({ ...p }));
    const liveCloses = S.closes.filter((c) => c.live);
    const realizedSol = liveCloses.reduce((a, c) => a + (c.pnlSol ?? 0), 0);
    return {
      version: ENGINE_VERSION,
      lane: config.lane, executing: armed(), armable: arm.armable, armability: arm,
      wallet, bridgeReady: hasBridge,
      control: controlView(),
      feed: { state: feedState, detail: feedDetail, counters: feed?.counters ?? null },
      rpc: rpc ? rpc.url ?? "configured" : null,
      entryInFlight, deployedTodaySol: deployedTodaySol(), dailySolCap: config.dailySolCap, maxSolPerTrade: config.maxSolPerTrade,
      entryWaitMs: config.entryWaitMs, entryFollowThroughX: config.entryFollowThroughX,
      open, closes: S.closes.slice(0, 60), refusals: S.refusals.slice(0, 20), log: S.log.slice(0, 40), counters: { ...S.counters },
      book: { liveTrades: liveCloses.length, liveWins: liveCloses.filter((c) => (c.pnlSol ?? 0) > 0).length, liveLosses: liveCloses.filter((c) => (c.pnlSol ?? 0) < 0).length, unread: liveCloses.filter((c) => c.pnlSol === null).length, realizedSol },
      shadow: { rows: shadow ? shadow.rows().length : Object.keys(S.shadow).length, scorecard: scorecard() },
      policy: policyConfigFor(config),
      record: RECORD,
    };
  }

  return Object.freeze({
    start, stop, tick, handleNotice, onLogs, setConfig, setRpc, forgetPosition, status, exportShadow, scorecard, report, load,
    get config() { return config; },
    get state() { return S; },
    setControl(next) { control = { ...control, ...next }; say(`control: hard stop ${control.hardStop ? "ON" : "off"}, entries ${control.pauseEntries ? "PAUSED" : "open"}`); emit(); },
    onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  });
}
