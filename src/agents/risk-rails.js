import { cfg } from "../config.js";

const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* `retainedBookRiskUsd()` WAS HERE, and it is deleted with the only clamp it fed
 * (owner, 2026-09-07 — the desk says WHAT and WHEN, never how much or on what balance).
 *
 * It totalled the desk's PAPER risk across live calls so `enforceRiskRails` could refuse
 * a new idea once that paper book was "full". Reproduced on 2026-09-07: four live calls
 * with no recorded desk_risk_usd reserved $100 each against a $400 book ceiling, so
 * `remainingBookRisk` hit 0, `position_size_usd` was set to 0, and a clean coin then
 * died at the `zero_authorized_size` publication gate — classified SAFETY, so no
 * escalation level could reach past it. The desk was refusing to SAY a name because of
 * money it does not hold, on a book nobody trades, while its own limit was 24 open calls.
 *
 * The same judgment exists where the money is real, on the operator's own machine:
 *   executor/strategy.mjs:308-311  book heat, the rolling 24h deploy cap, spendable
 *                                  balance and the per-name risk cap — all measured
 *                                  against the wallet that is about to sign.
 * A second copy here could only ever disagree with that one, and did. */

/**
 * Convert the Risk seat's judgement into deterministic arithmetic.
 *
 * The model chooses the thesis invalidation and may recommend being smaller. Code
 * decides whether zero is mechanically required and derives loss-at-stop, so a prose
 * mistake cannot manufacture an empty book or an oversized one.
 *
 * WHAT `position_size_usd` IS, SINCE 2026-09-07. It is the desk's PAPER RECORD: what
 * this seat thought the idea was worth on the desk's own stated equity, kept because
 * the evaluation pass grades against it and because two consistency checks in
 * compliance.js recompute it. It is NOT an instruction. It does not reach a wallet:
 * copy.js publishes no size, executor/strategy.mjs:247 refuses to read `call.size_sol`
 * and executor/poller.mjs:1192 refuses `ev.fixed_sol`, both at length and on purpose.
 * The bot sizes from its own FIXED_SOL, MAX_SOL_PER_TRADE and rails
 * (executor/strategy.mjs:243-311), on the operator's own machine.
 *
 * So nothing in this file may be written as though it bounded a real order. The one
 * rail that pretended to — a ceiling at the exit probe's notional — is gone, and the
 * note at its old site says where the same judgment is enforced for real.
 */
export function enforceRiskRails({ risk, ev, redteam, config = cfg }) {
  const out = { ...(risk || {}) };
  const notes = [];
  const px = finite(ev?.pair?.priceUsd);
  const stop = finite(out.stop_price);
  // Read ONLY to answer "did the probe complete?" below. Its VALUE is never priced here.
  const rt = finite(ev?.exitProbe?.roundTripLossPct);
  const maxRisk = config.equityUsd * (config.maxRiskPct / 100);

  const authorityLive = Boolean(
    ev?.mintAccount?.mintAuthority || ev?.mintAccount?.freezeAuthority ||
    (ev?.mintAccount?.flags || []).some((f) =>
      /mint_authority_live|freeze_authority_live|permanent_delegate|transfer_hook/i.test(String(f)))
  );
  /* THE ROUTE HALF OF THE OLD TEST, AND ONLY THE ROUTE HALF.
   *
   * This read `rt == null || rt > config.maxRoundTripSlippagePct || exitProbe.error`.
   * The middle clause was the same round-trip COST ceiling that screen() enforced as
   * `cannot_exit`, and leaving it here would have made that deletion cosmetic: a coin
   * over 8% would have passed the screen, had a full workup paid for, been sized to
   * zero here, and then died at the `zero_authorized_size` gate — killed by the same
   * judgment one file later and with the reason string pointing at the wrong place.
   *
   * What survives is the question the desk can actually answer: DID THE PROBE COMPLETE?
   * A probe that errored or returned nothing means nobody has shown this token can be
   * sold, which is the honeypot question and a fact about the coin. It matches
   * `unverified_exit` on the free screen deliberately.
   *
   * The cost ceiling now lives where the size is real: executor/jupiter.mjs:1341-1350
   * throws when the round trip measured at the BOT's own amountRaw exceeds
   * maxEntryRoundTripLossPct, and executor/poller.mjs:1234-1253 refuses the entry when
   * that measured loss plus worst-case fees no longer clears the authored stop. The
   * desk's version was quoting $75 for a bot that trades $2. */
  const exitUnproven = rt == null || Boolean(ev?.exitProbe?.error);

  if (exitUnproven || authorityLive) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    out.liquidity_adjusted = true;
    notes.push(exitUnproven
      ? "mechanical zero: the exit probe never completed, so nobody has shown this can be sold"
      : "mechanical zero: live token authority");
    return finish(out, notes);
  }

  if (!(px > 0) || !(stop > 0) || stop >= px) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push("mechanical zero: no valid stop below the current price");
    return finish(out, notes);
  }

  /* LOSS AT STOP IS PRICED OFF THE STOP ALONE.
   *
   * This read `stopFrac + rtCost / 100` — the measured round trip folded into the paper
   * loss because "a stop is not filled at a frictionless midpoint". True, and not this
   * desk's arithmetic to do: the round trip was quoted at a notional the desk invented
   * ($75, against a real clip near $2), so the friction it added was wrong by a multiple
   * in an unpredictable direction. The bot prices the real friction on the real order —
   * executor/poller.mjs:1234-1253 checks the measured loss plus worst-case fees against
   * the authored stop before it signs. What is left here is the desk's own WHAT: the
   * distance from the entry to the level where the thesis is wrong. */
  const lossFrac = (px - stop) / px;
  const redMultiplier = redteam?.verdict === "refuted" ? 0.25
    : redteam?.verdict === "wounded" ? 0.5 : 1;
  const tierMultiplier = ({ minimal: 0.10, quarter: 0.25, half: 0.50, full: 1 })[out.risk_tier] ?? 0.10;
  const confidenceMultiplier = clamp(finite(out.confidence) ?? 0.5, 0.25, 1);
  /* THE BOOK-HEAT CLAMP WAS HERE, and it is gone with `maxBookRiskPct` itself.
   *
   * `riskBudget = Math.min(..., maxBookRisk - openRiskUsd)` refused a clean coin outright
   * whenever the desk's PAPER book was full: with four live calls the min() hit zero,
   * position_size_usd went to zero, and mandate.eligibility() declined with safety:true
   * (`zero_authorized_size`, classified SAFETY — unreachable by any escalation level).
   * A balance judgment, about money the desk does not hold, silently converted into a
   * refusal to name a coin. See the note at the head of this file for the deleted
   * `retainedBookRiskUsd()` that fed it and for the bot's own book heat, which binds.
   *
   * The `liquidityMultiplier` (0.5 above a 4% round trip, 0.75 above 2%) went with it for
   * the same reason: it is a cost judgment, and its input is a cost measured at a size
   * the desk chose. */
  const riskBudget = maxRisk * tierMultiplier * redMultiplier * confidenceMultiplier;
  if (!(riskBudget > 0)) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push("mechanical zero: the tier, red-team and confidence multipliers leave no paper budget");
    return finish(out, notes);
  }
  let size = riskBudget / lossFrac;

  /* THE EXIT-PROBE SIZE CEILING WAS HERE, and it is gone (owner, 2026-09-07).
   *
   * It clamped position_size_usd to `min(equityUsd, probedNotionalUsd(ev))` — "never
   * larger than what we proved we can exit". A defensible instinct attached to the
   * wrong number twice over: the probe's notional was a size the DESK picked, and the
   * thing being clamped was a paper figure that never reached a wallet anyway. Its only
   * live effect was to make the desk's record disagree with what the bot would do, and
   * to feed a compliance veto (`size_exceeds_exit_probe`) that refused calls on the
   * strength of it. The $75-versus-$2 gap is the whole story.
   *
   * The real ceiling is the bot's, and it binds because it runs on the actual order:
   *   executor/strategy.mjs:305   want = Math.min(want, c.maxSolPerTrade)
   *   executor/strategy.mjs:307   per-name risk cap (fNameMax) sized down, not refused
   *   executor/strategy.mjs:308-311  book heat, rolling 24h deploy cap, spendable balance
   *   executor/jupiter.mjs:148-149   the built order's measured price impact against
   *                                  maxPriceImpactPct — the only test that asks the
   *                                  POOL whether this specific size can actually leave.
   * The equity bound below stays: it is the desk's own book arithmetic, and a paper
   * position larger than the paper book is a record that does not add up. */
  const sizeCeiling = config.equityUsd;
  if (size > sizeCeiling) {
    size = sizeCeiling;
    out.liquidity_adjusted = true;
    notes.push(`size capped to the desk's own $${sizeCeiling} book equity`);
  }
  notes.push(`${out.risk_tier || "minimal"} tier converted to a $${riskBudget.toFixed(2)} loss budget at the authored stop`);

  out.position_size_usd = Number(Math.max(0, size).toFixed(2));
  out.max_loss_usd = Number((out.position_size_usd * lossFrac).toFixed(2));
  out.pct_of_equity_at_risk = Number(((out.max_loss_usd / config.equityUsd) * 100).toFixed(4));
  return finish(out, notes);
}

/** CEO may cut Risk's number, never enlarge it or revive a zero-sized trade. */
export function enforceCeoRails({ ceo, risk }) {
  const out = { ...(ceo || {}) };
  const riskSize = Math.max(0, finite(risk?.position_size_usd) ?? 0);
  const asked = Math.max(0, finite(out.order_size_usd) ?? 0);
  const final = out.ruling === "DECLINE" ? 0 : Math.min(asked, riskSize);
  const emptyApproval = out.ruling === "APPROVE" && !(final > 0);
  if (emptyApproval) out.ruling = "HOLD";
  if (final !== asked) {
    const note = out.ruling === "DECLINE"
      ? "declines carry zero size"
      : `CEO size capped to Risk's $${riskSize} authorization`;
    out.size_change_reason = [out.size_change_reason, note].filter(Boolean).join("; ");
    out.rail_notes = [note];
  } else out.rail_notes = [];
  if (emptyApproval) {
    const note = "an approval with zero authorized size was converted to HOLD";
    out.size_change_reason = [out.size_change_reason, note].filter(Boolean).join("; ");
    out.rail_notes.push(note);
  }
  out.order_size_usd = Number(final.toFixed(2));
  return out;
}

function finish(out, notes) {
  out.rail_notes = notes;
  if (notes.length) {
    const prior = String(out.portfolio_notes || "").trim();
    out.portfolio_notes = [prior, `Deterministic rails: ${notes.join("; ")}.`]
      .filter(Boolean).join(" ");
  }
  return out;
}
