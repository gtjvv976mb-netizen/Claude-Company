/**
 * PUMP.FUN, LIVE — the launch feed and the minute tape.
 *
 * The desk's universe was 25 keyword searches against DexScreener. Measured on
 * 2026-09-02 that returned 313 mints whose MEDIAN age was 606 hours — twenty-five days
 * — and not one coin under an hour old survived the screen. Meanwhile pump.fun was
 * creating 29 coins a minute. A desk asked to trade a $5k-$20k coin inside thirty
 * minutes cannot see one, because the only lens it owns is a search engine's idea of
 * relevance for the English word "cat".
 *
 * This module is the other lens: pump.fun's own listing, and its own minute candles.
 * Both are free, keyless, and were probed live before a line of this was written.
 *
 * WHAT IS ACTUALLY TRUE OF THESE ENDPOINTS (probed 2026-09-03, not assumed):
 *   - /coins?sort=created_timestamp&order=DESC   the launch feed. 28.8 coins/min.
 *   - /coins?sort=last_trade_timestamp&order=DESC the coins being traded RIGHT NOW.
 *   - limit is capped server-side at 70 whatever you ask for; paginate with `offset`.
 *   - marketCapFrom / marketCapTo DO NOT FILTER. A "nano" query came back holding a
 *     $45m coin. Bands are decided here, in code, from usd_market_cap.
 *   - swap-api.pump.fun/v1/coins/{mint}/candles?interval=1m works for coins still on
 *     the bonding curve, which DexScreener does not index at all.
 *
 * Everything degrades to empty. A desk that cannot reach pump.fun keeps running on the
 * DexScreener sweep exactly as before; nothing here is on a critical path.
 */
import { getJson } from "../lib/http.js";
import { CAP_BANDS } from "../categories.js";

const LIST = "https://frontend-api-v3.pump.fun";
const SWAP = "https://swap-api.pump.fun";
/** The server ignores anything larger, so asking for more only looks bigger in a log. */
export const PAGE_ROWS = 70;
const HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; claude-co-desk)" };
const LAMPORTS = 1e9;
/** pump.fun mints are six-decimal; total_supply arrives in base units. */
const MINT_DECIMALS = 6;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* Some rows carry a seconds epoch and some carry milliseconds. Read as-is, a seconds
   timestamp makes a coin minted this morning look 1.6 years old, which is exactly the
   kind of number that quietly disqualifies a candidate for a reason nobody checks. */
const epochMs = (v) => {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

async function page(sort, offset, { timeoutMs = 9000 } = {}) {
  const url = `${LIST}/coins?offset=${offset}&limit=${PAGE_ROWS}&sort=${sort}&order=DESC&includeNsfw=true`;
  const r = await getJson(url, { headers: HEADERS, timeoutMs, label: `pumpfun/${sort}` });
  return Array.isArray(r.data) ? r.data : [];
}

/**
 * Pages of one listing, fetched together and deduped by mint. Pages are requested in
 * parallel because they are independent; a page that fails is simply absent.
 */
async function listing(sort, pages) {
  const wanted = Math.max(1, Math.min(12, Math.floor(pages) || 1));
  const results = await Promise.allSettled(
    Array.from({ length: wanted }, (_, i) => page(sort, i * PAGE_ROWS)));
  const seen = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const c of r.value) if (c?.mint && !seen.has(c.mint)) seen.set(c.mint, c);
  }
  return [...seen.values()];
}

/** Every coin pump.fun has just created — the top of the funnel the mandate asks for. */
export const newLaunches = ({ pages = 2 } = {}) => listing("created_timestamp", pages);

/** Every coin pump.fun has just traded — where a move in progress is visible. */
export const recentlyTraded = ({ pages = 4 } = {}) => listing("last_trade_timestamp", pages);

/** The band a market cap sits in, or null when it is off the desk's board entirely. */
export function bandOf(usdMarketCap) {
  const mc = num(usdMarketCap);
  if (mc == null || !(mc > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS)) if (mc >= b.lo && mc < b.hi) return band;
  return null;
}

/**
 * One coin as the rest of the desk expects to see it.
 *
 * The shape mirrors dexscreener.shapePair so a pump.fun-sourced coin can flow into the
 * funnel, the board and the screen without any of them learning a second dialect.
 *
 * `liquidityUsd` is the bonding curve's REAL SOL reserve priced in dollars, doubled to
 * describe both sides of the book — that reserve is literally the money available to
 * sell into before graduation, which is the number a stop depends on. A graduated coin
 * (`complete`) has a real AMM pool and DexScreener knows it better than this does, so
 * its reserve is reported but flagged.
 */
export function asCandidate(coin, { solUsd = null, now = Date.now() } = {}) {
  if (!coin?.mint) return null;
  const mcap = num(coin.usd_market_cap);
  const supply = num(coin.total_supply);
  const priceUsd = mcap != null && supply > 0 ? mcap / (supply / 10 ** MINT_DECIMALS) : null;
  /* A GRADUATED COIN HAS AN EMPTY CURVE, NOT AN EMPTY BOOK. real_sol_reserves goes to
     zero the moment the curve tips into a real AMM pool, and reporting that as $0 of
     liquidity would describe every graduated coin as unsellable — the one condition the
     screen treats as fatal. Unknown is the honest answer; DexScreener knows the pool. */
  const solReserve = num(coin.real_sol_reserves);
  const curveUsd = coin.complete || solReserve == null || !(solUsd > 0)
    ? null : (solReserve / LAMPORTS) * solUsd;
  const createdAt = epochMs(coin.created_timestamp);
  const ageHours = createdAt ? (now - createdAt) / 3.6e6 : null;
  return {
    mint: coin.mint,
    launchpad: "pump.fun",
    onCurve: !coin.complete,
    source: "pumpfun-live",
    pair: {
      dex: coin.complete ? "pumpswap" : "pumpfun",
      pairAddress: coin.pool_address ?? coin.bonding_curve ?? null,
      url: `https://pump.fun/coin/${coin.mint}`,
      baseSymbol: coin.symbol ?? null,
      baseName: coin.name ?? null,
      quoteSymbol: "SOL",
      priceUsd,
      // Both sides of the curve: the SOL that can be sold into, and the coin against it.
      liquidityUsd: curveUsd == null ? null : curveUsd * 2,
      fdv: mcap,
      marketCap: mcap,
      pairCreatedAt: createdAt,
      ageHours: ageHours == null ? null : Number(ageHours.toFixed(2)),
      // 24-hour aggregates do not exist on this feed and must not be invented: a move
      // that starts and ends inside thirty minutes is invisible to a daily number
      // anyway. The minute tape below is where this desk reads volume.
      volume: {},
      txns: {},
      priceChange: {},
      imageUrl: coin.image_uri ?? null,
      socials: [],
      websites: coin.website ? [{ url: coin.website }] : [],
    },
    live: {
      band: bandOf(mcap),
      graduated: !!coin.complete,
      creator: coin.creator ?? null,
      replyCount: num(coin.reply_count),
      athMarketCap: num(coin.ath_market_cap),
      lastTradeAt: epochMs(coin.last_trade_timestamp),
      curveSolReserve: solReserve == null ? null : solReserve / LAMPORTS,
      curveLiquidityUsd: curveUsd,
      verified: !!coin.verified,
      banned: !!coin.is_banned,
    },
    raw: coin,
  };
}

/** The minute tape. Oldest first, as the API returns it. */
export async function candles(mint, { limit = 40, interval = "1m" } = {}) {
  const r = await getJson(
    `${SWAP}/v1/coins/${mint}/candles?interval=${interval}&limit=${Math.max(2, Math.min(200, limit))}&currency=USD`,
    { headers: HEADERS, timeoutMs: 8000, label: "pumpfun/candles" });
  if (!Array.isArray(r.data)) return [];
  return r.data
    .map((k) => ({ ts: num(k.timestamp), open: num(k.open), high: num(k.high),
      low: num(k.low), close: num(k.close), volume: num(k.volume) }))
    .filter((k) => k.ts != null && k.close > 0);
}

/**
 * What the last half hour actually did.
 *
 * Pure, so it can be tested against a tape whose answer is already known — the ruler
 * gets checked before anything is measured with it. Returns null rather than a
 * confident zero when the tape is too short to say anything.
 */
export function momentumFrom(tape, { now = null } = {}) {
  if (!Array.isArray(tape) || tape.length < 3) return null;
  const last = tape.at(-1);
  if (!(last?.close > 0) || last.ts == null) return null;

  /* A "1m" CANDLE IS NOT A MINUTE.
   *
   * This counted candles and named the answer in minutes: vol5mUsd summed the last
   * five rows, pct5m compared against the row five back. That is only the same thing
   * if the feed emits an empty candle for every minute nobody traded, and it does not
   * — it returns rows only where trades happened. Measured on eight live coins, the
   * span of the last five candles ran from 4 minutes to 2,665: on ZODs this summed
   * forty-four hours of trickle and reported it as five minutes of volume, and the
   * ignition shortlist ranked that above a coin genuinely doing $400 in four minutes.
   * The sparser the tape, the bigger the number — the ruler rewarded exactly the
   * inactivity it was built to detect.
   *
   * The windows are now cut on the timestamps. `now` defaults to the last candle
   * rather than the wall clock so the reading is about the tape rather than about how
   * long ago it was fetched; pass one to measure staleness deliberately. */
  const end = now ?? last.ts;
  const MIN = 60_000;
  const inWindow = (from, to) => tape.filter((k) => k.ts > end - to * MIN && k.ts <= end - from * MIN);
  const sumVol = (rows) => rows.reduce((a, k) => a + (k.volume || 0), 0);

  /* The close as of N minutes ago: the last candle at or before that instant. Null when
   * the tape does not reach back that far — a coin eight minutes old has no 30-minute
   * change, and inventing one from its first ever print is how a new coin reads as a
   * moonshot. */
  const closeAt = (minsAgo) => {
    const cut = end - minsAgo * MIN;
    let found = null;
    for (const k of tape) { if (k.ts <= cut) found = k; else break; }
    return found?.close ?? null;
  };
  const pct = (mins) => {
    const then = closeAt(mins);
    return then > 0 ? ((last.close / then) - 1) * 100 : null;
  };

  const recent = inWindow(0, 5);
  const prior = inWindow(5, 15);
  const recentVol = sumVol(recent);
  // Ten minutes of prior against five of recent, so halve it to compare like with like.
  const priorVol = prior.length ? sumVol(prior) / 2 : 0;
  const coverageMins = (last.ts - tape[0].ts) / MIN;
  const high = Math.max(...tape.map((k) => k.close));

  return {
    candles: tape.length,
    // How much history the tape actually spans, so a caller can tell a coin with a
    // thin window from one with a long quiet one.
    coverageMins: Number(coverageMins.toFixed(1)),
    // Whether the last print is recent enough for a five-minute reading to mean
    // anything at all. Only meaningful when `now` was supplied.
    stalenessMins: now == null ? null : Number(((now - last.ts) / MIN).toFixed(1)),
    lastPriceUsd: last.close,
    pct5m: pct(5), pct15m: pct(15), pct30m: pct(30),
    vol5mUsd: recentVol,
    volPrior5mUsd: priorVol,
    // Null, not Infinity: a coin whose prior window was silent has no ratio to report.
    volAccel: priorVol > 0 ? recentVol / priorVol : null,
    drawdownFromHighPct: high > 0 ? ((last.close / high) - 1) * 100 : null,
  };
}

/** The minute tape for many mints at once, bounded so a sweep cannot melt the host. */
export async function momentumFor(mints, { limit = 40, concurrency = 8, now = null } = {}) {
  const out = new Map();
  // A single mint passed by mistake would otherwise be spread into its characters and
  // fetched letter by letter, and every reading would come back null.
  const list = typeof mints === "string" ? [mints] : (Array.isArray(mints) ? mints : []);
  const queue = [...new Set(list)].filter(Boolean);
  const workers = Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, async () => {
    for (let mint = queue.pop(); mint; mint = queue.pop()) {
      try { out.set(mint, momentumFrom(await candles(mint, { limit }), { now })); }
      catch { out.set(mint, null); }
    }
  });
  await Promise.all(workers);
  return out;
}
