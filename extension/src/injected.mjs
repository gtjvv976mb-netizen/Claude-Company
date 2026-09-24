/**
 * THE INJECTED SCRIPT: THE ONLY CODE THAT TOUCHES PHANTOM.
 *
 * Runs in the page's own world on the console page, where `window.phantom.solana` is.
 * It answers three requests from the content script (connect, disconnect, sign), each
 * stamped with the nonce the content script minted, and reports the account Phantom
 * gives it. That is the whole surface: it holds no key, builds no transaction, and it
 * will not sign for a wallet other than the one the request names.
 *
 * Signing is `provider.signTransaction(tx)` — Phantom's own approval window, every time.
 * The bytes go back to the worker, which checks the message is the one it built before
 * it sends anything. Phantom's sign-and-send method is deliberately not used: the lane
 * sends through the RPC the operator chose, with preflight skipped, as the executor does.
 */
import { VersionedTransaction } from "@solana/web3.js";

/* A module script never sets document.currentScript, so the tag is found by the
   attribute the content script put on it. It is still in the DOM here: the content
   script removes it on `load`, which fires after this module has run. */
const script = document.currentScript ?? document.querySelector("script[data-hawk-nonce]");
const NONCE = script?.dataset?.hawkNonce ?? null;
const CHANNEL = script?.dataset?.hawkChannel ?? "claudeco-hawk";
const TYPES = {
  CONNECT: "hawk:bridge:connect", DISCONNECT: "hawk:bridge:disconnect", SIGN: "hawk:bridge:sign",
  ACCOUNT: "hawk:bridge:account", REPLY: "hawk:bridge:reply",
};

const post = (message) => window.postMessage({ channel: CHANNEL, nonce: NONCE, from: "hawk-injected", ...message }, location.origin);
const reply = (id, ok, payload) => post({ type: TYPES.REPLY, id, ok, ...(ok ? { result: payload } : { error: payload }) });
const b64ToBytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));

function provider() {
  const p = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
  return p && p.isPhantom ? p : null;
}
async function waitForProvider(ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const p = provider();
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
const errorOf = (error) => {
  const code = Number(error?.code);
  if (code === 4001 || /reject|declin|cancel/i.test(String(error?.message ?? ""))) return { code: "rejected", message: "you declined in Phantom" };
  return { code: "provider", message: String(error?.message ?? error ?? "Phantom refused") };
};
const announce = (p) => post({ type: TYPES.ACCOUNT, publicKey: p?.publicKey ? p.publicKey.toBase58() : null });

let wired = null;
function wire(p) {
  if (wired === p) return;
  wired = p;
  try {
    p.on("connect", () => announce(p));
    p.on("disconnect", () => post({ type: TYPES.ACCOUNT, publicKey: null }));
    p.on("accountChanged", (pk) => post({ type: TYPES.ACCOUNT, publicKey: pk ? pk.toBase58() : null }));
  } catch { /* an older provider without events; the replies still carry the account */ }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.from !== "hawk-extension" || data.nonce !== NONCE) return;
  const { type, id } = data;
  if (type === TYPES.CONNECT) {
    const p = await waitForProvider();
    if (!p) return reply(id, false, { code: "no_wallet", message: "Phantom is not installed in this browser" });
    wire(p);
    try {
      const res = await p.connect(data.onlyIfTrusted ? { onlyIfTrusted: true } : undefined);
      const pk = (res?.publicKey ?? p.publicKey)?.toBase58?.() ?? null;
      announce(p);
      return reply(id, true, { publicKey: pk });
    } catch (error) { return reply(id, false, errorOf(error)); }
  }
  if (type === TYPES.DISCONNECT) {
    const p = provider();
    try { await p?.disconnect?.(); } catch { /* fine */ }
    post({ type: TYPES.ACCOUNT, publicKey: null });
    return reply(id, true, {});
  }
  if (type === TYPES.SIGN) {
    const p = provider();
    if (!p) return reply(id, false, { code: "no_wallet", message: "Phantom is not installed in this browser" });
    if (!p.publicKey) return reply(id, false, { code: "no_wallet", message: "Phantom is not connected" });
    const connected = p.publicKey.toBase58();
    if (data.wallet && data.wallet !== connected) return reply(id, false, { code: "wallet_mismatch", message: `Phantom is connected as ${connected}, not ${data.wallet}` });
    try {
      const tx = VersionedTransaction.deserialize(b64ToBytes(data.txBase64));
      const signed = await p.signTransaction(tx);
      return reply(id, true, { signedBase64: bytesToB64(signed.serialize()) });
    } catch (error) { return reply(id, false, errorOf(error)); }
  }
});

/* On load: say whether Phantom is here, and restore a session it already trusts. */
waitForProvider().then(async (p) => {
  if (!p) return post({ type: TYPES.ACCOUNT, publicKey: null, absent: true });
  wire(p);
  try { await p.connect({ onlyIfTrusted: true }); } catch { /* not trusted yet; the Connect button does it */ }
  announce(p);
});
