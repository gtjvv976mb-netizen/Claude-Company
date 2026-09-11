/**
 * THE FENCE BETWEEN THE TWO LANES, TESTED AS A FENCE.
 *
 * snipe-book.mjs exists for one reason: a mint held by the desk and by the sniper at the
 * same time is two engines each sizing an exit from one token balance, and the second one
 * to sign spends a balance that is already gone. So the assertions below are not "does
 * openSnipe return an object" — they are the two failures the invariant was written to
 * catch, driven deliberately:
 *
 *   - A CROSS-BOOK COLLISION, both at the moment it would be created and as a corruption
 *     injected straight into `S.snipes` behind the writers' backs.
 *   - A POSITION MISSING ITS ECONOMICS, likewise injected, because a book is only as good
 *     as what it refuses to have been corrupted into.
 *
 * The house rules this file is written to:
 *
 *   - EVERY ASSERTION IS MADE IN BOTH DIRECTIONS. A guard that cannot say no is not a
 *     guard, so every refusal is paired with the same case made valid and asserted to
 *     PASS — the collision refuses and then, with the desk row removed, opens; each of
 *     the four economics fields refuses when absent and opens when present; the two
 *     sanctioned sizing conventions both open while a third is refused.
 *   - EVERY ASSERTION PRINTS THE ACTUAL VALUE, including the clause the refusal named.
 *   - THE RULER IS VALIDATED AGAINST A CASE WHOSE ANSWER IS KNOWN FIRST: the durable-form
 *     rule is justified by a measurement, so this file MEASURES it — `JSON.stringify` is
 *     run over a book holding a BigInt and asserted to throw, which is the failure that
 *     would otherwise happen on the journal's write path with a position already open.
 *
 * No network, no clock, no keypair, no signing. Runs in well under a second.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import {
  IMMUTABLE_SNIPE_FIELDS, LANE_INVARIANT_CLAUSES, LaneInvariantError, REQUIRED_SNIPE_ECONOMICS,
  REQUIRED_SNIPE_PRICING, SNIPE_BOOK_VERSION, SNIPE_LANE, assertLaneInvariant, closeSnipe,
  ensureSnipeBook, openSnipe, snipeFor, snipeList, updateSnipe,
} from "./snipe-book.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOK_SRC = fs.readFileSync(path.join(HERE, "snipe-book.mjs"), "utf8");
/* THE SOURCE SCANS BELOW READ CODE, NOT PROSE. This file's first draft asserted "no
   Date.now() anywhere in the module" against the raw text and failed on the module's own
   header comment EXPLAINING that it never calls Date.now() — a ruler measuring the wrong
   thing, which is the one failure mode this repo's rules name outright. Comments are
   stripped first, and the count of what was stripped is printed. */
const CODE_ONLY = BOOK_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/** Assert a refusal AND the clause it named. A refusal with the wrong clause is a caller
 *  branching on the wrong reason, so the clause is part of the assertion, not decoration. */
const refuses = (name, clause, fn) => {
  try {
    const out = fn();
    ok(name, false, `NO REFUSAL — returned ${JSON.stringify(out, jsonSafe)?.slice(0, 80)}`);
  } catch (error) {
    if (!(error instanceof LaneInvariantError))
      return ok(name, false, `threw ${error.name}, not LaneInvariantError: ${error.message.slice(0, 80)}`);
    ok(name, error.clause === clause,
      `clause ${error.clause}${error.clause === clause ? "" : ` (wanted ${clause})`} — ${error.message.slice(0, 110)}`);
  }
};
const accepts = (name, fn, describe = () => "") => {
  try { const out = fn(); ok(name, true, describe(out)); return out; }
  catch (error) { ok(name, false, `REFUSED ${error.clause ?? error.name}: ${error.message.slice(0, 110)}`); return null; }
};
const jsonSafe = (k, v) => (typeof v === "bigint" ? `${v}n` : v);

/* Deterministic 32-byte keys. A mint is measured by DECODED BYTE LENGTH in the book, so
   the fixtures have to be real base58 keys rather than the readable strings a looser
   check would have accepted — which is itself the point of that check. */
const keyFrom = (seed) => {
  const bytes = new Uint8Array(32);
  let x = seed >>> 0;
  for (let i = 0; i < 32; i++) { x = (Math.imul(x ^ (x >>> 15), 2246822519) + 1) >>> 0; bytes[i] = x & 0xff; }
  bytes[0] ||= 7;                                   // never the all-zero default
  return bs58.encode(bytes);
};
const MINT_A = keyFrom(1), MINT_B = keyFrom(2), MINT_C = keyFrom(3), CREATOR = keyFrom(9);

/* THE LIVE FILL, from the spec's measured rails: maxSolPerTrade 0.005 SOL and
   expectedNetworkFeeLamports 500,000 (0.0005 SOL a leg), with the fee taken out of the
   ticket so 4,500,000 lamports reach the swap. Round-trip friction on it is 1.2222x. */
const LIVE = Object.freeze({
  mint: MINT_A, venue: "pumpfun", entry: 1, openedAt: 1_757_000_000_000,
  sizeSol: 0.005, feeSolPerLeg: 0.0005,
  qtyRaw: 123_456_789_000n, entryInputLamports: 4_500_000n, entryFeeLamports: 500_000n,
  creator: CREATOR, openedAtSlot: 300_000_001,
});
const draft = (patch = {}) => ({ ...LIVE, ...patch });
const state = (positions = {}) => ({ positions, snipes: {} });

/* ------------------------------------------------------------------ *
 * 1. A GOOD FILL OPENS, AND WHAT IT STORES IS DURABLE                  *
 * ------------------------------------------------------------------ */
console.log("\n1. A LIVE-SIZED FILL OPENS, AND THE ROW IT STORES CAN BE JOURNALLED");
{
  const S = state();
  const row = accepts("the live fill opens", () => openSnipe(S, draft()),
    (r) => `${r.mint.slice(0, 8)} qtyRaw ${r.qtyRaw} entryInputLamports ${r.entryInputLamports}`);
  ok("the row is filed under its own mint", S.snipes[MINT_A] === row, `key ${Object.keys(S.snipes)[0]?.slice(0, 8)}`);
  ok("the lane tag is stamped by the book", row.lane === SNIPE_LANE, `lane ${JSON.stringify(row.lane)}`);
  ok("the row is frozen", Object.isFrozen(row), `Object.isFrozen -> ${Object.isFrozen(row)}`);
  ok("bookVersion is recorded on the row", row.bookVersion === SNIPE_BOOK_VERSION, `${row.bookVersion}`);

  /* THE MEASURED REASON FOR DIGIT STRINGS. journal.mjs:971 writes each position with
     JSON.stringify, and JSON.stringify(1n) throws. Both directions, on real values. */
  ok("qtyRaw is stored as a digit string, not a BigInt",
    typeof row.qtyRaw === "string" && /^\d+$/.test(row.qtyRaw), `typeof ${typeof row.qtyRaw} = ${row.qtyRaw}`);
  ok("entryInputLamports too", typeof row.entryInputLamports === "string", `${row.entryInputLamports}`);
  let jsonErr = null, bigintErr = null;
  try { JSON.stringify(S.snipes); } catch (e) { jsonErr = e; }
  try { JSON.stringify({ [MINT_A]: { qtyRaw: 1n } }); } catch (e) { bigintErr = e; }
  ok("the book as stored survives JSON.stringify", jsonErr === null, `${jsonErr?.message ?? "no throw"}`);
  ok("a BigInt in the same place would NOT — which is why the rule exists",
    bigintErr !== null, `${bigintErr?.message?.slice(0, 70)}`);
  ok("and a BigInt left in the book is refused by the invariant, before it reaches the journal",
    (() => { const bad = state(); bad.snipes[MINT_A] = { ...row, qtyRaw: 123n };
      try { assertLaneInvariant(bad); return false; } catch (e) { return e.clause === "raw_amount_not_durable"; } })(),
    "clause raw_amount_not_durable");

  const report = accepts("the invariant passes on a healthy book", () => assertLaneInvariant(S),
    (r) => `snipeCount ${r.snipeCount} deskCount ${r.deskCount}`);
  ok("the report counts what it proved", report?.snipeCount === 1 && report?.deskCount === 0,
    `snipes ${report?.snipeCount} desk ${report?.deskCount}`);
  ok("snipeList returns exactly the open snipes", snipeList(S).length === 1 && snipeList(S)[0] === row,
    `length ${snipeList(S).length}`);
  refuses("one mint, one position", "duplicate_snipe", () => openSnipe(S, draft()));
}

/* ------------------------------------------------------------------ *
 * 2. THE FOUR ECONOMICS — REFUSED WHEN ABSENT, OPENS WHEN PRESENT      *
 * ------------------------------------------------------------------ */
console.log("\n2. EVERY FIELD snipe-policy.mjs PRICES OFF IS REQUIRED (BOTH DIRECTIONS)");
{
  ok("the required set is exactly the four the determiner consumes",
    REQUIRED_SNIPE_ECONOMICS.join(",") === "entry,openedAt,sizeSol,feeSolPerLeg",
    `[${REQUIRED_SNIPE_ECONOMICS.join(", ")}]`);
  for (const field of REQUIRED_SNIPE_ECONOMICS) {
    const missing = draft(); delete missing[field];
    refuses(`openSnipe refuses a fill with no ${field}`, "economics_missing", () => openSnipe(state(), missing));
    refuses(`a null ${field} is the same refusal`, "economics_missing",
      () => openSnipe(state(), draft({ [field]: null })));
    accepts(`and the same fill WITH ${field} opens`, () => openSnipe(state(), draft()),
      (r) => `${field} = ${JSON.stringify(r[field])}`);

    /* The corruption path: a row already in the book, missing the same field. This is the
       case the brief names — the invariant must catch it, not just the writer. */
    const S = state();
    openSnipe(S, draft());
    const corrupt = { ...S.snipes[MINT_A] }; delete corrupt[field];
    S.snipes[MINT_A] = corrupt;
    refuses(`the INVARIANT catches an already-filed row missing ${field}`, "economics_missing",
      () => assertLaneInvariant(S));
  }
  refuses("a non-numeric entry is refused", "entry_invalid", () => openSnipe(state(), draft({ entry: "1.0" })));
  refuses("a zero entry is refused", "entry_invalid", () => openSnipe(state(), draft({ entry: 0 })));
  refuses("a NaN openedAt is refused", "opened_at_invalid", () => openSnipe(state(), draft({ openedAt: NaN })));
  refuses("a negative feeSolPerLeg is refused", "economics_invalid",
    () => openSnipe(state(), draft({ feeSolPerLeg: -0.0005 })));
  accepts("a zero feeSolPerLeg opens — observe mode sets networkFeeReserveSol to 0",
    () => openSnipe(state(), draft({ feeSolPerLeg: 0, entryInputLamports: 5_000_000n, entryFeeLamports: 0n })),
    (r) => `feeSolPerLeg ${r.feeSolPerLeg}, swap input ${r.entryInputLamports}, frictionX is exactly 1`);
  refuses("but a zero feeSolPerLeg beside a 500,000-lamport entry fee is two stories about one fill",
    "economics_inconsistent", () => openSnipe(state(), draft({ feeSolPerLeg: 0, entryInputLamports: 5_000_000n })));
}

/* ------------------------------------------------------------------ *
 * 3. A POSITION THE BOOK CANNOT PRICE IS NOT FILED                     *
 * ------------------------------------------------------------------ */
console.log("\n3. NO MARK, NO POSITION — markX = sellExactIn(curve, qtyRaw) / entryInputLamports");
{
  ok("the pricing operands are named", REQUIRED_SNIPE_PRICING.join(",") === "qtyRaw,entryInputLamports",
    `[${REQUIRED_SNIPE_PRICING.join(", ")}]`);
  for (const field of REQUIRED_SNIPE_PRICING) {
    const clause = field === "qtyRaw" ? "quantity_unpriceable" : "entry_input_unpriceable";
    const missing = draft(); delete missing[field];
    refuses(`a fill with no ${field} has no mark`, clause, () => openSnipe(state(), missing));
    refuses(`a ${field} of 0 has no mark either`, clause, () => openSnipe(state(), draft({ [field]: 0n })));
    refuses(`a fractional ${field} is refused, never truncated`, clause,
      () => openSnipe(state(), draft({ [field]: 1.5 })));
    refuses(`a negative ${field} is refused`, clause, () => openSnipe(state(), draft({ [field]: "-5" })));
    const S = state(); openSnipe(S, draft());
    const corrupt = { ...S.snipes[MINT_A] }; delete corrupt[field];
    S.snipes[MINT_A] = corrupt;
    refuses(`the INVARIANT catches an already-filed row with no ${field}`, clause, () => assertLaneInvariant(S));
  }
  accepts("a digit string qtyRaw (the journal's own form) is accepted",
    () => openSnipe(state(), draft({ qtyRaw: "123456789000" })), (r) => `qtyRaw ${r.qtyRaw}`);

  /* NO BREAKEVEN EXISTS AT ALL. proceeds = size*m - fee, outlay = size + fee, so size <= fee
     never closes at any mark. Known answer before the code runs: refusal. */
  refuses("a fill whose fee equals its ticket has no breakeven multiple", "economics_unpriceable",
    () => openSnipe(state(), draft({ sizeSol: 0.0005, feeSolPerLeg: 0.0005, entryInputLamports: 500_000n,
      entryFeeLamports: 500_000n })));
  refuses("nor one whose fee exceeds it", "economics_unpriceable",
    () => openSnipe(state(), draft({ sizeSol: 0.0004, feeSolPerLeg: 0.0005, entryInputLamports: 400_000n,
      entryFeeLamports: 500_000n })));
  accepts("one lamport of headroom and it prices", () => openSnipe(state(),
    draft({ sizeSol: 0.000501, feeSolPerLeg: 0.0005, entryInputLamports: 1_000n, entryFeeLamports: 500_000n })),
    (r) => `sizeSol ${r.sizeSol} vs feeSolPerLeg ${r.feeSolPerLeg}`);
}

/* ------------------------------------------------------------------ *
 * 4. THE TICKET AND THE SWAP INPUT DESCRIBE ONE FILL                   *
 * ------------------------------------------------------------------ */
console.log("\n4. THE TWO SANCTIONED SIZING CONVENTIONS, AND NOTHING ELSE");
{
  accepts("fee inside the budget: 0.005 SOL ticket, 4,500,000 lamports swapped (frictionX 1.2222)",
    () => openSnipe(state(), draft({ entryInputLamports: 4_500_000n })), (r) => `swap ${r.entryInputLamports}`);
  accepts("fee beside it: 0.005 SOL ticket, 5,000,000 lamports swapped (frictionX 1.2000)",
    () => openSnipe(state(), draft({ entryInputLamports: 5_000_000n })), (r) => `swap ${r.entryInputLamports}`);
  refuses("a swap input above the ticket is two different fills on one row", "economics_inconsistent",
    () => openSnipe(state(), draft({ entryInputLamports: 50_000_000n })));
  refuses("and one far below it is too", "economics_inconsistent",
    () => openSnipe(state(), draft({ entryInputLamports: 1_000_000n })));
  refuses("a declared entryFeeLamports that disagrees with feeSolPerLeg is refused", "economics_inconsistent",
    () => openSnipe(state(), draft({ entryFeeLamports: 5_000_000n })));
  accepts("entryFeeLamports is optional", () => {
    const d = draft(); delete d.entryFeeLamports; return openSnipe(state(), d);
  }, (r) => `entryFeeLamports ${JSON.stringify(r.entryFeeLamports ?? null)}`);
}

/* ------------------------------------------------------------------ *
 * 5. THE COLLISION THE WHOLE FILE EXISTS FOR                           *
 * ------------------------------------------------------------------ */
console.log("\n5. NO MINT IS EVER OPEN IN BOTH BOOKS");
{
  /* (a) refused at the moment it would be created */
  const S = state({ [MINT_A]: { mint: MINT_A, qtyRaw: "999", callId: 41 } });
  refuses("a snipe on a mint the DESK holds is refused at open", "cross_book_collision",
    () => openSnipe(S, draft()));
  ok("and nothing was filed", Object.keys(S.snipes).length === 0, `S.snipes has ${Object.keys(S.snipes).length} rows`);

  /* (b) the same mint, desk row removed: it must now open. A fence that never opens is
         not a fence, it is a wall. */
  delete S.positions[MINT_A];
  accepts("with the desk flat, the same fill opens", () => openSnipe(S, draft()),
    (r) => `${r.mint.slice(0, 8)} now in the snipe book`);

  /* (c) the corruption path — the collision created behind the writers' backs. */
  S.positions[MINT_A] = { mint: MINT_A, qtyRaw: "999" };
  refuses("the INVARIANT catches a collision injected straight into the books", "cross_book_collision",
    () => assertLaneInvariant(S));
  console.log(`     desk keys [${Object.keys(S.positions).map((m) => m.slice(0, 8))}]  ` +
    `snipe keys [${Object.keys(S.snipes).map((m) => m.slice(0, 8))}]`);
  delete S.positions[MINT_A];
  accepts("and passes again once the desk row is gone", () => assertLaneInvariant(S),
    (r) => `snipeCount ${r.snipeCount} deskCount ${r.deskCount}`);

  /* (d) a desk book keyed by something other than the mint must not slip past. The desk
         keys by mint today; an invariant that TRUSTED the key would miss this row. */
  S.positions["desk-row-7"] = { mint: MINT_A, qtyRaw: "999" };
  refuses("a desk row filed under a non-mint key is still a collision", "cross_book_collision",
    () => assertLaneInvariant(S));
  delete S.positions["desk-row-7"];

  /* (e) two DIFFERENT mints, one per lane, is the normal healthy state. */
  S.positions[MINT_B] = { mint: MINT_B, qtyRaw: "5" };
  const report = accepts("one mint per lane is fine", () => assertLaneInvariant(S),
    (r) => `snipeCount ${r.snipeCount} deskCount ${r.deskCount}`);
  ok("the counts are right", report?.snipeCount === 1 && report?.deskCount === 1,
    `snipes ${report?.snipeCount} desk ${report?.deskCount}`);
  ok("snipeList cannot see the desk position",
    snipeList(S).every((p) => p.mint !== MINT_B), `snipeList mints [${snipeList(S).map((p) => p.mint.slice(0, 8))}]`);
  ok("snipeFor never falls through to the desk book", snipeFor(S, MINT_B) === null, `${snipeFor(S, MINT_B)}`);
}

/* ------------------------------------------------------------------ *
 * 6. THE OTHER WAYS A BOOK GETS CORRUPTED                              *
 * ------------------------------------------------------------------ */
console.log("\n6. THE INVARIANT IS RUN AGAINST WHAT IS IN THE BOOK, NOT AGAINST WHAT openSnipe WOULD HAVE BUILT");
{
  const base = () => { const S = state(); openSnipe(S, draft()); return S; };
  let S = base(); S.snipes[MINT_B] = { ...S.snipes[MINT_A] };
  refuses("a row filed under the wrong key", "book_key_mismatch", () => assertLaneInvariant(S));
  S = base(); S.snipes[MINT_A] = { ...S.snipes[MINT_A], lane: "desk" };
  refuses("a row wearing the desk's lane tag", "lane_invalid", () => assertLaneInvariant(S));
  S = base(); S.snipes[MINT_A] = { ...S.snipes[MINT_A], venue: "" };
  refuses("a row with no venue — nothing knows how to exit it", "venue_invalid", () => assertLaneInvariant(S));
  S = base(); S.snipes[MINT_A] = { ...S.snipes[MINT_A], creator: "not-a-key" };
  refuses("a creator that is not an account key", "creator_invalid", () => assertLaneInvariant(S));
  S = base(); S.snipes[MINT_A] = null;
  refuses("a null row", "snipe_invalid", () => assertLaneInvariant(S));
  S = base(); S.snipes = [];
  refuses("a book that is an array", "book_invalid", () => assertLaneInvariant(S));
  S = base(); S.positions = "positions";
  refuses("a desk book that is not an object", "desk_book_invalid", () => assertLaneInvariant(S));
  refuses("a runtime that is not an object", "state_invalid", () => assertLaneInvariant(null));
  accepts("a runtime with no snipe book yet is healthy, not broken",
    () => assertLaneInvariant({ positions: {} }), (r) => `snipeCount ${r.snipeCount}`);
  accepts("ensureSnipeBook creates it", () => { const s = { positions: {} }; ensureSnipeBook(s); return s.snipes; },
    (b) => `typeof ${typeof b}, ${Object.keys(b).length} rows`);

  /* FAIL-CLOSED ON ITS OWN WRITE. A pre-existing corrupt row makes the post-insert
     invariant throw; the row openSnipe was filing must not be left behind. */
  const poisoned = base();
  poisoned.snipes[MINT_C] = { ...poisoned.snipes[MINT_A], mint: MINT_C, lane: "desk" };
  refuses("openSnipe refuses when the book it is writing into is already corrupt", "lane_invalid",
    () => openSnipe(poisoned, draft({ mint: MINT_B })));
  ok("and it rolled its own row back out", !Object.prototype.hasOwnProperty.call(poisoned.snipes, MINT_B),
    `keys [${Object.keys(poisoned.snipes).map((m) => m.slice(0, 8))}]`);
}

/* ------------------------------------------------------------------ *
 * 7. THE FILL IS FROZEN; THE DETERMINER'S WORKING FIELDS ARE NOT       *
 * ------------------------------------------------------------------ */
console.log("\n7. updateSnipe — frictionX IS A FACT ABOUT THE LAMPORTS THAT WERE PAID");
{
  const S = state();
  const row = openSnipe(S, draft({ confirmedHigh: 1, confirmedHighPrev: 0 }));
  const moved = accepts("the determiner's own fields may move",
    () => updateSnipe(S, { ...row, confirmedHigh: 1.9, confirmedHighPrev: 1.4 }),
    (r) => `confirmedHigh ${r.confirmedHigh} confirmedHighPrev ${r.confirmedHighPrev}`);
  ok("and the book holds the new row", S.snipes[MINT_A] === moved && moved.confirmedHigh === 1.9,
    `stored confirmedHigh ${S.snipes[MINT_A].confirmedHigh}`);
  for (const field of ["sizeSol", "feeSolPerLeg", "entry", "openedAt", "entryInputLamports", "venue", "creator"]) {
    const patch = { sizeSol: 0.01, feeSolPerLeg: 0.0004, entry: 2, openedAt: 1_757_000_000_001,
      entryInputLamports: 9_000_000n, venue: "somewhere-else", creator: keyFrom(77) }[field];
    refuses(`${field} is fixed at the fill`, "immutable_field_changed",
      () => updateSnipe(S, { ...S.snipes[MINT_A], [field]: patch }));
  }
  ok("the immutable list is the fill, not the state machine",
    IMMUTABLE_SNIPE_FIELDS.includes("sizeSol") && IMMUTABLE_SNIPE_FIELDS.includes("feeSolPerLeg") &&
    !IMMUTABLE_SNIPE_FIELDS.includes("qtyRaw"), `[${IMMUTABLE_SNIPE_FIELDS.join(", ")}]`);
  accepts("qtyRaw may fall — a partial sell", () => updateSnipe(S, { ...S.snipes[MINT_A], qtyRaw: 100_000_000_000n }),
    (r) => `qtyRaw ${r.qtyRaw}`);
  refuses("qtyRaw may not rise — a snipe never adds", "quantity_increased",
    () => updateSnipe(S, { ...S.snipes[MINT_A], qtyRaw: 999_999_999_999n }));
  ok("and the refused update left the stored row alone", S.snipes[MINT_A].qtyRaw === "100000000000",
    `qtyRaw ${S.snipes[MINT_A].qtyRaw}`);
  refuses("a mint that is not open cannot be updated", "snipe_unknown",
    () => updateSnipe(S, { ...S.snipes[MINT_A], mint: MINT_C }));
}

/* ------------------------------------------------------------------ *
 * 8. CLOSING, AND THE CLOCK THAT ARRIVES AS A PARAMETER                *
 * ------------------------------------------------------------------ */
console.log("\n8. closeSnipe — THE ROW LEAVES WITH ITS REASON AND THE CALLER'S CLOCK");
{
  const S = state();
  openSnipe(S, draft());
  refuses("closing needs the reason it closed", "close_invalid",
    () => closeSnipe(S, MINT_A, { closedAt: 1_757_000_060_000 }));
  refuses("closing needs the caller's clock — this book reads none of its own", "close_invalid",
    () => closeSnipe(S, MINT_A, { reason: "clock" }));
  refuses("a mint that is not open cannot be closed", "snipe_unknown",
    () => closeSnipe(S, MINT_C, { reason: "clock", closedAt: 1 }));
  ok("none of those refusals removed anything", Object.keys(S.snipes).length === 1,
    `${Object.keys(S.snipes).length} row(s) still open`);
  const closed = accepts("a clean close returns the row",
    () => closeSnipe(S, MINT_A, { reason: "clock", closedAt: 1_757_000_060_000, markX: 0.91 }),
    (c) => `reason ${c.reason} closedAt ${c.closedAt} markX ${c.markX}`);
  ok("the envelope is frozen", Object.isFrozen(closed), `${Object.isFrozen(closed)}`);
  ok("the book is empty", snipeList(S).length === 0, `snipeList length ${snipeList(S).length}`);
  accepts("and the desk may now hold that mint without colliding",
    () => { S.positions[MINT_A] = { mint: MINT_A, qtyRaw: "1" }; return assertLaneInvariant(S); },
    (r) => `snipeCount ${r.snipeCount} deskCount ${r.deskCount}`);

  /* A CLOSE THAT REFUSES MUST NOT HAVE HAPPENED. If another row in the book is corrupt
     the invariant throws after the delete, and without the restore the caller sees a
     refusal while the position has already left — a position that exists nowhere is a
     position nothing will ever exit. */
  const T = state();
  openSnipe(T, draft({ mint: MINT_B }));
  openSnipe(T, draft({ mint: MINT_C }));
  T.snipes[MINT_C] = { ...T.snipes[MINT_C], lane: "desk" };
  refuses("closing into a book with a corrupt row refuses", "lane_invalid",
    () => closeSnipe(T, MINT_B, { reason: "clock", closedAt: 2 }));
  ok("and the row it was closing is still open — no position vanishes on a refusal",
    Object.prototype.hasOwnProperty.call(T.snipes, MINT_B),
    `keys [${Object.keys(T.snipes).map((m) => m.slice(0, 8))}]`);
}

/* ------------------------------------------------------------------ *
 * 9. PURE: NOTHING MUTATED, NOTHING REMEMBERED, NO CLOCK               *
 * ------------------------------------------------------------------ */
console.log("\n9. PURITY — A REPLAY MUST PRODUCE BYTE-IDENTICAL ROWS");
{
  const d = draft();
  const before = JSON.stringify(d, jsonSafe);
  const a = openSnipe(state(), d);
  const after = JSON.stringify(d, jsonSafe);
  ok("the draft is never mutated", before === after, `${before === after ? "identical" : after.slice(0, 90)}`);
  const b = openSnipe(state(), draft());
  ok("two opens of the same fill produce identical rows", JSON.stringify(a) === JSON.stringify(b),
    `${JSON.stringify(a).slice(0, 90)}`);
  const S = state();
  openSnipe(S, draft());
  const snapshot = JSON.stringify(S.snipes);
  try { snipeList(S); assertLaneInvariant(S); snipeFor(S, MINT_A); } catch { /* asserted below */ }
  ok("reads do not write", JSON.stringify(S.snipes) === snapshot, `book unchanged: ${JSON.stringify(S.snipes) === snapshot}`);
  console.log(`     source ${BOOK_SRC.length} bytes, ${CODE_ONLY.length} bytes of it code — ` +
    `${(BOOK_SRC.match(/Date\.now/g) || []).length} mention(s) of Date.now in the prose, ` +
    `${(CODE_ONLY.match(/Date\.now/g) || []).length} in the code`);
  ok("no clock is read anywhere in the module", !/Date\.now|new Date\b|performance\.now/.test(CODE_ONLY),
    `code matches: ${(CODE_ONLY.match(/Date\.now|new Date\b|performance\.now/g) || []).length}`);
  ok("no randomness either", !/Math\.random/.test(CODE_ONLY), "Math.random not present in code");
  ok("and no I/O", !/\bfrom "node:(fs|net|http|https)"|require\(/.test(CODE_ONLY), "no node:fs / node:net import");
}

/* ------------------------------------------------------------------ *
 * 10. THE SOURCE-LEVEL BOUNDARY                                        *
 * ------------------------------------------------------------------ */
console.log("\n10. THE BOOK IS THE FENCE — IT IMPORTS NO DESK ENGINE AND READS NO DESK BOOK");
{
  const imports = [...BOOK_SRC.matchAll(/^import[^\n]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
  console.log(`     imports: [${imports.join(", ")}]`);
  ok("nothing from the desk's exit engines is imported",
    !imports.some((m) => /trade-policy|strategy|desk-mirror|poller/.test(m)), `[${imports.join(", ")}]`);
  ok("the only local import is the ruler", imports.filter((m) => m.startsWith(".")).join(",") === "./snipe-curve.mjs",
    `[${imports.filter((m) => m.startsWith(".")).join(", ")}]`);

  /* snipeList is the sniper's openList(). poller.mjs:726 is Object.values(S.positions);
     this one may not be able to name that book at all. Proved from the function's own
     source text as well as from the behaviour asserted in section 5. */
  const body = snipeList.toString();
  ok("snipeList's own body never mentions the desk book", !/positions/.test(body),
    `body length ${body.length}, "positions" occurrences ${(body.match(/positions/g) || []).length}`);
  ok("snipeFor's body does not either", !/positions/.test(snipeFor.toString()), "no 'positions' in snipeFor");

  /* Every clause the file can throw is registered, and every registered clause is used.
     An unregistered clause would make the frozen list a lie for anyone branching on it —
     which is exactly the failure src/calls.js gateClass() has (an unheard-of gate answers
     SAFETY), so this file asserts the property rather than relying on care. */
  const thrown = new Set([...CODE_ONLY.matchAll(/refuse\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  /* Not every clause reaches `refuse()` as a literal — two of them arrive through a
     ternary or as a parameter — so the reachability half of this check looks for the
     clause as a quoted token anywhere in the CODE. A regex over `refuse("` alone reported
     `quantity_unpriceable` unused while three assertions above were firing it. */
  const quoted = new Set([...CODE_ONLY.matchAll(/"([a-z][a-z_]+)"/g)].map((m) => m[1]));
  const listed = new Set(LANE_INVARIANT_CLAUSES);
  const unregistered = [...thrown].filter((c) => !listed.has(c));
  const unused = [...listed].filter((c) => !quoted.has(c));
  ok("every clause thrown is registered", unregistered.length === 0, `unregistered: [${unregistered.join(", ")}]`);
  ok("every registered clause is actually reachable", unused.length === 0, `unused: [${unused.join(", ")}]`);
  ok("the clause list is frozen", Object.isFrozen(LANE_INVARIANT_CLAUSES), `${LANE_INVARIANT_CLAUSES.length} clauses`);
  let unregisteredThrew = null;
  try { new LaneInvariantError("not_a_clause", "x"); } catch (e) { unregisteredThrew = e; }
  ok("constructing an error with an unregistered clause is itself an error",
    unregisteredThrew !== null, `${unregisteredThrew?.message?.slice(0, 70)}`);
}

/* ------------------------------------------------------------------ *
 * 11. THE CONTRACT WITH THE DETERMINER, READ FROM ITS SOURCE           *
 * ------------------------------------------------------------------ */
console.log("\n11. THE FIELDS THE BOOK GUARANTEES ARE THE FIELDS snipe-policy.mjs READS");
{
  const POLICY_SRC = fs.readFileSync(path.join(HERE, "snipe-policy.mjs"), "utf8");
  /* The determiner may denominate the fill in SOL (sizeSol / feeSolPerLeg, the draft's
     form) or in lamports (entryInputLamports / entryFeeLamports, frictionXFor's form).
     The book carries BOTH, so the assertion is that the determiner reads the economics in
     ONE of the two sanctioned denominations — not that it picked the one this file
     happens to prefer. What it must never do is price a fill off nothing. */
  const found = (names) => names.filter((n) => new RegExp(`\\b${n}\\b`).test(POLICY_SRC));
  const size = found(["sizeSol", "entryInputLamports", "sizeLamports"]);
  const fee = found(["feeSolPerLeg", "entryFeeLamports", "expectedExitFeeLamports", "feeLamports"]);
  const entry = found(["entry", "entryMarkX"]);
  const opened = found(["openedAt", "openedAtMs", "openedAtSlot"]);
  console.log(`     snipe-policy.mjs reads: size [${size}] fee [${fee}] entry [${entry}] opened [${opened}]`);
  ok("the determiner reads the fill's size", size.length > 0, `[${size.join(", ")}]`);
  ok("the determiner reads the fee per leg", fee.length > 0, `[${fee.join(", ")}]`);
  ok("the determiner reads the entry level", entry.length > 0, `[${entry.join(", ")}]`);
  ok("the determiner reads the open time", opened.length > 0, `[${opened.join(", ")}]`);

  /* Both denominations are present on every row this book files, so whichever the
     determiner is written against, the row can answer it. */
  const row = openSnipe(state(), draft());
  const carries = ["sizeSol", "feeSolPerLeg", "entry", "openedAt", "qtyRaw", "entryInputLamports", "entryFeeLamports"]
    .filter((f) => row[f] !== undefined && row[f] !== null);
  ok("a filed row carries both denominations", carries.length === 7, `[${carries.join(", ")}]`);
  ok("it does not carry a breakeven multiple of its own — one definition, in snipe-curve.mjs",
    row.frictionX === undefined, `row.frictionX = ${JSON.stringify(row.frictionX)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
