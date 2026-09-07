/* THE GUARD MUST MATCH THE BREAKER EXACTLY, IN BOTH DIRECTIONS.
 *
 * desk.js refuses to buy the xAI read when the Anthropic breaker would refuse the
 * analyst seats without sending a request. Too loose and it removes the probe that is
 * the ONLY thing that closes a credit breaker — the desk would never think again. Too
 * tight and it goes on paying for reads nobody can judge, which is the $7.16 this
 * exists to stop. So the predicate is tested against acquireCredit itself, not against
 * a description of it. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  (await import("node:path")).join((await import("node:os")).tmpdir(), `cc-guard-${process.pid}.db`);
import assert from "node:assert/strict";
import { acquireCredit, creditBreakerState, noteCreditRefusal, noteCreditSuccess,
  resetCreditBreakers, setCreditBreakerClock, CREDIT_BREAKER_COOLDOWN_MS } from "./src/lib/llm.js";

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };

/** The guard exactly as desk.js writes it. */
const guardFires = () => {
  const s = creditBreakerState("anthropic");
  return s.state !== "closed" && s.probeReadyInMs > 0;
};

let clock = 1_000_000;
setCreditBreakerClock(() => clock);

ok("a healthy provider never trips the guard", () => {
  resetCreditBreakers();
  assert.equal(guardFires(), false);
  assert.equal(acquireCredit("anthropic").allowed, true);
});

ok("while the breaker cools down the guard fires AND acquireCredit sends nothing", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += 1_000;                       // still inside the cooldown
  assert.equal(guardFires(), true, "guard must fire during cooldown");
  assert.equal(acquireCredit("anthropic").allowed, false,
    "acquireCredit must refuse without sending — otherwise the guard is too tight");
});

ok("the instant a probe is due the guard STOPS firing, so recovery is never blocked", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += CREDIT_BREAKER_COOLDOWN_MS;  // the probe is now due
  assert.equal(creditBreakerState("anthropic").probeReadyInMs, 0);
  assert.equal(guardFires(), false, "a due probe must pass the guard or the desk never recovers");
  assert.equal(acquireCredit("anthropic").allowed, true, "and acquireCredit issues the probe");
});

ok("half_open with a probe in flight fires the guard, and sends nothing", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  assert.equal(acquireCredit("anthropic").allowed, true);   // takes the probe slot
  clock += 100;
  assert.equal(guardFires(), true, "a second caller must not buy a read behind a live probe");
  assert.equal(acquireCredit("anthropic").allowed, false);
});

ok("a success closes the breaker and the guard goes quiet", () => {
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  clock += CREDIT_BREAKER_COOLDOWN_MS;
  acquireCredit("anthropic");
  noteCreditSuccess("anthropic");
  assert.equal(guardFires(), false);
  assert.equal(acquireCredit("anthropic").allowed, true);
});

ok("the guard reads anthropic only — an xAI outage must not stop the analysts", () => {
  resetCreditBreakers();
  noteCreditRefusal("xai", "used all its credits");
  clock += 1_000;
  assert.equal(guardFires(), false, "an xAI outage is not a reason to skip Anthropic work");
});

ok("EXHAUSTIVE: guard === (acquireCredit refuses) at every point across a cooldown", () => {
  for (const step of [0, 1, 100, 5_000, CREDIT_BREAKER_COOLDOWN_MS - 1, CREDIT_BREAKER_COOLDOWN_MS]) {
    resetCreditBreakers();
    noteCreditRefusal("anthropic", "credit balance is too low");
    clock += step;
    const fired = guardFires();
    const refusedWithoutSending = acquireCredit("anthropic").allowed === false;
    assert.equal(fired, refusedWithoutSending,
      `at +${step}ms the guard (${fired}) disagreed with acquireCredit (${refusedWithoutSending})`);
  }
});

console.log(`\n${pass} passed — the guard fires exactly when a request would not be sent\n`);
