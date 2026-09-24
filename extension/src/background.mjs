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
 * showing the console page (/hawk on the site). The content script there opens a port to
 * this worker; the injected script there talks to window.phantom.solana. A sign request
 * goes worker → content → injected → Phantom → back the same way, with an id, and the
 * engine checks that what came back is the bytes it asked for before anything is sent.
 * No console tab, no bridge, no signing — and the lane says so on the checklist.
 */
import { createHawkEngine } from "./lib/engine.mjs";
import { createRpc, createLogsFeed } from "./lib/rpc.mjs";
import { PUMPFUN_PROGRAM_ID } from "../../executor/snipe-venue-pumpfun.mjs";
import { CONFIG_DEFAULTS, normalizeConfig, websocketUrlFor, ConfigError } from "./lib/config.mjs";
import { UI, BRIDGE, SIGN_ERRORS, BridgeError, nextId } from "./lib/protocol.mjs";

const STATE_KEY = "hawk:state";
const SHADOW_KEY = "hawk:shadow";
const CONFIG_KEY = "hawk:config";
const PORT_NAME = "hawk-console";
const ALARM = "hawk-keepalive";

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
      type: "basic", iconUrl: chrome.runtime.getURL("icons/hawk-128.png"), title, message: body,
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
      rpc: primary, secondaryRpc: secondary, bridge, store, feedFactory: feedFactoryFor(config),
      log, notify, config,
    });
    engine.onStatus(() => scheduleStatusPush());
    await engine.start();
    log(`engine up — lane ${config.lane}${config.rpcUrl ? "" : ", no RPC configured"}`);
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
  if (!engine) return { lane: config?.lane ?? "off", bridgeReady: bridge.isReady(), wallet: bridge.wallet(), open: [], closes: [], log: recentLog.map((l) => ({ line: l })), booting: true };
  const s = engine.status();
  return { ...s, hostLog: recentLog.slice(0, 10), consoleOrigin: bridgeState.origin, consoleUrl: config?.consoleUrl ?? CONFIG_DEFAULTS.consoleUrl };
}
function pushStatus() {
  const status = publicStatus();
  updateBadge(status);
  try { chrome.runtime.sendMessage({ type: UI.STATUS_CHANGED, status }).catch(() => {}); } catch { /* no popup open */ }
  if (bridgeState.port) { try { bridgeState.port.postMessage({ type: BRIDGE.STATUS, status: consoleStatus(status) }); } catch { /* gone */ } }
}
/** What the page may see: no RPC URL, no config beyond the dials it needs to explain itself. */
function consoleStatus(s) {
  return {
    lane: s.lane, executing: s.executing, armable: s.armable, wallet: s.wallet, bridgeReady: s.bridgeReady,
    feed: s.feed, control: s.control, entryInFlight: s.entryInFlight, deployedTodaySol: s.deployedTodaySol, dailySolCap: s.dailySolCap,
    maxSolPerTrade: s.maxSolPerTrade, entryWaitMs: s.entryWaitMs, entryFollowThroughX: s.entryFollowThroughX,
    open: (s.open ?? []).map((p) => ({ mint: p.mint, symbol: p.symbol, live: p.live, openedAt: p.openedAt, lastMarkX: p.lastMarkX, pendingSell: p.pendingSell ?? null, graduated: p.graduated ?? null, waitedOut: p.waitedOut ?? null, sizeSol: p.sizeSol })),
    closes: (s.closes ?? []).slice(0, 20), refusals: (s.refusals ?? []).slice(0, 10), log: (s.log ?? []).slice(0, 15),
    counters: s.counters, book: s.book, shadow: s.shadow, policy: s.policy, record: s.record, version: s.version,
    armability: s.armability ? { armable: s.armability.armable, blocking: s.armability.blocking, warnings: s.armability.warnings, items: s.armability.items } : null,
  };
}
function updateBadge(status = null) {
  const s = status ?? (engine ? engine.status() : null);
  let text = "", color = "#7a6d9c";
  if (s?.executing) { text = "LIVE"; color = "#ff6b5a"; }
  else if (s?.lane === "observe") { text = "OBS"; color = "#9945ff"; }
  else if (s?.lane === "execute") { text = "ARM?"; color = "#e0ad3d"; }
  if ((s?.open ?? []).some((p) => p.live && p.pendingSell)) { text = "SELL"; color = "#ff6b5a"; }
  try { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); } catch { /* no action */ }
}

/* ── messages from the popup and the options page ──────────────────────────────────── */
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
        case UI.OPEN_CONSOLE: {
          await ensureEngine();
          const url = config.consoleUrl;
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
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); ensureEngine().catch((e) => log(`boot failed: ${e.message}`)); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); ensureEngine().catch((e) => log(`boot failed: ${e.message}`)); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) ensureEngine().catch((e) => log(`wake failed: ${e.message}`)); });
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
