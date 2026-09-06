/**
 * A DEAD ACCOUNT MUST STOP THE DESK, AND A STOPPED DESK MUST REST.
 *
 * Two defects measured on 2026-09-06 while both provider accounts were empty:
 *
 *   1. lib/llm.js throws OutOfCredit when the balance is gone, and penthouse.js:773 has
 *      always had the handler that halts the cycle on it. It never fired, because desk.js
 *      runs its seats through Promise.allSettled, which turns every rejection into a value.
 *      The throw was filed beside a timeout as an ordinary "seat failure" and the workup
 *      returned outcome "insufficient_coverage" — a billing failure wearing a research
 *      verdict. Measured: 1,323 refused Anthropic requests an hour, 92% of candidates
 *      ending insufficient_coverage, and 2 cycle:halted events in 3.2 hours.
 *
 *   2. index.js chose the next gap by testing workedUp BEFORE stopped, so a cycle that
 *      worked up fifteen coins and then hit the wall took GAP_WORKED (45s) instead of
 *      GAP_BLOCKED (600s) — the fast path, at the moment the desk could do nothing.
 *      Measured: cycles restarting every 114s where the blocked path asks for 600.
 *
 * Both are silent: nothing here fails loudly, it just spends the day retrying.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { OutOfCredit, BudgetExhausted } from "./src/lib/llm.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};

console.log("\n1. A CREDIT REFUSAL IS NOT A SEAT FAILURE");
{
  // The exact discrimination desk.js's collect() performs on a settled rejection.
  const isCredit = (reason) => reason instanceof OutOfCredit;

  const dead = new OutOfCredit("the Anthropic balance is empty — the desk cannot think");
  const capped = new BudgetExhausted("daily provider budget spent: $200.00 of $200 in 24h");
  const timeout = new Error("fetch failed");
  const badJson = new SyntaxError("Unexpected token < in JSON at position 0");

  ok("the empty-balance throw is recognised", isCredit(dead), dead.message.slice(0, 48));
  ok("so is the desk's own daily cap, which extends it", isCredit(capped),
    `BudgetExhausted instanceof OutOfCredit = ${capped instanceof OutOfCredit}`);
  ok("a timeout is NOT a credit failure and must not stop the desk", !isCredit(timeout), timeout.message);
  ok("nor is a malformed response", !isCredit(badJson), badJson.message.slice(0, 40));

  // Promise.allSettled is what hid it: the rejection survives as a value.
  const settled = [
    { status: "fulfilled", value: { score: 7 } },
    { status: "rejected", reason: dead },
    { status: "rejected", reason: timeout },
  ];
  const credit = settled.filter((r) => r.status === "rejected" && isCredit(r.reason));
  const ordinary = settled.filter((r) => r.status === "rejected" && !isCredit(r.reason));
  ok("a settled batch still surfaces the credit refusal", credit.length === 1,
    `${credit.length} credit, ${ordinary.length} ordinary, ${settled.length} total`);
  ok("...and the ordinary failure is left to be tolerated as before", ordinary.length === 1);
}

console.log("\n2. desk.js LETS IT ESCAPE BOTH SETTLED BATCHES");
{
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  ok("OutOfCredit is imported at all", /import\s*\{[^}]*OutOfCredit[^}]*\}\s*from\s*"\.\/lib\/llm\.js"/.test(src),
    (src.match(/import\s*\{[^}]*\}\s*from\s*"\.\/lib\/llm\.js";/) || ["(none)"])[0].slice(0, 70));
  ok("collect() remembers a credit rejection", /creditFailure = creditFailure \?\? r\.reason/.test(src));

  const throws = [...src.matchAll(/if \(creditFailure\) throw creditFailure;/g)];
  ok("and the workup rethrows it, after BOTH batches", throws.length === 2,
    `${throws.length} rethrow site(s); expected one after the cheap trio and one after forensics+narrative`);

  // Order matters: every seat in the batch must report before the cycle stops.
  const cheapAt = src.indexOf("cheap.forEach((r, i) => collect(cheapKeys[i], r));");
  const firstThrow = src.indexOf("if (creditFailure) throw creditFailure;");
  ok("the rethrow follows the collect, so the other seats still record", cheapAt > 0 && firstThrow > cheapAt,
    `collect@${cheapAt} < throw@${firstThrow}`);

  /* Match the RETURN, not the prose. The first two mentions of insufficient_coverage in
     this file are the comment above the fix explaining the incident, and an earlier draft
     of this assertion matched those and failed on correct code. Anchor on the emit that
     actually ends the workup. */
  const returnAt = src.indexOf(`emit("token:end", { mint, symbol: ev.symbol, outcome: "insufficient_coverage" })`);
  const lastThrow = src.lastIndexOf("if (creditFailure) throw creditFailure;");
  ok("...and BOTH rethrows precede the insufficient_coverage return they were mistaken for",
    returnAt > 0 && lastThrow > 0 && lastThrow < returnAt,
    `last throw@${lastThrow} < return@${returnAt}`);
}

console.log("\n3. penthouse ALREADY KNEW WHAT TO DO WITH IT");
{
  const p = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  ok("the halt handler exists and sets stopped", /if \(e instanceof OutOfCredit\)/.test(p) && /stopped = e\.constructor\.name === "BudgetExhausted"/.test(p));
  ok("and it distinguishes an empty account from our own cap",
    /"daily budget reached"/.test(p) && /"out of credit"/.test(p));
}

console.log("\n4. A STOPPED CYCLE RESTS, HOWEVER BUSY IT WAS FIRST");
{
  const idx = fs.readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
  const stoppedAt = idx.indexOf("if (r?.stopped || r?.skipped === \"budget\")");
  const workedAt = idx.indexOf("(r.workedUp ?? 0) > 0");
  ok("stopped is tested BEFORE workedUp", stoppedAt > 0 && workedAt > 0 && stoppedAt < workedAt,
    `stopped@${stoppedAt} < workedUp@${workedAt}`);

  // The branch as written, evaluated against the case that was mischosen.
  const gapFor = (r) => {
    if (r?.stopped || r?.skipped === "budget") return "BLOCKED";
    if (r && ((r.workedUp ?? 0) > 0 || (r.opened ?? 0) > 0)) return "WORKED";
    if (r?.skipped === "position_open") return "IDLE";
    return "IDLE";
  };
  ok("a cycle that worked 15 coins then hit the wall now backs off",
    gapFor({ workedUp: 15, opened: 0, stopped: "out of credit" }) === "BLOCKED",
    `workedUp=15 stopped="out of credit" -> ${gapFor({ workedUp: 15, opened: 0, stopped: "out of credit" })} (was WORKED)`);
  ok("a genuinely productive cycle still takes the fast gap",
    gapFor({ workedUp: 8, opened: 2, stopped: null }) === "WORKED");
  ok("the daily cap also rests", gapFor({ workedUp: 20, skipped: "budget" }) === "BLOCKED");
  ok("a full book is not a stall", gapFor({ workedUp: 0, skipped: "position_open" }) === "IDLE");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
