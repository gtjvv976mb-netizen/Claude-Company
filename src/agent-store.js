import db from "./lib/store.js";
import { AGENT_LEVELS, agentLevel, rewardsOwed, validateStrategy } from "./agent-desk.js";

/**
 * WHERE A DESK'S STRATEGY AND ITS EARNED REWARDS LIVE.
 *
 * agent-desk.js holds the rules and is pure. This holds the rows. The split is deliberate: the
 * ladder, the reward table and the strategy validator are the parts most likely to be argued
 * about and re-tuned, and they are far easier to argue about when they can be driven by a test
 * with no database at all.
 *
 * TWO TABLES, AND NEITHER OF THEM TOUCHES THE TRADING RECORD.
 *
 * That is the same rule the fee book follows for the same reason: bagworkagent.fun's headline
 * number adds claimed fees and level rewards to trading P&L, which is how an agent that is
 * -0.105 SOL on trading displays +15.6. A reward that can be summed into a trading figure
 * eventually will be, so rewards are stored where trades are not.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS agent_strategies (
  floor INTEGER PRIMARY KEY,
  wallet TEXT,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level INTEGER,
  sol REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rewards_once
  ON agent_rewards(floor, kind, level);
`);

const asFloor = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
};

/** The saved strategy for one floor, or null. Never throws on a corrupt row: a strategy that
 *  cannot be parsed is reported as absent, because the page must still render. */
export function strategyFor(floor) {
  const f = asFloor(floor);
  if (f === null) return null;
  const row = db.prepare("SELECT json, wallet, updated_at FROM agent_strategies WHERE floor = ?").get(f);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.json);
    /* RE-VALIDATED ON THE WAY OUT, not only on the way in. A dial can be removed from the lane
       in a release, and a stored strategy naming it would otherwise keep being shown to an
       operator as if the bot still read it — the exact failure this desk refuses on the way in.
       An invalid stored strategy is reported with its errors rather than silently served. */
    const verdict = validateStrategy(parsed);
    return Object.freeze({
      floor: f, wallet: row.wallet ?? null, updatedAtMs: Number(row.updated_at) || null,
      strategy: verdict.ok ? verdict.strategy : null,
      stale: !verdict.ok, staleErrors: verdict.errors,
    });
  } catch {
    return Object.freeze({ floor: f, wallet: row.wallet ?? null, updatedAtMs: Number(row.updated_at) || null,
      strategy: null, stale: true, staleErrors: Object.freeze(["the stored strategy is not valid JSON"]) });
  }
}

/**
 * Save a strategy for a floor. Returns the same `{ ok, strategy, errors }` the validator does,
 * and writes NOTHING unless it is entirely valid — a partially applied strategy is a strategy
 * nobody configured.
 */
export function saveStrategy({ floor, wallet = null, strategy }) {
  const f = asFloor(floor);
  if (f === null) return Object.freeze({ ok: false, strategy: null, errors: Object.freeze([`floor ${JSON.stringify(floor)} is not 1-50`]) });
  const verdict = validateStrategy(strategy);
  if (!verdict.ok) return verdict;
  db.prepare(`INSERT INTO agent_strategies (floor, wallet, json, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(floor) DO UPDATE SET wallet = excluded.wallet, json = excluded.json,
              updated_at = excluded.updated_at`)
    .run(f, wallet, JSON.stringify(verdict.strategy), Date.now());
  return verdict;
}

/** Every reward row for a floor, newest first. */
export function rewardsFor(floor) {
  const f = asFloor(floor);
  if (f === null) return Object.freeze([]);
  return Object.freeze(db.prepare("SELECT kind, level, sol, ts FROM agent_rewards WHERE floor = ? ORDER BY ts DESC").all(f)
    .map((r) => Object.freeze({ kind: r.kind, level: r.level, sol: Number(r.sol), atMs: Number(r.ts) })));
}

/** What a floor has been paid in house rewards, in SOL. Never summed with anything else. */
export function rewardSolFor(floor) {
  const f = asFloor(floor);
  if (f === null) return 0;
  const row = db.prepare("SELECT COALESCE(SUM(sol), 0) AS total FROM agent_rewards WHERE floor = ?").get(f);
  return Number(row?.total) || 0;
}

/**
 * Credit any level rewards a floor has earned and not yet been paid.
 *
 * IDEMPOTENT TWICE OVER: `rewardsOwed` filters against the rows already booked, and the unique
 * index on (floor, kind, level) makes a double insert impossible even if two requests race. This
 * is called on page loads, and a reward that can pay twice pays forever.
 */
export function creditRewards({ floor, closedTrades = null, realizedSol = null, winRate = null, now = () => Date.now() }) {
  const f = asFloor(floor);
  if (f === null) return Object.freeze([]);
  const level = agentLevel({ closedTrades, realizedSol, winRate }).level;
  const owed = rewardsOwed({ level, paidRows: rewardsFor(f) });
  const paid = [];
  for (const r of owed) {
    try {
      db.prepare("INSERT INTO agent_rewards (floor, kind, level, sol, ts) VALUES (?, ?, ?, ?, ?)")
        .run(f, r.kind, r.level, r.sol, now());
      paid.push(r);
    } catch { /* the unique index refused a race; the reward is already booked */ }
  }
  return Object.freeze(paid);
}

/** The reward ladder, for a page that wants to show what is coming. */
export const ladder = () => AGENT_LEVELS;
