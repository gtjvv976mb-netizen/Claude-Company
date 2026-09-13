/**
 * ENTRY_MODE=take-every-call — the owner's instruction, and exactly what it does and does
 * not switch off.
 *
 * In this mode every published call is bought at the owner's FIXED_SOL. The EDGE rails —
 * R_net, the per-name risk cap, book heat, and the route's stop-floor cost check — become
 * advisory: reported in the plan's reason and the log, never a refusal. The MONEY rails
 * do not move: a call with no stop, the rolling 24h loss brake, the open-position count,
 * the daily deploy cap, the spendable balance and the minimum viable size still refuse.
 * The route's own caps (round-trip loss, price impact) are never advisory either.
 *
 * Every assertion prints what it measured, and every rule that must still refuse is
 * driven to refuse, because a mode that "takes everything" is exactly the mode where a
 * rail silently switched off costs the most.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, ENTRY_MODES, planEntry, freshState } from "./strategy.mjs";
import { sizeEntryToRoute } from "./entry-sizing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

/* A 3 SOL wallet, a 0.5 SOL fixed size, and a call whose stop is 20% away — the shape of
   the live install this mode was written for. */
const EQUITY = 3;
const state = (over = {}) => ({ ...freshState(0), equitySol: EQUITY, spendableSol: EQUITY, ...over });
const RISK = { ...DEFAULTS, fixedSol: 0.5, networkFeeReserveSol: 0.0005 };
const TAKE = { ...RISK, entryMode: "take-every-call" };
const call = (over = {}) => ({ mint: "m", symbol: "T", entry_ref: 1, stop: 0.8, target: 1.3, ...over });

section("1. THE MODE IS NAMED, AND OFF BY DEFAULT");
ok("ENTRY_MODES lists the two modes", JSON.stringify(ENTRY_MODES) === '["risk","take-every-call"]', JSON.stringify(ENTRY_MODES));
ok("the default is risk", DEFAULTS.entryMode === "risk", DEFAULTS.entryMode);

section("2. THE EDGE RAILS BECOME ADVISORY, AND SAY SO");
{
  /* Per-name risk: 0.5 SOL at a 20% stop on 3 SOL is a 3.4% stop risk, over the 2.5% cap.
     In risk mode the rail SIZES DOWN; in take-every-call the size is the owner's. */
  const risk = planEntry({ call: call(), cfg: RISK, state: state() });
  const take = planEntry({ call: call(), cfg: TAKE, state: state() });
  ok("risk mode sizes 0.5 SOL down under the per-name cap", risk.action === "buy" && risk.sol < 0.5 && /per-name risk cap/.test(risk.boundBy || ""),
    `${risk.sol.toFixed(4)} SOL, bound by ${risk.boundBy}`);
  ok("take-every-call buys the full 0.5 SOL", take.action === "buy" && take.sol === 0.5, `${take.sol} SOL`);
  ok("…and reports the risk it carries as an ADVISORY, by name",
    take.advisories.some((a) => /per-name cap/.test(a)) && /ADVISORY/.test(take.reason), take.reason);
  ok("…and the reason names the mode", /^take-every-call:/.test(take.reason));

  /* Costs eat the target: a 3% target against a 6% round trip is a negative R_net. */
  const thin = call({ target: 1.03 });
  const riskThin = planEntry({ call: thin, cfg: RISK, state: state() });
  const takeThin = planEntry({ call: thin, cfg: TAKE, state: state() });
  ok("risk mode refuses a call whose costs eat the target", riskThin.action === "skip" && /costs eat the target/.test(riskThin.reason), riskThin.reason);
  ok("take-every-call takes it and says the costs eat the target", takeThin.action === "buy" && takeThin.advisories.some((a) => /costs eat the target/.test(a)),
    takeThin.advisories.join("; "));

  /* Book heat: four 0.5 SOL positions already open at 20% stops is 13% heat; the fifth
     would breach 20% in risk mode. */
  const hot = state({ bookHeat: 0.19, openCount: 4 });
  const riskHot = planEntry({ call: call(), cfg: RISK, state: hot });
  const takeHot = planEntry({ call: call(), cfg: TAKE, state: hot });
  ok("risk mode shrinks the fifth position to the heat left", riskHot.action === "skip" || riskHot.sol < 0.5, `${riskHot.action} ${riskHot.sol ?? ""} ${riskHot.reason}`);
  ok("take-every-call buys the fifth at full size and warns about the heat",
    takeHot.action === "buy" && takeHot.sol === 0.5 && takeHot.advisories.some((a) => /book heat/.test(a)), takeHot.advisories.join("; "));
}

section("3. THE MONEY RAILS STILL REFUSE — EVERY ONE, DRIVEN TO REFUSE");
{
  const refuses = (name, args, re) => {
    const plan = planEntry(args);
    ok(name, plan.action === "skip" && re.test(plan.reason), `${plan.action}: ${plan.reason}`);
  };
  refuses("a call with no stop", { call: call({ stop: null }), cfg: TAKE, state: state() }, /no stop/);
  refuses("a stop at or above entry", { call: call({ stop: 1.0 }), cfg: TAKE, state: state() }, /at or above entry/);
  refuses("the rolling 24h loss brake", { call: call(), cfg: TAKE, state: state({ realizedTodaySol: -0.5 }) }, /realized-loss entry brake hit/);
  refuses("the open-position count", { call: call(), cfg: { ...TAKE, maxOpenPositions: 2 }, state: state({ openCount: 2 }) }, /already holding/);
  refuses("the daily deploy cap, when nothing is left", { call: call(), cfg: { ...TAKE, dailySolCap: 1 }, state: state({ deployedTodaySol: 0.999 }) }, /deploy cap|minimum/);
  refuses("the spendable balance", { call: call(), cfg: TAKE, state: state({ spendableSol: 0.001 }) }, /spendable|minimum/);
  const capped = planEntry({ call: call(), cfg: { ...TAKE, dailySolCap: 0.7 }, state: state({ deployedTodaySol: 0.4 }) });
  ok("the daily deploy cap still SIZES DOWN what is left", capped.action === "buy" && capped.sol < 0.5 && /deploy cap/.test(capped.boundBy || ""),
    `${capped.sol?.toFixed(4)} SOL bound by ${capped.boundBy}`);
  const ceiling = planEntry({ call: call(), cfg: { ...TAKE, maxSolPerTrade: 0.3 }, state: state() });
  ok("the per-trade ceiling still binds above the fixed size", ceiling.action === "buy" && ceiling.sol === 0.3, `${ceiling.sol} SOL`);
}

section("4. THE ROUTE'S STOP-FLOOR CHECK IS ADVISORY; THE ROUTE'S OWN CAPS ARE NOT");
{
  /* A probe whose reverse leg returns 97% of the input: a 3% round trip. Against a stop
     4% below entry, the conservative return (after a 3% slippage haircut each way and the
     fee model) sits below the stop — the exact refusal TripleT drew on 2026-09-13. */
  const probe = ({ refusal = null, rt = 3 } = {}) => async (amountRaw) => ({
    refusal, lossPct: rt, impactPct: 0.5,
    reverse: { outAmount: String(BigInt(amountRaw) * BigInt(Math.round((100 - rt) * 1000)) / 100_000n) },
  });
  const args = { sol: 0.5, lamportsPerSol: 1_000_000_000, stopRatio: 0.96, expectedNetworkFeeLamports: 500_000,
    slippageBps: 300, minSizeFor: () => 0.03 };
  const enforced = await sizeEntryToRoute({ ...args, probe: probe() });
  ok("enforced: the stop-floor refuses, down the whole ladder", enforced.ok === false && /at\/below the authored stop/.test(enforced.refusal),
    (enforced.refusal || "").slice(0, 90));
  const advisory = await sizeEntryToRoute({ ...args, probe: probe(), stopFloor: "advisory" });
  ok("advisory: the same route is taken at full size", advisory.ok === true && advisory.sol === 0.5, `${advisory.ok} ${advisory.sol}`);
  ok("…with the verdict carried as advisory text", typeof advisory.advisory === "string" && /at\/below the authored stop/.test(advisory.advisory),
    (advisory.advisory || "").slice(0, 90));
  const capped = await sizeEntryToRoute({ ...args, probe: probe({ refusal: "entry round-trip loss 14% exceeds cap 12%", rt: 14 }), stopFloor: "advisory" });
  ok("advisory does NOT lift the route's own caps: a 14% round trip is still refused", capped.ok === false && /exceeds cap/.test(capped.refusal),
    (capped.refusal || "").slice(0, 90));
  let threw = null;
  try { await sizeEntryToRoute({ ...args, probe: probe(), stopFloor: "off" }); } catch (e) { threw = e; }
  ok("an unknown stopFloor value throws rather than defaulting either way", threw instanceof Error && /stopFloor/.test(threw.message), threw?.message);
}

section("5. THE MODE IS ARMED BY A SENTENCE AND CARRIED THROUGH AN UPGRADE");
{
  const poller = fs.readFileSync(path.join(HERE, "poller.mjs"), "utf8");
  const runner = fs.readFileSync(path.join(HERE, "launchd-runner.mjs"), "utf8");
  const install = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");
  const health = fs.readFileSync(path.join(HERE, "heartbeat-health.mjs"), "utf8");
  ok("the poller refuses the mode without FIXED_SOL set explicitly", /take-every-call needs FIXED_SOL set explicitly/.test(poller));
  ok("the poller refuses the mode without the typed sentence", /ENTRY_MODE_ACK set to exactly/.test(poller) && /I take every published call on \$\{wallet\} at \$\{fixedSol\} SOL/.test(poller));
  ok("the poller hands the route ladder the advisory floor only in this mode",
    /stopFloor: CFG\.entryMode === "take-every-call" \? "advisory" : "enforce"/.test(poller));
  ok("the poller logs each advisory as WARN", /log\(`WARN \$\{ev\.symbol\}: \$\{note\}`\)/.test(poller) && /buying anyway \(ENTRY_MODE=take-every-call\)/.test(poller));
  ok("the runner allows the three env names", ["ENTRY_MODE", "ENTRY_MODE_ACK", "FIXED_SOL"].every((n) => new RegExp(`"${n}"`).test(runner)));
  ok("an upgrade carries the mode, the sentence and the size forward", /for dial in ENTRY_MODE ENTRY_MODE_ACK FIXED_SOL/.test(install));
  ok("…and the launch lane's arming lines with them", /SNIPE_LANE SNIPE_TICK_MS SNIPE_MAX_SOL_PER_TRADE SNIPE_DAILY_SOL_CAP SNIPE_LIVE_ACK/.test(install));
  ok("the heartbeat reports the mode so the board can say which bot it is", /entryMode: entryMode === "take-every-call" \? "take-every-call" : "risk"/.test(health));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
