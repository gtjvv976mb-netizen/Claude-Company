/**
 * THE SIX SLEEVES — the desk's market-cap bands, and how long each is held.
 *
 * A LEAF. This module imports nothing, on purpose: the bands are the desk's one
 * taxonomy and both the screen (config.js) and the board (categories.js) must read the
 * same numbers. When the boundaries lived in categories.js, config.js could not import
 * them without a cycle, so it kept its own copy — and on 2026-09-03 the two drifted a
 * full rung apart, the screen calling a $250k coin "low" while the desk called it
 * "medium". One definition, no cycle, no drift.
 */
/* THE SIX SLEEVES, AND HOW LONG EACH ONE IS MEANT TO BE HELD (owner, 2026-09-03).
 *
 * The ladder moved down a rung and grew a nano band, because the money on this desk is
 * made buying low and selling high inside a session, not holding: a $5k coin that works
 * does it within half an hour, and a $5m coin needs most of a day. `hold` is not a
 * suggestion — a call carries its band's window, and the executor sells at `holdMaxMs`
 * whether or not the target printed. Nothing here is a safety limit; the stop, the
 * liquidity floor and the exit probe are, and they did not move. */
export const CAP_BANDS = {
  nano:      { lo: 5_000,     hi: 20_000,     label: "nano",      note: "$5k-$20k — minutes old, decided in minutes",
               holdMinMs: 60_000,             holdMaxMs: 30 * 60_000 },
  micro:     { lo: 20_000,    hi: 60_000,     label: "micro",     note: "$20k-$60k — the first re-rate, sharpest rugs",
               holdMinMs: 20 * 60_000,        holdMaxMs: 60 * 60_000 },
  low:       { lo: 60_000,    hi: 100_000,    label: "low",       note: "$60k-$100k — a crowd is forming",
               holdMinMs: 60 * 60_000,        holdMaxMs: 5 * 60 * 60_000 },
  medium:    { lo: 100_000,   hi: 500_000,    label: "medium",    note: "$100k-$500k — room to re-rate, thin book",
               holdMinMs: 60 * 60_000,        holdMaxMs: 5 * 60 * 60_000 },
  high:      { lo: 500_000,   hi: 1_000_000,  label: "high",      note: "$500k-$1m — a tape worth reading",
               holdMinMs: 60 * 60_000,        holdMaxMs: 5 * 60 * 60_000 },
  very_high: { lo: 1_000_000, hi: 10_000_000, label: "very high", note: "$1m-$10m — needs real money to move",
               holdMinMs: 5 * 60 * 60_000,    holdMaxMs: 24 * 60 * 60_000 },
};

/** The hold window for a market cap, or null when the cap is unreadable or off-board. */
export function holdWindowFor(mcap) {
  if (mcap == null || !(mcap > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS))
    if (mcap >= b.lo && mcap < b.hi) return { band, holdMinMs: b.holdMinMs, holdMaxMs: b.holdMaxMs };
  return null;
}

/** The band a market cap sits in, or null when it is unreadable or off the board. */
export function bandForMarketCap(mcap) {
  const mc = Number(mcap);
  if (!Number.isFinite(mc) || !(mc > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS)) if (mc >= b.lo && mc < b.hi) return band;
  return null;
}
