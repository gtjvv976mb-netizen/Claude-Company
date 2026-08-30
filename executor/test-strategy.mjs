/**
 * Risk-engine test suite. `npm test` in this folder.
 * Every case here is a way a trading bot loses money by accident.
 */
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
let pass=0, fail=0;
const t=(name,cond,got)=>{ cond?pass++:fail++; console.log(`${cond?"PASS":"FAIL"}  ${name}${cond?"":"  -> got "+JSON.stringify(got)}`); };
const call={ mint:"m", symbol:"T", size_sol:0.05, stop:0.62, target:1.9, ts:0 };

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

// SNIPE-HOLD-SELL — the default: 2x sells EVERYTHING, before the trail can arm
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
const at2x=stepPosition({pos:p,mark:2.0,cfg:DEFAULTS});
t("2x sells the whole position (takeProfitX default)", at2x.action==="sell"&&at2x.fraction===1, at2x);
t("just under 2x still holds",
  stepPosition({pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}),mark:1.99,cfg:DEFAULTS}).action==="hold");

// breakeven + trail — the RIDE path, opt-in via takeProfitX: 0
const RIDE={...DEFAULTS, takeProfitX:0};
p=openPosition({call,sol:0.05,fillPrice:1,cfg:RIDE});
const atTarget=stepPosition({pos:p,mark:2.0,cfg:RIDE});
t("target does NOT emit a zero-size swap", atTarget.action==="hold", atTarget);
t("stop lifted to breakeven-or-better at target", p.stop>=1, p.stop);
stepPosition({pos:p,mark:5.0,cfg:RIDE});
t("trail ratchets up behind the high", p.stop>=5.0*(1-RIDE.trailPct)-1e-9, p.stop);
const before=p.stop; stepPosition({pos:p,mark:3.0,cfg:RIDE});
t("trail never loosens on a pullback", p.stop===before, p.stop);
t("trailing stop fires", stepPosition({pos:p,mark:p.stop-0.01,cfg:RIDE}).action==="sell");

// desk exit wins
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("desk exit sells everything", stepPosition({pos:p,mark:9.9,deskExit:{code:"rug"},cfg:DEFAULTS}).fraction===1);
// unreadable mark must not be treated as zero
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("unreadable mark holds (never a false stop)", stepPosition({pos:p,mark:null,cfg:DEFAULTS}).action==="hold");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
