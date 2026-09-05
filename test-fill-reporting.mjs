/**
 * A TRADE THE DESK NEVER HEARS ABOUT IS INDISTINGUISHABLE FROM ONE THAT NEVER HAPPENED.
 *
 * On 2026-09-04 the bot bought TOAD — signed, confirmed, finalized, 491,380,826 raw
 * tokens sitting in the wallet, 0.021322 SOL gone — and the site showed nothing. The
 * owner's reasonable conclusion was that it had not traded.
 *
 * The site shows a position on the floor's board only where the feed says it is taken
 * (SQLite's 1 on the wire, or a literal true — `=== true` alone held nothing), and
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
    /takeMatch[\s\S]{0,1400}copy\.markTaken\(floorNo, callId/.test(office));
  /* A 200 for a write that did not happen ends the retry that would have surfaced it. */
  ok("it answers 404 when no offered delivery matched, rather than a false success",
    /return json\(ok \? 200 : 404/.test(office));
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

/* THE FLAG WAS ONE BIT, AND ONE BIT CANNOT SAY 0.0175 SOL OR "SOLD". Shrek call 55,
   2026-09-05: the board showed the desk's paper 0.4 SOL for a real 0.0175 SOL fill; the
   bot sold at 03:01:42Z on its own normalised stop at -13.5% and the site never heard
   it, so when the desk's stop_hit came at 03:10:24Z the card still called the position
   held. Both legs now report with the chain's numbers to one route, and the desk keeps
   them in executor_fills, keyed by signature. The behaviour is exercised against the
   real route in test-executor-fill-report.mjs; these are the contract pins. */
console.log("\nAND NOW IT SAYS WHAT IT DID, WITH NUMBERS — BOTH LEGS");
{
  const copySrc = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");
  ok("there is a fill route", office.includes("executor\\/fill$"), "POST /api/floor/{n}/executor/fill");
  ok("...behind the same constant-time secret as take, feed and heartbeat",
    /fillMatch[\s\S]{0,700}cryptoTimingEqual\(auth, secret\)[\s\S]{0,200}bad or missing executor secret/.test(office));
  ok("a malformed body is 400, so a NaN never reaches the public board",
    /const valid = copy\.validateExecutorFill\(body\);\s*\n\s*if \(!valid\.ok\) return json\(400/.test(office));
  ok("no offered delivery is 404, never a false success that ends the retry",
    /const fill = copy\.recordExecutorFill\(floorNo, body\);\s*\n\s*if \(!fill\) return json\(404/.test(office));
  ok("a stored fill is 200 with the row", /return json\(200, \{ ok: true, fill \}\)/.test(office));
  ok("the table exists, keyed by the chain signature",
    /CREATE TABLE IF NOT EXISTS executor_fills/.test(copySrc) && /signature\s+TEXT NOT NULL UNIQUE/.test(copySrc));
  ok("...and only ever holds a buy or a sell", /CHECK \(side IN \('buy','sell'\)\)/.test(copySrc));
  ok("a re-post by signature is an upsert, not a second fill",
    /INSERT OR IGNORE INTO executor_fills/.test(copySrc) && /UPDATE executor_fills SET[\s\S]{0,600}WHERE signature=\?/.test(copySrc));
  ok("a buy marks the delivery taken — the flag is derived, not a second report",
    /if \(f\.side === "buy"\) markTaken\(floorNo, f\.call_id, true\)/.test(copySrc));
  ok("a fill on a call this floor was never offered is refused, as take is",
    /SELECT 1 FROM deliveries WHERE floor_no=\? AND call_id=\? AND verdict='offered'[\s\S]{0,80}if \(!offered\) return null/.test(copySrc));
  ok("every feed row carries the bot's book", /bot_status: null, bot_size_sol: null/.test(copySrc) &&
    /out\.bot_status = sells\.length \? "closed" : buys\.length \? "open" : null/.test(copySrc));
  ok("...and never the wallet", /The wallet column is deliberately NOT selected/.test(copySrc));
  // The bot's half of the contract (executor owner): both legs queued durably, acked by
  // a journal meta key, rebuilt at boot.
  ok("the bot posts both legs to the fill route", /\/api\/floor\/\$\{FLOOR\}\/executor\/fill/.test(poller));
  ok("...from a durable queue of intent ids", /unreportedFillDetails/.test(poller));
  ok("...flushed every tick", /flushFillReports\(/.test(poller));
  ok("...and a 2xx is remembered in the journal so a restart does not re-post for ever",
    /fill_reported:/.test(poller));
}

console.log("\nAND THE SITE READS EXACTLY THAT FLAG");
{
  ok("the board shows only what the bot is actually in — its own report first, the take flag only when it never reported",
    /const botOpen = \(c\) => c\.bot_status === "open" \|\| \(c\.bot_status == null && c\.status === "live" && \(c\.taken === true \|\| Number\(c\.taken\) === 1\)\);/.test(viewer) &&
    /const held = open\.filter\(botOpen\);/.test(viewer));
  ok("...which is why an unreported fill rendered as nothing at all", true,
    "the bug this closes");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
