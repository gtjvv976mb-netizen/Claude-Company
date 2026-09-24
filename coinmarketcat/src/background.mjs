/**
 * THE SERVICE WORKER: THE ENGINE'S HOST, AND NOTHING ELSE.
 *
 * Everything that decides lives in src/lib/engine.mjs and the executor modules it
 * imports. This file gives the engine a chrome.storage store, a fetch-backed RPC, the
 * websocket feed, a bridge to the console tab where Phantom lives, notifications and a
 * badge — and routes the popup's and the options page's messages to it.
 *
 * The bridge is the one piece worth reading twice. Phantom injects its provider into web
 * pages only, never into an extension's own pages, so signing has to happen in a tab
 * showing the console page (site/console/, published under the repository's GitHub Pages URL;
 * /hawk on the Claude Company site and a local serve are matched too). The content script there opens a port to
 * this worker; the injected script there talks to window.phantom.solana. A sign request
 * goes worker → content → injected → Phantom → back the same way, with an id, and the
 * engine checks that what came back is the bytes it asked for before anything is sent.
 * No console tab, no bridge, no Phantom signing — and the lane says so on the checklist.
 *
 * THE AUTOPILOT WALLET is the other signer, and this file is the only one that may import
 * it (test-hawk-no-key.mjs pins that). The keystore is built here over chrome.storage.local
 * (the encrypted blob) and chrome.storage.session (the unlocked key: memory only, trusted
 * contexts only, gone with the browser), the signer is refreshed when the worker starts and
 * after every keystore call, and the engine is handed both signers: config.signerMode
 * picks which one buys; a sell goes to whichever holds the position. On autopilot nothing
 * needs the console tab to trade — the keepalive alarm and the feed's socket keep the
 * worker up. The console tab is needed for one thing then: FUNDING, which is a transfer
 * from Phantom this file builds and Phantom approves in ONE window. SWEEP sends every token
 * and every lamport above the rent floor back to Phantom, signed by the autopilot wallet.
 * Nothing here logs, stores or sends a passphrase or a key; the one message that hands a
 * key back is the recovery export, which needs the passphrase.
 *
 * THE xSTOCK VENUE (off by default) needs nothing new from this file: the engine builds its
 * feed poller and its Jupiter client on the worker's own fetch (the manifest's https host
 * permission already covers api.jup.ag, api.geckoterminal.com, api.dexscreener.com), and
 * the same interval drives its tick. The popup's venue switch is an ordinary SET_CONFIG.
 */
import { createHawkEngine } from "./lib/engine.mjs";
import { createRpc, createLogsFeed } from "./lib/rpc.mjs";
import { PUMPFUN_PROGRAM_ID } from "../vendor/executor/snipe-venue-pumpfun.mjs";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, describeMint } from "../vendor/executor/token2022.mjs";
import {
  CONFIG_DEFAULTS, normalizeConfig, websocketUrlFor, ConfigError, quoteEntryFor, STOCK_FOCUS_CHOICES, AUTOPILOT_UNLOCK_MINUTES,
} from "./lib/config.mjs";
import { UI, BRIDGE, SIGN_ERRORS, BridgeError, nextId, AUTOPILOT } from "./lib/protocol.mjs";
import { fromBase64, toBase64, sameMessage, signatureOf, transactionFeeLamports, unitsToRaw, rawToUnits } from "./lib/tx.mjs";
import {
  createKeystore, createSessionSigner, buildFundTransaction, buildSweepTransaction, buildTokenSweepTransaction,
  buildTokenFundTransaction, buildCloseTokenAccountsTransaction, sweepableLamports, MAX_CLOSES_PER_TRANSACTION,
  SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS,
} from "./lib/session-wallet.mjs";

const STATE_KEY = "hawk:state";
const SHADOW_KEY = "hawk:shadow";
const CONFIG_KEY = "hawk:config";
const AUTOPILOT_META_KEY = "coinmarketcat:autopilot";   // { sweepTo, lastFund } — addresses and signatures, nothing secret
const PORT_NAME = "hawk-console";
const ALARM = "hawk-keepalive";
const EXPIRY_ALARM = "coinmarketcat-autopilot-expiry";
const FUND_PRIORITY_FEE_LAMPORTS = 10_000;   // a transfer is not in a race; this lands it under ordinary load
const SWEEP_COMPUTE_UNIT_LIMIT = 20_000;

/* ── storage ───────────────────────────────────────────────────────────────────────── */
let lastShadowFingerprint = null;
let lastShadowSaveAt = 0;
let saveTimer = null;
let pendingState = null;
const store = {
  async load() {
    const got = await chrome.storage.local.get([STATE_KEY, SHADOW_KEY]);
    const state = got[STATE_KEY] ?? null;
    if (state && got[SHADOW_KEY]) state.shadow = got[SHADOW_KEY];
    return state;
  },
  /** The book and the log go every second at most; the shadow rows, which can be
   *  megabytes, go only when they changed and at most every twenty seconds. */
  async save(state) {
    pendingState = state;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const s = pendingState; pendingState = null;
      if (!s) return;
      const { shadow, ...rest } = s;
      const writes = { [STATE_KEY]: rest };
      const rows = Object.values(shadow ?? {});
      const fingerprint = `${rows.length}:${rows.reduce((a, r) => a + (r.forward?.length ?? 0) + (r.outcome ? 1 : 0), 0)}`;
      if (fingerprint !== lastShadowFingerprint && Date.now() - lastShadowSaveAt > 20_000) {
        writes[SHADOW_KEY] = shadow ?? {};
        lastShadowFingerprint = fingerprint;
        lastShadowSaveAt = Date.now();
      }
      try { await chrome.storage.local.set(writes); } catch (error) { console.warn("hawk: storage.set failed", error); }
    }, 1_000);
  },
  /** Write whatever is queued now — before the engine is rebuilt on a changed RPC. */
  async flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const s = pendingState; pendingState = null;
    if (!s) return;
    const { shadow, ...rest } = s;
    lastShadowFingerprint = null;
    try { await chrome.storage.local.set({ [STATE_KEY]: rest, [SHADOW_KEY]: shadow ?? {} }); } catch (error) { console.warn("hawk: storage.set failed", error); }
  },
};
async function loadConfig() {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  try { return normalizeConfig({ ...CONFIG_DEFAULTS, ...(got[CONFIG_KEY] ?? {}) }); }
  catch (error) { console.warn("hawk: stored config was malformed, using defaults:", error.message); return normalizeConfig(CONFIG_DEFAULTS); }
}
async function saveConfig(config) { await chrome.storage.local.set({ [CONFIG_KEY]: config }); }

/* ── the autopilot wallet's keystore ───────────────────────────────────────────────────
   The { get, set, remove } shape session-wallet.mjs asks for, over the two chrome areas.
   The session area is pinned to trusted contexts (this worker and the extension's own
   pages): a content script cannot read it. */
const chromeArea = (area) => ({
  async get(key) { const got = await area.get(key); return got?.[key]; },
  async set(key, value) { await area.set({ [key]: value }); },
  async remove(key) { await area.remove(key); },
});
try { Promise.resolve(chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })).catch(() => {}); } catch { /* older Chrome: trusted-only is the default */ }
const keystore = createKeystore({ storage: chromeArea(chrome.storage.local), session: chromeArea(chrome.storage.session) });
const sessionSigner = createSessionSigner({ keystore });
async function readMeta() { const got = await chrome.storage.local.get(AUTOPILOT_META_KEY); return got[AUTOPILOT_META_KEY] ?? {}; }
async function writeMeta(patch) { await chrome.storage.local.set({ [AUTOPILOT_META_KEY]: { ...(await readMeta()), ...patch } }); }

/* ── the bridge to the console tab ─────────────────────────────────────────────────── */
const bridgeState = { port: null, tabId: null, origin: null, wallet: null, pending: new Map() };
const bridge = {
  isReady: () => bridgeState.port !== null,
  wallet: () => bridgeState.wallet,
  async request(type, payload = {}, { timeoutMs = 30_000 } = {}) {
    if (!bridgeState.port || bridgeState.tabId === null) throw new BridgeError(SIGN_ERRORS.NO_BRIDGE, "no console tab is open — open the console page and connect Phantom there");
    const id = nextId("bridge");
    const message = { type, id, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bridgeState.pending.delete(id);
        reject(new BridgeError(SIGN_ERRORS.TIMEOUT, `no answer from Phantom inside ${timeoutMs}ms`));
      }, timeoutMs);
      bridgeState.pending.set(id, { resolve, reject, timer });
      try { bridgeState.port.postMessage(message); }
      catch (error) {
        clearTimeout(timer); bridgeState.pending.delete(id);
        reject(new BridgeError(SIGN_ERRORS.NO_BRIDGE, `the console tab did not take the request: ${error?.message ?? error}`));
      }
    });
  },
  async connect({ onlyIfTrusted = false } = {}) { return bridge.request(BRIDGE.CONNECT, { onlyIfTrusted }, { timeoutMs: 60_000 }); },
  async disconnect() { return bridge.request(BRIDGE.DISCONNECT, {}, { timeoutMs: 10_000 }); },
  async signTransaction({ txBase64, purpose, mint, summary, timeoutMs, wallet }) {
    if (!bridgeState.wallet) throw new BridgeError(SIGN_ERRORS.NO_WALLET, "Phantom is not connected on the console page");
    if (wallet && wallet !== bridgeState.wallet) throw new BridgeError(SIGN_ERRORS.WALLET_MISMATCH, `Phantom is connected as ${bridgeState.wallet}, not ${wallet}`);
    return bridge.request(BRIDGE.SIGN, { txBase64, purpose, mint, summary, wallet: bridgeState.wallet }, { timeoutMs: Number(timeoutMs) || 25_000 });
  },
};
function settleReply(msg) {
  const p = bridgeState.pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  bridgeState.pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new BridgeError(msg.error?.code ?? SIGN_ERRORS.PROVIDER, msg.error?.message ?? "Phantom refused", msg.error ?? {}));
}
function dropBridge(reason) {
  for (const [id, p] of bridgeState.pending) { clearTimeout(p.timer); p.reject(new BridgeError(SIGN_ERRORS.NO_BRIDGE, `the console tab went away (${reason})`)); bridgeState.pending.delete(id); }
  bridgeState.port = null; bridgeState.tabId = null; bridgeState.origin = null;
  engine?.status && pushStatus();
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  if (bridgeState.port && bridgeState.port !== port) { try { bridgeState.port.disconnect(); } catch { /* gone */ } }
  bridgeState.port = port;
  bridgeState.tabId = port.sender?.tab?.id ?? null;
  bridgeState.origin = port.sender?.origin ?? port.sender?.url ?? null;
  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case BRIDGE.HELLO: pushStatus(); break;
      case BRIDGE.PING: break;
      case BRIDGE.ACCOUNT:
        bridgeState.wallet = typeof msg.publicKey === "string" && msg.publicKey.length > 30 ? msg.publicKey : null;
        log(bridgeState.wallet ? `Phantom connected as ${bridgeState.wallet}` : "Phantom disconnected");
        pushStatus();
        break;
      case BRIDGE.REPLY: settleReply(msg); break;
      case BRIDGE.PAGE_CONNECT:
        try { await bridge.connect({ onlyIfTrusted: false }); } catch (error) { log(`connect refused: ${error?.message ?? error}`); }
        break;
      case BRIDGE.PAGE_HELLO: pushStatus(); break;
      default: break;
    }
  });
  port.onDisconnect.addListener(() => { if (bridgeState.port === port) dropBridge("port closed"); });
  pushStatus();
});

/* ── the engine ────────────────────────────────────────────────────────────────────── */
let engine = null;
let config = null;
let starting = null;
const recentLog = [];
function log(line) { recentLog.unshift(`${new Date().toISOString().slice(11, 19)} ${line}`); if (recentLog.length > 50) recentLog.length = 50; console.log("hawk:", line); }

function notify({ kind, title, body, mint }) {
  try {
    chrome.notifications.create(`hawk-${kind}-${mint ?? ""}-${Date.now()}`, {
      type: "basic", iconUrl: chrome.runtime.getURL("icons/coinmarketcat-128.png"), title, message: body,
      priority: kind === "sell" || kind === "attention" ? 2 : 1, requireInteraction: kind === "sell",
    });
  } catch (error) { console.warn("hawk: notification failed", error); }
}
function rpcFor(cfg) {
  if (!cfg.rpcUrl) return { primary: null, secondary: null };
  return { primary: createRpc({ url: cfg.rpcUrl }), secondary: cfg.secondaryRpcUrl ? createRpc({ url: cfg.secondaryRpcUrl }) : null };
}
function feedFactoryFor(cfg) {
  const wsUrl = websocketUrlFor(cfg);
  if (!wsUrl) return null;
  return ({ onLogs, onState }) => createLogsFeed({ wsUrl, programId: PUMPFUN_PROGRAM_ID, onLogs, onState });
}
async function ensureEngine() {
  if (engine) return engine;
  if (starting) return starting;
  starting = (async () => {
    config = await loadConfig();
    const { primary, secondary } = rpcFor(config);
    engine = createHawkEngine({
      rpc: primary, secondaryRpc: secondary, bridge, sessionSigner, store, feedFactory: feedFactoryFor(config),
      log, notify, config,
    });
    engine.onStatus(() => scheduleStatusPush());
    await engine.start();                      // start() refreshes the signer: the keystore is read before anything arms
    scheduleExpiryAlarm();
    log(`engine up — lane ${config.lane}, signer ${config.signerMode}${config.rpcUrl ? "" : ", no RPC configured"}`);
    updateBadge();
    return engine;
  })();
  try { return await starting; } finally { starting = null; }
}
async function applyConfig(next) {
  const e = await ensureEngine();
  const merged = normalizeConfig({ ...config, ...next });
  const endpointsChanged = merged.rpcUrl !== config.rpcUrl || merged.rpcWsUrl !== config.rpcWsUrl || merged.secondaryRpcUrl !== config.secondaryRpcUrl;
  await saveConfig(merged);
  if (endpointsChanged) {
    /* The feed factory is bound at construction; a changed endpoint needs a fresh engine,
       started on the state the old one has written. */
    e.stop();
    await store.save(e.state);
    await store.flush();
    engine = null;
    config = merged;
    await ensureEngine();
  } else {
    config = await e.setConfig(merged);
  }
  updateBadge();
  return config;
}

/* ── status fan-out: popup, console page, badge ────────────────────────────────────── */
let statusTimer = null;
function scheduleStatusPush() { if (statusTimer) return; statusTimer = setTimeout(() => { statusTimer = null; pushStatus(); }, 250); }
function publicStatus() {
  if (!engine) return { lane: config?.lane ?? "off", signerMode: config?.signerMode ?? "phantom", bridgeReady: bridge.isReady(), wallet: bridge.wallet(), phantomWallet: bridge.wallet(), open: [], closes: [], log: recentLog.map((l) => ({ at: Date.now(), line: l })), booting: true };
  const s = engine.status();
  return { ...s, hostLog: recentLog.slice(0, 10), consoleOrigin: bridgeState.origin, consoleUrl: config?.consoleUrl ?? CONFIG_DEFAULTS.consoleUrl, setupCompletedAt: config?.setupCompletedAt ?? 0 };
}
function pushStatus() {
  const status = publicStatus();
  updateBadge(status);
  try { chrome.runtime.sendMessage({ type: UI.STATUS_CHANGED, status }).catch(() => {}); } catch { /* no popup open */ }
  if (bridgeState.port) { try { bridgeState.port.postMessage({ type: BRIDGE.STATUS, status: consoleStatus(status) }); } catch { /* gone */ } }
}
/** What the page may see: no RPC URL, no config beyond the dials it needs to explain itself.
 *  `wallet` is PHANTOM's here, whatever the mode — the page is where Phantom lives, and its
 *  Connect button reads it; on autopilot the lane's own wallet travels as `laneWallet`. */
function consoleStatus(s) {
  return {
    lane: s.lane, executing: s.executing, armable: s.armable, wallet: s.phantomWallet ?? null, bridgeReady: s.bridgeReady,
    signerMode: s.signerMode ?? "phantom", laneWallet: s.wallet ?? null,
    feed: s.feed, control: s.control, entryInFlight: s.entryInFlight, deployedTodaySol: s.deployedTodaySol, dailySolCap: s.dailySolCap,
    maxSolPerTrade: s.maxSolPerTrade, entryWaitMs: s.entryWaitMs, entryFollowThroughX: s.entryFollowThroughX,
    /* The listed stocks, today's spend in each, and the canary rule in its own words: a
       page that shows a stock-quoted position must be able to name what it was paid in. */
    quoteMints: (s.quoteMints ?? []).map((q) => ({ mint: q.mint, symbol: q.symbol, maxPerTrade: q.maxPerTrade, minPerTrade: q.minPerTrade, dailyCap: q.dailyCap, deployedToday: q.deployedToday, canary: q.canary, nextLiveTicket: q.nextLiveTicket, paused: q.paused })),
    deployedTodayQuote: s.deployedTodayQuote ?? {}, stockCanaryRule: s.stockCanaryRule ?? null,
    open: (s.open ?? []).map((p) => ({ mint: p.mint, symbol: p.symbol, live: p.live, openedAt: p.openedAt, lastMarkX: p.lastMarkX, pendingSell: p.pendingSell ?? null, graduated: p.graduated ?? null, waitedOut: p.waitedOut ?? null, sizeSol: p.sizeSol,
      quoteMint: p.quoteMint ?? null, quoteSymbol: p.quoteSymbol ?? null, quoteDecimals: p.quoteDecimals ?? null, quotePaused: p.quotePaused ?? null, canary: p.canary ?? null,
      venue: p.venue ?? null, pool: p.pool ?? null, dex: p.dex ?? null })),
    closes: (s.closes ?? []).slice(0, 20), refusals: (s.refusals ?? []).slice(0, 10), log: (s.log ?? []).slice(0, 15),
    counters: s.counters, book: s.book, shadow: s.shadow, policy: s.policy, record: s.record, version: s.version,
    armability: s.armability ? { armable: s.armability.armable, blocking: s.armability.blocking, warnings: s.armability.warnings, items: s.armability.items } : null,
  };
}
function updateBadge(status = null) {
  const s = status ?? (engine ? engine.status() : null);
  let text = "", color = "#7a6d9c";
  if (s?.executing) { text = s.signerMode === "autopilot" ? "AUTO" : "LIVE"; color = "#ff6b5a"; }
  else if (s?.lane === "observe") { text = "OBS"; color = "#9945ff"; }
  else if (s?.lane === "execute") { text = "ARM?"; color = "#e0ad3d"; }
  if ((s?.open ?? []).some((p) => p.live && p.pendingSell)) { text = "SELL"; color = "#ff6b5a"; }
  try { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); } catch { /* no action */ }
}

/* ── the autopilot wallet: fund, sweep, lock, and the rest ──────────────────────────── */
const lamportsToSol = (v) => Number(BigInt(v)) / 1e9;
const shortKey = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : String(k));
function hostRpc() {
  if (!config?.rpcUrl) throw new Error("set an RPC URL in Options first: funding, sweeping and the balance all read the chain");
  return createRpc({ url: config.rpcUrl });
}
/** The name to show for a mint the autopilot wallet holds: a listed or known stock's
 *  symbol, a position's symbol, else the short address. */
function symbolsByMint() {
  const out = new Map();
  if (engine) { const s = engine.status(); for (const p of [...(s.closes ?? []), ...(s.open ?? [])]) if (p.symbol) out.set(p.mint, p.symbol); }
  for (const k of STOCK_FOCUS_CHOICES) out.set(k.mint, k.symbol);
  for (const q of config?.quoteMints ?? []) out.set(q.mint, q.symbol);
  return out;
}
async function tokenHoldings(rpc, owner) {
  const lists = await Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) => rpc.getTokenAccountsByOwner(owner, { programId })));
  const names = symbolsByMint();
  return lists.flat().map((h) => ({ ...h, symbol: names.get(h.mint) ?? shortKey(h.mint), ui: Number.isInteger(h.decimals) ? rawToUnits(h.amountRaw, h.decimals) : h.amountRaw }));
}
/** After every keystore call: re-read it, refresh the engine's view, re-arm the expiry alarm. */
async function afterKeystoreChange() {
  const e = await ensureEngine();
  await e.refreshSigner();
  scheduleExpiryAlarm();
  pushStatus();
}
function scheduleExpiryAlarm() {
  const snap = keystore.snapshot();
  try {
    if (snap.unlocked && Number.isFinite(snap.expiresAt)) chrome.alarms.create(EXPIRY_ALARM, { when: snap.expiresAt + 1_000 });
    else chrome.alarms.clear(EXPIRY_ALARM);
  } catch { /* no alarms: the snapshot still judges expiry against the clock */ }
}
/** Only the extension's own pages (popup, options, the setup page) may drive the autopilot
 *  wallet — never a web page, never a content script. */
function fromExtensionPage(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const base = chrome.runtime.getURL("");
  return typeof sender.url === "string" && sender.url.startsWith(base);
}
/** Check the signed bytes are the message that was built, send them, wait for the chain. */
async function sendSignedAndConfirm(rpc, unsignedBase64, signed, lastValidBlockHeight, { timeoutMs = 90_000 } = {}) {
  const signedBytes = fromBase64(signed?.signedBase64 ?? signed);
  if (!sameMessage(fromBase64(unsignedBase64), signedBytes)) throw new Error("the transaction that came back is not the one that was asked for — refusing to send it");
  const signature = signatureOf(signedBytes);
  await rpc.sendTransaction(toBase64(signedBytes), { skipPreflight: false });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await rpc.getSignatureStatus(signature).catch(() => null);
    if (status?.err) throw new Error(`${signature} failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    const height = await rpc.getBlockHeight().catch(() => null);
    if (Number.isFinite(height) && Number.isFinite(lastValidBlockHeight) && height > lastValidBlockHeight) throw new Error(`${signature} expired unlanded — nothing moved; try again`);
    if (Date.now() > deadline) throw new Error(`${signature} has no status after ${Math.round(timeoutMs / 1000)} s — check an explorer before trying again`);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}
const simError = (sim) => `${JSON.stringify(sim.err)}${Array.isArray(sim.logs) && sim.logs.length ? ` — ${sim.logs.slice(-2).join(" | ")}` : ""}`;

async function autopilotStatus() {
  const e = await ensureEngine();
  const snap = keystore.snapshot();
  const meta = await readMeta();
  const publicKey = snap.publicKey;
  let balanceLamports = null, tokens = [], readError = null;
  if (publicKey && config.rpcUrl) {
    const rpc = hostRpc();
    try { balanceLamports = (await rpc.getBalance(publicKey)).toString(); } catch (error) { readError = String(error?.message ?? error); }
    try { tokens = (await tokenHoldings(rpc, publicKey)).filter((h) => BigInt(h.amountRaw) > 0n); } catch (error) { readError ??= String(error?.message ?? error); }
  }
  const st = e.status();
  return {
    exists: Boolean(publicKey), publicKey, unlocked: snap.unlocked, expiresAt: snap.expiresAt,
    signerMode: config.signerMode, unlockMinutes: config.autopilotUnlockMinutes, unlockMinutesRange: AUTOPILOT_UNLOCK_MINUTES,
    fundAssets: [{ asset: "SOL", symbol: "SOL", defaultAmount: config.dailySolCap }, ...(config.quoteMints ?? []).map((q) => ({ asset: q.mint, symbol: q.symbol, defaultAmount: q.dailyCap }))],
    phantomWallet: bridge.wallet(), phantomReady: bridge.isReady(), sweepTo: bridge.wallet() ?? meta.sweepTo ?? null,
    balanceLamports, balanceSol: balanceLamports === null ? null : lamportsToSol(balanceLamports), rentFloorLamports: SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS,
    tokens: tokens.map((t) => ({ mint: t.mint, symbol: t.symbol, amountRaw: t.amountRaw, decimals: t.decimals, ui: t.ui })),
    liveHeld: st.autopilotHeld ?? 0, lastFund: meta.lastFund ?? null, lastSweep: meta.lastSweep ?? null, readError,
  };
}

async function autopilotCreate(msg) {
  const e = await ensureEngine();
  if (typeof msg.passphrase !== "string" || msg.passphrase !== msg.confirm) throw new Error("the two passphrases do not match — type the same one twice");
  const replace = msg.replace === true;
  if (replace) {
    /* A wallet with money in it is not replaced from here: sweep it back first. */
    const existing = await keystore.publicKey();
    if (existing) {
      if ((e.status().autopilotHeld ?? 0) > 0) throw new Error("the autopilot wallet holds a live position — it must be sold or forgotten before the wallet is replaced");
      const rpc = hostRpc();
      const balance = await rpc.getBalance(existing);
      if (balance > BigInt(SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS) + 10_000n)
        throw new Error(`the autopilot wallet still holds ${lamportsToSol(balance)} SOL — sweep it back to Phantom before replacing it`);
      if ((await tokenHoldings(rpc, existing)).some((h) => BigInt(h.amountRaw) > 0n))
        throw new Error("the autopilot wallet still holds tokens — sweep it back to Phantom before replacing it");
    }
  }
  const made = await keystore.create({ passphrase: msg.passphrase, replace, currentPassphrase: msg.currentPassphrase });
  log(made.replaced ? `autopilot wallet replaced: ${made.replaced} → ${made.publicKey}` : `autopilot wallet created: ${made.publicKey} (locked; fund it from Phantom, then unlock)`);
  await afterKeystoreChange();
  return { ok: true, publicKey: made.publicKey, replaced: made.replaced };
}

async function autopilotUnlock(msg) {
  await ensureEngine();
  const minutes = msg.minutes === undefined || msg.minutes === null || msg.minutes === "" ? config.autopilotUnlockMinutes : Number(msg.minutes);
  if (!(Number.isInteger(minutes) && minutes >= AUTOPILOT_UNLOCK_MINUTES.min && minutes <= AUTOPILOT_UNLOCK_MINUTES.max))
    throw new Error(`unlock for a whole number of minutes from ${AUTOPILOT_UNLOCK_MINUTES.min} to ${AUTOPILOT_UNLOCK_MINUTES.max}`);
  const unlocked = await keystore.unlock({ passphrase: msg.passphrase, ttlMs: minutes * 60_000 });
  log(`autopilot wallet unlocked for ${minutes} min, until ${new Date(unlocked.expiresAt).toISOString().slice(11, 16)} UTC`);
  await afterKeystoreChange();
  return { ok: true, expiresAt: unlocked.expiresAt };
}

async function autopilotLock() {
  const e = await ensureEngine();
  await keystore.lock();
  log("autopilot wallet locked — the unlocked key is cleared from session storage; it signs nothing until unlocked");
  await afterKeystoreChange();
  return { ok: true, liveHeld: e.status().autopilotHeld ?? 0 };
}

async function autopilotExport(msg) {
  await ensureEngine();
  const secretBase58 = await keystore.exportSecret({ passphrase: msg.passphrase });
  log("the autopilot wallet's key was exported for recovery — treat that wallet as exposed: sweep it and replace it");
  return { ok: true, secretBase58 };
}

/** Phantom → the autopilot wallet: SOL (default: the day's budget) or a listed stock. Built
 *  here, simulated, then ONE Phantom approval on the console tab. */
async function autopilotFund(msg) {
  const e = await ensureEngine();
  const to = await keystore.publicKey();
  if (!to) throw new Error("create the autopilot wallet first");
  const from = bridge.wallet();
  if (!from || !bridge.isReady()) throw new Error("open the console page and connect Phantom: funding is one Phantom approval, asked on that tab");
  const rpc = hostRpc();
  const asset = typeof msg.asset === "string" && msg.asset ? msg.asset : "SOL";
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  let built;
  if (asset === "SOL") {
    const amount = msg.amount === undefined || msg.amount === null || msg.amount === "" ? config.dailySolCap : msg.amount;
    let lamports;
    try { lamports = unitsToRaw(String(amount).trim(), 9, "the SOL amount"); } catch (error) { throw new Error(error.message); }
    if (lamports <= 0n) throw new Error("the SOL amount must be more than zero");
    built = buildFundTransaction({ from, to, lamports, blockhash, priorityFeeLamports: FUND_PRIORITY_FEE_LAMPORTS });
  } else {
    const entry = quoteEntryFor(config, asset);
    if (!entry) throw new Error("only a stock listed in Options → Stock quotes can be funded from here");
    const read = await rpc.getMultipleAccounts([asset]);
    const facts = describeMint(read.accounts[0] ?? null, asset);
    if (facts.metadataSymbol && facts.metadataSymbol !== entry.symbol) throw new Error(`the list names ${shortKey(asset)} ${entry.symbol}, but that mint calls itself ${facts.metadataSymbol}`);
    if (facts.paused) throw new Error(`${entry.symbol} is paused by its issuer: nothing can move it now`);
    if (facts.transferHookProgram) throw new Error(`${entry.symbol}'s transfer hook points at ${facts.transferHookProgram}; this extension does not move a hooked token`);
    const amount = msg.amount === undefined || msg.amount === null || msg.amount === "" ? entry.dailyCap : msg.amount;
    let amountRaw;
    try { amountRaw = unitsToRaw(String(amount).trim(), facts.decimals, `the ${entry.symbol} amount`); } catch (error) { throw new Error(error.message); }
    if (amountRaw <= 0n) throw new Error(`the ${entry.symbol} amount must be more than zero`);
    built = buildTokenFundTransaction({ from, to, mint: asset, amountRaw, tokenProgram: facts.program, decimals: facts.decimals, blockhash, priorityFeeLamports: FUND_PRIORITY_FEE_LAMPORTS, symbol: entry.symbol });
  }
  /* A transfer Phantom's balance cannot cover is refused here, not in a window. */
  const sim = await rpc.simulateTransaction(built.txBase64, { addresses: [from, to] });
  if (sim?.err) throw new Error(`the funding transfer would fail, so Phantom was not asked: ${simError(sim)}`);
  log(`asking Phantom to approve: ${built.summary}`);
  const signed = await bridge.signTransaction({ txBase64: built.txBase64, purpose: built.purpose, mint: built.mint ?? null, summary: built.summary, timeoutMs: 120_000, wallet: from });
  const signature = await sendSignedAndConfirm(rpc, built.txBase64, signed, lastValidBlockHeight);
  await writeMeta({ sweepTo: from, lastFund: { at: Date.now(), signature, asset, summary: built.summary } });
  log(`${built.summary} — landed, sig ${signature}`);
  await e.refreshSigner();
  pushStatus();
  return { ok: true, signature, summary: built.summary };
}

/** The autopilot wallet → Phantom: every token it holds (TransferChecked, the emptied
 *  account closed for its rent), every empty token account closed, then every lamport
 *  above the rent floor. Signed by the autopilot wallet; Phantom is asked nothing. */
async function autopilotSweep(msg) {
  const e = await ensureEngine();
  const from = await keystore.publicKey();
  if (!from) throw new Error("there is no autopilot wallet to sweep");
  if (!sessionSigner.isReady()) throw new Error("unlock the autopilot wallet first: the sweep is signed by it");
  const meta = await readMeta();
  const to = bridge.wallet() ?? meta.sweepTo ?? null;
  if (!to) throw new Error("connect Phantom on the console page first: the sweep goes back to your Phantom wallet");
  if (msg.expectTo !== to) throw new Error(`the sweep would go to ${to}, not to ${msg.expectTo ?? "the address you confirmed"} — reopen the popup and confirm again`);
  const st = e.status();
  if ((st.autopilotHeld ?? 0) > 0)
    throw new Error(`the autopilot wallet holds ${st.autopilotHeld} live position${st.autopilotHeld === 1 ? "" : "s"}: let the lane sell (or press HARD STOP), or Forget a row you sold by hand, before sweeping — a sweep would leave the position no SOL to sell with`);
  if (st.entryInFlight) throw new Error("a buy is being signed right now — sweep after it settles");
  const rpc = hostRpc();
  const done = { to, tokens: [], closed: 0, sol: null, skipped: [] };
  const sign = (built) => sessionSigner.signTransaction({ txBase64: built.txBase64, purpose: built.purpose, summary: built.summary, wallet: from });

  /* 1 — every token with a balance. A Token-2022 mint is read first: a paused one cannot
     move, a live hook needs accounts this builder does not resolve. */
  const holdings = (await tokenHoldings(rpc, from)).filter((h) => BigInt(h.amountRaw) > 0n);
  const t22 = [...new Set(holdings.filter((h) => h.programId === TOKEN_2022_PROGRAM).map((h) => h.mint))];
  const facts = new Map();
  if (t22.length) {
    const read = await rpc.getMultipleAccounts(t22);
    t22.forEach((mint, i) => { try { facts.set(mint, describeMint(read.accounts[i] ?? null, mint)); } catch (error) { facts.set(mint, { error: error.message }); } });
  }
  for (const h of holdings) {
    const f = facts.get(h.mint);
    if (f?.error) { done.skipped.push({ mint: h.mint, symbol: h.symbol, why: `its mint could not be read: ${f.error}` }); continue; }
    if (f?.paused) { done.skipped.push({ mint: h.mint, symbol: h.symbol, why: "paused by its issuer: nothing can move it until it is unpaused" }); continue; }
    if (f?.transferHookProgram) { done.skipped.push({ mint: h.mint, symbol: h.symbol, why: "a live transfer hook: move it by hand from the exported key" }); continue; }
    let moved = false;
    for (const closeSource of [true, false]) {
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const built = buildTokenSweepTransaction({ from, to, mint: h.mint, amountRaw: h.amountRaw, tokenProgram: h.programId, decimals: h.decimals, blockhash, closeSource, symbol: h.symbol });
      const sim = await rpc.simulateTransaction(built.txBase64, { addresses: [from] });
      if (sim?.err) { if (closeSource) continue; done.skipped.push({ mint: h.mint, symbol: h.symbol, why: `the transfer would fail: ${simError(sim)}` }); break; }
      const signature = await sendSignedAndConfirm(rpc, built.txBase64, await sign(built), lastValidBlockHeight);
      done.tokens.push({ mint: h.mint, symbol: h.symbol, amountRaw: h.amountRaw, decimals: h.decimals, ui: h.ui, signature, closed: closeSource });
      log(`${built.summary} — landed, sig ${signature}`);
      moved = true;
      break;
    }
    if (!moved && !done.skipped.some((s) => s.mint === h.mint)) done.skipped.push({ mint: h.mint, symbol: h.symbol, why: "the transfer could not be built" });
  }

  /* 2 — the empty token accounts every buy leaves behind: closed, their rent back here. */
  const empty = (await tokenHoldings(rpc, from)).filter((h) => BigInt(h.amountRaw) === 0n);
  for (let i = 0; i < empty.length; i += MAX_CLOSES_PER_TRANSACTION) {
    const batch = empty.slice(i, i + MAX_CLOSES_PER_TRANSACTION);
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const built = buildCloseTokenAccountsTransaction({ owner: from, accounts: batch.map((h) => ({ address: h.address, tokenProgram: h.programId })), blockhash });
    const sim = await rpc.simulateTransaction(built.txBase64, { addresses: [from] });
    if (sim?.err) { done.skipped.push({ accounts: batch.length, why: `closing ${batch.length} empty account(s) would fail: ${simError(sim)}` }); continue; }
    const signature = await sendSignedAndConfirm(rpc, built.txBase64, await sign(built), lastValidBlockHeight);
    done.closed += batch.length;
    log(`${built.summary} — landed, sig ${signature}`);
  }

  /* 3 — the SOL above the rent floor, to the lamport: the fee is computed, not guessed. */
  const balance = await rpc.getBalance(from);
  const fee = transactionFeeLamports({ computeUnitLimit: SWEEP_COMPUTE_UNIT_LIMIT, priorityFeeLamports: 0 });
  const lamports = sweepableLamports({ balanceLamports: balance, feeLamports: fee });
  if (lamports > 0n) {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const built = buildSweepTransaction({ from, to, lamports, blockhash, computeUnitLimit: SWEEP_COMPUTE_UNIT_LIMIT, priorityFeeLamports: 0 });
    const signature = await sendSignedAndConfirm(rpc, built.txBase64, await sign(built), lastValidBlockHeight);
    done.sol = { lamports: lamports.toString(), sol: lamportsToSol(lamports), signature };
    log(`${built.summary} — landed, sig ${signature}`);
  } else done.solNote = `the balance is at the ${lamportsToSol(SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS)} SOL rent floor: nothing above it to sweep`;
  await writeMeta({ lastSweep: { at: Date.now(), to, sol: done.sol?.sol ?? 0, tokens: done.tokens.length, closed: done.closed } });
  await e.refreshSigner();
  pushStatus();
  return { ok: true, ...done };
}

/* ── messages from the popup, the options page and the setup page ──────────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("hawk:autopilot:")) return false;
  (async () => {
    if (!fromExtensionPage(sender)) return { ok: false, error: "the autopilot wallet answers the extension's own pages only" };
    try {
      switch (msg.type) {
        case AUTOPILOT.STATUS: return { ok: true, autopilot: await autopilotStatus() };
        case AUTOPILOT.CREATE: return await autopilotCreate(msg);
        case AUTOPILOT.UNLOCK: return await autopilotUnlock(msg);
        case AUTOPILOT.LOCK: return await autopilotLock();
        case AUTOPILOT.FUND: return await autopilotFund(msg);
        case AUTOPILOT.SWEEP: return await autopilotSweep(msg);
        case AUTOPILOT.EXPORT_SECRET: return await autopilotExport(msg);
        default: return { ok: false, error: `unknown message ${msg.type}` };
      }
    } catch (error) {
      /* The message only: SessionWalletError, BridgeError and RpcError never carry a
         passphrase or a key, and nothing here is logged. */
      return { ok: false, error: error?.message ?? String(error), code: error?.code ?? error?.clause };
    }
  })().then(sendResponse);
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("hawk:ui:")) return false;
  (async () => {
    try {
      switch (msg.type) {
        case UI.GET_STATUS: await ensureEngine(); return { ok: true, status: publicStatus() };
        case UI.GET_CONFIG: await ensureEngine(); return { ok: true, config };
        case UI.SET_CONFIG: { const saved = await applyConfig(msg.config ?? {}); pushStatus(); return { ok: true, config: saved }; }
        case UI.ARM: {
          const lane = msg.lane === "execute" ? "execute" : msg.lane === "observe" ? "observe" : "off";
          const saved = await applyConfig({ lane, ...(typeof msg.liveAck === "string" ? { liveAck: msg.liveAck } : {}) });
          pushStatus();
          return { ok: true, config: saved, status: publicStatus() };
        }
        case UI.DISARM: { const saved = await applyConfig({ lane: "off" }); pushStatus(); return { ok: true, config: saved }; }
        case UI.HARD_STOP: { const e = await ensureEngine(); e.setControl({ hardStop: msg.on === true }); pushStatus(); return { ok: true }; }
        case UI.PAUSE: { const e = await ensureEngine(); e.setControl({ pauseEntries: msg.on === true }); pushStatus(); return { ok: true }; }
        case UI.CONNECT: { await ensureEngine(); await bridge.connect({ onlyIfTrusted: false }); return { ok: true, wallet: bridge.wallet() }; }
        case UI.FORGET_POSITION: { const e = await ensureEngine(); const done = await e.forgetPosition(msg.mint); pushStatus(); return { ok: done }; }
        case UI.CLEAR_STOCK_CANARY: { const e = await ensureEngine(); const done = await e.clearStockCanary(msg.mint, { venue: msg.venue === "jupiter-xstock" ? "jupiter-xstock" : null }); pushStatus(); return { ok: done }; }
        case UI.OPEN_CONSOLE: {
          await ensureEngine();
          const url = config.consoleUrl;
          /* tabs.query sees only tabs under a host permission (the https wildcard): a console
             served from http://localhost is not found and a second tab opens. Accepted for the
             local dev case rather than asking for the `tabs` permission the manifest lacks on purpose. */
          const tabs = await chrome.tabs.query({ url: `${url.split("#")[0].split("?")[0]}*` }).catch(() => []);
          if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch { /* fine */ } }
          else await chrome.tabs.create({ url });
          return { ok: true };
        }
        case "hawk:ui:export-shadow": { const e = await ensureEngine(); return { ok: true, jsonl: e.exportShadow(), rows: e.status().shadow.rows }; }
        case "hawk:ui:report": { const e = await ensureEngine(); return { ok: true, report: e.report() }; }
        default: return { ok: false, error: `unknown message ${msg.type}` };
      }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), key: error instanceof ConfigError ? error.key : undefined, code: error?.code };
    }
  })().then(sendResponse);
  return true;
});

/* ── lifecycle ─────────────────────────────────────────────────────────────────────── */
/** The first-run setup page, opened once when the extension is installed — not on an
 *  update, not on a browser start. Everything it sets stays editable in Options. */
const WELCOME_PAGE = "welcome.html";
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  ensureEngine().catch((e) => log(`boot failed: ${e.message}`));
  if (details?.reason === "install") {
    try { Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) })).catch(() => {}); } catch { /* no tabs API: the popup links it */ }
  }
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); ensureEngine().catch((e) => log(`boot failed: ${e.message}`)); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) ensureEngine().catch((e) => log(`wake failed: ${e.message}`));
  if (alarm.name === EXPIRY_ALARM) {
    /* The unlock ran out: the snapshot already says locked (it judges the clock); this
       re-reads the store, which removes the expired entry, and says so out loud. */
    ensureEngine().then(async (e) => {
      await e.refreshSigner();
      if (!keystore.snapshot().unlocked) {
        log("the autopilot wallet's unlock ran out — it is locked and signs nothing until you unlock it");
        const held = e.status().autopilotHeld ?? 0;
        notify({ kind: "attention", title: "COINMARKETCAT: the autopilot wallet locked itself", body: held
          ? `Its unlock ran out while it holds ${held} live position${held === 1 ? "" : "s"}. Unlock it in the popup so the lane can sell.`
          : "Its unlock ran out. The lane buys nothing on autopilot until you unlock it again." });
      }
      pushStatus();
    }).catch((e) => log(`expiry check failed: ${e.message}`));
  }
});
chrome.notifications.onClicked.addListener((id) => {
  try { chrome.notifications.clear(id); } catch { /* fine */ }
  ensureEngine().then(async () => {
    const url = config.consoleUrl;
    const tabs = await chrome.tabs.query({ url: `${url.split("#")[0].split("?")[0]}*` }).catch(() => []);
    if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch { /* fine */ } }
    else await chrome.tabs.create({ url });
  }).catch(() => {});
});
ensureEngine().catch((e) => log(`boot failed: ${e.message}`));
