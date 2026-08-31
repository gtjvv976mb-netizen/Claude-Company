import db from "./src/lib/store.js";
import {
  HORIZONS_MIN,
  evaluationSummary,
  recordDecision,
  refreshForwardMarks,
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

const due = refreshForwardMarks([
  { mint: "ALPHA", pair: { priceUsd: 1.20 } },
  { mint: "BETA", pair: { priceUsd: 0.50 } },
], t0 + 15 * 60_000);
ok("both due 15-minute marks are stored", due.marked === 2, JSON.stringify(due));
const alpha15 = db.prepare("SELECT * FROM forward_marks WHERE run_id=? AND horizon_min=15").get(first);
ok("the observation timestamp is not before due_at", alpha15.observed_at >= alpha15.due_at);
ok("gross return uses the frozen entry", near(alpha15.gross_return_pct, 20), `${alpha15.gross_return_pct}%`);
ok("net return deducts retained round-trip cost", near(alpha15.net_return_pct, 18), `${alpha15.net_return_pct}%`);
ok("MAE excludes the pre-decision 90% print", near(alpha15.mae_pct, -20), `${alpha15.mae_pct}%`);
ok("MFE comes from the retained post-decision path", near(alpha15.mfe_pct, 30), `${alpha15.mfe_pct}%`);

const again = refreshForwardMarks([
  { mint: "ALPHA", pair: { priceUsd: 5 } },
  { mint: "BETA", pair: { priceUsd: 5 } },
], t0 + 15 * 60_000 + 1);
ok("a restart/repeated sweep cannot overwrite an observed horizon", again.marked === 0,
  JSON.stringify(again));
ok("the first observed mark remains intact",
  db.prepare("SELECT price_mid p FROM forward_marks WHERE run_id=? AND horizon_min=15").get(first).p === 1.2);

console.log("\nMISSING DATA IS EXPLICIT, NOT SILENTLY DROPPED");
const atOneHour = refreshForwardMarks([], t0 + 60 * 60_000);
ok("the grace window leaves a newly-due mark pending", atOneHour.unavailable === 0,
  JSON.stringify(atOneHour));
const afterGrace = refreshForwardMarks([], t0 + 120 * 60_000 + 1);
ok("after grace, both missing one-hour marks become unavailable", afterGrace.unavailable === 2,
  JSON.stringify(afterGrace));
ok("unavailable rows remain in the journal",
  db.prepare("SELECT COUNT(*) n FROM forward_marks WHERE horizon_min=60 AND data_status='unavailable'").get().n === 2);

console.log("\nTHE SCORECARD USES SIGNALS AND PRICES RED-TEAM OPPORTUNITY COST");
const summary = evaluationSummary({ horizonMin: 15, minSignals: 100 });
ok("two research runs produce two signals", summary.signals === 2, `signals=${summary.signals}`);
ok("the binding Red Team refusal is counted once", summary.redTeam.bindingSignals === 1,
  JSON.stringify(summary.redTeam));
ok("its -52% counterfactual is recorded as loss prevented",
  near(summary.redTeam.lossesPreventedPct, 52), JSON.stringify(summary.redTeam));
ok("two observations can never claim an edge", summary.edgeClaimable === false, summary.edgeNote);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
