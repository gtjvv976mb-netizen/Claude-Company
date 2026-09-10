/**
 * WOULD THIS HAVE MADE MONEY?
 *
 * The owner has spent about $600 to run this desk and has two settled trades and
 * -$0.42 to show for it. The question is not rhetorical and it deserves a measured
 * answer rather than an encouraging one.
 *
 * Every published call is already on the record with the mark it was published at
 * (`entry_ref`), the mark it closed at (`close_mark`), the reason it closed, and the
 * round trip it would have cost to get in and out (`rt_loss_at_call`). So the paper
 * trade is arithmetic over rows that already exist. No provider spend, no waiting.
 *
 * ── WHY THIS IS AN UPPER BOUND, NOT A FORECAST ───────────────────────────────────────
 *
 * Three optimisms are baked into the source data and CANNOT be removed by being careful
 * here. They are reported alongside every figure rather than buried, because a backtest
 * that hides them is how people talk themselves into funding a losing system:
 *
 *  1. `entry_ref` IS A MARK, NOT A FILL. It is the price when the desk published, and
 *     the bot's own simulation measured that only ~75% of published calls are takeable
 *     at all — entry-window expiry, slippage against the zone, route quality. A paper
 *     trade that fills every call at the published mark is trading an account nobody
 *     has. `fillRate` below re-prices the whole book on that.
 *  2. `close_mark` IS ALSO A MARK. The desk observed it; an executor selling into real
 *     depth would have moved the price against itself, and on a memecoin exit that is
 *     not a rounding error.
 *  3. THE COIN THAT VANISHED. A call that stopped being quotable cannot produce a
 *     close_mark, so it is absent from the closed population by construction. That
 *     absence removes losers more often than winners.
 *
 * ── THE FIGURE THAT ACTUALLY ANSWERS THE QUESTION ────────────────────────────────────
 *
 * Not the win rate, and not the average return. Both can look fine while the operation
 * loses money, because the research is bought whether or not the trade works. FINSABER
 * (arXiv:2505.07078) treats LLM spend as a component of trading cost rather than as
 * overhead reported elsewhere, and that is the only accounting under which this question
 * has an honest answer.
 *
 * So the output is BREAK-EVEN POSITION SIZE: given the measured edge per call and the
 * measured research bill over the same window, how large would each position have to be
 * for the trading side to cover the desk? If the edge is negative, no size works and the
 * function says so in those words rather than reporting a large number.
 */
import { DatabaseSync } from "node:sqlite";
import { openJournal } from "./lib/db-file.js";

const db = openJournal(DatabaseSync);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctl = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Calls opened on the same DAY share a market the way coins in a cohort do, so the day
   is the resampling unit. Resampling individual calls would treat one week of one
   market as many independent draws — the same error the seat measurement corrects. */
const dayOf = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);

/**
 * @param {object} opts
 * @param {number} opts.fillRate      fraction of calls assumed takeable (default 0.75,
 *                                    the bot's own measured ceiling). Unfilled calls
 *                                    earn nothing and cost nothing.
 * @param {number} opts.extraSlipPct  additional round-trip drag beyond the measured
 *                                    rt_loss_at_call, charged to every filled call.
 * @param {string} opts.costPolicy    "exclude" (default) drops calls with no measured
 *                                    round trip; "zero" charges them nothing and says so.
 */
export function paperTrade({
  fillRate = 0.75,
  extraSlipPct = 0,
  costPolicy = "exclude",
  bootstrapSamples = 4000,
  seed = 20260911,
  sinceMs = 0,
} = {}) {
  if (!["exclude", "zero"].includes(costPolicy)) {
    throw new Error(`invalid cost policy: ${costPolicy}`);
  }
  if (!(fillRate > 0 && fillRate <= 1)) throw new Error(`fillRate must be in (0,1]`);

  const rows = db.prepare(
    `SELECT id, mint, symbol, conviction, entry_ref, close_mark, close_reason,
            rt_loss_at_call, opened_at, closed_at
       FROM calls
      WHERE status='closed' AND close_mark IS NOT NULL AND entry_ref > 0
            AND opened_at >= ?
      ORDER BY opened_at ASC`,
  ).all(sinceMs);

  const live = db.prepare("SELECT COUNT(*) n FROM calls WHERE status='live'").get()?.n ?? 0;

  const trades = [];
  let droppedNoCost = 0;
  for (const r of rows) {
    const hasCost = Number.isFinite(r.rt_loss_at_call) && r.rt_loss_at_call >= 0;
    if (!hasCost && costPolicy === "exclude") { droppedNoCost++; continue; }
    const rt = hasCost ? Number(r.rt_loss_at_call) : 0;
    const gross = ((Number(r.close_mark) - Number(r.entry_ref)) / Number(r.entry_ref)) * 100;
    trades.push({
      id: r.id, symbol: r.symbol, day: dayOf(r.opened_at),
      openedAt: r.opened_at, closedAt: r.closed_at, closeReason: r.close_reason,
      grossPct: gross,
      roundTripPct: rt,
      netPct: gross - Math.max(0, rt) - Math.max(0, extraSlipPct),
    });
  }

  /* THE RESEARCH BILL over the same window. This is the term that decides the question,
     and it is bought whether or not any trade works. */
  const first = trades.length ? trades[0].openedAt : null;
  const last = trades.length ? trades[trades.length - 1].closedAt ?? trades[trades.length - 1].openedAt : null;
  const spendRow = first
    ? db.prepare("SELECT COALESCE(SUM(usd),0) usd, COUNT(*) calls FROM llm_spend WHERE ts BETWEEN ? AND ?")
      .get(first, last ?? first)
    : { usd: 0, calls: 0 };
  const researchUsd = Number(spendRow.usd) || 0;

  const nets = trades.map((t) => t.netPct);
  const wins = nets.filter((x) => x > 0).length;

  /* Expected net per PUBLISHED call, not per filled one: an unfilled call earns nothing,
     and the research that produced it was still paid for. This is the number that has to
     carry the desk. */
  const meanNetFilled = mean(nets);
  const edgePerCallPct = meanNetFilled === null ? null : meanNetFilled * fillRate;

  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    byDay.get(t.day).push(t);
  }
  const days = [...byDay.keys()];

  /* Percentile bootstrap over DAYS, on the same reasoning as the cycle bootstrap. */
  let ci95 = null, bootUsable = 0;
  if (days.length >= 5 && trades.length >= 10) {
    const rand = mulberry32(seed);
    const vals = [];
    for (let s = 0; s < bootstrapSamples; s++) {
      const drawn = [];
      for (let i = 0; i < days.length; i++) drawn.push(...byDay.get(days[Math.floor(rand() * days.length)]));
      const m = mean(drawn.map((t) => t.netPct));
      if (m !== null && Number.isFinite(m)) vals.push(m * fillRate);
    }
    if (vals.length >= Math.max(20, bootstrapSamples * 0.5)) {
      vals.sort((a, b) => a - b);
      const at = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))];
      ci95 = [at(0.025), at(0.975)];
      bootUsable = vals.length;
    }
  }

  /* BREAK-EVEN SIZE. size * (edge/100) * publishedCalls >= researchUsd. */
  const publishedCalls = trades.length;   // filled or not, each was researched
  let breakEven = null;
  if (edgePerCallPct !== null && publishedCalls > 0) {
    if (edgePerCallPct <= 0) {
      breakEven = {
        possible: false,
        reason: "the measured edge per published call is not positive, so no position " +
          "size makes the trading side cover the research bill — a larger size scales " +
          "the loss, it does not reverse it",
      };
    } else {
      breakEven = {
        possible: true,
        sizeUsdPerCall: researchUsd / ((edgePerCallPct / 100) * publishedCalls),
      };
    }
  }

  const totals = edgePerCallPct === null ? null : {
    researchUsd,
    publishedCalls,
    /* What the book would have returned at a few sizes, net of the research bill. */
    atSizeUsd: [10, 100, 1000].map((size) => ({
      sizeUsd: size,
      tradingUsd: (edgePerCallPct / 100) * size * publishedCalls,
      netOfResearchUsd: (edgePerCallPct / 100) * size * publishedCalls - researchUsd,
    })),
  };

  return {
    population: {
      closedCallsConsidered: rows.length,
      traded: trades.length,
      stillLive: live,
      droppedNoCost,
      firstOpenedAt: first, lastClosedAt: last, days: days.length,
    },
    perFilledCall: {
      meanNetPct: meanNetFilled,
      medianNetPct: median(nets),
      winRatePct: trades.length ? (wins / trades.length) * 100 : null,
      p10Pct: pctl(nets, 0.10), p90Pct: pctl(nets, 0.90),
      bestPct: nets.length ? Math.max(...nets) : null,
      worstPct: nets.length ? Math.min(...nets) : null,
      meanRoundTripPct: mean(trades.map((t) => t.roundTripPct)),
    },
    assumptions: { fillRate, extraSlipPct, costPolicy },
    edgePerPublishedCallPct: edgePerCallPct,
    ci95PerPublishedCallPct: ci95,
    bootstrap: { samples: bootstrapSamples, usable: bootUsable, resampledUnit: "day", seed },
    research: { usd: researchUsd, providerCalls: spendRow.calls },
    breakEven,
    totals,
    caveats: [
      "UPPER BOUND, not a forecast. entry_ref is the mark when the desk published, not a " +
      "fill the bot obtained; close_mark is a mark the desk observed, not a price an " +
      "executor sold into. Both flatter the result and neither can be corrected from " +
      "these rows.",
      "A call that stopped being quotable produces no close_mark and is therefore absent " +
      "from this population by construction. That absence removes losers more often than " +
      "winners.",
      "The research bill is charged whether or not a call is filled, which is why the " +
      "edge is stated PER PUBLISHED CALL rather than per filled one.",
      "Resampled by DAY: calls opened on one day share a market and are not independent.",
      "This is a record of what happened, not a prediction of what will. It is not " +
      "investment advice and it carries no expectation about future results.",
    ],
  };
}
