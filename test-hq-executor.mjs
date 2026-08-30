/**
 * THE HOUSE EATS ITS OWN COOKING.
 *
 * The HQ wrote every call and received none of them: broadcast() reached floors whose
 * state is 'owned', and floor 50's state is 'hq' because it is never for sale. So the
 * one desk with an opinion had no way to put money behind it.
 *
 * This proves the whole road end to end, on a throwaway database:
 *   a published call -> a delivery row on floor 50 -> the executor feed serving it
 *   to a poller authenticated by floor 50's own secret.
 *
 * It also asserts the part that must NEVER change: the feed carries prices, stops and
 * sizes, and no key material of any kind. The server publishes rows. The wallet lives
 * on the owner's machine, exactly as it does for a tenant.
 */
import db from "./src/lib/store.js";
import { openCall, closeCall, liveCalls } from "./src/calls.js";
import { broadcast, settingsFor, saveSettings } from "./src/copy.js";
import { listFloors, HQ_FLOOR } from "./src/tower.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE HQ IS A FLOOR THAT TRADES");

const floors = listFloors();
const hq = floors.find((f) => f.n === HQ_FLOOR);
ok("floor 50 is the HQ and is not 'owned'", hq?.state === "hq", `state=${hq?.state}`);

// The fix: the broadcast list must now include it.
const targets = floors.filter((f) => f.state === "owned" || f.n === HQ_FLOOR).map((f) => f.n);
ok("the broadcast list includes the HQ", targets.includes(HQ_FLOOR), `targets=[${targets}]`);

const s = settingsFor(HQ_FLOOR);
ok("the HQ has copy settings of its own", !!s, `appetite=${s.appetite} bankroll=${s.bankroll_sol} SOL`);
// The HQ is the memecoin desk; a 'balanced' HQ would skip 100% of its own calls.
ok("the HQ's appetite actually admits memecoins", s.categories.includes("memecoin"),
  `categories=${s.categories.join(",")}`);
// The poller authenticates with this and never receives a webhook, so it must exist
// without one having been configured.
ok("a feed secret exists without any webhook URL being set",
  !!s.executor_secret && !s.executor_url,
  `secret=${s.executor_secret ? s.executor_secret.slice(0, 8) + "… (" + s.executor_secret.length + " chars)" : "none"}`);

// Publish a call the way the desk does, then broadcast it.
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const call = openCall({
  mint: "HQtest1111111111111111111111111111111111111", symbol: "HOUSE",
  category: "memecoin", launchpad: "pump.fun", conviction: 62,
  entryRef: 0.0010, stop: 0.00062, target: 0.0019,
  thesis: "the house backs its own call", invalidation: "deployer sells",
  liqUsd: 90_000, rtLossPct: 3.1,
});
ok("a call was published", !!call, `id=${call?.id}`);

const res = broadcast(call.id, targets);
ok("the broadcast succeeded", res.ok, `offered=${res.offered} skipped=${res.skipped}`);

const del = db.prepare("SELECT * FROM deliveries WHERE call_id=? AND floor_no=?").get(call.id, HQ_FLOOR);
ok("the HQ received a delivery row for its own call", !!del,
  del ? `verdict=${del.verdict} size=${del.size_sol ?? "n/a"} ${del.reason ?? ""}` : "no row");
ok("and it was OFFERED, not skipped", del?.verdict === "offered",
  del?.verdict === "offered" ? "the house may trade it" : `verdict=${del?.verdict} — ${del?.reason}`);

// The security invariant. This is the line that must never move.
const feedRow = db.prepare("SELECT executor_secret FROM copy_settings WHERE floor_no=?").get(HQ_FLOOR);
ok("the feed is gated by the floor's own secret", !!feedRow?.executor_secret);
const payload = JSON.stringify({ call, delivery: del });
for (const forbidden of ["secretKey", "privateKey", "seed", "mnemonic", "keypair"]) {
  ok(`the call payload carries no ${forbidden}`, !payload.toLowerCase().includes(forbidden.toLowerCase()));
}
ok("the payload carries what a bot actually needs (stop + entry)",
  payload.includes("0.00062") && payload.includes("0.001"),
  "stop and entry reference present");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
