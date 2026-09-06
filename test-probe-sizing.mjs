/**
 * THE PROBE SIZE AND THE CAP THAT MAKES LOWERING IT SAFE.
 *
 * Measured 2026-09-07, and the reason this file exists: cfg.targetSizeUsd was $75. That
 * one number is the notional the exit probe measures the round trip at, an absolute
 * ceiling on position_size_usd in risk-rails.js, AND — through compliance.js — the
 * source of the minimum stop distance every coin must carry. At $75 the derived floor
 * was 11.93% while the desk's own median published stop across 57 calls is 11.50%: the
 * desk was below its own bar and live candidates were being withheld with
 * "edge_below_cost, stop_inside_costs".
 *
 * It was pricing an exit nobody pays. The floor's configured fixed_sol is 0.4 SOL
 * (~$41), the executor's hard ceiling is OPERATOR_MAX.maxSolPerTrade = 0.05 SOL
 * (~$5.17), and the last two live buys were 0.0175 SOL (~$1.81) and 0.021 SOL (~$2.20).
 *
 * Lowering the probe ALONE would have been worse than leaving it: the desk would then
 * authorise a 0.4 SOL delivery it had only proved it could exit $15 of. The two halves
 * are tested together here, and so is the safety property the change must not weaken —
 * a stop inside its costs is still a veto, not a preference.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/probe-sizing-test.db";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.env.CLAUDE_CO_DB.startsWith("/tmp/probe-sizing")) { /* runner sandbox */ }
else { try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {} }

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const copy = await import("./src/copy.js");
const db = (await import("./src/lib/store.js")).default;
const { cfg } = await import("./src/config.js");
const { stopFloorForCoin } = await import("./src/agents/decision.js");
const { complianceCheck } = await import("./src/agents/compliance.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 12;
copy.settingsFor(FLOOR);                       // materialise the row
const setFloor = (patch) => copy.saveSettings(FLOOR, patch);

/* A call whose desk-authored size is a tiny fraction of the paper book — the ordinary
   shape. The team's book allocation is deliberately generous here so that the PROBE cap
   is the thing under test rather than the allocation cap. */
const call = {
  id: 1, mint: "M", symbol: "PROBE", category: "memecoin", launchpad: "pump.fun",
  conviction: 80, entry_ref: 0.001, stop: 0.00088, target: 0.0014,
  liq_at_call: 200_000, mcap_at_call: 900_000,
  desk_size_usd: 15, desk_equity_usd: 100,     // 15% of book: never the binding cap below
};

console.log("\nTHE PROBE SIZE IS $15 AND STAYS ENV-OVERRIDABLE");
ok("cfg.targetSizeUsd defaults to 15", cfg.targetSizeUsd === 15, `$${cfg.targetSizeUsd}`);
/* Read in a CHILD process: cfg is frozen at import, so an in-process env poke would
   prove nothing about the number production actually boots with. */
const child = spawnSync(process.execPath,
  ["-e", "import('./src/config.js').then(m => console.log('TARGET=' + m.cfg.targetSizeUsd))"],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, DESK_TARGET_SIZE_USD: "42" }, timeout: 60_000 });
ok("DESK_TARGET_SIZE_USD overrides it", /TARGET=42\b/.test(child.stdout || ""),
  (child.stdout || child.stderr || "").trim().split("\n").pop());

console.log("\nA DELIVERY IS NEVER LARGER THAN THE PROBE PROVED EXITABLE");
const capInfo = copy.probeSizeCapSol();
console.log(`  probe $${capInfo.targetSizeUsd} at SOL $${capInfo.solUsd} (${capInfo.source}) ` +
  `= ${capInfo.capSol} SOL`);
ok("the cap is the probed notional converted to SOL",
  capInfo.known && Math.abs(capInfo.capSol - Math.floor((cfg.targetSizeUsd / capInfo.solUsd) * 1e4) / 1e4) < 1e-9,
  `${capInfo.capSol} SOL`);

// The house floor's real setting on 2026-09-07: 0.4 SOL, about $41.
setFloor({ appetite: "aggressive", bankrollSol: 2, fixedSol: 0.4 });
const capped = copy.decide(FLOOR, call);
ok("a 0.4 SOL fixed size is delivered at the cap, not at 0.4",
  capped.verdict === "offered" && capped.sizeSol === capInfo.capSol,
  `${capped.sizeSol} SOL (asked 0.4)`);
ok("...and the delivery SAYS the probe capped it",
  /exit probe measures a round trip at \$15/.test(capped.reason || "") &&
  /You set 0\.4 SOL/.test(capped.reason || ""),
  capped.reason);
ok("...and the cap is machine-readable, not only prose",
  capped.probeCapBinds === true && capped.probeCapSol === capInfo.capSol,
  `probeCapBinds=${capped.probeCapBinds} probeCapSol=${capped.probeCapSol}`);

console.log("\nA DELIVERY ALREADY UNDER THE CAP IS UNTOUCHED");
setFloor({ fixedSol: 0.05 });                  // ~$5.15, the executor's own hard ceiling
const under = copy.decide(FLOOR, call);
ok("0.05 SOL is delivered as 0.05 SOL", under.verdict === "offered" && under.sizeSol === 0.05,
  `${under.sizeSol} SOL`);
ok("...with no cap note attached", !/exit probe measures/.test(under.reason || "") &&
  under.probeCapBinds === false, under.reason);

console.log("\nTHE CAP ONLY EVER LOWERS A SIZE");
/* The bug this guards against is a "cap" implemented as an assignment: a floor asking
   for 0.03 SOL must not be handed 0.1456 because that is what the probe allows. */
let raised = [];
for (const asked of [0.02, 0.03, 0.05, 0.1, 0.1456, 0.2, 0.4, 1.5]) {
  setFloor({ bankrollSol: 5, fixedSol: asked });
  const d = copy.decide(FLOOR, call);
  if (d.verdict !== "offered" || d.sizeSol > asked + 1e-9) raised.push(`${asked}->${d.sizeSol}`);
}
ok("no asked-for size is ever raised by the cap", raised.length === 0,
  raised.length ? raised.join(", ") : "0.02 / 0.03 / 0.05 / 0.1 / 0.1456 / 0.2 / 0.4 / 1.5 SOL all <= asked");

console.log("\nTHE MISMATCH IS VISIBLE, NOT ONLY IN A CODE READING");
setFloor({ bankrollSol: 2, fixedSol: 0.4 });
const mismatch = copy.probeSizingMismatch();
ok("a floor asking for more than the probe measured is surfaced",
  mismatch.floorsOverProbe.some((f) => f.floorNo === FLOOR && f.fixedSol === 0.4),
  JSON.stringify(mismatch.floorsOverProbe));
ok("...with the dollar figure the operator can compare", mismatch.note.includes("$15"), mismatch.note);

console.log("\nTHE STOP FLOOR THIS BUYS BACK");
/* Shrek's measured anchor: a 2.55% round trip at $75. The cost is taken to scale
   linearly with probe size, so the same coin probed at $15 costs 0.51%. The floor is
   computed by the REAL stopFloorForCoin against the REAL cfg — the ruler production
   checks against, not a re-derivation of it. */
const rt75 = 2.55, rt15 = rt75 * (15 / 75);
const floor75 = stopFloorForCoin({ exitProbe: { roundTripLossPct: rt75 } }, cfg);
const floor15 = stopFloorForCoin({ exitProbe: { roundTripLossPct: rt15 } }, cfg);
console.log(`  Shrek: round trip ${rt75}% at $75 -> stop floor ${floor75.toFixed(2)}%`);
console.log(`         round trip ${rt15.toFixed(2)}% at $15 -> stop floor ${floor15.toFixed(2)}%`);
console.log(`  the desk's median published stop across its live feed is 11.50%`);
ok("the floor derived at $15 is lower than at $75", floor15 < floor75,
  `${floor15.toFixed(2)}% < ${floor75.toFixed(2)}%`);
ok("...and 11.50% now clears it, where at $75 it did not",
  11.5 >= floor15 && 11.5 < floor75,
  `median 11.50% vs floor15 ${floor15.toFixed(2)}% / floor75 ${floor75.toFixed(2)}%`);

console.log("\nTHE SAFETY VETO SURVIVED: A STOP INSIDE ITS COSTS IS STILL REFUSED");
/* The property that must NOT have become waivable. This veto exists because the
   executor refused four consecutive live calls on 2026-09-03 (HeeHaw, TOAD, USWS)
   whose stops sat inside the round trip. A cheaper probe lowers the bar; it must not
   remove it. */
const px = 0.001;
/* rtPct null means the coin was NOT probed — and the exitProbe key is then absent
   rather than null, because compliance reads Number(rt) and Number(null) is 0, a
   finite "measured 0%" that would quietly derive a floor instead of falling back to
   the flat one. The unmeasured case has to be built the way evidence.js builds it. */
const checkAt = (stopPct, rtPct) => {
  const stop = px * (1 - stopPct / 100);
  const size = 15;
  const loss = size * (stopPct / 100 + (rtPct == null ? 0 : rtPct / 100));
  return complianceCheck({
    pm: { decision: "PROPOSE", how_red_team_was_answered: "answered" },
    redteam: { verdict: "survives" },
    risk: { position_size_usd: size, max_loss_usd: Number(loss.toFixed(4)), stop_price: stop },
    ticket: {
      entry_zone_low: px, entry_zone_high: px * 1.02, stop_price: stop,
      take_profit: [{ price: px * 1.5, pct_to_sell: 100 }],
      max_slippage_bps: 300,
    },
    ev: { pair: { priceUsd: px },
      exitProbe: rtPct == null ? { targetSizeUsd: cfg.targetSizeUsd, error: "unprobed" }
                               : { roundTripLossPct: rtPct } },
  });
};
const tooTight = checkAt(3, rt15);             // 3% stop against a 0.51% round trip
const insideCosts = tooTight.violations.find((x) => x.code === "stop_inside_costs");
ok("a 3% stop is still vetoed at the cheaper $15 probe",
  tooTight.pass === false && !!insideCosts, insideCosts?.detail || JSON.stringify(tooTight.violations));
ok("...as a VIOLATION, never a warning that can be argued past",
  !tooTight.warnings.some((x) => x.code === "stop_inside_costs"),
  `warnings: ${tooTight.warnings.map((x) => x.code).join(",") || "none"}`);
const roomy = checkAt(15, rt15);               // 15% stop, comfortably outside the costs
ok("a 15% stop clears the same check", !roomy.violations.some((x) => x.code === "stop_inside_costs"),
  roomy.violations.map((x) => x.code).join(",") || "no violations");
/* And the flat fallback is untouched: an UNMEASURED coin still faces cfg.minStopDistancePct.
   Moving that 12 would have changed nothing for a coin that probed (compliance.js:132,
   requiredPct = derivedPct ?? floorPct) and everything for one that did not. */
ok("the unmeasured-coin fallback is still 12%", cfg.minStopDistancePct === 12, `${cfg.minStopDistancePct}%`);
const unmeasured = checkAt(9, null);
ok("...and an unmeasured coin with a 9% stop is still refused by it",
  unmeasured.violations.some((x) => x.code === "stop_inside_costs" && /flat floor/.test(x.detail)),
  unmeasured.violations.find((x) => x.code === "stop_inside_costs")?.detail || "no veto");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
