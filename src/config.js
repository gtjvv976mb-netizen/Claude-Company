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
/* An effort the provider does not know is a 400 that reads as a seat failure, so an env
   A/B only accepts the ladder lib/llm.js sizes max_tokens for. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const effortEnv = (k, d) => (EFFORTS.has(process.env[k]) ? process.env[k] : d);

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
  /* `maxBookRiskPct` (DESK_MAX_BOOK_RISK_PCT) WAS HERE and is deleted (owner, 2026-09-07).
   * It was the ceiling on the desk's PAPER book, and risk-rails.js clamped a new idea's
   * size to what was left under it. Reproduced: four live calls exhausted it, the size
   * became 0, and a clean coin was refused at `zero_authorized_size` — a SAFETY gate, so
   * no escalation level could reach past it. The desk was declining to NAME a coin on a
   * balance judgment about money it does not hold. The bot keeps its own book heat, its
   * own rolling deploy cap and its own spendable balance, all against the wallet that
   * signs (executor/strategy.mjs:308-311), which is the only place the number is real. */
  maxCandidates: num("DESK_MAX_CANDIDATES", 24),
  /* `targetSizeUsd` (DESK_TARGET_SIZE_USD) WAS HERE, and its removal is the point of
   * the 2026-09-07 change rather than a side effect of it.
   *
   * It began as "the size the exit probe measures at" and it never stayed that. By the
   * end it was: an ABSOLUTE ceiling on position_size_usd in risk-rails.js; the notional
   * behind compliance.js's size_exceeds_exit_probe veto; the base of the per-coin
   * minimum stop distance (stop_inside_costs) and of the 5x-cost edge floor
   * (edge_below_cost); the SOL cap on every delivery in copy.js; and the amount the
   * `cannot_exit` screen ran at. One config number, invented by the desk, quietly
   * deciding how much a stranger's bot was allowed to buy and which coins it was
   * allowed to hear about.
   *
   * It came down three times chasing the problem — $500, $200, $75, $15 — which is the
   * tell. Every reduction made the vetoes slightly less wrong and none of them made the
   * desk's number equal the bot's, because the desk cannot know the bot's: the bot
   * reads FIXED_SOL and MAX_SOL_PER_TRADE from the operator's own environment. At $75
   * it refused a coin for "round-trip loss 8.08% > ceiling 8%" while that bot's real
   * clip was about $2.
   *
   * Every consumer is deleted. The route probe that still needs an amount to quote gets
   * one from src/probe-size.js — measured off a live bot's declared cap, with
   * ROUTE_PROBE_FALLBACK_USD as the stated constant when no bot is reporting — and no
   * judgment anywhere reads it. It is deliberately NOT an env knob any more: as
   * DESK_TARGET_SIZE_USD it was a standing invitation to write another veto against it.
   *
   * `equityUsd` and `maxRiskPct` above survive because they are the desk's own paper
   * book — what it records that it thought an idea was worth — and nothing derived from
   * them reaches a wallet (copy.js publishes no size; executor/strategy.mjs:247 and
   * executor/poller.mjs:1192 refuse the fields that used to carry one). */

  /* WHAT ONE SOL IS WORTH, for the one job that still needs it synchronously: turning
   * a bot's declared per-trade cap (SOL) into the USD amount the route probe quotes at
   * (probe-size.js). It prefers the SOL price the desk's own executor recorded on its
   * last real chain fill and falls back to this. $103 is the price measured 2026-09-07.
   *
   * There is no longer an unsafe direction here. This used to widen or narrow a SOL cap
   * on a delivery, so an understated price was dangerous; deliveries carry no size now,
   * and the only consequence of a stale figure is that a route test is quoted at a
   * slightly different amount than intended, which does not change whether a route
   * exists. Still worth keeping current so the report says something true. */
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
     * At $12,000 a real $3.40 clip round-trips at 0.11% and the $75 probe at 2.5% —
     * which is the whole 2026-09-07 lesson in one line: the same pool is 23x cheaper to
     * leave at the size actually traded. The pool is still thin enough to be drained by
     * a determined seller, which is what liq_collapse, holder concentration and the
     * freeze-authority check are for. Those did not move and must not. (`cannot_exit`
     * was named here as a fourth; it was the cost ceiling, and it is deleted — the bot
     * measures that at its own size, executor/jupiter.mjs:1341-1350.)
     *
     * Note this is DEPTH, not market cap: a $1m-cap coin is a claim about price x
     * supply, while liquidity is the money actually in the pool to sell into. They
     * are routinely an order of magnitude apart. */
/* OWNER OVERRIDE 2026-09-07: THE FIRST GOAL IS THAT COINS GET PUBLISHED AT ALL.
     *
     * Measured before this change: of 500 workups, 4 reached PASS and 15 WATCH — a 3.8%
     * positive rate — against a quota of three calls from a 8-24 coin pass. The free
     * screen alone killed ~93% (157 considered, 11 viable). Three cycles in a row walked
     * the whole L0-L4 ladder and published nothing.
     *
     * Every floor below is an OPPORTUNITY or QUALITY judgement, not a claim about
     * whether a position can be left. The liquidity floor is the one that could be
     * either, and 12000 was calibrated for a much larger clip: the bot trades 0.05 SOL,
     * about $5, so $2,500 of pool depth is still ~500x the order. The gates that decide
     * whether a coin can be SOLD AT ALL — freezable, seizable, transfer_hook,
     * cannot_exit, unverified_exit, no_stop — are SAFETY class and are untouched here
     * and at every rung of the ladder.
     *
     * The owner's instruction was explicit and repeated: allow more coins through,
     * profitable or not, and adjust from there. */
    minLiquidityUsd: num("DESK_MIN_LIQUIDITY_USD", 2500),
    // 24h here quietly strangled the sniper lane: the free screen killed every
    // coin the ignition path is FOR. The research's floor is one hour past
    // migration (rugs express inside the first hour); 1.5h keeps a margin.
    minPairAgeHours: num("DESK_MIN_PAIR_AGE_HOURS", 0.25),
    minVolume24hUsd: num("DESK_MIN_VOL24_USD", 1000),
    maxVolToLiqRatio: num("DESK_MAX_VOL_LIQ", 250),  // above this, suspect wash
    minTxns24h: num("DESK_MIN_TXNS24", 10),
    maxFdvToLiqRatio: num("DESK_MAX_FDV_LIQ", 3000), // thin float propping a fat FDV

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
    _minMarketCapUsd: num("DESK_MIN_MCAP_USD", 1_000),
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
    _maxMarketCapUsd: num("DESK_MAX_MCAP_USD", 50_000_000),
    get maxMarketCapUsd() { return _bandWindow?.mcapMax ?? this._maxMarketCapUsd; },
    set maxMarketCapUsd(v) { this._maxMarketCapUsd = v; },
  },

  /* `maxRoundTripSlippagePct` (DESK_MAX_RT_SLIPPAGE) WAS HERE — the round-trip cost
   * ceiling behind the `cannot_exit` screen kill, risk-rails' mechanical zero and the
   * red team's confirmable "exit_failure" fact. Removed 2026-09-07 with the rest of the
   * desk's money judgments.
   *
   * It killed 12 of the desk's last 100 coins with nothing else against them, 11 of
   * them between 8.0% and 9.2% against a ceiling of 8% — marginal calls decided by a
   * cost measured at $75 for a bot that trades about $2. The same ceiling still exists
   * and still binds, in the process that knows the size: executor/jupiter.mjs:1341-1350
   * (`maxEntryRoundTripLossPct`, quoted at the bot's own amountRaw) and
   * executor/poller.mjs:1234-1253 (that measured loss plus worst-case fees against the
   * authored stop). Nothing was made unsafe; the judgment was moved to where its
   * inputs are real. */

    /* THREE COST MIRRORS WERE HERE — `minStopDistancePct` (DESK_MIN_STOP_DISTANCE_PCT),
     * `executorSlippageBps` (EXECUTOR_SLIPPAGE_BPS) and `executorMaxFeeShareOfStop`
     * (EXECUTOR_MAX_FEE_SHARE_OF_STOP) — and the word "mirrors" was the confession.
     *
     * They existed so the desk could reproduce the executor's pre-signing cost guard at
     * publish time and refuse "exactly what the bot would refuse — no more and no less".
     * That equality was never achievable, because the guard's answer depends on the
     * order size and the desk's copy ran on a size the desk invented. The history in
     * this very block records the desk chasing it: executorWorstFeeRatio revised from
     * 5.7% to 2.5% after a sweep found the desk blocking 8.5%-9.5% stops the bot would
     * happily have taken. That is a duplicate being tuned toward an original it cannot
     * reach.
     *
     * The original: executor/strategy.mjs:115 (maxFeeShareOfStop), :232-234 (the fee
     * floor derived from the REAL fee reserve and the REAL stop), and
     * executor/poller.mjs:1234-1253 (the slippage haircut and worst-case fee ratio
     * computed from `preliminaryAmountRaw`, the lamports about to be spent). The desk
     * now authors the honest invalidation level and says nothing about what it costs. */

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
  /* TECHNICAL IS RETIRED, AND ITS 0.03 IS RE-NORMALISED ACROSS THE FOUR THAT REMAIN.
   *
   * Live 24h: 31 Technical calls, $0.67 (7d $8.45), 0 kills — and its brief carried no
   * KILL clause at all, so it could never have ended a workup; at 0.03, on a seat told
   * to keep its own confidence near zero, it could not move a composite either. A seat
   * that cannot kill and barely weighs is a bill, not an opinion. "Zero would mean
   * never hearing it" (above) no longer holds: the location question it kept — already
   * vertical, a knife still falling — is four numbers on the bundle, pair.priceChange,
   * that every remaining seat reads. The 0.03 goes back proportionally (0.38/0.97 →
   * 0.39, 0.26/0.97 → 0.27, 0.24/0.97 → 0.25, 0.09/0.97 → 0.09) so the table still sums
   * to 1.00 and the order of the seats is untouched. composite() normalises by the
   * weights present, so this is bookkeeping for the reader, not a change in how a
   * score is formed. */
  weights: {
    narrative: 0.39,   // lore, trend, endorsement — on a memecoin this IS the asset
    forensics: 0.27,   // who owns the float, and have they rugged before
    flow: 0.25,        // a crowd, or a machine wearing one
    liquidity: 0.09,   // is there a market, and can a way out be quoted; the screen already measured it
  },

  // Defaults are the economical tier; env vars UPGRADE a seat, they no longer rescue
  // the bill. Measured 2026-08-29: all-Opus ran $1.29-1.44 a workup, and three seats
  // were most of it — Red Team thinking at xhigh (31% of all spend by itself),
  // Narrative dragging ~41k tokens of raw web results in per run, and five analysts
  // filling bounded schemas on the priciest model in the house. Judgment seats keep
  // Opus; evidence-shaped verdicts do not need it.
  /* TWO SEATS SIT ON HAIKU 4.5 ($1/$5 per MTok against Sonnet 5's $2/$10), each on
   * what it is actually asked to author:
   *   liquidity — a FINDINGS seat. Its two authorised kills (the LIQUIDITY brief in
   *               agents/analysts.js) are the free screen's own thin_liquidity and
   *               unverified_exit, applied before it is ever paid; what it adds is the
   *               shape of the book. Live 24h: 31 calls, $0.95 (7d $13.08), 0 kills.
   *   execution — compliance.js `stop_mismatch` forces its stop equal to Risk's, so it
   *               authors the entry zone and the targets and nothing else. Live 24h:
   *               11 calls, $0.48 (7d $6.26).
   * Haiku 4.5 rejects output_config.effort, so the effort rows below are inert for both
   * (lib/llm.js drops the field) and remain only as the ledger's label. Red Team keeps
   * Opus: its verdict feeds redteam_refuted_unanswered, a SAFETY gate, and the seat
   * scorecard is empty, so nothing measured yet licenses a cut there. */
  models: {
    scout:      process.env.DESK_MODEL_SCOUT      || "claude-haiku-4-5",
    forensics:  process.env.DESK_MODEL_FORENSICS  || "claude-sonnet-5",
    liquidity:  process.env.DESK_MODEL_LIQUIDITY  || "claude-haiku-4-5",
    flow:       process.env.DESK_MODEL_FLOW       || "claude-sonnet-5",
    narrative:  process.env.DESK_MODEL_NARRATIVE  || "claude-sonnet-5",
    redteam:    process.env.DESK_MODEL_REDTEAM    || "claude-opus-5",
    risk:       process.env.DESK_MODEL_RISK       || "claude-sonnet-5",
    pm:         process.env.DESK_MODEL_PM         || "claude-opus-5",
    execution:  process.env.DESK_MODEL_EXECUTION  || "claude-haiku-4-5",
  },

  effort: {
    scout: "low",
    forensics: "high",
    liquidity: "medium",
    flow: "high",
    narrative: "medium",
    redteam: effortEnv("DESK_EFFORT_REDTEAM", "high"),
                        // the adversary keeps the strongest MODEL; xhigh thinking alone
                        // was ~14k output tokens a run and a third of the whole bill.
                        // DESK_EFFORT_REDTEAM is an A/B handle only (medium is about
                        // -$0.14 a call on the live 7d, $0.336 median): the default is
                        // not cut, because the verdict feeds a SAFETY gate and the seat
                        // scorecard has nothing yet to show what a cheaper one costs.
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
 * NONE OF THIS TOUCHES SAFETY. Honeypot mechanics, live mint and freeze authority, and
 * the unverified-is-not-safe rule are unchanged and absolute, and so is the route probe
 * behind unverified_exit — a token nobody can quote a sell for is refused. This lowers a
 * PROXY so that more small coins reach the real test; it does not lower the real test.
 * (The cost half of that probe — `cannot_exit` against maxRoundTripSlippagePct — was
 * removed 2026-09-07. It was never a safety test: it measured what leaving costs at a
 * notional the desk invented, and the bot measures it at the real one.)
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
 *   Of the last 100 kills, most are safety MECHANICS rather than opinions — 12
 *   serial_deployer, 15 post_migration_dump, 6 holder_concentration, 6 mintable,
 *   5 thin_liquidity, 4 deployer-has-rugged, 3 each freezable / seizable /
 *   transfer_hook / frozen_by_default / unverified_exit, 2 wash_suspect
 *   (re-counted 2026-09-07).
 *
 *   The old count led with "18 cannot_exit (the probe PROVED the position cannot be
 *   sold)". It proved no such thing. It proved a $75 order was expensive, for a bot
 *   trading about $2, and 12 of those 100 coins died on it with nothing else against
 *   them. The gate is gone and those 12 will now publish.
 *
 * Filling a quota out of that pool does not produce three trades. It produces three
 * bags — and an unsellable bag fails the quota's own purpose, which is to have the desk
 * actually TRADING. So "by any means" is implemented as MORE EFFORT and RELAXED
 * JUDGEMENT, on a ladder that is recorded on every call, and the safety floor is never
 * crossed at any level for any quota. There is no level 5.
 *
 * L0 normal      — today's bars, nothing relaxed.
 * L1 widen       — more candidates per category, more workups, a longer hunt. PURE
 *                  EFFORT: the cost goes up and not one standard moves. It does NOT
 *                  widen the launchpad — see `allLaunchpads`, removed 2026-09-07.
 * L2 conviction  — accept a lower conviction score, down to a floor that stays above
 *                  the "would not trade this myself" line.
 * L3 narrative   — accept a coin the X read calls MANUFACTURED, provided every safety
 *                  gate passed. This is the largest single judgement gate and it is a
 *                  model's opinion about attention, not a mechanic that loses money.
 *                  The other arm of that same seat — "this deployer's own account has
 *                  rugged before" — is a FACT and stays absolute at every level.
 * L4 band        — widen the market-cap band of the SEARCH. (An age-ceiling knob used
 *                  to be advertised here too; it moved nothing and was removed
 *                  2026-09-07 — see `searchAgeCeilingMultiplier` below.)
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
     L0/L1 USED TO ask for a proposal the PM actually made, and that excluded most of
     what this desk produces: measured over 500 workups, the positive verdicts are 4
     PASS (tier 2+) against 15 WATCH (tier 1), so a tier-2 bar discarded 79% of the
     desk's own positive opinions at the first two rungs — the same shape of defect as
     the conviction bar of 55, one field over. The floor at L2+ was already 1, so this
     only changes WHEN a WATCH becomes eligible, never WHETHER. A PM PASS and a CEO
     DECLINE remain the team's explicit no and are refused at every level (mandate.js).
     Owner set this on 2026-09-07 with the three-calls-per-cycle quota in force. */
  minTier: num("CYCLE_MIN_TIER", 1),
  /* CALIBRATED TO WHAT THIS DESK ACTUALLY SCORES, not to what reads like a high bar.
   *
   * It was 55, and 55 was unreachable: across all 58 calls the desk has ever published
   * the conviction scores run min 20, median 31, MAX 51. A bar of 55 sits above the
   * highest score the desk has ever assigned to anything, so an L0 or L1 pass could not
   * publish a call by arithmetic — which is exactly what cycle 19 did, running L0 and
   * L1 to completion, fully funded, and publishing nothing both times.
   *
   * The owner set these numbers on 2026-09-07 against that distribution, with the
   * quota mandate ("three published calls per cycle") explicitly in force. */
  minConviction: num("CYCLE_MIN_CONVICTION", 20),
  /* THE FLOOR AT L2 AND BELOW-NOTHING. "Above the line where I would not trade this
     myself" is the owner's phrasing. The floor was 35, above the median of 31: cycle 19
     refused four coins at 25, 28, 31 and 34 with the quota unmet, and HeeHaw — the only
     profitable trade this system has made — scored 28 and would have been refused too.
     A PM PASS and a CEO DECLINE are the team's explicit no and stay refused at EVERY
     level, here as in mandate.js: ranking the team's maybes is not overruling the team.
     Conviction is a JUDGMENT gate (calls.js GATE_CLASS); every SAFETY gate is untouched
     by this and by every rung of the ladder. */
  floorTier: num("CYCLE_FLOOR_TIER", 1),
  floorConviction: num("CYCLE_FLOOR_CONVICTION", 15),
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
    /* `allLaunchpads` WAS HERE, AND IT WAS A PROMISE THE DESK DID NOT KEEP.
     *
     * It was set true at L1 and read by NOTHING (measured 2026-09-07: no module in
     * src/ mentioned it), while the L1 note "every launchpad" was stamped onto every
     * call published at that level — 33 of 193 in one simulated run. The relaxations
     * are the desk's own account of what it did; one that describes work no module
     * does is a false record on a live call.
     *
     * It is REMOVED rather than wired, because wiring it would cross a standing owner
     * instruction. `selectAcrossBoard` at PENTHOUSE_PAD_QUOTA=1 (the default) filters
     * the general pass to pump.fun too — "the owner's instruction is to search and
     * trade pump.fun coins only" (categories.js) — so an L1 that looked off pump.fun
     * would be the ladder overruling the owner to chase a quota. Whether the quota may
     * do that is the owner's decision, not this file's. Until they say so, L1 buys more
     * looks at the pad they chose, and the note says only that. */
    /** JUDGEMENT (L2+). */
    minTier: CYCLE.minTier,
    minConviction: CYCLE.minConviction,
    /** JUDGEMENT (L3). The X read's "manufactured" verdict stops ending the workup.
        Its serial_rugger arm is a FACT and is never covered by this. */
    acceptManufacturedNarrative: false,
    /** OPPORTUNITY (L4). The band the SEARCH considers. Per-coin floors are unmoved. */
    mcapMin: null,
    mcapMax: null,
    /* `searchAgeCeilingMultiplier` WAS HERE, and it was inert for the same reason.
     *
     * It advertised "the search's age ceiling to 4x" at L4 and was read by nothing.
     * There is no age ceiling in the cycle's search to widen: sweep() applies none, and
     * the only ceiling in the file (48h) belongs to the 5-minute fresh lane, which the
     * ladder does not drive. The minimum-age floor was never in question — `too_new` is
     * classified SAFETY because the research behind it ("rugs express inside the first
     * hour") is a claim about losing money, and `minAgeFloorMultiplier` below stays at
     * 1 forever so that invariant remains testable. Removing the ceiling knob changes
     * no behaviour at all; it only stops a published call claiming a widening that
     * never happened. */
    minAgeFloorMultiplier: 1,        // ALWAYS 1. Present so the invariant is testable.
    relaxations,
  };

  if (L >= 1) {
    plan.workupMultiplier = num("CYCLE_L1_WORKUP_X", 2);
    plan.perCellMultiplier = num("CYCLE_L1_PERCELL_X", 2);
    plan.huntMultiplier = num("CYCLE_L1_HUNT_X", 2);
    relaxations.push(`L1: ${plan.workupMultiplier}x the workups, ${plan.perCellMultiplier}x the candidates ` +
      `per category and ${plan.huntMultiplier}x the hunt — effort only, no standard moved, same launchpad`);
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
    /* MUST STAY >= the base _maxMarketCapUsd or L4 NARROWS the search it claims to
       widen. When the owner raised the base ceiling to $50m on 2026-09-07 this was
       left at $40m, so installing the L4 window cut $10m off the top while every L4
       call carried the note "the SEARCH's market-cap band widened to $1,000-$40,000,000"
       — a false record of the kind this file's own comments warn about. */
    plan.mcapMax = num("CYCLE_L4_MCAP_MAX", 100_000_000);
    relaxations.push(`L4: the SEARCH's market-cap band widened to $${plan.mcapMin.toLocaleString()}-$${plan.mcapMax.toLocaleString()} — every per-coin floor, the minimum pair age included, is unchanged`);
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
