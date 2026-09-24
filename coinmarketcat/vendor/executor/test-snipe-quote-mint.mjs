/**
 * A CURVE QUOTED IN A STOCK, FROM THE ENTRY CONTRACT TO THE BOOK AND THE SCORECARD.
 *
 * pump.fun "Custom Pairs" let a curve be quoted in something other than SOL, and the
 * quotes this desk cares about are the xStocks: Token-2022 mints with a permanent
 * delegate, a live freeze authority, a Pausable extension and a transfer hook whose
 * program is the zero key. Every one of those is a kill in the BASE-mint audit, and
 * rightly so — but the wallet never HOLDS the quote as a position; it pays with it. So
 * the quote mint is DESCRIBED (`describeMint`) and never JUDGED (`auditMintAccount`),
 * and the contract takes those facts as `args.quote`.
 *
 * What this file pins, in order:
 *
 *  1. THE DEFAULT IS SOL ONLY. `SNIPE_LANE_DEFAULTS.quoteMintAllowlist` is an empty
 *     frozen array and `effectiveLaneConfig` leaves it alone, so a lane that never typed
 *     an allowlist refuses a stock-quoted curve exactly as it did before one existed.
 *  2. A SOL CURVE IGNORES THE QUOTE FACTS. Passing `quote` beside a SOL curve changes
 *     nothing: same ticket, same plan, `detail.quote.isSol` true. The regression the
 *     whole feature must not introduce.
 *  3. THE LIVE GLDx CURVE. `fixtures/pumpfun-xstock-quote.json` carries the real bytes of
 *     a mainnet pump.fun curve quoted in GLDx; `decodeBondingCurve` reads GLDx out of
 *     them, and `describeMint` reads the GLDx mint beside it. Each refusal is asserted at
 *     its own gate with its own reason: not allowlisted; allowlisted but no facts;
 *     allowlisted but malformed facts; facts for a different mint; a paused quote; the
 *     day cap in GLDx; the minimum ticket in GLDx. Then the clean case clears every
 *     gate with the plan sized in GLDx raw units and the fee budget on absolute caps.
 *  4. THE BOOK ROW AT EIGHT DECIMALS. A fill paid in GLDx opens with `quoteMint`,
 *     `quoteDecimals` 8, `feeSolPerLeg` 0 and its network fee as `networkFeeLamports`;
 *     the same row without decimals, or with a SOL fee folded in, is refused as
 *     `quote_invalid`. The two quote fields are immutable.
 *  5. THE SCORECARD IS ONE POPULATION PER QUOTE. GLDx rows and SOL rows in one book are
 *     partitioned, never pooled; `quoteMintsOf` lists SOL first; `shadowReport` carries
 *     a card per quote.
 *
 * NOTHING HERE SIGNS, SENDS, LOADS A KEY OR TOUCHES THE NETWORK.
 *
 *   node executor/test-snipe-quote-mint.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import { constantProductExactIn, constantProductExactOut, constantProductSellExactIn } from "./snipe-curve.mjs";
import { MAX_GROSS_RENT_LAMPORTS } from "./network-fee-budget.mjs";
import { SNIPE_GATES, SOL_QUOTE_MINT, snipeContract, quoteTicketFor } from "./snipe-entry.mjs";
import { SNIPE_LANE_DEFAULTS, effectiveLaneConfig } from "./snipe-lane.mjs";
import { decodeBondingCurve } from "./snipe-venue-pumpfun.mjs";
import { describeMint, auditMintAccount, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./token2022.mjs";
import { openSnipe, updateSnipe, IMMUTABLE_SNIPE_FIELDS } from "./snipe-book.mjs";
import { snipeScorecard, quoteMintsOf, rowQuoteMint, shadowReport, renderShadowReport } from "./snipe-shadow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0; let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

/* ════ THE LIVE BYTES ═════════════════════════════════════════════════════════════════ */

const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pumpfun-xstock-quote.json"), "utf8"));
const account = (address) => {
  const row = FIXTURE.accounts.find((a) => a.address === address);
  assert.ok(row, `fixture has ${address}`);
  return { owner: row.owner, data: Buffer.from(row.data[0], "base64") };
};
const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LIVE_CURVE = "JXJC7sJa235q7GbFjsQ9oorm6wHForQ8MZJoF1MedDP";
const LIVE_MINT = "DRA4qXNRw5XBd5aVBjFdKJWMc1yiBpqrp8gTWYsmpump";

const gldx = describeMint(account(GLDX), GLDX);
const tslax = describeMint(account(TSLAX), TSLAX);
const liveCurve = decodeBondingCurve(account(LIVE_CURVE), { mint: LIVE_MINT });

/** The quote facts the lane would fold: describeMint's record plus the wallet's sizing in
 *  the token's raw units. 0.05 GLDx a ticket, 0.20 GLDx a day, 0.01 GLDx minimum. */
const GLDX_RAW = 100_000_000n;                                   // one GLDx at 8 decimals
const quoteFactsFor = (described, over = {}) => ({
  mint: described.mint, decimals: described.decimals, tokenProgram: described.program,
  symbol: described.metadataSymbol, paused: described.paused, transferHookProgram: described.transferHookProgram,
  ticketRaw: GLDX_RAW / 20n, dailyCapRaw: GLDX_RAW / 5n, deployedTodayRaw: 0n, minTicketRaw: GLDX_RAW / 100n,
  ...over,
});

/* ════ THE CONTRACT'S FIXTURES, as test-snipe-entry.mjs builds them ═══════════════════ */

const CREATOR = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL = 1_000_000_000n; const TOK = 1_000_000n;
const SOL_CURVE = Object.freeze({
  kind: "bonding-curve", curveType: "standard", creator: CREATOR, complete: false, feeBps: 100,
  vQuoteRaw: 30n * SOL, vBaseRaw: 1_073_000_000n * TOK, realQuoteRaw: 0n, realBaseRaw: 793_100_000n * TOK,
});
/* The live GLDx curve's own reserves, with the fixture fee the SOL curve above uses (the
   decoder reports the fee as unknown; the contract's arithmetic does not depend on it). */
const STOCK_CURVE = Object.freeze({
  kind: "bonding-curve", curveType: "standard", creator: liveCurve.creator, complete: false, feeBps: 100,
  vQuoteRaw: liveCurve.vQuoteRaw, vBaseRaw: liveCurve.vBaseRaw,
  realQuoteRaw: liveCurve.realQuoteRaw, realBaseRaw: liveCurve.realBaseRaw,
  quoteMint: liveCurve.quoteMint, quoteIsSol: liveCurve.quoteIsSol, quoteDecimals: 8,
});
const CFG = Object.freeze({
  lane: "observe", maxSolPerTrade: 0.005, dailySolCap: 0.01, minSolPerTrade: 0.005,
  maxFeeShareOfStop: 0.25, networkFeeReserveSol: 500_000 / 1e9, maxPriceImpactPct: 5,
  maxEntryRoundTripLossPct: 12, maxNetworkFeeLamports: 2_000_000, maxNetworkFeePct: 10,
  maxRentLamports: MAX_GROSS_RENT_LAMPORTS, noticeMaxMs: 4_000, quoteMintAllowlist: [],
});
const NOW = 1_758_700_000_000;
const NOTICE = Object.freeze({ mint: LIVE_MINT, creator: liveCurve.creator, slot: FIXTURE.slot, noticeAt: NOW - 400, source: "logsSubscribe" });
const CLEAN_MINT = Object.freeze({
  ok: true, program: "spl-token-2022", isToken2022: true, decimals: 6, supply: "1000000000000000",
  mintAuthority: null, freezeAuthority: null, extensions: ["metadataPointer", "tokenMetadata"],
  extensionDetail: [{ extension: "metadataPointer" }, { extension: "tokenMetadata" }], botRefusals: [], flags: [],
});
const fixtureEncode = (baseOutRaw, maxQuoteInRaw) => {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(baseOutRaw, 0); data.writeBigUInt64LE(maxQuoteInRaw, 8);
  return { programId: PROGRAM, keys: [], data };
};
const PROOF_SIG = bs58.encode(Buffer.alloc(64, 7));
const ADAPTER = Object.freeze({
  id: "fixture-curve", programId: PROGRAM, supportsExactOut: true, supportedCurveTypes: ["standard"],
  quote: { mint: WSOL, decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE },
  watch: () => { throw new Error("the fixture adapter does not stream"); },
  accountsFor: () => [], curveFromAccount: (data) => data,
  quoteExactIn: (curve, quoteInRaw) => constantProductExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, quoteInRaw, feeBps: Number(curve.feeBps ?? 0) }),
  quoteExactOut: (curve, baseOutRaw) => constantProductExactOut({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseOutRaw, feeBps: Number(curve.feeBps ?? 0) }),
  sellExactIn: (curve, baseInRaw) => constantProductSellExactIn({ vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseInRaw, feeBps: Number(curve.feeBps ?? 0), realQuoteRaw: curve.realQuoteRaw ?? null }),
  buyIx: ({ baseOutRaw, maxQuoteInRaw }) => [fixtureEncode(baseOutRaw, maxQuoteInRaw)],
  sellIx: () => { throw new Error("fixture sell encoder"); },
  decodeBuyIx: (ix) => ({ baseOutRaw: ix.data.readBigUInt64LE(0), maxQuoteInRaw: ix.data.readBigUInt64LE(8) }),
  exitRoute: () => ({ via: "curve", reason: "the curve is the exit until it graduates" }),
  isComplete: (curve) => curve.complete === true,
  quoteReserveLamports: (curve) => curve.realQuoteRaw ?? 0n,
  layoutVerified: true,
  layoutProof: {
    cluster: "mainnet-beta", programId: PROGRAM,
    provedBy: "executor/test-snipe-quote-mint.mjs — FIXTURE LAYOUT, NOT A REAL VENUE PROOF",
    roundTrips: [
      { method: "buyIx", signature: PROOF_SIG, slot: 1, instructionIndex: 0 },
      { method: "sellIx", signature: PROOF_SIG, slot: 2, instructionIndex: 0 },
      { method: "decodeBuyIx", signature: PROOF_SIG, slot: 3, instructionIndex: 0 },
    ],
  },
});
const args = (over = {}) => ({
  notice: { ...NOTICE }, curve: { ...STOCK_CURVE }, adapter: ADAPTER, cfg: { ...CFG },
  book: { snipes: [], positions: [], attempts: [], deployedTodaySol: 0 }, nowMs: NOW,
  control: { hardStop: false, pauseEntries: false }, mint: { ...CLEAN_MINT },
  creator: { shareOfSupplyPct: 0.8, priorLaunches: 0 },
  fees: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 1_559_560 },
  instruction: null, socials: { twitter: "x", telegram: null, website: null }, ...over,
});
const allowGldx = (over = {}) => args({ cfg: { ...CFG, quoteMintAllowlist: [GLDX] }, ...over });

/* ════ 1. THE DEFAULT IS SOL ONLY ═════════════════════════════════════════════════════ */
console.log("\n1. THE ALLOWLIST DEFAULTS EMPTY, AND THE EFFECTIVE CONFIG KEEPS IT SO");
{
  const d = SNIPE_LANE_DEFAULTS.quoteMintAllowlist;
  ok("SNIPE_LANE_DEFAULTS.quoteMintAllowlist is an empty frozen array", Array.isArray(d) && d.length === 0 && Object.isFrozen(d));
  const eff = effectiveLaneConfig({ ...SNIPE_LANE_DEFAULTS, lane: "observe" });
  ok("effectiveLaneConfig passes it through untouched", eff.quoteMintAllowlist === d);
  const typed = effectiveLaneConfig({ ...SNIPE_LANE_DEFAULTS, lane: "observe", quoteMintAllowlist: [GLDX] });
  ok("...and an operator's list survives it", typed.quoteMintAllowlist.length === 1 && typed.quoteMintAllowlist[0] === GLDX);
}

/* ════ 2. A SOL CURVE IGNORES THE QUOTE FACTS ═════════════════════════════════════════ */
console.log("\n2. A SOL-QUOTED CURVE IS UNCHANGED BY QUOTE FACTS BESIDE IT (the regression)");
{
  const without = snipeContract(args({ curve: { ...SOL_CURVE } }));
  const withFacts = snipeContract(args({ curve: { ...SOL_CURVE }, quote: quoteFactsFor(gldx), cfg: { ...CFG, quoteMintAllowlist: [GLDX] } }));
  ok("the SOL curve clears every gate", without.ok === true, `${without.gate ?? "pass"}: ${without.detail.message.slice(0, 80)}`);
  ok("...with the quote facts present too", withFacts.ok === true, `${withFacts.gate ?? "pass"}`);
  ok("the ticket is still the SOL ticket", withFacts.detail.ticketLamports === 5_000_000n && withFacts.detail.ticketSol === 0.005);
  ok("the plan is byte-identical", withFacts.detail.baseOutRaw === without.detail.baseOutRaw && withFacts.detail.maxQuoteInRaw === without.detail.maxQuoteInRaw);
  ok("detail.quote says SOL, in both", without.detail.quote.isSol === true && withFacts.detail.quote.isSol === true
    && without.detail.quote.mint === SOL_QUOTE_MINT && without.detail.quote.curveMint === SOL_QUOTE_MINT
    && without.detail.quote.tokenProgram === TOKEN_PROGRAM && without.detail.quote.decimals === 9);
  ok("detail.quote is frozen", Object.isFrozen(withFacts.detail.quote));
  const legacy = snipeContract(args({ curve: { ...SOL_CURVE, quoteMint: undefined } }));
  ok("a curve with no quote field at all is SOL", legacy.ok === true && legacy.detail.quote.isSol === true);
  const byAddress = snipeContract(args({ curve: { ...SOL_CURVE, quoteMint: WSOL, quoteIsSol: false } }));
  ok("wrapped SOL by address is SOL", byAddress.ok === true && byAddress.detail.quote.isSol === true);
  const fee = withFacts.detail.feeBudget;
  ok("the SOL fee budget still has a percentage basis", fee !== null && fee.feeBasisLamports !== null && fee.pctOfBasis !== null,
    `basis ${fee?.feeBasisLamports} pct ${fee?.pctOfBasis?.toFixed(3)}`);
}

/* ════ 3. THE LIVE GLDx CURVE ═════════════════════════════════════════════════════════ */
console.log("\n3. THE LIVE GLDx-QUOTED CURVE, REFUSED BY NAME AND THEN ADMITTED");
{
  ok("the fixture curve decodes as quoted in GLDx", liveCurve.quoteMint === GLDX && liveCurve.quoteIsSol === false && liveCurve.mint === LIVE_MINT,
    `vQuote ${liveCurve.vQuoteRaw} realQuote ${liveCurve.realQuoteRaw}`);
  ok("describeMint reads GLDx as an 8-decimal Token-2022 mint, unpaused, hook program zero",
    gldx.decimals === 8 && gldx.program === TOKEN_2022_PROGRAM && gldx.paused === false && gldx.transferHookProgram === null && gldx.metadataSymbol === "GLDx");
  let audit = null;
  try { auditMintAccount(account(GLDX), GLDX); } catch (error) { audit = error.message; }
  ok("...and the BASE-mint audit refuses the same bytes, which is why a quote is described, never judged",
    typeof audit === "string", audit?.slice(0, 90));

  const notListed = snipeContract(args());
  ok("empty allowlist: refused at quote_not_sol", notListed.ok === false && notListed.gate === "quote_not_sol");
  ok("...and the message says the allowlist is empty", /allowlist is empty: this lane pays in SOL only/.test(notListed.detail.message), notListed.detail.message.slice(0, 120));
  ok("...naming the quote", notListed.detail.quoteMint === GLDX && notListed.detail.quote.curveMint === GLDX && notListed.detail.quote.isSol === true);

  const otherListed = snipeContract(args({ cfg: { ...CFG, quoteMintAllowlist: [TSLAX] } }));
  ok("a list that names a different mint refuses, counting what is listed",
    otherListed.gate === "quote_not_sol" && /1 other mint is listed/.test(otherListed.detail.message), otherListed.detail.message.slice(-60));

  const noFacts = snipeContract(allowGldx());
  ok("allowlisted, no facts: refused at quote_not_sol", noFacts.gate === "quote_not_sol" && /no quote facts were supplied/.test(noFacts.detail.message), noFacts.detail.message.slice(0, 120));

  const badFacts = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { decimals: 20 }) }));
  ok("allowlisted, malformed facts: refused with the reason", badFacts.gate === "quote_not_sol" && /quote\.decimals 20 is outside/.test(badFacts.detail.message), badFacts.detail.message.slice(-90));
  const badProgram = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { tokenProgram: "11111111111111111111111111111111" }) }));
  ok("...a quote owned by a non-token program too", badProgram.gate === "quote_not_sol" && /not a token program this lane knows/.test(badProgram.detail.message));
  const looseBool = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { paused: "no" }) }));
  ok("...and `paused` must be a strict boolean", looseBool.gate === "quote_not_sol" && /paused must be a strict boolean/.test(looseBool.detail.message));

  const wrongMint = snipeContract(allowGldx({ quote: quoteFactsFor(tslax) }));
  ok("facts for TSLAx beside a GLDx curve: refused, saying which mint the facts describe",
    wrongMint.gate === "quote_not_sol" && /describe XsDoVfqe.*not this quote/.test(wrongMint.detail.message), wrongMint.detail.message.slice(-100));

  const paused = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { paused: true }) }));
  ok("a PAUSED quote is refused at quote_not_sol", paused.gate === "quote_not_sol" && paused.detail.paused === true && /PAUSED/.test(paused.detail.message));

  const overCap = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { deployedTodayRaw: GLDX_RAW / 5n - GLDX_RAW / 25n }) }));
  ok("the day cap is judged in GLDx, exactly", overCap.gate === "daily_capacity" && overCap.detail.quoteMint === GLDX
    && overCap.detail.wouldBeRaw === GLDX_RAW / 5n - GLDX_RAW / 25n + GLDX_RAW / 20n, overCap.detail.message);
  ok("...with the amounts printed in GLDx units", /0\.05000000 GLDx ticket .* 0\.20000000 GLDx cap/.test(overCap.detail.message));
  const atCap = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { deployedTodayRaw: GLDX_RAW / 5n - GLDX_RAW / 20n }) }));
  ok("...and a ticket that lands exactly on the cap passes it", atCap.gate !== "daily_capacity");

  const tiny = snipeContract(allowGldx({ quote: quoteFactsFor(gldx, { minTicketRaw: GLDX_RAW }) }));
  ok("the minimum ticket is judged in GLDx", tiny.gate === "size_under_minimum" && tiny.detail.quoteMint === GLDX && tiny.detail.minTicketRaw === GLDX_RAW,
    tiny.detail.message);

  const clean = snipeContract(allowGldx({ quote: quoteFactsFor(gldx) }));
  ok(`the clean stock launch clears all ${SNIPE_GATES.length} gates`, clean.ok === true, `${clean.gate ?? "pass"}: ${clean.detail.message.slice(0, 100)}`);
  ok("the ticket is 0.05 GLDx raw", clean.detail.ticketLamports === GLDX_RAW / 20n && clean.detail.ticketSol === 0.05);
  ok("detail.quote names GLDx, Token-2022, 8 decimals, not SOL", clean.detail.quote.mint === GLDX && clean.detail.quote.curveMint === GLDX
    && clean.detail.quote.isSol === false && clean.detail.quote.decimals === 8 && clean.detail.quote.tokenProgram === TOKEN_2022_PROGRAM
    && clean.detail.quote.symbol === "GLDx" && clean.detail.quote.ticketRaw === GLDX_RAW / 20n);
  ok("the plan is sized in GLDx raw: the ceiling is at most the ticket", clean.detail.maxQuoteInRaw > 0n && clean.detail.maxQuoteInRaw <= GLDX_RAW / 20n,
    `baseOut ${clean.detail.baseOutRaw} ceiling ${clean.detail.maxQuoteInRaw} impact ${clean.detail.impactPct?.toFixed(4)}%`);
  ok("the stop floor is traced as unmeasured", "stop_floor" in clean.detail.measured && clean.detail.measured.stop_floor === null);
  const fee = clean.detail.feeBudget;
  ok("the fee budget ran on absolute caps only: null basis, ceiling = maxNetworkFeeLamports", fee !== null && fee.feeBasisLamports === null
    && fee.pctOfBasis === null && fee.networkFeeCeilingLamports === 2_000_000n, `ceiling ${fee?.networkFeeCeilingLamports}`);
  ok("...and the xStock ATA rent (179 bytes) is inside the rent cap", fee.rentFeeLamports === 1_559_560 && fee.rentFeeLamports <= fee.maxRentLamports);
  const feeHigh = snipeContract(allowGldx({ quote: quoteFactsFor(gldx), fees: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 2_000_000, rentFeeLamports: 0 } }));
  ok("the absolute network-fee cap still binds on a stock ticket", feeHigh.gate === "network_fee_over_cap" && feeHigh.detail.feeBasisLamports === null, feeHigh.detail.message);
  const every = clean.trace.map((s) => s.gate).join(",");
  ok("the trace ran every gate in order", every === SNIPE_GATES.join(","));

  /* quoteTicketFor on its own: the exported validator is what the lane and the browser call. */
  const q = quoteTicketFor(quoteFactsFor(gldx));
  ok("quoteTicketFor freezes a ticket in the quote's units", Object.isFrozen(q) && q.ticketUnits === 0.05 && q.ticketRaw === 5_000_000n && q.symbol === "GLDx");
  let zero = null; try { quoteTicketFor(quoteFactsFor(gldx, { ticketRaw: 0n })); } catch (e) { zero = e.message; }
  ok("...and refuses a zero ticket", /quote\.ticketRaw must be positive/.test(zero ?? ""), zero);
  let noSymbol = quoteTicketFor(quoteFactsFor(gldx, { symbol: undefined }));
  ok("...defaulting the symbol to the mint's first four characters", noSymbol.symbol === "Xsv9");
}

/* ════ 4. THE BOOK ROW AT EIGHT DECIMALS ══════════════════════════════════════════════ */
console.log("\n4. A FILL PAID IN GLDx OPENS IN THE BOOK, AND SAYS SO");
{
  const keyFrom = (seed) => {
    const bytes = new Uint8Array(32); let x = seed >>> 0;
    for (let i = 0; i < 32; i++) { x = (Math.imul(x ^ (x >>> 15), 2246822519) + 1) >>> 0; bytes[i] = x & 0xff; }
    bytes[0] ||= 7; return bs58.encode(bytes);
  };
  const MINT = keyFrom(41); const CREATOR_KEY = keyFrom(42);
  /* 0.05 GLDx in: sizeSol here is the size in the QUOTE's units (the field name predates
     the quote field; the row's quoteMint says what the unit is). */
  const row = {
    mint: MINT, venue: "pumpfun", entry: 1, openedAt: NOW, sizeSol: 0.05, feeSolPerLeg: 0,
    qtyRaw: 4_600_000_000_000n, entryInputLamports: 5_000_000n, entryFeeLamports: 0n,
    creator: CREATOR_KEY, openedAtSlot: FIXTURE.slot,
    quoteMint: GLDX, quoteDecimals: 8, networkFeeLamports: "15000",
  };
  const S = { positions: {}, snipes: {} };
  let opened = null; let openErr = null;
  try { opened = openSnipe(S, row); } catch (e) { openErr = e; }
  ok("the GLDx row opens", opened !== null, openErr ? `${openErr.clause}: ${openErr.message.slice(0, 100)}` : `${opened.quoteMint.slice(0, 6)} @ ${opened.quoteDecimals}dp`);
  ok("it carries the quote and its decimals", opened?.quoteMint === GLDX && opened?.quoteDecimals === 8);
  ok("the network fee travels as a digit string", opened?.networkFeeLamports === "15000");
  ok("the two quote fields are immutable", IMMUTABLE_SNIPE_FIELDS.includes("quoteMint") && IMMUTABLE_SNIPE_FIELDS.includes("quoteDecimals"));
  const refuses = (name, patch, clause) => {
    let got = null;
    try { openSnipe({ positions: {}, snipes: {} }, { ...row, ...patch }); } catch (e) { got = e; }
    ok(name, got !== null && got.clause === clause, got ? `${got.clause}: ${got.message.slice(0, 100)}` : "opened");
  };
  refuses("a GLDx row without decimals is refused", { quoteDecimals: undefined }, "quote_invalid");
  refuses("a GLDx row with a SOL fee folded into the size is refused", { feeSolPerLeg: 0.0005 }, "quote_invalid");
  refuses("a GLDx row with entryFeeLamports set is refused", { entryFeeLamports: 500_000n }, "quote_invalid");
  refuses("a quote that is not a key is refused", { quoteMint: "GLDx" }, "quote_invalid");
  refuses("decimals outside 0..18 are refused", { quoteDecimals: 19 }, "quote_invalid");
  refuses("a non-digit network fee is refused under the book's own durability clause", { networkFeeLamports: "15000.5" }, "raw_amount_not_durable");
  let mutated = null;
  try { updateSnipe(S, { ...opened, quoteMint: TSLAX }); } catch (e) { mutated = e; }
  ok("updateSnipe refuses to change the quote", mutated !== null, mutated?.message?.slice(0, 100));
  const solRow = openSnipe({ positions: {}, snipes: {} }, { ...row, quoteMint: undefined, quoteDecimals: undefined, networkFeeLamports: undefined, feeSolPerLeg: 0.0005, entryFeeLamports: 500_000n, sizeSol: 0.005, entryInputLamports: 4_500_000n });
  ok("a SOL row opens exactly as before", solRow.quoteMint === undefined && solRow.feeSolPerLeg === 0.0005);
}

/* ════ 5. THE SCORECARD IS ONE POPULATION PER QUOTE ═══════════════════════════════════ */
console.log("\n5. GLDx ROWS AND SOL ROWS ARE JUDGED APART");
{
  const mk = (i, followed, quoteMint) => ({
    mint: `M${i}`, wouldHaveSigned: true,
    curve: { reserveKnown: true, realQuoteRaw: "1000", ...(quoteMint ? { quoteMint, quoteDecimals: 8 } : {}) },
    forward: [{ realQuoteRaw: followed ? "2000" : "900" }],
    gate: { measured: { creator_profile: 12, launch_share: 150 } },
  });
  const sol = [...Array.from({ length: 30 }, (_, i) => mk(i, i % 3 === 0, null))];
  const stock = [...Array.from({ length: 12 }, (_, i) => mk(100 + i, i % 2 === 0, GLDX))];
  const rows = [...sol, ...stock];
  ok("rowQuoteMint reads SOL for a row with no quote field", rowQuoteMint(sol[0]) === SOL_QUOTE_MINT && rowQuoteMint(stock[0]) === GLDX);
  ok("quoteMintsOf lists SOL first, then GLDx", JSON.stringify(quoteMintsOf(rows)) === JSON.stringify([SOL_QUOTE_MINT, GLDX]));
  const solCard = snipeScorecard(rows, { minRows: 5, minFlagged: 3 });
  const gldxCard = snipeScorecard(rows, { minRows: 5, minFlagged: 3, quoteMint: GLDX });
  ok("the default card judges the SOL rows only", solCard.judged === 30 && solCard.quoteMint === SOL_QUOTE_MINT && solCard.excludedByQuote[GLDX] === 12,
    `judged ${solCard.judged} excluded ${JSON.stringify(solCard.excludedByQuote)}`);
  ok("the GLDx card judges the GLDx rows only", gldxCard.judged === 12 && gldxCard.quoteMint === GLDX && gldxCard.excludedByQuote[SOL_QUOTE_MINT] === 30,
    `judged ${gldxCard.judged}`);
  /* A positive is a launch NOBODY followed (the reserve never advanced past the fill). */
  ok("the two cards' positives add up to the book's", solCard.positives + gldxCard.positives === rows.filter((r) => r.forward[0].realQuoteRaw === "900").length,
    `${solCard.positives} + ${gldxCard.positives}`);
  const report = shadowReport(rows, { minRows: 5, minFlagged: 3 });
  ok("shadowReport carries one card per quote", Object.keys(report.scorecardByQuote).length === 2 && report.scorecardByQuote[GLDX].judged === 12);
  const text = renderShadowReport(report);
  ok("...and renders both", /quote SOL/.test(text) && text.includes(`quote ${GLDX}`));
}

console.log(`\n${failed ? "FAIL" : "PASS"} test-snipe-quote-mint  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
