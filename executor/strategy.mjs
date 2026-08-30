/**
 * THE RISK ENGINE — pure decision logic for the Claude Company executor.
 *
 * Deliberately free of network, wallet and clock: every input is passed in and
 * every output is a plain intent ({action, reason, ...}). That is what makes it
 * simulatable — simulate.mjs runs this exact code over tens of thousands of
 * synthetic price paths, so the numbers you see are produced by the same
 * function that will trade your money, not by a separate toy model.
 *
 * WHAT THIS BUYS YOU, and it is the whole point:
 *   The desk publishes an entry and, later, an exit. Between those two messages
 *   the naive bot is naked — if the desk's monitor is slow, or your box was
 *   asleep, or the token rugs in ninety seconds, nothing protects the position.
 *   This engine watches the mark every poll and acts on its own:
 *
 *     STOP        — cut at the desk's stop. Non-negotiable, checked every tick.
 *     BREAKEVEN   — the moment the call's target is touched, the stop lifts to
 *                   entry. From there the position cannot lose money.
 *     TRAIL       — and then ratchets up behind the high water mark, so a rare
 *                   10x is allowed to run instead of being round-tripped.
 *                   (An optional scale-out exists but ships OFF: the sweep in
 *                   tune.mjs showed every scale-out setting cost mean P&L,
 *                   because cutting winners kills the fat tail.)
 *     DESK EXIT   — the desk's own exit always wins and sells everything: it
 *                   knows things the price alone does not (creator sold, LP
 *                   pulled, thesis dead).
 *
 *   Plus the two portfolio brakes that decide whether a bot survives a bad week:
 *     DAILY LOSS LIMIT and MAX CONCURRENT POSITIONS.
 *
 * None of this manufactures an edge — the edge is the quality of the desk's
 * calls. This engine exists so a real edge is not destroyed by one bad night,
 * and so a bad streak cannot compound into a blown account.
 */

export const DEFAULTS = {
  maxSolPerTrade: 0.05,
  dailySolCap: 0.5,          // total SOL deployed per rolling day
  dailyLossLimitSol: 0.15,   // realized losses that stop new entries for the day
  maxOpenPositions: 4,
  // TUNED BY SIMULATION, not by feel — see tune.mjs. On a fat-tailed return
  // distribution every scale-out setting REDUCED mean P&L: cutting winners kills
  // the runners that carry the whole edge. Zero scale-out with a wide trail
  // matched the naive bot's mean while cutting the bad-run tail (10th pct
  // -0.152 -> -0.118 SOL) and drawdown (-0.233 -> -0.187). Change these only
  // with a fresh sweep, never by intuition.
  scaleOutPct: 0,            // fraction sold when target is first touched (0 = ride it)
  trailPct: 0.60,            // trail this far under the high water mark, once armed
  stopBufferPct: 0,          // widen the desk's stop by this much (0 = obey exactly)
};

/** Should we take this entry at all, and at what size? */
export function planEntry({ call, cfg = DEFAULTS, state }) {
  const c = { ...DEFAULTS, ...cfg };
  if (state.openCount >= c.maxOpenPositions)
    return { action: "skip", reason: `already holding ${state.openCount} of max ${c.maxOpenPositions}` };
  if (state.realizedTodaySol <= -Math.abs(c.dailyLossLimitSol))
    return { action: "skip", reason: `daily loss limit hit (${state.realizedTodaySol.toFixed(3)} SOL)` };

  const want = Math.min(Number(call.size_sol) || c.maxSolPerTrade, c.maxSolPerTrade);
  if (state.deployedTodaySol + want > c.dailySolCap)
    return { action: "skip", reason: `daily deploy cap (${state.deployedTodaySol.toFixed(3)}/${c.dailySolCap} SOL)` };
  if (state.spendableSol != null && want > state.spendableSol)
    return { action: "skip", reason: "insufficient balance after the fee reserve" };
  if (!(want > 0)) return { action: "skip", reason: "size rounds to nothing" };

  // A call with no stop is a call we cannot risk-manage; refuse it rather than
  // hold something with no floor under it.
  if (call.stop == null || !(Number(call.stop) > 0))
    return { action: "skip", reason: "call has no stop — refusing an unmanageable position" };

  return { action: "buy", sol: want, reason: "entry within caps" };
}

/** Fresh position record, created after a fill. */
export function openPosition({ call, sol, fillPrice, cfg = DEFAULTS }) {
  const c = { ...DEFAULTS, ...cfg };
  const stop = Number(call.stop) * (1 - c.stopBufferPct);
  return {
    mint: call.mint, symbol: call.symbol,
    entry: fillPrice, sol, qty: sol / fillPrice,
    stop, initialStop: stop,
    target: call.target != null ? Number(call.target) : null,
    high: fillPrice, scaled: false, openedAt: call.ts ?? 0,
  };
}

/**
 * The per-tick decision for ONE open position. `mark` is the current price;
 * `deskExit` is set when the desk has published an exit for this call.
 * Returns {action: hold|sell|sell_part, fraction, reason}.
 */
export function stepPosition({ pos, mark, deskExit = null, cfg = DEFAULTS }) {
  const c = { ...DEFAULTS, ...cfg };

  // The desk's own exit outranks price: it can see a rug, a creator sell or a
  // dead thesis that the last print does not show yet.
  if (deskExit) return { action: "sell", fraction: 1, reason: `desk exit: ${deskExit.code || "exit"}` };

  if (!(mark > 0)) return { action: "hold", reason: "no readable mark" };
  if (mark > pos.high) pos.high = mark;

  // The stop is checked first and always. This is the line that keeps one bad
  // night from being the last night.
  if (mark <= pos.stop)
    return { action: "sell", fraction: 1,
      reason: pos.scaled ? "trailing stop" : "stop loss" };

  // First touch of target ARMS the trail and lifts the stop to breakeven, so the
  // position can no longer lose. Only sells here if a scale-out is configured —
  // a zero fraction must never reach the wallet as a zero-size swap.
  if (!pos.scaled && pos.target != null && mark >= pos.target) {
    pos.scaled = true;
    pos.stop = Math.max(pos.stop, pos.entry);      // breakeven, never worse
    const trail = pos.high * (1 - c.trailPct);
    if (trail > pos.stop) pos.stop = trail;
    if (c.scaleOutPct > 0)
      return { action: "sell_part", fraction: c.scaleOutPct, reason: "target hit — scaling out, stop to breakeven" };
    return { action: "hold", reason: "target hit — stop to breakeven, now trailing" };
  }

  // After scaling, ratchet the stop up behind the high. Never loosen it.
  if (pos.scaled) {
    const trail = pos.high * (1 - c.trailPct);
    if (trail > pos.stop) pos.stop = trail;
  }

  return { action: "hold", reason: "in trade" };
}

/** Roll the daily counters when the day boundary passes. */
export function rollDay(state, now, dayMs = 86400e3) {
  if (now - state.dayStart >= dayMs) {
    state.dayStart = now;
    state.deployedTodaySol = 0;
    state.realizedTodaySol = 0;
  }
  return state;
}

export const freshState = (now = 0) => ({
  dayStart: now, deployedTodaySol: 0, realizedTodaySol: 0,
  openCount: 0, spendableSol: null,
});
