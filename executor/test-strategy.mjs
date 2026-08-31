/**
 * Risk-engine test suite. `npm test` in this folder.
 * Every case here is a way a trading bot loses money by accident.
 */
import { DEFAULTS, POLICY_VERSION, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import { policyConfigForPosition, resolveTakeProfitRule } from "./trade-policy.mjs";
let pass=0, fail=0;
const t=(name,cond,got)=>{ cond?pass++:fail++; console.log(`${cond?"PASS":"FAIL"}  ${name}${cond?"":"  -> got "+JSON.stringify(got)}`); };
const call={ mint:"m", symbol:"T", size_sol:0.05, stop:0.62, target:1.9, ts:0 };
t("executor and server share snipe-v2", POLICY_VERSION === "snipe-v2", POLICY_VERSION);

// caps
let st=freshState(0); st.openCount=4;
t("max open positions blocks entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0); st.realizedTodaySol=-0.2;
t("daily loss limit blocks entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0); st.deployedTodaySol=0.4999;
t("daily deploy cap blocks entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0);
t("clean state allows entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="buy");
// The desk's number is now a CEILING, not the size. We size off risk-at-stop and
// take the smaller of the two, so an oversized call cannot inflate the position.
const big = planEntry({call:{...call,size_sol:5},cfg:DEFAULTS,state:freshState(0)});
t("an oversized desk call cannot inflate our size", big.sol <= DEFAULTS.maxSolPerTrade && big.sol > 0, big.sol);
t("size is risk-derived, not desk-derived", big.sol < 5, big.sol);
t("call with no stop is refused", planEntry({call:{...call,stop:null},cfg:DEFAULTS,state:freshState(0)}).action==="skip");

// stop
let p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("holds above stop", stepPosition({pos:p,mark:0.8,cfg:DEFAULTS}).action==="hold");
t("STOPS at the stop", stepPosition({pos:p,mark:0.61,cfg:DEFAULTS}).action==="sell");

// SNIPE-V2: both authored targets and the default 2x rule sell EVERYTHING.
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
const at2x=stepPosition({pos:p,mark:2.0,cfg:DEFAULTS});
t("2x sells the whole position (takeProfitX default)", at2x.action==="sell"&&at2x.fraction===1, at2x);
const atTarget=stepPosition({
  pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}), mark:1.9, cfg:DEFAULTS,
});
t("desk target sells the whole position", atTarget.action==="sell"&&atTarget.fraction===1&&/desk target/.test(atTarget.reason), atTarget);
const forcedScale=stepPosition({
  pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}), mark:1.9,
  cfg:{...DEFAULTS,scaleOutPct:0.5},
});
t("legacy scaleOutPct cannot re-enable partial exits", forcedScale.action==="sell"&&forcedScale.fraction===1, forcedScale);
const autoRule=resolveTakeProfitRule(0,DEFAULTS.takeProfitX);
t("auto persists shared 2x plus the authored target", autoRule.takeProfitX===2&&autoRule.honorDeskTarget===true, autoRule);
const explicitRule=resolveTakeProfitRule(10,DEFAULTS.takeProfitX);
p=openPosition({call,sol:0.05,fillPrice:1,cfg:{...DEFAULTS,...explicitRule}});
Object.assign(p,explicitRule);
// A JSON round trip mirrors the state-file restart boundary.
const restored=JSON.parse(JSON.stringify(p));
const explicit10=policyConfigForPosition(restored,DEFAULTS);
const throughDeskTarget=stepPosition({pos:restored,mark:2,cfg:explicit10});
t("explicit 10x overrides the authored target", throughDeskTarget.action==="hold", throughDeskTarget);
const atExplicit10=stepPosition({pos:restored,mark:10,cfg:explicit10});
t("explicit 10x exits in full at 10x", atExplicit10.action==="sell"&&atExplicit10.fraction===1, atExplicit10);

// Ratchets are price-triggered, independent of the authored target. A targetless
// position makes each arm observable without the target correctly closing it first.
const runner={...call,target:null};
p=openPosition({call:runner,sol:0.05,fillPrice:1,cfg:DEFAULTS});
stepPosition({pos:p,mark:1.34,cfg:DEFAULTS});
t("breakeven does not arm below 1.35x", p.stop===runner.stop, p.stop);
stepPosition({pos:p,mark:1.35,cfg:DEFAULTS});
t("breakeven arms at 1.35x", p.stop>=p.entry, p.stop);
t("breakeven ratchet fires on a full giveback",
  stepPosition({pos:p,mark:0.99,cfg:DEFAULTS}).action==="sell");

p=openPosition({call:runner,sol:0.05,fillPrice:1,cfg:DEFAULTS});
stepPosition({pos:p,mark:1.5,cfg:DEFAULTS});
t("25% trail arms at 1.5x", Math.abs(p.stop-1.5*(1-DEFAULTS.trailPct))<1e-9, p.stop);
stepPosition({pos:p,mark:1.8,cfg:DEFAULTS});
const before=p.stop;
stepPosition({pos:p,mark:1.6,cfg:DEFAULTS});
t("trail never loosens on a pullback", p.stop===before, p.stop);
t("ratcheted trail fires", stepPosition({pos:p,mark:p.stop-0.01,cfg:DEFAULTS}).action==="sell");

// desk exit wins
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("desk exit sells everything", stepPosition({pos:p,mark:9.9,deskExit:{code:"rug"},cfg:DEFAULTS}).fraction===1);
// unreadable mark must not be treated as zero
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("unreadable mark holds (never a false stop)", stepPosition({pos:p,mark:null,cfg:DEFAULTS}).action==="hold");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
