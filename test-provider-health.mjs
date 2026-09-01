import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isProviderCreditError,
  providerCreditHealth,
  providerErrorForViewer,
} from "./src/provider-health.js";

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
assert.equal(providerErrorForViewer("billing failed: sk-private-material"), null,
  "the public heartbeat never receives raw upstream wording");
assert.equal(providerErrorForViewer("provider says raise the account ceiling", { isOwner: true }),
  "provider says raise the account ceiling",
  "the authenticated house owner can inspect the bounded diagnostic");
assert.equal(providerErrorForViewer("x".repeat(300), { isOwner: true }).length, 240,
  "the owner diagnostic remains bounded");

const unrelated = providerCreditHealth([
  event("seat:failed", 2_000, { seat: "flow", error: "request timed out" }),
], { nowMs: now });
assert.equal(unrelated.blocked, false, "ordinary seat errors remain part of degraded health, not credit health");

const concurrentCompletion = providerCreditHealth([
  event("seat:failed", 4 * 60_000, { error: "the Anthropic balance is empty — the desk cannot think" }),
  event("seat:done", 60_000, { seat: "technical" }),
], { nowMs: now });
assert.equal(concurrentCompletion.blocked, true,
  "an in-flight seat finishing three minutes later does not falsely prove provider recovery");
assert.equal(concurrentCompletion.recoveryGraceMs, 5 * 60_000,
  "the default recovery grace is included in the diagnostic result");

const recovered = providerCreditHealth([
  event("seat:failed", 10 * 60_000, { error: "the Anthropic balance is empty — the desk cannot think" }),
  event("seat:done", 60_000, { seat: "technical" }),
], { nowMs: now });
assert.equal(recovered.blocked, false,
  "a successful paid seat nine minutes after the failure proves the shared account recovered");

const customGrace = providerCreditHealth([
  event("seat:failed", 5_000, { error: "the Anthropic balance is empty — the desk cannot think" }),
  event("seat:done", 1_000, { seat: "technical" }),
], { nowMs: now, recoveryGraceMs: 3_000 });
assert.equal(customGrace.blocked, false, "callers can configure the recovery grace");

const stale = providerCreditHealth([
  event("seat:failed", 7 * 3600e3, { error: "the Anthropic balance is empty — the desk cannot think" }),
], { nowMs: now });
assert.equal(stale.blocked, false, "expired failures do not leave the desk blocked forever");

const officeSource = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
assert.match(officeSource,
  /SELECT json_extract\(data,'\$\.seat'\) seat,[\s\S]{0,180}COUNT\(\*\) n, MAX\(ts\) last_ts[\s\S]{0,100}type='seat:failed'/,
  "heartbeat seat-failure groups retain the newest event timestamp");
assert.match(officeSource, /lastTs:\s*r\.last_ts\s*\?\?\s*null/,
  "heartbeat exposes the newest timestamp for every grouped seat failure");

console.log("provider credit health: direct, fallback, recovery, and expiry gates pass");
