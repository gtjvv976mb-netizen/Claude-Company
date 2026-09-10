/**
 * DO THE PAID SEATS BEAT THE FREE SCREEN?
 *
 * The desk has never asked. It has run four paid Anthropic seats over every coin the
 * free deterministic screen let through, and nobody has measured whether those seats
 * discriminate any better than the screen floors already do. External research is not
 * encouraging on the point — FORESIGHT-9 measured mechanical equal-weighting beating 31
 * of 36 of its own agent runs, and a census of 19 closed-loop LLM trading studies found
 * ZERO reporting the counterfactual of what they refused — so the question is open and
 * it is not settled in our favour by anything published.
 *
 * It is unusually cheap for US to answer, because recordDecision() already writes a
 * decision_runs row and five forward_marks horizons for every coin the screen touches,
 * including the ones it rejected and every coin an analyst killed. The counterfactual is
 * a query. It costs no provider spend at all, which is the whole point: it is the one
 * measurement that runs while both provider accounts are empty.
 *
 * ── WHAT IS COMPARED, AND WHY IT IS NOT THE OBVIOUS THING ────────────────────────────
 *
 * The tempting arms are `screened_out` versus approved. That comparison is worthless for
 * this question: it measures THE SCREEN's alpha, which we are not in doubt about and are
 * not paying for. The seats never saw a screened_out coin.
 *
 * The arms that answer the question are the two populations the SEATS produced, among
 * coins that all cleared the same free screen:
 *
 *     APPROVED        outcome='decided'  AND final_decision='APPROVED'
 *     ANALYST-KILLED  outcome='killed'
 *
 * Everything else is excluded on purpose, and each for a different reason:
 *   screened_out / no_data          the seats never ran — pre-seat exits
 *   credit_outage / error           the seats could not run — a billing or transport
 *                                   failure is not a research verdict
 *   insufficient_coverage           fewer than three seats returned, so there IS no
 *                                   panel judgement to score
 * Folding any of those into the killed arm would credit the seats for refusals that were
 * really the screen's, or really an empty account's.
 *
 * ── THE TWO WAYS THIS MEASUREMENT LIES, BOTH HANDLED HERE ────────────────────────────
 *
 * 1. THE COST HOLE. evaluationSummary() computes net as `gross - Math.max(0, cost || 0)`,
 *    and round_trip_cost_pct is `rec.ev?.exitProbe?.roundTripLossPct ?? null` — NULL
 *    whenever the exit probe did not complete. A coin killed on `unverified_exit` fires
 *    precisely when the probe did not complete, so it carries null cost and has nothing
 *    subtracted. Grading the killed arm that way flatters exactly the population we are
 *    testing, in exactly the direction that would make the seats look good. So the
 *    default costPolicy is "exclude": a run with no measured round trip is dropped from
 *    BOTH arms, and the count dropped from each is reported. "zero" reproduces the
 *    existing biased behaviour for comparison and says so; "impute" charges the median
 *    observed cost.
 *
 * 2. THE CLUSTERING HOLE. Every coin in a cohort is worked in the same hour and moves
 *    with the same market, so coins are not independent observations and treating n as
 *    the number of coins overstates the evidence. The unit of resampling here is THE
 *    CYCLE, not the coin: the bootstrap resamples whole cycles with replacement and
 *    carries every run inside them.
 *
 *    TWO THINGS MEASURED IN test-seat-alpha.mjs, because both are counter-intuitive and
 *    one of them limits what this function may ever be used to claim:
 *
 *    (a) When the arms are BALANCED inside a cycle, the cohort's shared shock lands in
 *        both arms and CANCELS in the difference. Resampling cycles is then legitimately
 *        TIGHTER than resampling coins, because the coin-level bootstrap destroys that
 *        pairing. A wider interval is not automatically the more honest one.
 *
 *    (b) When the approval RATE moves with the cohort's shock, the shock stops
 *        cancelling. The coin-level bootstrap then reports a confident effect that is
 *        purely market (measured: a 95% interval of [13.6, 19.3] on a planted truth of
 *        ZERO), and resampling cycles correctly carries that variance — 2.1x the width.
 *        BUT IT STILL EXCLUDES ZERO. Confounding between arm and cohort is a bias in the
 *        point estimate, and no resampling scheme removes a bias; a bootstrap prices
 *        variance only. This is precisely why the causal caveat below is unconditional
 *        and why the delta is never called alpha.
 *
 * ── WHAT THIS STILL CANNOT TELL YOU ──────────────────────────────────────────────────
 *
 * This is observational, not causal. The seats did not choose at random: an approved
 * coin also tends to be one with better screen metrics, so a positive delta conflates
 * "the seats discriminate" with "the seats agree with metrics that were already
 * predictive". Closing that needs the selection propensity recorded AT DECISION TIME —
 * the one field that cannot be reconstructed afterwards. Until that exists this function
 * reports an association and labels it as one; it never calls it alpha.
 */
import { DatabaseSync } from "node:sqlite";
import { openJournal } from "./lib/db-file.js";

const db = openJournal(DatabaseSync);

/* The forward mark must have actually been taken. A row still 'pending' is a coin whose
   horizon has not arrived, and counting it as anything would be inventing data. */
const OBSERVED = "observed";

/* Runs where the SEATS produced the verdict. See the header for why nothing else counts. */
const ARM_SQL = Object.freeze({
  approved: "r.outcome='decided' AND r.final_decision='APPROVED'",
  analystKilled: "r.outcome='killed'",
});

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * A deterministic 32-bit PRNG. The bootstrap must be reproducible: the same journal and
 * the same seed give the same interval, or two people reading the same number disagree
 * about what it says. Math.random() would also make the test flaky for real reasons.
 */
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

/**
 * Pull every seat-judged run with an observed mark at `horizonMin`, tagged by arm and
 * carrying its cycle so the bootstrap can resample by cohort.
 */
function loadRuns({ horizonMin, filters, args }) {
  const where = ["m.horizon_min=?", "m.data_status=?", "r.entry_price IS NOT NULL",
    "m.gross_return_pct IS NOT NULL", `(${ARM_SQL.approved} OR ${ARM_SQL.analystKilled})`,
    ...filters];
  const rows = db.prepare(
    `SELECT r.id, r.cycle, r.mint, r.symbol, r.outcome, r.final_decision, r.binding_gate,
            r.round_trip_cost_pct AS cost, m.gross_return_pct AS gross
       FROM decision_runs r
       JOIN forward_marks m ON m.run_id = r.id
      WHERE ${where.join(" AND ")}
      ORDER BY r.decided_at ASC`,
  ).all(horizonMin, OBSERVED, ...args);

  return rows.map((r) => ({
    id: r.id,
    cycle: String(r.cycle),
    mint: r.mint,
    symbol: r.symbol,
    arm: r.outcome === "killed" ? "analystKilled" : "approved",
    bindingGate: r.binding_gate,
    gross: Number(r.gross),
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost),
  }));
}

/** Net return under the declared cost policy. See hole 1 in the header. */
function applyCost(runs, costPolicy) {
  const measured = runs.map((r) => r.cost).filter((c) => Number.isFinite(c) && c >= 0);
  const imputed = median(measured);
  const kept = [];
  const droppedByArm = { approved: 0, analystKilled: 0 };

  for (const r of runs) {
    const hasCost = Number.isFinite(r.cost) && r.cost >= 0;
    if (!hasCost) {
      if (costPolicy === "exclude") { droppedByArm[r.arm]++; continue; }
      if (costPolicy === "impute" && imputed === null) { droppedByArm[r.arm]++; continue; }
    }
    const charge = hasCost ? r.cost : (costPolicy === "impute" ? imputed : 0);
    kept.push({ ...r, charged: charge, net: r.gross - Math.max(0, charge) });
  }
  return { kept, droppedByArm, imputedCostPct: imputed };
}

/** The point estimate: mean net of the approved arm minus mean net of the killed arm. */
function deltaOf(runs) {
  const a = runs.filter((r) => r.arm === "approved").map((r) => r.net);
  const k = runs.filter((r) => r.arm === "analystKilled").map((r) => r.net);
  if (!a.length || !k.length) return null;
  return mean(a) - mean(k);
}

/**
 * Percentile bootstrap over CYCLES. Resampling coins would treat one hour of one market
 * as many independent draws; resampling cycles keeps the correlated block together.
 * A resample that lands with an empty arm yields no delta and is counted, not silently
 * dropped — a high skip count is itself a finding about how thin the data is.
 */
function bootstrapDelta(runs, { samples, seed }) {
  const byCycle = new Map();
  for (const r of runs) {
    if (!byCycle.has(r.cycle)) byCycle.set(r.cycle, []);
    byCycle.get(r.cycle).push(r);
  }
  const cycles = [...byCycle.keys()];
  const rand = mulberry32(seed);
  const deltas = [];
  let skipped = 0;

  for (let s = 0; s < samples; s++) {
    const drawn = [];
    for (let i = 0; i < cycles.length; i++) {
      drawn.push(...byCycle.get(cycles[Math.floor(rand() * cycles.length)]));
    }
    const d = deltaOf(drawn);
    if (d === null) { skipped++; continue; }
    deltas.push(d);
  }

  if (deltas.length < Math.max(20, samples * 0.5)) {
    return { ci95: null, skipped, usable: deltas.length, cycles: cycles.length };
  }
  deltas.sort((a, b) => a - b);
  const at = (p) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(p * deltas.length)))];
  return { ci95: [at(0.025), at(0.975)], skipped, usable: deltas.length, cycles: cycles.length };
}

function armSummary(runs, arm, dropped) {
  const xs = runs.filter((r) => r.arm === arm);
  return {
    n: xs.length,
    cycles: new Set(xs.map((r) => r.cycle)).size,
    meanNetPct: mean(xs.map((r) => r.net)),
    medianNetPct: median(xs.map((r) => r.net)),
    meanGrossPct: mean(xs.map((r) => r.gross)),
    droppedNoCost: dropped[arm],
  };
}

/**
 * The measurement. Returns a verdict that REFUSES to answer on thin data rather than
 * reporting a delta nobody should act on — the same fail-closed instinct the desk uses
 * when fewer than three seats return.
 *
 * @param {object}  opts
 * @param {number}  opts.horizonMin        which forward horizon to score (default 1440 = 24h)
 * @param {string}  opts.costPolicy        "exclude" (default) | "impute" | "zero"
 * @param {number}  opts.bootstrapSamples  resamples of the cycle set (default 2000)
 * @param {number}  opts.minCycles         refuse below this many distinct cycles (default 8)
 * @param {number}  opts.minPerArm         refuse below this many runs in either arm (default 15)
 * @param {number}  opts.seed              PRNG seed, so the interval is reproducible
 */
export function seatAlpha({
  horizonMin = 1440,
  costPolicy = "exclude",
  bootstrapSamples = 2000,
  minCycles = 8,
  minPerArm = 15,
  seed = 20260910,
  floorNo = undefined,
  evidenceScope = undefined,
  policyVersion = undefined,
  promptManifestHash = undefined,
} = {}) {
  if (!["exclude", "impute", "zero"].includes(costPolicy)) {
    throw new Error(`invalid cost policy: ${costPolicy}`);
  }

  const filters = [];
  const args = [];
  if (evidenceScope != null) {
    if (!["house", "tenant", "unattributed"].includes(evidenceScope)) {
      throw new Error(`invalid evidence scope: ${evidenceScope}`);
    }
    filters.push("r.evidence_scope=?"); args.push(evidenceScope);
  }
  if (floorNo === null) filters.push("r.floor_no IS NULL");
  else if (Number.isInteger(floorNo)) { filters.push("r.floor_no=?"); args.push(floorNo); }
  if (policyVersion != null) { filters.push("r.policy_version=?"); args.push(policyVersion); }
  if (promptManifestHash != null) {
    filters.push("r.prompt_manifest_hash=?"); args.push(promptManifestHash);
  }

  const raw = loadRuns({ horizonMin, filters, args });
  const { kept, droppedByArm, imputedCostPct } = applyCost(raw, costPolicy);

  const arms = {
    approved: armSummary(kept, "approved", droppedByArm),
    analystKilled: armSummary(kept, "analystKilled", droppedByArm),
  };
  const cycles = new Set(kept.map((r) => r.cycle)).size;
  const point = deltaOf(kept);

  const caveats = [
    "Observational, not causal: approved coins also tend to have better screen metrics, " +
    "so a positive delta conflates seat discrimination with agreement with already-" +
    "predictive metrics. Closing that needs the selection propensity recorded at " +
    "decision time, which nothing writes today.",
  ];
  if (costPolicy === "zero") {
    caveats.push("costPolicy='zero' reproduces the known bias: a run with no measured " +
      "round trip is charged nothing, and `unverified_exit` kills are exactly the runs " +
      "that have no measured round trip. The killed arm is flattered under this policy.");
  }
  if (costPolicy === "impute" && imputedCostPct !== null) {
    caveats.push(`Runs with no measured round trip were charged the median observed ` +
      `cost of ${imputedCostPct.toFixed(3)}%.`);
  }

  /* Refuse before reporting, on the same principle as insufficient_coverage: a number
     computed from four cycles is not evidence, and printing it invites acting on it. */
  if (cycles < minCycles || arms.approved.n < minPerArm || arms.analystKilled.n < minPerArm) {
    return {
      verdict: "INSUFFICIENT",
      reason: `need >=${minCycles} cycles and >=${minPerArm} runs per arm; have ` +
        `${cycles} cycles, approved ${arms.approved.n}, killed ${arms.analystKilled.n}`,
      horizonMin, costPolicy, cycles, arms, delta: null, bootstrap: null, caveats,
    };
  }

  const boot = bootstrapDelta(kept, { samples: bootstrapSamples, seed });

  let verdict = "NO_DETECTABLE_DIFFERENCE";
  if (boot.ci95) {
    if (boot.ci95[0] > 0) verdict = "SEATS_DISCRIMINATE";
    else if (boot.ci95[1] < 0) verdict = "SEATS_ANTI_DISCRIMINATE";
  } else {
    verdict = "INSUFFICIENT";
  }

  return {
    verdict,
    horizonMin,
    costPolicy,
    cycles,
    arms,
    delta: { pointPct: point, ci95Pct: boot.ci95 },
    bootstrap: {
      samples: bootstrapSamples, usable: boot.usable, skipped: boot.skipped,
      resampledUnit: "cycle", cycles: boot.cycles, seed,
    },
    caveats,
  };
}

/**
 * Which gates did the killing, among coins the seats actually judged. Not part of the
 * delta — it is the follow-up question a non-zero delta immediately raises, and it is
 * free once the rows are open.
 */
export function killBreakdown({ horizonMin = 1440 } = {}) {
  return db.prepare(
    `SELECT r.binding_gate AS gate, COUNT(*) AS n,
            AVG(m.gross_return_pct) AS mean_gross_pct
       FROM decision_runs r
       JOIN forward_marks m ON m.run_id = r.id
      WHERE m.horizon_min=? AND m.data_status=? AND r.outcome='killed'
            AND m.gross_return_pct IS NOT NULL
      GROUP BY r.binding_gate
      ORDER BY n DESC`,
  ).all(horizonMin, OBSERVED);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * THE CONTINUOUS FORM — BECAUSE THE BINARY ONE CANNOT RUN
 *
 * seatAlpha() above compares approved against analyst-killed. Run against the live
 * journal on 2026-09-10 it refused, and the refusal was the finding: the desk has
 * APPROVED TWO COINS, EVER (182 decided, of which WATCH 126, VETOED 32, PASS 22,
 * APPROVED 2; against 341 killed and 33,464 insufficient_coverage). A two-arm delta
 * needs an arm, and there is not one. Waiting for approvals to accumulate is not a plan
 * when the accounts are empty.
 *
 * But the question does not actually require the approval decision. The seats emit a
 * SCORE on every coin they judge, and the useful question — does a seat's opinion carry
 * information about what the coin then does? — is a correlation, not a contrast. That
 * has 500-odd rows of power today instead of two.
 *
 * WHY PER SEAT AND NOT PER PANEL. A killed coin stops the pipeline where it was killed,
 * so its panel is partial: two seats on some coins, four on others. A panel composite
 * built from two seats is not on the same footing as one built from four, and comparing
 * them would measure the seat mix as much as the judgement. Correlating WITHIN one
 * seat's own population has no such confound — every point comes from the same seat
 * scoring on the same dimension — and it answers the sharper question anyway, which is
 * WHICH seat predicts. That is the input the ablation needs.
 *
 * SPEARMAN, NOT PEARSON. Memecoin forward returns are savagely skewed: measured on this
 * journal at the 48h horizon, the killed population's MEAN net return is +140.6% while
 * its MEDIAN is -6.6%. A Pearson correlation on those levels would be a report about
 * three coins. Ranks are immune to that, and the question — do higher scores go with
 * better outcomes? — is a question about order, not magnitude.
 *
 * The clustering and cost discipline is identical to seatAlpha(), and so is the refusal:
 * a correlation from four cycles is not evidence.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/** Ranks with ties averaged — ties are common here because seats favour round scores. */
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman's rho on paired samples. Null when the sample is degenerate. */
export function spearman(pairs) {
  if (pairs.length < 3) return null;
  const rx = ranks(pairs.map((p) => p[0]));
  const ry = ranks(pairs.map((p) => p[1]));
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;      // every score identical, or every return
  return num / Math.sqrt(dx * dy);
}

/** Resample whole cycles, recompute a statistic, return a percentile interval. */
function bootstrapStat(items, statOf, { samples, seed }) {
  const byCycle = new Map();
  for (const it of items) {
    if (!byCycle.has(it.cycle)) byCycle.set(it.cycle, []);
    byCycle.get(it.cycle).push(it);
  }
  const cycles = [...byCycle.keys()];
  const rand = mulberry32(seed);
  const vals = [];
  let skipped = 0;
  for (let s = 0; s < samples; s++) {
    const drawn = [];
    for (let i = 0; i < cycles.length; i++) {
      drawn.push(...byCycle.get(cycles[Math.floor(rand() * cycles.length)]));
    }
    const v = statOf(drawn);
    if (v === null || !Number.isFinite(v)) { skipped++; continue; }
    vals.push(v);
  }
  if (vals.length < Math.max(20, samples * 0.5)) {
    return { ci95: null, skipped, usable: vals.length, cycles: cycles.length };
  }
  vals.sort((a, b) => a - b);
  const at = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))];
  return { ci95: [at(0.025), at(0.975)], skipped, usable: vals.length, cycles: cycles.length };
}

const rhoOf = (items) => spearman(items.map((i) => [i.score, i.net]));

/**
 * Does each seat's score carry information about what the coin then did?
 *
 * Reads every seat-judged run (decided OR killed — both had seats return) with an
 * observed mark at the horizon, pulls each seat's own score out of the stored record,
 * and correlates score against net forward return within that seat's population.
 */
export function seatScoreAlpha({
  horizonMin = 1440,
  costPolicy = "exclude",
  bootstrapSamples = 2000,
  minCycles = 8,
  minPerSeat = 30,
  seed = 20260911,
} = {}) {
  if (!["exclude", "impute", "zero"].includes(costPolicy)) {
    throw new Error(`invalid cost policy: ${costPolicy}`);
  }

  const rows = db.prepare(
    `SELECT r.cycle, r.outcome, r.round_trip_cost_pct AS cost, r.record_json,
            m.gross_return_pct AS gross
       FROM decision_runs r
       JOIN forward_marks m ON m.run_id = r.id
      WHERE m.horizon_min=? AND m.data_status=? AND m.gross_return_pct IS NOT NULL
            AND r.outcome IN ('decided','killed')
      ORDER BY r.decided_at ASC`,
  ).all(horizonMin, OBSERVED);

  /* Cost first, on exactly the same rule as the two-arm form: an uncosted run is
     dropped under the default rather than silently charged nothing. */
  const measured = rows.map((r) => r.cost).filter((c) => Number.isFinite(c) && c >= 0);
  const imputed = median(measured);
  const bySeat = new Map();
  let parsed = 0, unparsable = 0, droppedNoCost = 0;

  for (const row of rows) {
    const hasCost = Number.isFinite(row.cost) && row.cost >= 0;
    if (!hasCost && (costPolicy === "exclude" || (costPolicy === "impute" && imputed === null))) {
      droppedNoCost++; continue;
    }
    const charge = hasCost ? row.cost : (costPolicy === "impute" ? imputed : 0);
    const net = Number(row.gross) - Math.max(0, charge);

    let rec;
    try { rec = JSON.parse(row.record_json); } catch { unparsable++; continue; }
    const analysts = rec?.analysts;
    if (!analysts || typeof analysts !== "object") { unparsable++; continue; }
    parsed++;

    for (const [seat, verdict] of Object.entries(analysts)) {
      const score = Number(verdict?.score);
      if (!Number.isFinite(score)) continue;
      if (!bySeat.has(seat)) bySeat.set(seat, []);
      bySeat.get(seat).push({ cycle: String(row.cycle), score, net });
    }
  }

  const seats = {};
  for (const [seat, items] of [...bySeat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const cycles = new Set(items.map((i) => i.cycle)).size;
    const rho = rhoOf(items);
    const entry = {
      n: items.length, cycles,
      meanScore: mean(items.map((i) => i.score)),
      medianNetPct: median(items.map((i) => i.net)),
      rho, ci95: null, verdict: "INSUFFICIENT",
    };
    if (items.length >= minPerSeat && cycles >= minCycles && rho !== null) {
      const b = bootstrapStat(items, rhoOf, { samples: bootstrapSamples, seed });
      entry.ci95 = b.ci95;
      entry.bootstrap = { usable: b.usable, skipped: b.skipped, resampledUnit: "cycle" };
      if (!b.ci95) entry.verdict = "INSUFFICIENT";
      else if (b.ci95[0] > 0) entry.verdict = "PREDICTS";
      else if (b.ci95[1] < 0) entry.verdict = "ANTI_PREDICTS";
      else entry.verdict = "NO_SIGNAL";
    }
    seats[seat] = entry;
  }

  return {
    horizonMin, costPolicy,
    runs: { matched: rows.length, parsed, unparsable, droppedNoCost },
    seats,
    thresholds: { minCycles, minPerSeat },
    bootstrapSeed: seed,
    caveats: [
      "Spearman on ranks, not levels: this journal's 48h killed population has a mean " +
      "net return of +140.6% against a median of -6.6%, so a correlation on levels " +
      "would be a report about a handful of coins.",
      "Correlation is computed WITHIN each seat's own population, so it is not " +
      "confounded by the seat mix — a killed coin stops the pipeline and has a partial " +
      "panel, which is why no panel-level composite is reported here.",
      "Observational. A seat that scores high on coins that were going to run anyway " +
      "shows a correlation without adding judgement; only the selection propensity " +
      "recorded at decision time can separate those, and nothing writes it today.",
      "A seat is scored on the coins IT saw. Seats that run late see a survivor " +
      "population, so two seats' rho values are not directly comparable to each other.",
    ],
  };
}
