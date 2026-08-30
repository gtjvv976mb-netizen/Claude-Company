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
   * traded, or the desk vetoes coins on a cost nobody pays. This was $500, chosen
   * against the $10,000 notional book above. The executor that trades these calls
   * sizes at 2% of a sub-1-SOL wallet: about $3.40, with a hard cap near $10. So
   * the screen was rejecting coins on the round-trip cost of a position ~150x
   * larger than any that gets placed.
   *
   * $200 keeps the check meaningful rather than merely passing it: it still asks
   * whether MANY tenants copying one call could all get out, which is the reason
   * to probe above your own clip size at all — while no longer failing a coin over
   * an order nobody sends. At the $25,000 liquidity floor below this round-trips
   * at ~3.2%, comfortably inside the 8% ceiling. */
  targetSizeUsd: num("DESK_TARGET_SIZE_USD", 200),

  // Deterministic screen floors. These kill before any token is spent.
  screen: {
    /* MEASURED, not chosen. Sweeping 301 live coins and moving this floor alone:
     *   $75,000 -> 53 survivors      $30,000 -> 67
     *   $50,000 -> 61                $25,000 -> 68
     *   $40,000 -> 66                $20,000 -> 68   (no further gain)
     * The curve is flat below $25k — every coin the market has to offer is already
     * admitted there, so going lower buys literally nothing and only takes on pools
     * a single wallet can drain. $25,000 is where the gains stop, which is why it
     * is the floor rather than a rounder, braver-sounding number.
     *
     * Note this is DEPTH, not market cap: a $1m-market-cap coin is a claim about
     * price x supply, while liquidity is the money actually in the pool to sell
     * into. They are routinely an order of magnitude apart. */
    minLiquidityUsd: num("DESK_MIN_LIQUIDITY_USD", 25000),
    // 24h here quietly strangled the sniper lane: the free screen killed every
    // coin the ignition path is FOR. The research's floor is one hour past
    // migration (rugs express inside the first hour); 1.5h keeps a margin.
    minPairAgeHours: num("DESK_MIN_PAIR_AGE_HOURS", 1.5),
    minVolume24hUsd: num("DESK_MIN_VOL24_USD", 50000),
    maxVolToLiqRatio: num("DESK_MAX_VOL_LIQ", 40),   // above this, suspect wash
    minTxns24h: num("DESK_MIN_TXNS24", 200),
    maxFdvToLiqRatio: num("DESK_MAX_FDV_LIQ", 250),  // thin float propping a fat FDV

    /* THE CEILING — this desk hunts memecoins, not holdings.
     *
     * There was no market-cap bound of any kind here, in either direction, and the
     * ranking paid up to +39 for depth alone (+15 over $75k liquidity, +10 over
     * $400k, +14 for an aged survivor over $750k). A large established coin therefore
     * out-ranked a small one on size before its story was read at all, and the desk
     * kept surfacing coins you would hold rather than trade.
     *
     * A memecoin thesis is a claim that a coin can RE-RATE. Past roughly $10m that
     * claim needs someone to arrive with millions, which is a different business from
     * the one this desk is in. Below it, a 2-5x is an ordinary week.
     *
     * This is a ceiling on the OPPORTUNITY, not on safety — the liquidity floor and
     * the exit probe remain the things that decide whether a position can be left. */
    maxMarketCapUsd: num("DESK_MAX_MCAP_USD", 10_000_000),
  },

  // Slippage the desk refuses to accept on a round trip at target size.
  maxRoundTripSlippagePct: num("DESK_MAX_RT_SLIPPAGE", 8),

  // PM weighting. The desk's opinion about what predicts a good Solana trade:
  // safety and exitability dominate; narrative is a tiebreak.
  weights: {
    forensics: 0.28,
    liquidity: 0.22,
    flow: 0.20,
    technical: 0.16,
    narrative: 0.14,
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
  dailyBudgetUsd: Number(process.env.DESK_DAILY_BUDGET_USD || 40),
};

/** The RPC URL embeds an API key. Never print it raw — mask it wherever it is shown. */
export const maskRpc = (u = cfg.rpc) =>
  String(u).replace(/([?&]api-key=)[^&]+/i, "$1***").replace(/\/\/([^@/]+:)[^@]+@/, "//$1***@");

// Well-known mints used as quote assets / routing anchors.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
