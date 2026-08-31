import { enforceCeoRails, enforceRiskRails, retainedBookRiskUsd } from "./src/agents/risk-rails.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};
const near = (actual, expected, epsilon = 0.011) => Math.abs(actual - expected) <= epsilon;

const config = {
  equityUsd: 10_000,
  maxRiskPct: 1,
  maxBookRiskPct: 4,
  targetSizeUsd: 10_000,
  maxRoundTripSlippagePct: 8,
};
const ev = {
  pair: { priceUsd: 1 },
  exitProbe: { roundTripLossPct: 2 },
  mintAccount: { mintAuthority: null, freezeAuthority: null, flags: [] },
};
const model = {
  risk_tier: "full",
  stop_price: 0.60,
  stop_rationale: "the launch breaks",
  size_rationale: "complete evidence",
  liquidity_adjusted: false,
  portfolio_notes: "",
  confidence: 1,
  // Deliberate lies: production must overwrite all three.
  position_size_usd: 10_000,
  max_loss_usd: 1,
  pct_of_equity_at_risk: 0.01,
};
const run = (redteam = "survives", over = {}) => enforceRiskRails({
  risk: { ...model, ...(over.risk || {}) },
  ev: { ...ev, ...(over.ev || {}) },
  redteam: { verdict: redteam },
  openRiskUsd: over.openRiskUsd ?? 0,
  config: { ...config, ...(over.config || {}) },
});

console.log("\nLOSS-AT-STOP IS RECOMPUTED, NOT TRUSTED");
const full = run();
// 40% stop distance + 2% measured round trip = 42%; $100 / 42% = $238.10.
ok("position derives from the $100 budget and 42% loss fraction",
  near(full.position_size_usd, 238.10), `size=$${full.position_size_usd}`);
ok("max loss is recomputed to the configured ceiling", near(full.max_loss_usd, 100),
  `loss=$${full.max_loss_usd}`);
ok("risk percentage is recomputed", near(full.pct_of_equity_at_risk, 1, 0.0001),
  `${full.pct_of_equity_at_risk}%`);

console.log("\nRED TEAM AND BOOK HEAT CAN ONLY REDUCE RISK");
const retainedHeat = retainedBookRiskUsd([
  { desk_risk_usd: 25 }, { desk_risk_usd: null }, { desk_risk_usd: -10 },
], config);
ok("legacy live calls reserve one full idea budget", retainedHeat === 125,
  `$${retainedHeat} retained risk`);
const wounded = run("wounded");
const refuted = run("refuted");
ok("wounded is smaller than survives", wounded.max_loss_usd < full.max_loss_usd,
  `${wounded.max_loss_usd} < ${full.max_loss_usd}`);
ok("refuted is smaller than wounded", refuted.max_loss_usd < wounded.max_loss_usd,
  `${refuted.max_loss_usd} < ${wounded.max_loss_usd}`);
const almostFull = run("survives", { openRiskUsd: 390 });
ok("remaining book budget caps loss at $10", near(almostFull.max_loss_usd, 10),
  `loss=$${almostFull.max_loss_usd}`);
const fullBook = run("survives", { openRiskUsd: 400 });
ok("an exhausted book produces no authorization", fullBook.position_size_usd === 0,
  fullBook.rail_notes.join("; "));

console.log("\nTHE EXIT-PROBED NOTIONAL IS AN ABSOLUTE CEILING");
const probed = run("survives", { config: { targetSizeUsd: 75 } });
ok("size cannot exceed the measured $75 notional", probed.position_size_usd === 75,
  `size=$${probed.position_size_usd}`);
ok("the cap is audited", probed.liquidity_adjusted === true &&
  probed.rail_notes.some((n) => /exit-probe notional/.test(n)), probed.rail_notes.join("; "));

console.log("\nCEO MAY CUT, NEVER ENLARGE OR REVIVE");
const authorized = { position_size_usd: 75 };
const enlarged = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 500, size_change_reason: "" }, risk: authorized,
});
ok("oversized CEO order is capped to Risk", enlarged.order_size_usd === 75,
  `$${enlarged.order_size_usd}`);
const cut = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 20, size_change_reason: "" }, risk: authorized,
});
ok("a genuine CEO cut is preserved", cut.order_size_usd === 20);
const empty = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 0, size_change_reason: "" }, risk: authorized,
});
ok("zero-sized APPROVE becomes HOLD", empty.ruling === "HOLD" && empty.order_size_usd === 0,
  `${empty.ruling} $${empty.order_size_usd}`);
const decline = enforceCeoRails({
  ceo: { ruling: "DECLINE", order_size_usd: 50, size_change_reason: "" }, risk: authorized,
});
ok("DECLINE is always zero", decline.order_size_usd === 0);
const malformed = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: Infinity, size_change_reason: "" }, risk: authorized,
});
ok("non-finite approval fails to HOLD at zero",
  malformed.ruling === "HOLD" && malformed.order_size_usd === 0,
  `${malformed.ruling} $${malformed.order_size_usd}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
