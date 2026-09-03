/**
 * THE CALLOUTS TAB IS A WINDOW, NOT AN INSTANT.
 *
 * A sweep sees only what pump.fun is trading in those two minutes, and a verified caller
 * is roughly one callout in eighteen. Drawn from the sweep alone the tab showed five
 * cards, then one, then none — and read as broken while it was working exactly as
 * written. What a reader wants is "who has called something recently", which is a
 * question about the last several hours.
 *
 * Durable on purpose: Render restarts on every deploy, and an in-memory board would
 * empty itself several times a day for reasons that have nothing to do with the market.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { rememberVerifiedCallouts, verifiedCalloutBoard, CALLOUT_BOARD_HOURS } from "./src/callouts.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const HOUR = 3600e3;
const now = 1_788_500_000_000;
const caller = (over = {}) => ({ mint: "M1", user: "W1", symbol: "AAA", username: "alice",
  walletSolUsd: 5000, ts: now - 60_000, multiple: 1.4, ...over });

console.log("\nSWEEPS ACCUMULATE INSTEAD OF REPLACING");
{
  rememberVerifiedCallouts([caller()], { now: now - 3 * HOUR });
  rememberVerifiedCallouts([caller({ mint: "M2", user: "W2", symbol: "BBB", username: "bob", walletSolUsd: 2000 })], { now: now - HOUR });
  rememberVerifiedCallouts([], { now });                       // a sweep that found nothing
  const board = verifiedCalloutBoard({ now });
  ok("a sweep that finds nothing does not empty the board", board.length === 2, `${board.length} rows`);
  ok("...and the freshest caller is first", board[0].username === "bob", board.map((r) => r.username).join(", "));
}

console.log("\nA CALLER SEEN AGAIN UPDATES IN PLACE");
{
  rememberVerifiedCallouts([caller({ walletSolUsd: 5600 })], { now });
  const board = verifiedCalloutBoard({ now });
  const alice = board.filter((r) => r.username === "alice");
  ok("no duplicate row for the same caller on the same coin", alice.length === 1, `${alice.length} rows`);
  ok("the balance is refreshed", alice[0].wallet_sol_usd === 5600, `$${alice[0].wallet_sol_usd}`);
  ok("first_seen is preserved, last_seen moves", alice[0].first_seen < alice[0].last_seen,
    `first ${alice[0].first_seen}, last ${alice[0].last_seen}`);
  // The same wallet calling a DIFFERENT coin is a different call and gets its own row.
  rememberVerifiedCallouts([caller({ mint: "M3", symbol: "CCC" })], { now });
  ok("the same caller on another coin is its own row",
    verifiedCalloutBoard({ now }).filter((r) => r.username === "alice").length === 2);
}

console.log("\nTHE WINDOW ENDS, AND THE BOARD IS BOUNDED");
{
  ok("a caller outside the window is gone",
    verifiedCalloutBoard({ now: now + (CALLOUT_BOARD_HOURS + 1) * HOUR }).length === 0,
    `window is ${CALLOUT_BOARD_HOURS}h`);
  const many = Array.from({ length: 450 }, (_, i) => caller({ mint: "X" + i, user: "U" + i }));
  rememberVerifiedCallouts(many, { now });
  const size = verifiedCalloutBoard({ now, limit: 200 }).length;
  ok("a burst cannot grow the board without limit", size <= 200, `${size} rows returned`);
}

console.log("\nA BAD ROW COSTS THE SWEEP NOTHING");
{
  const before = verifiedCalloutBoard({ now, limit: 200 }).length;
  const kept = rememberVerifiedCallouts([{ mint: null, user: "W9" }, { mint: "M9" }, caller({ mint: "M9", user: "W9" })], { now });
  ok("rows without a mint or a caller are skipped, the good one is kept", kept === 1, `${kept} written`);
  ok("...and the board still reads", verifiedCalloutBoard({ now, limit: 200 }).length >= before);
}

console.log("\nTHE ROUTE AND THE TAB BOTH SPEAK OF A WINDOW");
{
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  assert.match(office, /rememberVerifiedCallouts\(gate\.rows, \{ now \}\)/, "the sweep records what it found");
  assert.match(office, /const board = verifiedCalloutBoard\(\{ now \}\)/, "the payload is built from the board");
  assert.match(office, /boardHours: CALLOUT_BOARD_HOURS/, "coverage states the window");
  assert.match(office, /newThisSweep: gate\.rows\.length/, "and separates this sweep from the board");
  const view = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
  assert.match(view, /board covers the last/, "the tab says it is a window");
  assert.match(view, /"seen " \+ found/, "each card says when that caller was seen");
  ok("the route records, the tab reads the window", true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
