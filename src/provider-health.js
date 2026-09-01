/* Two different ways to run out of money, and only the first was recognised.
 * "balance is empty" is the account having nothing left; "metered provider ceiling"
 * is the desk's own pre-flight refusing a call that would cross the configured spend
 * limit (llm.js). The second failed EVERY seat individually rather than identically,
 * so neither this matcher nor the DEGRADED identical-error check caught it — the
 * heartbeat read RUNNING - healthy while 149 calls were withheld for "fewer than
 * three analysts returned", a research verdict that was really a billing verdict.
 * A blocker that dresses as a judgement is the worst kind, so it gets named. */
const CREDIT_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /(?:the\s+)?anthropic balance is empty/i,
  /insufficient (?:api )?credits?/i,
  /metered provider ceiling/i,
  /provider (?:spend|budget) (?:cap|ceiling|limit) reached/i,
];

/** True only for errors that specifically identify exhausted provider credit. */
export function isProviderCreditError(error) {
  const message = String(error ?? "");
  return CREDIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Raw provider wording is useful to the authenticated house operator, but the
 * global heartbeat is intentionally public. Keep that diagnostic out of anonymous
 * responses instead of assuming every upstream error string is secret-free. */
export function providerErrorForViewer(error, { isOwner = false } = {}) {
  return isOwner ? String(error ?? "").slice(0, 240) : null;
}

function eventData(event) {
  if (event?.data && typeof event.data === "object") return event.data;
  try { return JSON.parse(event?.data ?? "{}"); }
  catch { return {}; }
}

/**
 * Derive provider-credit health from durable desk events.
 *
 * `desk:out_of_credit` is the direct signal, but chronicle writes are deliberately
 * best-effort. The desk also records the propagated error as `seat:failed`, so that
 * durable fallback must participate in health or a fully starved desk can report green.
 * A successful paid seat proves recovery only after a short grace period. Seats run in
 * parallel, so one request that was already in flight can complete moments after its
 * siblings discover the empty balance; that completion is part of the failed batch,
 * not evidence that somebody topped the account up.
 */
export function providerCreditHealth(events, {
  nowMs = Date.now(),
  windowMs = 6 * 60 * 60 * 1000,
  recoveryGraceMs = 5 * 60 * 1000,
} = {}) {
  const cutoff = nowMs - windowMs;
  let failures = 0;
  let lastFailureTs = null;
  let lastFailureError = "";
  let lastSuccessTs = null;

  for (const event of events ?? []) {
    const ts = Number(event?.ts);
    if (!Number.isFinite(ts) || ts <= cutoff || ts > nowMs) continue;

    if (event.type === "seat:done") {
      if (lastSuccessTs == null || ts > lastSuccessTs) lastSuccessTs = ts;
      continue;
    }

    const isCreditFailure = event.type === "desk:out_of_credit" ||
      (event.type === "seat:failed" && isProviderCreditError(eventData(event).error));
    if (!isCreditFailure) continue;

    failures++;
    // Keep the newest failure's TEXT, not just its time: the caller must tell an
    // empty balance (top up) from a spend ceiling (raise the limit) — different fixes.
    if (lastFailureTs == null || ts > lastFailureTs) {
      lastFailureTs = ts;
      lastFailureError = String(eventData(event).error ?? "");
    }
  }

  const recovered = lastFailureTs != null && lastSuccessTs != null &&
    lastSuccessTs - lastFailureTs >= recoveryGraceMs;
  return {
    blocked: lastFailureTs != null && !recovered,
    failures,
    lastFailureTs,
    lastFailureError,
    lastSuccessTs,
    recoveryGraceMs,
  };
}
