import assert from "node:assert/strict";
import { validateExecutableEntryOrder } from "./entry-quote-guard.mjs";

const now = 1_000_000;
const intent = {
  id: "entry:test", kind: "entry", amountRaw: "5000000",
  context: {
    event: { stop: 0.80, target: 1.50 },
    entryReference: { marketMark: 1, entryLow: 0.90, entryHigh: 1.10 },
    entryPreflight: { inputAmountRaw: "5000000", forwardOutputRaw: "1000",
      tokenDecimals: 3, solUsd: 200, observedAt: now - 1_000,
      solUsdSource: "pyth-sol-usd-shard0-v1", solUsdPublishTime: Math.floor(now / 1_000),
      solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.1 },
  },
};
const order = { inAmount: "5000000", outAmount: "1000", otherAmountThreshold: "980" };

const valid = validateExecutableEntryOrder(intent, order, { nowMs: now, maxEntryQuoteDriftPct: 3 });
assert.equal(valid.quotedMark, 1);
assert.ok(valid.worstCaseMark > 1.02 && valid.worstCaseMark < 1.021);

assert.throws(() => validateExecutableEntryOrder(intent,
  { ...order, outAmount: "800", otherAmountThreshold: "790" }, { nowMs: now, maxEntryQuoteDriftPct: 30 }),
  /outside authored zone/);
assert.throws(() => validateExecutableEntryOrder(intent,
  { ...order, outAmount: "1000", otherAmountThreshold: "900" }, { nowMs: now }),
  /drift .* exceeds/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, forwardOutputRaw: "500" },
} }, order, { nowMs: now, maxEntryQuoteDriftPct: 5 }), /drift .* exceeds/,
"a bad preliminary Jupiter rate cannot define its own fair-value anchor");
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryReference: { ...intent.context.entryReference, entryLow: 0.70 },
} }, { ...order, outAmount: "1250", otherAmountThreshold: "1240" },
{ nowMs: now, maxEntryQuoteDriftPct: 30 }), /breached authored stop/);
assert.throws(() => validateExecutableEntryOrder(intent, order,
  { nowMs: now + 61_001, maxEntryQuoteDriftPct: 3 }), /preflight is stale/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, inputAmountRaw: null },
} }, order, { nowMs: now }), /preflight input/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, tokenDecimals: null },
} }, order, { nowMs: now }), /on-chain token decimals/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, solUsdSource: "jupiter" },
} }, order, { nowMs: now }), /independent two-RPC Pyth/);
assert.equal(validateExecutableEntryOrder({ kind: "risk_exit" }, order, { nowMs: now }), null);

console.log("\nfinal executable entry quote stays bound to the authored zone\n");
