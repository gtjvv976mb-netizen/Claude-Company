/* THE PAGE'S ONE VOCABULARY, EXECUTED — NOT DESCRIBED.
 *
 * The PLAIN block in office3d.html is DOM-free so it can be lifted out and run here.
 * Every sentence a user can read is proved to carry no internal code, no provider error
 * and no team id; the tables the tape, the decision record and the roster share are
 * exercised with the exact payloads the chronicle emits. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
let pass = 0; const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };

const start = html.indexOf("/* PLAIN:BEGIN"), end = html.indexOf("/* PLAIN:END */");
assert.ok(start > 0 && end > start, "the PLAIN block must exist between its markers");
const block = html.slice(start, end);
const sandbox = { window: {}, console };
vm.runInNewContext(block, sandbox, { filename: "office3d.html#PLAIN" });
const P = sandbox.window.PLAIN;
assert.ok(P && typeof P.event === "function", "PLAIN must land on window");

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHOUT = /\b[A-Z][A-Z_]{4,}\b/;            // CREDIT_OUTAGE, SCREENED_OUT, INACTIVE…
const ISO_ID = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/;

console.log("\nROLES");
ok("a seat is named by its plain role, however it is keyed", () => {
  for (const [k, v] of [["Liquidity", "exit check"], ["liquidity", "exit check"], ["ETHAN HUNTED", "exit check"],
    ["Red Team", "devil's advocate"], ["redteam", "devil's advocate"], ["XRead", "story check"], ["TrendScan", "story check"],
    ["MAXWELL SMORT", "the first screen"], ["Screener", "the first screen"], ["Floor", "desk"], ["CEO", "the CEO"]])
    assert.equal(P.role(k), v, `${k} -> ${P.role(k)}`);
});

console.log("\nDECISIONS");
ok("CREDIT_OUTAGE is SKIPPED with a sentence, never the code", () => {
  const d = P.decision("credit_outage", "the analyst seats cannot run for another 60s — nothing was bought for this coin");
  assert.equal(d.chip, "SKIPPED"); assert.doesNotMatch(d.sentence, /_/); assert.match(d.sentence, /could not run/);
});
ok("a screened-out coin says why in words", () => {
  const d = P.decision("screened_out", "post_migration_dump");
  assert.equal(d.chip, "TURNED DOWN"); assert.match(d.sentence, /sold off right after launch/); assert.doesNotMatch(d.sentence, /_/);
});
ok("an unknown code falls back to a sentence, lowercased, no underscores", () => {
  const d = P.decision("some_future_outcome");
  assert.equal(d.chip, "FINISHED"); assert.match(d.sentence, /reason on file/); assert.doesNotMatch(d.sentence, /_|[A-Z]{3,}/);
});
ok("close reasons read as words", () => {
  assert.equal(P.closeReason("target_hit"), "target hit"); assert.equal(P.closeReason("invalidated"), "reason broke");
  assert.doesNotMatch(P.closeReason("weird_new_reason"), /_/);
});

console.log("\nEVENTS — the exact payloads the chronicle emits");
ok("a provider failure never shows the error body, the status code or the team id", () => {
  const r = P.event({ type: "seat:failed", seat: "TrendScan", error: "xai 403: \"Your team 7fce2f04-3025-4e0c-9f1d-4722ee3cb8ac has either used all available credits or reached its monthly spending limit.\"" });
  assert.equal(r.text, "story check could not run this time");
  assert.doesNotMatch(r.text, UUID); assert.doesNotMatch(r.text, /403|xai|credit/i);
});
ok("a round never shows its ISO id", () => {
  const r = P.event({ type: "cycle:start", cycle: "2026-09-07T19-45-00-000Z", cycleId: 21 });
  assert.equal(r.text, "Round started"); assert.doesNotMatch(r.text, ISO_ID);
});
ok("a halted round says why in words", () => {
  assert.equal(P.event({ type: "cycle:halted", reason: "out_of_credit" }).text, "Round paused — the analysts could not run");
  assert.equal(P.event({ type: "cycle:halted", reason: "hunt_budget" }).text, "Round paused — research budget reached");
});
ok("a finished study is chatter, worded from the decision table", () => {
  const r = P.event({ type: "token:end", outcome: "killed", symbol: "BILL", detail: "post_migration_dump" });
  assert.equal(r.chatter, true); assert.match(r.text, /BILL — turned down/); assert.match(r.text, /sold off right after launch/);
});
ok("a withheld call names the gate in words", () => {
  const r = P.event({ type: "call:withheld", symbol: "NVDAx", gate: "freezable" });
  assert.equal(r.text, "NVDAx held back — the contract can be frozen");
});
ok("world ambience, thinking ticks and cache hits stay off the tape", () => {
  for (const t of ["world:snack", "world:visit", "seat:thinking", "seat:searching", "xread:cached", "fresh:skipped_repeat", "desk:out_of_credit"])
    assert.equal(P.event({ type: t }), null, t);
});
ok("the who column is a role, never a spy name or a raw seat id", () => {
  assert.equal(P.event({ type: "seat:verdict", seat: "Liquidity", score: 71 }).who, "exit check");
  assert.equal(P.event({ type: "whales", symbol: "SOLCAT", uniqueBuyers: 0, netUsd: 0 }).who, "big wallets");
});
ok("SWEEP: every event type in the table yields a sentence with no shouted code, no id, no provider text", () => {
  let seen = 0;
  for (const type of P.eventTypes) {
    const r = P.event({ type, symbol: "TEST", seat: "Flow", mint: "AbCdEf123456789xyz", count: 2, published: 1, quota: 3,
      reason: "out_of_credit", gate: "post_migration_dump", stopped: "out of credit mid-hunt", usedUsd: 3.2, capUsd: 200,
      heldHours: 2, total: 300, uniqueBuyers: 2, netUsd: 4100, outcome: "killed", detail: "wash_suspect", score: 40, error: "xai 403 team 7fce2f04-3025-4e0c-9f1d-4722ee3cb8ac" });
    if (!r) continue; seen++;
    assert.doesNotMatch(r.text, SHOUT, `${type}: "${r.text}"`);
    assert.doesNotMatch(r.text, UUID, type); assert.doesNotMatch(r.text, /403|xai/i, type); assert.doesNotMatch(r.text, ISO_ID, type);
    assert.doesNotMatch(r.who, /[A-Z]{3,}/, `${type}: who "${r.who}"`);
  }
  assert.ok(seen >= 20, `expected the table to render at least 20 kinds, rendered ${seen}`);
  console.log(`       ${seen} event kinds rendered, ${P.eventTypes.length - seen} hidden by design`);
});

console.log("\nINTEGRATION, AT SOURCE LEVEL");
ok("fmtTape delegates to PLAIN and hides chatter unless asked", () => {
  const i = html.indexOf("function fmtTape(e) {"); assert.ok(i > 0, "fmtTape exists");
  const fn = html.slice(i, html.indexOf("\n}\n", i));
  assert.match(fn, /window\.PLAIN\.event\(e\)/); assert.match(fn, /p\.chatter && !window\.__showChatter/);
  assert.doesNotMatch(fn, /case "cycle:start"/, "the old switch must be gone");
});
ok("the tape has a Show-analyst-chatter toggle that follows Detailed view", () => {
  for (const t of ['className = "tape-tools"', '"Show analyst chatter"', 'localStorage.getItem("cc_detailed")', "window.__reloadTape"])
    assert.ok(html.includes(t), `page must contain ${t}`);
});
ok("memoNode paints the decision chip from the table", () => {
  const i = html.indexOf("function memoNode("); assert.ok(i > 0, "memoNode exists");
  const fn = html.slice(i, html.indexOf("\n}\n", i));
  assert.match(fn, /window\.PLAIN\.decision\(decision\)/); assert.doesNotMatch(fn, /\.textContent = decision;/);
});
ok("the anatomy primitives and the Detailed-view gate exist and openDialog is shared", () => {
  for (const s of ["const readerOf = ", "const detailedView = ", "const plainLead = ", "const chipRow = ", "const leadButton = ", "const detailsFold = ", "window.openDialog = openDialog;", ".plainlead{", ".chiprow{", ".info-btn{"])
    assert.ok(html.includes(s), s);
});

console.log(`\n${pass} passed — one vocabulary, executed\n`);
