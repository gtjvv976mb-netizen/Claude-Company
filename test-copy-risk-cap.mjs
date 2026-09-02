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
const { decide, saveSettings, settingsFor } = await import("./src/copy.js");
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
ok("a fixed size is honoured above the team's portable allocation",
  offered.verdict === "offered" && offered.sizeSol === 2,
  `${offered.verdict} ${offered.sizeSol} SOL \u2014 ${offered.reason}`);
ok("the delivery does not claim a cap it did not apply", !/capped to the team's/.test(offered.reason), offered.reason);
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
ok("a legacy call with no cap retains legacy sizing", legacyCall.verdict === "offered" && legacyCall.sizeSol === 2,
  `${legacyCall.verdict} ${legacyCall.sizeSol} SOL`);

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
