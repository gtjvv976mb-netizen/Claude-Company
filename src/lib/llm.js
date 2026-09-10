import { UNTRUSTED_BRIEF } from "../untrusted.js";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { emit, runContext } from "./bus.js";
import { CHARTER, cfg, CYCLE_BUDGET_DEFAULT_USD } from "../config.js";
import db, { ensureColumn } from "./store.js";
// No cycle: desk-policy reaches only store, bus and canonical, never back into llm.
import { withPolicy } from "../desk-policy.js";

db.exec(`
CREATE TABLE IF NOT EXISTS llm_spend (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  floor    INTEGER,
  floor_attributed INTEGER NOT NULL DEFAULT 0,
  evidence_scope TEXT NOT NULL DEFAULT 'unattributed',
  seat     TEXT, model TEXT, effort TEXT,
  in_tok   INTEGER, out_tok INTEGER, cached_tok INTEGER,
  usd      REAL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_ts ON llm_spend(ts);
`);

/**
 * WHERE THE MONEY ACTUALLY GOES, per seat.
 *
 * The desk records every model call's seat, model, effort and cost, and nothing has ever
 * read it back. "Make it cheaper" without this is guesswork — and guesswork here means
 * cutting the seat that is cheap and load-bearing while leaving the one that is 44% of
 * the bill untouched. Aggregate only: no prompt text, no evidence, no wallet.
 */
export function spendBySeat({ hours = 24 } = {}) {
  const since = spendNow() - Math.max(1, Number(hours) || 24) * 3600e3;
  const rows = db.prepare(`
    SELECT seat, model, effort,
           COUNT(*) AS calls,
           SUM(usd) AS usd,
           SUM(in_tok) AS inTok,
           SUM(out_tok) AS outTok,
           SUM(cached_tok) AS cachedTok
    FROM llm_spend WHERE ts >= ?
    GROUP BY seat, model, effort
    ORDER BY usd DESC`).all(since);
  const total = rows.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  const workups = db.prepare(
    "SELECT COUNT(DISTINCT ts / 600000) n FROM llm_spend WHERE ts >= ?").get(since)?.n ?? 0;
  return {
    hours, sinceMs: since,
    totalUsd: Number(total.toFixed(4)),
    seats: rows.map((r) => ({
      seat: r.seat, model: r.model, effort: r.effort,
      calls: r.calls,
      usd: Number((Number(r.usd) || 0).toFixed(4)),
      pctOfTotal: total > 0 ? Number(((Number(r.usd) || 0) / total * 100).toFixed(1)) : 0,
      usdPerCall: r.calls > 0 ? Number(((Number(r.usd) || 0) / r.calls).toFixed(4)) : 0,
      inTok: r.inTok, outTok: r.outTok, cachedTok: r.cachedTok,
      // A seat whose input dwarfs its output is paying to READ; one whose output
      // dominates is paying to THINK. They are cut in completely different ways.
      shape: (r.outTok || 0) > (r.inTok || 0) / 4 ? "thinking" : "reading",
    })),
    tenMinuteBuckets: workups,
  };
}

/**
 * THE BILL, ROW BY ROW. spendBySeat gives means, and a mean is the wrong number for a
 * cost simulation: the measured per-seat medians (Red Team $0.37, Narrative $0.21,
 * PM $0.18 … Liquidity $0.03) sit under a tail the server-side fallback and retries
 * can stretch to dollars on one call, and only the rows carry that tail. Five columns —
 * seat, model, effort, usd, ts — and nothing else: no floor, no prompt, no evidence.
 * Newest first, bounded, so a public GET can never page the whole ledger out.
 */
export function spendRows({ sinceMs = 0, limit = 5000 } = {}) {
  const cap = Math.max(1, Math.min(20_000, Number(limit) || 5000));
  return db.prepare(`SELECT seat, model, effort, usd, ts FROM llm_spend
                     WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(Number(sinceMs) || 0, cap)
    .map((r) => ({ seat: r.seat, model: r.model, effort: r.effort,
      usd: Number(r.usd) || 0, ts: r.ts }));
}

ensureColumn("llm_spend", "floor", "INTEGER");
// Existing nulls predate floor attribution and may contain tenant spend. Keep them out
// of house-only improvement evidence rather than laundering unknown provenance as HQ.
ensureColumn("llm_spend", "floor_attributed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("llm_spend", "evidence_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_spend_floor_ts
         ON llm_spend(floor_attributed,evidence_scope,floor,ts)`);

/** Billing failures are terminal for a cycle: retrying just burns time. */
export class OutOfCredit extends Error {}

/** The daily cap tripping is handled exactly like an empty balance — every existing
 * OutOfCredit path (halt the cycle, fail the floor run cleanly) already does the
 * right thing, so the brake subclasses it rather than inventing a parallel path. */
export class BudgetExhausted extends OutOfCredit {}

/* ═══════════════════════════════════════════════════════════════════════════════
 * THE CREDIT CIRCUIT BREAKER — one per provider, in the layer that holds the key.
 *
 * WHY: a dry account does not slow the desk down, it makes it spend the day being
 * told no. Measured 2026-09-06 with both balances empty: 1,323 refused requests an
 * hour. Letting OutOfCredit escape desk.js's Promise.allSettled and taking the 600s
 * blocked gap instead of the 45s worked gap cut cycles/hour 37 -> 17 — and refusals
 * only 1,323 -> 1,254, a 5% dent. The reason is concurrency: PENTHOUSE_WORKUP_CONCURRENCY
 * is 3, so when one workup hits the wall and halts the cycle, the two still in flight
 * fire every remaining seat at a provider that is certainly going to refuse. The halt
 * stops the NEXT candidate; it cannot un-fire the calls already in the air. Nothing
 * short of refusing at the provider layer, before the request is built, removes them —
 * hence a breaker here rather than another guard further up. ~1,250 refusals an hour
 * also costs Render CPU and ~224,000 junk chronicle rows a day.
 *
 * THE PROPERTY THAT MATTERS MOST IS RECOVERY, NOT REFUSAL. The operator tops the
 * account up and expects the desk back with no deploy, no restart, no manual step. A
 * breaker that latches open is strictly worse than the bug it replaces: the desk would
 * look dead while the account was funded, and nothing in the heartbeat would say why.
 * So the half-open probe is not an optimisation, it is the whole point, and the state
 * machine below is built so that it CANNOT be skipped:
 *
 *   - The only exit from "open" towards a CALL is acquire() itself, which converts
 *     open -> half_open the first time it is called after the cooldown. There is no
 *     timer to be cleared, no listener to be unsubscribed, nothing that a restart can
 *     lose. If the desk is calling the provider at all, the probe happens.
 *   - "half_open" holds exactly ONE probe, so a top-up is tested by a single call and
 *     never by a thundering herd of fifteen seats.
 *   - A probe that never reports (a promise that never settles, a killed await) would
 *     otherwise latch half_open forever, so the probe holds a LEASE. Once it expires
 *     the next caller takes the probe instead. Every state therefore drains back to a
 *     new probe on a bounded clock.
 *
 *   - A probe that is BILLED is proof of funding whatever it then says, so success is
 *     reported at the meter, not after the response has been validated. A truncated or
 *     off-contract answer used to re-open the breaker on the one call that had just
 *     proved the account was funded.
 *   - And the breaker stands itself down rather than latch on evidence it never
 *     gathered: CREDIT_BREAKER_STAND_DOWN_PROBES consecutive NON-credit probe failures
 *     close it and let the true error surface. A revoked key or a mis-set model name is
 *     not a credit outage and must not be reported as one for an afternoon.
 *
 * Maximum time-to-recovery, from credit returning to ordinary calls flowing again:
 *   COOLDOWN_MS                      + the time to the desk's next call   (normal)
 *   COOLDOWN_MS + PROBE_LEASE_MS     + the time to the desk's next call   (hung probe)
 *   COOLDOWN_MS x STAND_DOWN_PROBES  + the time to the desk's next call   (not credit)
 * With the defaults that is 60s, 360s and 120s. test-credit-breaker.mjs prints all
 * three, measured.
 *
 * PER PROVIDER, STRICTLY. Anthropic and xAI are separate accounts on separate cards,
 * and on 2026-09-05 the operator topped up Anthropic while xAI was the dry one. A
 * shared breaker would have blacked out the funded provider. The map below is keyed by
 * provider and no code path reads another provider's record.
 *
 * IT NEVER SWALLOWS A NON-CREDIT ERROR. Only a call site that has positively
 * identified a credit refusal calls refused(); a timeout, a 500 or a schema mismatch
 * goes to failure(), which cannot open a closed breaker and leaves the error itself
 * completely untouched on its way to the caller.
 *
 * AND A REPORT ONLY COUNTS FOR THE BREAKER IT WAS ISSUED AGAINST. Every gate carries
 * the record's epoch, which changes on every open and every close, so a request that
 * was already in the air when the outage began cannot re-open a breaker that has since
 * recovered — the ownership guard failure() always had, extended to refused().
 * ═══════════════════════════════════════════════════════════════════════════════ */

/* A NON-NUMBER MUST NOT BECOME A NO-OP BREAKER.
 *
 * DESK_CREDIT_BREAKER_COOLDOWN_S=60s is the natural mistake for a name ending in _S,
 * and Number("60s") is NaN. NaN survives BOTH Math.max and Math.min unchanged, so the
 * bounds below cannot catch it — and `now < readyAt` is false against NaN, which lets
 * every caller straight through. The breaker would do nothing at all while the owner's
 * heartbeat showed an open breaker with a null countdown, forever. Parse through
 * Number.isFinite with the documented default as the fallback, and say so out loud:
 * a typo the operator can see is a typo the operator fixes. */
function breakerSeconds(name, defaultSeconds) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultSeconds;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  console.warn(`[credit breaker] ${name}="${raw}" is not a number ` +
    `— using the default ${defaultSeconds}s (the value is SECONDS, digits only)`);
  return defaultSeconds;
}

/** Bounded on both ends deliberately. Under 5s the breaker is just the retry storm
 *  with extra steps; over 15 minutes the desk looks dead for a quarter of an hour
 *  after a top-up, which is the failure mode this whole thing exists to prevent. */
export const CREDIT_BREAKER_COOLDOWN_MS = Math.min(15 * 60_000, Math.max(5_000,
  Math.round(breakerSeconds("DESK_CREDIT_BREAKER_COOLDOWN_S", 60) * 1000)));

/** How long a probe may hold the single slot before another caller may take it. Must
 *  outlast the slowest legitimate call — a max-effort 32k-token stream, or grok's 120s
 *  x_search — or a slow probe would be lapped and become the herd it prevents. */
export const CREDIT_BREAKER_PROBE_LEASE_MS = Math.max(CREDIT_BREAKER_COOLDOWN_MS,
  Math.min(30 * 60_000, Math.max(30_000,
    Math.round(breakerSeconds("DESK_CREDIT_BREAKER_PROBE_LEASE_S", 300) * 1000))));

/** How many CONSECUTIVE non-credit probe failures stand the breaker down. See
 *  gateFor().failure(): the breaker's mandate is credit and nothing else, so it must
 *  not stay open on evidence it never gathered. */
export const CREDIT_BREAKER_STAND_DOWN_PROBES = 2;

/* Printed once, at boot, so a mis-set cooldown is visible in the log rather than
   silently in effect. Skipped under the test runner, where 80 files would each say it. */
if (process.env.NODE_ENV !== "test") {
  console.log(`[credit breaker] cooldown ${CREDIT_BREAKER_COOLDOWN_MS / 1000}s · ` +
    `probe lease ${CREDIT_BREAKER_PROBE_LEASE_MS / 1000}s · ` +
    `stand-down after ${CREDIT_BREAKER_STAND_DOWN_PROBES} consecutive non-credit probes`);
}

/* Time is injected so the recovery test can advance a clock instead of sleeping for a
 * minute — a test that sleeps for the real cooldown is a test nobody runs. Production
 * never calls this; the default is the wall clock. */
let breakerClock = () => Date.now();
export function setCreditBreakerClock(fn) {
  breakerClock = typeof fn === "function" ? fn : () => Date.now();
}

/* THE SAME SEAM FOR THE MONEY RAILS, AND FOR THE SAME REASON.
 *
 * assertDailyBudget's three windows (24h cap, the hourly pace, the lane reserve) and
 * reserveProviderBudget's provider ceiling all key on Date.now(), so a simulation that
 * runs fifty cycles inside one wall-clock minute measures the PACE BRAKE rather than the
 * thing it set out to measure. SIM B's answer was to widen the cap to $1,000,000 and say
 * so in its header — which means the one end-to-end run of the cycle never exercised the
 * $16/pass, $200/day and hourly rails at all.
 *
 * With the clock injected, SIM C runs those rails at their real values and advances time
 * the way the desk experiences it. Production never calls this; the default is the wall
 * clock, and every reader below goes through spendNow() so a future window cannot be
 * added that quietly reads Date.now() directly. */
let spendClock = () => Date.now();
export function setSpendClock(fn) {
  spendClock = typeof fn === "function" ? fn : () => Date.now();
}
export const spendNow = () => spendClock();

const CREDIT_BREAKERS = new Map();
const breakerRecord = (provider) => {
  let b = CREDIT_BREAKERS.get(provider);
  if (!b) {
    b = { provider, state: "closed", openedAt: null, probeStartedAt: null,
      /* epoch changes on EVERY open and EVERY close, and every gate carries the epoch
         it was issued under. That is what tells a report from a request that is still
         in the air apart from a report about the state the breaker is in NOW. */
      epoch: 0,
      probeSeq: 0, opens: 0, probes: 0, refusedWhileOpen: 0,
      nonCreditProbeFailures: 0, lastError: null };
    CREDIT_BREAKERS.set(provider, b);
  }
  return b;
};

/* The refusal is worded as the PROVIDER's own refusal, on purpose. provider-health.js
 * classifies an outage by matching the error text ("anthropic balance is empty",
 * "xai 403 ... credit"), and the heartbeat's BLOCKED state is built on that match. A
 * breaker that invented new wording would have silently turned the heartbeat green the
 * moment it started working, which is the opposite of visible. */
function breakerRefusalMessage(provider, waitMs) {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  return provider === "xai"
    ? `xai 403: credit breaker open — the xAI account refused for lack of credits; ` +
      `no request sent, next probe in ${secs}s`
    : `the Anthropic balance is empty — the desk cannot think ` +
      `(credit breaker open, no request sent, next probe in ${secs}s)`;
}

/* One place that changes the epoch, so no transition can forget to. The cached
   closed-state gate is dropped with it: a cached gate holding a stale epoch would be a
   gate that can never report a refusal — the "breaker that never opens" bug again. */
function bumpEpoch(b) {
  b.epoch += 1;
  b.closedGate = null;
}

function issueProbe(b, now) {
  b.state = "half_open";
  b.probeStartedAt = now;
  b.probeSeq += 1;
  b.probes += 1;
  return b.probeSeq;
}

/* A gate the breaker refused. Same SHAPE as an allowed gate, deliberately: a caller
   that forgets to check `allowed` should get a harmless no-op, not a TypeError in the
   middle of an outage. Every method is a no-op because no request was made, so this
   call has learned nothing about the account either way. */
const refusedGate = (message, retryInMs) => ({
  allowed: false, probe: false, message, retryInMs,
  success() {}, refused() {}, failure() {},
});

/** A token whose failure() only acts if this call still owns the probe. A late report
 *  from a lapsed probe must not re-open a breaker that has since closed, nor restart
 *  the cooldown of one a newer refusal has already re-opened. */
function gateFor(provider, b, seq) {
  const epoch = b.epoch;
  const owns = () => b.state === "half_open" && b.probeSeq === seq;
  /* A report is only about the breaker it was issued against. Measured 2026-09-07: a
     seat acquired a gate while CLOSED, its request sat in the air through the whole
     outage — dry account, sibling opens the breaker, operator tops up, probe succeeds,
     breaker closes — and then reported its credit error and re-opened a healthy
     breaker. The epoch is the ownership guard failure() always had, extended to the
     one report that could arrive from before the recovery. */
  const current = () => b.epoch === epoch;
  return {
    allowed: true,
    probe: seq != null,
    // Proof the account pays: close, whatever state we were in.
    success() { noteCreditSuccess(provider); },
    // The caller has positively identified a credit refusal. Open (or re-open) — but
    // only if the breaker has not transitioned since this call was let out.
    refused(message) { if (current()) noteCreditRefusal(provider, message); },
    // Anything else. Cannot open a closed breaker; only releases a probe we still own.
    failure(err) {
      if (seq == null || !owns()) return;
      b.probeStartedAt = null;
      b.lastError = String(err?.message ?? err ?? "").slice(0, 240) || b.lastError;
      /* THE BREAKER'S MANDATE IS CREDIT AND NOTHING ELSE, so it must not stay open on
       * evidence it never gathered. A deterministic non-credit fault — a mis-set model
       * name after a retier, a revoked key, blocked egress — fails every probe for a
       * reason that has nothing to do with the balance. Re-opening on each of those
       * kept a FUNDED desk silent indefinitely while reporting a credit outage it no
       * longer had: measured at 60 minutes, 60 spent probes, siblings costing zero
       * requests. After CREDIT_BREAKER_STAND_DOWN_PROBES consecutive non-credit probe
       * failures the breaker stands down and the real error surfaces to the caller as
       * it always would — the desk fails loudly with the true fault instead of quietly
       * as "out of credit". A genuine credit refusal resets the count. */
      b.nonCreditProbeFailures += 1;
      if (b.nonCreditProbeFailures >= CREDIT_BREAKER_STAND_DOWN_PROBES) {
        const downMs = b.openedAt ? Math.max(0, breakerClock() - b.openedAt) : 0;
        b.state = "closed";
        b.openedAt = null;
        bumpEpoch(b);
        emit("desk:breaker_stood_down", { provider, downMs,
          probes: b.nonCreditProbeFailures, refusedWhileOpen: b.refusedWhileOpen,
          reason: "consecutive non-credit probe failures — not a credit outage",
          lastError: b.lastError });
        b.nonCreditProbeFailures = 0;
        b.probes = 0;
        b.refusedWhileOpen = 0;
        return;
      }
      /* Not yet: a probe that failed has not proved the account pays either, so the
       * breaker goes back to open with the cooldown restarted rather than staying
       * half-open with a spent slot. The error itself is untouched throughout. */
      b.state = "open";
      b.openedAt = breakerClock();
    },
  };
}

/**
 * Ask the breaker for permission to call `provider`. Returns a gate:
 *   { allowed: true,  probe }  — go ahead; report back via success/refused/failure
 *   { allowed: false, message, retryInMs } — the caller refuses IN ITS OWN IDIOM
 *
 * The caller does the refusing, not the breaker, because the two providers have
 * different contracts and neither may be quietly changed: llm.js throws OutOfCredit
 * (which desk.js halts the cycle on), while grok.js has always failed open with
 * { ok:false } for a live 403 and must keep doing exactly that — a throw there would
 * let a dry xAI account halt a cycle that a funded Anthropic account could still run,
 * which is the cross-provider blackout this design exists to prevent.
 */
export function acquireCredit(provider, { now = breakerClock() } = {}) {
  const b = breakerRecord(provider);
  /* The hot path — a healthy provider — hands back a cached gate rather than a frozen
     no-op. An earlier draft returned a no-op here and the breaker NEVER OPENED: the very
     first refusal is by definition delivered to a caller holding a closed-state gate, so
     a gate that cannot report a refusal is a breaker that can never trip. Caught by the
     recovery test, which measured fetch calls instead of trusting the state field. */
  if (b.state === "closed") return (b.closedGate ??= gateFor(provider, b, null));

  if (b.state === "open") {
    const readyAt = b.openedAt + CREDIT_BREAKER_COOLDOWN_MS;
    if (now < readyAt) {
      b.refusedWhileOpen += 1;
      return refusedGate(breakerRefusalMessage(provider, readyAt - now), readyAt - now);
    }
    return gateFor(provider, b, issueProbe(b, now));   // the single probe
  }

  // half_open: one probe at a time, until its lease runs out.
  const heldFor = now - (b.probeStartedAt ?? now);
  if (b.probeStartedAt != null && heldFor < CREDIT_BREAKER_PROBE_LEASE_MS) {
    b.refusedWhileOpen += 1;
    const waitMs = CREDIT_BREAKER_PROBE_LEASE_MS - heldFor;
    return refusedGate(breakerRefusalMessage(provider, waitMs), waitMs);
  }
  /* The probe never reported. Reclaim rather than latch — this is the branch that makes
   * "open with no scheduled probe" unreachable. */
  return gateFor(provider, b, issueProbe(b, now));
}

/** A provider refused for credit. Opens that provider's breaker and nobody else's. */
export function noteCreditRefusal(provider, message) {
  const b = breakerRecord(provider);
  const reopened = b.state !== "closed";
  b.state = "open";
  b.openedAt = breakerClock();
  b.probeStartedAt = null;
  b.opens += 1;
  /* The provider named the balance, so whatever non-credit noise came before it is not
     the story any more. Two non-credit probes SEPARATED by a real refusal must not add
     up to a stand-down. */
  b.nonCreditProbeFailures = 0;
  b.lastError = String(message ?? "").slice(0, 240);
  bumpEpoch(b);
  /* The chronicle should show the transition, not just the silence that follows it.
   * Without this the only trace of a breaker doing its job is an absence of events,
   * which reads identically to a dead process. */
  emit("desk:breaker_open", { provider, reopened,
    cooldownMs: CREDIT_BREAKER_COOLDOWN_MS, opens: b.opens,
    reason: reopened ? "probe refused again" : "credit refusal" });
  return b;
}

/** A provider answered and billed. Closes that provider's breaker if it was open. */
export function noteCreditSuccess(provider) {
  const b = CREDIT_BREAKERS.get(provider);
  if (!b || b.state === "closed") return null;   // the hot path: one map get, no work
  const downMs = b.openedAt ? Math.max(0, breakerClock() - b.openedAt) : 0;
  b.state = "closed";
  b.openedAt = null;
  b.probeStartedAt = null;
  b.lastError = null;
  b.nonCreditProbeFailures = 0;
  bumpEpoch(b);
  emit("desk:breaker_closed", { provider, downMs, probes: b.probes,
    refusedWhileOpen: b.refusedWhileOpen });
  b.probes = 0;
  b.refusedWhileOpen = 0;
  return b;
}

/** Snapshot for diagnostics and the owner heartbeat. Read-only: never a transition. */
export function creditBreakerState(provider, { now = breakerClock() } = {}) {
  const b = CREDIT_BREAKERS.get(provider);
  if (!b || b.state === "closed") {
    return { provider, state: "closed", openedAt: null, probeReadyInMs: 0,
      refusedWhileOpen: 0, opens: b?.opens ?? 0, lastError: null };
  }
  const probeReadyInMs = b.state === "open"
    ? Math.max(0, b.openedAt + CREDIT_BREAKER_COOLDOWN_MS - now)
    : Math.max(0, (b.probeStartedAt ?? now) + CREDIT_BREAKER_PROBE_LEASE_MS - now);
  return { provider, state: b.state, openedAt: b.openedAt,
    openedMsAgo: b.openedAt == null ? null : Math.max(0, now - b.openedAt),
    probeInFlight: b.state === "half_open", probeReadyInMs,
    opens: b.opens, probes: b.probes, refusedWhileOpen: b.refusedWhileOpen,
    lastError: b.lastError };
}

/** Every provider whose breaker is not closed, for the owner-only heartbeat branch. */
export function openCreditBreakers({ now = breakerClock() } = {}) {
  const out = [];
  for (const provider of CREDIT_BREAKERS.keys()) {
    const s = creditBreakerState(provider, { now });
    if (s.state !== "closed") out.push(s);
  }
  return out;
}

/** Tests only. Production has no reason to forget an outage it is living through. */
export function resetCreditBreakers() { CREDIT_BREAKERS.clear(); }

/**
 * THE RESERVE — the publishing lane cannot be starved by the scanning lanes.
 *
 * Measured on the live desk: 160 workups in a day, $20.15 of a $25 cap, and ZERO
 * calls. The cause was not strictness — `call:withheld` never fired once, meaning the
 * desk never reached its publish step at all. It was arithmetic. The fresh scan runs
 * every 5 minutes (288 chances a day to spend) while the full cycle — the ONLY lane
 * carrying the mandate hunt, and so the only lane that reliably publishes — runs four
 * times. The scanner ate the day's budget before the publisher could open its mouth:
 * 33 cycles ended on the budget and 24 halted outright, against 2 that genuinely
 * found nothing in the market.
 *
 * So the cap becomes two caps. Opportunistic lanes (the fresh scan, watch promotion)
 * may spend only up to their share; past that the money is RESERVED and only the
 * cycle may draw on it. A tenant's own floor run is never throttled — they paid
 * 250,000 $CLAUDECO for it, and taking payment for work we then refuse to do is not a
 * budget policy, it is a broken promise.
 */
export const OPPORTUNISTIC_SHARE = Math.min(0.95, Math.max(0.1,
  Number(process.env.DESK_OPPORTUNISTIC_SHARE || 0.55)));

/** Lanes that yield to the reserve. Everything else spends to the full cap. */
/* THE TREND LANE YIELDS TOO. It was never added here when it was wired up, so while
 * fresh and promote stood aside at their share it spent to the full cap: 32 TrendScan
 * calls, $3.47, in the live 24h — 9% of the day — and 122 calls / $13.65 over 7d, every
 * pass of it abandoned as researchless because both breakers were open. It is a
 * scanning lane exactly like the other two and has no more claim on the cycle's
 * reserve than they do. The workup reads this through desk.js; the scan itself reads
 * it in trends.js, before Grok is paid. */
const OPPORTUNISTIC = new Set(["fresh", "promote", "trend"]);

/**
 * THE PACE — what actually makes a desk run around the clock.
 *
 * A daily cap alone does not produce a 24/7 desk, it produces a desk that works until
 * lunchtime. Left to itself the machine spends as fast as it can find candidates, so a
 * $40 day is gone in a few hours and the next eighteen are silent — which is precisely
 * what happened on the 30th: 163 workups, $22 by mid-afternoon, then nothing.
 *
 * So spending is paced by the HOUR as well as the day. The hourly allowance is the
 * daily cap divided across 24 hours and multiplied by a burst factor, so the desk can
 * still work a cluster of candidates when it finds one, but cannot eat tomorrow
 * morning's budget tonight. Running out of pace is not an error: the cycle ends
 * gracefully, the monitor keeps watching every open position for free, and the next
 * tick picks up where this one stopped.
 *
 * A tenant's paid floor run is exempt. They bought that work and it is not ours to
 * schedule.
 */
export const HOURLY_BURST = Math.max(1, Number(process.env.DESK_HOURLY_BURST || 3));

/** Throws before any tokens are spent if this lane's share of the last 24h is gone. */
export function assertDailyBudget(capUsd, { lane = "cycle" } = {}) {
  if (!capUsd || capUsd <= 0) return;
  const totalSpent = spendSince(spendNow() - 24 * 3600e3).usd;
  const spent = spendSince(spendNow() - 24 * 3600e3,
    { evidenceScope: "house", includeUnattributed: true }).usd;
  const yields = OPPORTUNISTIC.has(lane);
  if (totalSpent >= capUsd) {
    throw new BudgetExhausted(
      `daily provider budget spent: $${totalSpent.toFixed(2)} of $${capUsd} in 24h`);
  }

  // Pace first: it is the brake that keeps the desk alive at 3am, and it binds long
  // before the daily cap does. The tenant's own paid run never waits on it.
  if (lane !== "floor") {
    /* THE FLOOR UNDER THE PACE. A pace tighter than one cycle's own allowance is not
     * a pace, it is a deadlock: the cycle is cut off mid-hunt every single time and
     * can never reach its publish step. That is exactly what shipped — $5/hour
     * against a $10 cycle — and the desk went an hour without completing anything
     * while looking, from outside, like a quiet market.
     *
     * Read from the same env var penthouse.js reads rather than imported from it;
     * llm.js is below penthouse in the graph and must not reach back up. The DEFAULT
     * is now shared through config.js (which is below both), because these two reads
     * had drifted apart: llm.js said 4 while penthouse.js enforced 8, so the floor
     * protected a cycle half the size of the one that ran. Same env var, one default. */
    const cycleBudget = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || CYCLE_BUDGET_DEFAULT_USD);
    const hourCap = Math.max((capUsd / 24) * HOURLY_BURST, cycleBudget * 1.25);
    const spentHour = spendSince(spendNow() - 3600e3,
      { evidenceScope: "house", includeUnattributed: true }).usd;
    if (spentHour >= hourCap) {
      emit("cycle:paced", { lane, spentHourUsd: spentHour, hourCapUsd: Number(hourCap.toFixed(2)),
        dayUsd: spent, capUsd });
      throw new BudgetExhausted(
        `hourly pace reached: $${spentHour.toFixed(2)} of $${hourCap.toFixed(2)} this hour ` +
        `— the desk paces $${capUsd} across the day so it is still working tonight; monitoring continues`);
    }
  }

  // Paid floor work skips pacing and the house reserve, but it cannot spend past the
  // provider-account hard ceiling. The caller's existing failure path handles refunding
  // a run that dies before a model is asked.
  if (lane === "floor") {
    return;
  }

  const laneCap = yields ? capUsd * OPPORTUNISTIC_SHARE : capUsd;
  if (spent >= laneCap) {
    emit("cycle:budget", { usedUsd: spent, capUsd, laneCap: Number(laneCap.toFixed(2)),
      lane, reserved: yields, window: "24h" });
    throw new BudgetExhausted(yields
      ? `the ${lane} lane has spent its share ($${spent.toFixed(2)} of $${laneCap.toFixed(2)}) — ` +
        `the rest of the $${capUsd} day is reserved for the cycle that publishes`
      : `daily budget spent: $${spent.toFixed(2)} of $${capUsd} in 24h — the desk pauses, monitoring continues`);
  }
}

const client = new Anthropic();

// Anthropic list price, USD per 1M tokens. Used only for the desk's own
// running cost meter — it is not billing.
const PRICE = {
  "claude-opus-5":   { in: 5.0,  out: 25.0 },
  "claude-fable-5":  { in: 10.0, out: 50.0 },
  "claude-sonnet-5": { in: 2.0,  out: 10.0 },
  "claude-haiku-4-5":{ in: 1.0,  out: 5.0  },
};

// Reservations use deliberately conservative rates, not the selected model's best
// case. This covers server-side fallback, cache-write premiums, and concurrent seats.
const PROVIDER_RESERVATION_PRICE = {
  // $20/MTok covers the most expensive configured model's 1-hour cache-write
  // rate. This checkout only requests 5-minute cache entries, but reservations
  // are a ceiling, not an estimate.
  anthropic: { in: 20, out: 50, search: 0.01, inputOverhead: 4096,
    serverToolContextTokens: 1_000_000, perSearchContextTokens: 40_000 },
  // Grok 4.6 doubles token rates above its long-context threshold.
  xai: { in: 4, out: 12, search: 0.005, inputOverhead: 2048,
    serverToolContextTokens: 500_000, perSearchContextTokens: 40_000 },
};
let reservedProviderUsd = 0;
let unpersistedProviderUsd = 0;

const rawProviderSpendUsd = (sinceMs) => Number(db.prepare(
  "SELECT COALESCE(SUM(usd),0) usd FROM llm_spend WHERE ts>=?").get(sinceMs)?.usd || 0) +
  unpersistedProviderUsd;

export function noteUnpersistedProviderSpend(usd) {
  unpersistedProviderUsd += Math.max(0, Number(usd) || 0);
}

/** Reserve a worst-case model call before it starts. The synchronous check/increment
 * makes parallel analyst launches atomic within the process, so five calls cannot all
 * observe the same last dollar and overshoot it together. */
export function reserveProviderBudget({ provider = "anthropic", maxTokens = 16000,
  maxSearches = 0, payload = "", capUsd = cfg.dailyBudgetUsd } = {}) {
  if (!(capUsd > 0)) return { usd: 0, release() {} };
  const price = PROVIDER_RESERVATION_PRICE[provider];
  if (!price) throw new Error(`unknown provider budget: ${provider}`);
  let serialized;
  try { serialized = typeof payload === "string" ? payload : JSON.stringify(payload); }
  catch { serialized = String(payload); }
  // One token can never contain less than one source byte, so bytes are a safe upper
  // bound on input tokens; fixed overhead covers request/tool framing not in payload.
  const requestInputCeiling = Buffer.byteLength(serialized || "", "utf8") + price.inputOverhead;
  /* Server-side search results are injected after the request leaves this process, so
   * payload bytes cannot reserve them. This used to reserve a COMPLETE model context —
   * a million tokens, $20.00 — for any call that enabled a tool, whatever it had asked
   * the tool to do. Measured: the narrative seat reserved $20.82 against a real cost of
   * $0.18, a hundred-fold, and on a $200 day a handful of concurrent seats could
   * exhaust the reservation pool and start refusing work the desk had the money for.
   * Those refusals surfaced as "fewer than three analysts returned" — a billing failure
   * wearing a research verdict, 2,532 times in seven days.
   *
   * A ceiling should be generous, not arbitrary. Each search a call is ALLOWED to make
   * can inject a bounded amount of context, so the reservation scales with the number
   * requested and is still capped by the full-context figure for anything unbounded. */
  const toolContextCeiling = maxSearches > 0
    ? Math.min(price.serverToolContextTokens,
      Math.max(price.perSearchContextTokens, maxSearches * price.perSearchContextTokens))
    : 0;
  const inputTokenCeiling = Math.max(requestInputCeiling, toolContextCeiling);
  const outputTokenCeiling = Math.max(1, Math.min(100_000, Number(maxTokens) || 16000));
  const searchCeiling = Math.max(0, Math.min(10_000, Number(maxSearches) || 0));
  const usd = inputTokenCeiling / 1e6 * price.in +
    outputTokenCeiling / 1e6 * price.out + searchCeiling * price.search;
  const spent = rawProviderSpendUsd(spendNow() - 24 * 3600e3);
  if (spent + reservedProviderUsd + usd > capUsd) {
    throw new BudgetExhausted(
      `metered provider ceiling: $${spent.toFixed(2)} spent + $${reservedProviderUsd.toFixed(2)} reserved; ` +
      `next call needs up to $${usd.toFixed(2)} of the $${capUsd.toFixed(2)} limit`);
  }
  reservedProviderUsd += usd;
  let released = false;
  return { usd, release() {
    if (released) return;
    released = true;
    reservedProviderUsd = Math.max(0, reservedProviderUsd - usd);
  } };
}

export async function withProviderBudget(options, fn) {
  const reservation = reserveProviderBudget(options);
  try { return await fn(); }
  finally { reservation.release(); }
}

export const spend = { usd: 0, calls: 0, inTok: 0, outTok: 0, cachedTok: 0 };

/** Cost one completed Anthropic response from provider-reported usage. Cache fields
 * are separate from input_tokens. Cache writes are charged at the maximum supported
 * 2x duration and reads at their documented 0.1x rate, so a future duration change
 * cannot make the local hard brake optimistic. */
export function anthropicUsageCost(requestedModel, message) {
  const model = message?.model || requestedModel;
  const p = PRICE[model] || { in: 10, out: 50 };
  const usage = message?.usage || {};
  const uncached = Math.max(0, Number(usage.input_tokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const searches = Math.max(0, Number(usage.server_tool_use?.web_search_requests) || 0);
  const usd = uncached / 1e6 * p.in + cacheWrite / 1e6 * p.in * 2 +
    cacheRead / 1e6 * p.in * 0.1 + output / 1e6 * p.out + searches * 0.01;
  return { model, uncached, cacheWrite, cacheRead, output, searches, usd };
}

export function meterAnthropicUsage(requestedModel, message, seat, effort) {
  const cost = anthropicUsageCost(requestedModel, message);
  const { model, uncached, cacheWrite, cacheRead, output, usd } = cost;
  const totalInput = uncached + cacheWrite + cacheRead;
  spend.usd += usd;
  spend.calls += 1;
  spend.inTok += totalInput;
  spend.outTok += output;
  spend.cachedTok += cacheRead;
  const context = runContext.getStore();
  const floor = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ??
    (floor == null || Number(floor) === 50 ? "house" : "tenant");
  try {
    db.prepare("INSERT INTO llm_spend (floor,floor_attributed,evidence_scope,seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,1,?,?,?,?,?,?,?,?,?)")
      .run(floor, evidenceScope, seat ?? null, model, effort ?? null,
        totalInput, output, cacheRead, usd, spendNow());
  } catch { noteUnpersistedProviderSpend(usd); } // preserve the brake even if the ledger is unavailable
  return cost;
}

/** What the desk has actually spent, from the database rather than a live process. */
export function spendSince(sinceMs, { evidenceScope, includeUnattributed = false } = {}) {
  const scoped = evidenceScope == null ? ""
    : includeUnattributed
      ? " AND ((floor_attributed=1 AND evidence_scope=?) OR floor_attributed=0)"
      : " AND floor_attributed=1 AND evidence_scope=?";
  const row = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(usd),0) usd,
    COALESCE(SUM(in_tok),0) inTok, COALESCE(SUM(out_tok),0) outTok
    FROM llm_spend WHERE ts >= ?${scoped}`)
    .get(...(evidenceScope == null ? [sinceMs ?? 0] : [sinceMs ?? 0, evidenceScope]));
  return { ...row, usd: Number(row.usd.toFixed(4)) };
}

export const SHARED_RULES = `
You are a specialist on an automated Solana research desk called Claude Company ("Claude Co").
You hold exactly one seat. Do that seat's job and no other seat's job.

${CHARTER}

Operating rules for your reply:
- You are given an EVIDENCE bundle fetched deterministically by code. Treat it as the
  only source of numeric fact. Do not state any number that is not derivable from it.
- If a datum you need is missing or null, say so, lower your confidence, and proceed.
  Never substitute a plausible-looking figure for a missing one.
- Each finding needs a source: an evidence key path (e.g. "pair.liquidityUsd"),
  a URL you actually read, or the literal string "inference" when it is your judgment.
- Be concrete and terse. A number with a source beats a paragraph of adjectives.
- You are producing research for a human who will decide. You never execute anything.

${UNTRUSTED_BRIEF}

THIS DESK TRADES PUMP.FUN, AND IT TRADES A CLOCK.
Every coin sits in one of six market-cap bands, and the bundle states which in
\`band\`, with \`hold.holdMaxMs\` alongside it. That window is not advice: the position
is SOLD when it expires, whether or not the target printed. So a thesis has to be able
to happen inside it.

  nano  $5k-$20k    sold in 30 minutes      micro  $20k-$60k   sold within the hour
  low   $60k-$100k  sold within five hours  medium $100k-$500k sold within five hours
  high  $500k-$1m   sold within five hours  very high $1m-$10m sold within a day

Two consequences you are expected to reason with rather than around:
- "It needs a few days to play out" is a REFUSAL on a nano coin, not a caveat. Judge
  whether the move can happen in the window the coin actually has.
- On nano and micro the coin is minutes old by design. Youth is the ordinary condition
  here, not a reason to abstain. Say "the data is absent" when it is; do not say "too
  new to tell" about the population this desk exists to trade.
A thesis has to be worth acting on inside the window the coin has. Judge that by the
move you expect, not by what trading it would cost: what a round trip costs, what the
fees are and how much is bought are not this desk's questions and must not enter your
reasoning. The program that holds the wallet measures those against the size it is
actually about to send, immediately before it signs.
`.trim();

export class Refusal extends Error {}

/**
 * THE USER TURN, IN CACHE ORDER — and the whole of the prefix fix.
 *
 * Measured live over 24h: the PM read ~377k input tokens and had 32,039 of them served
 * from cache (4.5%); Risk 4.4%; Red Team 6.8%; Narrative 0. The cache is a byte-prefix
 * match, and the seat's brief used to sit in `system` BETWEEN SHARED_RULES and the
 * evidence bundle — so the 8-24k-token bundle that eight seats read within seconds of
 * each other differed, byte for byte, in front of every one of them and could never be
 * a hit. Now everything that varies by seat comes AFTER the last breakpoint:
 *
 *   system      SHARED_RULES                                (breakpoint)
 *   content[0]  the shared block — the evidence bundle       (breakpoint)
 *   content[1]  the seat's brief + its standing orders + the task + book/red team/risk
 *
 * Caches are model-scoped, and an `output_config.effort` difference splits the messages
 * cache as well, so the bundle is shared per model AND effort: Forensics, Flow and Risk
 * on Sonnet/high, Red Team and the PM on Opus/high; Liquidity sits alone on Haiku 4.5
 * since Technical retired (2026-09-08). Reads bill at 0.1x and 5-minute writes at 1.25x,
 * so a second seat on the same entry is already ahead. Haiku 4.5's minimum cacheable
 * prefix is 4,096 tokens — SHARED_RULES alone is under that, so a Haiku seat only hits
 * once the bundle block is in the prefix. The standing orders stay AFTER the last
 * breakpoint deliberately:
 * guidance changes far more often than a charter, and a cached copy would mean a seat
 * working under orders that were reverted an hour ago.
 *
 * THE SEAT'S STANDING ORDERS. Its charter is the constant its module ships; the orders
 * below it are written by the coach from the desk's own graded results, between
 * workups. Injected here, once, so every seat in the building learns the same way —
 * and so a new seat cannot be added that quietly opts out of the feedback loop.
 */
function seatTurn({ seat, system, shared, prompt }) {
  const brief = system ? withPolicy(seat, system) : "";
  const tail = brief ? `${brief}\n\n${prompt}` : prompt;
  return [
    ...(shared ? [{ type: "text", text: shared, cache_control: { type: "ephemeral" } }] : []),
    { type: "text", text: tail },
  ];
}

/**
 * One structured call to a seat. Returns the parsed object, validated against `schema`.
 * Throws after retries rather than returning a half-parsed shape — a seat that cannot
 * answer in contract is a seat that gets dropped, not one that gets guessed at.
 *
 * `shared` is the block every seat on the same model reads byte-for-byte — the evidence
 * bundle — and it is placed ahead of the brief so it can be a cache hit (seatTurn()).
 * `prompt` is the part that is this seat's alone.
 */
export async function ask({
  seat,
  model,
  effort = "high",
  schema,
  prompt,
  system,
  shared,
  maxTokens,
  attempts = 3,
}) {
  /* A request without a model is a guaranteed 400 that costs a round trip and a retry
     budget and reads as a provider failure. Refuse it here, where the caller is named. */
  if (!model) throw new Error(`ask(): model is required (seat ${seat ?? "?"})`);
  // Thinking counts against max_tokens, so the deeper the effort the more headroom the
  // visible answer needs. 8000 flat starved the xhigh seats of any room to reply.
  maxTokens ??= effort === "max" ? 32000 : effort === "xhigh" ? 24000 : 16000;
  /* THE BREAKER, before a single byte of request is built. This is the whole saving:
     with the account dry, the fifteen seats of an in-flight workup used to each pay a
     round trip to be refused (1,254 an hour after the halt fix). Here they cost one
     map lookup. Placed above the retry loop so no seat:thinking is emitted and no
     budget is reserved for a call that is not going to happen. */
  const gate = acquireCredit("anthropic");
  if (!gate.allowed) throw new OutOfCredit(gate.message);
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      emit("seat:thinking", { seat, model, effort, attempt: a });
      // Streaming, not parse(): the SDK refuses a non-streaming call at these token
      // budgets because it could exceed the HTTP timeout. finalMessage() gives the same
      // assembled response, and the schema check below is the authority on shape anyway.
      // The retier taught this the hard way, in production: `fallbacks` is an
      // Opus 5 / Fable 5 parameter — Sonnet rejects it with a 400 — and
      // `output_config.effort` errors on Haiku 4.5. Every capability gate here
      // exists because a live cycle hit the 400 for its absence.
      const opusTier = /opus-5|fable-5/.test(model);
      const haiku = /haiku/.test(model);
      const req = {
        model,
        max_tokens: maxTokens,
        /* SHARED_RULES ALONE, so the cached prefix is byte-identical for every seat on
           a model. The seat's brief used to sit here too, between SHARED_RULES and the
           evidence — and it is what made the bundle unhittable: see seatTurn(). */
        system: [{ type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: seatTurn({ seat, system, shared, prompt }) }],
        output_config: haiku
          ? { format: betaZodOutputFormat(schema) }
          : { format: betaZodOutputFormat(schema), effort },
      };
      if (opusTier) {
        // Server-side fallback: if a safety classifier declines, the request is
        // routed to a comparable model instead of failing the whole cycle.
        req.betas = ["server-side-fallback-2026-07-01"];
        req.fallbacks = "default";
      }
      const res = await withProviderBudget({ provider: "anthropic", maxTokens, payload: req }, async () => {
        /* maxRetries:0 — ONE OWNER FOR THE RETRY POLICY. The SDK retries 429/5xx
           internally, and this loop retries them too, so the two multiplied:
           ask({attempts:3}) against a 529 measured NINE network requests. The loop
           keeps the job because it is the one that emits seat:retry and backs off
           where the chronicle can see it. */
        const stream = client.beta.messages.stream(req, { maxRetries: 0 });
        const message = await stream.finalMessage();
        meterAnthropicUsage(model, message, seat, effort);
        /* THE BILLING FACT, REPORTED WHERE THE BILLING FACT IS KNOWN.
           A response that arrives and is metered is proof the provider served us and
           charged us — whatever the response then turns out to SAY. Reporting success
           only after validation meant a truncated or off-contract answer took the
           gate.failure() path below, so the one call that PROVED the account was
           funded re-opened the breaker: measured 1 request, "response did not match
           contract", and a real $0.0055 of metered spend, with the desk concluding it
           was broke. Validation failures are ordinary errors that never touch the
           breaker again. */
        gate.success();
        return message;
      });

      if (res.stop_reason === "max_tokens") {
        throw new Error(`${seat}: ran out of tokens before answering (effort ${effort}, cap ${maxTokens})`);
      }
      if (res.stop_reason === "refusal") {
        throw new Refusal(`${seat}: refused (${res.stop_details?.category ?? "unknown"})`);
      }
      // The SDK's auto-parse leaves parsed_output null on this version even when the
      // model returned perfectly valid JSON, so fall back to validating the text block
      // against the same schema. Zod is the authority either way — a seat that cannot
      // answer in contract is dropped, never guessed at.
      let parsed = res.parsed_output ?? res.parsed ?? null;
      if (!parsed) {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!text) throw new Error(`${seat}: empty response`);
        const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        let raw;
        try { raw = JSON.parse(json); }
        catch { throw new Error(`${seat}: response was not JSON`); }
        const check = schema.safeParse(raw);
        if (!check.success) {
          throw new Error(`${seat}: response did not match contract — ${check.error.issues.slice(0, 2).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
        }
        parsed = check.data;
      }

      emit("seat:done", { seat, usd: spend.usd });
      // The breaker was already told, at the meter — see above.
      return parsed;
    } catch (err) {
      lastErr = err;
      /* A safety refusal is a BILLED, completed call — the model ran and declined, and
         the meter above has already closed the breaker on that bill. It is not a seat
         failure to retry, so it leaves immediately and untouched. */
      if (err instanceof Refusal) throw err;
      if (/credit balance is too low/i.test(String(err?.message))) {
        gate.refused(String(err?.message));
        emit("desk:out_of_credit", { seat });
        throw new OutOfCredit("the Anthropic balance is empty — the desk cannot think");
      }
      const retryable =
        err?.status === 429 || err?.status >= 500 || err?.name === "APIConnectionError";
      emit("seat:retry", { seat, attempt: a, error: String(err?.message || err) });
      if (a === attempts || (!retryable && !/parse/.test(String(err?.message)))) break;
      await new Promise((r) => setTimeout(r, 800 * a * a));
    }
  }
  /* Not a credit failure — a timeout, a 500, a contract mismatch. It cannot open a
     closed breaker; it only releases a probe this call was holding, and the error
     itself travels on completely unchanged. */
  gate.failure(lastErr);
  emit("seat:failed", { seat, error: String(lastErr?.message || lastErr) });
  throw lastErr;
}

/**
 * Two-step for the narrative seat: server-side web search cannot be combined with a
 * structured output format, so we search in one call and shape the result in a second.
 */
/* CAN THE SEARCH CALL SHAPE ITS OWN ANSWER?
 *
 * askWithWeb used to ALWAYS spend a second billed request: one to search, then a whole
 * separate ask() at effort low whose only job was to pour the notes into the schema —
 * re-sending SHARED_RULES and the entire evidence bundle to do it. That is why the
 * Narrative seat shows 732 spend rows for 366 runs, roughly 7.7% of every provider call
 * on the desk, for a step that produces no new information.
 *
 * The current structured-output contract lists CITATIONS and message PREFILLING as
 * incompatible with a format; tool use is not on that list. "Not listed as incompatible"
 * is weaker than "documented as supported", and this desk cannot probe it without a
 * funded account — so the code probes it ITSELF, once, in production, and adapts:
 *
 *   - the search request asks for the format;
 *   - if the provider rejects the COMBINATION with a 400, this latch drops for the life
 *     of the process, the request is rebuilt without it, and the old two-call path runs
 *     exactly as before. Nothing breaks and nothing is lost but one refused request;
 *   - if the answer comes back already in contract, the shaping call is skipped.
 *
 * A 400 here is our request being malformed, not the provider failing, so it must NOT be
 * reported to the credit breaker — that would open the breaker on our own bug. */
let WEB_STRUCTURED = true;
export const webStructuredEnabled = () => WEB_STRUCTURED;
export function resetWebStructured() { WEB_STRUCTURED = true; }
const FORMAT_REJECTED = /output_config|output format|structured output|format.*not (?:supported|allowed)|incompatible/i;

/** The same extraction ask() performs: SDK parse first, then the text block against Zod. */
function parsedFrom(res, schema) {
  if (!res || !schema) return null;
  const direct = res.parsed_output ?? res.parsed ?? null;
  if (direct) {
    const c = schema.safeParse(direct);
    return c.success ? c.data : null;
  }
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return null;
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let raw;
  try { raw = JSON.parse(json); } catch { return null; }
  const check = schema.safeParse(raw);
  return check.success ? check.data : null;
}

export async function askWithWeb({ seat, model, effort, schema, prompt, system, shared, maxTokens = 16000 }) {
  /* The second Anthropic entry point, and it needs the breaker as much as ask() does:
     the narrative seat runs on every workup, so with the account dry it was a full
     third of the refusals. Guarded before seat:searching so a breaker-refused call
     does not narrate itself into the chronicle either. */
  const gate = acquireCredit("anthropic");
  if (!gate.allowed) throw new OutOfCredit(gate.message);
  emit("seat:searching", { seat, model });

  // Server-tool errors do NOT throw: they arrive as a result block whose content is an
  // error object instead of a list. Unchecked, a rate-limited search reads to the agent
  // as "no coverage exists" — which is exactly the absence-of-evidence mistake the
  // charter forbids. Retry, then say plainly that the tool failed.
  let research = null, searchError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const req = {
      model,
      max_tokens: maxTokens,
      /* Array form with the breakpoint, exactly as ask() builds it. A plain string
         here carried no cache_control at all, which is why the Narrative seat ran
         at cached=0 in the measured 24h: 20 calls, $3.79, $0.19 each. Tools render
         ahead of `system`, so this request keys its own entry rather than sharing the
         analysts' — but the tool-error retry below re-sends identical bytes and
         reads it back, and the shaping call in ask() carries the same bundle block
         under its own effort. */
      system: [{ type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } }],
      // max_uses 4 fed ~41k tokens of raw results back through the loop per run;
      // two searches answer "is there a story and is it true" or nothing will.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      /* The format rides along unless this process has already learned it cannot. */
      output_config: WEB_STRUCTURED && schema
        ? { effort, format: betaZodOutputFormat(schema) }
        : { effort },
      messages: [{ role: "user", content: seatTurn({ seat, system, shared, prompt }) }],
    };
    /* This call had NO credit handler at all: a dry account threw the provider's raw
       "credit balance is too low" error out of askWithWeb, where desk.js filed it beside
       a timeout as an ordinary seat failure — the same disguise the halt fix removed
       from ask(). Classify it here, on the identical test ask() uses, so the breaker
       learns from this seat too and the cycle halts on it. Every other error is
       rethrown byte-for-byte, exactly as before. */
    try {
      research = await withProviderBudget({ provider: "anthropic", maxTokens,
        maxSearches: 2, payload: req }, async () => {
        /* No maxRetries override here, deliberately: unlike ask(), this call has no
           retry loop of its own — the loop it sits in retries web_search TOOL errors
           only — so the SDK is already the single owner of its retry policy. */
        const message = await client.messages.create(req);
        meterAnthropicUsage(model, message, seat, effort);
        // Metering is the proof the account is live: report it here, beside the bill,
        // never after a downstream check that could fail for its own reasons.
        gate.success();
        return message;
      });
    } catch (err) {
      if (/credit balance is too low/i.test(String(err?.message))) {
        gate.refused(String(err?.message));
        emit("desk:out_of_credit", { seat });
        throw new OutOfCredit("the Anthropic balance is empty — the desk cannot think");
      }
      /* The one-call probe failing is not a provider failure and not a seat failure: it
         is this request asking for something the combination does not allow. Drop the
         latch, leave the breaker alone, and go round again on the old two-call path. */
      if (WEB_STRUCTURED && schema && FORMAT_REJECTED.test(String(err?.message))) {
        WEB_STRUCTURED = false;
        emit("seat:retry", { seat, attempt,
          error: "structured output is not available alongside web search on this account " +
            "— falling back to the two-call path for the rest of this process" });
        continue;
      }
      gate.failure(err);
      throw err;
    }

    const errs = research.content
      .filter((b) => b.type === "web_search_tool_result" && !Array.isArray(b.content))
      .map((b) => b.content?.error_code || "unknown");
    if (!errs.length) { searchError = null; break; }
    searchError = errs[0];
    emit("seat:retry", { seat, attempt, error: `web_search: ${searchError}` });
    if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt));
  }

  const notes = research.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cited = [];
  for (const block of research.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) cited.push(`${r.title ?? ""} — ${r.url}`);
    }
  }

  /* THE SAVED CALL. If the search request already answered in contract, the shaping
     request buys nothing — and it is the whole of the Narrative seat's second bill.
     A tool failure still goes the long way round: the fallback prompt below is the only
     place that tells the seat it read NOTHING and must carry that at zero weight, and
     losing that instruction would turn a failed search into silent absence-of-evidence. */
  if (!searchError) {
    const direct = parsedFrom(research, schema);
    if (direct) {
      emit("seat:done", { seat, usd: spend.usd });
      return direct;
    }
  }

  return ask({
    seat,
    model,
    effort: "low", // shaping already-gathered notes is mechanical
    schema,
    system,
    shared,
    maxTokens,
    prompt:
      `Convert your own research notes into the required contract. Use ONLY what the notes support.\n\n` +
      (searchError
        ? `=== TOOL FAILURE ===\nThe web search tool failed with "${searchError}" on every attempt. You have read NOTHING external. ` +
          `Report this as missing data and carry it at zero weight in both directions — you have established neither the presence nor the absence of coverage.\n\n`
        : "") +
      `=== YOUR RESEARCH NOTES ===\n${notes}\n\n` +
      `=== SOURCES YOU ACTUALLY READ ===\n${cited.join("\n") || "(none returned)"}\n\n` +
      `=== ORIGINAL BRIEF ===\n${prompt}`,
  });
}
