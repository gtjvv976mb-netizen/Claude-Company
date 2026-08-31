const CREDIT_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /(?:the\s+)?anthropic balance is empty/i,
  /insufficient (?:api )?credits?/i,
];

/** True only for errors that specifically identify exhausted provider credit. */
export function isProviderCreditError(error) {
  const message = String(error ?? "");
  return CREDIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
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
    if (lastFailureTs == null || ts > lastFailureTs) lastFailureTs = ts;
  }

  const recovered = lastFailureTs != null && lastSuccessTs != null &&
    lastSuccessTs - lastFailureTs >= recoveryGraceMs;
  return {
    blocked: lastFailureTs != null && !recovered,
    failures,
    lastFailureTs,
    lastSuccessTs,
    recoveryGraceMs,
  };
}
