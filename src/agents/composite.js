import { cfg } from "../config.js";

export function composite(analysts, weights = cfg.weights, omit = null) {
  let num = 0, den = 0;
  for (const [seat, a] of Object.entries(analysts || {})) {
    if (seat === omit) continue;
    const w = (weights[seat] ?? 0) * (a?.confidence ?? 0.5);
    num += (a?.score ?? 50) * w;
    den += w;
  }
  return den > 0 ? num / den : 50;
}

/** Observational attribution: how much each seat moves the mechanical composite. */
export function leaveOneOut(analysts, weights = cfg.weights) {
  const full = composite(analysts, weights);
  const seats = {};
  for (const seat of Object.keys(analysts || {})) {
    const without = composite(analysts, weights, seat);
    seats[seat] = { without, delta: full - without,
      // A compact observational flag for the mechanical bull/bear side. Candidate-
      // ranking flips are computed later across a full cohort from these same values.
      sideFlipped: (full >= 50) !== (without >= 50) };
  }
  return { full, seats };
}
