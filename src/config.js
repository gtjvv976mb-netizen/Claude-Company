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

/* THE OPEN CYCLE'S BAND WINDOW, or null when nothing is widened. Module-scoped
   because it is a property of the DESK's current pursuit, not of any one coin, and
   because the two screens that must honour it are not otherwise related. Written only
   by setCycleBandWindow (see below); read only by the two cfg.screen getters. */
let _bandWindow = null;

export const cfg = {
  rpc: process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com",
  birdeyeKey: process.env.BIRDEYE_API_KEY || "",

  equityUsd: num("DESK_EQUITY_USD", 10000),
  maxRiskPct: num("DESK_MAX_RISK_PCT", 1.0),
  maxBookRiskPct: num("DESK_MAX_BOOK_RISK_PCT", 4.0),
  maxCandidates: num("DESK_MAX_CANDIDATES", 8),
  /* THE SIZE THE EXIT PROBE MEASURES AT — and it must resemble the size actually
   * traded, or the desk vetoes coins on a cost nobody pays. It has come down three
   * times: $500 (chosen against the $10,000 notional book above), $200, $75, now $15.
   *
   * $75 was the binding constraint on publishing anything. This number is not only the
   * probe size: risk-rails.js makes it an ABSOLUTE ceiling on position_size_usd ("no
   * evidence that a larger order can leave at the assumed stop"), and compliance.js
   * derives the minimum stop distance a coin must carry from the round trip measured
   * AT IT. Measured 2026-09-07: at $75 the derived floor is ~11.93%, while the desk's
   * own median published stop across its 55 calls is 11.5% — the desk was below its
   * own bar and candidates were being withheld as "edge_below_cost, stop_inside_costs".
   *
   * It was pricing an exit nobody was ever going to pay. The floor's configured
   * fixed_sol is 0.4 SOL (~$41 at SOL $103), the executor's HARD ceiling is
   * OPERATOR_MAX.maxSolPerTrade = 0.05 SOL (~$5.17), and the last two live buys were
   * 0.0175 SOL (~$1.81) and 0.021 SOL (~$2.20). The desk demanded a stop wide enough
   * to survive exiting $75 while the bot exits under $2.
   *
   * $15 is chosen off the executor's hard ceiling, which is the only number that
   * cannot be exceeded: 0.05 SOL is ~$5.17 today, so $15 leaves roughly 3x headroom
   * for SOL appreciation and is still 5x smaller than today's figure. It is not a
   * measurement of anything — it is a ceiling with margin — so it stays env-overridable
   * and moves the day the executor's ceiling moves.
   *
   * THE INVARIANT THAT MAKES LOWERING IT SAFE lives in copy.js: no delivery may be
   * larger than the notional the probe proved exitable. Lowering the probe alone would
   * leave the desk authorising a 0.4 SOL delivery it only proved it could exit $15 of. */
targetSizeUsd: num("DESK_TARGET_SIZE_USD", 15),

  /* WHAT ONE SOL IS WORTH, for the one job that needs it synchronously: converting the
   * probed notional above into the SOL cap on a delivery (copy.js). decide() is
   * deterministic per floor per call and must cost nothing, so it cannot call a price
   * API — it prefers the SOL price the desk's own executor recorded on its last real
   * chain fill and falls back to this. $103 is the price measured 2026-09-07, the same
   * anchor the $15 above is derived from (0.05 SOL = $5.17). Understating SOL widens
   * the SOL cap, which is the unsafe direction, so this is the number to update when
   * SOL moves and no fill has been reported in a while. */
  solUsdFallback: num("DESK_SOL_USD_FALLBACK", 103),

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
    /* $5k, the floor of the nano sleeve. It sat at $10k while the nano band starts at
     * $5k, so the smallest half of the band the owner asked for was refused as
     * "too_small" by a number nobody had moved. */
    _minMarketCapUsd: num("DESK_MIN_MCAP_USD", 5_000),
    /* THE ONLY TWO NUMBERS THE QUOTA LADDER IS ALLOWED TO MOVE.
     *
     * They are getters, not constants, because L4 of the escalation ladder widens the
     * market-cap BAND — and the band is an OPPORTUNITY judgement, stated as such where
     * it is checked: "a coin this size is perfectly tradeable, it simply is not the
     * trade this desk exists to find" (evidence.js). Nothing safety-shaped hides behind
     * these: the liquidity, volume, participation and age floors are per-coin and come
     * from floorsFor(mcap) — widening the hunt band changes WHICH coins are looked at,
     * never what any one of them has to clear. A $40m coin admitted at L4 is still
     * screened against very_high's floors, still exit-probed, still holder-checked.
     *
     * A getter rather than an argument because the paid screen (evidence.js) and the
     * free pre-screen (penthouse.js) both read cfg.screen and neither belongs to this
     * change. The override is set by exactly one writer — the open cycle, through
     * setCycleBandWindow — and cleared in a finally, so it can never outlive the pass
     * that widened it. */
    get minMarketCapUsd() { return _bandWindow?.mcapMin ?? this._minMarketCapUsd; },
    set minMarketCapUsd(v) { this._minMarketCapUsd = v; },
    /* $10m, matching the top of the very-high sleeve (categories.js). The two numbers
     * are one taxonomy: a ceiling above the last sleeve creates calls no floor can
     * receive, which is the exact failure the sleeve test was written to catch. */
    _maxMarketCapUsd: num("DESK_MAX_MCAP_USD", 10_000_000),
    get maxMarketCapUsd() { return _bandWindow?.mcapMax ?? this._maxMarketCapUsd; },
    set maxMarketCapUsd(v) { this._maxMarketCapUsd = v; },
  },

  // Slippage the desk refuses to accept on a round trip at target size.
  maxRoundTripSlippagePct: num("DESK_MAX_RT_SLIPPAGE", 8),

    /* THE STOP THAT COSTS ALONE WOULD TRIGGER.
     *
     * A stop closer to entry than the cost of getting in and out is not a stop; it is a
     * guaranteed exit charged to the book. The executor refuses those before signing,
     * and on 2026-09-03 it refused four consecutive live calls for exactly this —
     * HeeHaw, TOAD and USWS carried stops 5% to 6.5% below entry against a conservative
     * round-trip cost of about 9%. The desk was authoring trades its own bot could
     * prove were already lost.
     *
     * The number: the executor applies its slippage tolerance to BOTH legs
     * (1 - 0.97^2 = 5.91% at 300bps), adds a worst-case network fee near 2%, and pump.fun
     * itself takes about 1.25% a side on the small bands. Round to a floor of 12%, which
     * clears all three with room for the measured round trip on top. */
    /* The absolute floor, used when a coin's round trip could not be measured. The
       real floor is derived per coin in compliance.js from the executor's own guard. */
    minStopDistancePct: num("DESK_MIN_STOP_DISTANCE_PCT", 12),
    /* Mirrors of the executor's cost model, so the desk refuses exactly what the bot
       would refuse — no more and no less.
       executorWorstFeeRatio was 0.057, the fee share of a conviction-shrunk 0.0175 SOL
       position. That is no longer reachable: the executor's fee floor holds a position
       at or above the size where the round trip costs maxFeeShareOfTrade, so 2.5% IS
       the worst case now. Leaving it at 5.7% made the desk refuse calls its own bot
       would have taken — a sweep found 8.5% to 9.5% stops on clean coins blocked at
       publish time and tradeable in the executor. Refusing a call the bot wanted is the
       same waste as publishing one it will not take, pointed the other way. */
    executorSlippageBps: num("EXECUTOR_SLIPPAGE_BPS", 300),
    /* The executor caps the round trip's fees at this share of the STOP DISTANCE, not
       of the position — a wide stop can carry more fee in absolute terms and still be
       worth taking. The desk assumes the same shape so the two never disagree. */
    executorMaxFeeShareOfStop: Number(process.env.EXECUTOR_MAX_FEE_SHARE_OF_STOP || 0.25),

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
  /* THE SEATS NOW ASK MEMECOIN QUESTIONS, SO THE WEIGHTS FOLLOW THEM.
   *
   * forensics stopped being the mint/freeze seat — those are deterministic kills in the
   * free screen now, and a paid model re-checking a boolean is waste. What it asks
   * instead is who owns the float and would they sell it out from under you: bundling,
   * the middle of the book, and the creator's record. That is a harder question and a
   * more decisive one, so it holds its weight rather than losing it.
   *
   * liquidity keeps a small share because on this desk it mostly confirms what the
   * screen measured. It matters when a pool can be DRAINED, not when a whale would
   * move it — the bot trades $3 to $10. */
  weights: {
    narrative: 0.38,   // lore, trend, endorsement — on a memecoin this IS the asset
    forensics: 0.26,   // who owns the float, and have they rugged before
    flow: 0.24,        // a crowd, or a machine wearing one
    liquidity: 0.09,   // can it be exited at OUR size; the screen already measured it
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

/**
 * FLOORS THAT SCALE WITH THE COIN, because a flat one is a ban on small coins.
 *
 * Measured on a live sweep of 302: the micro band saw 60 coins and passed TWO. Forty-four
 * of the 58 deaths were `thin_liquidity` against a flat $12,000 floor — which asks a
 * $30k-cap coin for a liquidity-to-cap ratio of forty percent. No real micro-cap clears
 * that, so the owner's "at least 5 per category" was arithmetically impossible in the
 * band they most want, and the desk was quietly a large-cap desk wearing a memecoin
 * charter.
 *
 * The same shape of bug has bitten before: an ABSOLUTE step applied to a quantity that
 * spans two orders of magnitude prices the small end out entirely. Bands here run from
 * $10k to $20m — a 2000x range — so any single number is wrong at one end or the other.
 *
 * WHAT THE FLOOR IS ACTUALLY FOR decides where to put it. It is a cheap proxy for "can
 * our size get out", asked before the desk pays to measure the real thing. Round-trip
 * cost on a constant-product pool is about 4X/L, and the desk probes at $75 while the
 * executor trades $3-$10:
 *
 *     L = $5,000   $75 probe -> 6.0%   (inside the 8% ceiling)   $10 clip -> 0.8%
 *     L = $3,000   $75 probe -> 10.0%  (over the ceiling)
 *
 * So ~$5k is where the probe itself stops clearing, and that is the honest floor for a
 * micro-cap — not $12k.
 *
 * The floors RISE with market cap on purpose. A $30k coin with $5k of liquidity is
 * ordinary; a $15m coin with $5k of liquidity is a fiction, and the suspicion belongs to
 * the RATIO, which maxFdvToLiqRatio already catches independently.
 *
 * NONE OF THIS TOUCHES SAFETY. The measured exit probe (cannot_exit, round-trip loss
 * against maxRoundTripSlippagePct) is unchanged and absolute, as are honeypot mechanics,
 * live mint and freeze authority, and the unverified-is-not-safe rule. This lowers a
 * PROXY so that more small coins reach the real test; it does not lower the real test.
 */
/* One row per sleeve, and `ageH` is the youngest the desk will look at in that band.
 *
 * The age floor used to be one flat 1.5 hours for everything, which is a coherent rule
 * for a desk hunting day-old coins and an incoherent one for a desk asked to trade a
 * $9k coin inside thirty minutes: it refused, twice over, the exact population the
 * nano and micro sleeves exist for. It is now the band's own number. The larger bands
 * keep a real floor — a $5m coin an hour old is a different kind of claim.
 *
 * `vol` and `txns` are 24-HOUR floors. A coin four minutes old has no 24-hour history
 * and never will in time to matter, so a coin inside its band's hunt window is judged
 * on its minute tape instead (see wouldSurviveScreen). Neither path touches the real
 * test: the measured Jupiter round-trip, live mint and freeze authority, holder
 * concentration and honeypot mechanics are unchanged and absolute. */
import { bandForMarketCap } from "./bands.js";

export const BAND_FLOORS = {
  nano:      { liq: 2_000,  vol: 1_500,  txns: 10, ageH: 0.02 },  // $5k-$20k, from a minute old
  micro:     { liq: 4_000,  vol: 3_000,  txns: 20, ageH: 0.05 },  // $20k-$60k
  low:       { liq: 5_000,  vol: 4_000,  txns: 25, ageH: 0.25 },  // $60k-$100k
  medium:    { liq: 8_000,  vol: 8_000,  txns: 40, ageH: 0.5 },   // $100k-$500k
  high:      { liq: 12_000, vol: 12_000, txns: 60, ageH: 1 },     // $500k-$1m
  very_high: { liq: 15_000, vol: 15_000, txns: 60, ageH: 1.5 },   // $1m-$10m
};

/**
 * The floors that apply to THIS coin.
 *
 * An unreadable market cap falls back to the flat configured floors — the strictest
 * reading — because an unknown number must never be handed the most permissive band.
 * That is the same rule the rest of the desk follows everywhere else.
 */
export function floorsFor(mcap) {
  const flat = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, ageH: cfg.screen.minPairAgeHours };
  if (mcap == null || !(mcap > 0)) return flat;
  /* ONE TAXONOMY. These boundaries were hardcoded here and drifted a full rung out of
     step with CAP_BANDS on 2026-09-03: the screen called a $250k coin "low" while the
     desk called it "medium" and the sleeves disagreed with both. The bands are defined
     in exactly one place now, and this reads them. */
  const band = bandForMarketCap(mcap);
  return band ? BAND_FLOORS[band] : flat;
}

/** The RPC URL embeds an API key. Never print it raw — mask it wherever it is shown. */
export const maskRpc = (u = cfg.rpc) =>
  String(u).replace(/([?&]api-key=)[^&]+/i, "$1***").replace(/\/\/([^@/]+:)[^@]+@/, "//$1***@");

// Well-known mints used as quote assets / routing anchors.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE COHORT CYCLE AND ITS ESCALATION LADDER
 *
 * The owner's instruction is that every cycle produces at least three published calls
 * "at any cost, by any means", and that a new cycle begins once that cycle's calls have
 * closed. The whole shape of what follows comes from ONE measurement, and it is worth
 * writing down where the knobs live rather than in a commit message:
 *
 *   Of the last 100 kills, ~60 are safety MECHANICS rather than opinions — 18
 *   cannot_exit (the round-trip probe PROVED the position cannot be sold), 16
 *   serial_deployer, 9 post_migration_dump, 5 holder_concentration, 4 deployer-has-
 *   rugged, 4 thin_liquidity, 2 mintable, 2 freezable, 1 wash_suspect.
 *
 * Filling a quota out of that pool does not produce three trades. It produces three
 * bags — and an unsellable bag fails the quota's own purpose, which is to have the desk
 * actually TRADING. So "by any means" is implemented as MORE EFFORT and RELAXED
 * JUDGEMENT, on a ladder that is recorded on every call, and the safety floor is never
 * crossed at any level for any quota. There is no level 5.
 *
 * L0 normal      — today's bars, nothing relaxed.
 * L1 widen       — more candidates, more launchpads, a wider search window. PURE
 *                  EFFORT: the cost goes up and not one standard moves.
 * L2 conviction  — accept a lower conviction score, down to a floor that stays above
 *                  the "would not trade this myself" line.
 * L3 narrative   — accept a coin the X read calls MANUFACTURED, provided every safety
 *                  gate passed. This is the largest single judgement gate and it is a
 *                  model's opinion about attention, not a mechanic that loses money.
 *                  The other arm of that same seat — "this deployer's own account has
 *                  rugged before" — is a FACT and stays absolute at every level.
 * L4 band        — widen the market-cap band and the age window of the SEARCH.
 *
 * Read `minAgeFloorMultiplier` below before assuming "age window" means the screen's
 * minimum pair age. It does not, deliberately.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

export const MAX_ESCALATION_LEVEL = 4;

export const CYCLE = {
  /** Three, per the owner. The cycle publishes what it found if it cannot reach it. */
  quota: num("CYCLE_CALL_QUOTA", 3),
  /* THE DEADLOCK GUARD. A cohort holds the gate shut until every call it published is
     closed — so one position that never closes stops the entire desk, permanently, and
     silently. Past this age the cycle is force-closed and the next opens. Its still-open
     calls do NOT vanish: they stay live and keep being monitored and exited by the
     normal lanes (monitorCalls, the 45s fast lane, the executor's mirror). They simply
     stop holding the gate. */
  maxAgeMs: num("CYCLE_MAX_AGE_MS", 6 * 3600_000),
  /** Set CYCLE_COHORT=0 to disable the cohort gate entirely and restore the exact
      pre-cohort behaviour of every publishing lane. */
  enabled: process.env.CYCLE_COHORT !== "0",

  /* THE CONVICTION BAR THE LADDER LOWERS. Tier is mandate.js's: 4 the CEO approved it,
     3 the CEO held it, 2 the PM proposed it, 1 the PM wanted a trigger first.
     L0/L1 ask for a proposal the PM actually made. */
  minTier: num("CYCLE_MIN_TIER", 2),
  minConviction: num("CYCLE_MIN_CONVICTION", 55),
  /* THE FLOOR AT L2 AND BELOW-NOTHING. "Above the line where I would not trade this
     myself" is the owner's phrasing; 35 with the PM's own WATCH behind it is a coin the
     team studied and wanted one more trigger on, which is a maybe — not a no. A PM PASS
     and a CEO DECLINE are the team's explicit no and stay refused at EVERY level, here
     as in mandate.js: ranking the team's maybes is not overruling the team. */
  floorTier: num("CYCLE_FLOOR_TIER", 1),
  floorConviction: num("CYCLE_FLOOR_CONVICTION", 35),
};

/**
 * What the desk is allowed to do differently at each level.
 *
 * Every field here is EFFORT or JUDGEMENT. No field of this object can relax a safety
 * gate, because no safety gate reads it — the classification lives in calls.js
 * (SAFETY_GATES) and the veto is applied before any of this is consulted.
 */
export function escalationPlan(level = 0) {
  const L = Math.max(0, Math.min(MAX_ESCALATION_LEVEL, Number(level) || 0));
  const relaxations = [];
  const plan = {
    level: L,
    label: ["normal", "widen", "conviction", "narrative", "band"][L],
    /* EFFORT (L1+). Multipliers on how many coins are looked at and how long the
       cycle is allowed to spend looking. The daily money brake in llm.js and the
       per-cycle budget are NOT touched by any of this — effort can buy more looks, it
       cannot buy past the money ceiling. */
    workupMultiplier: 1,
    perCellMultiplier: 1,
    huntMultiplier: 1,
    /** L1 stops the cycle skipping coins simply because a launchpad was unfamiliar. */
    allLaunchpads: false,
    /** JUDGEMENT (L2+). */
    minTier: CYCLE.minTier,
    minConviction: CYCLE.minConviction,
    /** JUDGEMENT (L3). The X read's "manufactured" verdict stops ending the workup.
        Its serial_rugger arm is a FACT and is never covered by this. */
    acceptManufacturedNarrative: false,
    /** OPPORTUNITY (L4). The band the SEARCH considers. Per-coin floors are unmoved. */
    mcapMin: null,
    mcapMax: null,
    /** L4 widens the search's age CEILING — it will look at older coins. It never
        lowers the minimum-age floor, which is why this is a multiplier ≥ 1 on the
        ceiling and there is deliberately no knob for the floor. See openIssues:
        `too_new` is classified SAFETY because the research behind it ("rugs express
        inside the first hour") is a claim about losing money, not about opportunity,
        and an ambiguous gate is classified SAFETY by rule. */
    searchAgeCeilingMultiplier: 1,
    minAgeFloorMultiplier: 1,        // ALWAYS 1. Present so the invariant is testable.
    relaxations,
  };

  if (L >= 1) {
    plan.workupMultiplier = num("CYCLE_L1_WORKUP_X", 2);
    plan.perCellMultiplier = num("CYCLE_L1_PERCELL_X", 2);
    plan.huntMultiplier = num("CYCLE_L1_HUNT_X", 2);
    plan.allLaunchpads = true;
    relaxations.push("L1: more candidates, every launchpad, a wider sweep — effort only, no standard moved");
  }
  if (L >= 2) {
    plan.minTier = CYCLE.floorTier;
    plan.minConviction = CYCLE.floorConviction;
    relaxations.push(`L2: conviction floor lowered to ${plan.minConviction} (tier ${plan.minTier}) — the cycle was short of quota`);
  }
  if (L >= 3) {
    plan.acceptManufacturedNarrative = true;
    relaxations.push("L3: accepted a coin the X read called the story manufactured — every safety gate still passed");
  }
  if (L >= 4) {
    plan.mcapMin = num("CYCLE_L4_MCAP_MIN", 1_000);
    plan.mcapMax = num("CYCLE_L4_MCAP_MAX", 40_000_000);
    plan.searchAgeCeilingMultiplier = num("CYCLE_L4_AGE_X", 4);
    relaxations.push(`L4: market-cap band widened to $${plan.mcapMin.toLocaleString()}-$${plan.mcapMax.toLocaleString()} and the search's age ceiling to ${plan.searchAgeCeilingMultiplier}x — the minimum-age SAFETY floor is unchanged`);
  }
  return plan;
}

/**
 * Widen (or clear) the band window the two screens read. ONE writer: the cycle, around
 * its own pass, in a try/finally. Pass null to clear.
 *
 * Deliberately not exported as a mutable variable: a value that can be widened from
 * anywhere is a safety floor that can be widened from anywhere, and this desk has been
 * bitten once already by a relaxation nobody could point at afterwards.
 */
export function setCycleBandWindow(win) {
  _bandWindow = win && (win.mcapMin != null || win.mcapMax != null)
    ? { mcapMin: win.mcapMin ?? null, mcapMax: win.mcapMax ?? null } : null;
  return _bandWindow;
}
export const cycleBandWindow = () => (_bandWindow ? { ..._bandWindow } : null);
