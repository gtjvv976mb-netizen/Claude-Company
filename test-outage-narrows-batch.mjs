/* A WIDE BATCH DURING AN OUTAGE BUYS READS NOBODY CAN JUDGE.
 *
 * penthouse.js narrows the workup batch to one worker while the analyst provider is
 * unhealthy. The property that matters is narrow-only: it must never widen the batch
 * past what the operator configured, and it must be exactly the configured width again
 * the moment the provider is healthy. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  (await import("node:path")).join((await import("node:os")).tmpdir(), `cc-narrow-${process.pid}.db`);
import assert from "node:assert/strict";
import { creditBreakerState, noteCreditRefusal, noteCreditSuccess, resetCreditBreakers,
  setCreditBreakerClock, acquireCredit, CREDIT_BREAKER_COOLDOWN_MS } from "./src/lib/llm.js";

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };

let clock = 2_000_000;
setCreditBreakerClock(() => clock);

/** The rule exactly as penthouse.js applies it. */
const widthFor = (configured) =>
  creditBreakerState("anthropic").state === "closed" ? configured : 1;

ok("a healthy desk runs at the configured width, unchanged", () => {
  resetCreditBreakers();
  for (const w of [1, 2, 3, 6]) assert.equal(widthFor(w), w);
});

ok("an open breaker narrows the batch to one", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += 1_000;
  assert.equal(widthFor(3), 1);
  assert.equal(widthFor(6), 1);
});

ok("half_open (a probe in flight) also narrows — the batch must not race the probe", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  acquireCredit("anthropic");                       // takes the probe -> half_open
  assert.equal(creditBreakerState("anthropic").state, "half_open");
  assert.equal(widthFor(3), 1);
});

ok("recovery restores the configured width immediately", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  acquireCredit("anthropic");
  noteCreditSuccess("anthropic");
  assert.equal(creditBreakerState("anthropic").state, "closed");
  assert.equal(widthFor(3), 3, "a recovered desk must not stay throttled");
});

ok("NARROW-ONLY: the width is never greater than configured, in any breaker state", () => {
  for (const configured of [1, 2, 3, 6]) {
    for (const setup of [
      () => {},
      () => { noteCreditRefusal("anthropic", "credit balance is too low"); },
      () => { noteCreditRefusal("anthropic", "credit balance is too low");
              clock += CREDIT_BREAKER_COOLDOWN_MS; acquireCredit("anthropic"); },
    ]) {
      resetCreditBreakers(); setup();
      const w = widthFor(configured);
      assert.ok(w <= configured, `width ${w} exceeded configured ${configured}`);
      assert.ok(w >= 1, "width must stay at least 1 — a cycle with no workers studies nothing");
    }
  }
});

ok("an xAI outage does not narrow the batch — only the analyst provider governs it", () => {
  resetCreditBreakers();
  noteCreditRefusal("xai", "used all its credits");
  clock += 1_000;
  assert.equal(widthFor(3), 3);
});

console.log(`\n${pass} passed — the batch narrows during an analyst outage and never widens\n`);
