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

/* ═══════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE USED TO ASSERT, AND WHY IT NOW ASSERTS THE OPPOSITE.
 *
 * It was the test for decide()'s per-floor SIZING. It proved that "fixed means fixed"
 * (an explicit fixed_sol was not shrunk to the team's fraction-of-book allocation), that
 * AUTO sizing WAS shrunk to it, and — after bb4ae05 — that both were then capped to the
 * SOL value of the desk's exit probe. Three ceilings, each with its own reason string,
 * all authored by a desk that does not own the wallet.
 *
 * THE OWNER'S RULE (2026-09-07, stated three times and final): the desk says only WHAT
 * and WHEN. Never how much, never fees, never costs, never balance. So decide() no
 * longer computes a size at all, and none of those three ceilings exists to be tested.
 *
 * The coverage is not dropped, it is inverted: the same three levers are pulled and the
 * delivery must be IDENTICAL every time. That is a stronger property than any of the old
 * assertions — "the desk did not shrink this one" was a claim about one path, while
 * "nothing the tenant configures changes what the desk sends" closes all of them at
 * once. The desk's own paper record (desk_size_usd, desk_risk_usd, desk_equity_usd) is
 * still stored on the call, because the evaluation pass grades against it; the test that
 * it never reaches a delivery is below.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
console.log("\nTHE DESK'S PAPER RECORD IS STILL STORED ON THE CALL");
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
ok("the desk's recorded size is stored", stored.desk_size_usd === 50, `$${stored.desk_size_usd}`);
ok("the recorded max loss is stored", stored.desk_risk_usd === 21, `$${stored.desk_risk_usd}`);
ok("the source equity is stored", stored.desk_equity_usd === 10_000, `$${stored.desk_equity_usd}`);

console.log("\n...AND IT REACHES NO DELIVERY, WHATEVER THE FLOOR HAS CONFIGURED");
/* THE THREE LEVERS THAT USED TO MOVE THE NUMBER, pulled hard in both directions. A
   fixed size of 2 SOL against a 10 SOL bankroll; AUTO, which the team's 0.5%
   book allocation ($50/$10,000) used to shrink to 0.05 SOL; and a 0.001 SOL fixed size
   that used to be lifted to the 0.02 SOL fee floor or refused outright. */
const deliveries = [];
for (const [label, patch] of [
  ["fixed 2 SOL", { fixedSol: 2 }],
  ["AUTO", { fixedSol: "auto" }],
  ["fixed 0.001 SOL (under the old fee floor)", { fixedSol: 0.001 }],
  ["a 0.2 SOL bankroll", { fixedSol: "auto", bankrollSol: 0.2 }],
]) {
  saveSettings(50, patch);
  const d = decide(50, stored);
  deliveries.push({ label, d });
  ok(`${label}: offered with no size`, d.verdict === "offered" && d.sizeSol === null
    && d.sizeBinding === false, `${d.verdict} sizeSol=${d.sizeSol}`);
}
saveSettings(50, { fixedSol: 2, bankrollSol: 10 });
ok("every configuration produces the SAME delivery — the tenant's settings move nothing",
  new Set(deliveries.map((x) => x.d.reason)).size === 1,
  [...new Set(deliveries.map((x) => x.d.reason))].join(" || "));
ok("...and none of them claims a cap the desk did not apply",
  deliveries.every((x) => !/capped to/.test(x.d.reason)), deliveries[0].d.reason);
ok("...and none of them was SKIPPED for being too small to clear the fees",
  deliveries.every((x) => x.d.verdict === "offered"),
  deliveries.filter((x) => x.d.verdict !== "offered").map((x) => `${x.label}: ${x.d.reason}`).join(" | ") || "none skipped");

console.log("\nA ZERO PAPER AUTHORIZATION NO LONGER SUPPRESSES THE CALL EITHER");
/* This used to be "an explicit zero cap is never revived": desk_size_usd of 0 made
   decide() skip the floor entirely. It is the same mistake as the fee floor, in its most
   revealing form — a number on the DESK's paper book deciding whether a tenant's bot
   hears about a coin at all. The publication gate below is where a zero authorization
   still stops a call, and that is the right place: it stops the desk PUBLISHING, not one
   floor's delivery of something already published. */
const zero = decide(50, { ...stored, desk_size_usd: 0 });
ok("a zero paper size does not suppress the delivery",
  zero.verdict === "offered" && zero.sizeSol === null, `${zero.verdict}: ${zero.reason}`);
const legacyCall = decide(50, { ...stored, desk_size_usd: null, desk_equity_usd: null });
ok("a legacy call with no paper record is delivered identically",
  legacyCall.verdict === "offered" && legacyCall.reason === zero.reason,
  `${legacyCall.verdict}: ${legacyCall.reason}`);

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
/* THE ONE PLACE A ZERO SIZE STILL STOPS SOMETHING, and it is a publication gate rather
   than a money gate: a workup the desk's own seats sized at zero is a workup with no
   thesis behind it, and publishing it would put a call on the board that the desk does
   not believe in. It says nothing about anyone's wallet. */
const noSize = eligibility(eligibleRecord(0));
ok("zero authorization is ineligible", !noSize.eligible && noSize.safety,
  noSize.reason);
ok("a positive authorization remains eligible", eligibility(eligibleRecord(50)).eligible === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
