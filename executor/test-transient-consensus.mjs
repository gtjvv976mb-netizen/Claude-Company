/**
 * A TWO-PROVIDER CONSENSUS FAILURE IS WEATHER, NOT A DECISION.
 *
 * The entry path prices a trade through two independent RPC views — the classic mint
 * audit (jupiter.mjs, which fixes the decimals the USD anchor is built on) and the Pyth
 * SOL-USD oracle (sol-usd-oracle.mjs) — and both fail closed when either provider's read
 * is rejected or the two views differ. Failing closed is correct and is not being
 * loosened here: a forged decimals byte moves the entry anchor by powers of ten.
 *
 * What was wrong is what happened NEXT. Neither message was on the transient allowlist,
 * so both landed on the acknowledge branch (poller.mjs, "entry acknowledged without a
 * trade") and ONE slow provider consumed a published call permanently — the same
 * dropped-packet-as-decision defect that ate TOAD, MACRODUCK, Hosico, TripleT, HeeHaw,
 * USWS across 2026-09-01 to 09-04 and that the allowlist was built to cure.
 *
 * The two dangerous directions are what this file asserts:
 *   - a blip must be RETRIED with the cursor pinned, not answered;
 *   - a real forgery must not pin the queue for ever — it keeps disagreeing, and after
 *     MAX_ENTRY_RETRIES the call is acknowledged exactly as before.
 * Plus the narrowness: the sibling failures that are configuration or an audited
 * rejection are still answered at once, on the first poll.
 */
import fs from "node:fs";
import { MINT_CONSENSUS_FIELDS } from "./token2022.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
const src = read("./poller.mjs"), jup = read("./jupiter.mjs"), oracle = read("./sol-usd-oracle.mjs");

/* The classifier, lifted from the source so the test cannot drift from it. */
const block = src.slice(src.indexOf("const TRANSIENT_ENTRY_FAILURE = ["),
  src.indexOf("const MAX_ENTRY_RETRIES"));
const patterns = [...block.matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1], m[2]));
const isTransient = (msg) => patterns.some((re) => re.test(msg));
const MAX = Number((src.match(
  /MAX_ENTRY_RETRIES = Math\.max\(1, Math\.min\(\d+, Number\(process\.env\.MAX_ENTRY_RETRIES\) \|\| (\d+)\)\)/) || [])[1]);

console.log("\nTHE MESSAGES ARE THE ONES THE CODE ACTUALLY THROWS");
{
  /* Asserted against the throwing files, not typed from memory: a reword of either
     error breaks this loudly instead of silently un-retrying the call again. */
  const mintReads = "classic mint consensus requires successful reads from both RPC providers";
  const mintDisagree = "classic mint RPC views disagree on ";
  const oracleReads = "independent SOL/USD oracle requires successful reads from both RPC providers";
  ok("jupiter.mjs throws the both-reads message verbatim", jup.includes(`"${mintReads}"`), mintReads);
  ok("jupiter.mjs throws the views-disagree message verbatim",
    jup.includes(`\`${mintDisagree}\${field}\``), `${mintDisagree}<field>`);
  ok("sol-usd-oracle.mjs throws the same both-reads shape", oracle.includes(`"${oracleReads}"`), oracleReads);
  ok("both consensus reads are on the ENTRY path, so the classification matters",
    /independentClassicMintDecimals\(conn, secondaryConn, ev\.mint\)/.test(src) &&
      /independentSolUsdPrice\(conn, secondaryConn\)/.test(src),
    "poller.mjs prices the entry through both");

  console.log("  every message the two consensus helpers can raise on a provider blip:");
  const blips = [mintReads, oracleReads, ...MINT_CONSENSUS_FIELDS.map((f) => mintDisagree + f)];
  for (const msg of blips) ok(`retried: ${msg}`, isTransient(msg));
}

console.log("\nAND THE ALLOWLIST STAYS NARROW — A DECISION IS STILL ANSWERED AT ONCE");
{
  /* Every one of these would be true again on the next poll, so retrying them burns the
     queue. The first two are misconfiguration, the next two are an audited REJECTION of
     a view that was read successfully, and the last is a different consensus entirely
     (a signed transaction's custody accounts) that this change deliberately leaves alone. */
  for (const msg of [
    "classic mint consensus requires two distinct RPC connections",
    "independent SOL/USD oracle requires two distinct RPC connections",
    "classic mint consensus rejected an RPC view: mint account is unavailable",
    "independent SOL/USD oracle rejected an RPC view: Pyth SOL/USD update is stale (95s old)",
    "RPC providers disagree on the validated transaction custody accounts",
  ]) ok(`answered at once: ${msg.slice(0, 62)}`, !isTransient(msg));
}

console.log("\nTHE RETRY LOOP, REPRODUCED FROM THE SOURCE BRANCH");
{
  /* The poller's own branch, transcribed. The source assertions below prove this model
     is the code's shape rather than a hopeful one. */
  const bump = (retries, key) => { const next = (retries.get(key) || 0) + 1; retries.set(key, next); return next; };
  const poll = (state, ev, error) => {
    const key = String(ev.event_id);
    if (isTransient(error) && bump(state.retries, key) <= MAX)
      return { verdict: "retry", attempt: state.retries.get(key), cursor: state.cursor };
    if (state.retries.has(key)) {
      const attempts = state.retries.get(key);
      state.retries.delete(key);
      state.cursor = ev.id;
      return { verdict: "gave up", attempt: attempts, cursor: state.cursor };
    }
    state.cursor = ev.id;
    return { verdict: "acknowledged", attempt: 0, cursor: state.cursor };
  };
  const PINNED = 100;
  const ev = { id: 101, event_id: "48:101", symbol: "BLIP" };

  ok("the ceiling is the poller's own, and it is short", Number.isFinite(MAX) && MAX <= 10,
    `MAX_ENTRY_RETRIES ${MAX} — about ${(MAX + 1) * 15}s of patience at a 15s poll`);

  for (const msg of ["classic mint consensus requires successful reads from both RPC providers",
    "classic mint RPC views disagree on decimals"]) {
    const state = { retries: new Map(), cursor: PINNED };
    const trace = [];
    for (let i = 1; i <= MAX + 1; i++) trace.push(poll(state, ev, msg));
    const retried = trace.filter((t) => t.verdict === "retry");
    console.log(`  "${msg.slice(0, 44)}…": ` +
      trace.map((t, i) => `poll ${i + 1} ${t.verdict}@cursor ${t.cursor}`).join(" | "));
    ok(`${msg.slice(0, 38)}…: retried ${MAX} times before anything is consumed`,
      retried.length === MAX && retried.every((t) => t.cursor === PINNED),
      `attempts ${retried.map((t) => t.attempt).join(",")}, cursor pinned at ${PINNED} throughout`);
    /* The counter reported on the give-up poll is MAX + 1, not MAX: the source's
       `isTransientEntryFailure(error) && bumpEntryRetry(key) <= MAX_ENTRY_RETRIES` bumps
       BEFORE it compares, so the poll that gives up has counted itself. Pinned as it
       actually is — the live log's "gave up after 7 transient attempts" follows six
       retries — rather than asserting a number the code does not produce. */
    ok("...and the last poll acknowledges rather than retrying for ever",
      trace[MAX].verdict === "gave up" && trace[MAX].cursor === ev.id && trace[MAX].attempt === MAX + 1,
      `${MAX} retries, then poll ${MAX + 1} gave up (reported as ${trace[MAX].attempt} attempts), ` +
      `cursor advanced ${PINNED} -> ${trace[MAX].cursor}`);
    ok("...and the retry count is dropped once the call is answered",
      state.retries.size === 0, `${state.retries.size} keys left`);
  }

  const cfg = { retries: new Map(), cursor: PINNED };
  const first = poll(cfg, ev, "classic mint consensus requires two distinct RPC connections");
  ok("a misconfiguration is consumed on the FIRST poll, with no retry at all",
    first.verdict === "acknowledged" && first.attempt === 0 && first.cursor === ev.id,
    `${first.verdict} at poll 1, cursor ${PINNED} -> ${first.cursor}`);
}

console.log("\nTHE SOURCE DOES WHAT THIS MODEL SAYS");
{
  ok("a transient entry failure retries against the same ceiling",
    /if \(isTransientEntryFailure\(error\) && bumpEntryRetry\(key\) <= MAX_ENTRY_RETRIES\) \{/.test(src));
  ok("a retry leaves the cursor where it is", /the call stays on the feed`\);\s*\n\s*break;/.test(src));
  ok("exhausting the retries acknowledges the call and clears its count",
    /gave up after[\s\S]{0,160}entryRetries\.delete\(key\);\s*\n\s*S\.cursor = Number\(ev\.id\); save\(\); continue;/.test(src));
  ok("the ceiling is still env-overridable", /Number\(process\.env\.MAX_ENTRY_RETRIES\) \|\| \d+/.test(src));
  ok("the two new patterns are in the allowlist and nowhere else",
    patterns.filter((re) => /reads from both RPC providers|views disagree/.test(re.source)).length === 2,
    patterns.filter((re) => /reads from both RPC providers|views disagree/.test(re.source)).map(String).join(" "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
