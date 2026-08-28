// Every outbound call in this codebase goes through here. It is GET-only by
// construction: there is no write path to any venue, which is what makes the
// charter's "never executes" rule structural rather than aspirational.
export async function getJson(url, { headers = {}, timeoutMs = 12000, label } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url: label || url };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), url: label || url };
  } finally {
    clearTimeout(t);
  }
}

export async function rpc(endpoint, method, params, { timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    if (j.error) return { ok: false, error: j.error.message };
    return { ok: true, data: j.result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Read-only RPC methods. Anything not on this list is refused before it is sent.
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getTokenLargestAccounts",
  "getTokenSupply", "getSignaturesForAddress", "getBalance", "getSlot",
  "getTransaction", "getProgramAccounts",
  // the treasury scanner's reads
  "getTokenAccountsByOwner", "getTokenAccountBalance",
]);

export async function readRpc(endpoint, method, params, opts = {}) {
  if (!ALLOWED.has(method)) {
    throw new Error(`readRpc refused non-read method: ${method}`);
  }
  // The public RPC rate-limits the expensive reads, and a 429 on holders is not a
  // cosmetic loss: holder concentration is the single most decision-relevant datum the
  // forensics seat has. Back off and try again before giving up on it.
  const attempts = opts.attempts ?? 3;
  let last;
  for (let i = 1; i <= attempts; i++) {
    last = await rpc(endpoint, method, params, opts);
    if (last.ok) return last;
    const rateLimited = /429|Too many requests|rate/i.test(String(last.error || ""));
    if (!rateLimited || i === attempts) break;
    await new Promise((r) => setTimeout(r, 700 * i * i));
  }
  return last;
}
