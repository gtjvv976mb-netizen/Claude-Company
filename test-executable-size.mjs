/**
 * A SIZE THAT CANNOT BE EXECUTED IS NOT AN OFFER — AND THE DESK IS NOT WHO KNOWS.
 *
 * WHAT THIS FILE USED TO ASSERT. Solana's network fees are fixed per trade, so below a
 * certain notional they eat the trade: two worst-case fees are 66% of a 0.0015 SOL
 * position. Measured on the live desk, every call for a day was offered between 0.0015
 * and 0.0092 SOL and every one was correctly refused by the executor as "costs eat the
 * target". The response was to teach decide() a MIN_EXECUTABLE_SOL floor: lift a tiny
 * size to ~0.02 SOL when the tenant's bankroll could afford it, and SKIP THE CALL
 * ENTIRELY when it could not.
 *
 * WHY THAT WAS THE WRONG PLACE FOR IT (owner, 2026-09-07; the desk says only WHAT and
 * WHEN, never how much and never what it costs). The fee floor was being applied to a
 * size decide() had itself just invented out of the tenant's bankroll, the category
 * multiplier and the desk's own fraction-of-book — so a fee judgment about a fictional
 * order was deciding whether a real tenant heard about a coin at all. That is the most
 * damaging shape a money judgment can take on this desk: not a wrong number on a screen,
 * a SUPPRESSED CALL. And "advisory" was never a defence, because a number that can stop
 * a call being offered is not advisory whatever it is labelled.
 *
 * WHERE THE JUDGMENT LIVES NOW, on the wallet that actually pays the fees:
 *   executor/strategy.mjs:232-234  feeFloorSol = 2*feeReserve / (maxFeeShareOfStop *
 *                                  effectiveStop) — the real reserve, the real stop
 *   executor/strategy.mjs:313-321  refuses when no size clears that floor, and says so
 * Both are tested in executor/test-sizing.mjs and executor/test-strategy.mjs.
 *
 * SO THIS FILE NOW ASSERTS THE INVERSE, which is the property that actually matters to a
 * tenant: no configuration of a floor's own money can stop a call reaching it.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/exec-size-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const copy = await import("./src/copy.js");
const db = (await import("./src/lib/store.js")).default;
const { planEntry, DEFAULTS } = await import("./executor/strategy.mjs");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 7;
copy.settingsFor(FLOOR);   // materialise the row
const setFloor = (bankroll, fixed) => db
  .prepare("UPDATE copy_settings SET bankroll_sol=?, appetite='aggressive', fixed_sol=? WHERE floor_no=?")
  .run(bankroll, fixed, FLOOR);

// The call that produced 0.0015 SOL offers in production: sized at 0.034% of the desk's
// paper book. Its desk_* fields are still carried, and are still read by nothing here.
const tinyCall = {
  id: 1, mint: "M", symbol: "DOGE-1", category: "memecoin", launchpad: "pump.fun",
  conviction: 55, entry_ref: 0.000334, stop: 0.000246, target: 0.00044,
  liq_at_call: 200000, mcap_at_call: 400000,
  desk_size_usd: 3.4, desk_equity_usd: 10000,
};

console.log("\nNO BANKROLL IS TOO SMALL TO BE TOLD ABOUT A COIN");
{
  /* Every one of these used to produce a different outcome: lifted to 0.02, refused as
     "network fees eat the trade", or offered at the asked size. The whole point of the
     change is that they no longer differ — the desk is not looking at any of it. */
  const shapes = [
    ["5 SOL bankroll, no fixed size", 5, 0],
    ["0.2 SOL bankroll — the old refusal case", 0.2, 0],
    ["0.5 SOL bankroll with fixed 0.2 SOL", 0.5, 0.2],
    ["0.01 SOL bankroll, fixed 0.0001 SOL", 0.01, 0.0001],
    ["50 SOL bankroll", 50, 0],
  ];
  const seen = [];
  for (const [label, bankroll, fixed] of shapes) {
    setFloor(bankroll, fixed);
    const d = copy.decide(FLOOR, tinyCall);
    seen.push(d);
    ok(`${label}: offered`, d.verdict === "offered", `${d.verdict}: ${d.reason}`);
  }
  ok("no configuration is refused for the fees",
    seen.every((d) => !/fees/.test(String(d.reason)) || /does not size it/.test(String(d.reason))),
    "no delivery is skipped on a fee judgment");
  ok("every one of them carries the SAME delivery — the money settings move nothing",
    new Set(seen.map((d) => d.reason)).size === 1 && seen.every((d) => d.sizeSol === null),
    [...new Set(seen.map((d) => d.reason))].join(" || "));
  ok("...and none of them was lifted, because there was nothing to lift",
    seen.every((d) => !/lifted to/.test(String(d.reason))), "no lift note on any delivery");
}

console.log("\nTHE FEE FLOOR IS ALIVE AND BINDING — IN THE PROCESS THAT PAYS THE FEES");
{
  /* The same judgment, at its new address, on numbers that are real: the bot's own fee
     reserve, its own stop, its own wallet. A 0.02 SOL wallet cannot fund a viable
     position and the bot says so; a 2 SOL wallet can. Neither answer was ever the
     desk's to give, because the desk cannot see either wallet. */
  const state = (equity) => ({ openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0,
    bookHeat: 0, equitySol: equity, spendableSol: equity, wins: 0, losses: 0 });
  const plan = (equity) => planEntry({
    call: { mint: "M", symbol: "DOGE-1", entry_ref: 1, stop: 0.74, target: 1.6, conviction: 55 },
    cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05, dailySolCap: 0.5,
      networkFeeReserveSol: 500_000 / 1e9, measuredRoundTripLossPct: 1 },
    state: state(equity) });

  const broke = plan(0.002);
  ok("a wallet too small for a viable position is refused BY THE BOT",
    broke.action === "skip", broke.reason);
  ok("...and told in fee language, which is the bot's language",
    /fees|minimum|rounds to nothing/.test(broke.reason), broke.reason);
  const funded = plan(2);
  ok("a funded wallet takes the same call", funded.action === "buy",
    `${funded.sol} SOL — ${funded.reason}`);
  ok("...at a size above the bot's own fee-derived minimum",
    funded.sol >= Math.max(DEFAULTS.minSolPerTrade, 0.0005), `${funded.sol} SOL`);

  const src = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");
  ok("and copy.js holds no MIN_EXECUTABLE_SOL of its own any more",
    !src.split("\n").some((l) => /MIN_EXECUTABLE_SOL/.test(l) && !/^\s*(\*|\/\*|\/\/)/.test(l)),
    "every mention is prose in the comment explaining the removal");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
