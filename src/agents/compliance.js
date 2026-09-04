import { cfg } from "../config.js";

const FORBIDDEN = /\b(private key|seed phrase|secret key|mnemonic|signTransaction|sendTransaction|sendRawTransaction|keypair)\b/i;

/**
 * COMPLIANCE — the final veto, and deliberately not a model. The charter's hard rules
 * are enforced by code so that no amount of persuasive reasoning upstream can talk the
 * desk past them. Every violation here is a veto, not a warning.
 */
export function complianceCheck({ pm, risk, redteam, ticket, ev }) {
  const violations = [];
  const warnings = [];
  const v = (cond, code, detail) => { if (cond) violations.push({ code, detail }); };
  const w = (cond, code, detail) => { if (cond) warnings.push({ code, detail }); };

  const blob = JSON.stringify({ pm, risk, ticket });
  v(FORBIDDEN.test(blob), "execution_language",
    "Output references signing or key material. This desk is proposal-only.");

  // A refutation is answerable — that is what the CEO adjudicates. The violation
  // is proposing over one WITHOUT an answer, not daring to argue with the adversary.
  v(redteam?.verdict === "refuted" && pm?.decision === "PROPOSE"
      && !(pm?.how_red_team_was_answered || "").trim(), "overrode_refutation_unanswered",
    "PM proposed over a refutation without answering the attack.");

  v(risk?.position_size_usd > 0 === false && pm?.decision === "PROPOSE", "zero_size_proposal",
    "PM proposed a trade the risk seat sized at zero.");

  const maxRisk = cfg.equityUsd * (cfg.maxRiskPct / 100);
  v(risk?.max_loss_usd > maxRisk * 1.01, "risk_budget_breach",
    `max_loss_usd=${risk?.max_loss_usd} exceeds desk ceiling ${maxRisk.toFixed(2)}.`);

  v(risk?.position_size_usd > cfg.equityUsd, "size_exceeds_equity",
    `position_size_usd=${risk?.position_size_usd} exceeds book equity ${cfg.equityUsd}.`);

  v(risk?.position_size_usd > cfg.targetSizeUsd * 1.001, "size_exceeds_exit_probe",
    `position_size_usd=${risk?.position_size_usd} exceeds the $${cfg.targetSizeUsd} notional actually exit-probed.`);

  // Never trust three model-authored numbers to agree. Recompute loss from the actual
  // entry, stop, size and measured round-trip friction, then compare both the budget
  // and the claimed figure against that arithmetic.
  const riskPx = Number(ev?.pair?.priceUsd);
  const riskStop = Number(risk?.stop_price);
  const riskSize = Number(risk?.position_size_usd);
  const rtFrac = Math.max(0, Number(ev?.exitProbe?.roundTripLossPct) || 0) / 100;
  if (riskPx > 0 && riskStop > 0 && riskStop < riskPx && riskSize > 0) {
    const computedLoss = riskSize * (((riskPx - riskStop) / riskPx) + rtFrac);
    v(computedLoss > maxRisk * 1.01, "computed_risk_budget_breach",
      `entry/stop/size imply $${computedLoss.toFixed(2)} cost-adjusted loss, above $${maxRisk.toFixed(2)}.`);
    v(Math.abs(computedLoss - Number(risk?.max_loss_usd)) > Math.max(0.02, computedLoss * 0.02),
      "risk_arithmetic_mismatch",
      `reported max loss $${risk?.max_loss_usd} does not match recomputed $${computedLoss.toFixed(2)}.`);
  }

  /* EVERY ticket is audited, not only a proposal's.
   *
   * These checks were gated on `pm.decision === "PROPOSE"` — correct while a ticket
   * only ever existed for a proposal. Under the mandate the execution seat also drafts
   * a contingency ticket for a WATCH, because the cycle may rank that WATCH into being
   * the call and a call needs a stop. Left gated, such a ticket would reach publication
   * with NONE of this validated: not the edge-versus-cost floor, not the stop sitting
   * below the entry zone, not the take-profit legs summing under 100%, not the ticket
   * stop agreeing with the risk seat's. The decision-shaped checks above stay tied to
   * PROPOSE; ticket ARITHMETIC is true or false regardless of the verdict behind it. */
  if (ticket) {
    const px = ev?.pair?.priceUsd;

    // The Hummingbot lesson, from their own honestly-published live run (-1.54%
    // over 334 trades): a target that is not a large multiple of round-trip cost
    // is a machine for paying the market. We MEASURE that cost; use it.
    const rt = ev?.exitProbe?.roundTripLossPct;
    const tp1 = ticket.take_profit?.[0]?.price;
    if (rt != null && rt > 0 && tp1 > 0 && px > 0) {
      const edgePct = ((tp1 - px) / px) * 100;
      v(edgePct < 5 * rt, "edge_below_cost",
        `first target is ${edgePct.toFixed(1)}% away but the measured round trip costs ${rt}% — edge must be >= 5x cost.`);
    }
    v(!(ticket.entry_zone_low > 0) || !(ticket.entry_zone_high >= ticket.entry_zone_low),
      "bad_entry_zone", `entry zone ${ticket.entry_zone_low}-${ticket.entry_zone_high} is not a valid range.`);

    v(ticket.stop_price > 0 && ticket.stop_price >= ticket.entry_zone_low,
      "stop_above_entry", `stop ${ticket.stop_price} is not below entry low ${ticket.entry_zone_low}.`);

    /* A STOP INSIDE THE ROUND-TRIP COST IS A LOSS THE DESK HAS ALREADY BOOKED.
     *
     * The executor plans for a worst case near 9% — its slippage tolerance applied to
     * both legs, a worst-case network fee, and pump.fun's own cut — and refuses to sign
     * anything whose stop sits inside that, because the costs alone would trigger it. It
     * refused four consecutive live calls this way on 2026-09-03 (HeeHaw, TOAD, USWS and
     * a second HeeHaw, stops 5% to 6.5% below entry). The seats are told the floor, but a
     * prompt is a request; this is the check. Publishing a call the desk's own bot can
     * prove is already lost wastes the offer and teaches the tenant nothing. */
    /* THE FLOOR IS THIS COIN'S OWN ARITHMETIC, NOT A FLAT NUMBER.
     *
     * A single figure cannot be right for every coin, because what the round trip costs
     * is a fact about the coin. Measured against the desk's eight most recent published
     * calls, the flat 12% let seven through that the executor then refused — the four
     * with 5% to 8.5% stops were never tradeable at any size, and even the 12% and 15%
     * ones failed once conviction had shrunk the position and the fixed fee became a
     * larger share of it.
     *
     * So the floor is now the executor's own guard, run here before publishing:
     *   conservative = (1 - roundTrip) * slippageHaircut - feeRatio
     *   the call is refused unless conservative > stopRatio
     * which rearranges to a minimum stop distance this coin must carry. Publish only
     * what the bot can take, and every published call is actionable by construction.
     *
     * A coin whose honest invalidation level is tighter than that is not a coin this
     * desk can trade at this size. That is the answer the PM prompt already asks for —
     * say so and decline, rather than moving the level to fit. */
    const floorPct = Number(cfg.minStopDistancePct) || 0;
    if (ticket.stop_price > 0 && ticket.entry_zone_low > 0) {
      const distPct = (1 - ticket.stop_price / ticket.entry_zone_low) * 100;
      const rtPct = Number(ev?.exitProbe?.roundTripLossPct);
      const haircut = (1 - (Number(cfg.executorSlippageBps) || 300) / 10_000) ** 2;
      /* Fees scale with the stop, matching the executor — and with the EFFECTIVE stop it
         actually uses, which is the authored distance plus the measured round-trip
         friction. Using the raw stop here left the desk a third of a percent optimistic
         and it published calls the bot then refused. */
      const proposedStopFrac = 1 - ticket.stop_price / ticket.entry_zone_low;
      const effectiveStopFrac = Math.max(proposedStopFrac, 0.01) +
        (Number.isFinite(rtPct) ? rtPct / 100 : 0);
      const feeRatio = (Number(cfg.executorMaxFeeShareOfStop) || 0.25) * effectiveStopFrac;
      /* Derived only when the round trip was actually measured. An unmeasured coin
         falls back to the flat floor rather than to a number invented from nothing. */
      const derivedPct = Number.isFinite(rtPct)
        ? (1 - ((1 - rtPct / 100) * haircut - feeRatio)) * 100
        : null;
      /* The derived figure REPLACES the flat one when it exists; the flat floor is the
         fallback for an unmeasured coin, not a second opinion to be maxed against a
         real measurement. */
      const requiredPct = derivedPct ?? floorPct;
      v(distPct < requiredPct, "stop_inside_costs",
        `stop is ${distPct.toFixed(1)}% below entry, but this coin needs at least ` +
        `${requiredPct.toFixed(1)}%` +
        (derivedPct != null
          ? ` — its measured round trip is ${rtPct.toFixed(2)}%, slippage costs ` +
            `${((1 - haircut) * 100).toFixed(2)}% and fees about ${(feeRatio * 100).toFixed(1)}% ` +
            `of the position the bot will actually size`
          : ` (the flat floor; this coin's round trip was not measured)`) +
        `. A stop inside that is triggered by the costs before the thesis is wrong, and ` +
        `the executor proves it and refuses to sign.`);
    }

    const tpSum = (ticket.take_profit || []).reduce((a, t) => a + (t.pct_to_sell || 0), 0);
    v(tpSum > 100.01, "tp_over_100", `take-profit legs sum to ${tpSum}% of the position.`);

    v(Math.abs(ticket.stop_price - (risk?.stop_price ?? ticket.stop_price)) > 1e-12,
      "stop_mismatch", `ticket stop ${ticket.stop_price} != risk seat stop ${risk?.stop_price}.`);

    if (px > 0) {
      w(px < ticket.entry_zone_low * 0.5 || px > ticket.entry_zone_high * 2,
        "entry_far_from_market", `current price ${px} is far outside entry zone ${ticket.entry_zone_low}-${ticket.entry_zone_high}.`);
    }

    const measured = ev?.exitProbe?.roundTripLossPct;
    w(measured != null && ticket.max_slippage_bps != null && ticket.max_slippage_bps / 100 < measured / 2,
      "slippage_too_tight", `max_slippage ${ticket.max_slippage_bps}bps is tight against a measured round trip of ${measured}%.`);
  }

  return { pass: violations.length === 0, violations, warnings };
}
