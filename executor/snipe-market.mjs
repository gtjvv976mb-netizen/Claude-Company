/**
 * THE MARKET FLOOR — the single biggest change to what this bot trades.
 *
 * bagworkagent.fun's agents will not touch a token under an hour old, under $30,000 of
 * liquidity, under $50,000 of 24-hour volume, or under a $50,000 market cap. Those four
 * numbers are theirs, read out of their own strategy configuration, and they are worth
 * copying for one reason: they refuse ALMOST EXACTLY the population HAWK-AI currently buys,
 * and this desk's own record says that population loses money.
 *
 * 64 real trades, -0.361 SOL, 5 winners. Entries under three seconds won 0% of the time for
 * -18.5%; entries at ten seconds and later won 40% for +34.0%. No entry signal ordered the
 * outcome, and fees were about 45% of the average loss. Every number in that sentence says
 * the same thing: the problem is not the speed of the feed, it is that a coin nobody has
 * traded yet has no demand to measure, so there is nothing to be right about.
 *
 * A floor is the opposite bet. It refuses to be first and insists on evidence.
 *
 * ── WHAT THIS FILE DOES NOT PRETEND ───────────────────────────────────────────────────
 *
 * BAGWORK trade coins that have long since bonded, on AMM pools. This desk cannot: the only
 * buy and sell layouts proved against mainnet here are pump.fun's bonding curve v2
 * (snipe-venue-pumpfun.mjs), and a bonded coin trades somewhere this repo cannot yet
 * encode. So the floor is applied where it CAN be honoured — coins still on their curve,
 * which is the overlap between "has proven demand" and "this bot can actually buy it". A
 * coin can be a week old, still on its curve, and trading: the venue's own listing showed
 * one at 247 hours. That overlap is the buyable part of their strategy, and pretending the
 * rest is reachable would be a lie told in code.
 *
 * ── THE FOUR FACTS, AND WHERE EACH ONE HONESTLY COMES FROM ─────────────────────────────
 *
 * Every fact below is either free or already paid for. Nothing here adds a request to the
 * path that buys.
 *
 *   age          the venue's own `created_timestamp`, off the listing row.
 *   liquidity    the curve's REAL quote reserve x SOL/USD. For a bonding curve this is not
 *                a proxy for depth, it IS the depth: it is the SOL a seller can actually
 *                get out. The lane already read the curve; the oracle is already polled.
 *   market cap   the venue's own `usd_market_cap`, off the same listing row.
 *   24h volume   DexScreener, the only source for it, and the one request this costs — paid
 *                only for candidates that already cleared the three free facts.
 *
 * ── AND WHAT IS UNKNOWN IS NEVER ZERO ─────────────────────────────────────────────────
 *
 * `Number(null)` is `0`, and this desk has already been bitten by exactly that once: a
 * creator-fee vault read that failed came back as a confident "empty". Here the same bug
 * would be worse in both directions — an unreadable liquidity reading as $0 refuses
 * everything, and an unreadable 24h volume reading as $0 does too, so the floor would look
 * like it was working while measuring nothing. So every fact is `null` when unknown, the
 * floor REFUSES on a null it was asked to judge, and the refusal names the missing fact
 * rather than the threshold.
 */

/**
 * BAGWORK'S OWN NUMBERS. Copied, not invented — these are the values their agents run, and
 * they are kept in their own frozen object so that nothing this desk adds can be mistaken
 * for something they proved.
 */
export const BAGWORK_FLOOR = Object.freeze({
  minAgeHours: 1,
  minLiquidityUsd: 30_000,
  minVolume24hUsd: 50_000,
  minMcapUsd: 50_000,
});

/**
 * WHAT THIS DESK ADDS, AND WHY EACH ONE EARNS ITS PLACE.
 *
 * Their floor is four thresholds on four numbers, and every one of those numbers can be
 * manufactured by the person who launched the coin. That is not a hypothetical on this
 * venue: a deployer can wash a coin between two wallets all day, and volume, market cap and
 * price all move. So these five refuse the SHAPE of a manufactured market rather than its
 * size, and every one of them reads off facts the four above already fetched.
 *
 *  - maxVolumeToLiquidity — $5m of 24h volume against $30k of depth is not a market, it is
 *    a treadmill. Real books turn over their depth a few times a day, not two hundred.
 *  - minTxns24h — a dollar figure is one wallet's decision; a transaction count is many
 *    people's. Cheapest honest check on whether "volume" means "traders".
 *  - maxSellShare — when three of every four trades are sells, the demand being measured is
 *    somebody else's exit, and a buyer is the liquidity for it.
 *  - maxPriceChange24hPct — their own strategies cap `maxChange5m` at 0.12 and `maxSpike5m`
 *    at 0.2 for this reason: buying what has already run is how you become the exit for
 *    whoever caught it. This is that cap at the timeframe a floor cares about.
 *  - minTopPoolLiquidityUsd — depth summed across twenty dust pools is not depth. You trade
 *    in ONE pool, so the deepest one has to hold enough on its own. Their floor sums.
 *
 * All five are OFF by default (`null`), for the same reason the proxy gates are: a threshold
 * nobody has graded against an outcome is a guess with a number attached. BAGWORK_FLOOR is
 * evidence — it is what a system earning 14.5 SOL actually runs. These are hypotheses, and
 * they ship measured rather than armed.
 */
export const CLAUDE_CO_ADDITIONS = Object.freeze({
  maxVolumeToLiquidity: null,
  minTxns24h: null,
  maxSellShare: null,
  maxPriceChange24hPct: null,
  minTopPoolLiquidityUsd: null,
});

/** The floor as the lane configures it: their four, then ours. */
export const MARKET_FLOOR_DEFAULTS = Object.freeze({ ...BAGWORK_FLOOR, ...CLAUDE_CO_ADDITIONS });

/** Every threshold this file understands. A config naming anything else is a typo, and a
 *  typo in a floor is a floor that is not there — so it throws rather than being ignored. */
export const MARKET_FLOOR_KEYS = Object.freeze(Object.keys(MARKET_FLOOR_DEFAULTS));

/** The facts a floor judges, in the order it judges them: free ones first. */
export const MARKET_FACTS = Object.freeze([
  "ageHours", "mcapUsd", "liquidityUsd", "topPoolLiquidityUsd",
  "volume24hUsd", "txns24h", "sellShare", "priceChange24hPct",
]);

export class MarketFloorError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "MarketFloorError";
    this.clause = clause;
    this.detail = Object.freeze({ clause, ...detail });
  }
}

const LAMPORTS = 1_000_000_000;
/** Wrapped SOL. Written out rather than imported: snipe-entry.mjs imports THIS file, so
 *  importing its SOL_QUOTE_MINT back would be a cycle. test-snipe-market.mjs asserts the two
 *  literals are identical, which is the check that matters. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** A finite non-negative number, or null. NEVER a coerced zero — see the header. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const nonNeg = (v) => {
  const x = num(v);
  return x === null || x < 0 ? null : x;
};
const bigOrNull = (v) => {
  if (typeof v === "bigint") return v;
  const s = String(v ?? "");
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

/**
 * SOL IN DOLLARS, OUT OF THE SAME RESPONSE — no oracle call, no cache, no extra request.
 *
 * A DexScreener pair states its base token's price twice: `priceUsd` in dollars and
 * `priceNative` in the quote token. On a WSOL-quoted pair the ratio of the two IS the dollar
 * price of SOL, and it is self-consistent with the very pool whose depth is being read.
 *
 * WSOL-quoted pools ONLY. This venue really does list curves quoted in USDC and in other
 * mints — proved on mainnet in the venue adapter — and on one of those the same ratio yields
 * roughly 1.0, which would value a 200 SOL reserve at two hundred dollars and refuse a
 * perfectly good candidate for being shallow. So the quote mint is checked, never assumed.
 *
 * The MEDIAN across qualifying pools, because one stale or manipulated pool should not set
 * the denominator for every liquidity figure. And a result outside a very wide sanity band is
 * reported as unknown rather than used: a SOL price of four dollars or four million is not a
 * market move, it is a unit or decoding fault, and a fault that is quietly accepted here
 * silently rescales every threshold in the floor.
 */
export function solUsdFromPairs(pairs) {
  if (!Array.isArray(pairs)) return null;
  const votes = [];
  for (const p of pairs) {
    if (!isPlainObject(p) || p.chainId !== "solana") continue;
    if (p.quoteToken?.address !== WSOL_MINT) continue;
    const usd = num(p.priceUsd), native = num(p.priceNative);
    if (usd === null || native === null || !(usd > 0) || !(native > 0)) continue;
    votes.push(usd / native);
  }
  if (!votes.length) return null;
  votes.sort((a, b) => a - b);
  const mid = votes.length % 2 ? votes[(votes.length - 1) / 2]
    : (votes[votes.length / 2 - 1] + votes[votes.length / 2]) / 2;
  return mid >= 1 && mid <= 1_000_000 ? mid : null;
}

/**
 * The facts, assembled from what the lane already has.
 *
 * Pure: every input is passed in, including the clock, so a captured candidate replays to
 * the identical verdict. Each source is optional and each missing source leaves its facts
 * `null` rather than zero — a floor judging a null refuses and says which fact was missing.
 *
 * `listing` is a pump.fun listing row (the venue's own numbers for its own curve).
 * `curve`   is the decoded bonding curve, for the liquidity that only it can state exactly.
 * `pairs`   is DexScreener's pair array for the mint, for the volume nothing else has.
 * `solUsd`  is the SOL price, without which a lamport reserve is not a dollar figure.
 */
export function marketFacts({ listing = null, curve = null, pairs = null, solUsd = null, nowMs = null,
  /* The creation stamp when no listing row carries one — a launch notice knows when it
     arrived, and for a create event that IS the coin's birth. Supplied rather than guessed
     so that an armed floor refuses a fresh launch with "four minutes old" instead of with
     "age could not be measured", which is true but useless. */
  createdAtMs: createdAtMsHint = null } = {}) {
  const row = isPlainObject(listing) ? listing : {};
  const now = num(nowMs);
  /* A SUPPLIED PRICE WINS — an operator who wired the desk's verified oracle should get it —
     and the pairs are the fallback, not the other way round. Which one was used is reported,
     because a liquidity figure is only as good as its denominator. */
  const supplied = (() => { const x = num(solUsd); return x !== null && x > 0 ? x : null; })();
  const list0 = Array.isArray(pairs) ? pairs : null;
  const derived = supplied === null ? solUsdFromPairs(list0) : null;
  const sol = supplied ?? derived;
  const solUsdSource = supplied !== null ? "supplied" : (derived !== null ? "pairs" : null);

  /* AGE, from the venue's own creation stamp. Milliseconds: the listing states them in ms
     and a seconds/ms mix-up here is a 1000x error in the one fact whose whole purpose is to
     keep this bot away from brand-new coins, so the unit is asserted rather than sniffed. */
  const createdAtMs = num(row.created_timestamp) ?? num(createdAtMsHint);
  const ageHours = createdAtMs !== null && now !== null && now >= createdAtMs
    ? (now - createdAtMs) / 3_600_000 : null;

  /* LIQUIDITY, from the curve itself. realQuoteRaw is the SOL actually inside the curve —
     what a seller can get out — so for a bonding curve this is the honest depth and not an
     approximation of one. A curve whose real reserve is unknown yields null, never zero:
     "unreadable" and "empty" are opposite facts about whether to trade. */
  const realQuoteRaw = bigOrNull(curve?.realQuoteRaw);
  const liquiditySol = realQuoteRaw === null ? null : Number(realQuoteRaw) / LAMPORTS;
  const liquidityUsd = liquiditySol !== null && sol !== null ? liquiditySol * sol : null;

  /* MARKET CAP, the venue's own USD figure. Cross-checked against DexScreener below when
     both are present, because a market cap is supply x price and this venue quotes some
     curves in mints other than SOL — a case already proved on mainnet in the venue adapter. */
  const mcapUsd = nonNeg(row.usd_market_cap ?? row.market_cap_usd);

  /* THE DEXSCREENER HALF. Solana pairs only, sorted deepest first, and every figure summed
     ACROSS pools except the ones that are only meaningful per pool. */
  const list = Array.isArray(pairs) ? pairs.filter((p) => isPlainObject(p) && p.chainId === "solana") : null;
  const depths = list === null ? null : list.map((p) => nonNeg(p.liquidity?.usd)).filter((x) => x !== null);
  const topPoolLiquidityUsd = depths === null || !depths.length ? null : Math.max(...depths);
  const vols = list === null ? null : list.map((p) => nonNeg(p.volume?.h24)).filter((x) => x !== null);
  const volume24hUsd = vols === null || !vols.length ? null : vols.reduce((a, b) => a + b, 0);

  let buys = null, sells = null;
  if (list !== null) {
    for (const p of list) {
      const b = nonNeg(p.txns?.h24?.buys), s = nonNeg(p.txns?.h24?.sells);
      if (b === null || s === null) continue;
      buys = (buys ?? 0) + b; sells = (sells ?? 0) + s;
    }
  }
  const txns24h = buys === null ? null : buys + sells;
  /* A ZERO-TRADE DAY HAS NO SELL SHARE. Reported null rather than 0, which would read as
     "every trade was a buy" — the most bullish possible reading of no trades at all. */
  const sellShare = txns24h === null || txns24h === 0 ? null : sells / txns24h;

  /* Price change from the DEEPEST pool, not averaged: a percentage from a dust pool is a
     rounding artefact, and averaging it into a real one launders the artefact. */
  const deepest = list === null || !list.length ? null
    : list.reduce((a, b) => ((nonNeg(b.liquidity?.usd) ?? -1) > (nonNeg(a.liquidity?.usd) ?? -1) ? b : a));
  const priceChange24hPct = deepest === null ? null : num(deepest.priceChange?.h24);

  return Object.freeze({
    mint: typeof row.mint === "string" ? row.mint : (typeof curve?.mint === "string" ? curve.mint : null),
    ageHours, mcapUsd, liquidityUsd, topPoolLiquidityUsd,
    volume24hUsd, txns24h, sellShare, priceChange24hPct,
    /* Carried so a refusal can be explained without re-deriving it, and so a shadow row
       keeps the inputs beside the verdict. */
    liquiditySol, solUsd: sol, solUsdSource, createdAtMs, pools: list === null ? null : list.length,
    onCurve: row.complete === undefined ? null : row.complete !== true,
    /* THE DISAGREEMENT, REPORTED. Two independent market caps that differ by more than 3x
       mean one of them is measuring something else — a non-SOL-quoted curve, a stale pool —
       and a floor that silently picks the friendlier one is not a floor. */
    dexMcapUsd: deepest === null ? null : nonNeg(deepest.marketCap ?? deepest.fdv),
  });
}

/**
 * The floor. Returns `null` when the candidate clears it, or a refusal naming the ONE fact
 * that stopped it — first failure wins, cheapest first, so a report says which single thing
 * to look at rather than a list.
 *
 * A threshold set against a fact that could not be measured REFUSES. That rule is the whole
 * reason this function can be trusted: the alternative — treating unknown as acceptable —
 * turns every outage at DexScreener into an afternoon of unfiltered buying.
 */
export function marketFloor(facts, cfg = {}) {
  if (!isPlainObject(facts)) throw new MarketFloorError("facts_missing", "marketFloor needs a facts object");
  if (!isPlainObject(cfg)) throw new MarketFloorError("config_invalid", "marketFloor needs a config object");
  for (const key of Object.keys(cfg)) {
    if (!MARKET_FLOOR_KEYS.includes(key))
      throw new MarketFloorError("config_invalid",
        `market floor does not understand ${JSON.stringify(key)}; a threshold this file ignores is a floor that is not there. `
        + `Known: ${MARKET_FLOOR_KEYS.join(", ")}`, { key });
  }

  const measured = {};
  for (const f of MARKET_FACTS) measured[f] = facts[f] ?? null;

  /** One rule. `cmp` is true when the fact PASSES. */
  const rule = (key, fact, cmp, say) => {
    const bar = num(cfg[key]);
    if (bar === null) return null;                       // not configured: nothing to judge
    const got = num(facts[fact]);
    if (got === null)
      return { clause: key, fact, threshold: bar, measured: null,
        message: `${key} is set to ${bar} but ${fact} could not be measured for this candidate — `
          + "unverified is not safe, so the floor refuses rather than assuming it would have passed" };
    if (cmp(got, bar)) return null;
    return { clause: key, fact, threshold: bar, measured: got, message: say(got, bar) };
  };

  const atLeast = (got, bar) => got >= bar;
  const atMost = (got, bar) => got <= bar;
  const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /* THEIR FOUR, in the order of what each costs to know. */
  const checks = [
    rule("minAgeHours", "ageHours", atLeast,
      (g, b) => `the coin is ${g < 1 ? plural(Math.round(g * 60), "minute") : `${g.toFixed(1)} hours`} old, under the `
        + `${b}-hour floor — a coin nobody has traded yet has no demand to measure`),
    rule("minMcapUsd", "mcapUsd", atLeast,
      (g, b) => `market cap is ${usd(g)}, under the ${usd(b)} floor`),
    rule("minLiquidityUsd", "liquidityUsd", atLeast,
      (g, b) => `the curve holds ${usd(g)} of real SOL, under the ${usd(b)} floor — that is what a seller can get out`),
    rule("minTopPoolLiquidityUsd", "topPoolLiquidityUsd", atLeast,
      (g, b) => `the deepest single pool holds ${usd(g)}, under the ${usd(b)} floor — you trade in one pool, not in the sum`),
    rule("minVolume24hUsd", "volume24hUsd", atLeast,
      (g, b) => `24-hour volume is ${usd(g)}, under the ${usd(b)} floor`),
    /* OURS. */
    rule("minTxns24h", "txns24h", atLeast,
      (g, b) => `${g} trades in 24 hours, under the ${b} floor — a dollar figure is one wallet's decision, a trade count is many`),
    rule("maxSellShare", "sellShare", atMost,
      (g, b) => `${Math.round(g * 100)}% of the last day's trades were SELLS, over the ${Math.round(b * 100)}% cap — `
        + "the demand here is somebody else's exit"),
    rule("maxPriceChange24hPct", "priceChange24hPct", atMost,
      (g, b) => `already up ${Math.round(g)}% today, over the ${Math.round(b)}% cap — buying what has run is how you become the exit`),
    /* maxVolumeToLiquidity is judged after this loop: it is the only rule that needs TWO
       facts, so it has two ways to be unmeasurable and a division that must be guarded. */
  ].filter(Boolean);

  for (const refusal of checks) return Object.freeze({ ...refusal, measured });

  /* THE WASH-TRADE RATIO, last because it needs two facts and therefore two ways to be
     unmeasurable. Volume over depth: a real book turns its depth over a few times a day. */
  const ratioBar = num(cfg.maxVolumeToLiquidity);
  if (ratioBar !== null) {
    const v = num(facts.volume24hUsd), l = num(facts.liquidityUsd);
    const refuse = (fact, extra) => Object.freeze({
      clause: "maxVolumeToLiquidity", fact, threshold: ratioBar, measured, ...extra,
    });
    if (v === null || l === null) {
      const fact = v === null ? "volume24hUsd" : "liquidityUsd";
      return refuse(fact, { ratio: null,
        message: `maxVolumeToLiquidity is set to ${ratioBar} but ${fact} could not be measured — `
          + "unverified is not safe, so the floor refuses rather than assuming it would have passed" });
    }
    /* A ZERO-DEPTH POOL IS NOT AN INFINITE RATIO. Division by it is refused by name, the
       same discipline snipe-volume.mjs applies to an absent baseline. */
    if (!(l > 0))
      return refuse("liquidityUsd", { ratio: null,
        message: "the curve holds no SOL at all, so volume-over-liquidity cannot be formed — "
          + "a ratio against zero is not a large number, it is not a number" });
    const ratio = v / l;
    if (ratio > ratioBar)
      return refuse("volume24hUsd", { ratio,
        message: `${usd(v)} of 24-hour volume against ${usd(l)} of depth is ${ratio.toFixed(0)}x turnover, over the `
          + `${ratioBar}x cap — that is a treadmill, not a market` });
  }

  return null;
}

/**
 * The market read, as a PORT — injected for the same reason every other outside call in this
 * subsystem is: a test has to be able to drive a hostile answer (an empty pair list, a hang,
 * a pool with no liquidity field, which DexScreener really does return) without a network
 * and without depending on a stranger's uptime.
 *
 * It FAILS SOFT into `null` facts, never into zeros, and reports the failure in `clause` so
 * the floor above it refuses with "could not be measured" rather than with a threshold.
 */
export function createMarketReader({ pairsFor, timeoutMs = 8_000 } = {}) {
  if (typeof pairsFor !== "function")
    throw new MarketFloorError("config_invalid", "createMarketReader needs pairsFor(mint): no HTTP client is built here");
  return async function read(mint) {
    try {
      let timer = null;
      const got = await Promise.race([
        Promise.resolve(pairsFor(String(mint))),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`pairsFor timed out after ${timeoutMs}ms`)), timeoutMs); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (got?.ok && Array.isArray(got.pairs))
        return Object.freeze({ ok: true, clause: null, message: null, pairs: Object.freeze([...got.pairs]) });
      return Object.freeze({ ok: false, clause: "no_pairs", message: String(got?.error ?? "no pairs"), pairs: null });
    } catch (error) {
      return Object.freeze({ ok: false, clause: "fetch_failed", message: String(error?.message ?? error).slice(0, 160), pairs: null });
    }
  };
}

/**
 * One candidate's market read, in the shape the `market_floor` gate consumes: the network
 * half and the local half joined.
 *
 * The SPLIT is the point. The pairs fetch is a network round trip and starts beside the
 * account read; the facts are assembled here, after the curve has decoded, because the
 * honest liquidity number comes out of the curve and not out of anybody's API. So the gate
 * reads a settled fact, the fetch costs the slower of two calls rather than their sum, and
 * nothing on the path that buys waits on a stranger twice.
 */
export function marketReadFor({ read = null, listing = null, curve = null, solUsd = null,
  createdAtMs = null, nowMs = Date.now() } = {}) {
  const r = isPlainObject(read) ? read : null;
  return Object.freeze({
    ok: r?.ok === true,
    clause: r === null ? "no_read" : r.clause ?? null,
    message: r === null ? "no market read was performed for this candidate" : r.message ?? null,
    facts: marketFacts({ listing, curve, pairs: r?.pairs ?? null, solUsd, createdAtMs, nowMs }),
  });
}

/** The floor the lane runs, resolved from a config object that may name only some of it.
 *  Unknown keys throw — see MARKET_FLOOR_KEYS. */
export function resolveMarketFloor(cfg = {}) {
  if (!isPlainObject(cfg)) throw new MarketFloorError("config_invalid", "resolveMarketFloor needs an object");
  for (const key of Object.keys(cfg))
    if (!MARKET_FLOOR_KEYS.includes(key))
      throw new MarketFloorError("config_invalid",
        `market floor does not understand ${JSON.stringify(key)}. Known: ${MARKET_FLOOR_KEYS.join(", ")}`, { key });
  const out = {};
  for (const key of MARKET_FLOOR_KEYS) {
    const v = cfg[key] === undefined ? MARKET_FLOOR_DEFAULTS[key] : cfg[key];
    out[key] = v === null || v === undefined ? null : Number(v);
    if (out[key] !== null && !Number.isFinite(out[key]))
      throw new MarketFloorError("config_invalid", `market floor ${key} must be a finite number or null, got ${JSON.stringify(cfg[key])}`, { key });
    if (out[key] !== null && out[key] < 0)
      throw new MarketFloorError("config_invalid", `market floor ${key} must not be negative, got ${out[key]}`, { key });
  }
  return Object.freeze(out);
}

/** Whether a resolved floor would refuse anything at all. A floor with every threshold null
 *  is not a floor, and a lane that believes it is running one deserves to be told. */
export function floorIsArmed(floor) {
  return isPlainObject(floor) && MARKET_FLOOR_KEYS.some((k) => num(floor[k]) !== null);
}

/**
 * THE ONE PLACE THE FLOOR AND THE FEED CAN SILENTLY CANCEL EACH OTHER OUT.
 *
 * The feed dedupes by mint and forgets a mint after `dedupeTtlMs` — 30 minutes by default,
 * chosen to outlive any position the lane can hold, because a mint that re-enters as a fresh
 * launch while it is still open is the bug that dedupe exists to prevent.
 *
 * The momentum source's whole job is to report coins the LAUNCH sources already saw at t=0. So
 * whether one of its candidates is emitted at all depends on whether the feed has forgotten it
 * yet, and that is decided by the candidate's age against the dedupe window:
 *
 *   minAgeHours 1 against a 30-minute window   ->  every candidate has aged out. Works.
 *   minAgeHours 0.25 against the same window   ->  every candidate is still remembered from its
 *                                                  own launch, and every one is dropped as a
 *                                                  duplicate.
 *
 * The default pairing works, and it works BY COINCIDENCE: two constants chosen for unrelated
 * reasons happen to sit the right way round. An operator lowering the age floor to a quarter of
 * an hour — a completely reasonable thing to try — would get a momentum source that delivers
 * nothing at all, reports no error, and looks exactly like a dead API or a broken pre-filter.
 *
 * So it is refused at startup with both numbers named. This is the same posture the gRPC pair
 * already takes for a half-configured endpoint: a lane that stops and says why beats a lane
 * that runs and silently does less than the operator believes.
 */
export function momentumDedupeConflict({ minAgeHours = null, dedupeTtlMs = null } = {}) {
  const hours = num(minAgeHours);
  const ttl = num(dedupeTtlMs);
  /* No age floor means the momentum source is not selecting on age at all, so there is nothing
     for the window to cancel out. An unknown TTL is not assumed. */
  if (hours === null || ttl === null || !(ttl > 0)) return null;
  const ageMs = hours * 3_600_000;
  if (ageMs >= ttl) return null;
  const mins = (ms) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;
  return Object.freeze({
    clause: "momentum_dedupe_conflict",
    minAgeHours: hours, minAgeMs: ageMs, dedupeTtlMs: ttl,
    message: `SNIPE_MIN_AGE_HOURS=${hours} asks the momentum source for coins ${mins(ageMs)} old, but the `
      + `feed remembers every mint it has seen for ${mins(ttl)} — so every candidate would still be held `
      + "in the dedupe ledger from its own launch and would be dropped as a duplicate before any gate ran. "
      + "The source would deliver nothing, report no error, and look exactly like a dead API. Raise "
      + `SNIPE_MIN_AGE_HOURS to at least ${(ttl / 3_600_000).toFixed(2)}, or turn the floor off.`,
  });
}

export const SNIPE_MARKET_VERSION = "snipe-market-v1";

/* ── THE MOMENTUM SOURCE'S PRE-FILTER ──────────────────────────────────────────────────
 *
 * The floor's fourth fact — 24-hour volume — costs a DexScreener request per candidate, and
 * an activity-sorted listing page is 70 rows of which most cannot pass on facts that are
 * already in hand. So the three FREE facts are judged first, off the listing row alone, and
 * the request is spent only on what survives. That is the same cheapest-first discipline the
 * gate stack runs on, applied one layer earlier.
 *
 * It also enforces the one thing no threshold can: a coin that has already BONDED is not
 * buyable by this desk at all. The only buy and sell layouts proved against mainnet here are
 * pump.fun's bonding curve v2, and a bonded coin trades where this repo cannot yet encode.
 * Admitting one would produce a row that refuses at `curve_already_complete` after paying
 * for a market read — honest, but a waste — so it is dropped here, counted, and named.
 */

/** Why a listing row was dropped before anything was fetched for it. */
export const PREFILTER_CLAUSES = Object.freeze(["no_mint", "bonded", "too_young", "under_mcap", "unknown_age"]);

/**
 * Judge one listing row on what it already carries. Returns `null` to keep it, or a clause
 * naming why it was dropped. Pure — the clock is passed in.
 *
 * ONLY the free facts, and only the thresholds that free facts can honestly answer. It never
 * decides liquidity or volume: those belong to the gate, with the curve and the market read
 * in hand. A pre-filter that guessed at them would be a second, weaker floor disagreeing
 * with the real one.
 */
export function prefilterListingRow(row, floor = {}, { nowMs = Date.now() } = {}) {
  if (!isPlainObject(row) || typeof row.mint !== "string" || !row.mint) return { clause: "no_mint" };
  /* BONDED IS NOT A THRESHOLD, IT IS A CAPABILITY. See above. */
  if (row.complete === true) return { clause: "bonded", mint: row.mint };

  const minAge = num(floor.minAgeHours);
  if (minAge !== null) {
    const created = num(row.created_timestamp);
    const at = num(nowMs);
    /* A row with no creation stamp cannot be judged on age. Dropped, not admitted: the whole
       point of the floor is that this bot stops buying coins whose age it does not know.
       AN UNUSABLE CLOCK IS THE SAME REFUSAL UNDER A DIFFERENT NAME — and it has to be the
       different name. Comparing against NaN drops the row either way, so the fail-closed
       behaviour was already right; the clause was not, and `too_young` blames the coin for a
       fault in this process. An operator reading a listing where every row is "too young"
       looks at the market. One reading "unknown_age" looks at the clock. */
    if (created === null || at === null) return { clause: "unknown_age", mint: row.mint, clockUnusable: at === null };
    const ageHours = (at - created) / 3_600_000;
    if (!(ageHours >= minAge)) return { clause: "too_young", mint: row.mint, ageHours, threshold: minAge };
  }

  const minMcap = num(floor.minMcapUsd);
  if (minMcap !== null) {
    const mcap = nonNeg(row.usd_market_cap ?? row.market_cap_usd);
    /* An unknown market cap is NOT dropped here. Unlike age, the gate can still measure it
       from DexScreener, so dropping it now would refuse a candidate the floor might have
       judged on better evidence. Only a mcap that is KNOWN and under the bar is dropped. */
    if (mcap !== null && mcap < minMcap) return { clause: "under_mcap", mint: row.mint, mcapUsd: mcap, threshold: minMcap };
  }
  return null;
}

/**
 * The momentum fetcher: an activity-sorted listing, pre-filtered, with a tally of what it
 * dropped and why.
 *
 * THE TALLY IS NOT DECORATION. A source that quietly returns two rows out of seventy looks
 * identical to a dead market and to a broken filter, and those need opposite responses. So
 * `stats()` says how many rows arrived, how many survived, and the clause for every one that
 * did not — and a poll where NOTHING survived still reports the arrivals, so "the filter is
 * working" and "the endpoint is empty" can never be confused.
 */
export function momentumFetcher({ fetchRows, floor = {}, now = () => Date.now(), keep = 24 } = {}) {
  if (typeof fetchRows !== "function")
    throw new MarketFloorError("config_invalid", "momentumFetcher needs fetchRows(): the listing fetch is injected, never built here");
  if (!Number.isInteger(keep) || keep < 1)
    throw new MarketFloorError("config_invalid", `momentumFetcher keep must be a positive integer, got ${keep}`);
  const dropped = {};
  for (const c of PREFILTER_CLAUSES) dropped[c] = 0;
  const counters = { polls: 0, arrived: 0, survived: 0, capped: 0, dropped };

  const fn = async function fetchMomentumRows() {
    const rows = await fetchRows();
    if (!Array.isArray(rows)) throw new Error(`momentumFetcher: fetchRows() returned ${rows === null ? "null" : typeof rows}, not an array`);
    counters.polls++;
    counters.arrived += rows.length;
    const nowMs = now();
    const out = [];
    for (const row of rows) {
      const verdict = prefilterListingRow(row, floor, { nowMs });
      if (verdict === null) out.push(row);
      else dropped[verdict.clause] = (dropped[verdict.clause] ?? 0) + 1;
    }
    counters.survived += out.length;
    /* A CAP, because the gate stack pays a request per survivor. The listing is sorted by
       activity, so the head of it is the part worth paying for, and what was cut is counted
       rather than silently lost. */
    if (out.length > keep) { counters.capped += out.length - keep; return out.slice(0, keep); }
    return out;
  };
  fn.stats = () => ({ ...counters, dropped: { ...dropped }, keep });
  return fn;
}
