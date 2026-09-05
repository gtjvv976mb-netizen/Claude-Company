// The board reads `taken` off the wire, and the wire says 1, not true.
//
// Grox Mulder's wall shows what the floor actually HOLDS: offered calls the bot took.
// `taken` is SQLite's INTEGER 0/1 in copy.js and /api/floor/:n/feed serves it raw, so a
// strict `=== true` filter held nothing — through the first real fill (Shrek, call 55,
// 2026-09-05) the feed said taken:1 and the board said nothing was held. This runs the
// board's OWN filter against the real wire shape, not a fixture that politely says `true`.
import fs from "node:fs";
import assert from "node:assert/strict";

const view = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
const copy = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");

assert.match(copy, /taken\s+INTEGER NOT NULL DEFAULT 0/, "the schema stores taken as 0/1, which is what the feed serves");

const m = view.match(/const held = open\.filter\((\(c\) => [^\n]+)\);/);
assert.ok(m, "the board's held filter is where this test expects it");
const predicate = new Function(`return ${m[1]};`)();

const wire = [
  { call_id: 55, symbol: "Shrek", verdict: "offered", status: "live", taken: 1 },
  { call_id: 56, symbol: "TOAD", verdict: "offered", status: "live", taken: 0 },
  { call_id: 57, symbol: "BOOL", verdict: "offered", status: "live", taken: true },
  { call_id: 58, symbol: "NONE", verdict: "offered", status: "live", taken: null },
];
const held = wire.filter(predicate).map((c) => c.symbol);
console.log(`held from the wire shape: ${JSON.stringify(held)}`);
assert.deepEqual(held, ["Shrek", "BOOL"], "taken:1 (the wire) and taken:true both hold; 0 and null do not");
console.log("ok - grok board holds what the wire says is taken");
