/**
 * Zero is a mechanical result, never a model-confidence verdict.
 *
 * This imports the exact production rail. The previous test copied the predicate out
 * of desk.js and could stay green while production drifted around it.
 */
import { enforceRiskRails } from "./src/agents/risk-rails.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

const config = {
  equityUsd: 10_000,
  maxRiskPct: 1,
  maxBookRiskPct: 4,
  targetSizeUsd: 75,
  maxRoundTripSlippagePct: 8,
};
const judgement = {
  risk_tier: "quarter",
  stop_price: 0.60,
  stop_rationale: "the launch structure failed",
  size_rationale: "small forward sample",
  liquidity_adjusted: false,
  portfolio_notes: "",
  confidence: 1,
};
const evidence = (over = {}) => ({
  pair: { priceUsd: over.price ?? 1 },
  exitProbe: over.probe === null
    ? { roundTripLossPct: null, error: "no route" }
    : { roundTripLossPct: over.probe ?? 2 },
  mintAccount: {
    mintAuthority: over.mintAuthority ?? null,
    freezeAuthority: over.freezeAuthority ?? null,
    flags: over.flags ?? [],
  },
});
const rail = (ev, risk = judgement) => enforceRiskRails({
  risk, ev, redteam: { verdict: "survives" }, config,
});

console.log("\nA TRADEABLE COIN GETS A REAL, CODE-DERIVED SIZE");
const clean = rail(evidence());
ok("clean exit + renounced authorities is non-zero", clean.position_size_usd > 0,
  `size=$${clean.position_size_usd}`);
ok("the result carries deterministic audit notes",
  clean.rail_notes.some((n) => /converted to/.test(n)), clean.rail_notes.join("; "));

console.log("\nMECHANICAL FAILURES ARE ZERO");
for (const [name, ev] of [
  ["unmeasured exit", evidence({ probe: null })],
  ["exit above the ceiling", evidence({ probe: 8.01 })],
  ["live mint authority", evidence({ mintAuthority: "MintAuth111" })],
  ["live freeze authority", evidence({ freezeAuthority: "FreezeAuth111" })],
]) {
  const r = rail(ev);
  ok(`${name} -> zero`, r.position_size_usd === 0, r.rail_notes.join("; "));
  ok(`${name} -> zero max loss too`, r.max_loss_usd === 0);
}

console.log("\nA MODEL CANNOT MANUFACTURE ZERO OR DOLLAR ARITHMETIC");
const fabricated = rail(evidence(), {
  ...judgement,
  position_size_usd: 0,
  max_loss_usd: 0,
  pct_of_equity_at_risk: 0,
});
ok("a fabricated model zero is replaced", fabricated.position_size_usd > 0,
  `size=$${fabricated.position_size_usd}`);
ok("its claimed max loss is recomputed", fabricated.max_loss_usd > 0,
  `max loss=$${fabricated.max_loss_usd}`);

for (const [name, risk] of [
  ["missing stop", { ...judgement, stop_price: null }],
  ["negative stop", { ...judgement, stop_price: -1 }],
  ["stop at entry", { ...judgement, stop_price: 1 }],
  ["stop above entry", { ...judgement, stop_price: 1.1 }],
  ["non-finite stop", { ...judgement, stop_price: Infinity }],
]) {
  const r = rail(evidence(), risk);
  ok(`${name} fails closed`, r.position_size_usd === 0, r.rail_notes.join("; "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
