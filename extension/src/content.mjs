/**
 * THE CONTENT SCRIPT: A RELAY WITH A NONCE, ON THE CONSOLE PAGE ONLY.
 *
 * It runs on the pages the manifest names (/hawk on the site, or the local office), and
 * does three things: injects injected.js into the page's own world, where Phantom's
 * provider lives; opens a port to the service worker and keeps it warm; and passes
 * messages between the two. It reads nothing from the page, signs nothing, and decides
 * nothing.
 *
 * The nonce is minted here and handed to injected.js through its script tag. Only a
 * window message carrying it is relayed to the worker as the wallet's word (an account,
 * a signature reply). Page-originated requests (the Connect button, "are you there?")
 * carry no nonce and are relayed as exactly that: a request the worker may ignore.
 */
import { CHANNEL, BRIDGE, HAWK_TO_PAGE, HAWK_FROM_PAGE } from "./lib/protocol.mjs";

const PORT_NAME = "hawk-console";
const nonce = crypto.randomUUID();
let port = null;
let pingTimer = null;

function inject() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.type = "module";
  script.dataset.hawkNonce = nonce;
  script.dataset.hawkChannel = CHANNEL;
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener("load", () => script.remove());
}

function toPage(message) {
  window.postMessage({ channel: CHANNEL, nonce, from: "hawk-extension", ...message }, location.origin);
}

function connect() {
  if (port) return;
  try { port = chrome.runtime.connect({ name: PORT_NAME }); }
  catch { port = null; return; }
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (HAWK_TO_PAGE.has(msg.type)) toPage(msg);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    /* The worker was recycled; dial again shortly so the lane sees the console. */
    setTimeout(connect, 1_500);
  });
  port.postMessage({ type: BRIDGE.HELLO, origin: location.origin, href: location.href });
  pingTimer = setInterval(() => { try { port?.postMessage({ type: BRIDGE.PING }); } catch { /* reconnect handles it */ } }, 20_000);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || typeof data.type !== "string") return;
  if (data.from === "hawk-extension") return;                 // our own relay, echoed back by the window
  if (!HAWK_FROM_PAGE.has(data.type)) return;
  const fromWallet = data.type === BRIDGE.ACCOUNT || data.type === BRIDGE.REPLY;
  if (fromWallet && data.nonce !== nonce) return;             // not the injected script's word
  if (!port) connect();
  const { channel: _c, nonce: _n, from: _f, ...message } = data;
  try { port?.postMessage(message); } catch { /* the worker will be back */ }
});

inject();
connect();
