import { cfg } from "../config.js";

const FORBIDDEN = /\b(private key|seed phrase|secret key|mnemonic|signTransaction|sendTransaction|sendRawTransaction|keypair)\b/i;

/**
 * COMPLIANCE — the final veto, and deliberately not a model. The charter's hard rules
 * are enforced by code so that no amount of persuasive reasoning upstream can talk the
 * desk past them. Every violation here is a veto, not a warning.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SEAT NO LONGER JUDGES, AND WHY THAT IS A CORRECTION RATHER THAN A LOOSENING
 *
 * THE OWNER'S RULE (2026-09-07, stated three times and final): the desk says only WHAT
 * and WHEN — what to buy, hold or sell, and when. It never says HOW MUCH, and it never
 * judges fees, costs or balance. Every one of those belongs to the bot, which owns the
 * wallet.
 *
 * Three vetoes lived here and are gone: `size_exceeds_exit_probe`, `edge_below_cost`
 * and `stop_inside_costs`. All three were the SAME arithmetic the executor already
 * performs — and the executor performs it correctly, because it runs at the size it is
 * actually about to sign for, against a live quote, seconds before signing. This seat
 * ran it against a notional the desk invented.
 *
 * THE INCIDENT THAT PROVES THE DUPLICATE WAS THE WORSE COPY. On 2026-09-07 a coin was
 * refused with "round-trip loss 8.08% > ceiling 8% at $75". The bot's actual trade size
 * is about $2. The desk had measured the cost of exiting $75 of a coin, found it dear,
 * and withheld a call the bot would have entered for two dollars. Eleven more of the
 * last hundred kills read the same way. A veto computed on a fabricated size is not a
 * conservative veto; it is a wrong one, and its errors are invisible because they look
 * like caution.
 *
 * WHERE EACH ONE LIVES NOW, all in the process that owns the money:
 *   size_exceeds_exit_probe → executor/strategy.mjs:305 (`want = Math.min(want,
 *     c.maxSolPerTrade)`), :307-311 (per-name risk, book heat, daily deploy cap,
 *     spendable balance) and executor/jupiter.mjs:148-149 — the price impact of the
 *     REAL order, refused above cfg.maxPriceImpactPct before the bytes are signed.
 *   edge_below_cost → executor/strategy.mjs:161-164, `rNet = (targetFrac - cost) /
 *     (stopFrac + cost)`, skipping with "costs eat the target" — where `cost` includes
 *     the round trip measured at the bot's own size (strategy.mjs:155, fed by
 *     poller.mjs:1254 `measuredRoundTripLossPct`).
 *   stop_inside_costs → executor/poller.mjs:1234-1253, the identical formula
 *     (`executableReturnRatio * slippageHaircut - worstFeeRatio <= stopRatio` → throw),
 *     run on the preflight quote for `preliminaryAmountRaw` — the lamports it is about
 *     to spend — rather than on a desk constant.
 *
 * WHAT STAYS. Everything below is either a coin-quality fact or an internal-consistency
 * check on the desk's OWN paper record (equity, its stated risk budget, its arithmetic
 * agreeing with itself). None of it constrains the bot's wallet, and none of it is a
 * claim about what a trade costs.
 * ═══════════════════════════════════════════════════════════════════════════════════
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

  /* `size_exceeds_exit_probe` WAS HERE. It vetoed a call whose risk-seat size exceeded
   * the notional the desk's exit probe had been quoted at — "bigger than we proved we
   * can exit". The sentiment is right and the seat holding it was wrong: the desk's
   * size is a paper number on a paper book, and the only size that can be too big is
   * the one about to be signed. The bot bounds that one four ways it can actually
   * enforce (strategy.mjs:305 operator ceiling and maxSolPerTrade; :307 per-name risk;
   * :308-311 book heat, daily deploy cap, spendable balance) and then proves it against
   * the live pool: jupiter.mjs:148-149 refuses the built order outright when its
   * measured price impact exceeds the cap. See the header for the $75-versus-$2
   * incident this deletion answers. */

  /* Never trust three model-authored numbers to agree. Recompute loss from the actual
   * entry, stop and recorded paper size, then compare both the budget and the claimed
   * figure against that arithmetic.
   *
   * `rtFrac` — the measured round trip, added to the stop distance as friction — WAS a
   * term in this and is gone (owner, 2026-09-07). It is a cost, it was measured at a
   * notional the desk invented, and this consistency check exists only to prove the
   * desk's own paper record adds up. Priced off the stop alone it matches
   * risk-rails.js exactly, which is the whole point of recomputing it. */
  const riskPx = Number(ev?.pair?.priceUsd);
  const riskStop = Number(risk?.stop_price);
  const riskSize = Number(risk?.position_size_usd);
  if (riskPx > 0 && riskStop > 0 && riskStop < riskPx && riskSize > 0) {
    const computedLoss = riskSize * ((riskPx - riskStop) / riskPx);
    v(computedLoss > maxRisk * 1.01, "computed_risk_budget_breach",
      `entry/stop/size imply $${computedLoss.toFixed(2)} loss at the stop, above $${maxRisk.toFixed(2)}.`);
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
   * with NONE of this validated: not the entry zone being a real range, not the stop
   * sitting below the entry zone, not the take-profit legs summing under 100%, not the
   * ticket stop agreeing with the risk seat's. The decision-shaped checks above stay tied to
   * PROPOSE; ticket ARITHMETIC is true or false regardless of the verdict behind it. */
  if (ticket) {
    const px = ev?.pair?.priceUsd;

    /* `edge_below_cost` WAS HERE — the Hummingbot lesson (-1.54% over 334 honestly
     * published live trades: a target that is not a large multiple of round-trip cost
     * is a machine for paying the market). The lesson stands. The seat enforcing it
     * does not, because "5x the round trip" is only meaningful at the size the round
     * trip was quoted at, and this desk was quoting $75 for a bot that trades $2 —
     * so it demanded a target five times too far away and passed on the coin.
     *
     * The bot runs the same test where the numbers are real: executor/strategy.mjs:161-164
     * computes R_net = (targetFrac - cost) / (stopFrac + cost) and skips with "costs eat
     * the target" when it is not positive, with `cost` carrying the round trip measured
     * on the bot's own lamports (strategy.mjs:155 ← poller.mjs:1254). It also refuses on
     * the break-even hit rate the bracket implies (strategy.mjs:174-180), which is the
     * same judgment with the desk's realised record priced in. */
    v(!(ticket.entry_zone_low > 0) || !(ticket.entry_zone_high >= ticket.entry_zone_low),
      "bad_entry_zone", `entry zone ${ticket.entry_zone_low}-${ticket.entry_zone_high} is not a valid range.`);

    v(ticket.stop_price > 0 && ticket.stop_price >= ticket.entry_zone_low,
      "stop_above_entry", `stop ${ticket.stop_price} is not below entry low ${ticket.entry_zone_low}.`);

    /* `stop_inside_costs` WAS HERE, and it was the largest duplicate of the three.
     *
     * It reproduced, line for line, the executor's pre-signing guard: take the measured
     * round trip, apply the slippage tolerance to both legs, subtract a worst-case
     * network fee, and refuse the call unless what is left still sits above the stop.
     *   conservative = (1 - roundTrip) * slippageHaircut - feeRatio  >  stopRatio
     * That guard is correct and it is still enforced — in executor/poller.mjs:1234-1253,
     * which throws before an entry is ever journaled and names which term dominated. The
     * difference is the inputs. The bot measures `preflight.lossPct` on
     * `preliminaryAmountRaw`, the exact lamports it is about to spend, and computes
     * `worstFeeRatio` as `2 * expectedNetworkFeeLamports / preliminaryAmountRaw` — the
     * fee share of the REAL order. This copy read cfg.executorSlippageBps and
     * cfg.executorMaxFeeShareOfStop against a round trip quoted at a notional the desk
     * chose, which on 2026-09-07 was $75 while the bot's clip was about $2. Fees are a
     * far larger share of $2 than of $75 and slippage a far smaller one, so the two
     * calculations did not merely differ in confidence — they disagreed in both
     * directions at once, and the desk's version had no way to find out.
     *
     * The seat is also still told the shape of the problem in prose (a stop tighter than
     * the cost of the round trip is not a stop), because authoring a 5% stop on a coin
     * that moves 20% in minutes is bad THESIS work, which is the desk's job. What is
     * gone is code here converting that into a dollar refusal. */

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
