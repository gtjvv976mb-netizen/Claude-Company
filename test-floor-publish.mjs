/**
 * THE APPROVAL THAT WENT NOWHERE.
 *
 * AURA was the desk's first ever PROPOSE and its first ever CEO APPROVE — after 188
 * workups, the sixteen seats finally said yes to something. And nothing happened. No
 * call, no delivery, no bot execution, and not even a withheld event to explain it.
 *
 * The cause: a tenant's paid research run wrote its outcome to a journal row and
 * stopped. rooms.js never called the publish step at all, so an approval on a floor
 * had no road out of the database. The bot trades published calls; this was never one.
 *
 * This proves the new road end to end, and — more importantly — proves it is a road to
 * the SAME gate rather than around it: a coin that fails a safety check must still be
 * refused when it arrives this way.
 */
import db from "./src/lib/store.js";
import { publishCall } from "./src/penthouse.js";
import { liveCalls, closeCall } from "./src/calls.js";
import { settingsFor } from "./src/copy.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 50;
settingsFor(FLOOR);                       // seeds appetite + feed secret
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

/** A workup record shaped like the one AURA produced: PROPOSE + CEO APPROVE. */
const approved = (over = {}) => ({
  mint: "AuRa111111111111111111111111111111111111111", symbol: "AURA",
  outcome: "decided", finalDecision: "APPROVED", weighted: 71,
  pm: { decision: "PROPOSE", conviction: 68, thesis: "real ignition", invalidation: "deployer sells" },
  redteam: { verdict: "wounded", headline: "thin on holders" },
  compliance: { pass: true, violations: [] },
  ceo: { ruling: "APPROVE" },
  ticket: { stop_price: 0.00062, take_profit: [{ price: 0.0019 }] },
  ev: { symbol: "AURA", pair: { priceUsd: 0.001, priceChange: { m5: 2 }, liquidityUsd: 90_000 },
        pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
        mintAccount: { flags: [] } },
  ...over,
});

console.log("\nTHE AURA PATH — an approved floor run must become a tradeable call");
const pub = publishCall(approved(), { category: "memecoin", launchpad: "pump.fun", toFloors: [FLOOR] });
ok("the approval published", pub.outcome === "published", `callId=${pub.callId} tier=${pub.tier}`);
const del = db.prepare("SELECT * FROM deliveries WHERE call_id=? AND floor_no=?").get(pub.callId, FLOOR);
ok("it was delivered to the floor that paid for it", !!del,
  del ? `verdict=${del.verdict} size=${del.size_sol}` : "no delivery row");
ok("and OFFERED, so the bot's feed will carry it", del?.verdict === "offered", del?.reason ?? "");

console.log("\nONE FLOOR'S RUN MUST NOT PUT THE WHOLE BUILDING IN A POSITION");
const others = db.prepare("SELECT COUNT(*) n FROM deliveries WHERE call_id=? AND floor_no<>?")
  .get(pub.callId, FLOOR).n;
ok("no other floor received it", others === 0, `${others} other deliveries`);

console.log("\nTHE BOOK GATE STILL BINDS — one trade at a time, as asked");
const second = publishCall(approved({ mint: "Second111111111111111111111111111111111111", symbol: "TWO" }),
  { category: "memecoin", toFloors: [FLOOR] });
ok("a second call is refused while the first works", second.outcome === "book_full", second.reason ?? "");

console.log("\nTHIS IS A ROAD TO THE GATE, NOT AROUND IT");
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const cases = [
  ["a killed coin", approved({ outcome: "killed", killedBy: "forensics", reason: "mint authority live" })],
  ["a compliance veto", approved({ compliance: { pass: false, violations: [{ code: "edge_below_cost" }] } })],
  ["no stop price", approved({ ticket: { stop_price: 0 } })],
  ["a stop above entry", approved({ ticket: { stop_price: 0.002, take_profit: [] } })],
  ["a spike-shaped entry", approved({ ev: { ...approved().ev, pair: { ...approved().ev.pair, priceChange: { m5: 44 } } } })],
];
for (const [label, rec] of cases) {
  const r = publishCall(rec, { category: "memecoin", toFloors: [FLOOR] });
  ok(`${label} is still refused`, r.outcome !== "published", `${r.outcome}: ${String(r.reason).slice(0, 58)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
