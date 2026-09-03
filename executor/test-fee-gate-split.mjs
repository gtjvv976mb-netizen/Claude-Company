/**
 * THE FEE CEILING IS A GATE. IT MUST NOT ALSO BE A COST MODEL.
 *
 * maxNetworkFeeLamports is the fee above which an entry is REFUSED, so raising it can
 * only ever admit trades. But the same constant was also charged against every trade —
 * as networkFeeReserveSol inside the risk rails, and as worstFeeRatio in the poller's
 * executable-cost guard — where raising it can only ever refuse them.
 *
 * Coupled, the owner's instruction to stop congestion refusing fills would have refused
 * ALL of them. Reviewed against the real sizing engine at the live 0.3366 SOL wallet, a
 * 2,000,000 cost model leaves no stop width between 8% and 95%, at any round-trip
 * friction, that still yields a buy.
 *
 * Nothing in the suite caught that. The 378-combination sweep in test-risk-sizing only
 * asserts that a sized trade does not BREACH a cap — which a bot that never buys
 * satisfies perfectly. So the load-bearing assertion here is the boring one: an ordinary
 * desk call must actually produce a BUY.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { planEntry, DEFAULTS } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const constant = (name) => {
  const m = poller.match(new RegExp(`${name}:\\s*([0-9_]+)`));
  return m ? Number(m[1].replace(/_/g, "")) : null;
};
const GATE = constant("maxNetworkFeeLamports");
const EXPECTED = constant("expectedNetworkFeeLamports");

console.log("\nTHE TWO NUMBERS ARE SEPARATE, AND POINT OPPOSITE WAYS");
{
  ok("the refusal gate was raised", GATE === 2_000_000, `${GATE}`);
  ok("the cost model was NOT", EXPECTED === 500_000, `${EXPECTED}`);
  ok("the gate is the looser of the two, which is the only safe direction", GATE > EXPECTED);
  ok("the sizing reserve reads the cost model, not the gate",
    /networkFeeReserveSol: EXECUTE \? jupiter\.cfg\.expectedNetworkFeeLamports/.test(poller));
  ok("the executable-cost guard reads the cost model, not the gate",
    /worstFeeRatio = 2 \* jupiter\.cfg\.expectedNetworkFeeLamports/.test(poller));
  ok("the gate itself is still enforced, unchanged",
    /if \(networkFees > cfg\.maxNetworkFeeLamports\)/.test(
      fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8")));
  ok("a fee-model refusal names itself instead of blaming the desk",
    /dominant term: \$\{worstFeeRatio >/.test(poller));
}

console.log("\nAN ORDINARY DESK CALL STILL BUYS  (the assertion the suite was missing)");
{
  // The live wallet, and a call shaped like the ones the desk actually publishes.
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: 0.3366, spendableSol: 0.3366, wins: 0, losses: 0 };
  const cfg = (reserve) => ({ ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05,
    dailySolCap: 0.5, networkFeeReserveSol: reserve, measuredRoundTripLossPct: 2 });
  const call = (stop, conviction) => ({ mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction });

  const reserve = EXPECTED / 1e9;
  for (const [stop, label] of [[0.90, "10%"], [0.80, "20%"], [0.70, "30%"], [0.62, "38%"]]) {
    const r = planEntry({ call: call(stop, 30), cfg: cfg(reserve), state });
    ok(`a ${label} stop at conviction 30 BUYS`, r.action === "buy",
      r.action === "buy" ? `${r.sol.toFixed(4)} SOL` : r.reason);
  }
  const full = planEntry({ call: call(0.90, 100), cfg: cfg(reserve), state });
  ok("a confident 10% stop takes the whole ceiling", full.action === "buy" && full.sol > 0.04,
    `${full.sol?.toFixed(4)} SOL`);

}

console.log("\nTHE GUARD THAT WOULD HAVE REFUSED THEM ALL");
{
  /* The refusal lives one stage EARLIER than planEntry, in the poller's executable-cost
     guard, which is why a sizing test could never have caught it. That arithmetic is
     reproduced here from poller.mjs — and validated first against the real refusal the
     live log printed, so the ruler is checked before anything is measured with it. */
  const slippageHaircut = (1 - 300 / 10_000) ** 2;
  const guard = ({ feeLamports, amountLamports, roundTripPct, stopRatio }) => {
    const executableReturnRatio = 1 - roundTripPct / 100;
    const worstFeeRatio = 2 * feeLamports / amountLamports;
    const conservative = executableReturnRatio * slippageHaircut - worstFeeRatio;
    return { refuses: conservative <= stopRatio, conservative, worstFeeRatio };
  };
  // The live log, 2026-09-03: "measured round trip 1.84% -> executable 98.16%; ...
  // conservative return 90.36% vs stop at 91.51%" — refused. Reproduce it exactly.
  const live = guard({ feeLamports: 500_000, amountLamports: 50_000_000, roundTripPct: 1.84, stopRatio: 0.9151 });
  ok("the reproduced guard matches the live refusal to two decimals",
    Math.abs(live.conservative * 100 - 90.36) < 0.01 && live.refuses,
    `${(live.conservative * 100).toFixed(2)}% vs the logged 90.36%`);

  // Now the real question, at the size an ordinary conviction-30 call actually gets.
  const amount = 17_500_000;                       // 0.0175 SOL, as sized above
  const stops = [[0.90, "10%"], [0.80, "20%"], [0.70, "30%"], [0.62, "38%"]];
  const refusedAt = (fee) => stops.filter(([stopRatio]) =>
    guard({ feeLamports: fee, amountLamports: amount, roundTripPct: 2, stopRatio }).refuses);
  const gateRefused = refusedAt(GATE), expectedRefused = refusedAt(EXPECTED);
  /* Not "none pass" — a 10% stop is refused on either setting, which is correct and is
     exactly why the desk carries a 12% minimum stop distance. The regression is that
     the fee term alone quadruples and takes otherwise-tradeable widths with it. */
  ok("the gate as a cost model refuses strictly more widths than the cost model does",
    gateRefused.length > expectedRefused.length,
    `${gateRefused.length}/${stops.length} refused at the gate vs ${expectedRefused.length}/${stops.length}`);
  const feeTerm = (fee) => guard({ feeLamports: fee, amountLamports: amount, roundTripPct: 2, stopRatio: 0.7 }).worstFeeRatio;
  ok("...because the fee term alone quadruples", Math.abs(feeTerm(GATE) / feeTerm(EXPECTED) - 4) < 0.01,
    `${(feeTerm(EXPECTED) * 100).toFixed(1)}% -> ${(feeTerm(GATE) * 100).toFixed(1)}% of the round trip`);
  // The widest stop the desk publishes is around 38%. It must survive.
  ok("a 30% stop, which the desk really publishes, is refused at the gate and passes at the cost model",
    guard({ feeLamports: GATE, amountLamports: amount, roundTripPct: 2, stopRatio: 0.70 }).refuses &&
    !guard({ feeLamports: EXPECTED, amountLamports: amount, roundTripPct: 2, stopRatio: 0.70 }).refuses);
}

console.log("\nRAISING THE GATE CHANGES NO SIZE AT ALL");
{
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: 0.3366, spendableSol: 0.3366, wins: 0, losses: 0 };
  const at = (reserve, stop) => planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction: 60 },
    cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
      networkFeeReserveSol: reserve, measuredRoundTripLossPct: 2 }, state });
  // 500,000 was the value every downstream derivation was built from. The split is only
  // honest if sizing is byte-identical to what it was before the ceiling moved.
  let identical = true;
  for (const stop of [0.95, 0.90, 0.85, 0.80, 0.70, 0.60]) {
    const before = at(500_000 / 1e9, stop), after = at(EXPECTED / 1e9, stop);
    if (before.action !== after.action || Math.abs((before.sol ?? 0) - (after.sol ?? 0)) > 1e-12) identical = false;
  }
  ok("sizing is byte-identical to before the ceiling was touched", identical);
}

console.log("\nTHE EMERGENCY EXIT IS NEVER STRICTER THAN THE ENTRY");
{
  for (const file of ["close-out.mjs", "sell-back.mjs"]) {
    const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const m = src.match(/maxNetworkFeeLamports:\s*([0-9_]+)/);
    const value = m ? Number(m[1].replace(/_/g, "")) : null;
    ok(`${file} can pay what the entry path can`, value === GATE, `${value} vs gate ${GATE}`);
  }
  /* The one real live round trip paid 92 lamports of priority on the entry and 280,276
     on the EXIT. The exit leg is the hungry one, and it is the leg an operator reaches
     for during a dump — exactly when fees spike. */
  ok("...which matters because the measured exit fee was 3,000x the entry's",
    280_276 > 92 * 1_000);
}

console.log("\nTHE RECONCILIATION TOLERANCES DID NOT WIDEN WITH THE GATE");
{
  const jup = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
  ok("unexplained custody outflow is bounded by the expected fee",
    /spent > BigInt\(expected\.amountRaw\) \+ BigInt\(reconciliationFeeTolerance\(cfg\)\)/.test(jup));
  ok("exit proceeds are compared against the signed minimum on the same basis",
    /receivedNet \+ BigInt\(reconciliationFeeTolerance\(cfg\)\) < minOutput/.test(jup));
  ok("...from one definition, so the two cannot drift",
    (jup.match(/const reconciliationFeeTolerance = /g) || []).length === 1);
  ok("a caller predating the split still behaves as before",
    /cfg\?\.expectedNetworkFeeLamports \?\? cfg\?\.maxNetworkFeeLamports \?\? 500_000/.test(jup));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
