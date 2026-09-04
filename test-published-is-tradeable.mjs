/**
 * ANYTHING THE DESK PUBLISHES, THE BOT MUST BE ABLE TO TAKE.
 *
 * The owner's rule: every published call should be traded. Historically it was not —
 * measured against the desk's eight most recent published calls, the executor would have
 * taken ONE. Four carried stops of 5% to 8.5%, which 300bps of slippage makes
 * unreachable at any size; the rest failed once conviction had shrunk the position and
 * the fixed fee became a larger share of it.
 *
 * The fix is not to make the bot accept them. It is to stop the desk offering calls its
 * own bot can prove are already lost. This file is the contract between the two: sweep
 * the space of calls, and assert that COMPLIANCE and the EXECUTOR never disagree.
 *
 * A disagreement in one direction wastes the offer and teaches the tenant nothing. In
 * the other it means the desk is refusing calls the bot could have traded.
 */
import { complianceCheck } from "./src/agents/compliance.js";
import { stopFloorForCoin } from "./src/agents/decision.js";
import { cfg } from "./src/config.js";
import { planEntry, DEFAULTS } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const WALLET = 0.3366, FEE = 500_000;
const SLIP = (1 - (Number(cfg.executorSlippageBps) || 300) / 10_000) ** 2;
const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0 };

/** Would the desk publish this call? */
const publishes = (stopPct, rtPct) => {
  const res = complianceCheck({
    pm: { decision: "PROPOSE" }, risk: { stop_price: 1 - stopPct / 100 }, redteam: { verdict: "survived" },
    ticket: { stop_price: 1 - stopPct / 100, entry_zone_low: 1, take_profit: [] },
    ev: { exitProbe: { roundTripLossPct: rtPct } },
  });
  return !(res.violations || []).some((v) => v.code === "stop_inside_costs");
};

/** Would the executor take it? Sizing, then the poller's executable-cost guard. */
const takes = (stopPct, rtPct, conviction) => {
  const sized = planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop: 1 - stopPct / 100, target: 3, conviction },
    cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
      networkFeeReserveSol: FEE / 1e9, measuredRoundTripLossPct: rtPct }, state });
  if (sized.action !== "buy") return { taken: false, why: sized.reason };
  const conservative = (1 - rtPct / 100) * SLIP - 2 * FEE / (sized.sol * 1e9);
  return { taken: conservative > (1 - stopPct / 100), why: "cost guard", sol: sized.sol };
};

console.log("\nTHE CONTRACT: PUBLISHED IMPLIES TRADEABLE");
{
  const disagreements = [];
  let published = 0, checked = 0;
  for (let stopPct = 4; stopPct <= 40; stopPct += 0.5) {
    for (const rtPct of [0.2, 0.5, 1, 2, 3, 5, 8]) {
      for (const conviction of [20, 30, 50, 80, 100]) {
        checked++;
        const pubs = publishes(stopPct, rtPct);
        if (!pubs) continue;
        published++;
        const t = takes(stopPct, rtPct, conviction);
        if (!t.taken) disagreements.push(`stop ${stopPct}% rt ${rtPct}% conv ${conviction}: ${t.why}`);
      }
    }
  }
  /* TWO KINDS OF REFUSAL, AND ONLY ONE IS A BROKEN CONTRACT.
   *
   * A cost-model disagreement means the desk and the executor have drifted apart, and
   * every one of those is a call wasted. But a wallet that cannot fund the minimum
   * viable position is a money fact the desk cannot see when it publishes — it does not
   * know the tenant's balance. At 0.3366 SOL a 2.5% per-name cap on a wide-stop, rough
   * coin allows 0.0390 SOL where the viable floor is 0.0400, and no cost model can wish
   * that away. Those are counted and reported, not tolerated silently. */
  const walletBound = disagreements.filter((d) => /under the .* minimum/.test(d));
  const modelDisagreements = disagreements.filter((d) => !/under the .* minimum/.test(d));
  ok("no call is refused because the two cost models disagree",
    modelDisagreements.length === 0,
    modelDisagreements.length ? modelDisagreements.slice(0, 3).join(" | ")
      : `${published} publishable of ${checked} swept`);
  ok("...and any remaining refusal is the wallet, said plainly",
    walletBound.every((d) => /round trip is mostly fees/.test(d)),
    `${walletBound.length} of ${published} need a bigger bankroll than 0.3366 SOL`);
  ok("...and the desk does publish a useful range, not nothing",
    published > checked * 0.2, `${published} of ${checked} publishable`);
}

console.log("\nTHE DESK IS NOT REFUSING WHAT THE BOT COULD HAVE TAKEN");
{
  // The other direction: a call the executor would happily take must not be blocked.
  const missed = [];
  for (let stopPct = 4; stopPct <= 40; stopPct += 0.5) {
    for (const rtPct of [0.2, 1, 2, 5]) {
      if (publishes(stopPct, rtPct)) continue;
      // Blocked by the desk — would the bot have taken it at full conviction?
      if (takes(stopPct, rtPct, 100).taken) missed.push(`stop ${stopPct}% rt ${rtPct}%`);
    }
  }
  /* A THIN CONSERVATIVE BAND IS CORRECT, AND MUST STAY THIN.
   *
   * The desk cannot know what size the bot will pick — that depends on conviction, the
   * wallet and the book — so it must assume the WORST-case fee share the executor's fee
   * floor permits (2.5%), while the bot pays the actual share for the size it chose
   * (2.0% at the full ceiling). That half-point gap makes the desk refuse a narrow band
   * of stops the bot would have taken.
   *
   * Closing it by assuming the best case would invert the failure: the desk would
   * publish calls the bot then refuses, which is the waste this whole contract exists to
   * end. So the band is accepted and BOUNDED instead — if it ever grows, the two cost
   * models have drifted apart and that is worth knowing. */
  const widths = missed.map((m) => Number((m.match(/stop ([\d.]+)%/) || [])[1])).filter(Number.isFinite);
  const band = widths.length ? Math.max(...widths) - Math.min(...widths) : 0;
  /* THE BAND IS THE PRICE OF THE GUARANTEE, AND IT IS ONE-DIRECTIONAL.
   *
   * The desk must assume the WORST fee share the executor permits — the share at the
   * minimum viable size — because it cannot know the tenant's wallet, the book, or the
   * conviction the seats will land on. The bot, sizing at the ceiling on a confident
   * call, usually pays less. So there is a band of stops the desk refuses that the bot
   * would have taken at full conviction.
   *
   * That direction is the safe one and is chosen deliberately: closing it means
   * assuming the best case, which publishes calls the bot then refuses — the exact
   * waste this contract exists to end, pointed the other way. What matters is that it
   * stays bounded and one-directional, so drift between the two models still shows up
   * as a failure rather than as quiet lost opportunity. */
  ok("the band stays bounded",
    band <= 8, missed.length ? `${missed.length} points spanning ${band.toFixed(1)}pp: ${missed.slice(0, 3).join(", ")}` : "none");
  ok("...and sits near the floor rather than across the whole range",
    widths.every((w) => w <= 20), widths.length ? `widest blocked stop ${Math.max(...widths)}%` : "none");
}

console.log("\nTHE FOUR REAL CALLS THAT WERE WASTED ARE NOW REFUSED AT PUBLISH TIME");
{
  // HeeHaw 5%/2.26, TOAD 5%/1.09, USWS 6.5%/1.03, HeeHaw 8.5%/2.23 — all offered, all
  // refused by the bot, all wasted. And FWOG 13%/0.51, which it did take.
  for (const [name, stopPct, rt] of [["HeeHaw", 5, 2.26], ["TOAD", 5, 1.09], ["USWS", 6.5, 1.03], ["HeeHaw", 8.5, 2.23]])
    ok(`${name}'s ${stopPct}% stop is no longer published`, !publishes(stopPct, rt),
      `needs ${stopFloorForCoin({ exitProbe: { roundTripLossPct: rt } }, cfg).toFixed(1)}%`);
  ok("FWOG's 13% stop still is", publishes(13, 0.51));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
