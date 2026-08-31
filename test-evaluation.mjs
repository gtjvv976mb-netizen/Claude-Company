import db from "./src/lib/store.js";
import {
  HORIZONS_MIN,
  FORWARD_MARK_TOLERANCE_MS,
  POLICY_VERSION,
  evaluationSummary,
  linkPublishedCall,
  recordDecision,
  refreshForwardMarks,
  refreshSimulatedOutcomes,
} from "./src/evaluation.js";

// Create the retained market-path table before the evaluator queries it. Importing
// this module does not touch the network.
await import("./src/data/snapshots.js");

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};
const near = (actual, expected, epsilon = 0.01) => Math.abs(actual - expected) <= epsilon;

const t0 = 1_800_000_000_000;
const rec = (mint, over = {}) => ({
  mint,
  symbol: mint,
  outcome: "decided",
  finalDecision: "APPROVED",
  ev: { pair: { priceUsd: 1 }, exitProbe: { roundTripLossPct: 2 } },
  analysts: { narrative: { score: 70, confidence: 1 }, flow: { score: 60, confidence: 1 } },
  redteamRaw: { verdict: "survives" },
  redteam: { verdict: "survives" },
  risk: { position_size_usd: 50 },
  pm: { decision: "PROPOSE" },
  ...over,
});

console.log("\nONE RESEARCH RUN IS ONE IMMUTABLE SIGNAL");
const first = recordDecision("cycle-a", rec("ALPHA"), t0);
const duplicate = recordDecision("cycle-a", rec("ALPHA", { finalDecision: "DECLINED" }), t0 + 5_000);
ok("recording the same cycle+mint is idempotent", duplicate === first,
  `id ${first} == ${duplicate}`);
ok("only one decision row exists", db.prepare("SELECT COUNT(*) n FROM decision_runs").get().n === 1);
ok("every standard horizon was scheduled exactly once",
  db.prepare("SELECT COUNT(*) n FROM forward_marks WHERE run_id=?").get(first).n === HORIZONS_MIN.length,
  HORIZONS_MIN.join(","));

const beta = recordDecision("cycle-a", rec("BETA", {
  finalDecision: "WATCH",
  redteamRaw: { verdict: "refuted" },
  redteam: { verdict: "refuted" },
  pm: { decision: "WATCH" },
}), t0);
ok("a distinct mint is a second signal", beta !== first);

console.log("\nA HORIZON CAN NEVER LOOK INTO ITS OWN PAST");
const early = refreshForwardMarks([
  { mint: "ALPHA", pair: { priceUsd: 9 } },
  { mint: "BETA", pair: { priceUsd: 9 } },
], t0 + 15 * 60_000 - 1);
ok("a mark one millisecond early is ignored", early.due === 0 && early.marked === 0,
  JSON.stringify(early));

// An extreme pre-decision print must not contaminate MAE. Only [decided_at, observed]
// is eligible for the path extrema.
const addSnapshot = db.prepare(`INSERT INTO snapshots (mint,ts,price,liq,vol24,buys,sells,fdv)
                                VALUES (?,?,?,?,?,?,?,?)`);
addSnapshot.run("ALPHA", t0 - 1, 0.10, 10_000, 1, 1, 1, 1);
addSnapshot.run("ALPHA", t0 + 1_000, 0.80, 10_000, 1, 1, 1, 1);
addSnapshot.run("ALPHA", t0 + 10 * 60_000, 1.30, 10_000, 1, 1, 1, 1);

addSnapshot.run("ALPHA", t0 + 16 * 60_000, 1.20, 11_000, 1, 1, 1, 1);
addSnapshot.run("BETA", t0 + 17 * 60_000, 0.50, 9_000, 1, 1, 1, 1);
const atDue = refreshForwardMarks([], t0 + 15 * 60_000);
ok("a newly due horizon waits for its post-due observation window",
  atDue.marked === 0 && atDue.waiting === 2, JSON.stringify(atDue));
const due = refreshForwardMarks([], t0 + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS);
ok("both due 15-minute marks are stored", due.marked === 2, JSON.stringify(due));
const alpha15 = db.prepare("SELECT * FROM forward_marks WHERE run_id=? AND horizon_min=15").get(first);
ok("the observation timestamp is not before due_at", alpha15.observed_at >= alpha15.due_at);
ok("the retained endpoint records its bounded delay",
  alpha15.mark_method === "nearest_persisted_snapshot" && alpha15.mark_delay_ms === 60_000,
  `${alpha15.mark_method} +${alpha15.mark_delay_ms}ms`);
ok("gross return uses the frozen entry", near(alpha15.gross_return_pct, 20), `${alpha15.gross_return_pct}%`);
ok("net return deducts retained round-trip cost", near(alpha15.net_return_pct, 18), `${alpha15.net_return_pct}%`);
ok("MAE excludes the pre-decision 90% print", near(alpha15.mae_pct, -20), `${alpha15.mae_pct}%`);
ok("MFE comes from the retained post-decision path", near(alpha15.mfe_pct, 30), `${alpha15.mfe_pct}%`);

const again = refreshForwardMarks([
  { mint: "ALPHA", pair: { priceUsd: 5 } },
  { mint: "BETA", pair: { priceUsd: 5 } },
], t0 + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1);
ok("a restart/repeated sweep cannot overwrite an observed horizon", again.marked === 0,
  JSON.stringify(again));
ok("the first observed mark remains intact",
  db.prepare("SELECT price_mid p FROM forward_marks WHERE run_id=? AND horizon_min=15").get(first).p === 1.2);

console.log("\nMISSING DATA IS EXPLICIT, NOT SILENTLY DROPPED");
const atOneHour = refreshForwardMarks([], t0 + 60 * 60_000);
ok("the grace window leaves a newly-due mark pending", atOneHour.unavailable === 0,
  JSON.stringify(atOneHour));
const afterGrace = refreshForwardMarks([], t0 + 60 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1);
ok("after grace, both missing one-hour marks become unavailable", afterGrace.unavailable === 2,
  JSON.stringify(afterGrace));
ok("unavailable rows remain in the journal",
  db.prepare("SELECT COUNT(*) n FROM forward_marks WHERE horizon_min=60 AND data_status='unavailable'").get().n === 2);

console.log("\nTHE SCORECARD USES SIGNALS AND PRICES RED-TEAM OPPORTUNITY COST");
const summary = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1 });
ok("two research runs produce two signals", summary.signals === 2, `signals=${summary.signals}`);
ok("the binding Red Team refusal is counted once", summary.redTeam.bindingSignals === 1,
  JSON.stringify(summary.redTeam));
ok("its -52% counterfactual is recorded as loss prevented",
  near(summary.redTeam.lossesPreventedPct, 52), JSON.stringify(summary.redTeam));
ok("two observations can never claim an edge", summary.edgeClaimable === false, summary.edgeNote);

console.log("\nTHE PRIMARY COHORT IS WHAT THE DESK ACTUALLY PUBLISHED");
ok("a successfully opened call links idempotently to its immutable decision",
  linkPublishedCall(first, 101, { floorNo: null }) === true &&
  linkPublishedCall(first, 101, { floorNo: null }) === true);
ok("a decision cannot be relinked to a different call",
  linkPublishedCall(first, 102, { floorNo: null }) === false);
ok("a house publication cannot claim a tenant decision",
  linkPublishedCall(beta, 103, { floorNo: 7 }) === false);
const published = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1,
  decisionCohort: "published" });
const notPublished = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1,
  decisionCohort: "not-published" });
ok("published scorecard contains the selected call even when decision labels differ",
  published.signals === 1 && published.expectancyPct === 18, JSON.stringify(published));
ok("the counterfactual contains only decisions that never reached the call sheet",
  notPublished.signals === 1 && notPublished.expectancyPct === -52,
  JSON.stringify(notPublished));

console.log("\nDOWNTIME CANNOT COLLAPSE MULTIPLE HORIZONS ONTO ONE LATE PRICE");
const gamma = recordDecision("cycle-gap", rec("GAMMA"), t0);
addSnapshot.run("GAMMA", t0 + 6 * 60 * 60_000, 8, 10_000, 1, 1, 1, 1);
const afterGap = refreshForwardMarks([{ mint: "GAMMA", pair: { priceUsd: 8 } }],
  t0 + 6 * 60 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1);
const gap15 = db.prepare("SELECT data_status,price_mid FROM forward_marks WHERE run_id=? AND horizon_min=15").get(gamma);
const gap60 = db.prepare("SELECT data_status,price_mid FROM forward_marks WHERE run_id=? AND horizon_min=60").get(gamma);
ok("late live price is not backfilled into the 15-minute horizon",
  gap15.data_status === "unavailable" && gap15.price_mid == null, JSON.stringify(afterGap));
ok("the same late price is not backfilled into the one-hour horizon",
  gap60.data_status === "unavailable" && gap60.price_mid == null);

console.log("\nPOLICY REPLAY NEVER RELABELS HISTORICAL POLICY COHORTS");
const oldPolicy = "historical-policy-fixture";
const oldPolicyRun = recordDecision("cycle-old-policy", rec("OLDPOLICY"), t0);
db.prepare("UPDATE decision_runs SET policy_version=? WHERE id=?").run(oldPolicy, oldPolicyRun);
refreshSimulatedOutcomes(t0 + 48 * 60 * 60_000);
ok("a historical-policy run is not replayed by the current policy implementation",
  db.prepare("SELECT COUNT(*) n FROM simulated_outcomes WHERE run_id=?").get(oldPolicyRun).n === 0);
const oldPolicySummary = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 48 * 60 * 60_000, policyVersion: oldPolicy });
ok("a requested replay cohort reports its requested policy version",
  oldPolicySummary.policyReplay.version === oldPolicy,
  `${oldPolicySummary.policyReplay.version} != ${oldPolicy}`);
ok("the current policy version remains explicit", POLICY_VERSION.length > 0, POLICY_VERSION);

console.log("\nREPEATED RUNS OF ONE ASSET CANNOT MANUFACTURE PRECISION");
const template = db.prepare("SELECT * FROM decision_runs WHERE id=?").get(first);
const columns = Object.keys(template).filter((key) => key !== "id");
const clone = db.prepare(`INSERT INTO decision_runs (${columns.join(",")})
  VALUES (${columns.map(() => "?").join(",")})`);
const addClusterRun = (runKey, mint, netReturn) => {
  const row = { ...template, run_key: runKey, cycle: runKey, mint,
    behavior_fingerprint: "cluster-fixture", final_decision: "APPROVED",
    evidence_scope: "house", floor_no: null, published_call_id: null };
  const info = clone.run(...columns.map((key) => row[key]));
  db.prepare(`INSERT INTO forward_marks
    (run_id,horizon_min,due_at,observed_at,price_mid,gross_return_pct,net_return_pct,
     mae_pct,mfe_pct,data_status,mark_method,mark_delay_ms)
    VALUES (?,15,?,?,?,?,?,?,?,?,?,?)`).run(
      info.lastInsertRowid, t0 + 15 * 60_000, t0 + 16 * 60_000, 1,
      netReturn + 2, netReturn, Math.min(0, netReturn), Math.max(0, netReturn),
      "observed", "fixture", 60_000);
};
for (let i = 0; i < 100; i++) addClusterRun(`cluster-${i}`, `MINT${i}`, i % 2 ? -2 : 2);
const clusteredBefore = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 30 * 60_000 + 1, evidenceScope: "house",
  behaviorFingerprint: "cluster-fixture", decisionCohort: "approved" });
for (let i = 0; i < 500; i++) addClusterRun(`duplicate-${i}`, "MINT0", 2);
const clusteredAfter = evaluationSummary({ horizonMin: 15, minSignals: 100,
  nowMs: t0 + 30 * 60_000 + 1, evidenceScope: "house",
  behaviorFingerprint: "cluster-fixture", decisionCohort: "approved" });
ok("500 duplicate observations do not increase the independent asset count",
  clusteredAfter.signals === 600 && clusteredAfter.distinctMints === 100);
ok("duplicate observations leave clustered expectancy confidence unchanged",
  clusteredAfter.expectancyLow95Pct === clusteredBefore.expectancyLow95Pct,
  `${clusteredBefore.expectancyLow95Pct} -> ${clusteredAfter.expectancyLow95Pct}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
