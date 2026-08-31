export const POLICY_VERSION = "snipe-v2";

export const POLICY_DEFAULTS = Object.freeze({
  takeProfitX: 2,
  maxAgeHours: 12,
  trailPct: 0.25,
  breakevenArmX: 1.35,
  trailArmX: 1.5,
  honorDeskTarget: true,
});

/** Resolve the floor dial once, when the position opens. */
export function resolveTakeProfitRule(rawValue, fallback = POLICY_DEFAULTS.takeProfitX) {
  const raw = Number(rawValue);
  const explicit = Number.isFinite(raw) && raw > 0;
  const fallbackNumber = Number(fallback);
  return {
    takeProfitX: explicit ? raw
      : (Number.isFinite(fallbackNumber) && fallbackNumber > 0
        ? fallbackNumber : POLICY_DEFAULTS.takeProfitX),
    honorDeskTarget: !explicit,
  };
}

/** Restore the immutable rule saved on an open position. */
export function policyConfigForPosition(position, baseConfig = {}) {
  const savedTakeProfit = Number(position?.takeProfitX);
  return {
    ...baseConfig,
    takeProfitX: Number.isFinite(savedTakeProfit) && savedTakeProfit > 0
      ? savedTakeProfit : (baseConfig.takeProfitX ?? POLICY_DEFAULTS.takeProfitX),
    // Old state has no boolean. Honor the authored target in that ambiguous case;
    // exiting earlier is the conservative migration and new positions always persist it.
    honorDeskTarget: typeof position?.honorDeskTarget === "boolean"
      ? position.honorDeskTarget
      : (baseConfig.honorDeskTarget ?? POLICY_DEFAULTS.honorDeskTarget),
  };
}

/** Bind an entry to a recent independently monitored USD mark before local signing.
 * The position policy itself remains dimensionless; ratios are anchored to this
 * verified mark so an old authored stop cannot silently widen after a price gap. */
export function validateEntryReference(event, {
  nowMs = Date.now(), maxMarkAgeMs = 15 * 60_000, maxDeviationPct = 10,
} = {}) {
  const mark = Number(event?.current_mark);
  const markAt = Number(event?.current_mark_at);
  const reference = Number(event?.entry_ref);
  const stop = Number(event?.stop);
  if (!(mark > 0) || !Number.isFinite(markAt) || markAt <= 0)
    throw new Error("entry has no current monitored market mark");
  if (markAt > nowMs + 5 * 60_000 || nowMs - markAt > maxMarkAgeMs)
    throw new Error("entry market mark is stale");
  if (!(reference > 0) || !(stop > 0)) throw new Error("entry reference or stop is invalid");
  const fallbackBand = Math.max(0, Number(maxDeviationPct)) / 100;
  const low = Number(event?.entry_lo) > 0 ? Number(event.entry_lo) : reference * (1 - fallbackBand);
  const high = Number(event?.entry_hi) > 0 ? Number(event.entry_hi) : reference * (1 + fallbackBand);
  if (!(high >= low && low > 0)) throw new Error("authored entry zone is invalid");
  if (mark < low || mark > high)
    throw new Error(`current mark ${mark} is outside authored entry zone ${low}-${high}`);
  if (mark <= stop) throw new Error(`current mark ${mark} has already breached stop ${stop}`);
  const target = event?.target == null ? null : Number(event.target);
  if (target != null && !(target > 0)) throw new Error("authored target is invalid");
  if (target != null && target <= mark)
    throw new Error(`current mark ${mark} has already reached authored target ${target}`);
  return {
    marketMark: mark,
    marketMarkAt: markAt,
    stopRatio: stop / mark,
    targetRatio: target == null ? null : target / mark,
    entryLow: low,
    entryHigh: high,
  };
}

/** Pure price-policy decision shared byte-for-byte by the server record and executor. */
export function pricePolicy({ position, mark, deskExit = null, nowMs = Date.now(), config = {} }) {
  const c = { ...POLICY_DEFAULTS, ...config };
  const p = { ...position };
  if (deskExit) return { action: "sell", fraction: 1,
    reason: `desk exit: ${deskExit.code || "exit"}`, position: p, policyVersion: POLICY_VERSION };

  if (p.openedAtMs != null && c.maxAgeHours > 0) {
    const ageH = (nowMs - p.openedAtMs) / 3600e3;
    if (ageH >= c.maxAgeHours) return { action: "sell", fraction: 1,
      reason: `age exit — ${Math.round(ageH)}h with no resolution`, position: p, policyVersion: POLICY_VERSION };
  }
  if (!(mark > 0)) return { action: "hold", reason: "no readable mark", position: p, policyVersion: POLICY_VERSION };

  p.high = Math.max(Number(p.high) || 0, mark);
  if (p.entry > 0 && p.high >= p.entry * c.breakevenArmX)
    p.stop = Math.max(Number(p.stop) || 0, p.entry);
  if (p.entry > 0 && p.high >= p.entry * c.trailArmX)
    p.stop = Math.max(Number(p.stop) || 0, p.high * (1 - c.trailPct));

  if (mark <= p.stop) return { action: "sell", fraction: 1,
    reason: p.stop >= p.entry ? "ratcheted stop" : "stop loss", position: p, policyVersion: POLICY_VERSION };
  if (c.takeProfitX > 0 && p.entry > 0 && mark >= p.entry * c.takeProfitX)
    return { action: "sell", fraction: 1,
      reason: `take profit: ${(mark / p.entry).toFixed(2)}x at or above the ${c.takeProfitX}x rule`,
      position: p, policyVersion: POLICY_VERSION };
  if (c.honorDeskTarget !== false && p.target != null && mark >= p.target)
    return { action: "sell", fraction: 1, reason: "desk target hit", position: p, policyVersion: POLICY_VERSION };
  return { action: "hold", reason: "in trade", position: p, policyVersion: POLICY_VERSION };
}
