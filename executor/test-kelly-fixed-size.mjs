/**
 * THE KELLY W_min GATE IS A SIZING VERDICT, AND IT ONLY BINDS WHERE KELLY SIZES.
 *
 * planEntry computes half-Kelly and then, if the operator has set a fixed fund, throws
 * the answer away: `want` is overwritten by c.fixedSol. So with the fund on, the W_min
 * branch could only ever REFUSE the trade — it can never shrink it — which makes it a
 * veto dressed as a sizing rule.
 *
 * The measured cost of leaving it armed: 56 trades are closed at a 50% hit rate, and
 * nMin is 12, so the estimate is live. An ordinary 15% stop / 30% target bracket demands
 * W_min 46.7%; a 15% / 25% one demands 52.5%. At a 50% hit rate the second is refused
 * outright and the first survives by three points of noise, so which ordinary brackets
 * the bot may trade at all is decided by a coin flip on a 56-trade sample.
 *
 * What this file has to prove is the SCOPE of the change, because a gate that stops
 * refusing is exactly the shape of a rail quietly removed:
 *   1. with the fund OFF, the gate still refuses, byte for byte;
 *   2. with the fund ON, the trade is taken — at the size the operator's own number
 *      produces, identical to what a healthy hit rate would have bought;
 *   3. every OTHER refusal still stands with the fund on: a negative R_net, a missing
 *      stop, the daily loss brake, a full book, and the per-name risk cap that sizes
 *      down rather than refusing.
 */
import { DEFAULTS, planEntry, freshState } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/* THE BRACKET, as the plan specifies it: a 15% stop and a 30% target. Everything the
   fixture claims about it is DERIVED from the engine's own cost model, so a change to
   costPct moves the expectation instead of falsifying the test. */
const STOP_FRAC = 0.15, TARGET_FRAC = 0.30;
const call = { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - STOP_FRAC, target: 1 + TARGET_FRAC };
const cost = DEFAULTS.costPct;
const R_NET = (TARGET_FRAC - cost) / (STOP_FRAC + cost);
const W_MIN = 1 / (1 + R_NET);
const EQUITY = 5;
const st = (o = {}) => ({ ...freshState(0), equitySol: EQUITY, spendableSol: EQUITY, ...o });
const KELLY = { ...DEFAULTS, fixedSol: 0 };          // the fund off: Kelly sizes
const FIXED = DEFAULTS;                              // the owner's default: 0.4 SOL ceiling

/* 40% OF 12 TRADES IS 4.8 TRADES, so the plan's "n=12, W=40%" is not a seed that exists.
   The two nearest honest ones are used instead and BOTH are asserted to sit under W_min:
   the sample at exactly nMin, and the hit rate at exactly 40%. */
const SEEDS = [
  ["n = nMin exactly", { wins: 5, losses: 7 }],
  ["W = 40% exactly", { wins: 8, losses: 12 }],
];
const rateOf = (s) => s.wins / (s.wins + s.losses);

console.log("\nTHE FIXTURE'S OWN ARITHMETIC, BEFORE IT PROVES ANYTHING");
console.log(`  bracket ${(STOP_FRAC * 100).toFixed(0)}% stop / ${(TARGET_FRAC * 100).toFixed(0)}% target,` +
  ` round-trip cost ${(cost * 100).toFixed(0)}%  ->  R_net ${R_NET.toFixed(4)}, W_min ${(W_MIN * 100).toFixed(2)}%`);
ok("the bracket needs the W_min the plan measured", Math.abs(W_MIN - 0.4667) < 5e-4,
  `W_min ${(W_MIN * 100).toFixed(2)}%`);
for (const [label, seed] of SEEDS) {
  const n = seed.wins + seed.losses;
  ok(`precondition: ${label} arms Kelly and sits UNDER W_min`,
    n >= DEFAULTS.nMin && rateOf(seed) < W_MIN,
    `n=${n} (nMin ${DEFAULTS.nMin}), W ${(rateOf(seed) * 100).toFixed(2)}% < W_min ${(W_MIN * 100).toFixed(2)}%`);
}

console.log("\n1. WITH THE FUND OFF, THE GATE STILL REFUSES — NOTHING WAS REMOVED");
for (const [label, seed] of SEEDS) {
  const p = planEntry({ call, cfg: KELLY, state: st(seed) });
  ok(`${label}: skipped where Kelly actually sizes`,
    p.action === "skip" && /hit rate \d+% is under the \d+% this bracket needs/.test(p.reason),
    `W ${(rateOf(seed) * 100).toFixed(2)}%, W_min ${(W_MIN * 100).toFixed(2)}% — ${p.reason}`);
}

console.log("\n2. WITH THE FUND ON, THE TRADE IS TAKEN — AT THE OPERATOR'S OWN NUMBER");
const taken = [];
for (const [label, seed] of SEEDS) {
  const p = planEntry({ call, cfg: FIXED, state: st(seed) });
  taken.push(p);
  ok(`${label}: bought`, p.action === "buy",
    `W ${(rateOf(seed) * 100).toFixed(2)}%, W_min ${(p.wMin * 100).toFixed(2)}%, R_net ${p.rNet.toFixed(4)}, ` +
    `estimatedF ${p.estimatedF}, f ${(p.f * 100).toFixed(3)}%, ${p.sol} SOL — ${p.reason}`);
  ok("...sized by the operator ceiling, not by Kelly",
    Math.abs(p.sol - FIXED.fixedSol) < 1e-12 && /operator ceiling/.test(p.reason),
    `${p.sol} SOL vs fixedSol ${FIXED.fixedSol}`);
  ok("...and Kelly's own answer is recorded as the zero it was",
    p.estimatedF === 0, `estimatedF ${p.estimatedF} — the honest record that Kelly declined to size`);
  ok("...while the actual risk taken is still inside the per-name cap",
    p.f <= FIXED.fNameMax + 1e-9,
    `actual stop risk ${(p.f * 100).toFixed(3)}% of ${(FIXED.fNameMax * 100).toFixed(2)}%`);
}

/* THE POINT OF THE WHOLE CHANGE, stated as an equality: the gate decided WHETHER, and
   it never decided HOW MUCH. A hit rate well ABOVE W_min buys exactly the same SOL. */
const healthy = planEntry({ call, cfg: FIXED, state: st({ wins: 12, losses: 8 }) });
ok("a healthy hit rate buys the identical size, so the gate moved WHETHER and not HOW MUCH",
  healthy.action === "buy" && Math.abs(healthy.sol - taken[0].sol) < 1e-12 &&
    Math.abs(healthy.sol - taken[1].sol) < 1e-12 && rateOf({ wins: 12, losses: 8 }) > W_MIN,
  `W 60% -> ${healthy.sol} SOL; W ${(rateOf(SEEDS[1][1]) * 100).toFixed(0)}% -> ${taken[1].sol} SOL`);

console.log("\n3. EVERY OTHER REFUSAL STILL STANDS WITH THE FUND ON");
{
  /* Kelly's OTHER refusal — the one that does not depend on a sample at all. Derived:
     a target inside the round-trip cost makes R_net negative whatever costPct is. */
  const evDead = { ...call, target: 1 + cost / 2 };
  const p = planEntry({ call: evDead, cfg: FIXED, state: st(SEEDS[1][1]) });
  ok("a bracket whose costs eat the target is still refused",
    p.action === "skip" && /costs eat the target/.test(p.reason), p.reason);
}
{
  const p = planEntry({ call: { ...call, stop: null }, cfg: FIXED, state: st(SEEDS[1][1]) });
  ok("a call with no stop is still refused", p.action === "skip" && /no stop/.test(p.reason), p.reason);
}
{
  /* Derived from the brake itself: exactly the share of equity the config brakes at, on
     a bankroll small enough that the PERCENTAGE is the tighter of the two brakes — so
     this asserts the 20%-of-equity rule and not the absolute cap standing in for it. */
  const EQ_BRAKE = Math.abs(FIXED.dailyLossLimitSol) / FIXED.dailyLossPctOfEquity / 2;
  const lost = -(FIXED.dailyLossPctOfEquity * EQ_BRAKE);
  const p = planEntry({ call, cfg: FIXED,
    state: st({ ...SEEDS[1][1], equitySol: EQ_BRAKE, spendableSol: EQ_BRAKE, realizedTodaySol: lost }) });
  ok("the 20%-of-equity daily loss brake still refuses",
    p.action === "skip" && /realized-loss entry brake/.test(p.reason) &&
      new RegExp(`${(FIXED.dailyLossPctOfEquity * 100).toFixed(0)}% of a`).test(p.reason),
    `lost ${lost.toFixed(4)} of a ${EQ_BRAKE.toFixed(4)} SOL bankroll — ${p.reason}`);
}
{
  const p = planEntry({ call, cfg: FIXED, state: st({ ...SEEDS[1][1], bookHeat: FIXED.bookHeatMax }) });
  ok("a fully heated book still refuses",
    p.action === "skip" && /book heat/.test(p.reason),
    `heat ${(FIXED.bookHeatMax * 100).toFixed(0)}% of ${(FIXED.bookHeatMax * 100).toFixed(0)}% — ${p.reason}`);
}
{
  /* The live 0.3366 SOL burner: the 0.4 SOL ceiling cannot fit inside a 2.5% per-name
     risk cap on that wallet, so the rail SIZES IT DOWN — it does not wave it through. */
  const WALLET = 0.3366;
  const p = planEntry({ call, cfg: FIXED, state: st({ ...SEEDS[1][1], equitySol: WALLET, spendableSol: WALLET }) });
  const room = (FIXED.fNameMax * WALLET) / STOP_FRAC;
  ok("the per-name risk cap still binds on a small wallet",
    p.action === "buy" && p.sol < FIXED.fixedSol && Math.abs(p.sol - room) < 1e-9 &&
      p.f <= FIXED.fNameMax + 1e-9 && /per-name risk cap/.test(p.boundBy || ""),
    `${p.sol.toFixed(6)} SOL of a ${FIXED.fixedSol} ceiling on a ${WALLET} SOL wallet ` +
    `(room ${room.toFixed(6)}), actual stop risk ${(p.f * 100).toFixed(3)}% — bound by ${p.boundBy}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
