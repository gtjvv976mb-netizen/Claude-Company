/**
 * Risk-engine test suite. `npm test` in this folder.
 * Every case here is a way a trading bot loses money by accident.
 */
import { DEFAULTS, POLICY_VERSION, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import { policyConfigForPosition, resolveTakeProfitRule, validateEntryReference } from "./trade-policy.mjs";
let pass=0, fail=0;
const t=(name,cond,got)=>{ cond?pass++:fail++; console.log(`${cond?"PASS":"FAIL"}  ${name}${cond?"":"  -> got "+JSON.stringify(got)}`); };
const call={ mint:"m", symbol:"T", size_sol:0.05, stop:0.62, target:1.9, ts:0 };
// v3: two-witness high-water ratchet (2026-09-01). v4: desk-led exits (2026-09-05) — the
// executor no longer runs the price policy on its own inputs. The pin is the tripwire
// that fired when the behavior changed - keep pinning the literal.
t("executor and server share desk-led-v4", POLICY_VERSION === "desk-led-v4", POLICY_VERSION);

// caps
/* The count is a sentinel now, not a policy — risk decides how many memecoins may run
   at once (owner's rule: several pump together, so a fixed count makes the desk late).
   What must stay true is that the sentinel, wherever it sits, still stops entry. */
let st=freshState(0); st.openCount=DEFAULTS.maxOpenPositions;
t("the open-position sentinel still blocks entry when reached", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0); st.openCount=DEFAULTS.maxOpenPositions-1;
t("...and one below it does not", planEntry({call,cfg:DEFAULTS,state:st}).action!=="skip");
st=freshState(0); st.realizedTodaySol=-0.2;
t("rolling 24h realized-loss brake blocks a later entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0); st.deployedTodaySol=0.4999;
t("rolling 24h deploy cap blocks entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="skip");
st=freshState(0);
t("clean state allows entry", planEntry({call,cfg:DEFAULTS,state:st}).action==="buy");
// The desk's number is now a CEILING, not the size. We size off risk-at-stop and
// take the smaller of the two, so an oversized call cannot inflate the position.
const big = planEntry({call:{...call,size_sol:5},cfg:DEFAULTS,state:freshState(0)});
t("an oversized desk call cannot inflate our size", big.sol <= DEFAULTS.maxSolPerTrade && big.sol > 0, big.sol);
t("size is risk-derived, not desk-derived", big.sol < 5, big.sol);
t("call with no stop is refused", planEntry({call:{...call,stop:null},cfg:DEFAULTS,state:freshState(0)}).action==="skip");

/* ── DESK-LED EXITS (2026-09-05) ──────────────────────────────────────────────
 * Every case below used to assert a SELL: the local stop, the 2x rule, the authored
 * target, the tenant's 10x dial, the breakeven and trail ratchets. Each was a bot-own
 * exit — the mechanism that sold Shrek (call 55) at 03:01:42Z on the bot's own
 * normalised stop at -13.5% while the desk's determined stop_hit came at 03:10:24Z.
 * The same marks now assert a HOLD: without a desk exit the bot has no exit. The
 * two properties kept are the ones a desk-led bot still needs — a desk exit sells
 * everything, and an unreadable mark never manufactures anything. */
let p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
const above=stepPosition({pos:p,mark:0.8,cfg:DEFAULTS});
t("holds above the stop", above.action==="hold", above);
const atStop=stepPosition({pos:p,mark:0.61,cfg:DEFAULTS});
t("HOLDS at the stop without a desk exit (the local stop is gone)", atStop.action==="hold", atStop);
t("...and says why", /desk-led/.test(atStop.reason), atStop.reason);
t("...and reports the policy version", atStop.policyVersion===POLICY_VERSION, atStop.policyVersion);

p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
const at2x=stepPosition({pos:p,mark:2.0,cfg:DEFAULTS});
t("2x HOLDS without a desk exit (no local take-profit)", at2x.action==="hold", at2x);
const atTarget=stepPosition({
  pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}), mark:1.9, cfg:DEFAULTS,
});
t("the authored target HOLDS without a desk exit (the desk fires target_hit, not the bot)", atTarget.action==="hold", atTarget);
const forcedScale=stepPosition({
  pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}), mark:1.9,
  cfg:{...DEFAULTS,scaleOutPct:0.5},
});
t("legacy scaleOutPct cannot produce a partial exit either", forcedScale.action==="hold"&&forcedScale.fraction!==0.5, forcedScale);
// The dial is still resolved and stored (the feed carries it, old journals hold it) —
// it just no longer changes the bot's exits.
const autoRule=resolveTakeProfitRule(0,DEFAULTS.takeProfitX);
t("auto still resolves to the shared 2x plus the authored target (stored, not acted on)", autoRule.takeProfitX===2&&autoRule.honorDeskTarget===true, autoRule);
const explicitRule=resolveTakeProfitRule(10,DEFAULTS.takeProfitX);
p=openPosition({call,sol:0.05,fillPrice:1,cfg:{...DEFAULTS,...explicitRule}});
Object.assign(p,explicitRule);
// A JSON round trip mirrors the state-file restart boundary.
const restored=JSON.parse(JSON.stringify(p));
const explicit10=policyConfigForPosition(restored,DEFAULTS);
t("the tenant's 10x survives a restart on the position", explicit10.takeProfitX===10&&explicit10.honorDeskTarget===false, explicit10);
const throughDeskTarget=stepPosition({pos:restored,mark:2,cfg:explicit10});
t("a 10x position holds at 2x", throughDeskTarget.action==="hold", throughDeskTarget);
const atExplicit10=stepPosition({pos:restored,mark:10,cfg:explicit10});
t("...and STILL holds at 10x — the dial no longer sells", atExplicit10.action==="hold", atExplicit10);

// The ratchets: fed the same two-witness sequences that used to arm and fire them.
const runner={...call,target:null};
p=openPosition({call:runner,sol:0.05,fillPrice:1,cfg:DEFAULTS});
for (const m of [1.35,1.35,1.5,1.5,1.8,1.8]) stepPosition({pos:p,mark:m,cfg:DEFAULTS});
t("a confirmed 1.35x/1.5x/1.8x run moves NO level on the position", p.stop===runner.stop&&p.high===1,
  `stop ${p.stop} (authored ${runner.stop}), high ${p.high}`);
const giveback=stepPosition({pos:p,mark:0.99,cfg:DEFAULTS});
t("a full giveback after the run holds (no breakeven ratchet)", giveback.action==="hold", giveback);
const trailFire=stepPosition({pos:p,mark:1.8*(1-DEFAULTS.trailPct)-0.01,cfg:DEFAULTS});
t("a 25% pullback from the high holds (no trail ratchet)", trailFire.action==="hold", trailFire);
p=openPosition({call:runner,sol:0.05,fillPrice:1,cfg:DEFAULTS});
stepPosition({pos:p,mark:1.1,cfg:DEFAULTS});
stepPosition({pos:p,mark:1.9,cfg:DEFAULTS});
const afterGlitch=stepPosition({pos:p,mark:1.1,cfg:DEFAULTS});
t("a lone spike still never arms a stop (there is no stop to arm)", p.stop===runner.stop&&afterGlitch.action==="hold",
  `stop ${p.stop}, ${afterGlitch.action}`);

// desk exit wins — KEPT: the desk's determination is unconditional and total.
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
const deskSell=stepPosition({pos:p,mark:9.9,deskExit:{code:"rug"},cfg:DEFAULTS});
t("desk exit sells everything", deskSell.action==="sell"&&deskSell.fraction===1, deskSell);
t("...with the desk's code in the reason", /desk exit: rug/.test(deskSell.reason), deskSell.reason);
const deskSellNoMark=stepPosition({pos:openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS}),mark:null,deskExit:{code:"stop_hit"},cfg:DEFAULTS});
t("a desk exit sells even with no readable mark", deskSellNoMark.action==="sell"&&deskSellNoMark.fraction===1, deskSellNoMark);
// unreadable mark must not be treated as zero — KEPT
p=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("unreadable mark holds (never a false stop)", stepPosition({pos:p,mark:null,cfg:DEFAULTS}).action==="hold");

// The desk's absolute levels ride on the position for the mirror.
const withDesk=openPosition({call:{...call,entry_ref:0.00035,deskStop:0.0003214,deskTarget:0.00044,opened_at:1_757_000_000_000,
  stop:0.865,target:1.2},sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("openPosition carries the desk's absolute levels beside the ratios",
  withDesk.deskEntryRef===0.00035&&withDesk.deskStop===0.0003214&&withDesk.deskTarget===0.00044&&withDesk.deskOpenedAt===1_757_000_000_000&&withDesk.stop===0.865,
  {deskEntryRef:withDesk.deskEntryRef,deskStop:withDesk.deskStop,deskTarget:withDesk.deskTarget,deskOpenedAt:withDesk.deskOpenedAt,stop:withDesk.stop});
const noDesk=openPosition({call,sol:0.05,fillPrice:1,cfg:DEFAULTS});
t("a call without desk levels carries nulls, never a ratio dressed as a level",
  noDesk.deskEntryRef===null&&noDesk.deskStop===null&&noDesk.deskTarget===null, noDesk);

const markNow = 1_000_000;
const freshEntry = { entry_ref: 1, entry_lo: 0.9, entry_hi: 1.1, stop: 0.8,
  target: 1.5, current_mark: 1.05, current_mark_at: markNow };
const reference = validateEntryReference(freshEntry, { nowMs: markNow });
t("entry bracket is normalized to the current monitored mark",
  Math.abs(reference.stopRatio - 0.8 / 1.05) < 1e-12, reference);
t("a stale-but-under-call-age 40% gap is refused before signing", (() => {
  try { validateEntryReference({ ...freshEntry, current_mark: 0.6 }, { nowMs: markNow }); return false; }
  catch (error) { return /outside authored entry zone|breached stop/.test(error.message); }
})());
t("an already-hit authored target is never bought", (() => {
  try { validateEntryReference({ ...freshEntry, current_mark: 1.5, entry_hi: 2 }, { nowMs: markNow }); return false; }
  catch (error) { return /already reached authored target/.test(error.message); }
})());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
