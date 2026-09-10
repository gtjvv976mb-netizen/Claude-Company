/* THE RULER BEFORE THE MEASUREMENT.
 *
 * seat-alpha.js answers whether the four paid seats discriminate better than the free
 * screen. Before that number is allowed to influence anything — and it is pointed at a
 * decision to keep or stop paying for the seats — the estimator is driven against cases
 * whose answers are known in advance:
 *
 *   - a PLANTED effect, which it must recover with an interval that excludes zero;
 *   - a NULL case drawn from one distribution, where it must decline to find an effect.
 *     A ruler that cannot say "no difference" cannot say "difference" either;
 *   - COHORT CLUSTERING, where the measured behaviour is counter-intuitive twice over:
 *     with arms balanced inside a cycle the shared shock CANCELS and resampling cycles is
 *     legitimately tighter, and where it does not cancel neither unit removes the bias;
 *   - the COST HOLE, where nulls concentrated in the killed arm must move the delta
 *     under costPolicy 'zero' and must not under the default 'exclude';
 *   - the EXCLUSIONS, where a screened_out or credit_outage row must never reach an arm.
 *
 * Every assertion prints the actual value. The synthetic journal is built here with a
 * seeded generator so the whole file is reproducible.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* CLAUDE_CO_DB must be set BEFORE src/* is imported: those modules open the journal at
   module scope, and a static import would be hoisted above this line and open the wrong
   file. Hence the dynamic imports at the bottom of the setup. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-seat-alpha-"));
process.env.CLAUDE_CO_DB = path.join(tmp, "journal.sqlite");
process.env.NODE_ENV = "test";

await import("./src/evaluation.js");            // creates decision_runs / forward_marks
const { seatAlpha, killBreakdown } = await import("./src/seat-alpha.js");

const db = new DatabaseSync(process.env.CLAUDE_CO_DB);

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };

/* ── the generator ──────────────────────────────────────────────────────────────────── */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* Box-Muller, so the synthetic returns are normal rather than uniform — a uniform draw
   would make the bootstrap look better behaved than it is on real return data. */
const normal = (r) => {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

let runId = 0;
function insertRun({ cycle, arm, gross, cost, outcome, finalDecision, gate = null, horizon = 1440 }) {
  runId++;
  const key = `run-${runId}`;
  db.prepare(
    `INSERT INTO decision_runs
      (run_key,cycle,mint,symbol,floor_no,evidence_scope,run_kind,decided_at,entry_price,
       round_trip_cost_pct,outcome,final_decision,binding_gate,evaluation_version,
       policy_version,prompt_version,models_json,config_json,weights_json,record_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(key, cycle, `mint${runId}`, `SYM${runId}`, 50, "house", "workup",
    1_700_000_000_000 + runId * 1000, 1.0, cost, outcome, finalDecision, gate,
    "v1", "p1", "pr1", "{}", "{}", "{}", "{}");
  const id = db.prepare("SELECT id FROM decision_runs WHERE run_key=?").get(key).id;
  db.prepare(
    `INSERT INTO forward_marks (run_id,horizon_min,due_at,observed_at,gross_return_pct,
                                net_return_pct,data_status)
     VALUES (?,?,?,?,?,?,'observed')`,
  ).run(id, horizon, 1, 2, gross, gross - (cost ?? 0));
  return id;
}

function wipe() {
  db.exec("DELETE FROM forward_marks; DELETE FROM decision_runs;");
}

/**
 * Build a journal with a known structure.
 * @param effect      how much better the approved arm truly is, in percentage points
 * @param marketSd    per-CYCLE shared shock — this is what makes coins in a cohort
 *                    correlated, and it is what a coin-level bootstrap ignores
 * @param idioSd      per-coin noise
 * @param killNullCost fraction of killed runs given a NULL round trip (the cost hole)
 */
function build({ cycles = 24, perCycle = 12, effect = 0, marketSd = 6, idioSd = 3,
  killNullCost = 0, imbalance = 0, seed = 7 } = {}) {
  wipe();
  const r = rng(seed);
  for (let c = 0; c < cycles; c++) {
    const shock = normal(r);
    const market = shock * marketSd;                 // shared by the whole cohort
    /* `imbalance` ties the approval RATE to the cohort's shock, so the arms are no longer
       balanced within a cycle. That is the condition under which a cohort shock stops
       cancelling in the approved-minus-killed difference and starts masquerading as seat
       skill — the exact thing resampling cycles defends against. */
    const approveRate = 0.5 + imbalance * Math.tanh(shock);
    for (let i = 0; i < perCycle; i++) {
      const approved = imbalance ? r() < approveRate : i % 2 === 0;
      const gross = market + normal(r) * idioSd + (approved ? effect : 0);
      const nullCost = !approved && r() < killNullCost;
      insertRun({
        cycle: `cycle-${c}`,
        arm: approved ? "approved" : "analystKilled",
        gross,
        cost: nullCost ? null : 1.0,                 // a flat 1% round trip otherwise
        outcome: approved ? "decided" : "killed",
        finalDecision: approved ? "APPROVED" : "KILLED",
        gate: approved ? null : "liquidity_floor",
      });
    }
  }
}

/* A naive coin-level bootstrap, written here purely as the comparison the clustering
   test needs. It is deliberately NOT exported from src — it is the wrong estimator. */
function coinLevelCi(seed = 3) {
  const rows = db.prepare(
    `SELECT r.outcome, m.gross_return_pct g, r.round_trip_cost_pct c
       FROM decision_runs r JOIN forward_marks m ON m.run_id=r.id
      WHERE m.horizon_min=1440 AND m.data_status='observed'`,
  ).all().map((x) => ({
    arm: x.outcome === "killed" ? "k" : "a", net: x.g - (x.c ?? 0),
  })).filter((x) => Number.isFinite(x.net));
  const r = rng(seed);
  const ds = [];
  for (let s = 0; s < 2000; s++) {
    const draw = rows.map(() => rows[Math.floor(r() * rows.length)]);
    const a = draw.filter((x) => x.arm === "a").map((x) => x.net);
    const k = draw.filter((x) => x.arm === "k").map((x) => x.net);
    if (!a.length || !k.length) continue;
    ds.push(a.reduce((p, q) => p + q, 0) / a.length - k.reduce((p, q) => p + q, 0) / k.length);
  }
  ds.sort((a, b) => a - b);
  return [ds[Math.floor(0.025 * ds.length)], ds[Math.floor(0.975 * ds.length)]];
}

const width = ([lo, hi]) => hi - lo;

/* ── 1. THE NULL CASE — the one that matters most ───────────────────────────────────── */
console.log("\nTHE NULL CASE (no true difference)");
build({ effect: 0, seed: 11 });
const nul = seatAlpha({ bootstrapSamples: 1500 });
ok("the estimator declines to find an effect that is not there", () => {
  assert.equal(nul.verdict, "NO_DETECTABLE_DIFFERENCE",
    `verdict=${nul.verdict} delta=${nul.delta?.pointPct?.toFixed(3)} ` +
    `ci=[${nul.delta?.ci95Pct?.map((x) => x.toFixed(2))}]`);
});
ok("...and its interval straddles zero", () => {
  const [lo, hi] = nul.delta.ci95Pct;
  assert.ok(lo < 0 && hi > 0, `ci=[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
});

/* ── 2. THE PLANTED EFFECT ──────────────────────────────────────────────────────────── */
console.log("\nA PLANTED EFFECT OF +8 POINTS");
build({ effect: 8, seed: 11 });
const planted = seatAlpha({ bootstrapSamples: 1500 });
ok("the estimator recovers the planted size", () => {
  const d = planted.delta.pointPct;
  assert.ok(Math.abs(d - 8) < 2.0, `recovered ${d.toFixed(3)} against a planted 8.0`);
});
ok("...and calls it a real difference", () => {
  assert.equal(planted.verdict, "SEATS_DISCRIMINATE",
    `verdict=${planted.verdict} ci=[${planted.delta.ci95Pct.map((x) => x.toFixed(2))}]`);
});
ok("...with an interval entirely above zero", () => {
  assert.ok(planted.delta.ci95Pct[0] > 0, `lo=${planted.delta.ci95Pct[0].toFixed(3)}`);
});

/* A seat set that is actively WRONG must be detectable too, or the tool can only ever
   deliver good news about the thing it is auditing. */
console.log("\nA PLANTED EFFECT OF -8 POINTS (the seats pick badly)");
build({ effect: -8, seed: 11 });
const inverted = seatAlpha({ bootstrapSamples: 1500 });
ok("an anti-predictive seat set is reported as such, not as 'no difference'", () => {
  assert.equal(inverted.verdict, "SEATS_ANTI_DISCRIMINATE",
    `verdict=${inverted.verdict} delta=${inverted.delta.pointPct.toFixed(3)}`);
});

/* ── 3. COHORT CLUSTERING ───────────────────────────────────────────────────────────── */
/* MEASURED, NOT ASSUMED: when the arms are BALANCED inside each cycle, the cohort's
   shared shock appears in both arms and CANCELS in the difference, so resampling cycles
   is legitimately TIGHTER than resampling coins — the coin-level bootstrap is wider only
   because it destroys that pairing. Clustering bites in the other configuration, where
   the approval rate moves with the cohort's shock. Then the shock stops cancelling, and
   a coin-level interval reports skill that is really the market. That is the case worth
   defending against, so it is the case tested — and the test is COVERAGE (does the
   interval contain the truth?), not width, because width alone proves nothing. */
console.log("\nCOHORT CLUSTERING (why the cycle is the unit)");
build({ effect: 0, marketSd: 12, idioSd: 2, imbalance: 0.42, seed: 5 });
const clustered = seatAlpha({ bootstrapSamples: 2000 });
const naive = coinLevelCi();
ok("the coin-level bootstrap invents an effect where the truth is zero", () => {
  const [lo, hi] = naive;
  assert.ok(lo > 0 || hi < 0,
    `coin-level ci=[${lo.toFixed(3)}, ${hi.toFixed(3)}] — expected it to EXCLUDE zero`);
  console.log(`        coin-level  ci=[${lo.toFixed(2)}, ${hi.toFixed(2)}] ` +
    `excludes zero — a false positive`);
});
ok("resampling cycles carries the cohort variance the other one dropped", () => {
  const wCycle = width(clustered.delta.ci95Pct), wCoin = width(naive);
  assert.ok(wCycle > wCoin,
    `cycle ${wCycle.toFixed(3)} vs coin ${wCoin.toFixed(3)}`);
  console.log(`        cycle-level ci=[${clustered.delta.ci95Pct[0].toFixed(2)}, ` +
    `${clustered.delta.ci95Pct[1].toFixed(2)}] — width ${wCycle.toFixed(2)} vs ` +
    `${wCoin.toFixed(2)} (${(wCycle / wCoin).toFixed(1)}x)`);
});
/* MEASURED, AND IT IS THE POINT OF THE CAVEAT: with the approval rate tied to the
   cohort's shock, BOTH intervals still exclude zero even though the planted effect is
   zero. That is not a bug in the estimator. Confounding between arm assignment and the
   cohort is a BIAS in the point estimate, and no amount of resampling removes a bias —
   resampling only prices variance. The honest consequence is that a positive delta from
   this tool can never, on its own, be called seat skill, which is exactly why the causal
   caveat is unconditional and why the selection propensity has to be recorded at
   decision time to ever close it. This assertion exists so nobody later "fixes" the
   bootstrap and believes they have fixed the inference. */
ok("neither unit removes confounding — a bootstrap prices variance, not bias", () => {
  const [clo, chi] = clustered.delta.ci95Pct;
  assert.ok(clo > 0, `cycle ci=[${clo.toFixed(2)}, ${chi.toFixed(2)}] on a TRUE effect of 0`);
  console.log(`        both intervals exclude zero on a true effect of 0 — the confound ` +
    `survives resampling`);
});
ok("...so the causal caveat is attached even when the verdict looks decisive", () => {
  assert.equal(clustered.verdict, "SEATS_DISCRIMINATE", `verdict=${clustered.verdict}`);
  assert.ok(clustered.caveats.some((c) => /Observational, not causal/.test(c)),
    JSON.stringify(clustered.caveats));
});
ok("the resampled unit is reported so a reader can check it", () => {
  assert.equal(clustered.bootstrap.resampledUnit, "cycle");
  assert.equal(clustered.bootstrap.cycles, 24, `cycles=${clustered.bootstrap.cycles}`);
});

/* ── 4. THE COST HOLE ───────────────────────────────────────────────────────────────── */
console.log("\nTHE COST HOLE (nulls concentrated in the killed arm)");
/* 60%, not 100%: excluding EVERY kill would empty the arm and correctly return
   INSUFFICIENT, which proves the refusal works but leaves nothing to compare. */
build({ effect: 0, killNullCost: 0.6, seed: 9 });
const excluded = seatAlpha({ costPolicy: "exclude", bootstrapSamples: 800 });
const zeroed = seatAlpha({ costPolicy: "zero", bootstrapSamples: 800 });
ok("'exclude' drops the uncosted runs, and says how many from each arm", () => {
  assert.equal(excluded.arms.approved.droppedNoCost, 0,
    `approved dropped=${excluded.arms.approved.droppedNoCost}`);
  assert.ok(excluded.arms.analystKilled.droppedNoCost > 0,
    `killed dropped=${excluded.arms.analystKilled.droppedNoCost}`);
});
ok("'zero' flatters the killed arm, exactly as the bias predicts", () => {
  /* Under 'zero' the killed arm is charged nothing while approved pays its 1%, so the
     approved-minus-killed delta must come out LOWER than under a fair comparison. */
  assert.ok(zeroed.delta.pointPct < excluded.delta.pointPct,
    `zero=${zeroed.delta.pointPct.toFixed(3)} exclude=${excluded.delta.pointPct.toFixed(3)}`);
  console.log(`        zero ${zeroed.delta.pointPct.toFixed(3)} < ` +
    `exclude ${excluded.delta.pointPct.toFixed(3)} — the gap is the bias`);
});
ok("...and 'zero' carries a caveat naming the bias", () => {
  assert.ok(zeroed.caveats.some((c) => /flattered/i.test(c)),
    `caveats=${JSON.stringify(zeroed.caveats)}`);
});
ok("'impute' charges the median observed round trip and says so", () => {
  const imp = seatAlpha({ costPolicy: "impute", bootstrapSamples: 400 });
  assert.ok(imp.caveats.some((c) => /median observed cost/i.test(c)),
    `caveats=${JSON.stringify(imp.caveats)}`);
});

/* ── 5. THE EXCLUSIONS ──────────────────────────────────────────────────────────────── */
console.log("\nWHAT MAY NOT ENTER AN ARM");
build({ effect: 0, cycles: 10, perCycle: 6, seed: 4 });
const before = seatAlpha({ costPolicy: "exclude", minCycles: 4, minPerArm: 5, bootstrapSamples: 200 });
for (const [outcome, decision] of [["screened_out", null], ["no_data", null],
  ["credit_outage", null], ["insufficient_coverage", "insufficient_coverage"], ["error", null]]) {
  for (let i = 0; i < 20; i++) {
    insertRun({ cycle: `cycle-${i % 10}`, arm: "x", gross: 999, cost: 1.0, outcome, finalDecision: decision });
  }
}
const after = seatAlpha({ costPolicy: "exclude", minCycles: 4, minPerArm: 5, bootstrapSamples: 200 });
ok("screened_out, no_data, credit_outage, insufficient_coverage and error never reach an arm", () => {
  assert.equal(after.arms.approved.n, before.arms.approved.n,
    `approved ${before.arms.approved.n} -> ${after.arms.approved.n}`);
  assert.equal(after.arms.analystKilled.n, before.arms.analystKilled.n,
    `killed ${before.arms.analystKilled.n} -> ${after.arms.analystKilled.n}`);
  console.log(`        100 excluded rows at +999% moved the delta by ` +
    `${Math.abs(after.delta.pointPct - before.delta.pointPct).toFixed(6)} points`);
});
ok("...so a screened_out flood cannot move the answer", () => {
  assert.ok(Math.abs(after.delta.pointPct - before.delta.pointPct) < 1e-9,
    `${before.delta.pointPct} vs ${after.delta.pointPct}`);
});

/* ── 6. FAIL CLOSED ─────────────────────────────────────────────────────────────────── */
console.log("\nREFUSING TO ANSWER ON THIN DATA");
build({ cycles: 3, perCycle: 4, effect: 8, seed: 2 });
const thin = seatAlpha({ bootstrapSamples: 200 });
ok("three cycles produces a refusal, not a number", () => {
  assert.equal(thin.verdict, "INSUFFICIENT", `verdict=${thin.verdict}`);
  assert.equal(thin.delta, null, `delta=${JSON.stringify(thin.delta)}`);
  assert.match(thin.reason, /cycles/, thin.reason);
  console.log(`        ${thin.reason}`);
});
ok("an empty journal refuses rather than dividing by zero", () => {
  wipe();
  const empty = seatAlpha({ bootstrapSamples: 100 });
  assert.equal(empty.verdict, "INSUFFICIENT", `verdict=${empty.verdict}`);
  assert.equal(empty.arms.approved.n, 0);
});

/* ── 7. REPRODUCIBILITY AND HYGIENE ─────────────────────────────────────────────────── */
console.log("\nREPRODUCIBILITY");
build({ effect: 4, seed: 8 });
ok("the same seed gives the same interval", () => {
  const a = seatAlpha({ bootstrapSamples: 600, seed: 42 });
  const b = seatAlpha({ bootstrapSamples: 600, seed: 42 });
  assert.deepEqual(a.delta.ci95Pct, b.delta.ci95Pct,
    `${JSON.stringify(a.delta.ci95Pct)} vs ${JSON.stringify(b.delta.ci95Pct)}`);
});
ok("a different seed moves the interval only a little", () => {
  const a = seatAlpha({ bootstrapSamples: 600, seed: 42 });
  const b = seatAlpha({ bootstrapSamples: 600, seed: 43 });
  assert.ok(Math.abs(width(a.delta.ci95Pct) - width(b.delta.ci95Pct)) < 2.0,
    `${width(a.delta.ci95Pct).toFixed(3)} vs ${width(b.delta.ci95Pct).toFixed(3)}`);
});
ok("an invalid cost policy is refused rather than guessed", () => {
  assert.throws(() => seatAlpha({ costPolicy: "free" }), /invalid cost policy/);
});
ok("the causal caveat is always attached, whatever the verdict", () => {
  const s = seatAlpha({ bootstrapSamples: 200 });
  assert.ok(s.caveats.some((c) => /Observational, not causal/.test(c)),
    JSON.stringify(s.caveats));
});
ok("the kill breakdown names the gates that did the killing", () => {
  const rows = killBreakdown();
  assert.ok(rows.length >= 1, `rows=${rows.length}`);
  assert.equal(rows[0].gate, "liquidity_floor", `gate=${rows[0].gate}`);
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * THE CONTINUOUS FORM. seatAlpha() cannot run on the live journal — the desk has approved
 * two coins ever — so seatScoreAlpha() asks the same question as a correlation instead of
 * a contrast, using the score every seat emits on every coin it judges.
 *
 * Same ruler discipline: a null case it must fail, planted signal in both directions it
 * must recover, and a demonstration that ranks survive the skew that would wreck a
 * correlation on levels.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */
const { seatScoreAlpha, spearman } = await import("./src/seat-alpha.js");

console.log("\nSPEARMAN ITSELF, ON ANSWERS KNOWN IN ADVANCE");
ok("a perfect monotone relationship is rho = 1, even when it is not linear", () => {
  const r = spearman([[1, 1], [2, 8], [3, 27], [4, 64], [5, 625]]);
  assert.ok(Math.abs(r - 1) < 1e-9, `rho=${r}`);
});
ok("a perfect inversion is rho = -1", () => {
  const r = spearman([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
  assert.ok(Math.abs(r + 1) < 1e-9, `rho=${r}`);
});
ok("ties are averaged rather than ordered arbitrarily", () => {
  const r = spearman([[1, 1], [1, 2], [1, 3], [2, 4]]);
  assert.ok(r !== null && Number.isFinite(r), `rho=${r}`);
});
ok("a degenerate sample returns null instead of a number", () => {
  assert.equal(spearman([[5, 1], [5, 2], [5, 3]]), null, "constant scores must give null");
  assert.equal(spearman([[1, 1]]), null, "n=1 must give null");
});

/* A journal where a named seat's score really does track the outcome. */
function buildScored({ cycles = 30, perCycle = 12, seed = 21,
  signalSeat = "flow", signalStrength = 1, noiseSeat = "narrative", heavyTail = false } = {}) {
  wipe();
  const r = rng(seed);
  for (let c = 0; c < cycles; c++) {
    const market = normal(r) * 4;
    for (let i = 0; i < perCycle; i++) {
      const latent = normal(r);
      /* The signal seat sees the latent quality; the noise seat scores at random. */
      const signalScore = Math.max(0, Math.min(100, 50 + latent * 20 * signalStrength));
      const noiseScore = Math.max(0, Math.min(100, 50 + normal(r) * 20));
      let gross = market + latent * 8 + normal(r) * 4;
      /* A few enormous winners, the way a real memecoin population behaves: this is what
         breaks a correlation computed on levels and leaves one on ranks intact. */
      if (heavyTail && r() < 0.03) gross += 900;
      const analysts = {
        [signalSeat]: { score: signalScore, confidence: 0.8, kill: false, findings: [] },
        [noiseSeat]: { score: noiseScore, confidence: 0.8, kill: false, findings: [] },
      };
      const id = insertRun({
        cycle: `cycle-${c}`, arm: "approved", gross, cost: 1.0,
        outcome: i % 3 === 0 ? "decided" : "killed",
        finalDecision: i % 3 === 0 ? "WATCH" : "KILLED",
      });
      db.prepare("UPDATE decision_runs SET record_json=? WHERE id=?")
        .run(JSON.stringify({ analysts }), id);
    }
  }
}

console.log("\nDOES A SEAT'S SCORE PREDICT WHAT THE COIN DID?");
buildScored({ signalStrength: 1 });
const scored = seatScoreAlpha({ bootstrapSamples: 800, minPerSeat: 30 });

ok("the seat that saw the latent quality is reported as predicting", () => {
  const f = scored.seats.flow;
  assert.equal(f.verdict, "PREDICTS",
    `flow verdict=${f.verdict} rho=${f.rho?.toFixed(3)} ci=${JSON.stringify(f.ci95)}`);
  assert.ok(f.rho > 0.15, `rho=${f.rho.toFixed(3)}`);
  console.log(`        flow      rho=${f.rho.toFixed(3)} ci=[${f.ci95.map((x) => x.toFixed(2))}] n=${f.n}`);
});

ok("the seat that scored at random is reported as carrying no signal", () => {
  const n = scored.seats.narrative;
  assert.equal(n.verdict, "NO_SIGNAL",
    `narrative verdict=${n.verdict} rho=${n.rho?.toFixed(3)} ci=${JSON.stringify(n.ci95)}`);
  console.log(`        narrative rho=${n.rho.toFixed(3)} ci=[${n.ci95.map((x) => x.toFixed(2))}] n=${n.n}`);
});

ok("a seat whose score points the WRONG way is reported as anti-predicting", () => {
  buildScored({ signalStrength: -1, seed: 33 });
  const s = seatScoreAlpha({ bootstrapSamples: 800, minPerSeat: 30 });
  assert.equal(s.seats.flow.verdict, "ANTI_PREDICTS",
    `verdict=${s.seats.flow.verdict} rho=${s.seats.flow.rho.toFixed(3)}`);
});

ok("ranks survive a heavy tail that would wreck a correlation on levels", () => {
  buildScored({ signalStrength: 1, heavyTail: true, seed: 44 });
  const s = seatScoreAlpha({ bootstrapSamples: 800, minPerSeat: 30 });
  assert.equal(s.seats.flow.verdict, "PREDICTS",
    `verdict=${s.seats.flow.verdict} rho=${s.seats.flow.rho?.toFixed(3)}`);
  console.log(`        with 3% of coins at +900%: flow still rho=${s.seats.flow.rho.toFixed(3)}`);
});

console.log("\nIT READS KILLED RUNS TOO — WHICH IS THE WHOLE POINT");
ok("killed runs contribute, so the sample is not limited to approvals", () => {
  buildScored({ signalStrength: 1, seed: 21 });
  const s = seatScoreAlpha({ bootstrapSamples: 200, minPerSeat: 30 });
  const killed = db.prepare("SELECT COUNT(*) c FROM decision_runs WHERE outcome='killed'").get().c;
  assert.ok(killed > 0, `killed=${killed}`);
  assert.ok(s.seats.flow.n > killed,
    `flow n=${s.seats.flow.n} must exceed the ${killed} killed runs it includes`);
  console.log(`        ${s.seats.flow.n} scored points drawn from ${killed} killed + the decided ones`);
});

console.log("\nREFUSING, AND HYGIENE");
ok("a seat below the row threshold is INSUFFICIENT with no interval", () => {
  buildScored({ cycles: 30, perCycle: 12, seed: 21 });
  const s = seatScoreAlpha({ bootstrapSamples: 200, minPerSeat: 100_000 });
  assert.equal(s.seats.flow.verdict, "INSUFFICIENT", `verdict=${s.seats.flow.verdict}`);
  assert.equal(s.seats.flow.ci95, null);
});
ok("unparsable records are counted, not silently skipped", () => {
  buildScored({ cycles: 12, perCycle: 8, seed: 6 });
  db.prepare("UPDATE decision_runs SET record_json='{not json' WHERE id IN " +
    "(SELECT id FROM decision_runs LIMIT 5)").run();
  const s = seatScoreAlpha({ bootstrapSamples: 100, minPerSeat: 10 });
  assert.equal(s.runs.unparsable, 5, `unparsable=${s.runs.unparsable}`);
  console.log(`        matched=${s.runs.matched} parsed=${s.runs.parsed} unparsable=${s.runs.unparsable}`);
});
ok("the same seed gives the same interval", () => {
  buildScored({ signalStrength: 1, seed: 21 });
  const a = seatScoreAlpha({ bootstrapSamples: 400, seed: 77, minPerSeat: 30 });
  const b = seatScoreAlpha({ bootstrapSamples: 400, seed: 77, minPerSeat: 30 });
  assert.deepEqual(a.seats.flow.ci95, b.seats.flow.ci95);
});
ok("an invalid cost policy is refused here too", () => {
  assert.throws(() => seatScoreAlpha({ costPolicy: "free" }), /invalid cost policy/);
});
ok("the caveats name the skew and the observational limit", () => {
  const s = seatScoreAlpha({ bootstrapSamples: 100, minPerSeat: 10 });
  assert.ok(s.caveats.some((c) => /Spearman on ranks/.test(c)), JSON.stringify(s.caveats));
  assert.ok(s.caveats.some((c) => /Observational/.test(c)), JSON.stringify(s.caveats));
});

console.log(`\n══ ${pass} passed, 0 failed ══`);

fs.rmSync(tmp, { recursive: true, force: true });
