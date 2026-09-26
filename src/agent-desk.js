/**
 * THE PUBLIC AGENT PAGE, AND THE TWO THINGS BAGWORK GETS WRONG ON IT.
 *
 * bagworkagent.fun gives every agent a public page — a share link, a live feed, a level, a
 * strategy anyone can inspect. That is genuinely good and this desk copies it: a bot nobody can
 * look at is a bot nobody can check, and Claude Co has had no per-desk public view at all.
 *
 * Two things are deliberately different, and both come from measuring their system rather than
 * admiring it.
 *
 * ── 1. THEIR HEADLINE NUMBER ADDS FEES TO TRADING ─────────────────────────────────────
 *
 * Across 26 of their agents and 362 closed trades: trading -0.077 SOL, creator fees +14.515,
 * rewards +0.620. Their `pnlSol` sums all three, which is how their #1 agent — a bot that is
 * -0.105 on trading — displays +15.6 SOL. Nobody switches off a bot showing +15.6.
 *
 * So `agentView()` returns `tradingSol`, `feeSol` and `rewardSol` as three separate fields and
 * NO total. There is no function in this file that adds them. The test asserts the absence of
 * `total`, `pnl` and `net` by name, because that is the only way a rule like this survives a
 * year of edits by people who did not read this comment.
 *
 * ── 2. THEIR LEVELS PAY FOR ACTIVITY, WHICH SUBSIDISES LOSING ─────────────────────────
 *
 * This is the part worth thinking about rather than copying. Their levels advance on how much
 * an agent has DONE, and each level pays a reward. An agent therefore earns by trading, whether
 * or not the trading works — and their aggregate numbers show exactly that outcome: a 21% win
 * rate maintained across hundreds of trades, with the losses covered by fees and rewards. The
 * reward structure is not incidental to the losing; it is what makes the losing survivable.
 *
 * So levels here require BOTH: the activity, and a record that justifies it. A desk that has
 * closed a thousand trades and lost money on them stays at level 1 and is told why, in those
 * words. Rewards are bounded, booked as their own kind, and never paid for churn.
 *
 * Everything in this file is pure: no clock of its own, no database, no HTTP. The endpoints
 * hand it rows and it shapes them, so every rule here is testable without a server.
 */

/**
 * THE LADDER. Each rung needs the trades AND the record.
 *
 * `minClosed` is the activity BAGWORK would pay for on its own. `minRealizedSol` and
 * `minWinRate` are the part they leave out, and they are what stops this ladder paying a desk
 * to churn. The thresholds are deliberately modest — this is meant to be reachable by a desk
 * that is working, not a prize for a spectacular run.
 *
 * `rewardSol` is what reaching the rung pays, once, from the house. Bounded at every rung and
 * small on purpose: a reward large enough to be worth farming is a reward that will be farmed.
 */
export const AGENT_LEVELS = Object.freeze([
  Object.freeze({ level: 1, name: "Opened", minClosed: 0, minRealizedSol: null, minWinRate: null, rewardSol: 0 }),
  Object.freeze({ level: 2, name: "Working", minClosed: 10, minRealizedSol: 0, minWinRate: null, rewardSol: 0.01 }),
  Object.freeze({ level: 3, name: "Earning", minClosed: 25, minRealizedSol: 0.05, minWinRate: 0.3, rewardSol: 0.02 }),
  Object.freeze({ level: 4, name: "Consistent", minClosed: 60, minRealizedSol: 0.25, minWinRate: 0.35, rewardSol: 0.05 }),
  Object.freeze({ level: 5, name: "Proven", minClosed: 150, minRealizedSol: 1, minWinRate: 0.4, rewardSol: 0.1 }),
]);

export const MAX_AGENT_LEVEL = AGENT_LEVELS[AGENT_LEVELS.length - 1].level;

/** The reward kinds this desk books. Each is its own kind for the same reason fees are: a
 *  number that can be added to trading P&L eventually will be. */
export const REWARD_KINDS = Object.freeze(["level_up"]);

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** A finite number, or null. NEVER a coerced zero — `Number(null)` is 0, and this codebase has
 *  shipped that bug three times now: in a fee-vault read, in a spike measurement, and in the
 *  very summary written to keep fees and trading apart. The absent check comes first. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * What level a desk has earned, and what is holding it at that level.
 *
 * Returns the highest rung whose EVERY requirement is met — activity and record together. The
 * `blockedBy` field names the first unmet requirement of the next rung, in the desk's own
 * numbers, because "level 2" tells an operator nothing and "you need 25 closed trades, you have
 * 12" tells them everything.
 *
 * An UNKNOWN record does not advance a level. A desk whose realized result cannot be read is
 * not a desk that has proved anything, and treating unknown as zero would let a rung asking for
 * "at least 0 SOL" be cleared by a missing measurement.
 */
export function agentLevel({ closedTrades = null, realizedSol = null, winRate = null } = {}) {
  const closed = num(closedTrades);
  const realized = num(realizedSol);
  const rate = num(winRate);

  const meets = (rung) => {
    if (rung.minClosed > 0) {
      if (closed === null || closed < rung.minClosed) return { ok: false, field: "closedTrades", need: rung.minClosed, got: closed };
    }
    if (rung.minRealizedSol !== null) {
      if (realized === null) return { ok: false, field: "realizedSol", need: rung.minRealizedSol, got: null };
      if (realized < rung.minRealizedSol) return { ok: false, field: "realizedSol", need: rung.minRealizedSol, got: realized };
    }
    if (rung.minWinRate !== null) {
      if (rate === null) return { ok: false, field: "winRate", need: rung.minWinRate, got: null };
      if (rate < rung.minWinRate) return { ok: false, field: "winRate", need: rung.minWinRate, got: rate };
    }
    return { ok: true };
  };

  let earned = AGENT_LEVELS[0], blocked = null, next = null;
  for (const rung of AGENT_LEVELS) {
    const verdict = meets(rung);
    if (verdict.ok) { earned = rung; continue; }
    next = rung; blocked = verdict; break;
  }

  const say = (b) => {
    if (!b) return null;
    const got = b.got === null ? "not measured" : (b.field === "winRate" ? `${Math.round(b.got * 100)}%` : String(b.got));
    const need = b.field === "winRate" ? `${Math.round(b.need * 100)}%` : String(b.need);
    const label = b.field === "closedTrades" ? "closed trades"
      : b.field === "realizedSol" ? "realized SOL from trading" : "win rate";
    return `needs ${need} ${label}, has ${got}`;
  };

  return Object.freeze({
    level: earned.level,
    name: earned.name,
    nextLevel: next ? next.level : null,
    nextName: next ? next.name : null,
    nextRewardSol: next ? next.rewardSol : null,
    blockedBy: blocked ? blocked.field : null,
    blockedReason: say(blocked),
    /* THE SENTENCE THAT IS THE WHOLE POINT. A desk that has done the work and lost the money is
       told that in those words rather than being levelled up for the work. */
    note: blocked && blocked.field !== "closedTrades"
      ? "this level is held by the RECORD, not by the amount of work: a desk that trades more "
        + "without earning more does not advance here, because a ladder that pays for activity "
        + "pays for losing"
      : null,
  });
}

/** What reaching a level pays, once. Unknown levels pay nothing rather than throwing: a reward
 *  table consulted with a bad argument must not be able to invent money. */
export function levelReward(level) {
  const rung = AGENT_LEVELS.find((r) => r.level === num(level));
  return rung ? rung.rewardSol : 0;
}

/**
 * The rewards a desk is owed but has not been paid, given the levels it has reached and the
 * reward rows already booked.
 *
 * IDEMPOTENT BY CONSTRUCTION. A level's reward is keyed by `level`, so replaying this function
 * against a book that already contains the payment yields nothing — which matters because this
 * will be called on every page load and a reward that pays twice is a reward that pays forever.
 */
export function rewardsOwed({ level = 1, paidRows = [] } = {}) {
  const reached = num(level) ?? 1;
  const paid = new Set();
  for (const r of Array.isArray(paidRows) ? paidRows : []) {
    if (!isPlainObject(r) || r.kind !== "level_up") continue;
    const l = num(r.level);
    if (l !== null) paid.add(l);
  }
  const owed = [];
  for (const rung of AGENT_LEVELS) {
    if (rung.level > reached) break;
    if (rung.rewardSol > 0 && !paid.has(rung.level))
      owed.push(Object.freeze({ kind: "level_up", level: rung.level, name: rung.name, sol: rung.rewardSol }));
  }
  return Object.freeze(owed);
}

/* ── THE STRATEGY BUILDER ───────────────────────────────────────────────────────────────
 *
 * BAGWORK let an owner save a custom strategy: thresholds, caps, timings. Copied, with one
 * change that matters more than the feature.
 *
 * THEIRS ACCEPTS WHATEVER IT IS GIVEN. A saved strategy naming a parameter their engine does not
 * read is stored, displayed back, and silently does nothing — so an owner tunes a number for a
 * week and watches a bot that never saw it. This desk has already been bitten by precisely that
 * shape, from the other end: nineteen of its own dials were parsed, bounded, printed and
 * documented while launchd never passed them to the process, so `SNIPE_MAX_LAUNCH_SHARE_PCT`
 * could not reach the bot that was supposed to read it.
 *
 * So this validator refuses any key the lane does not actually read, by name, with the list of
 * what it does. A strategy that saves is a strategy that runs.
 */

/** Every dial a saved strategy may set, with its bounds. Each maps to one env name the executor
 *  lane genuinely reads — test-agent-desk.js asserts that mapping against the lane's own table,
 *  so a dial cannot be offered here and ignored there. */
export const STRATEGY_DIALS = Object.freeze({
  /* MAC-ONLY (`live: false`). Money, exits and fill pricing: the bot will not take these from
     the desk — see executor/snipe-lane.mjs LIVE_FILTER_ENV — so the page shows them as lines to
     put in the env file, and the size and daily cap also need the owner's typed sentence. */
  maxSolPerTrade: Object.freeze({ env: "SNIPE_MAX_SOL_PER_TRADE", min: 0.001, max: 1, unit: "SOL", live: false }),
  dailySolCap: Object.freeze({ env: "SNIPE_DAILY_SOL_CAP", min: 0.001, max: 10, unit: "SOL", live: false }),
  takeAtEntryX: Object.freeze({ env: "SNIPE_TAKE_AT_ENTRY_X", min: 1.05, max: 100, unit: "x entry", live: false }),
  stopFrac: Object.freeze({ env: "SNIPE_STOP_FRAC", min: 0.01, max: 0.95, unit: "fraction of entry", live: false }),
  holdMaxMs: Object.freeze({ env: "SNIPE_HOLD_MAX_MS", min: 10_000, max: 24 * 3_600_000, unit: "ms", live: false }),
  stallMs: Object.freeze({ env: "SNIPE_STALL_MS", min: 0, max: 3_600_000, unit: "ms", live: false }),
  maxPriceImpactPct: Object.freeze({ env: "SNIPE_MAX_PRICE_IMPACT_PCT", min: 0.1, max: 50, unit: "%", live: false }),
  /* LIVE (`live: true`): WHAT TO BUY. A bot whose owner set SNIPE_REMOTE_FILTERS=1 applies these
     from the page within a heartbeat, without a restart — bagworkagent.fun's "edit the agent and
     it picks it up", limited to the part of a strategy that cannot spend more money. */
  marketFloor: Object.freeze({ env: "SNIPE_MARKET_FLOOR", type: "preset", values: Object.freeze(["off", "curve", "bagwork"]),
    unit: "preset", live: true }),
  minAgeHours: Object.freeze({ env: "SNIPE_MIN_AGE_HOURS", min: 0, max: 720, unit: "hours", live: true }),
  minVolume24hUsd: Object.freeze({ env: "SNIPE_MIN_VOLUME_24H_USD", min: 0, max: 100_000_000, unit: "USD", live: true }),
  minMcapUsd: Object.freeze({ env: "SNIPE_MIN_MCAP_USD", min: 0, max: 100_000_000, unit: "USD", live: true }),
  minLiquidityUsd: Object.freeze({ env: "SNIPE_MIN_LIQUIDITY_USD", min: 0, max: 10_000_000, unit: "USD", live: true }),
  minTopPoolLiquidityUsd: Object.freeze({ env: "SNIPE_MIN_TOP_POOL_LIQUIDITY_USD", min: 0, max: 10_000_000, unit: "USD", live: true }),
  minTxns24h: Object.freeze({ env: "SNIPE_MIN_TXNS_24H", min: 0, max: 10_000_000, unit: "trades", live: true }),
  maxSellShare: Object.freeze({ env: "SNIPE_MAX_SELL_SHARE", min: 0.01, max: 1, unit: "fraction", live: true }),
  maxPriceChange24hPct: Object.freeze({ env: "SNIPE_MAX_PRICE_CHANGE_24H_PCT", min: 0, max: 100_000, unit: "%", live: true }),
  maxVolumeToLiquidity: Object.freeze({ env: "SNIPE_MAX_VOLUME_TO_LIQUIDITY", min: 0.1, max: 10_000, unit: "x depth", live: true }),
  minVolumeSpike: Object.freeze({ env: "SNIPE_MIN_VOLUME_SPIKE", min: 0, max: 1_000, unit: "x baseline", live: true }),
  requireSocials: Object.freeze({ env: "SNIPE_REQUIRE_SOCIALS", type: "flag", unit: "on/off", live: true }),
});

export const STRATEGY_KEYS = Object.freeze(Object.keys(STRATEGY_DIALS));
/** The dials a running bot takes from the page. The executor's own list is the authority
 *  (snipe-lane.mjs LIVE_FILTER_ENV); test-agent-desk.mjs asserts these are a subset of it. */
export const LIVE_STRATEGY_KEYS = Object.freeze(STRATEGY_KEYS.filter((k) => STRATEGY_DIALS[k].live === true));

/**
 * Validate a saved strategy. Returns `{ ok, strategy, errors }` — never throws, because this is
 * driven by a form and a 500 is a worse answer than a list of what is wrong.
 *
 * An unknown key is an ERROR, not a warning and not a silently dropped field. That is the whole
 * difference from theirs: a strategy that cannot run must not be able to save.
 */
export function validateStrategy(input) {
  if (!isPlainObject(input))
    return Object.freeze({ ok: false, strategy: null, errors: Object.freeze(["a strategy must be an object of dial names to numbers"]) });
  const errors = [];
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const dial = STRATEGY_DIALS[key];
    if (!dial) {
      errors.push(`${key} is not a dial this desk's bot reads, so saving it would change nothing. `
        + `Known dials: ${STRATEGY_KEYS.join(", ")}`);
      continue;
    }
    /* Null is how a dial is CLEARED, and it is not the same as zero: several of these are
       thresholds where zero means "refuse everything" and absent means "do not judge this". */
    if (raw === null) { out[key] = null; continue; }
    if (dial.type === "preset") {
      const v = String(raw).trim().toLowerCase();
      if (!dial.values.includes(v)) { errors.push(`${key} must be one of ${dial.values.join(", ")}, got ${JSON.stringify(raw)}`); continue; }
      out[key] = v;
      continue;
    }
    if (dial.type === "flag") {
      if (raw === true || raw === false) { out[key] = raw; continue; }
      const t = String(raw).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(t)) out[key] = true;
      else if (["0", "false", "no", "off"].includes(t)) out[key] = false;
      else errors.push(`${key} must be on or off, got ${JSON.stringify(raw)}`);
      continue;
    }
    const n = num(raw);
    if (n === null) { errors.push(`${key} must be a number or null, got ${JSON.stringify(raw)}`); continue; }
    if (n < dial.min || n > dial.max) {
      errors.push(`${key} must be between ${dial.min} and ${dial.max} ${dial.unit}, got ${n}`);
      continue;
    }
    out[key] = n;
  }
  return Object.freeze({
    ok: errors.length === 0,
    strategy: errors.length === 0 ? Object.freeze(out) : null,
    errors: Object.freeze(errors),
  });
}

/** One dial's value as the env file spells it. */
const envValue = (dial, v) => (dial.type === "flag" ? (v ? "1" : "0") : String(v));

/**
 * The live half of a saved strategy, as `{ SNIPE_NAME: value }` — exactly what the desk hands
 * the bot with each heartbeat. Mac-only dials are never in it, whatever was saved, so a money
 * dial cannot travel to the bot by this route even if the page were changed to send one.
 */
export function liveFilterEnv(strategy) {
  const out = {};
  if (!isPlainObject(strategy)) return Object.freeze(out);
  for (const key of LIVE_STRATEGY_KEYS) {
    const v = strategy[key];
    if (v === undefined || v === null) continue;
    out[STRATEGY_DIALS[key].env] = envValue(STRATEGY_DIALS[key], v);
  }
  return Object.freeze(out);
}

/** A validated strategy as the environment the executor would run it under. Exists so the page
 *  can SHOW the operator the exact lines to put in their env file, rather than asking them to
 *  trust that a saved form reached a bot on their own laptop. */
export function strategyAsEnv(strategy) {
  if (!isPlainObject(strategy)) return Object.freeze([]);
  const lines = [];
  for (const key of STRATEGY_KEYS) {
    const v = strategy[key];
    if (v === undefined || v === null) continue;
    lines.push(`${STRATEGY_DIALS[key].env}=${envValue(STRATEGY_DIALS[key], v)}`);
  }
  return Object.freeze(lines);
}

/**
 * THE PUBLIC VIEW. One desk, shaped for a page anybody can open.
 *
 * Three money figures, side by side, never summed — see the header. Every one of them can be
 * `null`, and null means "not measured", which the page must render as such: a dash, not a
 * zero. A zero is a claim.
 */
export function agentView({
  floor = null, name = null, operator = null, live = null,
  closedTrades = null, wins = null, realizedSol = null,
  /* THE DENOMINATOR, AS THE BOT ACTUALLY DEFINES IT. `wins` and `losses` cover only the
     closures whose realised number is on the ledger; the rest are `unknown`. The first version
     of this function divided by the book's `counted`, believing it meant "readable" — the bot
     sends it as "rows the tally covers", unknowns included — so every unreadable close was
     counted as a loss: 5 wins of 41 readable showed as 5 of 64. `losses` and `unknown` are
     taken as sent; `counted` survives only as the fallback for a bot that sends neither. */
  losses = null, unknown = null, counted = null,
  /* WHETHER THE TALLY COVERS EVERY TRADE. A bot that predates snipeExitTotals tallied its last
     200 closes and sent that beside a lifetime count. A window is not a record: a desk that lost
     money on its first 800 trades and made some on its last 200 read as profitable, and cleared
     rungs the ladder says it never would. So a partial tally shows its figures but does not
     advance the level. */
  recordComplete = null,
  feeSol = null, feeClaims = null, feeComplete = null,
  /* WHAT IS WAITING IN THE VAULTS — not revenue, and never summed into anything. */
  feeClaimableSol = null, feeClaimableAtMs = null,
  rewardSol = null, strategy = null, updatedAtMs = null,
} = {}) {
  const closed = num(closedTrades);
  const won = num(wins);
  const lost = num(losses);
  const readable = won !== null && lost !== null ? won + lost : (num(counted) ?? closed);
  const winRate = readable !== null && readable > 0 && won !== null ? won / readable : null;
  /* A SUM OVER NOTHING IS NOT A BREAK-EVEN. With no readable close the realised figure is
     unknown whatever number arrived beside it, and a zero is enough to clear the ladder's
     "at least 0 SOL" rung. */
  const realized = readable === 0 ? null : num(realizedSol);
  const partial = recordComplete === false;
  const level = agentLevel({ closedTrades: closed, realizedSol: partial ? null : realized, winRate: partial ? null : winRate });
  const unmeasured = num(unknown) ?? (closed !== null && readable !== null ? Math.max(0, closed - readable) : null);

  return Object.freeze({
    floor: num(floor),
    name: typeof name === "string" && name ? name : null,
    /* The operator's wallet is PUBLIC on this page only as far as it already is on chain — it is
       the lease holder, which /api/tower/floors already publishes. Nothing here exposes a
       session, a token or an email. */
    operator: typeof operator === "string" && operator ? operator : null,
    live: live === true ? true : (live === false ? false : null),

    closedTrades: closed, wins: won, losses: lost, winRate,
    /* Reported, so a page can say "5 of 41 measurable closures" rather than implying the rate
       was computed over everything. */
    countedTrades: readable, unmeasuredTrades: unmeasured,
    recordComplete: recordComplete === true ? true : (recordComplete === false ? false : null),
    recordNote: partial
      ? "this bot tallied only its most recent closes, not its whole record, so the level is held until it "
        + "reports the whole record — upgrading the bot fixes it"
      : null,
    /* TRADING, ON ITS OWN. */
    tradingSol: realized,
    /* REVENUE, ON ITS OWN — claims that LANDED, and null when nothing on this desk records them
       (the dry lane never claims; the owner signs at /fees.html). `feeComplete: false` means at
       least one landed claim's amount was never reported, so the figure is a floor. */
    feeSol: num(feeSol), feeClaims: num(feeClaims),
    feeSolComplete: feeComplete === true ? true : (feeComplete === false ? false : null),
    /* WAITING, NOT EARNED: what the last vault read found. Its own field, never folded into
       feeSol, because money in a vault nobody has claimed is not revenue yet. */
    feeClaimableSol: num(feeClaimableSol), feeClaimableAtMs: num(feeClaimableAtMs),
    /* THE HOUSE'S REWARDS, ON THEIR OWN. */
    rewardSol: num(rewardSol),

    level: level.level, levelName: level.name,
    nextLevel: level.nextLevel, nextLevelReward: level.nextRewardSol,
    levelBlockedBy: level.blockedBy, levelBlockedReason: level.blockedReason, levelNote: level.note,

    strategy: isPlainObject(strategy) ? Object.freeze({ ...strategy }) : null,
    strategyEnv: strategyAsEnv(strategy),
    updatedAtMs: num(updatedAtMs),

    /* And the sentence, on the payload, so a client that renders a total has to ignore it in
       writing. */
    accounting: "trading, creator fees and house rewards are three separate figures and are never "
      + "summed: a fee line added to a losing trading line is how a losing bot displays a profit",
  });
}
