/**
 * THE WIRE BETWEEN THE FOUR PLACES THIS EXTENSION RUNS.
 *
 *   popup / options ──runtime.sendMessage──▶ background (the engine)
 *   background ──tabs.sendMessage──▶ content script ──window.postMessage──▶ injected (Phantom)
 *
 * Every message carries `type` from one of the tables below. Nothing else is accepted:
 * the content script relays only HAWK_TO_PAGE types page-ward and only HAWK_FROM_PAGE
 * types extension-ward, and the injected script answers only requests it recognises
 * from `window` itself, stamped with the nonce the content script minted at injection.
 * A page script can therefore ask the bridge for a connection or a status line, and can
 * never ask it for a signature — signatures are requested by the background only.
 */
export const CHANNEL = "claudeco-hawk";

/** popup/options → background */
export const UI = Object.freeze({
  GET_STATUS: "hawk:ui:get-status",
  GET_CONFIG: "hawk:ui:get-config",
  SET_CONFIG: "hawk:ui:set-config",
  ARM: "hawk:ui:arm",            // { lane: "observe" | "execute" }
  DISARM: "hawk:ui:disarm",
  HARD_STOP: "hawk:ui:hard-stop", // { on: boolean }
  PAUSE: "hawk:ui:pause",         // { on: boolean }
  CONNECT: "hawk:ui:connect",     // ask the console tab to connect Phantom
  FORGET_POSITION: "hawk:ui:forget-position", // { mint } — closes a row the user sold by hand
  OPEN_CONSOLE: "hawk:ui:open-console",
  STATUS_CHANGED: "hawk:ui:status-changed",   // background → popup (broadcast)
});

/** background → content → injected (requests), and back (replies with the same id) */
export const BRIDGE = Object.freeze({
  HELLO: "hawk:bridge:hello",              // content → background on load: { origin, nonce }
  PING: "hawk:bridge:ping",                // content → background keepalive
  CONNECT: "hawk:bridge:connect",          // background → injected: { onlyIfTrusted }
  DISCONNECT: "hawk:bridge:disconnect",
  SIGN: "hawk:bridge:sign",                // background → injected: { txBase64, purpose, mint, summary }
  ACCOUNT: "hawk:bridge:account",          // injected → background: { publicKey|null } on connect/change
  REPLY: "hawk:bridge:reply",              // injected → background: { id, ok, result|error }
  STATUS: "hawk:bridge:status",            // background → page: the status the console renders
  PAGE_CONNECT: "hawk:page:connect",       // page → content: the user pressed Connect on the page
  PAGE_HELLO: "hawk:page:hello",           // page → content: "is the extension here?"
});

export const HAWK_TO_PAGE = Object.freeze(new Set([BRIDGE.CONNECT, BRIDGE.DISCONNECT, BRIDGE.SIGN, BRIDGE.STATUS]));
export const HAWK_FROM_PAGE = Object.freeze(new Set([BRIDGE.ACCOUNT, BRIDGE.REPLY, BRIDGE.PAGE_CONNECT, BRIDGE.PAGE_HELLO]));

export const SIGN_ERRORS = Object.freeze({
  REJECTED: "rejected",        // the user pressed Reject in Phantom
  TIMEOUT: "timeout",          // the window sat past approvalTimeoutMs
  NO_BRIDGE: "no_bridge",      // no console tab is open
  NO_WALLET: "no_wallet",      // Phantom is not connected
  WALLET_MISMATCH: "wallet_mismatch", // Phantom switched accounts under the lane
  PROVIDER: "provider",        // Phantom threw something else
});

export class BridgeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.detail = detail;
  }
}

let counter = 0;
export function nextId(prefix = "req") {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
