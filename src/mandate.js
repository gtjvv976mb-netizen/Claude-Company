/**
 * THE MANDATE — one cycle, one trade, one at a time.
 *
 * The desk spent its first weeks as an ABSOLUTE GATE: a coin was published only if
 * every seat, up to and including the CEO, actively said yes. Across 177 workups that
 * produced 144 kills and zero calls. A desk that never calls generates no P&L, no
 * record, and — worst of all — no evidence about whether its own judgement is any
 * good. It cannot be graded, so it cannot improve.
 *
 * So the mandate changes the desk from a gate into a RANKER. Of everything the team
 * studied this cycle, publish the single best one, then trade it to completion before
 * looking again. The owner's argument for this is sound and worth writing down: there
 * was never a guarantee of profit on the approvals either, so refusing to act on the
 * team's best systematic read is not caution, it is abstention.
 *
 * But "rank instead of gate" is only safe because of the distinction this file exists
 * to enforce. There are two completely different kinds of "no" in the pipeline:
 *
 *   SAFETY FACTS — a live freeze authority, a round trip that cannot be closed, one
 *     wallet holding half the float, a honeypot, a crosscheck that two independent
 *     sources could not reconcile, an analyst hard-kill. These are not opinions about
 *     expected value. They are statements about whether the position can be EXITED at
 *     all. Overriding one is not "taking more risk" — it is buying something you have
 *     already measured that you cannot sell. No mode, flag, or mandate may override
 *     these. They are checked first and they are absolute.
 *
 *   CONVICTION OPINIONS — the PM wants a trigger first, the CEO would rather hold, the
 *     composite is a 61 and not a 74. These are judgements about whether the edge is
 *     big enough, made under uncertainty, by seats that have never once been graded
 *     against an outcome. THESE are what the mandate is allowed to rank rather than
 *     obey.
 *
 * One line the mandate deliberately does NOT cross: if the PM says AVOID, or the CEO
 * declines outright, the coin is out. The mandate ranks the team's maybes. It does not
 * trade against the team's no — that would not be "following the desk's systematic
 * call", it would be inverting it.
 *
 * And if nothing survives the safety gauntlet, the answer is to keep hunting, and
 * failing that to publish nothing and say so. A forced call into a coin that provably
 * cannot be exited is not a trade, it is a donation.
 */
import { liveCalls } from "./calls.js";

/**
 * How many house calls may be live at once. One means strictly sequential.
 *
 * This was 1 — "one cycle, one trade, run to completion" — which is the right shape
 * for the first trades, because one call and one outcome is a data point you can
 * actually read. It is also, by construction, NOT a desk that runs around the clock:
 * with a single slot the desk idles for as long as a position takes to work.
 *
 * Three, at the owner's request, is what makes it continuous: a slot frees the moment
 * any position closes, and the next cycle refills it. It stays deliberately small
 * because book heat is real — three concurrent memecoin positions on a sub-1-SOL
 * wallet is already most of the risk that wallet should carry, and strategy.mjs caps
 * the executor at four regardless.
 */
export const MAX_LIVE_CALLS = Math.max(1, Number(process.env.PENTHOUSE_MAX_LIVE_CALLS || 6));
/** Set PENTHOUSE_SEQUENTIAL=0 to let cycles run while a position is open. */
export const SEQUENTIAL = process.env.PENTHOUSE_SEQUENTIAL !== "0";

/**
 * Is the book full? While a call is live the desk does not go shopping — that is the
 * whole of "one cycle, one trade". Returns the open call so callers can say WHICH
 * position they are waiting on rather than emitting a bare refusal.
 */
export function bookState() {
  const live = liveCalls();
  return {
    live: live.length,
    full: SEQUENTIAL && live.length >= MAX_LIVE_CALLS,
    holding: live[0] ?? null,
    max: MAX_LIVE_CALLS,
  };
}

const decline = (reason, safety) => ({ eligible: false, reason, safety });

/**
 * May this workup become the cycle's call?
 *
 * `safety: true` means the refusal is a measured fact about the token and is not
 * negotiable. `safety: false` means the desk merely lacks conviction, which the
 * mandate is allowed to rank — but AVOID and DECLINE still end the candidacy, because
 * ranking the team's maybes is not the same as overruling the team.
 */
export function eligibility(rec) {
  if (!rec) return decline("no record", true);

  /* ---- SAFETY. Absolute. Checked before anything else so no later branch can
     ever reach past one of these. ---- */
  if (rec.outcome === "no_data")
    /* gather() fails two very different ways and this reason threw away which:
     * `dexscreener:` is the feed refusing us (rate limit, outage) and is OUR problem;
     * `pricing:` is the coin's own pools disagreeing so badly that no honest price
     * exists, which is a fact about the coin. One is fixed by backing off, the other
     * by walking away, and a single generic string made them indistinguishable while
     * this became the desk's most frequent refusal. */
    return decline(`no data — ${rec.error ?? "the desk cannot read this coin"}`, true);
  if (rec.outcome === "error")
    return decline(`the workup errored: ${rec.error ?? "unknown"}`, true);
  if (rec.outcome === "screened_out")
    return decline(`failed the safety screen: ${(rec.fails ?? []).map((f) => f.code).join(", ") || "screen"}`, true);
  if (rec.outcome === "insufficient_coverage")
    return decline("fewer than three analysts returned — a thin book is not a desk", true);
  if (rec.outcome === "killed")
    return decline(`${rec.killedBy ?? "an analyst"} killed it: ${rec.reason ?? "hard kill"}`, true);
  if (rec.compliance && rec.compliance.pass === false)
    return decline(`compliance veto: ${(rec.compliance.violations ?? []).map((v) => v.code).join(", ") || "violation"}`, true);
  if (rec.finalDecision === "VETOED")
    return decline("vetoed by compliance", true);
  // The red team's job is to catch what the other four talked themselves into, and
  // overriding a refutation is the most efficient way there is to buy a rug. But the
  // PM's charter already carries the correct exception: a refutation "blocks PROPOSE
  // unless you ANSWER the specific refutation". So a refuted thesis the PM proposed
  // anyway is one the PM answered on the record — that path stays open. A refuted
  // thesis the PM did NOT propose is one where the refutation stood, and it is out.
  if (rec.redteam?.verdict === "refuted" && rec.pm?.decision !== "PROPOSE")
    return decline(`the red team refuted the thesis and the PM did not answer it: ${rec.redteam?.headline ?? "refuted"}`, true);

  /* ---- THE TEAM'S EXPLICIT NO. Not a safety fact, but not rankable either. ---- */
  // PASS is reserved by the PM's own charter for "a NAMED flaw in the trade itself,
  // never for generic uncertainty" — so a PASS is a finding, not a shrug.
  if (rec.pm?.decision === "PASS")
    return decline("the PM passed on a named flaw — the mandate ranks the team's maybes, it does not trade against the team's no", false);
  if (rec.finalDecision === "DECLINED")
    return decline("the CEO declined it outright", false);

  /* ---- PUBLISHABILITY. A call that cannot be graded or managed is not a call,
     however much anyone likes the coin. ---- */
  if (!rec.pm?.invalidation)
    return decline("no pre-stated invalidation — the call could never be graded", true);
  const stop = Number(rec.ticket?.stop_price);
  if (!(stop > 0))
    return decline("no usable stop price — unmanageable for anyone copying it", true);
  const price = Number(rec.ev?.pair?.priceUsd);
  if (!(price > 0))
    return decline("no readable entry price", true);
  if (stop >= price)
    return decline(`the stop (${stop}) sits at or above the entry (${price}) — it would fire on arrival`, true);
  const authorizedSize = Number(rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd);
  if (!(authorizedSize > 0))
    return decline("the team authorized zero size — there is no trade to publish", true);
  const m5 = rec.ev?.pair?.priceChange?.m5 ?? 0;
  if (m5 > 20)
    return decline(`spike-shaped entry: +${m5}% in five minutes — copiers would be the exit`, true);

  /* ---- ELIGIBLE. The tier records HOW MUCH the team liked it, which is what the
     ranking below spends. A stronger verdict always outranks a weaker one. ---- */
  const tier =
    rec.finalDecision === "APPROVED" ? 4 :
    rec.finalDecision === "HELD" ? 3 :
    rec.pm?.decision === "PROPOSE" ? 2 :
    rec.pm?.decision === "WATCH" ? 1 : 0;

  const label = ["the PM would hold", "the PM wanted a trigger first", "the PM proposed it",
    "the CEO held it", "the CEO approved it"][tier];
  return { eligible: true, tier, reason: label, safety: false };
}

/**
 * Rank the contenders. Tier dominates by construction: an approval can never lose to a
 * hold on the strength of a conviction number, because the tiers are separated by more
 * than the other terms can span (conviction and the composite are both 0-100).
 */
export function contenderScore(rec) {
  const e = eligibility(rec);
  if (!e.eligible) return -Infinity;
  const conviction = Number(rec.pm?.conviction ?? 0);
  const weighted = Number(rec.weighted ?? 50);
  return e.tier * 100_000 + conviction * 100 + weighted;
}

/** The cycle's single call, or null with the reason every candidate fell over. */
export function pickOne(records) {
  const judged = (records ?? []).map((r) => {
    const rec = r?.rec ?? r;
    const e = eligibility(rec);
    return { ...(r?.rec ? r : { rec }), eligibility: e, score: contenderScore(rec) };
  });
  const eligible = judged.filter((j) => j.eligibility.eligible).sort((a, b) => b.score - a.score);
  return { winner: eligible[0] ?? null, judged, eligible };
}
