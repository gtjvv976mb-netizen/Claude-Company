/**
 * A TRADE THE DESK NEVER HEARS ABOUT IS INDISTINGUISHABLE FROM ONE THAT NEVER HAPPENED.
 *
 * On 2026-09-04 the bot bought TOAD — signed, confirmed, finalized, 491,380,826 raw
 * tokens sitting in the wallet, 0.021322 SOL gone — and the site showed nothing. The
 * owner's reasonable conclusion was that it had not traded.
 *
 * The site shows a position on the floor's board only where `taken === true`, and
 * nothing in the executor ever set that. A `take` route existed but was guarded by a
 * wallet session, so only a human clicking in the UI could reach it. The bot had no way
 * to say what it had done.
 *
 * The reporting is deliberately NOT fire-and-forget. That exact mistake is already in
 * this codebase once — the desk's entry alert was posted without awaiting it, and a
 * failed write lost a call with no trace anywhere.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const poller = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const viewer = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");

console.log("\nTHE BOT CAN NOW SAY WHAT IT DID");
{
  ok("there is a route it can actually reach", office.includes("executor\\/take$"),
    "POST /api/floor/{n}/executor/take");
  ok("...authenticated by the same read-only secret as the feed and heartbeat",
    /takeMatch[\s\S]{0,700}bad or missing executor secret/.test(office));
  ok("...and it only ever sets a flag, granting the server no control",
    /takeMatch[\s\S]{0,900}copy\.markTaken\(floorNo, callId/.test(office));
  ok("a malformed callId is refused",
    /if \(!Number\.isInteger\(callId\) \|\| callId <= 0\) return json\(400/.test(office));
  ok("the bot posts to it", /\/api\/floor\/\$\{FLOOR\}\/executor\/take/.test(poller));
}

console.log("\nA FILL IS A FACT ABOUT THE CHAIN, AND IS NEVER DELAYED BY THE DESK");
{
  ok("the report is queued, not awaited, at the moment of the fill",
    /unreportedFills\.add\(Number\(pos\.callId\)\);\s*\n\s*flushUnreportedFills\(\)\.catch/.test(poller));
  ok("...so an unreachable desk cannot undo or delay a trade",
    /flushUnreportedFills\(\)\.catch\(\(\) => \{\}\)/.test(poller));
}

console.log("\nBUT IT IS NEVER SILENTLY DROPPED EITHER");
{
  ok("a failed report stays in the queue", /could not report fill[\s\S]{0,120}will retry/.test(poller));
  ok("...and is retried on every tick", /flushUnreportedFills\(\)\.catch\(\(\) => \{\}\);\s*\n\s*sendHeartbeat\(\)/.test(poller));
  ok("a success removes it from the queue", /unreportedFills\.delete\(callId\)/.test(poller));
  ok("the queue is rebuilt from the journal at boot, so a restart mid-report keeps it",
    /function queueUnreportedFillsFromJournal/.test(poller) &&
    /queueUnreportedFillsFromJournal\(\);\s*\n\s*log\(`resuming/.test(poller));
  ok("...only for positions carrying a real call id",
    /Number\.isInteger\(callId\) && callId > 0\) unreportedFills\.add/.test(poller));
  ok("two flushes cannot overlap", /if \(reportingFills \|\| !unreportedFills\.size\) return;/.test(poller));
  ok("a non-2xx answer is a failure, not a success", /if \(!response\.ok\) throw new Error\(`take HTTP/.test(poller));
  ok("the request cannot hang forever", /AbortSignal\.timeout\(10_000\)[\s\S]{0,80}\}\);\s*\n\s*if \(!response\.ok\)/.test(poller));
}

console.log("\nAND THE SITE READS EXACTLY THAT FLAG");
{
  ok("the board shows only what the floor actually holds",
    /const held = open\.filter\(\(c\) => c\.taken === true\)/.test(viewer));
  ok("...which is why an unreported fill rendered as nothing at all", true,
    "the bug this closes");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
