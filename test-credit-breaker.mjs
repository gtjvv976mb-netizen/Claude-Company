/**
 * A DRY ACCOUNT MUST STOP COSTING MONEY TO BE TOLD NO — AND THE DESK MUST COME BACK
 * BY ITSELF WHEN IT IS TOPPED UP.
 *
 * The measured chain, 2026-09-06, both provider accounts empty:
 *   1,323 refused requests an hour. desk.js was letting OutOfCredit die inside
 *   Promise.allSettled, so the cycle never halted; index.js tested workedUp before
 *   stopped, so a halted cycle took the 45s gap instead of the 600s one. Fixing both
 *   moved cycles/hour 37 -> 17 and cycle:halted from 2-in-3.2-hours to 4-in-3.4-minutes,
 *   and refusals only 1,323 -> 1,254. A 5% dent, because PENTHOUSE_WORKUP_CONCURRENCY
 *   is 3: halting the cycle stops the NEXT candidate, it cannot un-fire the seats the
 *   other two workups already have in the air. Those seats are removed only by refusing
 *   at the provider layer, before the request exists.
 *
 * So: a circuit breaker per provider, in llm.js, tested here through the REAL entry
 * points with a counted fetch stub. The count is the evidence — an earlier draft of the
 * breaker trusted its own state field and shipped a gate that could never open, because
 * the first refusal always arrives at a caller holding a closed-state gate. The fetch
 * counter caught it; the state field would have read "open" either way.
 *
 * THE DECISIVE TEST IS RECOVERY (section 6). A breaker that latches open is far worse
 * than the bug it replaces: the desk looks permanently dead while the account is funded.
 * Time is injected, never slept, so the real cooldown can be crossed in microseconds and
 * the maximum time-to-recovery printed as an actual number.
 *
 * Nothing here touches the network: global fetch is replaced before llm.js is imported,
 * the key is fake and the base URL is unroutable.
 */
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};

/* ── the fetch stub: every provider request in this file passes through here ───────── */
const NET = { anthropic: 0, xai: 0, log: [] };
let anthropicReply = () => creditRefusal400();
let xaiReply = () => xaiCreditRefusal403();

const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });
const creditRefusal400 = () => json({ type: "error", error: { type: "invalid_request_error",
  message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade." } }, 400);
const anthropicMessage200 = () => json({
  id: "msg_probe", type: "message", role: "assistant", model: "claude-opus-5",
  content: [{ type: "text", text: "the account is paying again" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
});
/* The streaming shape ask() actually uses. A JSON body is enough for messages.create()
   but ask() reads a stream, and the difference is load-bearing: only a real stream gets
   as far as meterAnthropicUsage(), which is where the "we were billed" fact lives. */
const sse = (frames) => new Response(
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const anthropicStream200 = (text, stopReason = "end_turn") => () => sse([
  { type: "message_start", message: { id: "msg_stream", type: "message", role: "assistant",
    model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 200 } },
  { type: "message_stop" },
]);
const notFound404 = () => json({ type: "error", error: { type: "not_found_error",
  message: "model: claude-opus-9 not found" } }, 404);
const overloaded529 = () => json({ type: "error", error: { type: "overloaded_error",
  message: "Overloaded" } }, 529);
const xaiCreditRefusal403 = () => json({ error:
  "Your team has used all available credits. Please purchase more credits to continue." }, 403);
const xaiOk200 = () => json({ id: "grok_1", model: "grok-4.6",
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 } });

globalThis.fetch = async (url) => {
  const target = String(url);
  const provider = /xai/.test(target) ? "xai" : "anthropic";
  NET[provider] += 1;
  NET.log.push(provider);
  return provider === "xai" ? xaiReply() : anthropicReply();
};
const netSnapshot = () => ({ ...NET });
const netDelta = (before) => ({ anthropic: NET.anthropic - before.anthropic,
  xai: NET.xai - before.xai });

/* ── injected time. Nothing in this file sleeps. ───────────────────────────────────── */
let NOW = 1_800_000_000_000;
const advance = (ms) => { NOW += ms; return NOW; };

const { z } = await import("zod");
const llm = await import("./src/lib/llm.js");
const { bus } = await import("./src/lib/bus.js");
const grok = await import("./src/lib/grok.js");
const {
  OutOfCredit, BudgetExhausted, acquireCredit, noteCreditRefusal, noteCreditSuccess,
  creditBreakerState, openCreditBreakers, resetCreditBreakers, setCreditBreakerClock,
  CREDIT_BREAKER_COOLDOWN_MS, CREDIT_BREAKER_PROBE_LEASE_MS,
  CREDIT_BREAKER_STAND_DOWN_PROBES, ask, askWithWeb,
} = llm;

setCreditBreakerClock(() => NOW);
const SCHEMA = z.object({ verdict: z.string() });
const askOnce = (seat = "flow") => ask({ seat, model: "claude-opus-5", effort: "low",
  schema: SCHEMA, prompt: "one candidate", maxTokens: 512 });

const events = [];
bus.on("event", (e) => { if (/^desk:breaker_/.test(e.type)) events.push(e); });

const COOLDOWN = CREDIT_BREAKER_COOLDOWN_MS;
const LEASE = CREDIT_BREAKER_PROBE_LEASE_MS;

console.log(`\ncooldown ${COOLDOWN / 1000}s · probe lease ${LEASE / 1000}s (both env-tunable and bounded)`);

/* ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\n1. ONLY A CREDIT REFUSAL OPENS IT");
{
  resetCreditBreakers();
  ok("a fresh breaker is closed and lets calls out", acquireCredit("anthropic").allowed === true);

  // A timeout, a 500 and a schema mismatch are the three things this must never eat.
  for (const err of [new Error("fetch failed"), Object.assign(new Error("overloaded"), { status: 500 }),
    new SyntaxError("Unexpected token < in JSON at position 0")]) {
    acquireCredit("anthropic").failure(err);
  }
  ok("three non-credit failures leave it closed", creditBreakerState("anthropic").state === "closed",
    "a timeout/500/parse error must behave exactly as it did before the breaker existed");

  acquireCredit("anthropic").refused("Your credit balance is too low to access the Anthropic API");
  ok("a credit refusal opens it", creditBreakerState("anthropic").state === "open");

  // The desk's own daily cap is a different wall with its own handling; it arrives as
  // BudgetExhausted through failure(), never through refused(), and must not trip this.
  resetCreditBreakers();
  acquireCredit("anthropic").failure(new BudgetExhausted("metered provider ceiling: $90.00 spent"));
  ok("our own daily ceiling does not open the provider breaker",
    creditBreakerState("anthropic").state === "closed",
    "DESK_DAILY_BUDGET_USD is not the provider saying no");
}

console.log("\n2. AN OPEN BREAKER REFUSES WITHOUT A REQUEST");
{
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  const before = netSnapshot();
  let thrown = [];
  // The shape of the incident: two other workups, five seats each, still in flight.
  for (let i = 0; i < 15; i++) {
    try { await askOnce(`seat${i}`); thrown.push(null); }
    catch (e) { thrown.push(e); }
  }
  const d = netDelta(before);
  ok("all fifteen in-flight seats are refused", thrown.every((e) => e instanceof OutOfCredit));
  ok("and NOT ONE of them reaches the network", d.anthropic === 0,
    `${d.anthropic} requests for 15 seats — this is the ~1,250/hour the halt fix could not remove`);
  ok("the refusal still reads as the provider's own, so provider-health keeps classifying it",
    /anthropic balance is empty/i.test(thrown[0].message), thrown[0].message);
  ok("the breaker counted them", creditBreakerState("anthropic").refusedWhileOpen === 15);
}

console.log("\n3. PER PROVIDER, STRICTLY — 2026-09-05 TOPPED UP ANTHROPIC WHILE xAI WAS DRY");
{
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  ok("anthropic is open", creditBreakerState("anthropic").state === "open");
  ok("xai is untouched", creditBreakerState("xai").state === "closed");

  xaiReply = xaiOk200;
  let before = netSnapshot();
  const g = await grok.grokAsk({ seat: "MD", system: "s", prompt: "p", shape: "{}" });
  let d = netDelta(before);
  ok("a dead Anthropic account does not stop Grok calling out", d.xai === 1 && g.ok === true,
    `xai requests ${d.xai}, anthropic requests ${d.anthropic}`);

  // ...and the reverse. A live xAI 403 opens only the xai breaker.
  resetCreditBreakers();
  xaiReply = xaiCreditRefusal403;
  const refused = await grok.grokAsk({ seat: "MD", system: "s", prompt: "p", shape: "{}" });
  ok("a real xAI 403 fails OPEN as it always has, it does not throw",
    refused.ok === false && /xai 403/.test(refused.error), refused.error.slice(0, 60));
  ok("...and opens the xai breaker only", creditBreakerState("xai").state === "open" &&
    creditBreakerState("anthropic").state === "closed");

  before = netSnapshot();
  const g2 = await grok.grokAsk({ seat: "MD", system: "s", prompt: "p", shape: "{}" });
  d = netDelta(before);
  ok("the next Grok call costs no request at all", d.xai === 0 && g2.ok === false,
    `xai requests ${d.xai}; error: ${g2.error.slice(0, 48)}`);

  anthropicReply = anthropicMessage200;
  before = netSnapshot();
  try { await askOnce("flow"); } catch {}          // the stream will not parse; the CALL is the point
  d = netDelta(before);
  ok("a dead xAI account does not stop Anthropic calling out", d.anthropic === 1,
    `anthropic requests ${d.anthropic} while the xai breaker is open`);
  anthropicReply = creditRefusal400;
  xaiReply = xaiCreditRefusal403;
}

console.log("\n4. EXACTLY ONE PROBE, NOT A THUNDERING HERD");
{
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);

  // Fifteen seats wake at once the instant the cooldown expires.
  const gates = Array.from({ length: 15 }, () => acquireCredit("anthropic"));
  const allowed = gates.filter((g) => g.allowed);
  ok("exactly one of fifteen simultaneous callers carries the probe", allowed.length === 1,
    `${allowed.length} allowed of ${gates.length}`);
  ok("...and it knows it is the probe", allowed[0].probe === true);
  ok("the other fourteen are refused with a countdown, not a request",
    gates.filter((g) => !g.allowed).every((g) => g.retryInMs > 0));

  // Same thing through the real entry point, counting requests rather than gates.
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  const before = netSnapshot();
  await Promise.allSettled(Array.from({ length: 15 }, (_, i) => askOnce(`seat${i}`)));
  const d = netDelta(before);
  ok("fifteen concurrent ask() calls produce ONE network request", d.anthropic === 1,
    `${d.anthropic} request(s) for 15 seats`);
}

console.log("\n5. A FAILED PROBE RE-OPENS, IT DOES NOT CLOSE");
{
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  anthropicReply = creditRefusal400;                 // still dry
  let before = netSnapshot();
  let err = await askOnce("flow").catch((e) => e);
  ok("the probe goes out", netDelta(before).anthropic === 1);
  ok("it is refused again", err instanceof OutOfCredit);
  ok("the breaker is open again, not closed", creditBreakerState("anthropic").state === "open");
  ok("and the cooldown restarted from this refusal",
    creditBreakerState("anthropic").probeReadyInMs === COOLDOWN,
    `next probe in ${creditBreakerState("anthropic").probeReadyInMs / 1000}s`);

  before = netSnapshot();
  await askOnce("flow").catch(() => {});
  ok("so the call right after a failed probe is free again", netDelta(before).anthropic === 0);

  // A probe that fails for a NON-credit reason must also re-open rather than latch
  // half-open holding a slot nobody will ever hand back.
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  const probe = acquireCredit("anthropic");
  ok("half-open while the probe is out", creditBreakerState("anthropic").state === "half_open");
  probe.failure(new Error("fetch failed"));
  ok("a probe that times out returns the breaker to open with a fresh cooldown",
    creditBreakerState("anthropic").state === "open" &&
    creditBreakerState("anthropic").probeReadyInMs === COOLDOWN);
}

/* ══════════════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS. The operator tops the account up and touches nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\n6. RECOVERY — NO DEPLOY, NO RESTART, NO MANUAL STEP");
{
  resetCreditBreakers();
  events.length = 0;
  anthropicReply = creditRefusal400;

  const openedAt = NOW;
  let before = netSnapshot();
  const first = await askOnce("flow").catch((e) => e);
  ok("the account runs dry on a real call", first instanceof OutOfCredit &&
    netDelta(before).anthropic === 1, "one request, then the breaker trips");

  // ── an hour of a dead account, at the desk's blocked cadence of one cycle per 600s.
  before = netSnapshot();
  let refusedFree = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let seat = 0; seat < 15; seat++) {
      await askOnce(`seat${seat}`).catch(() => { refusedFree += 1; });
    }
    advance(0);                        // same instant: nothing has topped anything up
  }
  ok("90 seat calls over the hour cost zero requests", netDelta(before).anthropic === 0,
    `${refusedFree} refused for ${netDelta(before).anthropic} requests ` +
    `(the measured baseline was ~1,250 requests an hour)`);

  // ── THE OPERATOR TOPS UP. Nothing is deployed, restarted, or told.
  const toppedUpAt = advance(37_000);      // mid-cooldown, an arbitrary moment
  anthropicReply = anthropicMessage200;

  before = netSnapshot();
  await askOnce("flow").catch(() => {});
  ok("a call before the cooldown expires still costs nothing", netDelta(before).anthropic === 0,
    "the breaker cannot know yet, and guessing would be the retry storm again");

  // ── the cooldown expires. The next ordinary call IS the probe: there is no other
  //    door out of "open", so nothing has to remember to schedule it.
  advance(COOLDOWN - (NOW - openedAt) + 1);
  const probeAt = NOW;
  before = netSnapshot();
  await askWithWeb({ seat: "narrative", model: "claude-opus-5", effort: "low",
    schema: SCHEMA, prompt: "one candidate", maxTokens: 512 }).catch(() => {});
  ok("the probe leaves on its own", netDelta(before).anthropic >= 1);
  ok("it succeeds, and the breaker CLOSES", creditBreakerState("anthropic").state === "closed");

  // ── the decisive assertion: the very next ordinary call goes through.
  before = netSnapshot();
  await askOnce("flow").catch(() => {});
  const d = netDelta(before);
  ok("THE VERY NEXT ORDINARY CALL REACHES THE PROVIDER", d.anthropic === 1,
    `${d.anthropic} request — no deploy, no restart, no manual step`);

  const ttr = probeAt - toppedUpAt;
  const worst = COOLDOWN;
  ok("measured time-to-recovery is within the cooldown bound", ttr <= worst,
    `MEASURED ${ (ttr / 1000).toFixed(1) }s from top-up to the probe, bound ${worst / 1000}s`);
  console.log(`       ── time-to-recovery: ${(ttr / 1000).toFixed(1)}s measured · ` +
    `${COOLDOWN / 1000}s worst case · ${(COOLDOWN + LEASE) / 1000}s worst case with a hung probe`);

  const opened = events.filter((e) => e.type === "desk:breaker_open");
  const closed = events.filter((e) => e.type === "desk:breaker_closed");
  ok("the chronicle shows the transition, not just the silence",
    opened.length === 1 && closed.length === 1,
    `${opened.length} desk:breaker_open, ${closed.length} desk:breaker_closed`);
  ok("...and names the provider and the downtime", opened[0].provider === "anthropic" &&
    closed[0].provider === "anthropic" && closed[0].downMs === probeAt - openedAt,
    `down ${(closed[0].downMs / 1000).toFixed(0)}s, ${closed[0].refusedWhileOpen} calls refused for free`);
}

console.log("\n7. NO PATH LEAVES IT OPEN WITH NO PROBE COMING");
{
  /* Exhaustive over every (state, event) pair the breaker can be in. The invariant is
     not "it eventually closes" — it cannot, if the account is still empty — but that
     from ANY reachable state, advancing the clock by cooldown + lease always produces
     an allowed probe. That is what makes a latch unreachable. */
  const events2 = {
    "refused": (g) => g.refused("credit balance is too low"),
    "success": (g) => g.success(),
    "non-credit failure": (g) => g.failure(new Error("fetch failed")),
    "budget failure": (g) => g.failure(new BudgetExhausted("metered provider ceiling")),
    "nothing (caller vanished)": () => {},
  };
  const states = {
    "closed": () => {},
    "open": () => noteCreditRefusal("anthropic", "credit balance is too low"),
    "half_open": () => { noteCreditRefusal("anthropic", "credit balance is too low");
      advance(COOLDOWN); acquireCredit("anthropic"); },
    "open after a failed probe": () => { noteCreditRefusal("anthropic", "credit"); advance(COOLDOWN);
      acquireCredit("anthropic").refused("credit balance is too low"); },
  };
  let holes = 0, checked = 0;
  for (const [sName, setup] of Object.entries(states)) {
    for (const [eName, fire] of Object.entries(events2)) {
      resetCreditBreakers();
      setup();
      fire(acquireCredit("anthropic"));
      advance(COOLDOWN + LEASE + 1);
      const g = acquireCredit("anthropic");
      const reachable = g.allowed;                 // closed => ordinary call; open => probe
      checked += 1;
      if (!reachable) { holes += 1; console.log(`       hole: ${sName} + ${eName}`); }
    }
  }
  ok("every state/event pair reaches a call within cooldown + lease", holes === 0,
    `${checked} pairs checked, ${holes} that could latch`);

  // The hung probe specifically: the caller never reports back, ever.
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  acquireCredit("anthropic");                        // takes the probe and disappears
  advance(LEASE - 1);
  ok("the abandoned probe holds its slot for the lease", acquireCredit("anthropic").allowed === false);
  advance(2);
  const reclaimed = acquireCredit("anthropic");
  ok("then the next caller takes it — half-open cannot latch either",
    reclaimed.allowed === true && reclaimed.probe === true,
    `worst-case recovery with a hung probe is ${(COOLDOWN + LEASE) / 1000}s`);
}

console.log("\n8. A NON-CREDIT ERROR BEHAVES EXACTLY AS IT DID BEFORE");
{
  resetCreditBreakers();
  anthropicReply = () => json({ type: "error", error: { type: "not_found_error",
    message: "model: claude-opus-9" } }, 404);
  let before = netSnapshot();
  const err = await askOnce("flow").catch((e) => e);
  ok("the request still goes out", netDelta(before).anthropic === 1);
  ok("the original error is thrown, untouched and unwrapped",
    !(err instanceof OutOfCredit) && /claude-opus-9/.test(String(err?.message)),
    String(err?.message).slice(0, 60));
  ok("the breaker stays closed", creditBreakerState("anthropic").state === "closed");
  before = netSnapshot();
  await askOnce("flow").catch(() => {});
  ok("so the next call is not suppressed", netDelta(before).anthropic === 1,
    "a 404 must not become an outage");
  anthropicReply = creditRefusal400;
}

console.log("\n9. THE OWNER CAN SEE IT");
{
  resetCreditBreakers();
  ok("nothing to report when both providers are healthy", openCreditBreakers().length === 0);
  noteCreditRefusal("xai", "xai 403: all available credits used");
  const open = openCreditBreakers();
  ok("an open breaker is listed for the heartbeat's HQ branch", open.length === 1 &&
    open[0].provider === "xai" && open[0].state === "open");
  ok("...with the operator's countdown to recovery on it", open[0].probeReadyInMs === COOLDOWN,
    `probeReadyInMs ${open[0].probeReadyInMs}`);

  const office = (await import("node:fs")).readFileSync(
    new URL("./src/office.js", import.meta.url), "utf8");
  ok("and the heartbeat actually renders it, beside providerCredit",
    /providerCredit: hqViewer \?[\s\S]{0,1600}creditBreakers: hqViewer \? openCreditBreakers/.test(office),
    "the live switch belongs next to the billing history it explains");
  ok("owner-only, like the billing block it sits next to",
    /creditBreakers: hqViewer \? openCreditBreakers\(\{ now \}\) : null/.test(office));
}

console.log("\n10. BOUNDS");
{
  ok("the cooldown is bounded on both ends", COOLDOWN >= 5_000 && COOLDOWN <= 900_000,
    `${COOLDOWN}ms — under 5s it is the retry storm again, over 15min the desk looks dead`);
  ok("the probe lease outlasts the slowest legitimate call", LEASE >= 30_000 && LEASE >= COOLDOWN,
    `${LEASE}ms vs grok's 120s x_search timeout`);
}

/* ══════════════════════════════════════════════════════════════════════════════════
 * 11-15: the five defects an adversarial pass reproduced against this module on
 * 2026-09-07. 11 and 12 both defeat section 6 — the property the feature exists for.
 * ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\n11. A BILLED RESPONSE IS PROOF OF FUNDING, EVEN WHEN IT FAILS VALIDATION");
{
  /* The attack: account empty, breaker open, operator tops up, the probe goes out and
     the provider ANSWERS AND BILLS — but the answer is truncated or off-contract. If
     that reaches gate.failure(), the one call that PROVED the account is funded is the
     call that re-opens the breaker, and the desk pays $0.005 to conclude it is broke. */
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  anthropicReply = anthropicStream200("no contract here at all", "max_tokens");
  let before = netSnapshot();
  const spendBefore = llm.spend.usd;
  const err = await askOnce("flow").catch((e) => e);
  const billed = llm.spend.usd - spendBefore;
  ok("the probe reaches the provider", netDelta(before).anthropic >= 1,
    `${netDelta(before).anthropic} request(s)`);
  ok("...and the provider billed us for it", billed > 0, `metered $${billed.toFixed(4)}`);
  ok("the truncation surfaces to the caller untouched", !(err instanceof OutOfCredit) &&
    /ran out of tokens/.test(String(err?.message)), String(err?.message).slice(0, 64));
  ok("THE BREAKER CLOSES — a bill is proof the account pays",
    creditBreakerState("anthropic").state === "closed",
    `state ${creditBreakerState("anthropic").state} after a metered $${billed.toFixed(4)}`);

  // The other half of the finding: a response that parses but fails the seat's schema.
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN);
  anthropicReply = anthropicStream200('{"not_the":"contract"}');
  const err2 = await askOnce("flow").catch((e) => e);
  ok("a schema mismatch on a billed response closes it too",
    /did not match contract/.test(String(err2?.message)) &&
    creditBreakerState("anthropic").state === "closed",
    `${String(err2?.message).slice(0, 44)} · state ${creditBreakerState("anthropic").state}`);

  before = netSnapshot();
  anthropicReply = anthropicStream200('{"verdict":"buy"}');
  const good = await askOnce("flow").catch((e) => e);
  ok("so the desk is live on the very next call", netDelta(before).anthropic === 1 &&
    good?.verdict === "buy", `${netDelta(before).anthropic} request, verdict ${good?.verdict}`);
  anthropicReply = creditRefusal400;
}

console.log("\n12. A NON-CREDIT FAULT MUST NOT KEEP A FUNDED DESK SILENT");
{
  /* The attack: the breaker opens on a real refusal, the operator tops up, but a
     provider-wide NON-credit fault is now present (a mis-set model after a retier, a
     revoked key, blocked egress). Every probe fails for that reason, re-opens with a
     fresh cooldown, and never ends — a funded desk, silent, reporting a credit outage
     it does not have. The breaker's mandate is credit; it must not stay open on
     evidence it never gathered. */
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");   // genuinely dry
  anthropicReply = notFound404;                                  // topped up, but misconfigured
  const before = netSnapshot();
  let lastErr = null, closedAfterProbe = null, refusedSiblings = 0, siblingRequests = 0;
  for (let minute = 1; minute <= 60; minute++) {
    advance(COOLDOWN);
    lastErr = await askOnce("probe").catch((e) => e);
    if (closedAfterProbe == null && creditBreakerState("anthropic").state === "closed") {
      closedAfterProbe = minute;
    }
    const b = netSnapshot();
    for (let seat = 0; seat < 14; seat++) {
      const e = await askOnce(`seat${seat}`).catch((x) => x);
      if (e instanceof OutOfCredit) refusedSiblings += 1;
    }
    siblingRequests += netDelta(b).anthropic;
  }
  ok("after 60 simulated minutes the breaker has stood down, not latched",
    creditBreakerState("anthropic").state === "closed",
    `state ${creditBreakerState("anthropic").state}`);
  ok("it stands down after exactly two consecutive non-credit probes",
    closedAfterProbe === 2, `closed after probe ${closedAfterProbe}`);
  ok("the desk fails LOUDLY with the true fault, not quietly as out-of-credit",
    !(lastErr instanceof OutOfCredit) && /claude-opus-9/.test(String(lastErr?.message)),
    String(lastErr?.message).slice(0, 64));
  /* Minute 1: the probe fails, the breaker re-opens, its 14 siblings are refused for
     free. Minute 2: the second consecutive non-credit probe stands the breaker down
     THAT INSTANT, so those siblings already call out, as does every minute after. */
  ok("sibling seats are suppressed for one re-opened minute and no longer",
    refusedSiblings === 14, `${refusedSiblings} sibling refusals across the whole hour`);
  ok("...and are calling out for the other 59 minutes",
    siblingRequests === 59 * 14, `${siblingRequests} sibling requests`);
  ok("no other provider was touched", netDelta(before).xai === 0);

  // A genuine credit refusal resets the counter: two non-credit probes SEPARATED by a
  // real refusal must not add up to a stand-down.
  resetCreditBreakers();
  noteCreditRefusal("anthropic", "credit balance is too low");
  advance(COOLDOWN); anthropicReply = notFound404;
  await askOnce("probe").catch(() => {});                 // non-credit probe #1
  advance(COOLDOWN); anthropicReply = creditRefusal400;
  await askOnce("probe").catch(() => {});                 // the account really is dry again
  advance(COOLDOWN); anthropicReply = notFound404;
  await askOnce("probe").catch(() => {});                 // non-credit probe #1 again
  ok("a genuine credit refusal resets the non-credit count",
    creditBreakerState("anthropic").state === "open",
    `state ${creditBreakerState("anthropic").state} — one non-credit probe is not two`);
  anthropicReply = creditRefusal400;
}

console.log("\n13. A STALE IN-FLIGHT CALL CANNOT RE-OPEN A BREAKER THAT HAS RECOVERED");
{
  /* The attack: a seat acquires a gate while the breaker is CLOSED and its request is
     in the air. The account runs dry, a sibling opens the breaker, the operator tops
     up, the probe succeeds and the desk is live. Then the first seat's request finally
     reports its credit error and re-opens a healthy breaker. */
  resetCreditBreakers();
  const inFlight = acquireCredit("anthropic");
  ok("a healthy breaker lets the first seat out", inFlight.allowed === true);

  noteCreditRefusal("anthropic", "credit balance is too low");    // a sibling hits the wall
  advance(COOLDOWN);
  anthropicReply = anthropicStream200('{"verdict":"buy"}');       // the operator tops up
  await askOnce("probe").catch(() => {});
  ok("the probe closes it and the desk is live", creditBreakerState("anthropic").state === "closed");

  inFlight.refused("Your credit balance is too low to access the Anthropic API");
  ok("THE STALE REPORT IS IGNORED — the recovered breaker stays closed",
    creditBreakerState("anthropic").state === "closed",
    `state ${creditBreakerState("anthropic").state} after a report from a request older than the top-up`);
  const before = netSnapshot();
  await askOnce("flow").catch(() => {});
  ok("so the next ordinary call still reaches the provider", netDelta(before).anthropic === 1);

  // The guard must not disarm the breaker: a CURRENT refusal still opens it.
  acquireCredit("anthropic").refused("Your credit balance is too low");
  ok("a current credit refusal still opens it",
    creditBreakerState("anthropic").state === "open");
  anthropicReply = creditRefusal400;
}

console.log("\n14. A TYPO IN THE ENV CANNOT SILENTLY DISARM THE BREAKER");
{
  /* DESK_CREDIT_BREAKER_COOLDOWN_S=60s is the natural mistake for a name ending in _S.
     Number("60s") is NaN, NaN survives Math.max and Math.min, and `now < readyAt` is
     false against NaN — so every caller is allowed through, the breaker does nothing,
     and the heartbeat reports half_open with probeReadyInMs null forever. */
  const { spawnSync } = await import("node:child_process");
  const probe = `
    process.env.ANTHROPIC_API_KEY = "k";
    const m = await import("./src/lib/llm.js");
    console.log("RESOLVED " + m.CREDIT_BREAKER_COOLDOWN_MS + " " + m.CREDIT_BREAKER_PROBE_LEASE_MS);
    m.noteCreditRefusal("anthropic", "credit balance is too low");
    const s = m.creditBreakerState("anthropic");
    console.log("STATE " + s.state + " " + s.probeReadyInMs);
    console.log("ALLOWED " + m.acquireCredit("anthropic").allowed);
  `;
  const spawnWith = (env) => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DESK_CREDIT_BREAKER_COOLDOWN_S: "60s",
        DESK_CREDIT_BREAKER_PROBE_LEASE_S: "5m", ...env },
    });
    return `${run.stdout ?? ""}${run.stderr ?? ""}`;
  };
  const out = spawnWith({});
  const resolved = /RESOLVED (\S+) (\S+)/.exec(out);
  ok("a non-numeric cooldown falls back to the documented default, not NaN",
    resolved?.[1] === "60000", `resolved cooldown ${resolved?.[1]}`);
  ok("...and so does a non-numeric lease", resolved?.[2] === "300000",
    `resolved lease ${resolved?.[2]}`);
  ok("the breaker still refuses instead of becoming a no-op", /ALLOWED false/.test(out),
    out.match(/ALLOWED \w+/)?.[0] ?? "(no ALLOWED line)");
  const state = /STATE (\w+) (\S+)/.exec(out);
  const countdown = Number(state?.[2]);
  ok("and the heartbeat's countdown is a real number, not null or NaN",
    state?.[1] === "open" && Number.isFinite(countdown) &&
    countdown > 55_000 && countdown <= 60_000,
    out.match(/STATE .*/)?.[0] ?? "(no STATE line)");
  ok("the typo itself is logged, not swallowed",
    /DESK_CREDIT_BREAKER_COOLDOWN_S/.test(out) && /DESK_CREDIT_BREAKER_PROBE_LEASE_S/.test(out),
    (out.split("\n").find((l) => /CREDIT_BREAKER/.test(l) && !/^RESOLVED/.test(l)) ||
      "(nothing logged)").slice(0, 108));
  const booted = spawnWith({ NODE_ENV: "development" });
  const bootLines = booted.split("\n").filter((l) => /\[credit breaker\] cooldown/.test(l));
  ok("the resolved cooldown and lease are printed once at boot",
    bootLines.length === 1 && /cooldown 60s/.test(bootLines[0]) &&
    /probe lease 300s/.test(bootLines[0]),
    (bootLines[0] || "(no boot line)").slice(0, 112));
}

console.log("\n15. THE RETRY POLICY HAS EXACTLY ONE OWNER");
{
  /* ask({attempts:3}) against a 529 produced NINE network requests: the SDK retries
     internally on top of ask()'s own loop, so the two policies multiply. ask()'s loop
     is the one that emits seat:retry and backs off, so it keeps the job alone. */
  resetCreditBreakers();
  anthropicReply = overloaded529;
  const retries = [];
  const onRetry = (e) => { if (e.type === "seat:retry") retries.push(e); };
  bus.on("event", onRetry);
  const before = netSnapshot();
  const err = await ask({ seat: "flow", model: "claude-opus-5", effort: "low",
    schema: SCHEMA, prompt: "one candidate", maxTokens: 512, attempts: 3 }).catch((e) => e);
  bus.off("event", onRetry);
  const d = netDelta(before);
  ok("three attempts cost exactly three requests, not nine", d.anthropic === 3,
    `${d.anthropic} network requests for attempts:3 against a 529`);
  ok("ask()'s own loop is the one retrying, and it says so in the chronicle",
    retries.length === 3, `${retries.length} seat:retry events`);
  ok("the 529 still surfaces to the caller", !(err instanceof OutOfCredit) &&
    /529|overload/i.test(String(err?.message)), String(err?.message).slice(0, 56));
  ok("a 529 storm never opens the credit breaker",
    creditBreakerState("anthropic").state === "closed");
  anthropicReply = creditRefusal400;
}


/* ══════════════════════════════════════════════════════════════════════════════════
 * 16: SECTION 6 AGAIN, THROUGH THE FIXED CODE — because findings 1 and 2 both attacked
 * recovery itself, and a property is only proven by the run that could have broken it.
 * ══════════════════════════════════════════════════════════════════════════════════ */
console.log("\n16. THE HEADLINE PROPERTY, RE-PROVEN AFTER THE FIVE FIXES");
{
  resetCreditBreakers();
  anthropicReply = creditRefusal400;
  const openedAt = NOW;
  const first = await askOnce("flow").catch((e) => e);
  ok("the account runs dry on a real call", first instanceof OutOfCredit);

  let before = netSnapshot();
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let seat = 0; seat < 15; seat++) await askOnce(`seat${seat}`).catch(() => {});
  }
  ok("90 seat calls cost zero requests while it is genuinely dry",
    netDelta(before).anthropic === 0, `${netDelta(before).anthropic} requests`);

  /* THE OPERATOR TOPS UP — and the first answer back is BILLED BUT OFF-CONTRACT, the
     exact response finding 1 read as "still broke". Nothing is deployed or restarted. */
  const toppedUpAt = advance(37_000);
  anthropicReply = anthropicStream200("prose, not the contract", "max_tokens");
  advance(COOLDOWN - (NOW - openedAt) + 1);
  const probeAt = NOW;
  const spendBefore = llm.spend.usd;
  const probeErr = await askOnce("probe").catch((e) => e);
  ok("the probe is billed and then fails validation",
    llm.spend.usd > spendBefore && /ran out of tokens/.test(String(probeErr?.message)),
    `metered $${(llm.spend.usd - spendBefore).toFixed(4)}, then ${String(probeErr?.message).slice(0, 34)}`);
  ok("...and the desk is live anyway, because the bill is the proof",
    creditBreakerState("anthropic").state === "closed");

  anthropicReply = anthropicStream200('{"verdict":"buy"}');
  before = netSnapshot();
  const back = await askOnce("flow").catch((e) => e);
  ok("THE VERY NEXT ORDINARY CALL REACHES THE PROVIDER AND ANSWERS IN CONTRACT",
    netDelta(before).anthropic === 1 && back?.verdict === "buy",
    `${netDelta(before).anthropic} request, verdict ${back?.verdict} — no deploy, no restart, no manual step`);
  const ttr = NOW - toppedUpAt;
  ok("time-to-recovery is still inside the cooldown bound", ttr <= COOLDOWN,
    `MEASURED ${(ttr / 1000).toFixed(1)}s from top-up to serving again, bound ${COOLDOWN / 1000}s`);

  /* And the second half of the headline: when the fault is NOT credit, the silence is
     bounded too. Finding 2's version of this ran forever. */
  resetCreditBreakers();
  anthropicReply = creditRefusal400;
  await askOnce("flow").catch(() => {});
  const openedAt2 = NOW;
  anthropicReply = notFound404;                 // topped up, but the model name is wrong
  let standDownAt = null, faultErr = null;
  for (let i = 0; i < 20 && standDownAt == null; i++) {
    advance(COOLDOWN);
    faultErr = await askOnce("probe").catch((e) => e);
    if (creditBreakerState("anthropic").state === "closed") standDownAt = NOW;
  }
  ok("a NON-credit fault silences the desk for a bounded time, then surfaces itself",
    standDownAt != null && standDownAt - openedAt2 <= 2 * COOLDOWN &&
    /claude-opus-9/.test(String(faultErr?.message)),
    `${standDownAt == null ? "never" : ((standDownAt - openedAt2) / 1000).toFixed(0) + "s"} ` +
    `to stand-down, bound ${(2 * COOLDOWN) / 1000}s`);

  console.log(`       ── time-to-recovery after a top-up: ${(ttr / 1000).toFixed(1)}s measured\n` +
    `          worst case, credit returns:        ${COOLDOWN / 1000}s\n` +
    `          worst case, plus a hung probe:     ${(COOLDOWN + LEASE) / 1000}s\n` +
    `          worst case, fault was NOT credit:  ${(CREDIT_BREAKER_STAND_DOWN_PROBES * COOLDOWN) / 1000}s to the true error`);
  anthropicReply = creditRefusal400;
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
