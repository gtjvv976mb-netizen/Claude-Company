/**
 * A SMALL JSON-RPC CLIENT, AND THE ONE SUBSCRIPTION THE LANE NEEDS.
 *
 * @solana/web3.js's Connection would do all of this, but its websocket layer owns its
 * own reconnect policy and its own idea of when a subscription is dead. A launch sniper's
 * feed is the thing most worth understanding exactly, so this is written out: one
 * `logsSubscribe` on the pump.fun program, a heartbeat that notices silence, and a
 * reconnect with backoff that resubscribes and says so.
 *
 * Every method returns plain JSON as the node answered it, with `data` as
 * `[base64, "base64"]` — the shape executor/snipe-venue-pumpfun.mjs's decoders and
 * executor/token2022.mjs's audit already accept, so nothing is re-encoded on the way.
 */

export class RpcError extends Error {
  constructor(method, message, detail = {}) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
    this.method = method;
    this.detail = detail;
  }
}

export function createRpc({ url, fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
  if (!url) throw new Error("createRpc needs an https URL");
  let seq = 0;
  async function call(method, params = []) {
    const id = ++seq;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new RpcError(method, `HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new RpcError(method, body.error.message ?? "rpc error", body.error);
      return body.result;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(method, error?.name === "AbortError" ? `no answer inside ${timeoutMs}ms` : String(error?.message ?? error));
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    url,
    call,
    /** { slot, accounts: [ {data:[b64,"base64"], owner, lamports} | null ] } */
    async getMultipleAccounts(addresses, { commitment = "processed" } = {}) {
      const r = await call("getMultipleAccounts", [addresses.map(String), { encoding: "base64", commitment }]);
      return { slot: Number(r?.context?.slot) || null, accounts: Array.isArray(r?.value) ? r.value : [] };
    },
    async getBalance(address, { commitment = "processed" } = {}) {
      const r = await call("getBalance", [String(address), { commitment }]);
      return BigInt(r?.value ?? 0);
    },
    async getTokenAccountBalance(ata, { commitment = "processed" } = {}) {
      try {
        const r = await call("getTokenAccountBalance", [String(ata), { commitment }]);
        return r?.value?.amount != null ? BigInt(r.value.amount) : 0n;
      } catch (error) {
        /* An account that does not exist yet is a balance of zero, not an outage. */
        if (/could not find account|Invalid param/i.test(String(error.message))) return 0n;
        throw error;
      }
    },
    async getLatestBlockhash({ commitment = "confirmed" } = {}) {
      const r = await call("getLatestBlockhash", [{ commitment }]);
      return { blockhash: r?.value?.blockhash, lastValidBlockHeight: Number(r?.value?.lastValidBlockHeight) };
    },
    async getBlockHeight({ commitment = "confirmed" } = {}) {
      return Number(await call("getBlockHeight", [{ commitment }]));
    },
    /** The node's own simulation of the unsigned bytes, with post-state for `addresses`. */
    async simulateTransaction(txBase64, { addresses = [], commitment = "processed" } = {}) {
      const r = await call("simulateTransaction", [txBase64, {
        encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment,
        accounts: { encoding: "base64", addresses: addresses.map(String) },
      }]);
      return r?.value ?? r;
    },
    async sendTransaction(txBase64, { skipPreflight = true, maxRetries = 2 } = {}) {
      return call("sendTransaction", [txBase64, { encoding: "base64", skipPreflight, preflightCommitment: "processed", maxRetries }]);
    },
    async getSignatureStatus(signature) {
      const r = await call("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      return r?.value?.[0] ?? null;
    },
    async getTransaction(signature, { commitment = "confirmed" } = {}) {
      return call("getTransaction", [signature, { encoding: "json", commitment, maxSupportedTransactionVersion: 0 }]);
    },
    async getHealth() {
      try { return await call("getHealth", []); } catch (error) { return `unhealthy: ${error.message}`; }
    },
  });
}

/**
 * THE FEED. One websocket, one `logsSubscribe` on `programId`, every notification handed
 * to `onLogs({ signature, err, logs, slot, receivedAt })`. Silence longer than
 * `silenceMs` — pump.fun logs several times a second in any market — is treated as a
 * dead socket and redialled; every state change goes to `onState(state, detail)` with
 * one of "starting" | "live" | "degraded" | "dead" | "stopped", the executor feed's
 * own vocabulary.
 */
export function createLogsFeed({
  wsUrl, programId, onLogs, onState = () => {},
  WebSocketImpl = globalThis.WebSocket, clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  silenceMs = 45_000, pingMs = 15_000, commitment = "processed",
} = {}) {
  if (!wsUrl) throw new Error("createLogsFeed needs a wss URL");
  if (typeof WebSocketImpl !== "function") throw new Error("no WebSocket implementation is available here");
  let socket = null;
  let state = "stopped";
  let stopped = true;
  let attempt = 0;
  let subscriptionId = null;
  let lastMessageAt = 0;
  let watchdog = null;
  let pinger = null;
  let reconnectTimer = null;
  let seq = 0;
  const counters = { notifications: 0, reconnects: 0, errors: 0 };

  const setState = (next, detail = null) => {
    if (state === next) return;
    state = next;
    try { onState(next, detail); } catch { /* the listener's problem */ }
  };
  const send = (obj) => { try { socket?.send(JSON.stringify(obj)); } catch { /* the watchdog will notice */ } };
  const clearTimers = () => {
    if (watchdog) { clearTimer(watchdog); watchdog = null; }
    if (pinger) { clearTimer(pinger); pinger = null; }
  };
  const armWatchdog = () => {
    if (watchdog) clearTimer(watchdog);
    watchdog = setTimer(() => {
      if (stopped) return;
      if (clock() - lastMessageAt >= silenceMs) {
        counters.errors++;
        setState("degraded", `no message for ${silenceMs}ms — redialling`);
        redial("silence");
      } else armWatchdog();
    }, silenceMs);
  };
  const armPinger = () => {
    if (pinger) clearTimer(pinger);
    pinger = setTimer(() => {
      if (stopped) return;
      send({ jsonrpc: "2.0", id: ++seq, method: "getHealth" });   // a cheap round trip; the answer resets the clock
      armPinger();
    }, pingMs);
  };
  function redial(reason) {
    clearTimers();
    if (socket) { try { socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); } catch { /* gone */ } }
    socket = null;
    subscriptionId = null;
    if (stopped) return;
    counters.reconnects++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    attempt++;
    if (attempt > 20) setState("dead", `gave up after ${attempt - 1} redials (${reason})`);
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = setTimer(() => { reconnectTimer = null; dial(); }, delay);
  }
  function dial() {
    if (stopped) return;
    setState("starting", `dialling ${wsUrl} (attempt ${attempt + 1})`);
    let ws;
    try { ws = new WebSocketImpl(wsUrl); }
    catch (error) { counters.errors++; setState("degraded", `dial failed: ${error?.message ?? error}`); redial("dial"); return; }
    socket = ws;
    ws.onopen = () => {
      lastMessageAt = clock();
      send({ jsonrpc: "2.0", id: ++seq, method: "logsSubscribe", params: [{ mentions: [programId] }, { commitment }] });
      armWatchdog();
      armPinger();
    };
    ws.onmessage = (event) => {
      lastMessageAt = clock();
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
      if (msg.method === "logsNotification") {
        const value = msg.params?.result?.value ?? {};
        const slot = Number(msg.params?.result?.context?.slot) || null;
        counters.notifications++;
        try { onLogs({ signature: value.signature ?? null, err: value.err ?? null, logs: Array.isArray(value.logs) ? value.logs : [], slot, receivedAt: clock() }); }
        catch { /* the engine reports its own errors */ }
        return;
      }
      if (msg.id !== undefined && typeof msg.result === "number" && subscriptionId === null) {
        subscriptionId = msg.result;
        attempt = 0;
        setState("live", `subscribed (${subscriptionId})`);
        return;
      }
      if (msg.error && subscriptionId === null) {
        counters.errors++;
        setState("degraded", `subscribe refused: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        redial("refused");
      }
    };
    ws.onerror = () => { counters.errors++; };
    ws.onclose = () => { if (!stopped) { setState("degraded", "socket closed"); redial("close"); } };
  }
  return Object.freeze({
    start() { if (!stopped) return; stopped = false; attempt = 0; dial(); },
    stop() {
      stopped = true;
      clearTimers();
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
      if (socket) { try { socket.close(); } catch { /* gone */ } socket = null; }
      subscriptionId = null;
      setState("stopped");
    },
    get state() { return state; },
    get counters() { return { ...counters, lastMessageAt }; },
  });
}
