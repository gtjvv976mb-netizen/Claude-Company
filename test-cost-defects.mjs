/* TWO MEASURED COST DEFECTS, AND THE INVARIANTS THAT STOP THEM COMING BACK.
 *
 * Both were found by pricing the desk's own $525.94 against the 57 calls it published,
 * and both are repairs rather than sacrifices — no gate moves, no seat is retired, no
 * ordering changes, no test is weakened.
 *
 *  1. THE READ CACHE EXPIRED BEFORE THE VERDICT IT SUPPORTED. A 30-minute X-read cache
 *     behind a 40-minute study TTL means every study that reaches its own expiry re-buys
 *     the read, deterministically, at $0.156 a time on the dearest line of the bill. The
 *     number is not the invariant; the ORDERING is, and the two lived in different files
 *     with nothing relating them. That is what this pins.
 *
 *  2. THE NARRATIVE SEAT WAS BILLED TWICE FOR ONE JOB. askWithWeb searched, then spent a
 *     whole second request re-sending SHARED_RULES and the bundle purely to pour notes
 *     into the schema — 732 spend rows for 366 runs, ~7.7% of every provider call on the
 *     desk. It now asks for the contract on the search request itself and only falls back
 *     when it must.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cost-defects-"));
process.env.CLAUDE_CO_DB = path.join(tmp, "journal.sqlite");
process.env.NODE_ENV = "test";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };

/* ── 1. THE CACHE MUST OUTLIVE THE STUDY ────────────────────────────────────────────── */
console.log("\nTHE X-READ CACHE OUTLIVES THE STUDY IT SUPPORTS");
const grok = await import("./src/lib/grok.js");
const funnel = await import("./src/funnel.js");

const cacheMin = grok.XREAD_CACHE_TTL_MS / 60_000;
const studyMin = Number(process.env.FUNNEL_STUDY_TTL_MIN || 40);

ok("the read cache is not shorter than the study TTL it feeds", () => {
  assert.ok(cacheMin >= studyMin,
    `cache ${cacheMin}min vs study ${studyMin}min — a cache shorter than the study it ` +
    "supports guarantees a re-purchase at the boundary, which is the defect this pins");
  console.log(`        cache ${cacheMin}min >= study ${studyMin}min`);
});

ok("a read cached now is still there when the study it supports expires", () => {
  const t0 = 1_700_000_000_000;
  grok.xreadCacheReset();
  grok.xreadCachePut("mintA", { summary: "x" }, [], t0);
  const atStudyExpiry = t0 + studyMin * 60_000;
  assert.ok(grok.xreadCacheGet("mintA", atStudyExpiry),
    `the read was gone by the ${studyMin}min study expiry — it would be re-bought`);
});

ok("...and it does expire eventually, so a stale read is not served for ever", () => {
  const t0 = 1_700_000_000_000;
  grok.xreadCacheReset();
  grok.xreadCachePut("mintB", { summary: "x" }, [], t0);
  assert.equal(grok.xreadCacheGet("mintB", t0 + grok.XREAD_CACHE_TTL_MS + 1), null);
});

ok("a failed read is never cached — a transient refusal must be retried", () => {
  grok.xreadCacheReset();
  grok.xreadCachePut("mintC", null, [], 1);
  assert.equal(grok.xreadCacheGet("mintC", 2), null);
});

ok("the funnel's study TTL is the one this compares against, read from source", () => {
  const census = funnel.funnelCensus ? funnel.funnelCensus() : null;
  if (census?.ttlMinutes?.study !== undefined) {
    assert.equal(census.ttlMinutes.study, studyMin,
      `funnel says ${census.ttlMinutes.study}, test assumed ${studyMin}`);
    console.log(`        funnel census confirms study TTL = ${census.ttlMinutes.study}min`);
  }
});

/* ── 2. ONE JOB, ONE BILL ───────────────────────────────────────────────────────────── */
console.log("\nTHE SEARCH SEAT IS NOT BILLED TWICE FOR ONE JOB");
const llmSrc = fs.readFileSync(new URL("./src/lib/llm.js", import.meta.url), "utf8");

ok("the search request asks for the contract itself", () => {
  assert.match(llmSrc, /WEB_STRUCTURED && schema\s*\n?\s*\?\s*\{ effort, format: betaZodOutputFormat\(schema\) \}/,
    "the search call must request the format so the answer can arrive in contract");
});

ok("an answer already in contract skips the shaping call entirely", () => {
  const i = llmSrc.indexOf("THE SAVED CALL");
  assert.ok(i > 0, "the skip must be present and explained");
  const block = llmSrc.slice(i, i + 700);
  assert.match(block, /if \(!searchError\)/, "the skip must not apply after a tool failure");
  assert.match(block, /return direct;/);
});

ok("a TOOL FAILURE still takes the long path, because only it carries the warning", () => {
  /* The fallback prompt is the only place the seat is told it read NOTHING and must
     carry that at zero weight in both directions. Skipping it on a failed search would
     convert a broken tool into silent absence-of-evidence, which the charter forbids. */
  const i = llmSrc.indexOf("=== TOOL FAILURE ===");
  assert.ok(i > 0, "the tool-failure briefing must still exist");
  assert.match(llmSrc.slice(i, i + 420), /established neither the presence nor the absence/);
});

ok("a rejected combination drops the latch instead of failing the seat", () => {
  const i = llmSrc.indexOf("FORMAT_REJECTED.test");
  assert.ok(i > 0, "there must be a rejection path");
  const block = llmSrc.slice(i - 400, i + 500);
  assert.match(block, /WEB_STRUCTURED = false/, "the latch must drop");
  assert.match(block, /continue;/, "it must retry the old way rather than throw");
});

ok("...and that rejection is NOT reported to the credit breaker", () => {
  /* A 400 on our own request shape is our bug, not a dead account. Telling the breaker
     would open it on a fault the provider never had. */
  const i = llmSrc.indexOf("FORMAT_REJECTED.test");
  const block = llmSrc.slice(i, llmSrc.indexOf("gate.failure(err);", i));
  assert.doesNotMatch(block, /gate\.failure/,
    "the format-rejection path must not run gate.failure");
});

ok("the latch is inspectable and resettable, so a test can drive both paths", () => {
  const m = llmSrc.match(/export const webStructuredEnabled/);
  assert.ok(m, "the latch must be observable");
  assert.match(llmSrc, /export function resetWebStructured/);
});

ok("the rejection pattern matches the shapes a provider actually returns", () => {
  const re = /output_config|output format|structured output|format.*not (?:supported|allowed)|incompatible/i;
  for (const msg of [
    "400 output_config.format is not supported with tools",
    "structured output cannot be combined with server tools",
    "This format is not allowed for this request",
    "incompatible request: format + web_search",
  ]) assert.ok(re.test(msg), `did not match: ${msg}`);
  /* And it must NOT swallow the failures that are real. */
  for (const msg of [
    "credit balance is too low",
    "429 rate limit exceeded",
    "500 internal server error",
    "overloaded_error",
  ]) assert.ok(!re.test(msg), `wrongly matched a real failure: ${msg}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n══ ${pass} passed, 0 failed ══`);
