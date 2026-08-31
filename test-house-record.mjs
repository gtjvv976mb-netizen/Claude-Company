import db from "./src/lib/store.js";
import { openCall } from "./src/calls.js";
import { houseRecord, wilson } from "./src/perf.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

const call = (mint, symbol) => openCall({
  mint, symbol, category: "memecoin", entryRef: 1, stop: 0.6, target: 2,
  thesis: "signal-level accounting", invalidation: "stop",
});
const winner = call("HouseWin11111111111111111111111111111111111", "WIN");
const loser = call("HouseLoss1111111111111111111111111111111111", "LOSS");
const insert = db.prepare(`INSERT INTO results
  (floor_no,call_id,wallet,bought_usd,sold_usd,pnl_usd,fee_pct,fee_usd,fee_paid,settled_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// One hundred tenants copying one forecast are useful execution observations, but
// they remain a single piece of evidence about the research signal.
for (let floor = 1; floor <= 100; floor++)
  insert.run(floor, winner.id, `wallet-${floor}`, 100, 110, 10, 10, 1, 1, Date.now());
insert.run(101, loser.id, "wallet-loss", 100, 95, -5, 10, 0, 1, Date.now());

console.log("\nCOPIES DO NOT INFLATE THE HOUSE SAMPLE");
const record = houseRecord();
ok("101 tenant results become two independent calls", record.settled === 2,
  `settled=${record.settled}`);
ok("the hit rate is one of two calls", record.wins === 1 && record.losses === 1 && record.winRate === 50,
  `${record.wins}-${record.losses}, ${record.winRate}%`);
ok("signal-level P&L averages copies before summing", record.netPnlUsd === 5,
  `$${record.netPnlUsd}`);
ok("two calls can never claim an edge", record.edgeClaimable === false, record.edgeNote);
ok("the note names the 100-call minimum", /2\/100 independent calls/.test(record.edgeNote), record.edgeNote);

console.log("\nTHE CONFIDENCE GATE USES THE LOWER BOUND");
const coinFlip = wilson(6, 12);
ok("6/12 has a lower bound below 50%", coinFlip.low < 0.5,
  `${(coinFlip.low * 100).toFixed(1)}-${(coinFlip.high * 100).toFixed(1)}%`);
ok("the old upper-bound test would have been misleading", coinFlip.high > 0.5,
  "this is why edge cannot be gated on the interval's top");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
