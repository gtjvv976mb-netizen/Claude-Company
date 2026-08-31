import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

// Minimal .env loader so the desk has no dotenv dependency.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

export const CHARTER = fs.readFileSync(path.join(ROOT, "DESK.md"), "utf8");

export const cfg = {
  rpc: process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com",
  birdeyeKey: process.env.BIRDEYE_API_KEY || "",

  equityUsd: num("DESK_EQUITY_USD", 10000),
  maxRiskPct: num("DESK_MAX_RISK_PCT", 1.0),
  maxCandidates: num("DESK_MAX_CANDIDATES", 8),
  /* THE SIZE THE EXIT PROBE MEASURES AT — and it must resemble the size actually
   * traded, or the desk vetoes coins on a cost nobody pays. It has come down twice:
   * $500 (chosen against the $10,000 notional book above), then $200, now $75.
   *
   * The executor sizes at ~$3.40 with a hard cap near $10, so $75 still prices about
   * twenty tenants copying one call at once — which is the reason to probe above your
   * own clip at all. But it no longer vetoes the micro-caps this desk now hunts: at
   * the $12,000 liquidity floor below, $75 round-trips at 2.5%, well inside the 8%
   * ceiling, while a real $3.40 clip costs 0.11%. */
targetSizeUsd: num("DESK_TARGET_SIZE_USD", 75),

  // Deterministic screen floors. These kill before any token is spent.
  screen: {
    /* LOWERED FOR MICRO-CAPS, and only safe because the probe came down with it.
     *
     * $75,000 -> $25,000 was measured against the live market: the survivor curve
     * went flat below $25k, so nothing more was admitted. That measurement assumed
     * the OTHER floors (volume $50k, txns 200) were unchanged — and those are what
     * were actually excluding the sub-$1m coins this desk now wants.
     *
     * At $12,000 a real $3.40 clip round-trips at 0.11% and the $75 probe at 2.5%.
     * The pool is thin enough to be drained by a determined seller, which is exactly
     * what liq_collapse, cannot_exit, holder concentration and the freeze-authority
     * check are for. Those did not move and must not.
     *
     * Note this is DEPTH, not market cap: a $1m-cap coin is a claim about price x
     * supply, while liquidity is the money actually in the pool to sell into. They
     * are routinely an order of magnitude apart. */
minLiquidityUsd: num("DESK_MIN_LIQUIDITY_USD", 12000),
    // 24h here quietly strangled the sniper lane: the free screen killed every
    // coin the ignition path is FOR. The research's floor is one hour past
    // migration (rugs express inside the first hour); 1.5h keeps a margin.
    minPairAgeHours: num("DESK_MIN_PAIR_AGE_HOURS", 1.5),
    minVolume24hUsd: num("DESK_MIN_VOL24_USD", 15000),
    maxVolToLiqRatio: num("DESK_MAX_VOL_LIQ", 40),   // above this, suspect wash
    minTxns24h: num("DESK_MIN_TXNS24", 60),
    maxFdvToLiqRatio: num("DESK_MAX_FDV_LIQ", 250),  // thin float propping a fat FDV

    /* THE CEILING — $10m, now $3m. This desk hunts the coins that can still re-rate.
     *
     * A memecoin thesis is a claim that a coin can multiply. At $3m a 2x needs a few
     * million of fresh money; at $30m it needs sixty, which is somebody else's
     * business. The upside lives well below this line, and the whole point of coming
     * down here is that a 2x is an ordinary afternoon rather than a bull market.
     *
     * A ceiling on the OPPORTUNITY, not on safety. What decides whether a position
     * can be LEFT is the liquidity floor and the exit probe, and an unknown market
     * cap never fails this check — an unreadable number must not become an
     * execution. */
/* The board runs $10k to $20m. Below $10k there is not enough coin to trade and
     * the pool is one wallet; above $20m is somebody else's business. */
    minMarketCapUsd: num("DESK_MIN_MCAP_USD", 10_000),
    maxMarketCapUsd: num("DESK_MAX_MCAP_USD", 20_000_000),
  },

  // Slippage the desk refuses to accept on a round trip at target size.
  maxRoundTripSlippagePct: num("DESK_MAX_RT_SLIPPAGE", 8),

  /* REWEIGHTED FOR THE MARKET THIS DESK IS ACTUALLY IN.
   *
   * Narrative was the LOWEST-weighted seat at 0.14 — on a memecoin desk, where the
   * story is not a tiebreak, it is the asset. Nothing else about a two-hour-old coin
   * with a $200k cap is informative: it has no chart worth reading, no revenue, and a
   * book thin enough that "liquidity analysis" mostly restates the screen. What it
   * has is a dev, an X account, and either real people talking or one script pasted
   * four hundred times. That is the whole question.
   *
   * So narrative — the seat holding Grok's first-party read of X — becomes the
   * heaviest. Forensics stays near the top because it answers a different question
   * that never stops mattering: can this be used against a holder by design.
   * Technical falls hardest; a coin younger than a trading session has no tape to
   * analyse and a "technical read" of one is astrology with a candlestick chart. */
  /* THE CHART IS THE LEAST INFORMATIVE THING ABOUT A MEMECOIN.
   *
   * Narrative was originally the LOWEST seat at 0.14 and technical the fourth at 0.16 —
   * weights that belong to an asset with fundamentals, where price action summarises
   * what a market of informed participants concluded. A six-hour-old coin has no such
   * market: its chart is a few hours of the same attention the narrative seat is
   * reading, redrawn as candles. Weighting both is double-counting the weaker copy.
   *
   * What actually moves these: whether the lore is real and traceable, whether a trend
   * is live and this coin is early to it, whether an endorsement is a genuine person
   * with reach or a bought post — and, separately, whether the thing can rug you.
   *
   * So narrative dominates, forensics holds its ground because "can this be used
   * against a holder" never stops mattering at any weight, flow answers whether the
   * buyers are people or one wallet in a wig, and the chart keeps a token weight
   * rather than none: a coin that has already gone vertical is still worth knowing
   * about, and zero would mean never hearing it. */
  weights: {
    narrative: 0.38,   // lore, trend, endorsement — on a memecoin this IS the asset
    forensics: 0.26,   // can it be used against a holder by design
    flow: 0.24,        // real wallets arriving, or a few round-tripping
    liquidity: 0.09,   // can it be exited; micro-caps are thin by definition
    technical: 0.03,   // the chart, which on a 6-hour-old coin is attention redrawn
  },

  // Defaults are the economical tier; env vars UPGRADE a seat, they no longer rescue
  // the bill. Measured 2026-08-29: all-Opus ran $1.29-1.44 a workup, and three seats
  // were most of it — Red Team thinking at xhigh (31% of all spend by itself),
  // Narrative dragging ~41k tokens of raw web results in per run, and five analysts
  // filling bounded schemas on the priciest model in the house. Judgment seats keep
  // Opus; evidence-shaped verdicts do not need it.
  models: {
    scout:      process.env.DESK_MODEL_SCOUT      || "claude-haiku-4-5",
    forensics:  process.env.DESK_MODEL_FORENSICS  || "claude-sonnet-5",
    liquidity:  process.env.DESK_MODEL_LIQUIDITY  || "claude-sonnet-5",
    flow:       process.env.DESK_MODEL_FLOW       || "claude-sonnet-5",
    narrative:  process.env.DESK_MODEL_NARRATIVE  || "claude-sonnet-5",
    technical:  process.env.DESK_MODEL_TECHNICAL  || "claude-sonnet-5",
    redteam:    process.env.DESK_MODEL_REDTEAM    || "claude-opus-5",
    risk:       process.env.DESK_MODEL_RISK       || "claude-sonnet-5",
    pm:         process.env.DESK_MODEL_PM         || "claude-opus-5",
    execution:  process.env.DESK_MODEL_EXECUTION  || "claude-sonnet-5",
  },

  effort: {
    scout: "low",
    forensics: "high",
    liquidity: "medium",
    flow: "high",
    narrative: "medium",
    technical: "medium",
    redteam: "high",    // the adversary keeps the strongest MODEL; xhigh thinking alone
                        // was ~14k output tokens a run and a third of the whole bill
    risk: "high",
    pm: "high",
    execution: "medium",
  },

  // The desk stops paying, not the process: past this 24h spend, cycles skip their
  // model stages and say so on the tape. Monitoring (prices, exits) costs nothing
  // and keeps running.
  /* Raised 25 -> 40 at the owner's request, to get a cycle through TONIGHT.
   *
   * Today's $25 was consumed by the 5-minute scanner before the lane reserve existed
   * (163 workups, 138 of them killed at the screen), so every cycle since has started
   * and halted with no money to work with. The reserve fixes this from tomorrow on
   * its own — it is a rolling 24h window — but it cannot refund what is already
   * spent, and the autotrader has never once been exercised on a real call.
   *
   * $40 buys roughly 140 workups at the measured $0.126 each. The per-cycle ceiling
   * of $10 still bounds any single cycle, and the reserve still stops the scanner
   * taking more than 55%, so this raises the ceiling without loosening either brake. */
  dailyBudgetUsd: Number(process.env.DESK_DAILY_BUDGET_USD || 90),
};

/** The RPC URL embeds an API key. Never print it raw — mask it wherever it is shown. */
export const maskRpc = (u = cfg.rpc) =>
  String(u).replace(/([?&]api-key=)[^&]+/i, "$1***").replace(/\/\/([^@/]+:)[^@]+@/, "//$1***@");

// Well-known mints used as quote assets / routing anchors.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
