/**
 * A STOP INSIDE THE ROUND TRIP IS A LOSS THE DESK HAS ALREADY BOOKED.
 *
 * On 2026-09-03 the bot refused four consecutive live calls — HeeHaw, TOAD, USWS and a
 * second HeeHaw — with the same sentence: "entry round trip plus worst-case fees is
 * already at/below the authored stop". Their stops sat 5% to 6.5% below entry against a
 * conservative cost near 9%: the executor applies its slippage tolerance to BOTH legs
 * (1 - 0.97^2 = 5.91% at 300bps), adds a worst-case network fee near 2%, and pump.fun
 * takes about 1.25% a side on the small bands.
 *
 * So the desk was publishing trades its own bot could prove were already lost. The Risk
 * seat is told the floor and why, and this is the deterministic check behind that
 * request — a prompt asks, a gate decides.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { cfg } from "./src/config.js";
import { complianceCheck } from "./src/agents/compliance.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE FLOOR EXISTS AND CLEARS THE EXECUTOR'S OWN WORST CASE");
{
  const floor = Number(cfg.minStopDistancePct);
  ok("the desk states a minimum stop distance", floor > 0, `${floor}%`);
  /* The executor's arithmetic, reproduced: slippage on both legs, then fees. A floor
     that does not clear this refuses every call it lets through, one layer later. */
  const slippageHaircutPct = (1 - Math.pow(1 - 300 / 10_000, 2)) * 100;   // 5.91
  /* DERIVED, NOT TYPED. This was `const worstFeePct = 2.0` under a comment claiming to
     reproduce the executor's arithmetic — so the day the executor's fee assumption
     moved, this test would have gone on asserting a number that was no longer the
     executor's, and stayed green while the invariant it states became false. That is a
     failure this suite has been bitten by before: a fixture that hand-builds a world
     tests the logic and not the system.
     Read from the executor's SOURCE rather than imported, because importing poller.mjs
     boots the bot. `2 *` because the fee is paid on both legs, matching the executor's
     own worstFeeRatio, and the divisor is the live per-trade size the caps line
     reports. If either number moves in poller.mjs, this assertion moves with it. */
  const pollerSrc = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
  const expectedFeeLamports = Number(
    (pollerSrc.match(/expectedNetworkFeeLamports:\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  assert.ok(Number.isFinite(expectedFeeLamports),
    "could not read expectedNetworkFeeLamports out of executor/poller.mjs");
  const LIVE_TRADE_SOL = 0.05;
  const worstFeePct = 2 * expectedFeeLamports / (LIVE_TRADE_SOL * 1e9) * 100;
  ok("...and it clears slippage on both legs plus worst-case fees",
    floor > slippageHaircutPct + worstFeePct,
    `${floor}% > ${slippageHaircutPct.toFixed(2)}% + ${worstFeePct}%`);
  ok("...with room left for the measured round trip on top",
    floor - (slippageHaircutPct + worstFeePct) >= 2,
    `${(floor - slippageHaircutPct - worstFeePct).toFixed(2)}% of headroom`);
}

console.log("\nTHE FOUR LIVE REFUSALS WOULD NOW BE CAUGHT BEFORE PUBLICATION");
{
  const ticketFor = (stopPct) => ({
    entry_zone_low: 1, entry_zone_high: 1.02,
    stop_price: 1 - stopPct / 100,
    take_profit: [{ price: 1.3, pct_to_sell: 100 }],
    thesis: "t", invalidation: "the deployer sells",
  });
  const evFor = () => ({ symbol: "T", mint: "M", pair: { priceUsd: 1 },
    exitProbe: { ok: true, roundTripLossPct: 2 } });
  /* The fixture has to clear the checks BEFORE this one or it never reaches the gate
     under test — risk_arithmetic_mismatch fires first if max_loss_usd does not equal
     size x the stop distance. That is the point of asserting on the code, not on a
     count: an unrelated violation must not be able to masquerade as this one. */
  const codes = (stopPct) => {
    const size = 50;
    return complianceCheck({
      pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
      risk: { entry_price: 1, stop_price: 1 - stopPct / 100, position_size_usd: size,
        max_loss_usd: size * (stopPct / 100 + 0.02) },
      ticket: ticketFor(stopPct), ev: evFor(),
    }).violations.map((x) => x.code);
  };
  // The stops those four calls actually carried.
  for (const [name, stopPct] of [["HeeHaw", 5], ["TOAD", 5], ["USWS", 6.5]])
    ok(`${name}'s ${stopPct}% stop is refused as inside the costs`,
      codes(stopPct).includes("stop_inside_costs"), codes(stopPct).join(",") || "no violation");
  const wide = codes(25);
  ok("a 25% stop — ordinary for a coin that moves 20% in minutes — is not refused for this",
    !wide.includes("stop_inside_costs"), wide.join(",") || "clean");
  ok("...and neither is one exactly at the floor",
    !codes(Number(cfg.minStopDistancePct)).includes("stop_inside_costs"));
}

console.log("\nTHE SEAT THAT PICKS THE STOP IS TOLD, TOO");
{
  const src = fs.readFileSync(new URL("./src/agents/decision.js", import.meta.url), "utf8");
  ok("the Risk seat is given the floor", /minStopDistancePct/.test(src));
  ok("...and told what happens if the honest level is closer than it",
    /cannot be traded at this size on this desk/.test(src),
    "moving the level to fit is explicitly refused");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
