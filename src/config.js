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
  targetSizeUsd: num("DESK_TARGET_SIZE_USD", 500),

  // Deterministic screen floors. These kill before any token is spent.
  screen: {
    minLiquidityUsd: num("DESK_MIN_LIQUIDITY_USD", 75000),
    minPairAgeHours: num("DESK_MIN_PAIR_AGE_HOURS", 24),
    minVolume24hUsd: num("DESK_MIN_VOL24_USD", 50000),
    maxVolToLiqRatio: num("DESK_MAX_VOL_LIQ", 40),   // above this, suspect wash
    minTxns24h: num("DESK_MIN_TXNS24", 200),
    maxFdvToLiqRatio: num("DESK_MAX_FDV_LIQ", 250),  // thin float propping a fat FDV
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

  // Every stage defaults to the strongest model. Cost lever: set any of these to
  // claude-sonnet-5 (or claude-haiku-4-5 for the mechanical ones) via env.
  // Effort is tuned per stage instead — it cuts spend without cutting model tier.
  models: {
    scout:      process.env.DESK_MODEL_SCOUT      || "claude-opus-5",
    forensics:  process.env.DESK_MODEL_FORENSICS  || "claude-opus-5",
    liquidity:  process.env.DESK_MODEL_LIQUIDITY  || "claude-opus-5",
    flow:       process.env.DESK_MODEL_FLOW       || "claude-opus-5",
    narrative:  process.env.DESK_MODEL_NARRATIVE  || "claude-opus-5",
    technical:  process.env.DESK_MODEL_TECHNICAL  || "claude-opus-5",
    redteam:    process.env.DESK_MODEL_REDTEAM    || "claude-opus-5",
    risk:       process.env.DESK_MODEL_RISK       || "claude-opus-5",
    pm:         process.env.DESK_MODEL_PM         || "claude-opus-5",
    execution:  process.env.DESK_MODEL_EXECUTION  || "claude-opus-5",
  },

  effort: {
    scout: "low",
    forensics: "high",
    liquidity: "medium",
    flow: "high",
    narrative: "medium",
    technical: "medium",
    redteam: "xhigh",   // the adversary gets the most room to think
    risk: "high",
    pm: "xhigh",        // and so does the decision-maker
    execution: "medium",
  },
};

// Well-known mints used as quote assets / routing anchors.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
