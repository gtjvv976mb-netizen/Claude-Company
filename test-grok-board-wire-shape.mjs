// The board reads the bot's OWN report off the wire, and the wire says 1, not true.
//
// Grox Mulder's wall shows what the floor actually HOLDS. Until 2026-09-05 that was read
// off the desk's delivery row alone — live on the desk and taken:1 — which is the desk's
// paper book wearing the bot's name: on Shrek (call 55) the bot filled 0.0175 SOL, the
// board printed the desk's 0.4, the bot sold at 03:01:42Z on its own normalised stop and
// the wall kept the position until the desk's stop_hit landed at 03:10:24Z. Now the feed
// carries the bot's fill reports as bot_* fields (copy.js feedFor) and ONE predicate,
// botOpen, decides what is held: the bot's status first, the old reading only when the
// bot has never reported on the call. This runs the board's OWN predicate — and the
// board's own update function — against the real wire shapes, not a fixture that
// politely says `true`.
import fs from "node:fs";
import assert from "node:assert/strict";

const view = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
const copy = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");

assert.match(copy, /taken\s+INTEGER NOT NULL DEFAULT 0/, "the schema stores taken as 0/1, which is what the feed serves");

/* ── THE PREDICATE, EXTRACTED FROM THE PAGE ─────────────────────────────────── */
const pm = view.match(/^const botOpen = (\(c\) => [^\n]+);$/m);
assert.ok(pm, "the board's botOpen predicate is a one-line const where this test expects it");
const botOpen = new Function(`return ${pm[1]};`)();
assert.match(view, /const open = feed\.filter\(\(c\) => c\.verdict === "offered"\);/,
  "open is every OFFERED row — not pre-filtered by the desk's status, because a bot-open position on a desk-closed call is still held");
assert.match(view, /const held = open\.filter\(botOpen\);/, "held is open filtered by that one predicate");

const wire = [
  // the bot reported a buy and no sell; the desk has already closed the call. Still held:
  // the tokens are in the wallet until the bot's exit report lands.
  { call_id: 55, symbol: "Shrek-open-desk-closed", verdict: "offered", status: "closed", taken: 1, bot_status: "open" },
  // the bot reported a sell; the desk still says live and the delivery row still says taken.
  // NOT held — this is the nine minutes the wall lied about.
  { call_id: 55, symbol: "Shrek-closed-desk-live", verdict: "offered", status: "live", taken: 1, bot_status: "closed" },
  // no bot report at all: the old reading — live and taken:1 (the wire) holds …
  { call_id: 56, symbol: "TOAD-null-live-1", verdict: "offered", status: "live", taken: 1, bot_status: null },
  // … taken:true (a polite fixture) holds …
  { call_id: 57, symbol: "BOOL-null-live-true", verdict: "offered", status: "live", taken: true, bot_status: null },
  // … a row with the field ABSENT (a feed older than fill reporting) behaves as null …
  { call_id: 57, symbol: "OLD-absent-live-1", verdict: "offered", status: "live", taken: 1 },
  // … and 0 / null do not hold …
  { call_id: 58, symbol: "TOAD-null-live-0", verdict: "offered", status: "live", taken: 0, bot_status: null },
  { call_id: 59, symbol: "NONE-null-live-null", verdict: "offered", status: "live", taken: null, bot_status: null },
  // … nor does a desk-closed call the bot never reported on, whatever taken says.
  { call_id: 60, symbol: "GONE-null-closed-1", verdict: "offered", status: "closed", taken: 1, bot_status: null },
];
const held = wire.filter(botOpen).map((c) => c.symbol);
console.log(`held from the wire shapes: ${JSON.stringify(held)}`);
assert.deepEqual(held, ["Shrek-open-desk-closed", "TOAD-null-live-1", "BOOL-null-live-true", "OLD-absent-live-1"],
  "bot open holds even when the desk closed; bot closed drops even when the desk is live and taken:1; without a bot report, live+taken(1|true) holds and 0/null/desk-closed do not");

/* ── THE UPDATE FUNCTION, DRIVEN WITH THE FEED SHAPE ────────────────────────────
 * Lift window.__grokBoardUpdate out of the page and run it with the three draw calls
 * stubbed, so size, P&L basis, exposure and the realised-today sum are measured on the
 * real code rather than pinned as strings. */
const start = view.indexOf("window.__grokBoardUpdate = (feed = []) => {");
assert.ok(start > 0, "the update function is where this test expects it");
const end = view.indexOf("\n};\n", start);
const updateSrc = view.slice(start, end + 4);
const bm = view.match(/^const botMs = \(ts\) => \{[\s\S]*?\n\};$/m);
assert.ok(bm, "the bot-timestamp normaliser is a top-level const");
const win = {};
const grokBook = { positions: [], record: null };
const draws = { board: 0, tickets: 0, boss: 0 };
const update = new Function("window", "grokBook", "drawGrokBoard", "drawGrokTickets", "drawBossBoard", "botOpen",
  `${bm[0]}\n${updateSrc}\nreturn window.__grokBoardUpdate;`)(
  win, grokBook, () => draws.board++, () => draws.tickets++, () => draws.boss++, botOpen);

const now = Date.now();
const utcMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
const feed = [
  // Shrek as the wire carried it after the bot's buy report: the desk sized 0.4, the bot paid 0.0175.
  { call_id: 55, symbol: "Shrek", verdict: "offered", status: "live", taken: 1, category: "memecoin",
    size_sol: 0.4, entry_ref: 0.001, target: 0.002, last_mark: 0.0012, mcap_at_call: 1_000_000,
    bot_status: "open", bot_size_sol: 0.0175, bot_entry_mark: 0.0010, bot_opened_at: now - 60_000 },
  // a call the bot never reported on: paper size, P&L from the desk's entry_ref
  { call_id: 61, symbol: "PAPER", verdict: "offered", status: "live", taken: 1, category: "memecoin",
    size_sol: 0.3, entry_ref: 1, target: 2, last_mark: 0.9, mcap_at_call: 500_000, bot_status: null },
  // sold by the bot this UTC day while the desk still says live: not held, counted in realised
  { call_id: 62, symbol: "SOLD", verdict: "offered", status: "live", taken: 1, size_sol: 0.4, entry_ref: 1,
    bot_status: "closed", bot_size_sol: 0.02, bot_realized_sol: -0.0027, bot_closed_at: Math.max(utcMidnight + 1, now - 1000) },
  // sold yesterday (before UTC midnight): not in today's realised sum
  { call_id: 63, symbol: "YDAY", verdict: "offered", status: "closed", taken: 1, size_sol: 0.4, entry_ref: 1,
    bot_status: "closed", bot_size_sol: 0.02, bot_realized_sol: 5, bot_closed_at: utcMidnight - 1 },
  // sold this UTC day, reported in SECONDS: still today's
  { call_id: 64, symbol: "SECS", verdict: "offered", status: "closed", taken: 1, size_sol: 0.4, entry_ref: 1,
    bot_status: "closed", bot_size_sol: 0.02, bot_realized_sol: 0.0010, bot_closed_at: Math.floor(Math.max(utcMidnight + 1000, now - 1000) / 1000) },
  // passed by the floor: never on the board whatever the bot says
  { call_id: 65, symbol: "PASSED", verdict: "passed", status: "live", taken: 0, size_sol: 0.4, bot_status: "open", bot_size_sol: 1 },
];
update(feed);
const book = win.__liveBook;
console.log(`__liveBook: ${JSON.stringify(book)}`);
console.log(`positions: ${JSON.stringify(grokBook.positions)}`);
assert.equal(book.taken, 2, `taken counts the bot-open set, actual ${book.taken}`);
assert.equal(grokBook.positions.map((p) => p.symbol).join(","), "Shrek,PAPER",
  `the board carries exactly the held rows, actual ${grokBook.positions.map((p) => p.symbol).join(",")}`);
const shrek = grokBook.positions[0], paper = grokBook.positions[1];
assert.equal(shrek.size, 0.0175, `the bot's real size, not the desk's 0.4, actual ${shrek.size}`);
assert.equal(shrek.real, true, `a reported size is marked real, actual ${shrek.real}`);
assert.equal(paper.size, 0.3, `a row without a bot report keeps the desk's size, actual ${paper.size}`);
assert.equal(paper.real, false, `…and is marked paper, actual ${paper.real}`);
assert.ok(Math.abs(shrek.pnlPct - 20) < 1e-9, `P&L is measured from bot_entry_mark (0.0010 → 0.0012 = +20%), actual ${shrek.pnlPct}`);
assert.ok(Math.abs(paper.pnlPct - -10) < 1e-9, `…and from entry_ref when the bot never reported, actual ${paper.pnlPct}`);
assert.ok(Math.abs(book.exposureSol - 0.3175) < 1e-9, `exposure sums the sizes on the board (0.0175 + 0.3), actual ${book.exposureSol}`);
assert.ok(Math.abs(book.realizedTodaySol - (-0.0027 + 0.0010)) < 1e-9,
  `realised today sums bot_realized_sol closed since UTC midnight (ms and seconds), excluding yesterday's, actual ${book.realizedTodaySol}`);
assert.equal(book.liveCalls, 4, `live calls still counts the desk's live rows, actual ${book.liveCalls}`);
assert.equal(book.open, 3, `offered-to-this-floor still counts live offered rows, actual ${book.open}`);
assert.deepEqual(draws, { board: 1, tickets: 1, boss: 1 }, `one update repaints all three walls, actual ${JSON.stringify(draws)}`);

// Flat wire: nothing offered — the book is empty and realised today is 0, not null, so the
// wall prints "+0.0000 SOL" rather than a dash.
update([]);
console.log(`flat __liveBook: ${JSON.stringify(win.__liveBook)}`);
assert.equal(win.__liveBook.taken, 0, `nothing held on an empty feed, actual ${win.__liveBook.taken}`);
assert.equal(win.__liveBook.realizedTodaySol, 0, `realised today is a number on an empty feed, actual ${win.__liveBook.realizedTodaySol}`);

/* ── THE WALL NEVER FREEZES ON ANOTHER PANE ─────────────────────────────────── */
assert.match(view, /if \(hudOnly\) \{[\s\S]{0,700}?window\.__grokBoardUpdate\?\.\(body\.feed \|\| \[\]\);[\s\S]{0,200}?return;/,
  "the hudOnly loadCalls path feeds the board before it returns");

console.log("ok - grok board holds what the bot says it holds, and what the wire says is taken when the bot has not spoken");
