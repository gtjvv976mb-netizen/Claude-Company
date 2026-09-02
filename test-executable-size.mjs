/**
 * A SIZE THAT CANNOT BE EXECUTED IS NOT AN OFFER.
 *
 * Solana's network fees are fixed, so below a certain notional they eat the trade:
 * two worst-case fees are 66% of a 0.0015 SOL position. Measured on the live desk,
 * every call for a day was offered between 0.0015 and 0.0092 SOL and every one was
 * correctly refused by the executor as "costs eat the target" — the floor was
 * publishing arithmetically impossible trades and the bot was right to decline them.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/exec-size-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const copy = await import("./src/copy.js");
const db = (await import("./src/lib/store.js")).default;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 7;
const setFloor = (patch) => copy.saveSettings
  ? copy.saveSettings(FLOOR, patch)
  : db.prepare("UPDATE copy_settings SET bankroll_sol=?, appetite=? WHERE floor_no=?")
      .run(patch.bankrollSol ?? 5, patch.appetite ?? "aggressive", FLOOR);
copy.settingsFor(FLOOR);   // materialise the row

// A call the desk sized at a fraction of a large paper book — the shape that produced
// 0.0015 SOL offers in production.
const tinyCall = {
  id: 1, mint: "M", symbol: "DOGE-1", category: "memecoin", launchpad: "pump.fun",
  conviction: 55, entry_ref: 0.000334, stop: 0.000246, target: 0.00044,
  liq_at_call: 200000, mcap_at_call: 400000,
  desk_size_usd: 3.4, desk_equity_usd: 10000,     // 0.034% of book
};

console.log("\nAN UNEXECUTABLE SIZE IS LIFTED TO ONE THAT WORKS");
db.prepare("UPDATE copy_settings SET bankroll_sol=5, appetite='aggressive' WHERE floor_no=?").run(FLOOR);
const lifted = copy.decide(FLOOR, tinyCall);
ok("the call is still offered", lifted.verdict === "offered", lifted.reason);
ok("...at a size that can clear fixed fees", lifted.sizeSol >= 0.02,
  `${lifted.sizeSol} SOL — was 0.0017 before, where two fees are 59% of the trade`);
ok("...and the lift is disclosed in the reason", /network fees do not eat the trade/.test(lifted.reason || ""));

console.log("\nTHE LIFT NEVER EXCEEDS THE RISK THE TENANT CHOSE");
// 0.2 SOL bankroll, aggressive = 3% = 0.006 SOL per trade, below the 0.02 floor.
db.prepare("UPDATE copy_settings SET bankroll_sol=0.2, appetite='aggressive' WHERE floor_no=?").run(FLOOR);
const refused = copy.decide(FLOOR, tinyCall);
ok("a bankroll too small to trade is told so, not handed an impossible trade",
  refused.verdict === "skipped" && /network fees eat the trade/.test(refused.reason),
  refused.reason);

console.log("\nAN EXPLICIT FIXED SIZE IS THE TENANT'S CHOSEN RISK");
// Floor 50's real shape: a small declared bankroll (per-trade budget under 0.02 SOL at the
// appetite percentage) but fixed_sol = 0.2 — the owner stated a size in SOL. The
// refusal branch read only the percentage and told them to "set a fixed size".
db.prepare("UPDATE copy_settings SET bankroll_sol=0.5, appetite='aggressive', fixed_sol=0.2 WHERE floor_no=?").run(FLOOR);
const fixedFloor = copy.decide(FLOOR, tinyCall);
ok("a floor with a fixed size is offered the executable minimum",
  fixedFloor.verdict === "offered" && fixedFloor.sizeSol >= 0.02,
  `${fixedFloor.verdict} ${fixedFloor.sizeSol ?? ""} — ${(fixedFloor.reason || "").slice(0, 90)}`);
db.prepare("UPDATE copy_settings SET bankroll_sol=0.5, appetite='aggressive', fixed_sol=0 WHERE floor_no=?").run(FLOOR);
const noFixed = copy.decide(FLOOR, tinyCall);
ok("...and without one, the same tiny bankroll is still refused honestly",
  noFixed.verdict === "skipped" && /network fees eat the trade/.test(noFixed.reason), noFixed.reason);

console.log("\nA NORMAL SIZE IS UNTOUCHED");
db.prepare("UPDATE copy_settings SET bankroll_sol=50, appetite='aggressive' WHERE floor_no=?").run(FLOOR);
const normal = copy.decide(FLOOR, { ...tinyCall, desk_size_usd: 200, desk_equity_usd: 10000 });
ok("a size already above the floor is not lifted",
  normal.verdict === "offered" && normal.sizeSol > 0.02 &&
  !/network fees do not eat/.test(normal.reason || ""),
  `${normal.sizeSol} SOL`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
