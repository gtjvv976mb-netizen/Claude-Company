/**
 * HAWK-AI'S BOOK, TESTED AS A RECORD RATHER THAN AS A RENDER.
 *
 * The owner asked, on 2026-09-17, "where will users verify the performance and trades and
 * profit of HAWK-AI", and then "make his own HAWK-AI board". That is a question about
 * TRUST, so the assertions below are about the three ways a board like this lies:
 *
 *   1. IT DISAGREES WITH THE LEDGER BESIDE IT. The risk ledger already computed each exit's
 *      realised result once, pro rata against the basis, and wrote it in the same
 *      transaction that accounted the intent. So every realised number here is asserted
 *      EQUAL to `risk_events.realized_lamports` for the same intent — and the partial exit
 *      below exists purely to make that non-trivial, because full-size exits (all HAWK-AI
 *      has ever made) cannot tell the two arithmetics apart.
 *   2. IT SHOWS THE UNKNOWN AS BREAK-EVEN. A trade whose result cannot be read must arrive
 *      as `null` and stay `null` through the sanitizer and onto the page — never as 0,
 *      which is the number that means "closed flat".
 *   3. IT SHOWS A WINDOW AS THE RECORD. The read is capped; the count is not. A total that
 *      covers 200 of 500 trades must not be headed "500 closed trades".
 *
 * And the one attribution question this file exists to settle: BOTH LANES SHARE ONE WALLET
 * AND ONE JOURNAL, so a desk exit is written into the same table as a snipe exit. Every
 * positive assertion below is therefore paired with a desk exit that must NOT appear.
 *
 * House rules: every guard is exercised in both directions, every assertion prints the
 * actual value, and the known-answer arithmetic is stated in the test rather than copied
 * from the code it is checking. No network, no clock, no keypair, no signing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { ExecutionJournal } from "./journal.mjs";
import { freshState } from "./strategy.mjs";
import { sanitizeExecutorSnipe } from "../src/office.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hawk-board-"));
const file = path.join(dir, "state.sqlite");
const wallet = Keypair.generate().publicKey.toBase58();
let j = new ExecutionJournal(file, { wallet });

const WSOL = "So11111111111111111111111111111111111111112";
let seq = 0;

/* Drive one trade all the way to `accounted`, the same way the lane does: plan, sign,
   submit, confirm with the chain's own totals, account. Nothing is stubbed — these are the
   journal's real write paths, because a board read from rows that were inserted by hand
   proves nothing about the rows the bot actually writes. */
function closeTrade({ kind, mint, qtyRaw, basisLamports, inputRaw, outputLamports, feeLamports, at, reason }) {
  const n = ++seq;
  const id = `${kind === "snipe_exit" ? "snipe-exit" : "desk-exit"}:${n}`;
  j.ensureIntent({
    id, kind, eventId: `${n}:${kind}:${n}`, feedId: n,
    mint, inputMint: mint, outputMint: WSOL, amountRaw: String(inputRaw),
    context: { reason, position: { mint, qtyRaw: String(qtyRaw), costBasisLamports: String(basisLamports) } },
  });
  j.recordSigned(id, {
    attempt: 1, requestId: `request-${n}`, signedTx: Buffer.from(`bytes-${n}`),
    signature: `signature-${n}`, blockhash: `blockhash-${n}`, lastValidBlockHeight: 1000 + n,
    quotedOutputRaw: String(outputLamports), minOutputRaw: String(outputLamports),
    order: { router: "pumpfun" },
  });
  j.markSubmitted(id, 1);
  j.markConfirmed(id, 1, {
    totalInputAmount: String(inputRaw), totalOutputAmount: String(outputLamports),
    networkFeeLamports: String(feeLamports), signature: `signature-${n}`, finalizedAtMs: at,
  }, { status: "Success", code: 0, signature: `signature-${n}` });
  j.markAccounted(id, { cursor: n, primed: true, state: freshState(1), positions: {} });
  return id;
}

const mintA = Keypair.generate().publicKey.toBase58();
const mintB = Keypair.generate().publicKey.toBase58();
const mintC = Keypair.generate().publicKey.toBase58();
const mintD = Keypair.generate().publicKey.toBase58();
const T0 = 1_760_000_000_000;

/* ── THE FOUR TRADES, WITH THE ANSWER WORKED OUT HERE ──────────────────────────────────
   Stated as arithmetic in the test so a change to the code cannot quietly change what
   "correct" means. */

/* A WIN, sold in full: 0.745 SOL back, 5000 lamports of fee, against a 0.4 SOL basis. */
const winId = closeTrade({ kind: "snipe_exit", mint: mintA, qtyRaw: 1_000_000, basisLamports: 400_000_000,
  inputRaw: 1_000_000, outputLamports: 745_000_000, feeLamports: 5_000, at: T0 + 1_000, reason: "take" });
const WIN = 745_000_000 - 5_000 - 400_000_000;               // 344_995_000

/* A LOSS, sold in full. A board that cannot show this one is not a board. */
const lossId = closeTrade({ kind: "snipe_exit", mint: mintB, qtyRaw: 2_000_000, basisLamports: 300_000_000,
  inputRaw: 2_000_000, outputLamports: 200_000_000, feeLamports: 5_000, at: T0 + 2_000, reason: "stop" });
const LOSS = 200_000_000 - 5_000 - 300_000_000;              // -100_005_000

/* A PARTIAL EXIT — half the position. The ledger charges HALF the basis (400_000_000 * 500
   / 1000 = 200_000_000), so the answer is a small WIN. The arithmetic this method used in
   its first draft charged the whole 0.4 SOL and would report a 0.15 SOL LOSS on the very
   same row: opposite sign, which is why this case is here. */
const partialId = closeTrade({ kind: "snipe_exit", mint: mintC, qtyRaw: 1_000, basisLamports: 400_000_000,
  inputRaw: 500, outputLamports: 250_000_000, feeLamports: 5_000, at: T0 + 3_000, reason: "creator_exit" });
const PARTIAL = 250_000_000 - 5_000 - (400_000_000 * 500 / 1_000);   // 49_995_000
const PARTIAL_IF_NAIVE = 250_000_000 - 5_000 - 400_000_000;          // -150_005_000

/* THE DESK'S OWN EXIT, on the same wallet, in the same table, a millisecond later so it
   would sort to the top of any read that failed to filter by kind. */
const deskId = closeTrade({ kind: "desk_exit", mint: mintD, qtyRaw: 3_000_000, basisLamports: 100_000_000,
  inputRaw: 3_000_000, outputLamports: 900_000_000, feeLamports: 5_000, at: T0 + 4_000, reason: "desk" });

console.log("\nthe journal's own record");
const rows = j.snipeExits({ limit: 50 });
const byMint = Object.fromEntries(rows.map((r) => [r.mint, r]));

ok("three snipe exits, and only three", rows.length === 3, `${rows.length} rows`);
ok("the desk's exit is not in the sniper's book", !rows.some((r) => r.mint === mintD),
  `mints: ${rows.map((r) => r.mint.slice(0, 4)).join(", ")} (desk was ${mintD.slice(0, 4)})`);
ok("the desk's exit really was written to the same journal",
  j.getIntent(deskId)?.state === "accounted", `desk intent is ${j.getIntent(deskId)?.state}`);

ok("the win is the win", byMint[mintA]?.realizedLamports === String(WIN),
  `${byMint[mintA]?.realizedLamports} (expected ${WIN})`);
ok("the loss stays negative", byMint[mintB]?.realizedLamports === String(LOSS),
  `${byMint[mintB]?.realizedLamports} (expected ${LOSS})`);
ok("a partial exit is charged its pro-rata basis, not the whole position's",
  byMint[mintC]?.realizedLamports === String(PARTIAL),
  `${byMint[mintC]?.realizedLamports} (expected ${PARTIAL}; the naive arithmetic gives ${PARTIAL_IF_NAIVE})`);
ok("that partial case can tell the two arithmetics apart", PARTIAL > 0 && PARTIAL_IF_NAIVE < 0,
  `${PARTIAL} vs ${PARTIAL_IF_NAIVE} — opposite signs`);

/* THE RULER, VALIDATED AGAINST THE LEDGER ITSELF. */
const ledgerRealized = (id) => {
  const row = j.db.prepare("SELECT realized_lamports FROM risk_events WHERE intent_id=? AND kind='realized'").get(id);
  return row ? String(row.realized_lamports) : null;
};
for (const [label, id, mint] of [["win", winId, mintA], ["loss", lossId, mintB], ["partial", partialId, mintC]]) {
  ok(`the board agrees with the risk ledger on the ${label}`,
    byMint[mint]?.realizedLamports === ledgerRealized(id),
    `board ${byMint[mint]?.realizedLamports} vs ledger ${ledgerRealized(id)}`);
}

ok("each row carries the basis it closed against", byMint[mintA]?.basisLamports === "400000000",
  String(byMint[mintA]?.basisLamports));
ok("each row carries the reason the bot sold", byMint[mintA]?.reason === "take" && byMint[mintB]?.reason === "stop",
  `${byMint[mintA]?.reason} / ${byMint[mintB]?.reason}`);
ok("newest first", rows[0].mint === mintC && rows[2].mint === mintA,
  rows.map((r) => `${r.mint.slice(0, 4)}@${r.closedAt}`).join(" "));

console.log("\nbounds, windows and the count");
ok("the count counts every closed trade", j.snipeExitCount() === 3, `${j.snipeExitCount()}`);
ok("the count is the sniper's alone, like the rows", j.snipeExitCount() === rows.length,
  `${j.snipeExitCount()} counted, ${rows.length} read`);
const one = j.snipeExits({ limit: 1 });
ok("limit truncates the read", one.length === 1, `${one.length} row`);
ok("...and truncates it from the newest end", one[0].mint === mintC, one[0].mint.slice(0, 4));
ok("...while the count stays whole, so a window is never mistaken for the record",
  j.snipeExitCount() === 3 && one.length === 1, `count 3, window ${one.length}`);
ok("limit is bounded above whatever a caller asks for", j.snipeExits({ limit: 1e9 }).length === 3,
  "a 1e9 limit does not become a 1e9-row read");
ok("a garbage limit falls back rather than throwing", j.snipeExits({ limit: "nonsense" }).length === 3);
ok("sinceMs excludes what closed before it", j.snipeExits({ sinceMs: T0 + 2_500 }).length === 1,
  `${j.snipeExits({ sinceMs: T0 + 2_500 }).map((r) => r.mint.slice(0, 4)).join(",")}`);
ok("...and the count takes the same floor", j.snipeExitCount({ sinceMs: T0 + 2_500 }) === 1,
  `${j.snipeExitCount({ sinceMs: T0 + 2_500 })}`);

console.log("\nthe whole point: it survives a restart");
j.close();
j = new ExecutionJournal(file, { wallet, create: false });
const afterRestart = j.snipeExits({ limit: 50 });
ok("the book is still there after the process died", afterRestart.length === 3, `${afterRestart.length} rows`);
ok("...with the identical realised numbers",
  JSON.stringify(afterRestart) === JSON.stringify(rows), "byte-identical to the pre-restart read");
ok("...and the count too", j.snipeExitCount() === 3, `${j.snipeExitCount()}`);

console.log("\nthe tally covers the whole record, by the database");
{
  /* THE AGENT LADDER IS JUDGED ON THESE NUMBERS. The heartbeat used to tally the last 200
     rows and send that sum beside a lifetime count; past 200 trades a desk that lost money
     overall could read as a profitable record. snipeExitTotals is one aggregate over every
     row, and it must agree with the rows themselves. */
  const all = j.snipeExits({ limit: 200 });
  const known = all.filter((r) => r.realizedLamports !== null);
  const t = j.snipeExitTotals();
  ok("the totals count every trade", t.trades === j.snipeExitCount(), `${t.trades}`);
  ok("wins and losses agree with the rows",
    t.wins === known.filter((r) => BigInt(r.realizedLamports) > 0n).length
    && t.losses === known.filter((r) => BigInt(r.realizedLamports) <= 0n).length, JSON.stringify(t));
  ok("readable is wins + losses, and unknown is the rest",
    t.readable === t.wins + t.losses && t.unknown === t.trades - t.readable);
  ok("the realised total is the sum of the readable rows",
    t.realizedLamports === known.reduce((a, r) => a + Number(r.realizedLamports), 0), String(t.realizedLamports));
  ok("sinceMs takes the same floor as the count",
    j.snipeExitTotals({ sinceMs: T0 + 2_500 }).trades === j.snipeExitCount({ sinceMs: T0 + 2_500 }));
  ok("a window with no trade at all has a NULL total, not 0",
    j.snipeExitTotals({ sinceMs: T0 + 1e12 }).realizedLamports === null);
}

console.log("\nthe unknown is not zero");
/* A CLOSE WHOSE RESULT CANNOT BE READ. The write paths cannot produce this — markAccounted
   refuses an exit with no basis — so it is injected, which is the only honest way to test a
   defensive branch: corrupt the durable row behind the writers' backs, exactly as a
   half-migrated or hand-edited database would. */
j.db.prepare("DELETE FROM risk_events WHERE intent_id=?").run(lossId);
const damaged = j.snipeExits({ limit: 50 }).find((r) => r.mint === mintB);
ok("a close with no ledger entry reads as unknown", damaged?.realizedLamports === null,
  `realizedLamports = ${JSON.stringify(damaged?.realizedLamports)}`);
ok("...which is null, and emphatically not 0", damaged?.realizedLamports !== 0 && damaged?.realizedLamports !== "0",
  `${JSON.stringify(damaged?.realizedLamports)} — 0 would mean "broke even"`);
ok("...and the row is still listed rather than silently dropped",
  j.snipeExits({ limit: 50 }).length === 3 && j.snipeExitCount() === 3,
  "a trade you cannot price is still a trade that happened");
{
  const t = j.snipeExitTotals();
  ok("the totals count it as unknown, not as a break-even loss", t.unknown >= 1 && t.trades === 3 && t.readable === 3 - t.unknown,
    JSON.stringify(t));
}
j.close();

console.log("\nwhat the desk accepts from the bot");
const book = {
  closed: [
    { mint: mintA, closedAt: T0 + 1_000, reason: "take", realizedSol: 0.344995, sizeSol: 0.4 },
    { mint: mintB, closedAt: T0 + 2_000, reason: "stop", realizedSol: -0.100005, sizeSol: 0.3 },
    { mint: mintC, closedAt: T0 + 3_000, reason: "creator_exit", realizedSol: null, sizeSol: null },
  ],
  trades: 3, counted: 3, wins: 1, losses: 1, unknown: 1, realizedSol: 0.24499,
};
const clean = sanitizeExecutorSnipe({ mode: "execute", state: "up", book });
ok("the book survives sanitizing", clean.book !== null && clean.book.closed.length === 3,
  `${clean.book?.closed?.length} rows`);
ok("a loss is still a loss on the desk's side", clean.book.closed[1].realizedSol === -0.100005,
  String(clean.book.closed[1].realizedSol));
ok("a signed total is not clamped at zero", clean.book.realizedSol === 0.24499, String(clean.book.realizedSol));
ok("an unknown result arrives as null, not 0", clean.book.closed[2].realizedSol === null,
  JSON.stringify(clean.book.closed[2].realizedSol));
ok("the window and the total are carried as two numbers",
  clean.book.trades === 3 && clean.book.counted === 3, `${clean.book.trades} / ${clean.book.counted}`);

/* THE BOT IS A MACHINE THE DESK DOES NOT CONTROL, so every refusal below is driven with
   the value a compromised or broken one would actually send. */
ok("no book is null, not an empty book", sanitizeExecutorSnipe({ mode: "execute", state: "up" }).book === null);
ok("a book that is an array is refused",
  sanitizeExecutorSnipe({ mode: "execute", book: [1, 2, 3] }).book === null);
ok("a book that is a string is refused",
  sanitizeExecutorSnipe({ mode: "execute", book: "+900 SOL" }).book === null);
const hostile = sanitizeExecutorSnipe({ mode: "execute", book: {
  closed: [
    { mint: "<img src=x onerror=alert(1)>", realizedSol: 1 },
    { mint: mintA, realizedSol: 1e12, sizeSol: -5, reason: "x".repeat(400), closedAt: "tomorrow" },
    "not even an object",
    ...Array.from({ length: 60 }, () => ({ mint: mintB, realizedSol: 0.1, sizeSol: 0.1 })),
  ],
  trades: -7, counted: 1e12, wins: 1e12, losses: "many", unknown: null, realizedSol: 9e18,
} }).book;
ok("a mint that is not a mint is dropped", !hostile.closed.some((r) => /img|onerror/.test(String(r.mint))),
  `${hostile.closed.length} rows survived`);
ok("the row list is capped", hostile.closed.length <= 20, `${hostile.closed.length} rows`);
ok("an absurd realised result is bounded, not believed", hostile.closed[0].realizedSol === 1_000,
  String(hostile.closed[0].realizedSol));
ok("an absurd total is bounded too", hostile.realizedSol === 1_000, String(hostile.realizedSol));
ok("a negative size cannot appear", hostile.closed[0].sizeSol >= 0, String(hostile.closed[0].sizeSol));
ok("a novel-length reason is truncated", hostile.closed[0].reason.length <= 80,
  `${hostile.closed[0].reason.length} chars`);
ok("a non-numeric timestamp does not survive", hostile.closed[0].closedAt === null,
  JSON.stringify(hostile.closed[0].closedAt));
ok("a negative trade count cannot appear", hostile.trades >= 0, String(hostile.trades));
ok("counts are bounded", Number.isFinite(hostile.counted) && Number.isFinite(hostile.wins),
  `counted ${hostile.counted}, wins ${hostile.wins}`);
ok("a non-numeric count reads as 0, never as NaN", hostile.losses === 0, String(hostile.losses));

console.log("\nwhere the bot reads it from");
/* THE ONE DESIGN CLAIM THIS WHOLE FEATURE RESTS ON. The lane's own counters live in memory:
   they say "exited 1" and a restart says "exited 0". A board built on them forgets every
   trade the bot ever made, which is the opposite of a record anyone can verify profit on.
   So the heartbeat is pinned to the journal, by source, because this is precisely the kind
   of thing a later refactor "simplifies" back into the in-memory counter beside it. */
const poller = fs.readFileSync(path.join(HERE, "poller.mjs"), "utf8");
const beat = poller.slice(poller.indexOf("function snipeHeartbeat()"),
  poller.indexOf("const lane = snipeStatus.lane;", poller.indexOf("function snipeHeartbeat()")));
ok("the heartbeat's book comes from the durable journal", /journal\.snipeExits\(/.test(beat),
  "journal.snipeExits(...)");
ok("...and its tally from the journal's aggregate over EVERY row, not from the rows it read",
  /const t = journal\.snipeExitTotals\(\);/.test(beat) && /trades: t\.trades,/.test(beat), "journal.snipeExitTotals()");
ok("...so the tallies cover every trade and say so",
  /counted: t\.trades,/.test(beat) && /readable: t\.readable/.test(beat), "counted: t.trades");
ok("...and an unreadable record sends a null total, never 0",
  /realizedSol: t\.realizedLamports === null \? null/.test(beat));
ok("the book never takes the pulse down with it", /\} catch \{\}/.test(beat),
  "a throwing journal costs this block, not the heartbeat");
ok("the book is declared on the heartbeat's own shape", /open: \[\], counts: null, feed: null, book: null/.test(poller),
  "book defaults to null like every field beside it");

console.log("\nwhat the page does with it");
const page = fs.readFileSync(path.join(ROOT, "viewer", "office3d.html"), "utf8");
const board = page.slice(page.indexOf("const bk = snipe.book;"), page.indexOf("THE CHECKLIST, VERBATIM"));
ok("the HAWK-AI tab renders the book", board.includes("const bk = snipe.book;") && board.length > 500,
  `${board.length} chars of board`);
ok("the sign is coloured with classes this page actually styles",
  /const sign = \(n\) => \(n > 0 \? "good" : n < 0 \? "bad" : ""\)/.test(board));
ok("...and those two classes exist in the stylesheet",
  page.includes(".dashmetric b.good{color:var(--good)}") && page.includes(".dashmetric b.bad{color:var(--bad)}"));
ok("an unreadable result renders as words, not as a number",
  board.includes('r.realizedSol === null ? "not read"'), "\"not read\"");
ok("the colour is never applied to an unreadable result",
  /if \(v && cls && r\.realizedSol !== null\)/.test(board));
ok("the total names the window when the window is not the record",
  board.includes("bk.trades > counted ? `Counting the ${counted} most recent: `"));
ok("an older bot that sends no window falls back to the count",
  board.includes("const counted = bk.counted > 0 ? bk.counted : bk.trades;"));
ok("a fresh bot with nothing closed is told so, rather than shown an empty box",
  board.includes("No closed trade yet."));
ok("the RUNNING badge uses a class the page paints",
  page.includes('up: ["RUNNING", "good"]') && !page.includes('up: ["RUNNING", "ok"]'));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-hawk-board  ${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
