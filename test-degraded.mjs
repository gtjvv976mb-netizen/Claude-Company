/**
 * THE HEARTBEAT MUST NOTICE A BROKEN BUILD.
 *
 * RUNNING meant "not paused" — budget, a key, no open position. The desk reported
 * RUNNING for hours while every workup threw the same ReferenceError, because a failed
 * workup is caught, counted and stepped over so that one bad coin cannot end a cycle.
 * Right for one bad coin; catastrophic for a bug on the shared path.
 */
import { DatabaseSync } from "node:sqlite";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const db = new DatabaseSync(process.env.CLAUDE_CO_DB || ":memory:");
db.exec("CREATE TABLE IF NOT EXISTS chronicle (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data TEXT, ts INTEGER)");
db.exec("DELETE FROM chronicle");

// The exact query the heartbeat runs.
const topError = (sinceMs = 3600e3) => db.prepare(`
  SELECT json_extract(data,'$.error') e, COUNT(*) n FROM chronicle
  WHERE type='cycle:error' AND ts > ? GROUP BY e ORDER BY n DESC LIMIT 1`).get(Date.now() - sinceMs);
const verdict = (row) => (row?.e && row.n >= 5) ? "DEGRADED" : "RUNNING";

const add = (err, n, agoMs = 0) => {
  const ins = db.prepare("INSERT INTO chronicle (type,data,ts) VALUES ('cycle:error',?,?)");
  for (let i = 0; i < n; i++) ins.run(JSON.stringify({ error: err }), Date.now() - agoMs);
};

console.log("\nONE BAD COIN IS WEATHER");
add("no route for this mint", 3);
ok("a few scattered failures do not flag the build", verdict(topError()) === "RUNNING",
  "3 failures — coins are unreadable all the time");

console.log("\nEVERY COIN FAILING THE SAME WAY IS A BROKEN BUILD");
db.exec("DELETE FROM chronicle");
add("xRead is not defined", 12);
const row = topError();
ok("the heartbeat drops to DEGRADED", verdict(row) === "DEGRADED", `${row.n} identical failures`);
ok("...and names the actual error, so nobody has to infer it",
  row.e === "xRead is not defined", row.e,
);

console.log("\nDIFFERENT FAILURES DO NOT ADD UP INTO A FALSE ALARM");
db.exec("DELETE FROM chronicle");
for (const e of ["a", "b", "c", "d", "e", "f", "g"]) add(e, 1);
ok("seven different one-off errors stay RUNNING", verdict(topError()) === "RUNNING",
  "it is the REPETITION that means a shared path is broken, not the volume");

console.log("\nAND THE WINDOW IS RECENT, SO A FIXED BUG CLEARS");
db.exec("DELETE FROM chronicle");
add("xRead is not defined", 12, 2 * 3600e3);          // two hours ago, since fixed
ok("yesterday's outage does not hold the desk down", verdict(topError()) === "RUNNING",
  "the check asks whether it is broken NOW");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
