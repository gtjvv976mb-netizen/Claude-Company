/* TWO MEASURED LEAKS, EACH PROVED CLOSED.
 *
 * 2026-09-07: 151 mints were worked up, 52 of them three or more times, 319 re-starts in
 * a day. The fresh lane worked one coin up 25 times. Every re-start that cleared the free
 * screen bought a fresh ~$0.15 X read, because (a) the fresh lane never consulted
 * store.recentlyJudged — the gate every other lane uses — and (b) nothing on the X-read
 * path cached by mint. This proves both fixes: the cache helpers directly, and the two
 * integrations at source level, the way test-xread-order.mjs already pins desk.js. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  (await import("node:path")).join((await import("node:os")).tmpdir(), `cc-xread-${process.pid}.db`);
import assert from "node:assert/strict";
import fs from "node:fs";
import { xreadCacheGet, xreadCachePut, xreadCacheReset, XREAD_CACHE_TTL_MS } from "./src/lib/grok.js";
import * as store from "./src/lib/store.js";

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };
const MINT_A = "FgJReZeYfmKZeWrCaGYL8gLnUixwBhjdHuRknC6ypump";
const MINT_B = "CbyTNf7UPzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump";

console.log("\nTHE X-READ CACHE");
ok("a read is served back for the same mint inside the TTL", () => {
  xreadCacheReset();
  const t0 = 1_000_000;
  xreadCachePut(MINT_A, { verdict: "mixed" }, ["c1"], t0);
  const hit = xreadCacheGet(MINT_A, t0 + XREAD_CACHE_TTL_MS - 1);
  assert.ok(hit && hit.read.verdict === "mixed" && hit.citations[0] === "c1");
});
ok("a different mint is a miss — the cache is keyed on the coin, never on the hook", () => {
  assert.equal(xreadCacheGet(MINT_B, 1_000_001), null);
});
ok("past the TTL the read is re-bought, not replayed", () => {
  xreadCacheReset();
  const t0 = 2_000_000;
  xreadCachePut(MINT_A, { verdict: "organic" }, [], t0);
  assert.equal(xreadCacheGet(MINT_A, t0 + XREAD_CACHE_TTL_MS + 1), null);
});
/* RE-ANCHORED 2026-09-11, and the property it guards is unchanged: the cache must be ON
   for a duration long enough to matter. The literal moved 30 -> 45 minutes because the
   old value carried a defect this file's own premise did not anticipate — the study it
   supports lives 40 minutes (FUNNEL_STUDY_TTL_MIN), so a 30-minute cache expired TEN
   MINUTES BEFORE the verdict it was backing and every study reaching its own expiry
   re-bought the read. That is the same leak this file exists to close, one boundary
   further out. The assertion now pins the RELATIONSHIP rather than the number, because
   the two values lived in different files with nothing relating them, which is how they
   drifted apart in the first place. */
ok("the TTL outlives the study it supports, and is a real duration", () => {
  const studyMs = Number(process.env.FUNNEL_STUDY_TTL_MIN || 40) * 60_000;
  assert.ok(XREAD_CACHE_TTL_MS >= studyMs,
    `cache ${XREAD_CACHE_TTL_MS / 60_000}min must be >= study ${studyMs / 60_000}min, ` +
    "or every study that reaches its own expiry re-buys the read");
  assert.ok(XREAD_CACHE_TTL_MS >= 20 * 60_000,
    `cache ${XREAD_CACHE_TTL_MS / 60_000}min — too short to close the leak this file pins`);
});
ok("a failed read is never cached — the caller only puts on success", () => {
  xreadCacheReset();
  xreadCachePut(MINT_A, null, [], 3_000_000);
  assert.equal(xreadCacheGet(MINT_A, 3_000_001), null);
});
ok("the cache is bounded — the oldest entry is evicted past 500 mints", () => {
  xreadCacheReset();
  for (let i = 0; i < 501; i++) xreadCachePut(`mint-${i}`, { verdict: "x" }, [], 4_000_000 + i);
  assert.equal(xreadCacheGet("mint-0", 4_001_000), null, "the first mint must be gone");
  assert.ok(xreadCacheGet("mint-500", 4_001_000), "the newest must remain");
});

console.log("\nTHE INTEGRATIONS, AT SOURCE LEVEL");
const grok = fs.readFileSync(new URL("./src/lib/grok.js", import.meta.url), "utf8");
const fn = grok.slice(grok.indexOf("export async function grokXRead"));
ok("grokXRead consults the cache BEFORE the paid xai() call", () => {
  const get = fn.indexOf("xreadCacheGet(mint)"), paid = fn.indexOf('xai("/responses"');
  assert.ok(get > 0 && paid > 0 && get < paid, `get at ${get}, paid call at ${paid}`);
});
ok("...and puts on the success path only, after the verdict is emitted", () => {
  const put = fn.indexOf("xreadCachePut(mint, obj, citations)");
  const success = fn.indexOf("return { ok: true, read: obj, citations }");
  const failure = fn.indexOf("x-read returned no parseable JSON");
  assert.ok(put > failure && put < success, "put must sit between the failure return and the success return");
});
ok("a cache hit announces itself as xread:cached, never as a seat:verdict purchase", () => {
  const hitBlock = fn.slice(fn.indexOf("if (cached) {"), fn.indexOf('const r = await xai("/responses"'));
  assert.match(hitBlock, /emit\("xread:cached"/);
  assert.doesNotMatch(hitBlock, /emit\("seat:verdict"/);
});

const pent = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
ok("the fresh lane gates on store.recentlyJudged before it pays for a workup", () => {
  const start = pent.indexOf("if (!top || top.score < minScore) return");
  const gate = pent.indexOf("store.recentlyJudged(top.mint)", start);
  const workup = pent.indexOf('lane: "fresh"', start);
  assert.ok(start > 0 && gate > start && workup > gate, `gate at ${gate} must precede the fresh workup at ${workup}`);
});
ok("...and says so on the chronicle rather than skipping silently", () => {
  assert.match(pent, /emit\("fresh:skipped_repeat"/);
});

console.log("\nTHE DEDUPE ITSELF (behavioural, throwaway DB)");
ok("a recorded verdict makes recentlyJudged truthy for that mint and only that mint", () => {
  store.recordVerdict("test-cycle", MINT_A, "FGJ", "Screener", { verdict: "FAIL", kill: true, kill_reason: "test" });
  assert.ok(store.recentlyJudged(MINT_A), "the judged mint must be recognised");
  assert.equal(store.recentlyJudged(MINT_B), null, "an unjudged mint must not be");
});

console.log(`\n${pass} passed — the fresh lane does not re-ask, and a read is bought once per coin per cache window\n`);
