/**
 * THE STAMP THAT LIED.
 *
 * The desk started cycles constantly and finished none. The live record showed 33
 * budget stops, 24 halts, no `cycle:end` for sixteen hours, and zero calls — while
 * the scanning lane ticked over happily.
 *
 * The cause: `last_cycle_at` was written BEFORE the cycle ran, so a cycle that was
 * killed mid-flight (a deploy, a Render spin-down) left behind a stamp that was
 * indistinguishable from success. The next boot read its own fresh stamp, concluded a
 * cycle had just run, skipped the boot cycle, and fell back on a six-hour setInterval
 * that a short-lived process never survives to fire.
 *
 * This reproduces that exactly — run a cycle, kill it mid-flight, restart — and
 * asserts the boot now retries. It also asserts the guard the old code was reaching
 * for is still intact: a redeploy loop must not fire cycles back to back.
 */
import db from "./src/lib/store.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
const getKv = (k) => Number(db.prepare("SELECT value FROM kv WHERE key=?").get(k)?.value ?? 0);
const setKv = (k, v) => db.prepare(
  "INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(k, String(v));

const CYCLE_MINS = 360, MIN_RETRY_MS = 20 * 60000, MIN = 60000;

/** The shipped boot decision, lifted verbatim in shape. */
const bootWouldRun = (now) => {
  const sinceDone = now - getKv("last_cycle_done_at");
  const sinceStart = now - getKv("last_cycle_start_at");
  return sinceDone > (CYCLE_MINS / 2) * MIN && sinceStart > MIN_RETRY_MS;
};
/** The OLD decision, for contrast — one stamp, written before the work. */
const oldBootWouldRun = (now) => (now - getKv("last_cycle_at")) > (CYCLE_MINS / 2) * MIN;

const now = Date.now();
console.log("\nA FRESH DESK — nothing has ever run");
db.exec("DELETE FROM kv");
ok("the boot cycle fires", bootWouldRun(now));

console.log("\nTHE BUG, REPRODUCED — a cycle starts, is killed mid-flight, process restarts");
db.exec("DELETE FROM kv");
setKv("last_cycle_at", now - 3 * MIN);        // the old code stamped on START
setKv("last_cycle_start_at", now - 3 * MIN);  // ...and the cycle never returned
ok("the OLD logic skipped the retry — this is the sixteen silent hours",
  !oldBootWouldRun(now), "a start-stamp read as if it were a success");
// The new logic: 'done' never moved, so the cycle correctly counts as never having
// happened. The retry guard still holds it briefly, which is intended.
ok("the new logic knows no cycle COMPLETED", (now - getKv("last_cycle_done_at")) > (CYCLE_MINS / 2) * MIN);
ok("but the retry guard holds it while the start is fresh", !bootWouldRun(now),
  "3m since it started — inside the 20m guard");
ok("and once the guard expires the boot DOES retry", bootWouldRun(now + 25 * MIN),
  "28m after the killed start");

console.log("\nA GENUINELY RECENT SUCCESS — the desk must not re-spend");
db.exec("DELETE FROM kv");
setKv("last_cycle_start_at", now - 60 * MIN);
setKv("last_cycle_done_at", now - 55 * MIN);
ok("the boot cycle is skipped", !bootWouldRun(now), "completed 55m ago, inside the 180m window");

console.log("\nA REDEPLOY LOOP — the guard the old code was reaching for");
db.exec("DELETE FROM kv");
setKv("last_cycle_start_at", now - 2 * MIN);
ok("a second deploy 2m later does NOT fire another cycle", !bootWouldRun(now));
ok("nor a third at 10m", !bootWouldRun(now + 8 * MIN));
ok("but a real gap does", bootWouldRun(now + 25 * MIN));

console.log("\nSTALE PRODUCTION STAMPS must not be misread as completions");
db.exec("DELETE FROM kv");
setKv("last_cycle_at", now - 5 * MIN);   // the only key production currently holds
ok("the new key is absent, so the desk retries rather than trusting the old one",
  bootWouldRun(now), "last_cycle_done_at = 0");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
