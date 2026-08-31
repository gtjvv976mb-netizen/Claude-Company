import assert from "node:assert/strict";
import { isProviderCreditError, providerCreditHealth } from "./src/provider-health.js";

const now = 1_800_000_000_000;
const event = (type, ageMs, data = {}) => ({ type, ts: now - ageMs, data: JSON.stringify(data) });

assert.equal(isProviderCreditError("Your credit balance is too low to access the Anthropic API"), true);
assert.equal(isProviderCreditError("the Anthropic balance is empty — the desk cannot think"), true);
assert.equal(isProviderCreditError("request timed out"), false);

assert.deepEqual(providerCreditHealth([], { nowMs: now }).blocked, false);

const direct = providerCreditHealth([event("desk:out_of_credit", 1_000)], { nowMs: now });
assert.equal(direct.blocked, true, "the direct provider event blocks the heartbeat");

const propagated = providerCreditHealth([
  event("seat:failed", 2_000, { seat: "flow", error: "the Anthropic balance is empty — the desk cannot think" }),
], { nowMs: now });
assert.equal(propagated.blocked, true,
  "the durable seat failure blocks even when desk:out_of_credit was not recorded");

const rawProviderError = providerCreditHealth([
  event("seat:failed", 2_000, { seat: "narrative", error: "400: Your credit balance is too low to access the Anthropic API" }),
], { nowMs: now });
assert.equal(rawProviderError.blocked, true, "the provider's raw billing error is recognized");

const unrelated = providerCreditHealth([
  event("seat:failed", 2_000, { seat: "flow", error: "request timed out" }),
], { nowMs: now });
assert.equal(unrelated.blocked, false, "ordinary seat errors remain part of degraded health, not credit health");

const recovered = providerCreditHealth([
  event("seat:failed", 5_000, { error: "the Anthropic balance is empty — the desk cannot think" }),
  event("seat:done", 1_000, { seat: "technical" }),
], { nowMs: now });
assert.equal(recovered.blocked, false, "a later paid-seat success proves the shared provider account recovered");

const stale = providerCreditHealth([
  event("seat:failed", 7 * 3600e3, { error: "the Anthropic balance is empty — the desk cannot think" }),
], { nowMs: now });
assert.equal(stale.blocked, false, "expired failures do not leave the desk blocked forever");

console.log("provider credit health: direct, fallback, recovery, and expiry gates pass");
