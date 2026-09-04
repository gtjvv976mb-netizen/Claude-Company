/**
 * A DROPPED PACKET IS NOT A DECISION.
 *
 * Any error during an entry advanced the feed cursor and acknowledged the event, so a
 * four-second RPC timeout consumed a published call exactly like a refusal did —
 * permanently, with no retry. Measured in the live log across 2026-09-01 to 09-04,
 * eight real calls went this way: TOAD, MACRODUCK, Hosico, TripleT, HeeHaw, TOAD, USWS,
 * HeeHaw. Four of those were the executable-cost check (a real decision) and four were
 * the Token-2022 mint audit, but the same branch also swallows every RPC timeout.
 *
 * The reason for acknowledging is still right: new exposure is optional, and an entry
 * that keeps failing must not become a head-of-line denial of every later EXIT — which
 * is what would happen if the cursor never moved. So the fix is a BOUNDED retry, and
 * the two dangerous directions are what this file mostly asserts: a decision must never
 * be retried for ever, and the retry must never be unbounded.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const src = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");

/* The classifier, lifted from the source so the test cannot drift from it. */
const block = src.slice(src.indexOf("const TRANSIENT_ENTRY_FAILURE = ["),
  src.indexOf("const MAX_ENTRY_RETRIES"));
const patterns = [...block.matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1], m[2]));
const isTransient = (msg) => patterns.some((re) => re.test(msg));

console.log("\nTHE FAILURES THE LIVE LOG ACTUALLY SHOWS AS TRANSPORT");
{
  for (const msg of [
    "Solana RPC HTTP request timed out after 4000ms",
    "fetch failed",
    "failed to simulate transaction: Minimum context slot has not been reached",
    "RPC could not obtain a processed-slot freshness anchor",
    "RPC could not produce one coherent exact-slot account snapshot after 3 attempts",
    "Jupiter /order 400: Failed to get quotes",
    "feed HTTP 502",
    "socket hang up",
  ]) ok(`retried: ${msg.slice(0, 58)}`, isTransient(msg));
}

console.log("\nA DECISION IS NEVER RETRIED — IT IS ANSWERED");
{
  /* These are the executor deciding, and every one of them would be true again on the
     next poll. Retrying them would burn the queue and delay real exits. */
  for (const msg of [
    "entry round trip plus worst-case fees is already at/below the authored stop",
    "actual stop risk 3.22% exceeds per-name cap 2.50%",
    "mint AAA Token-2022 extension TransferFeeConfig is refused",
    "freeze authority 9xy could brick the exit",
    "CC_TOKEN_2022=0 keeps this executor on classic SPL Token mints",
    "rent 8157120 lamports exceeds cap 4200000",
    "call is 143m old (max 45m)",
    "PAUSE ENTRIES file is present",
    "non-rent network fees 2100000 lamports exceed cap 2000000",
    "the sized position rounds to nothing",
  ]) ok(`answered at once: ${msg.slice(0, 52)}`, !isTransient(msg));
}

console.log("\nTHE RETRY IS BOUNDED, AND CANNOT BLOCK THE QUEUE FOR EVER");
{
  const cap = (src.match(/MAX_ENTRY_RETRIES = Math\.max\(1, Math\.min\((\d+), Number\(process\.env\.MAX_ENTRY_RETRIES\) \|\| (\d+)\)\)/) || []);
  ok("there is a hard ceiling on attempts", cap[1] != null, `default ${cap[2]}, max ${cap[1]}`);
  ok("...and it is short enough to matter", Number(cap[2]) <= 10, `${cap[2]} attempts at a 15s poll`);
  ok("exhausting the retries acknowledges the call rather than holding it",
    /gave up after[\s\S]{0,160}S\.cursor = Number\(ev\.id\); save\(\); continue;/.test(src));
  ok("a retry leaves the cursor where it is", /the call stays on the feed`\);\s*\n\s*break;/.test(src));
  ok("a successful entry clears its retry count",
    /await onEntry\(ev\);\s*\n\s*entryRetries\.delete\(/.test(src));
  ok("the retry map cannot grow without bound", /if \(entryRetries\.size > \d+\)/.test(src));
}

console.log("\nEXITS ARE NEVER DELAYED BY A STUCK ENTRY");
{
  /* The whole reason the old code acknowledged unconditionally. An exit event must not
     sit behind an entry that keeps failing, which is why the retry is bounded and why
     only ENTRY events take this path at all. */
  ok("only entry events are retried", /if \(isTransientEntryFailure\(error\) && bumpEntryRetry\(key\)/.test(src) &&
    /ev\.type === "entry" && \(!intent \|\| \["planned", "failed", "expired"\]/.test(src));
  ok("an exit failure still falls through to the unchanged path",
    /if \(disposition === "not-held"\) log\(`EXIT \$\{ev\.symbol\} — not held`\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
