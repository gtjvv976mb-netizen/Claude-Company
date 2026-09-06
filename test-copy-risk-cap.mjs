import { DatabaseSync } from "node:sqlite";

if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");

// Reproduce the production shape that existed before the data migration. This must be
// created before copy.js is imported because migrations run at module initialization.
const legacy = new DatabaseSync(process.env.CLAUDE_CO_DB);
legacy.exec(`
  CREATE TABLE copy_settings (
    floor_no INTEGER PRIMARY KEY,
    appetite TEXT NOT NULL DEFAULT 'balanced',
    bankroll_sol REAL NOT NULL DEFAULT 5,
    auto INTEGER NOT NULL DEFAULT 0,
    categories TEXT,
    launchpads TEXT,
    updated_at INTEGER
  );
  INSERT INTO copy_settings
    (floor_no,appetite,bankroll_sol,auto,categories,launchpads,updated_at)
  VALUES (50,'balanced',5,0,NULL,NULL,1);
`);
legacy.close();

const db = (await import("./src/lib/store.js")).default;
const { decide, saveSettings, settingsFor, probeSizeCapSol } = await import("./src/copy.js");
const { getCall, openCall } = await import("./src/calls.js");
const { eligibility } = await import("./src/mandate.js");

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

console.log("\nTHE LEGACY HQ SETTING IS MIGRATED ONCE");
const migrated = settingsFor(50);
ok("legacy balanced HQ becomes aggressive", migrated.appetite === "aggressive", migrated.appetite);
ok("the migrated HQ admits the desk's memecoins", migrated.categories.includes("memecoin"),
  migrated.categories.join(","));
ok("the migration is durably recorded",
  db.prepare("SELECT COUNT(*) n FROM data_migrations WHERE name='2026-08-31-hq-memecoin-appetite'").get().n === 1);

console.log("\nTHE TEAM'S PORTABLE SIZE SURVIVES CALL PERSISTENCE");
saveSettings(50, { appetite: "aggressive", bankrollSol: 10, fixedSol: 2 });
const opened = openCall({
  mint: "RiskCap111111111111111111111111111111111111",
  symbol: "CAP",
  category: "memecoin",
  launchpad: "pump.fun",
  conviction: 90,
  entryRef: 1,
  stop: 0.6,
  target: 2,
  thesis: "the cap follows the call",
  invalidation: "stop",
  liqUsd: 100_000,
  mcapUsd: 500_000,
  deskSizeUsd: 50,
  deskRiskUsd: 21,
  deskEquityUsd: 10_000,
});
const stored = getCall(opened.id);
ok("authorized size is stored", stored.desk_size_usd === 50, `$${stored.desk_size_usd}`);
ok("authorized max loss is stored", stored.desk_risk_usd === 21, `$${stored.desk_risk_usd}`);
ok("the source equity is stored", stored.desk_equity_usd === 10_000, `$${stored.desk_equity_usd}`);

const offered = decide(50, stored);
// $50 / $10,000 = 0.5% of the declared 10 SOL bankroll = 0.05 SOL \u2014 the cap that
// AUTO sizing lives under. A FIXED size is the operator's own number (2026-09-02,
// the owner's call): on the house floor the proportional cap turned an explicit
// 0.2 SOL into 0.0006 and then "lifted" it to the 0.02 fee floor on every trade.
// Fixed means fixed; a zero authorization (below) is still never revived.
//
// The expected number here was 2 SOL until 2026-09-07. It is now the EXIT PROBE cap
// (cfg.targetSizeUsd / SOL price = $15 / $103 = 0.1456 SOL), because a delivery may
// never exceed the notional the desk actually proved it could exit \u2014 see
// probeSizeCapSol in copy.js. That is a different ceiling from the one this test
// guards: "fixed means fixed" settles who chooses the SIZE (not the team's 0.5% book
// allocation), never whether the desk may deliver beyond its own cost evidence. So the
// assertion keeps its subject \u2014 the team's allocation did not shrink this order to
// 0.05 \u2014 and adds the ceiling that did bind, and the disclosure of it.
const probeCap = probeSizeCapSol();
ok("a fixed size is not shrunk to the team's portable allocation",
  offered.verdict === "offered" && offered.sizeSol !== 0.05 && offered.sizeSol === probeCap.capSol,
  `${offered.verdict} ${offered.sizeSol} SOL \u2014 ${offered.reason}`);
ok("the delivery does not claim a cap it did not apply", !/capped to the team's/.test(offered.reason), offered.reason);
ok("...and the cap that DID bind is the exit probe, disclosed by name",
  offered.probeCapBinds === true && /exit probe measures a round trip at \$/.test(offered.reason),
  `probe cap ${probeCap.capSol} SOL at $${probeCap.targetSizeUsd} / SOL $${probeCap.solUsd}`);
saveSettings(50, { fixedSol: "auto" });
const autoSized = decide(50, stored);
saveSettings(50, { fixedSol: 2 });
ok("AUTO sizing is still capped to the team's portable allocation",
  autoSized.verdict === "offered" && autoSized.sizeSol === 0.05,
  `${autoSized.verdict} ${autoSized.sizeSol} SOL \u2014 ${autoSized.reason}`);
ok("and the delivery says so", /capped to the team's/.test(autoSized.reason), autoSized.reason);

console.log("\nZERO IS AN EXPLICIT CAP; NULL ALONE MEANS LEGACY");
const zero = decide(50, { ...stored, desk_size_usd: 0 });
ok("an explicit zero cap is never revived", zero.verdict === "skipped",
  `${zero.verdict}: ${zero.reason}`);
const legacyCall = decide(50, { ...stored, desk_size_usd: null, desk_equity_usd: null });
// Legacy = no portable desk cap on the call, so the team allocation cannot bind. The
// exit-probe cap still does: it is a property of what this desk has MEASURED, not of
// what any one call happened to carry, and a legacy row is no reason to deliver more
// than the probe cleared.
ok("a legacy call with no cap keeps the tenant's size, bounded only by the probe",
  legacyCall.verdict === "offered" && legacyCall.sizeSol === probeCap.capSol,
  `${legacyCall.verdict} ${legacyCall.sizeSol} SOL (asked 2, probe cap ${probeCap.capSol})`);

console.log("\nTHE PUBLICATION GATE ALSO REFUSES ZERO AUTHORIZATION");
const eligibleRecord = (size) => ({
  mint: "Gate111111111111111111111111111111111111111",
  outcome: "decided",
  finalDecision: "APPROVED",
  pm: { decision: "PROPOSE", conviction: 70, invalidation: "stop" },
  redteam: { verdict: "survives" },
  compliance: { pass: true, violations: [] },
  risk: { position_size_usd: size },
  ceo: { ruling: size > 0 ? "APPROVE" : "HOLD", order_size_usd: size },
  order: { size },
  ticket: { stop_price: 0.6 },
  ev: { pair: { priceUsd: 1, priceChange: { m5: 0 } } },
});
const noSize = eligibility(eligibleRecord(0));
ok("zero authorization is ineligible", !noSize.eligible && noSize.safety,
  noSize.reason);
ok("a positive authorization remains eligible", eligibility(eligibleRecord(50)).eligible === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
