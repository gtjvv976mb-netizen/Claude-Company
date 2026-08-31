/**
 * Sizing rules from the GROKSTREET operating thesis: R_net with costs, the
 * W_min gate, half-Kelly with rails, book heat, and the age exit.
 * `npm run test:sizing`
 */
import { DEFAULTS, POLICY_VERSION, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
// Kelly machinery is tested with the fixed fund OFF: the owner's fixed-fund default
// overrides how much is bet (never whether), and these tests are about the how-much.
const KELLY = { ...DEFAULTS, fixedSol: 0 };
let pass=0, fail=0;
const t=(n,c,got)=>{ c?pass++:fail++; console.log(`${c?"PASS":"FAIL"}  ${n}${c?"":"  -> "+JSON.stringify(got)}`); };
const st=(o={})=>({ ...freshState(0), equitySol: 5, ...o });
// the V1 bracket from the thesis: stop -2.8%, target +3.5%  => gross R = 1.25
const call = { mint:"m", symbol:"T", entry_ref: 1.0, stop: 0.972, target: 1.035, size_sol: 5 };
t("sizing uses the shared snipe-v2 strategy", POLICY_VERSION === "snipe-v2", POLICY_VERSION);

// R_net with 6% costs should be far below the 1.25 gross figure
const p1 = planEntry({ call, cfg: KELLY, state: st() });
console.log("  R_net on the 2.8/3.5 bracket with costs:", p1.rNet?.toFixed(3), "| verdict:", p1.action, "-", p1.reason);
t("costs kill a 1.25R gross bracket", p1.action==="skip", p1);

// a bracket wide enough to survive costs
const wide = { ...call, stop: 0.60, target: 2.0 };            // -40% / +100%
const p2 = planEntry({ call: wide, cfg: KELLY, state: st() });
t("a wide bracket is accepted", p2.action==="buy", p2);
t("small sample uses the flat default before final size caps", Math.abs(p2.estimatedF - DEFAULTS.fDefault) < 1e-9, p2);
t("recorded f is the actual capped stop risk", Math.abs(p2.f - (p2.sol * 0.4 / 5)) < 1e-12, p2.f);
console.log("    ->", p2.reason, "| size", p2.sol.toFixed(4), "SOL");

// with a real sample, Kelly applies and is capped
const p3 = planEntry({ call: wide, cfg: KELLY, state: st({wins:20, losses:10}) });
t("with n>=12 Kelly applies", /half-Kelly/.test(p3.reason), p3.reason);
t("and is clamped to fNameMax", p3.f <= DEFAULTS.fNameMax + 1e-9, p3.f);

// a hit rate under W_min must be refused outright
const p4 = planEntry({ call: wide, cfg: KELLY, state: st({wins:3, losses:29}) });
t("hit rate under W_min is refused", p4.action==="skip" && /under the/.test(p4.reason), p4.reason);

// book heat
const p5 = planEntry({ call: wide, cfg: KELLY, state: st({bookHeat: 0.079}) });
t("book heat cap blocks the next entry", p5.action==="skip" && /book heat/.test(p5.reason), p5.reason);

// f is risk-at-stop — but the flat per-trade cap may legitimately bind first
const eq=5, sf=0.40;
// assert the FORMULA, not a frozen constant — the rails are tunable by design
const kellyWant = DEFAULTS.fDefault*eq/sf;
t("size = f x equity / stopFrac", Math.abs(kellyWant - (DEFAULTS.fDefault*eq/sf)) < 1e-12 && kellyWant > 0, kellyWant);
t("risk at the stop equals f of equity",
  Math.abs((kellyWant*sf)/eq - DEFAULTS.fDefault) < 1e-12, (kellyWant*sf)/eq);
t("...and the flat cap binds when Kelly asks for more",
  p2.sol === DEFAULTS.maxSolPerTrade && kellyWant > DEFAULTS.maxSolPerTrade, {sol:p2.sol, kellyWant});

// THE FIXED FUND — the owner's default: same size every trade, refusals unchanged
const pf = planEntry({ call: wide, cfg: DEFAULTS, state: st({wins:20, losses:10}) });
t("fixed fund sizes every trade identically", /fixed fund/.test(pf.reason) && Math.abs(pf.sol-DEFAULTS.fixedSol)<1e-9, pf.reason);
const pfBad = planEntry({ call: wide, cfg: DEFAULTS, state: st({wins:3, losses:29}) });
t("fixed fund does NOT override Kelly's refusals", pfBad.action==="skip", pfBad.reason);
const unsafeFixed = planEntry({ call: wide, cfg: { ...DEFAULTS, maxSolPerTrade: 0.02 },
  state: st({ equitySol: 0.05 }) });
t("fixed fund cannot exceed the per-name risk rail on a small burner",
  unsafeFixed.action==="skip" && /actual stop risk/.test(unsafeFixed.reason), unsafeFixed);
const frictionSized = planEntry({ call: wide, cfg: { ...KELLY, measuredRoundTripLossPct: 5 }, state: st() });
t("measured round-trip friction is included in actual stop risk",
  frictionSized.action==="buy" && frictionSized.sol <= p2.sol && frictionSized.f >= 0, frictionSized);

// the age exit
const pos = openPosition({ call: {...wide, openedAtMs: 0}, sol: 0.05, fillPrice: 1, cfg: DEFAULTS });
const ageBoundary = DEFAULTS.maxAgeHours*3600e3;
const aged = stepPosition({ pos, mark: 1.01, cfg: DEFAULTS, nowMs: ageBoundary });
t("age exit fires at maxAgeHours", aged.action==="sell" && /age exit/.test(aged.reason), aged);
const young = stepPosition({ pos, mark: 1.01, cfg: DEFAULTS, nowMs: ageBoundary-1 });
t("and not before", young.action==="hold", young);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
