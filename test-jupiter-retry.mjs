/**
 * The exit probe must not die on a rate limit. Three live house calls re-run locally
 * were all screened out as unverified_exit because Jupiter's public host answered 429
 * on the first try — for $0.00 of research, before any analyst saw them.
 */
import assert from "node:assert/strict";
import { withRetry } from "./src/data/jupiter.js";

let pass = 0;
const ok = (n, c, d = "") => { assert.ok(c, n + (d ? " — " + d : "")); pass++; console.log("  ok   " + n + (d ? "  — " + d : "")); };
const noWait = { wait: async () => {} };

{ // 429 twice, then success: the probe completes
  let calls = 0;
  const r = await withRetry(async () => (++calls < 3 ? { ok: false, error: "HTTP 429" } : { ok: true, data: { fine: true } }), noWait);
  ok("two 429s then a 200 completes the probe", r.ok === true && calls === 3, `${calls} attempts`);
}
{ // a hard 4xx is not retried
  let calls = 0;
  const r = await withRetry(async () => { calls++; return { ok: false, error: "HTTP 400" }; }, noWait);
  ok("a 400 is final on the first answer", r.ok === false && calls === 1);
}
{ // the budget is finite
  let calls = 0;
  const r = await withRetry(async () => { calls++; return { ok: false, error: "HTTP 503" }; }, noWait);
  ok("a persistent 503 gives up after the retry budget", r.ok === false && calls === 4, `${calls} attempts`);
}
console.log(`\n${pass} passed\n`);
