/**
 * THE PUBLIC AGENT PAGE, PINNED — including the two rules that are the whole reason this file
 * differs from bagworkagent.fun's.
 *
 * 1. NO TOTAL. Their `pnlSol` adds creator fees and rewards to trading P&L, which is how an agent
 *    that is -0.105 on trading displays +15.6 SOL. The last section asserts that `agentView()`
 *    has no `total`, `pnl` or `net` field, by name.
 *
 * 2. LEVELS DO NOT PAY FOR CHURN. Their ladder advances on activity alone and pays a reward per
 *    rung, so an agent earns by trading whether or not the trading works — and their aggregate
 *    is a 21% win rate sustained over 362 trades. Here every rung above the first needs a RECORD
 *    as well as the trades, and a desk that has closed a thousand losing trades is asserted to
 *    stay at level 1 and to be told why in those words.
 *
 * Plus the parity check that stops the strategy builder from becoming a form that does nothing:
 * every dial it offers must be an env name the executor's lane genuinely reads, checked against
 * the lane's own table rather than against a copy of it.
 *
 *   node test-agent-desk.mjs
 */
import fs from "node:fs";
import {
  AGENT_LEVELS, MAX_AGENT_LEVEL, REWARD_KINDS, STRATEGY_DIALS, STRATEGY_KEYS,
  agentLevel, levelReward, rewardsOwed, validateStrategy, strategyAsEnv, agentView, LIVE_STRATEGY_KEYS, liveFilterEnv,
} from "./src/agent-desk.js";
import { SNIPE_ENV, LIVE_FILTER_ENV } from "./executor/snipe-lane.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

console.log("\nthe ladder needs the record, not just the work");
{
  ok("a new desk is level 1", agentLevel({}).level === 1);
  ok("ten closed trades that made money reach level 2",
    agentLevel({ closedTrades: 10, realizedSol: 0.01, winRate: 0.5 }).level === 2);

  /* THE ASSERTION THIS LADDER EXISTS FOR. BAGWORK's #1 agent has 362 closed trades between them
     and -0.077 SOL to show for it, and their system levels agents up on the trades. */
  const churner = agentLevel({ closedTrades: 1_000, realizedSol: -0.361, winRate: 0.08 });
  ok("a thousand LOSING closed trades stays at level 1", churner.level === 1, `level ${churner.level}`);
  ok("...and the next rung is blocked by the RECORD, not by the amount of work",
    churner.blockedBy === "realizedSol", churner.blockedBy);
  ok("...and it says so in those words",
    /a ladder that pays for activity\s+pays for losing/.test(churner.note ?? ""), churner.note?.slice(0, 80));
  ok("...and the reason quotes the desk's own numbers",
    /needs 0 realized SOL from trading, has -0\.361/.test(churner.blockedReason), churner.blockedReason);

  /* This desk's own 64 trades, exactly: 5 winners, -0.361 SOL. */
  const hawk = agentLevel({ closedTrades: 64, realizedSol: -0.361, winRate: 5 / 64 });
  ok("HAWK-AI's real record today is level 1", hawk.level === 1 && hawk.nextLevel === 2);

  ok("a good record with too few trades is held by the trades, and says so",
    agentLevel({ closedTrades: 3, realizedSol: 5, winRate: 0.9 }).blockedBy === "closedTrades");
  ok("...and that case gets no lecture about churn, because it is not churning",
    agentLevel({ closedTrades: 3, realizedSol: 5, winRate: 0.9 }).note === null);
  ok("a win rate under the rung's bar holds the level",
    agentLevel({ closedTrades: 30, realizedSol: 1, winRate: 0.1 }).blockedBy === "winRate");
  /* UNKNOWN IS NOT ZERO — a rung asking for "at least 0 SOL" must not be cleared by a missing
     measurement, which is exactly what `Number(null) === 0` would do. */
  ok("an unmeasured realized result does NOT advance a level",
    agentLevel({ closedTrades: 500, realizedSol: null, winRate: 0.9 }).level === 1);
  ok("...and says the measurement is missing rather than showing a zero",
    /has not measured/.test(agentLevel({ closedTrades: 500, realizedSol: null }).blockedReason));
  ok("the top rung reports no next level",
    agentLevel({ closedTrades: 500, realizedSol: 10, winRate: 0.9 }).nextLevel === null);
  ok("the ladder tops out where MAX_AGENT_LEVEL says",
    agentLevel({ closedTrades: 500, realizedSol: 10, winRate: 0.9 }).level === MAX_AGENT_LEVEL);
  ok("every rung above the first requires a record",
    AGENT_LEVELS.slice(1).every((r) => r.minRealizedSol !== null));
  ok("rewards are small on purpose — a reward worth farming will be farmed",
    AGENT_LEVELS.every((r) => r.rewardSol <= 0.1));
}

console.log("\nrewards are owed once, and replaying cannot pay twice");
{
  ok("reaching level 3 owes the level 2 and level 3 rewards",
    rewardsOwed({ level: 3 }).map((r) => r.level).join(",") === "2,3");
  ok("a reward already booked is not owed again",
    rewardsOwed({ level: 3, paidRows: [{ kind: "level_up", level: 2 }] }).map((r) => r.level).join(",") === "3");
  /* IDEMPOTENT BY CONSTRUCTION: this runs on every page load, and a reward that pays twice pays
     forever. */
  ok("replaying against a fully-paid book owes nothing",
    rewardsOwed({ level: 5, paidRows: AGENT_LEVELS.map((r) => ({ kind: "level_up", level: r.level })) }).length === 0);
  ok("level 1 pays nothing, so simply existing earns nothing", rewardsOwed({ level: 1 }).length === 0);
  ok("a row of another kind does not count as payment",
    rewardsOwed({ level: 2, paidRows: [{ kind: "creator_fee", level: 2 }] }).length === 1);
  ok("an unknown level pays nothing rather than throwing", levelReward(99) === 0 && levelReward(null) === 0);
  ok("every reward kind is declared", rewardsOwed({ level: 5 }).every((r) => REWARD_KINDS.includes(r.kind)));
}

console.log("\nthe strategy builder: a strategy that saves is a strategy that runs");
{
  const good = validateStrategy({ maxSolPerTrade: 0.05, minAgeHours: 2, maxSellShare: 0.7 });
  ok("a valid strategy saves", good.ok === true && good.strategy.maxSolPerTrade === 0.05);

  /* THE DIFFERENCE FROM THEIRS. A key their engine does not read is stored, displayed back and
     silently does nothing — so an owner tunes a number for a week and watches a bot that never
     saw it. Here it cannot save. */
  const unknown = validateStrategy({ maxSolPerTrade: 0.05, moonMode: true });
  ok("a dial the bot does not read is an ERROR, not a dropped field", unknown.ok === false);
  ok("...and nothing is saved when anything is wrong", unknown.strategy === null);
  ok("...and the error says saving it would change nothing",
    /moonMode is not a dial this desk's bot reads, so saving it would change nothing/.test(unknown.errors[0]));
  ok("...and lists what it does read", /Known dials: maxSolPerTrade/.test(unknown.errors[0]));

  ok("a value out of bounds is refused with the bounds",
    /must be between 0.001 and 1 SOL/.test(validateStrategy({ maxSolPerTrade: 50 }).errors[0]));
  ok("a non-number is refused rather than coerced",
    validateStrategy({ maxSolPerTrade: "big" }).ok === false);
  /* NULL CLEARS A DIAL, and that is not the same as zero: several of these are thresholds where
     zero means "refuse everything" and absent means "do not judge this at all". */
  ok("null clears a dial and is not read as zero",
    validateStrategy({ minAgeHours: null }).strategy.minAgeHours === null);
  ok("zero is still a legal value where zero means something",
    validateStrategy({ minAgeHours: 0 }).strategy.minAgeHours === 0);
  ok("a non-object is refused without throwing", validateStrategy(null).ok === false && validateStrategy(7).ok === false);
  ok("every error is reported at once, not one per submit",
    validateStrategy({ nope: 1, alsoNope: 2, maxSolPerTrade: 99 }).errors.length === 3);

  /* THE PARITY CHECK. Every dial offered here must be an env name the lane genuinely reads,
     checked against the lane's own table. This desk has already shipped the opposite failure:
     nineteen dials parsed, bounded, printed and documented while launchd never passed them. */
  const laneNames = new Set(Object.keys(SNIPE_ENV));
  const orphans = STRATEGY_KEYS.filter((k) => !laneNames.has(STRATEGY_DIALS[k].env));
  ok("every dial the builder offers is one the executor's lane actually reads",
    orphans.length === 0, orphans.map((k) => `${k} -> ${STRATEGY_DIALS[k].env}`).join(", ") || `all ${STRATEGY_KEYS.length} wired`);
  ok("every numeric dial has bounds, every dial a unit, and a typed dial its values",
    STRATEGY_KEYS.every((k) => {
      const d = STRATEGY_DIALS[k];
      if (typeof d.unit !== "string") return false;
      if (d.type === "preset") return Array.isArray(d.values) && d.values.length > 0;
      if (d.type === "flag") return true;
      return Number.isFinite(d.min) && Number.isFinite(d.max);
    }));

  /* THE PAGE MAY ONLY SEND WHAT THE BOT WILL TAKE. Every live dial must be one the executor's
     own LIVE_FILTER_ENV lists — the executor is the authority, and a dial the page offered as
     live that the bot refused would read as "the bot ignored my change". And no money dial may
     ever be live. */
  const liveEnv = new Set(LIVE_FILTER_ENV);
  const wrongLive = LIVE_STRATEGY_KEYS.filter((k) => !liveEnv.has(STRATEGY_DIALS[k].env));
  ok("every dial the page changes live is one the bot takes live", wrongLive.length === 0, wrongLive.join(", ") || `${LIVE_STRATEGY_KEYS.length} live`);
  ok("no money, exit or pricing dial is live",
    ["maxSolPerTrade", "dailySolCap", "stopFrac", "takeAtEntryX", "holdMaxMs", "stallMs", "maxPriceImpactPct"]
      .every((k) => STRATEGY_DIALS[k].live === false && !LIVE_STRATEGY_KEYS.includes(k)));
  const sent = liveFilterEnv({ maxSolPerTrade: 1, dailySolCap: 10, marketFloor: "curve", minVolume24hUsd: 25000,
    requireSocials: false, minAgeHours: null });
  ok("what travels to the bot is the live half only, env-spelled",
    JSON.stringify(sent) === JSON.stringify({ SNIPE_MARKET_FLOOR: "curve", SNIPE_MIN_VOLUME_24H_USD: "25000", SNIPE_REQUIRE_SOCIALS: "0" }),
    JSON.stringify(sent));
  ok("a preset outside its list is refused by name", /must be one of off, curve, bagwork/.test(validateStrategy({ marketFloor: "yolo" }).errors[0] ?? ""));
  ok("a flag takes on/off words and booleans", validateStrategy({ requireSocials: "off" }).strategy?.requireSocials === false
    && validateStrategy({ requireSocials: true }).strategy?.requireSocials === true
    && validateStrategy({ requireSocials: "maybe" }).ok === false);
  ok("the env lines spell a flag as 1/0", strategyAsEnv({ requireSocials: false }).join() === "SNIPE_REQUIRE_SOCIALS=0");
  ok("the per-trade ceiling matches the operator maximum the lane enforces",
    STRATEGY_DIALS.maxSolPerTrade.max === 1);

  /* The page SHOWS the env lines rather than claiming a saved form reached a laptop. */
  const env = strategyAsEnv(validateStrategy({ maxSolPerTrade: 0.05, minAgeHours: 2 }).strategy);
  ok("a saved strategy renders as the exact env lines to paste",
    env.includes("SNIPE_MAX_SOL_PER_TRADE=0.05") && env.includes("SNIPE_MIN_AGE_HOURS=2"), env.join(" "));
  ok("a cleared dial produces no line", !strategyAsEnv({ minAgeHours: null }).length);
}

console.log("\nthe view: three figures, and never their sum");
{
  const view = agentView({
    floor: 50, name: "Headquarters", operator: "Wa11et", live: true,
    closedTrades: 64, wins: 5, realizedSol: -0.361,
    feeSol: 14.515, feeClaims: 12, feeComplete: true, rewardSol: 0.62,
    strategy: { maxSolPerTrade: 0.05 }, updatedAtMs: 1_790_000_000_000,
  });
  ok("trading is its own field", view.tradingSol === -0.361);
  ok("fee revenue is its own field", view.feeSol === 14.515);
  ok("house rewards are their own field", view.rewardSol === 0.62);
  for (const forbidden of ["total", "totalSol", "pnl", "pnlSol", "net", "netSol", "combined", "balance"])
    ok(`there is no \`${forbidden}\` — their +15.6 SOL is exactly this addition`, !(forbidden in view));
  ok("the payload carries the sentence, so a client that sums has to ignore it in writing",
    /never\s+summed/.test(view.accounting));

  ok("the win rate is computed, not accepted", Math.abs(view.winRate - 5 / 64) < 1e-12);
  ok("a desk with no closed trades has a null win rate, not 0%", agentView({ closedTrades: 0, wins: 0 }).winRate === null);
  /* NULL MEANS NOT MEASURED, and a page must render it as a dash. A zero is a claim. */
  ok("unmeasured figures are null rather than zero",
    agentView({}).tradingSol === null && agentView({}).feeSol === null && agentView({}).rewardSol === null);
  ok("an incomplete fee figure is flagged so the page can say it is a floor, not a total",
    agentView({ feeComplete: false }).feeSolComplete === false && agentView({}).feeSolComplete === null);
  ok("the level rides on the view, computed from the same record", view.level === 1 && view.levelBlockedBy === "realizedSol");
  ok("nothing private is exposed: the operator is the lease holder and nothing else",
    Object.keys(view).every((k) => !/sid|token|secret|session|email|key/i.test(k)), Object.keys(view).join(","));

  const src = fs.readFileSync(new URL("./src/agent-desk.js", import.meta.url), "utf8");
  ok("no function in the module adds a fee figure to a trading figure",
    !/feeSol\s*\+/.test(src) && !/\+\s*feeSol/.test(src) && !/tradingSol\s*\+/.test(src));
  ok("the reason the ladder requires a record is written down, not just implemented",
    /what makes the losing survivable/.test(src));
  ok("the module is pure: no clock, no database, no HTTP",
    !/Date\.now\(/.test(src) && !/require\(|import .*db/.test(src) && !/\bfetch\(/.test(src));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-agent-desk  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
