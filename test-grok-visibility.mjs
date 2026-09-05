/**
 * A GROK FAILURE MUST BE VISIBLE.
 *
 * On 2026-09-05 the X read ran 92 times and then zero for an hour, while every Anthropic
 * seat kept completing on the very same coins. Nothing anywhere said so: xai() returned
 * the provider's own status and error body, and the caller threw it away — no event, no
 * spend row (a refused call has no usage to meter), no log the operator could reach. The
 * desk quietly degraded to "no reputation read" on every coin. The likeliest cause was
 * xAI credit, a separate account from Anthropic, and the operator had just refilled the
 * wrong one on the strength of a heartbeat that could only see Anthropic.
 *
 * Same lesson as the silent rehearsal and the silent fill: a measurement that reports
 * nothing is not a measurement that reports zero.
 */
import fs from "node:fs";
import { isProviderCreditError, providerCreditHealth } from "./src/provider-health.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nA FAILED READ IS ANNOUNCED LIKE ANY OTHER FAILED SEAT");
{
  const ev = fs.readFileSync(new URL("./src/data/evidence.js", import.meta.url), "utf8");
  const tr = fs.readFileSync(new URL("./src/trends.js", import.meta.url), "utf8");
  ok("the X read emits seat:failed with the provider's own error",
    /emit\("seat:failed", \{ seat: "XRead", mint: ev\.mint, symbol: [^,]+, error: xr\.error \}\)/.test(ev));
  ok("...including when the call THREW rather than returned",
    /\.catch\(\(e\) => \(\{ ok: false, error: `x-read threw:/.test(ev));
  ok("the trend lane emits seat:failed too", /emit\("seat:failed", \{ seat: "TrendScan", error \}\)/.test(tr));
  ok("...but not for a missing key, which is configuration rather than an outage",
    /if \(error !== "no key"\) emit\("seat:failed"/.test(tr));
  ok("the swallow that hid it is gone", !/\.catch\(\(\) => null\);\s*\n\s*if \(xr\?\.ok\)/.test(ev));
}

console.log("\nTHE HEALTH CHECK KNOWS WHAT AN xAI REFUSAL LOOKS LIKE");
{
  for (const msg of [
    "xai 402: {\"error\":\"insufficient credits\"}",
    "xai 402: Payment Required",
    "xai 403: {\"error\":\"billing account suspended\"}",
    "Insufficient balance to complete this request",
    "your credits are exhausted",
  ]) ok(`credit: ${msg.slice(0, 44)}`, isProviderCreditError(msg));
  for (const msg of [
    "xai 429: rate limited",
    "xai 503: upstream unavailable",
    "xai 500: internal error",
    "fetch failed",
    "x-read returned no parseable JSON",
    "xai 400: Failed to get quotes",
  ]) ok(`NOT credit (transient or malformed): ${msg.slice(0, 32)}`, !isProviderCreditError(msg));
}

console.log("\nAND IT NAMES THE PROVIDER, BECAUSE THERE ARE TWO ACCOUNTS");
{
  const now = 1_700_000_000_000;
  const dead = providerCreditHealth([
    { type: "seat:failed", ts: now - 120_000, data: { seat: "XRead", error: "xai 402: {\"error\":\"insufficient credits\"}" } },
    { type: "seat:failed", ts: now - 60_000,  data: { seat: "XRead", error: "xai 402: {\"error\":\"insufficient credits\"}" } },
  ], { nowMs: now, windowMs: 6 * 3600e3 });
  ok("a dead xAI account reports BLOCKED", dead.blocked === true);
  ok("...with the failures counted", dead.failures === 2, `${dead.failures}`);
  ok("...naming xai, not anthropic", dead.lastFailureProvider === "xai", dead.lastFailureProvider);
  const anth = providerCreditHealth([
    { type: "desk:out_of_credit", ts: now - 60_000, data: { seat: "Flow" } },
  ], { nowMs: now, windowMs: 6 * 3600e3 });
  ok("an Anthropic refusal still names anthropic", anth.blocked && anth.lastFailureProvider !== "xai");
  const fine = providerCreditHealth([
    { type: "seat:failed", ts: now - 60_000, data: { seat: "XRead", error: "xai 429: rate limited" } },
    { type: "seat:done",   ts: now - 30_000, data: { seat: "Flow" } },
  ], { nowMs: now, windowMs: 6 * 3600e3 });
  ok("a rate limit is not an outage", fine.blocked === false && fine.failures === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
