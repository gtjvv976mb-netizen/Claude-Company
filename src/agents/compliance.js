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

  v(redteam?.verdict === "refuted" && pm?.decision === "PROPOSE", "overrode_refutation",
    "PM proposed a trade the red team refuted.");

  v(risk?.position_size_usd > 0 === false && pm?.decision === "PROPOSE", "zero_size_proposal",
    "PM proposed a trade the risk seat sized at zero.");

  const maxRisk = cfg.equityUsd * (cfg.maxRiskPct / 100);
  v(risk?.max_loss_usd > maxRisk * 1.01, "risk_budget_breach",
    `max_loss_usd=${risk?.max_loss_usd} exceeds desk ceiling ${maxRisk.toFixed(2)}.`);

  v(risk?.position_size_usd > cfg.equityUsd, "size_exceeds_equity",
    `position_size_usd=${risk?.position_size_usd} exceeds book equity ${cfg.equityUsd}.`);

  if (pm?.decision === "PROPOSE" && ticket) {
    const px = ev?.pair?.priceUsd;
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
