/**
 * PARAMETER SWEEP — find risk settings that survive a fat tail.
 *
 * The first simulation run taught an expensive lesson cheaply: on a fat-tailed
 * return distribution, a tight trail and an eager scale-out CUT THE RUNNERS,
 * and the runners are the entire profit. A stop that feels prudent per-trade
 * can be ruinous per-portfolio.
 *
 * This sweeps the engine's parameters over the same seeded call streams and
 * ranks them by what actually matters: mean P&L, the bad-run tail (10th pct),
 * and drawdown. Whatever wins here becomes the shipped default — no parameter
 * in strategy.mjs is chosen by feel.
 *
 *   node tune.mjs [--trials 250] [--calls 60] [--winrate 0.28] [--desklag 40]
 */
import { DEFAULTS, planEntry, openPosition, stepPosition, rollDay, freshState } from "./strategy.mjs";

function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function makePath(rand, winrate, steps = 240) {
  const u = rand();
  let endMul;
  if (u < 0.34) endMul = 0.05 + rand() * 0.25;
  else if (u < 1 - winrate) endMul = 0.45 + rand() * 0.45;
  else if (u < 1 - winrate * 0.22) endMul = 1.15 + rand() * 1.1;
  else endMul = 2.5 + rand() * 9;
  const drift = Math.log(endMul) / steps, vol = 0.055 + rand() * 0.05;
  const path = [1];
  for (let i = 1; i <= steps; i++) {
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    path.push(Math.max(1e-6, path[i - 1] * Math.exp(drift + vol * z)));
  }
  return path;
}
function deskExitStep(path, stop, target, lag) {
  for (let i = 1; i < path.length; i++)
    if (path[i] <= stop || (target != null && path[i] >= target)) return Math.min(path.length - 1, i + lag);
  return path.length - 1;
}

function run({ managed, calls, rand, cfg, deskLag, winrate }) {
  const state = freshState(0);
  let realized = 0, equity = 0, peak = 0, maxDD = 0;
  for (let n = 0; n < calls; n++) {
    const path = makePath(rand, winrate);
    const entry = path[0], stop = entry * 0.62, target = entry * 1.9;
    const call = { mint: "m" + n, symbol: "C" + n, size_sol: cfg.maxSolPerTrade, stop, target, ts: n };
    rollDay(state, n, 1e9);
    const plan = planEntry({ call, cfg, state });
    if (plan.action !== "buy") continue;
    state.deployedTodaySol += plan.sol; state.openCount++;
    const pos = openPosition({ call, sol: plan.sol, fillPrice: entry, cfg });
    const exitAt = deskExitStep(path, stop, target, deskLag);
    let qty = pos.qty, gross = 0, done = false;
    for (let i = 1; i < path.length && !done; i++) {
      const mark = path[i], deskExit = i >= exitAt ? { code: "desk" } : null;
      if (!managed) { if (deskExit) { gross += qty * mark; qty = 0; done = true; } continue; }
      const d = stepPosition({ pos, mark, deskExit, cfg });
      if (d.action === "sell") { gross += qty * mark; qty = 0; done = true; }
      else if (d.action === "sell_part") { const p = qty * d.fraction; gross += p * mark; qty -= p; }
    }
    if (qty > 0) gross += qty * path[path.length - 1];
    const net = gross - plan.sol;
    realized += net; state.realizedTodaySol += net; state.openCount--;
    equity += net; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
  }
  return { realized, maxDD };
}

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TRIALS = arg("trials", 250), CALLS = arg("calls", 60);
const WINRATE = arg("winrate", 0.28), DESKLAG = arg("desklag", 40), SEED = 11;

const score = (rows) => {
  const s = rows.map((r) => r.realized).sort((a, b) => a - b);
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p10: s[Math.floor(s.length * 0.1)],
    dd: Math.min(...rows.map((r) => r.maxDD)),
    winRuns: rows.filter((r) => r.realized > 0).length / rows.length,
  };
};

const base = [];
for (let t = 0; t < TRIALS; t++) base.push(run({ managed: false, calls: CALLS, rand: rng(SEED + t), cfg: DEFAULTS, deskLag: DESKLAG, winrate: WINRATE }));
const B = score(base);

const grid = [];
for (const scaleOutPct of [0, 0.25, 0.5])
  for (const trailPct of [0.30, 0.45, 0.60, 0.75])
    grid.push({ scaleOutPct, trailPct });

const rows = grid.map((g) => {
  const cfg = { ...DEFAULTS, ...g };
  const out = [];
  for (let t = 0; t < TRIALS; t++) out.push(run({ managed: true, calls: CALLS, rand: rng(SEED + t), cfg, deskLag: DESKLAG, winrate: WINRATE }));
  return { ...g, ...score(out) };
});

rows.sort((a, b) => b.mean - a.mean);
const f = (v) => (v >= 0 ? "+" : "") + v.toFixed(3);
console.log(`\nPARAMETER SWEEP — ${TRIALS} runs x ${CALLS} calls, win rate ${(WINRATE*100).toFixed(0)}%, desk lag ${DESKLAG}`);
console.log(`Baseline NAIVE: mean ${f(B.mean)}  p10 ${f(B.p10)}  worstDD ${B.dd.toFixed(3)}  winRuns ${(B.winRuns*100).toFixed(0)}%\n`);
console.log(` scaleOut  trail    mean      p10      worstDD   winRuns   vs naive`);
for (const r of rows)
  console.log(`   ${String(r.scaleOutPct).padEnd(8)}${String(r.trailPct).padEnd(8)}${f(r.mean).padEnd(10)}${f(r.p10).padEnd(9)}${r.dd.toFixed(3).padEnd(10)}${(r.winRuns*100).toFixed(0).padEnd(10)}${f(r.mean - B.mean)}`);
console.log(`\nPick: highest mean that also improves p10 and drawdown vs naive.\n`);
