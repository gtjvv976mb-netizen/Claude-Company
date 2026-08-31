import { cfg } from "../config.js";

const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Retained book heat, reserving a full idea budget for pre-migration live calls. */
export function retainedBookRiskUsd(calls, config = cfg) {
  const legacyReserve = config.equityUsd * (config.maxRiskPct / 100);
  return (calls || []).reduce((sum, call) => sum +
    (call?.desk_risk_usd == null
      ? legacyReserve
      : Math.max(0, finite(call.desk_risk_usd) ?? 0)), 0);
}

/**
 * Convert the Risk seat's judgement into deterministic arithmetic.
 *
 * The model chooses the thesis invalidation and may recommend being smaller. Code
 * decides whether zero is mechanically required, derives loss-at-stop, and enforces
 * the exact size that was actually exit-probed. This prevents prose mistakes from
 * creating either an empty book or an oversized one.
 */
export function enforceRiskRails({ risk, ev, redteam, openRiskUsd = 0, config = cfg }) {
  const out = { ...(risk || {}) };
  const notes = [];
  const px = finite(ev?.pair?.priceUsd);
  const stop = finite(out.stop_price);
  const rt = finite(ev?.exitProbe?.roundTripLossPct);
  const rtCost = rt == null ? null : Math.max(0, rt);
  const maxRisk = config.equityUsd * (config.maxRiskPct / 100);

  const authorityLive = Boolean(
    ev?.mintAccount?.mintAuthority || ev?.mintAccount?.freezeAuthority ||
    (ev?.mintAccount?.flags || []).some((f) =>
      /mint_authority_live|freeze_authority_live|permanent_delegate|transfer_hook/i.test(String(f)))
  );
  const exitFails = rt == null || rt > config.maxRoundTripSlippagePct || Boolean(ev?.exitProbe?.error);

  if (exitFails || authorityLive) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    out.liquidity_adjusted = true;
    notes.push(exitFails
      ? `mechanical zero: exit probe was unavailable or exceeded ${config.maxRoundTripSlippagePct}%`
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

  const stopFrac = (px - stop) / px;
  // Include the measured round-trip cost in loss-at-stop. A stop is not filled at a
  // frictionless midpoint, especially in the exact drawdown in which it matters.
  const lossFrac = stopFrac + (rtCost / 100);
  const redMultiplier = redteam?.verdict === "refuted" ? 0.25
    : redteam?.verdict === "wounded" ? 0.5 : 1;
  const tierMultiplier = ({ minimal: 0.10, quarter: 0.25, half: 0.50, full: 1 })[out.risk_tier] ?? 0.10;
  const confidenceMultiplier = clamp(finite(out.confidence) ?? 0.5, 0.25, 1);
  const liquidityMultiplier = rtCost > 4 ? 0.5 : rtCost > 2 ? 0.75 : 1;
  const maxBookRisk = config.equityUsd * ((config.maxBookRiskPct ?? 4) / 100);
  const remainingBookRisk = Math.max(0, maxBookRisk - Math.max(0, finite(openRiskUsd) ?? 0));
  const riskBudget = Math.min(
    maxRisk * tierMultiplier * redMultiplier * confidenceMultiplier * liquidityMultiplier,
    remainingBookRisk,
  );
  if (!(riskBudget > 0)) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push(`book heat exhausted: $${Number(openRiskUsd).toFixed(2)} already at risk`);
    return finish(out, notes);
  }
  const arithmeticSize = riskBudget / lossFrac;
  let size = arithmeticSize;

  // The desk measured a round trip at targetSizeUsd. It has no evidence that a larger
  // order can leave at the assumed stop, so targetSizeUsd is an absolute size ceiling.
  const sizeCeiling = Math.min(config.equityUsd, config.targetSizeUsd);
  if (size > sizeCeiling) {
    size = sizeCeiling;
    out.liquidity_adjusted = true;
    notes.push(`size capped to the $${sizeCeiling} exit-probe notional`);
  }
  if (liquidityMultiplier < 1) {
    out.liquidity_adjusted = true;
    notes.push(`risk reduced for measured ${rtCost}% round-trip cost`);
  }
  notes.push(`${out.risk_tier || "minimal"} tier converted to a $${riskBudget.toFixed(2)} cost-adjusted loss budget`);

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
