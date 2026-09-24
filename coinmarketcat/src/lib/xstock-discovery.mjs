/**
 * NEW POOLS THAT PAIR A TOKEN WITH AN xSTOCK, FROM PUBLIC FEEDS.
 *
 * The pump.fun lane hears launches from the program's own logs, in the slot they happen.
 * A pool on Raydium, Meteora, Orca or a launchpad that pairs a new token with a tokenised
 * stock has no such single program to listen to, so this venue reads what the public
 * indexers publish about new pools and keeps the ones where one side is an xStock the user
 * cares about. Everything below was read off the live APIs on 2026-09-24 (the captured
 * responses are in fixtures/xstock-pools/):
 *
 *   · GeckoTerminal  GET https://api.geckoterminal.com/api/v2/networks/solana/new_pools
 *                    ?include=base_token,quote_token,dex&page=1
 *     The 20 newest Solana pools of ANY pair (one page covered about 48 s of creations),
 *     no filter by token, so the stock match happens here. CDN-cached for 30–60 s. The
 *     free tier answered 429 with `retry-after: 0` on the very first call of the session:
 *     a zero retry-after is not a promise, so it is treated as absent.
 *   · DexScreener    GET https://api.dexscreener.com/token-pairs/v1/solana/{stock}
 *     Up to 30 pools where the stock is base OR quote, ordered roughly by liquidity, so a
 *     brand-new pool with no liquidity can fall outside the 30. 300 requests a minute per
 *     its API reference. `pairCreatedAt` is epoch ms and may be null.
 *   · Jupiter gems   POST https://datapi.jup.ag/v1/pools/gems  {"recent":{"timeframe":"24h"}}
 *     The 30 newest LAUNCHPAD pools with their quote mint — the one feed that showed an
 *     xStock-quoted launchpad pool the moment it existed. UNDOCUMENTED: it may change or
 *     stop without notice. Off unless the user chooses it.
 *
 * What this file does: fetch (with a timeout), parse each feed into one pool shape, match
 * either side against the focus list, classify the pair (which side is the stock, which is
 * the token), dedupe by pool address, and back a feed off when it answers 429, 5xx or not
 * at all. What it does not do: decide anything. Every pool it hands over is a CANDIDATE,
 * and the lane's gates (src/lib/xstock-lane.mjs) say whether it is one it may touch.
 *
 * Pure parsers are exported so the tests can feed them the captured responses; no network
 * is touched in any test.
 */
import { WSOL } from "./tx.mjs";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** A counter-side that is money, not a launch: a pool of an xStock against SOL or a dollar
 *  stablecoin is a market in the stock, and there is no new token in it to buy. */
export const MONEY_MINTS = Object.freeze(new Set([WSOL, USDC_MINT, USDT_MINT]));

export const GECKO_NEW_POOLS_URL = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token,dex&page=1";
export const DEXSCREENER_PAIRS_URL = (mint) => `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
export const JUPITER_GEMS_URL = "https://datapi.jup.ag/v1/pools/gems";

/** Backoff bounds. The feeds are caches refreshed every 30–60 s: nothing is lost by
 *  waiting a minute after a refusal, and a feed that keeps refusing is left alone for ten. */
export const DISCOVERY_BACKOFF = Object.freeze({ rateLimitedMs: 60_000, errorMs: 30_000, maxMs: 10 * 60_000 });
/** How many pools the dedupe remembers. A pool seen once is never handed over twice. */
export const DISCOVERY_SEEN_CAP = 4_000;

const isStr = (v) => typeof v === "string" && v.length > 0;
const stripNetwork = (id) => (isStr(id) && id.startsWith("solana_") ? id.slice("solana_".length) : null);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const timeOf = (v) => { if (v === null || v === undefined || v === "") return null; const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; };

/* ── the three parsers, one pool shape ─────────────────────────────────────────────── */

/** GeckoTerminal new_pools → [{ pool, dex, baseMint, quoteMint, baseSymbol, quoteSymbol, createdAtMs, liquidityUsd, name }]. */
export function parseGeckoTerminalPools(body) {
  if (!body || !Array.isArray(body.data)) throw new Error("GeckoTerminal answered without a data list");
  const tokens = new Map();
  for (const inc of Array.isArray(body.included) ? body.included : []) {
    if (inc?.type === "token" && isStr(inc?.attributes?.address)) tokens.set(inc.attributes.address, inc.attributes);
  }
  const out = [];
  for (const row of body.data) {
    const a = row?.attributes ?? {}, r = row?.relationships ?? {};
    const pool = isStr(a.address) ? a.address : stripNetwork(row?.id);
    const baseMint = stripNetwork(r.base_token?.data?.id), quoteMint = stripNetwork(r.quote_token?.data?.id);
    if (!pool || !baseMint || !quoteMint) continue;
    out.push(Object.freeze({
      pool, dex: isStr(r.dex?.data?.id) ? r.dex.data.id : null, baseMint, quoteMint,
      baseSymbol: tokens.get(baseMint)?.symbol ?? null, quoteSymbol: tokens.get(quoteMint)?.symbol ?? null,
      createdAtMs: timeOf(a.pool_created_at), liquidityUsd: num(a.reserve_in_usd), name: isStr(a.name) ? a.name : null,
    }));
  }
  return out;
}

/** DexScreener token-pairs (an array of pair objects) → the same shape. Solana pairs only. */
export function parseDexScreenerPairs(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.pairs) ? body.pairs : null;
  if (!list) throw new Error("DexScreener answered without a pair list");
  const out = [];
  for (const p of list) {
    if (p?.chainId !== "solana") continue;
    const pool = p?.pairAddress, baseMint = p?.baseToken?.address, quoteMint = p?.quoteToken?.address;
    if (!isStr(pool) || !isStr(baseMint) || !isStr(quoteMint)) continue;
    const labels = Array.isArray(p.labels) && p.labels.length ? ` ${p.labels.join("/")}` : "";
    out.push(Object.freeze({
      pool, dex: isStr(p.dexId) ? `${p.dexId}${labels}` : null, baseMint, quoteMint,
      baseSymbol: p.baseToken?.symbol ?? null, quoteSymbol: p.quoteToken?.symbol ?? null,
      createdAtMs: timeOf(p.pairCreatedAt), liquidityUsd: num(p?.liquidity?.usd),
      name: isStr(p.baseToken?.symbol) && isStr(p.quoteToken?.symbol) ? `${p.baseToken.symbol} / ${p.quoteToken.symbol}` : null,
    }));
  }
  return out;
}

/** Jupiter's undocumented gems feed → the same shape, from its `recent` bucket. */
export function parseJupiterGems(body) {
  const list = body?.recent?.pools;
  if (!Array.isArray(list)) throw new Error("the Jupiter gems feed answered without recent.pools");
  const out = [];
  for (const p of list) {
    const pool = p?.id, baseMint = p?.baseAsset?.id, quoteMint = p?.quoteAsset;
    if (!isStr(pool) || !isStr(baseMint) || !isStr(quoteMint)) continue;
    out.push(Object.freeze({
      pool, dex: isStr(p.type) ? p.type : isStr(p.dex) ? p.dex : null, baseMint, quoteMint,
      baseSymbol: p.baseAsset?.symbol ?? null, quoteSymbol: null,
      createdAtMs: timeOf(p.createdAt), liquidityUsd: num(p.liquidity), name: null,
    }));
  }
  return out;
}

/**
 * WHICH SIDE IS THE STOCK, WHICH IS THE TOKEN. `focus` is [{ mint, symbol, listed }].
 * Returns null when neither side is in focus (not this venue's business). Otherwise a
 * classification with `kind`:
 *   "launch"         one side is a focus stock and the other is neither money nor a stock
 *   "money_pair"     the other side is SOL, USDC or USDT — a market in the stock, no token to buy
 *   "stock_pair"     the other side is also a stock (in focus, or an Xs… address: every
 *                    one of the 1,008 official xStock mints read on 2026-09-24 starts "Xs")
 */
export function classifyPool(pool, focus) {
  const byMint = new Map((focus ?? []).map((f) => [f.mint, f]));
  const base = byMint.get(pool.baseMint) ?? null, quote = byMint.get(pool.quoteMint) ?? null;
  if (!base && !quote) return null;
  const stock = quote ?? base;
  const stockSide = quote ? "quote" : "base";
  const tokenMint = stockSide === "quote" ? pool.baseMint : pool.quoteMint;
  const tokenSymbol = stockSide === "quote" ? pool.baseSymbol : pool.quoteSymbol;
  let kind = "launch";
  if (base && quote) kind = "stock_pair";
  else if (MONEY_MINTS.has(tokenMint)) kind = "money_pair";
  else if (tokenMint.startsWith("Xs")) kind = "stock_pair";
  return Object.freeze({ kind, stockMint: stock.mint, stockSymbol: stock.symbol, stockListed: stock.listed === true, stockSide, tokenMint, tokenSymbol: tokenSymbol ?? null });
}

/* ── the poller ───────────────────────────────────────────────────────────────────── */

export class DiscoveryError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = "DiscoveryError"; this.code = code; this.detail = detail; }
}

/**
 * The poller. `sources()` and `focus()` are read on every poll, so a change in Options
 * takes effect on the next one. `poll()` returns the NEW candidates (pools this instance
 * has not handed over before), each { pool, dex, baseMint, quoteMint, …, sources, firstSeenAt,
 * ageAtFirstSightMs, classification }. Pools older than `horizonMs()` at first sight are
 * remembered as seen and counted, never handed over: a feed that lists 30 pools of a stock,
 * most of them weeks old, is not 30 launches.
 */
export function createPoolDiscovery({
  fetchImpl = globalThis.fetch, clock = () => Date.now(), timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  sources = () => [], focus = () => [], horizonMs = () => 600_000, timeoutMs = 10_000,
} = {}) {
  const seen = new Map();       // pool → the candidate as first handed over (plus the sources that saw it since)
  const feeds = new Map();      // source id → counters and backoff
  let olderThanHorizon = 0, notInFocus = 0, polls = 0;

  const feed = (id) => {
    if (!feeds.has(id)) feeds.set(id, { id, requests: 0, ok: 0, errors: 0, rateLimited: 0, lastOkAt: null, lastError: null, lastErrorAt: null, backoffUntil: 0, backoffMs: 0, pools: 0 });
    return feeds.get(id);
  };

  async function fetchJson(url, { method = "GET", body = null } = {}) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? timers.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        method, signal: controller?.signal,
        headers: body === null ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (res.status === 429) {
        const header = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
        const seconds = Number(header);
        throw new DiscoveryError("rate_limited", `HTTP 429${header !== null ? ` (retry-after: ${header})` : ""}`, { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null });
      }
      if (!res.ok) throw new DiscoveryError("http", `HTTP ${res.status}`, { status: res.status });
      if (parsed === null) throw new DiscoveryError("malformed", "the answer was not JSON");
      return parsed;
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError("network", error?.name === "AbortError" ? `no answer inside ${timeoutMs}ms` : String(error?.message ?? error));
    } finally { if (timer !== null) timers.clearTimeout(timer); }
  }

  /** One request for one feed, with its backoff honoured and updated. Returns the parsed
   *  pools, or null when the feed is resting or failed (the failure is on its counters). */
  async function ask(id, url, parse, opts) {
    const f = feed(id);
    const now = clock();
    if (now < f.backoffUntil) return null;
    f.requests++;
    try {
      const pools = parse(await fetchJson(url, opts));
      f.ok++; f.lastOkAt = clock(); f.backoffMs = 0; f.backoffUntil = 0; f.pools += pools.length;
      return pools;
    } catch (error) {
      const code = error?.code ?? "malformed";
      if (code === "rate_limited") f.rateLimited++; else f.errors++;
      f.lastError = `${code}: ${error?.message ?? error}`; f.lastErrorAt = clock();
      /* A retry-after the server gave (and that is not zero) is honoured up to the cap; else
         the wait doubles from the floor for this kind of failure. */
      const floor = code === "rate_limited" ? DISCOVERY_BACKOFF.rateLimitedMs : DISCOVERY_BACKOFF.errorMs;
      const doubled = f.backoffMs > 0 ? f.backoffMs * 2 : floor;
      const wait = Math.min(DISCOVERY_BACKOFF.maxMs, Math.max(floor, error?.detail?.retryAfterMs ?? 0, doubled));
      f.backoffMs = wait; f.backoffUntil = clock() + wait;
      return null;
    }
  }

  async function poll() {
    polls++;
    const ids = sources();
    const list = focus();
    if (!list.length || !ids.length) return [];
    const found = [];           // [{ pool, source }]
    if (ids.includes("geckoterminal")) {
      const pools = await ask("geckoterminal", GECKO_NEW_POOLS_URL, parseGeckoTerminalPools);
      for (const p of pools ?? []) found.push({ p, source: "geckoterminal" });
    }
    if (ids.includes("dexscreener")) {
      for (const stock of list) {
        const pools = await ask("dexscreener", DEXSCREENER_PAIRS_URL(stock.mint), parseDexScreenerPairs);
        if (pools === null && clock() < feed("dexscreener").backoffUntil) break;   // the feed is resting: stop asking it this round
        for (const p of pools ?? []) found.push({ p, source: "dexscreener" });
      }
    }
    if (ids.includes("jupiter-gems")) {
      const pools = await ask("jupiter-gems", JUPITER_GEMS_URL, parseJupiterGems, { method: "POST", body: { recent: { timeframe: "24h" } } });
      for (const p of pools ?? []) found.push({ p, source: "jupiter-gems" });
    }
    const now = clock();
    const fresh = [];
    for (const { p, source } of found) {
      const known = seen.get(p.pool);
      if (known) { if (!known.sources.includes(source)) known.sources.push(source); continue; }
      const classification = classifyPool(p, list);
      if (!classification) { notInFocus++; continue; }
      const ageAtFirstSightMs = p.createdAtMs === null ? null : now - p.createdAtMs;
      const candidate = { ...p, sources: [source], firstSeenAt: now, ageAtFirstSightMs, classification };
      seen.set(p.pool, candidate);
      if (ageAtFirstSightMs !== null && ageAtFirstSightMs > horizonMs()) { olderThanHorizon++; continue; }
      fresh.push(candidate);
    }
    if (seen.size > DISCOVERY_SEEN_CAP) for (const k of [...seen.keys()].slice(0, seen.size - DISCOVERY_SEEN_CAP)) seen.delete(k);
    return fresh;
  }

  return Object.freeze({
    poll,
    status() {
      return {
        polls, seen: seen.size, olderThanHorizon, notInFocus,
        feeds: [...feeds.values()].map((f) => ({ ...f, resting: clock() < f.backoffUntil })),
      };
    },
  });
}
