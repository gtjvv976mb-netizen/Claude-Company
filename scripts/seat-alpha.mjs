#!/usr/bin/env node
/**
 * Ask the journal whether the paid seats discriminate better than the free screen.
 *
 *   node scripts/seat-alpha.mjs                        # 24h horizon, strict cost policy
 *   node scripts/seat-alpha.mjs --horizon 360          # 6h
 *   node scripts/seat-alpha.mjs --cost zero            # reproduce the known-biased view
 *   node scripts/seat-alpha.mjs --gates               # also break the kills down by gate
 *
 * Reads only. Spends nothing. This is the one measurement that runs with both provider
 * accounts empty, which is why it goes first.
 */
import { seatAlpha, killBreakdown } from "../src/seat-alpha.js";

const argv = process.argv.slice(2);
const flag = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (name) => argv.includes(`--${name}`);

const horizonMin = Number(flag("horizon", 1440));
const costPolicy = flag("cost", "exclude");
const pct = (x) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);

const r = seatAlpha({
  horizonMin,
  costPolicy,
  bootstrapSamples: Number(flag("samples", 4000)),
  floorNo: has("floor") ? Number(flag("floor")) : undefined,
  policyVersion: flag("policy-version", undefined),
});

console.log(`\n  DO THE PAID SEATS BEAT THE FREE SCREEN?`);
console.log(`  horizon ${r.horizonMin}m · cost policy "${r.costPolicy}" · ${r.cycles} cycles\n`);

const row = (label, a) => console.log(
  `    ${label.padEnd(16)} n=${String(a.n).padStart(5)}  cycles=${String(a.cycles).padStart(4)}` +
  `  mean net ${pct(a.meanNetPct).padStart(9)}  median ${pct(a.medianNetPct).padStart(9)}` +
  (a.droppedNoCost ? `   (${a.droppedNoCost} dropped: no measured round trip)` : ""));

row("approved", r.arms.approved);
row("analyst-killed", r.arms.analystKilled);

if (r.verdict === "INSUFFICIENT") {
  console.log(`\n  ⟶ INSUFFICIENT — ${r.reason}`);
  console.log(`    No number is reported, on purpose. A delta from this little data is not evidence.\n`);
} else {
  const [lo, hi] = r.delta.ci95Pct;
  console.log(`\n    delta (approved − killed)   ${pct(r.delta.pointPct)}`);
  console.log(`    95% interval                [${pct(lo)}, ${pct(hi)}]`);
  console.log(`    resampled by                ${r.bootstrap.resampledUnit}` +
    ` (${r.bootstrap.usable}/${r.bootstrap.samples} usable, seed ${r.bootstrap.seed})`);
  const say = {
    SEATS_DISCRIMINATE: "the approved arm outperforms the killed arm on this journal",
    SEATS_ANTI_DISCRIMINATE: "the KILLED arm outperforms the approved arm — the seats are picking badly",
    NO_DETECTABLE_DIFFERENCE: "no difference this journal can resolve",
  }[r.verdict];
  console.log(`\n  ⟶ ${r.verdict} — ${say}`);
}

for (const c of r.caveats) console.log(`\n    ! ${c.replace(/\s+/g, " ")}`);

if (has("gates")) {
  console.log(`\n  WHICH GATES DID THE KILLING\n`);
  for (const g of killBreakdown({ horizonMin })) {
    console.log(`    ${String(g.gate ?? "—").padEnd(28)} n=${String(g.n).padStart(5)}` +
      `   mean gross ${pct(g.mean_gross_pct)}`);
  }
}
console.log("");
