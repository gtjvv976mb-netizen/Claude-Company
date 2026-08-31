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
