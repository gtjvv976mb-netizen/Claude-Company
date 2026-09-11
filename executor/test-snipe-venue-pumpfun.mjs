/* THE PUMP.FUN ADAPTER, DRIVEN AGAINST REAL MAINNET BYTES WHOSE ANSWER WAS KNOWN FIRST.
 *
 * Every fixture below was read off mainnet-beta on 2026-09-11 through the free public
 * endpoint and is pasted here verbatim. Nothing in this file is synthetic except where a
 * line says so out loud, and every synthetic case exists to prove a REFUSAL — because a
 * decoder that has only ever been shown correct bytes has not been tested, it has been
 * demonstrated.
 *
 * THE DISCIPLINE, WHICH IS THE REPO'S OWN (CLAUDE.md, the arccos rule): validate the ruler
 * before trusting it. The offsets this adapter reads are not asserted against a second
 * copy of themselves — they are asserted against numbers produced by somebody else:
 *
 *   · pump.fun's own API row for the same mint in the same minute        (§2, six fields)
 *   · the bonding-curve PDA the program itself emitted in a CreateEvent  (§2, §9)
 *   · 85.005 SOL to graduate, the figure test-pumpfun-curve.mjs pins by hand, re-derived
 *     here from an account decoded through a completely different path   (§4)
 *   · the tokens a REAL on-chain buy actually delivered, to the raw unit (§8)
 *   · the lamports two REAL swaps were actually charged in fees          (§7)
 *
 * If any offset in the adapter drifts by one byte, at least four of those five stop
 * agreeing. That is what makes them a ruler rather than a restatement.
 *
 * AND BOTH DIRECTIONS, EVERYWHERE. A wrong discriminator, a truncated account, a foreign
 * owner, a corrupted event, a missing fee, an execute request: each one is asserted to be
 * REFUSED, with the clause named. A fence that has never said no is not a fence.
 *
 * NO NETWORK. NO CLOCK. NO KEYPAIR. This file runs offline in well under a second.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import { auditMintAccount, TOKEN_2022_PROGRAM } from "./token2022.mjs";
import { snipeCurveState, constantProductExactIn } from "./snipe-curve.mjs";
import {
  venueContract, createVenueRegistry, registerVenue, venueFor, VenueContractError,
  REQUIRED_VENUE_METHODS,
} from "./snipe-venue.mjs";
import {
  PUMPFUN_VENUE, PUMPFUN_VENUE_ID, PUMPFUN_PROGRAM_ID, PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_VENUE_VERSION, BONDING_CURVE_DISCRIMINATOR, GLOBAL_DISCRIMINATOR,
  CREATE_EVENT_DISCRIMINATOR, TRADE_EVENT_DISCRIMINATOR, BONDING_CURVE_LAYOUT,
  BONDING_CURVE_MIN_BYTES, BONDING_CURVE_WITH_CREATOR_BYTES, GLOBAL_LAYOUT, GLOBAL_MIN_BYTES,
  PUMPFUN_ACCOUNT_ROLES, PUMPFUN_BASE_DECIMALS, PUMPFUN_CURVE_TYPE, PUMPFUN_FEE_OBSERVATION,
  PUMPFUN_LAYOUT_EVIDENCE, LAYOUT_UNVERIFIED_REASON, PumpfunVenueError,
  bondingCurveAddress, globalAddress, decodeBondingCurve, curveFromAccount, decodeGlobal,
  decodeCreateEvent, decodeTradeEvent, eventsFromLogs, noticesFromLogs,
  quoteExactIn, quoteExactOut, sellExactIn, buyIx, buildBuy, sellIx, decodeBuyIx, PUMPFUN_IX,
  exitRoute, isComplete, quoteReserveLamports, watch,
} from "./snipe-venue-pumpfun.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log("  ok   ", name); pass++; }
  catch (error) { console.log("  FAIL ", name, "\n         ", error.message); fail++; }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/* ── FIXTURES — every one of these is a real mainnet read, 2026-09-11 ───────────────── */

/** Account CaLhPyhttKFHy2T6i12HCuqocFCCKuf49Z5QYpS3Fp77, 124 bytes, owner 6EF8rre…F6P. */
const LIVE_CURVE_MINT = "BjPvXGPq6aPvamzeJAhRF5HaTixY4zAtRti1WtSepump";
const LIVE_CURVE_ADDRESS = "CaLhPyhttKFHy2T6i12HCuqocFCCKuf49Z5QYpS3Fp77";
const LIVE_CURVE_HEX =
  "17b7f83760d8ac605cf5d97852cc0300055db202070000005c5dc72cc1cd020005b18e06000000000080c6a47e8d0300" +
  "0033af42ec3f732fe1bd41b36c4f42a44f591a9f5d854a3ff5920e5dca5bd130dd010100000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000";
/** THE ANSWER, KNOWN BEFORE THE DECODE: the row frontend-api-v3.pump.fun returned for
 *  that mint in the same minute. The adapter never sees this object. */
const LIVE_CURVE_FEED_ROW = Object.freeze({
  virtual_token_reserves: 1069079517066588n,
  virtual_sol_reserves: 30110014725n,
  real_token_reserves: 789179517066588n,
  real_sol_reserves: 110014725n,
  complete: false,
  creator: "4Uko6H1FMJVuxxDjtnkjvbTf3adLmny5tWdnwdgLXLkt",
});

/** Account Cg14LaBKV4TrN253WmpA55LB9R9ec38HMcgPjyiFaM5i — a GRADUATED coin's curve, and
 *  the whole account is 49 bytes with nowhere to put a creator. */
const GRADUATED_CURVE_MINT = "6ZrYhkwvoYE4QqzpdzJ7htEHwT2u2546EkTNJ7qepump";
const GRADUATED_CURVE_HEX =
  "17b7f83760d8ac6000000000000000000000000000000000000000000000000000000000000000000080c6a47e8d0300" +
  "01";
/** What pump.fun's feed still reports for it — the reserves it had BEFORE graduating.
 *  115.005 − 30 = 85.005 SOL raised, which is the repo's own hand-worked figure. */
const GRADUATED_FEED_VSOL = 115005360585n;

/** The first 113 bytes of Global 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf (1054 on
 *  chain; only the decoded prefix is pasted, because nothing past offset 113 is read). */
const GLOBAL_PREFIX_HEX =
  "a7e8e8b1c86c727f01d3bb8cab341ce0528457f2c3817d3278441963dcd55fed58ba24c999ddac02aa4ac2f8d0dd5cbc" +
  "97e3289c197cb5062a54f3d956b9ce6e5115f96567aa5cb3e60010d847e3cf030000ac23fc060000000078c5fb51d102" +
  "000080c6a47e8d03005f00000000000000";

/** The real `Program data:` payloads. Create is from tx 3X3mQJn8… (slot 446,023,102);
 *  the two trades are the buy in that same transaction and a sell 138 slots later. */
const CREATE_EVENT_B64 =
  "G3KpTd7rY3YUAAAAT2ZmaWNpYWwgQm9uemkgQnVkZHkFAAAAQk9OWklQAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvYmFma3JlaWRmdXJuM2Nuamd2Z2RuaWlieTNwcGJxYnp3d2gzd3NhbXBxY3Q0bDV5ZnR0ZHB4c2Rjcm0NZ5R4DNvGl0tdsj/oi5NhqzmUroaJv1bVWiRWfUFub6w6hiMVms8iL7nS7iRC5+rcowQNHOvPJZKmxhphQWFNdSHpBIjrPE5vfQmu9Yn2YsBxf4PapMpSIufJGz/xsdZ1IekEiOs8Tm99Ca71ifZiwHF/g9qkylIi58kbP/Gx1m5Oo2oAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAA";
const TRADE_EVENT_BUY_B64 =
  "vdt/007mYe4NZ5R4DNvGl0tdsj/oi5NhqzmUroaJv1bVWiRWfUFub+AN3DoAAAAAerAAaxkfAAABdSHpBIjrPE5vfQmu9Yn2YsBxf4PapMpSIufJGz/xsdZuTqNqAAAAAOC5/zYHAAAAhl/X3MmwAwDgDdw6AAAAAIbHxJA4sgIASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZfAAAAAAAAAIIljwAAAAAAdSHpBIjrPE5vfQmu9Yn2YsBxf4PapMpSIufJGz/xsdYeAAAAAAAAAEQ0LQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAADBkkcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAN3DoAAAAA4Ln/NgcAAADgDdw6AAAAAA==";
const TRADE_EVENT_SELL_B64 =
  "vdt/007mYe4NZ5R4DNvGl0tdsj/oi5NhqzmUroaJv1bVWiRWfUFub8YNZhQAAAAAgBzYo+sJAAAA+UtekzmAkAR4pfcS0bWIozXRq6nxT5Vg9wOAMcZufJCZTqNqAAAAAICuEVwHAAAAurFjAzOeAwCAAu5fAAAAALoZUbehnwIAYIzMHfzpYbQ7d5wZFQWm4tO/RdWk20YYrXbILWF1RTVfAAAAAAAAAAmcMQAAAAAAw8EWYS4O8tBSJ3LKMEhG9TZvlAeEifg2L4qFudIJT4IeAAAAAAAAAIqqDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAHNlbGwAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAABM4YAAAAAAABAAAAGeT7K3fprQwNQiKrQF12ZT1c5Y8G6drNzCpGEtWP6xAQJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxg1mFAAAAACArhFcBwAAAIAC7l8AAAAA";
const CREATE_TX_SIGNATURE =
  "3X3mQJn8Bhe3zBKFjYwvUarL45uzEbjHjXy5Ebh2GJxNUfD4a1TBWdqSJfg8iHLVJbu1rR3Nded1qyhMFV8a3K8d";
const CREATE_TX_SLOT = 446023102;
const LAUNCH_MINT = "uKubAxmYJEABdmw6hqegbgghe6fcmaHqjKd2umjpump";

/** The launch mint account itself, 423 bytes, owner Token-2022 — pasted so spec gate 11
 *  is checked against real bytes rather than against the allow-list's good intentions. */
const LAUNCH_MINT_HEX =
  "0000000000000000000000000000000000000000000000000000000000000000000000000080c6a47e8d030006010000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000011200400000000000000000000000000000000000000000000000" +
  "000000000000000000000d6794780cdbc6974b5db23fe88b9361ab3994ae8689bf56d55a24567d416e6f1300b9000000" +
  "0000000000000000000000000000000000000000000000000000000000000d6794780cdbc6974b5db23fe88b9361ab39" +
  "94ae8689bf56d55a24567d416e6f140000004f6666696369616c20426f6e7a6920427564647905000000424f4e5a4950" +
  "00000068747470733a2f2f697066732e696f2f697066732f6261666b726569646675726e33636e6a677667646e696962" +
  "793370706271627a777768337773616d70716374346c3579667474647078736463726d00000000";

const bytes = (hex) => Buffer.from(hex, "hex");
const LIVE = () => bytes(LIVE_CURVE_HEX);
const GRAD = () => bytes(GRADUATED_CURVE_HEX);
const LIVE_INFO = () => ({ owner: PUMPFUN_PROGRAM_ID, data: LIVE() });
/** The measured fee is passed EXPLICITLY at every call site in this file, which is the
 *  point of the adapter refusing to default it. */
const FEE = PUMPFUN_FEE_OBSERVATION.totalFeeBps;

/* ── 1. THE RULER: DISCRIMINATORS ARE DERIVED, THEN CHECKED AGAINST REAL BYTES ──────── */
console.log("\n1. THE DISCRIMINATORS — derived from the anchor convention, then measured");
ok("every discriminator constant equals sha256(<namespace>:<Name>)[0..8]", () => {
  const d = (ns, n) => crypto.createHash("sha256").update(`${ns}:${n}`).digest().subarray(0, 8).toString("hex");
  const pairs = [
    ["account", "BondingCurve", BONDING_CURVE_DISCRIMINATOR],
    ["account", "Global", GLOBAL_DISCRIMINATOR],
    ["event", "CreateEvent", CREATE_EVENT_DISCRIMINATOR],
    ["event", "TradeEvent", TRADE_EVENT_DISCRIMINATOR],
  ];
  for (const [ns, name, constant] of pairs) {
    assert.equal(d(ns, name), constant, `${ns}:${name} -> ${d(ns, name)}, constant says ${constant}`);
    console.log(`         sha256("${ns}:${name}")[0..8] = ${constant}`);
  }
});
ok("both REAL curve accounts start with that derived discriminator", () => {
  for (const [label, buf] of [["live 124B", LIVE()], ["graduated 49B", GRAD()]]) {
    const got = buf.subarray(0, 8).toString("hex");
    assert.equal(got, BONDING_CURVE_DISCRIMINATOR, `${label} starts ${got}`);
    console.log(`         ${label}: ${got}`);
  }
});
ok("the REAL Global account starts with the Global discriminator", () => {
  const got = bytes(GLOBAL_PREFIX_HEX).subarray(0, 8).toString("hex");
  assert.equal(got, GLOBAL_DISCRIMINATOR, `Global starts ${got}`);
  console.log(`         ${got}`);
});
ok("ONE FLIPPED BYTE in the discriminator is refused — the ruler can say no", () => {
  const bad = LIVE(); bad[7] ^= 0x01;
  const err = throws(() => decodeBondingCurve(bad, { requireOwner: false }));
  assert.ok(err instanceof PumpfunVenueError, `threw ${err && err.name}`);
  assert.equal(err.clause, "account_discriminator_mismatch", `clause=${err.clause}`);
  assert.equal(curveFromAccount(bad, { requireOwner: false }), null, "curveFromAccount returned a curve for it");
  console.log(`         byte 7 flipped -> ${err.clause} (${err.detail.discriminator}); curveFromAccount -> null`);
});

/* ── 2. THE LIVE CURVE, AGAINST PUMP.FUN'S OWN ROW ─────────────────────────────────── */
console.log("\n2. THE LIVE CURVE — six fields, each one an answer known before the decode");
ok("every decoded reserve equals the API row for the same mint in the same minute", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const checks = [
    ["vBaseRaw", c.vBaseRaw, LIVE_CURVE_FEED_ROW.virtual_token_reserves],
    ["vQuoteRaw", c.vQuoteRaw, LIVE_CURVE_FEED_ROW.virtual_sol_reserves],
    ["realBaseRaw", c.realBaseRaw, LIVE_CURVE_FEED_ROW.real_token_reserves],
    ["realQuoteRaw", c.realQuoteRaw, LIVE_CURVE_FEED_ROW.real_sol_reserves],
  ];
  for (const [name, got, want] of checks) {
    assert.equal(got, want, `${name} decoded ${got}, the row says ${want}`);
    console.log(`         ${name.padEnd(12)} ${got}  == row`);
  }
  assert.equal(c.complete, LIVE_CURVE_FEED_ROW.complete, `complete=${c.complete}`);
  assert.equal(c.creator, LIVE_CURVE_FEED_ROW.creator, `creator=${c.creator}`);
  assert.equal(c.tokenTotalSupplyRaw, 1000000000000000n, `supply=${c.tokenTotalSupplyRaw}`);
  console.log(`         complete ${c.complete}, creator ${c.creator}, supply ${c.tokenTotalSupplyRaw}`);
});
ok("the PDA this module derives IS the account that was read", () => {
  const derived = bondingCurveAddress(LIVE_CURVE_MINT).toBase58();
  assert.equal(derived, LIVE_CURVE_ADDRESS, `derived ${derived}, read ${LIVE_CURVE_ADDRESS}`);
  const g = globalAddress().toBase58();
  assert.equal(g, PUMPFUN_LAYOUT_EVIDENCE.accounts.global.address, `global PDA ${g}`);
  console.log(`         curve PDA ${derived}\n         global PDA ${g}`);
});
ok("the decoded shape carries what snipe-curve.mjs and the gates need", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  assert.equal(c.curveType, PUMPFUN_CURVE_TYPE, `curveType=${c.curveType}`);
  assert.equal(c.quoteMint, WSOL, `quoteMint=${c.quoteMint}`);
  assert.equal(c.quoteDecimals, 9, `quoteDecimals=${c.quoteDecimals}`);
  assert.equal(c.baseDecimals, PUMPFUN_BASE_DECIMALS, `baseDecimals=${c.baseDecimals}`);
  assert.equal(c.layoutVariant, "with-creator", `layoutVariant=${c.layoutVariant}`);
  assert.equal(c.bytes, 124, `bytes=${c.bytes}`);
  assert.ok(Object.isFrozen(c), "the decoded curve is not frozen");
  for (const k of ["vBaseRaw", "vQuoteRaw", "realBaseRaw", "realQuoteRaw", "tokenTotalSupplyRaw"])
    assert.equal(typeof c[k], "bigint", `${k} is ${typeof c[k]}, not bigint`);
  console.log(`         curveType ${c.curveType}, quote ${c.quoteMint.slice(0, 8)}…/${c.quoteDecimals}dp, ` +
    `variant ${c.layoutVariant}, ${c.bytes} bytes, all amounts bigint, frozen`);
});
ok("the decode does not mutate the buffer it is handed, and repeats exactly", () => {
  const buf = LIVE(); const before = Buffer.from(buf);
  const a = decodeBondingCurve(buf, { feeBps: FEE, mint: LIVE_CURVE_MINT, requireOwner: false });
  const b = decodeBondingCurve(buf, { feeBps: FEE, mint: LIVE_CURVE_MINT, requireOwner: false });
  assert.ok(before.equals(buf), "the input buffer changed during decode");
  assert.deepEqual(a, b, "two decodes of the same bytes differed");
  console.log(`         buffer unchanged (${buf.length} bytes), two decodes deep-equal`);
});
ok("an account owned by another program is refused, and refused by NAME", () => {
  const err = throws(() => decodeBondingCurve({ owner: TOKEN_2022_PROGRAM, data: LIVE() }, { feeBps: FEE }));
  assert.equal(err.clause, "account_wrong_owner", `clause=${err && err.clause}`);
  assert.match(err.message, /Tokenz/, `message=${err.message}`);
  console.log(`         owner ${TOKEN_2022_PROGRAM.slice(0, 10)}… -> ${err.clause}`);
});
ok("a truncated account is refused rather than read past its end", () => {
  const err = throws(() => decodeBondingCurve(LIVE().subarray(0, BONDING_CURVE_MIN_BYTES - 1), { requireOwner: false }));
  assert.equal(err.clause, "account_too_short", `clause=${err && err.clause}`);
  assert.equal(err.detail.bytes, BONDING_CURVE_MIN_BYTES - 1, `bytes=${err.detail.bytes}`);
  console.log(`         ${BONDING_CURVE_MIN_BYTES - 1} bytes -> ${err.clause} (minimum ${BONDING_CURVE_MIN_BYTES})`);
});

/* ── 3. THE 49-BYTE GRADUATED CURVE ────────────────────────────────────────────────── */
console.log("\n3. THE GRADUATED CURVE — a second real length, and no creator to read");
ok("49 bytes decodes, reports complete, and reports creator: null", () => {
  assert.equal(GRAD().length, BONDING_CURVE_MIN_BYTES, `fixture is ${GRAD().length} bytes`);
  const c = decodeBondingCurve(GRAD(), { feeBps: FEE, mint: GRADUATED_CURVE_MINT, requireOwner: false });
  assert.equal(c.complete, true, `complete=${c.complete}`);
  assert.equal(c.creator, null, `creator=${c.creator} — 32 bytes were read past the end of a 49-byte account`);
  assert.equal(c.layoutVariant, "no-creator", `layoutVariant=${c.layoutVariant}`);
  assert.equal(isComplete(c), true, `isComplete=${isComplete(c)}`);
  console.log(`         ${c.bytes} bytes, complete ${c.complete}, creator ${c.creator}, variant ${c.layoutVariant}`);
});
ok("A GRADUATED CURVE READS ALL ZEROS — which is why complete is a structural fact", () => {
  const c = decodeBondingCurve(GRAD(), { feeBps: FEE, requireOwner: false });
  for (const k of ["vBaseRaw", "vQuoteRaw", "realBaseRaw", "realQuoteRaw"])
    assert.equal(c[k], 0n, `${k}=${c[k]}`);
  assert.equal(quoteReserveLamports(c), 0n, `quoteReserveLamports=${quoteReserveLamports(c)}`);
  console.log(`         all four reserves 0 on chain while the feed still reports vSol ${GRADUATED_FEED_VSOL};`);
  console.log(`         a mark built on these bytes is 0.0 — a FLOOR trigger out of a coin that merely graduated`);
});
ok("the two variants really are different, in the direction claimed", () => {
  const live = decodeBondingCurve(LIVE(), { requireOwner: false });
  const grad = decodeBondingCurve(GRAD(), { requireOwner: false });
  assert.ok(live.bytes >= BONDING_CURVE_WITH_CREATOR_BYTES, `live is ${live.bytes} bytes`);
  assert.ok(grad.bytes < BONDING_CURVE_WITH_CREATOR_BYTES, `graduated is ${grad.bytes} bytes`);
  assert.notEqual(live.creator, grad.creator, "both variants produced the same creator");
  console.log(`         ${live.bytes}B -> creator ${live.creator.slice(0, 10)}… | ${grad.bytes}B -> ${grad.creator}`);
});

/* ── 4. THE 85.005 CROSS-CHECK — the repo's own hand-worked number, re-derived ──────── */
console.log("\n4. 85.005 SOL TO GRADUATE — derived from bytes, not asserted as a constant");
ok("snipeCurveState on the real live curve lands on the repo's measured figure", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const s = snipeCurveState(c);
  assert.equal(s.heldBaseRaw, 279900000000000n,
    `held = vBase - realBase = ${s.heldBaseRaw}, and every live row measures 279,900,000,000,000`);
  const toGraduateSol = Number(s.quoteToCompleteRaw) / 1e9;
  const gradTotalSol = Number(c.realQuoteRaw) / 1e9 + toGraduateSol;
  assert.ok(Math.abs(gradTotalSol - 85.005) < 0.01,
    `graduation total derived as ${gradTotalSol.toFixed(6)} SOL, the repo's fixture says 85.005`);
  console.log(`         held ${s.heldBaseRaw} (279.9M, as every live row measures)`);
  console.log(`         still owed ${toGraduateSol.toFixed(6)} SOL + raised ${(Number(c.realQuoteRaw) / 1e9).toFixed(6)}` +
    ` = ${gradTotalSol.toFixed(6)} SOL total`);
});
ok("and the graduated coin's own feed reserves say the same thing from the other side", () => {
  const raised = Number(GRADUATED_FEED_VSOL - 30000000000n) / 1e9;
  assert.ok(Math.abs(raised - 85.005) < 0.01, `115.005 - 30 = ${raised.toFixed(6)} SOL`);
  console.log(`         ${Number(GRADUATED_FEED_VSOL) / 1e9} - 30 = ${raised.toFixed(6)} SOL raised at completion`);
});
ok("there is no graduation constant in the adapter's source", () => {
  const src = fs.readFileSync(new URL("./snipe-venue-pumpfun.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /85[_.]?0/, "an 85-SOL graduation constant reached the code");
  console.log(`         no 85-SOL constant outside the comments — the number is derived per curve`);
});

/* ── 5. GLOBAL — four constants this repo already pins by hand ──────────────────────── */
console.log("\n5. THE GLOBAL ACCOUNT — decoded only as far as it can be checked");
ok("the opening reserves equal test-pumpfun-curve.mjs's hand-worked fixture", () => {
  const g = decodeGlobal(bytes(GLOBAL_PREFIX_HEX));
  assert.equal(g.initialVirtualBaseRaw, 1073000000000000n, `vTok0=${g.initialVirtualBaseRaw} (fixture: 1073M)`);
  assert.equal(g.initialVirtualQuoteRaw, 30000000000n, `vSol0=${g.initialVirtualQuoteRaw} (fixture: 30 SOL)`);
  assert.equal(g.initialRealBaseRaw, 793100000000000n, `realTok0=${g.initialRealBaseRaw} (fixture: 793.1M)`);
  assert.equal(g.tokenTotalSupplyRaw, 1000000000000000n, `supply=${g.tokenTotalSupplyRaw}`);
  assert.equal(g.initialized, true, `initialized=${g.initialized}`);
  console.log(`         vTok0 ${g.initialVirtualBaseRaw}  vSol0 ${g.initialVirtualQuoteRaw}` +
    `  realTok0 ${g.initialRealBaseRaw}  supply ${g.tokenTotalSupplyRaw}`);
  console.log(`         authority ${g.authority.slice(0, 12)}…  feeRecipient ${g.feeRecipient.slice(0, 12)}…`);
});
ok("its static fee field is reported and FLAGGED as not the executable rate", () => {
  const g = decodeGlobal(bytes(GLOBAL_PREFIX_HEX));
  assert.equal(g.staticFeeBasisPoints, 95, `staticFeeBasisPoints=${g.staticFeeBasisPoints}`);
  assert.equal(g.staticFeeIsNotTheExecutableRate, true, "the divergence flag is missing");
  assert.equal(g.feeBps, undefined, "decodeGlobal exposed a field named feeBps — callers will quote from it");
  console.log(`         static ${g.staticFeeBasisPoints} bps, flagged not-executable; no field named feeBps`);
});
ok("a short or wrong Global buffer is refused", () => {
  const short = throws(() => decodeGlobal(bytes(GLOBAL_PREFIX_HEX).subarray(0, GLOBAL_MIN_BYTES - 1)));
  assert.equal(short.clause, "account_too_short", `clause=${short && short.clause}`);
  const wrong = throws(() => decodeGlobal(LIVE()));
  assert.equal(wrong.clause, "account_discriminator_mismatch", `clause=${wrong && wrong.clause}`);
  console.log(`         ${GLOBAL_MIN_BYTES - 1} bytes -> ${short.clause}; a curve account -> ${wrong.clause}`);
});
ok("the layout offsets the test reasons about are the ones the module exports", () => {
  assert.equal(BONDING_CURVE_LAYOUT.virtualTokenReserves, 8, `offset=${BONDING_CURVE_LAYOUT.virtualTokenReserves}`);
  assert.equal(BONDING_CURVE_LAYOUT.complete, 48, `offset=${BONDING_CURVE_LAYOUT.complete}`);
  assert.equal(BONDING_CURVE_LAYOUT.creator, 49, `offset=${BONDING_CURVE_LAYOUT.creator}`);
  assert.equal(GLOBAL_LAYOUT.feeBasisPoints, 105, `offset=${GLOBAL_LAYOUT.feeBasisPoints}`);
  assert.ok(Object.isFrozen(BONDING_CURVE_LAYOUT) && Object.isFrozen(GLOBAL_LAYOUT), "layouts are not frozen");
  console.log(`         curve {v:8, complete:48, creator:49}; global {fee:105}; both frozen`);
});

/* ── 6. THE FEE IS NEVER DEFAULTED ─────────────────────────────────────────────────── */
console.log("\n6. AN UNKNOWN FEE IS A REFUSAL, NOT A ZERO");
ok("a curve decoded without a fee carries feeBps: null and refuses all three quotes", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { mint: LIVE_CURVE_MINT });
  assert.equal(c.feeBps, null, `feeBps=${c.feeBps}`);
  assert.equal(c.feeBpsKnown, false, `feeBpsKnown=${c.feeBpsKnown}`);
  for (const [name, fn] of [["quoteExactIn", () => quoteExactIn(c, 5_000_000n)],
    ["quoteExactOut", () => quoteExactOut(c, 1_000_000_000n)],
    ["sellExactIn", () => sellExactIn(c, 1_000_000_000n)]]) {
    const err = throws(fn);
    assert.ok(err instanceof PumpfunVenueError, `${name} threw ${err && err.name}`);
    assert.equal(err.clause, "fee_unverified", `${name} clause=${err.clause}`);
    assert.match(err.message, new RegExp(PUMPFUN_FEE_PROGRAM_ID), `${name} message=${err.message}`);
    console.log(`         ${name.padEnd(14)} -> ${err.clause}`);
  }
});
ok("…and the SAME curve with the measured fee quotes normally — it can say yes too", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const q = quoteExactIn(c, 5_000_000n);
  assert.ok(q.baseOutRaw > 0n, `baseOutRaw=${q.baseOutRaw}`);
  assert.equal(q.feeBps, FEE, `feeBps=${q.feeBps}`);
  console.log(`         feeBps ${FEE} -> baseOut ${q.baseOutRaw}, curve got ${q.curveQuoteInRaw}, fee ${q.feeRaw}`);
});
ok("a nonsense fee is refused rather than clamped", () => {
  for (const badFee of [-1, 1.5, 10_000, "125"]) {
    const err = throws(() => decodeBondingCurve(LIVE(), { feeBps: badFee, requireOwner: false }));
    assert.ok(err && err.clause === "fee_unverified", `feeBps ${JSON.stringify(badFee)} -> ${err && err.clause}`);
  }
  console.log(`         -1, 1.5, 10000 and "125" all refused as fee_unverified`);
});

/* ── 7. THE FEE SHAPE, FROM TWO REAL SWAPS ─────────────────────────────────────────── */
console.log("\n7. THE FEE SHAPE — measured in both directions off the real tape");
ok("the BUY event: fees are exactly 95 and 30 bps, charged ON TOP of the curve input", () => {
  const t = decodeTradeEvent(Buffer.from(TRADE_EVENT_BUY_B64, "base64"));
  assert.equal(t.isBuy, true, `isBuy=${t.isBuy}`);
  assert.equal(t.mint, LAUNCH_MINT, `mint=${t.mint}`);
  assert.equal(t.curveQuoteRaw, 987_500_000n, `curve input=${t.curveQuoteRaw}`);
  // Integer arithmetic, so "exactly 95 bps" is a proof and not a rounding story.
  assert.equal(t.protocolFeeRaw * 10_000n, t.curveQuoteRaw * BigInt(t.protocolFeeBps),
    `protocol fee ${t.protocolFeeRaw} is not exactly ${t.protocolFeeBps} bps of ${t.curveQuoteRaw}`);
  assert.equal(t.creatorFeeRaw * 10_000n, t.curveQuoteRaw * BigInt(t.creatorFeeBps),
    `creator fee ${t.creatorFeeRaw} is not exactly ${t.creatorFeeBps} bps of ${t.curveQuoteRaw}`);
  assert.equal(t.protocolFeeBps, 95, `protocolFeeBps=${t.protocolFeeBps}`);
  assert.equal(t.creatorFeeBps, 30, `creatorFeeBps=${t.creatorFeeBps}`);
  assert.equal(t.userQuoteRaw, 999_843_750n, `user paid ${t.userQuoteRaw}`);
  assert.ok(t.userQuoteRaw > t.curveQuoteRaw, "the buy fee was not charged on top");
  console.log(`         curve got ${t.curveQuoteRaw}, fees ${t.protocolFeeRaw}+${t.creatorFeeRaw}` +
    ` (${t.protocolFeeBps}+${t.creatorFeeBps} bps), user paid ${t.userQuoteRaw}`);
});
ok("the SELL event: the same rates, taken OUT of the proceeds — the opposite direction", () => {
  const t = decodeTradeEvent(Buffer.from(TRADE_EVENT_SELL_B64, "base64"));
  assert.equal(t.isBuy, false, `isBuy=${t.isBuy}`);
  assert.equal(t.curveQuoteRaw, 342_232_518n, `curve paid=${t.curveQuoteRaw}`);
  assert.equal(t.protocolFeeBps, 95, `protocolFeeBps=${t.protocolFeeBps}`);
  assert.equal(t.creatorFeeBps, 30, `creatorFeeBps=${t.creatorFeeBps}`);
  assert.equal(t.userQuoteRaw, 337_954_611n, `user received ${t.userQuoteRaw}`);
  assert.ok(t.userQuoteRaw < t.curveQuoteRaw, "the sell fee was not taken out of the proceeds");
  console.log(`         curve paid ${t.curveQuoteRaw}, fees ${t.protocolFeeRaw}+${t.creatorFeeRaw}` +
    `, user received ${t.userQuoteRaw}`);
});
ok("the measured observation record matches what the two events actually say", () => {
  const buy = decodeTradeEvent(Buffer.from(TRADE_EVENT_BUY_B64, "base64"));
  assert.equal(PUMPFUN_FEE_OBSERVATION.protocolFeeBps, buy.protocolFeeBps,
    `record says ${PUMPFUN_FEE_OBSERVATION.protocolFeeBps}, tape says ${buy.protocolFeeBps}`);
  assert.equal(PUMPFUN_FEE_OBSERVATION.creatorFeeBps, buy.creatorFeeBps,
    `record says ${PUMPFUN_FEE_OBSERVATION.creatorFeeBps}, tape says ${buy.creatorFeeBps}`);
  assert.equal(PUMPFUN_FEE_OBSERVATION.totalFeeBps, buy.totalFeeBps, `total=${buy.totalFeeBps}`);
  const g = decodeGlobal(bytes(GLOBAL_PREFIX_HEX));
  assert.notEqual(g.staticFeeBasisPoints, buy.totalFeeBps,
    "the Global static fee and the executed total agree — the divergence this design rests on is gone");
  console.log(`         tape ${buy.totalFeeBps} bps total vs Global's static ${g.staticFeeBasisPoints} bps —` +
    ` the account is NOT the executable rate`);
});
ok("the event's creator field is returned flagged unattributed, because it disagreed", () => {
  const sell = decodeTradeEvent(Buffer.from(TRADE_EVENT_SELL_B64, "base64"));
  const create = decodeCreateEvent(Buffer.from(CREATE_EVENT_B64, "base64"));
  assert.equal(sell.mint, create.mint, `different mints: ${sell.mint} vs ${create.mint}`);
  assert.notEqual(sell.eventCreator, create.creator,
    "the sampled disagreement is gone; re-check whether the curve account is still the authority");
  assert.equal(sell.eventCreatorIsUnattributed, true, "the unattributed flag is missing");
  console.log(`         same mint, trade event creator ${sell.eventCreator.slice(0, 10)}… vs curve creator` +
    ` ${create.creator.slice(0, 10)}… -> flagged, CREATOR-SOLD must use the curve account`);
});

/* ── 8. THE ARITHMETIC, REPLAYED AGAINST A REAL FILL ───────────────────────────────── */
console.log("\n8. A REAL ON-CHAIN BUY, REPLAYED — the strongest known answer available");
ok("the plain constant product reproduces the delivered tokens to the raw unit", () => {
  const t = decodeTradeEvent(Buffer.from(TRADE_EVENT_BUY_B64, "base64"));
  // The reserves BEFORE the trade, recovered from the reserves the event reports after it.
  const vQuoteBefore = t.vQuoteRaw - t.curveQuoteRaw;
  const vBaseBefore = t.vBaseRaw + t.baseRaw;
  assert.equal(vQuoteBefore, 30_000_000_000n, `vQuote before = ${vQuoteBefore}`);
  assert.equal(vBaseBefore, 1_073_000_000_000_000n, `vBase before = ${vBaseBefore}`);
  const q = constantProductExactIn({
    vBase: vBaseBefore, vQuote: vQuoteBefore, quoteInRaw: t.curveQuoteRaw, feeBps: 0 });
  assert.equal(q.baseOutRaw, t.baseRaw,
    `replay produced ${q.baseOutRaw}, the chain delivered ${t.baseRaw}`);
  console.log(`         floor(${vBaseBefore} x ${t.curveQuoteRaw} / (${vQuoteBefore} + ${t.curveQuoteRaw}))`);
  console.log(`         = ${q.baseOutRaw}  ==  the ${t.baseRaw} the chain actually delivered`);
});
ok("and the ADAPTER, given what the user really paid, reproduces the same fill", () => {
  const t = decodeTradeEvent(Buffer.from(TRADE_EVENT_BUY_B64, "base64"));
  const openingCurve = {
    vBaseRaw: t.vBaseRaw + t.baseRaw, vQuoteRaw: t.vQuoteRaw - t.curveQuoteRaw,
    realQuoteRaw: 0n, feeBps: t.totalFeeBps, mint: t.mint,
  };
  const q = quoteExactIn(openingCurve, t.userQuoteRaw);
  assert.equal(q.curveQuoteInRaw, t.curveQuoteRaw,
    `adapter split ${t.userQuoteRaw} into curve ${q.curveQuoteInRaw}, chain took ${t.curveQuoteRaw}`);
  assert.equal(q.feeRaw, t.totalFeeRaw, `adapter fee ${q.feeRaw}, chain charged ${t.totalFeeRaw}`);
  assert.equal(q.baseOutRaw, t.baseRaw, `adapter baseOut ${q.baseOutRaw}, chain delivered ${t.baseRaw}`);
  console.log(`         spend ${t.userQuoteRaw} -> curve ${q.curveQuoteInRaw} + fee ${q.feeRaw}` +
    ` -> ${q.baseOutRaw} tokens, all three exact`);
});
ok("exact-out inverts exact-in at the live ticket size — the entry ceiling closes", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const ticket = 5_000_000n;                      // LIVE_LIMITS.maxSolPerTrade = 0.005 SOL
  const inQ = quoteExactIn(c, ticket);
  const outQ = quoteExactOut(c, inQ.baseOutRaw);
  assert.ok(outQ.quoteInRaw <= ticket, `ceiling ${outQ.quoteInRaw} exceeds the ticket ${ticket}`);
  assert.ok(ticket - outQ.quoteInRaw <= 2n,
    `ceiling ${outQ.quoteInRaw} is ${ticket - outQ.quoteInRaw} lamports below the ticket ${ticket}`);
  assert.equal(outQ.deliveredBaseOutRaw >= inQ.baseOutRaw, true,
    `exact-out would deliver ${outQ.deliveredBaseOutRaw} against the ${inQ.baseOutRaw} asked for`);
  console.log(`         spend ${ticket} -> ${inQ.baseOutRaw} tokens; ceiling for those tokens = ${outQ.quoteInRaw}`);
});
ok("a full round trip at the live ticket LOSES, by roughly twice the venue fee", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const ticket = 5_000_000n;
  const bought = quoteExactIn(c, ticket);
  const sold = sellExactIn(c, bought.baseOutRaw);
  assert.ok(sold.quoteOutRaw < ticket, `round trip returned ${sold.quoteOutRaw} on ${ticket} — a free lunch`);
  const lossBps = Number((ticket - sold.quoteOutRaw) * 10_000n) / Number(ticket);
  assert.ok(lossBps > FEE && lossBps < 3 * FEE,
    `round-trip loss ${lossBps.toFixed(2)} bps is outside (1x, 3x) the ${FEE} bps venue fee`);
  console.log(`         out ${ticket} -> ${bought.baseOutRaw} tokens -> back ${sold.quoteOutRaw}` +
    ` = ${lossBps.toFixed(2)} bps lost against a ${FEE} bps one-way fee`);
});
ok("THE VIRTUAL RESERVES WILL QUOTE SOL THE CURVE DOES NOT HOLD — and the cap stops it", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  // Sell the whole float. The virtual reserve says ~30 SOL; the curve holds 0.110014725.
  const sold = sellExactIn(c, c.realBaseRaw);
  assert.equal(sold.reserveBound, true, `reserveBound=${sold.reserveBound}`);
  assert.ok(sold.uncappedQuoteOutRaw > c.realQuoteRaw,
    `uncapped ${sold.uncappedQuoteOutRaw} did not exceed the real reserve ${c.realQuoteRaw}`);
  assert.ok(sold.quoteOutRaw <= c.realQuoteRaw,
    `payout ${sold.quoteOutRaw} exceeds what the curve holds (${c.realQuoteRaw})`);
  console.log(`         virtual answer ${sold.uncappedQuoteOutRaw} lamports vs ${c.realQuoteRaw} actually held` +
    ` -> capped to ${sold.quoteOutRaw}, reserveBound ${sold.reserveBound}`);
});

/* ── 9. THE CREATE EVENT, SELF-CHECKED AGAINST ITS OWN PDA ─────────────────────────── */
console.log("\n9. THE LAUNCH NOTICE — decoded from the program's own event log");
ok("the real CreateEvent decodes, and its bondingCurve field IS the PDA of its mint", () => {
  const e = decodeCreateEvent(Buffer.from(CREATE_EVENT_B64, "base64"));
  assert.equal(e.mint, LAUNCH_MINT, `mint=${e.mint}`);
  assert.equal(e.bondingCurve, bondingCurveAddress(e.mint).toBase58(),
    `event curve ${e.bondingCurve} vs derived ${bondingCurveAddress(e.mint).toBase58()}`);
  assert.equal(e.symbol, "BONZI", `symbol=${e.symbol}`);
  assert.equal(e.creator, e.user, `creator ${e.creator} != user ${e.user}`);
  console.log(`         "${e.name}" (${e.symbol}) mint ${e.mint}`);
  console.log(`         curve ${e.bondingCurve} == PDA(mint) — the decode checks itself`);
});
ok("its opening reserves are exactly the Global account's initial_* fields", () => {
  const e = decodeCreateEvent(Buffer.from(CREATE_EVENT_B64, "base64"));
  const g = decodeGlobal(bytes(GLOBAL_PREFIX_HEX));
  assert.equal(e.vBaseRaw, g.initialVirtualBaseRaw, `${e.vBaseRaw} vs ${g.initialVirtualBaseRaw}`);
  assert.equal(e.vQuoteRaw, g.initialVirtualQuoteRaw, `${e.vQuoteRaw} vs ${g.initialVirtualQuoteRaw}`);
  assert.equal(e.realBaseRaw, g.initialRealBaseRaw, `${e.realBaseRaw} vs ${g.initialRealBaseRaw}`);
  assert.equal(e.tokenTotalSupplyRaw, g.tokenTotalSupplyRaw, `${e.tokenTotalSupplyRaw} vs ${g.tokenTotalSupplyRaw}`);
  console.log(`         event ${e.vBaseRaw}/${e.vQuoteRaw}/${e.realBaseRaw} == Global's initial_* — two sources agree`);
});
ok("CORRUPT THE MINT AND THE SELF-CHECK FIRES — the cross-check is load-bearing", () => {
  const raw = Buffer.from(CREATE_EVENT_B64, "base64");
  const bad = Buffer.from(raw);
  // The mint sits immediately after three borsh strings; flip one byte of it.
  const mintOffset = raw.indexOf(bs58.decode(LAUNCH_MINT));
  assert.ok(mintOffset > 0, `could not locate the mint key in the payload (offset ${mintOffset})`);
  bad[mintOffset + 3] ^= 0x01;
  const err = throws(() => decodeCreateEvent(bad));
  assert.ok(err instanceof PumpfunVenueError, `threw ${err && err.name}`);
  assert.equal(err.clause, "event_malformed", `clause=${err.clause}`);
  console.log(`         mint byte at ${mintOffset + 3} flipped -> ${err.clause}: PDA ${err.detail.derived.slice(0, 10)}…` +
    ` != event ${err.detail.bondingCurve.slice(0, 10)}…`);
});
ok("a truncated event is a named refusal, not a read past the end of the buffer", () => {
  const raw = Buffer.from(CREATE_EVENT_B64, "base64");
  const err = throws(() => decodeCreateEvent(raw.subarray(0, 120)));
  assert.equal(err.clause, "event_malformed", `clause=${err && err.clause}`);
  assert.match(err.message, /ran out reading/, `message=${err.message}`);
  console.log(`         120 of ${raw.length} bytes -> ${err.clause} (${err.message.split(" ran out ")[1]})`);
});
ok("a TradeEvent payload is not mistaken for a CreateEvent, or the reverse", () => {
  const a = throws(() => decodeCreateEvent(Buffer.from(TRADE_EVENT_BUY_B64, "base64")));
  const b = throws(() => decodeTradeEvent(Buffer.from(CREATE_EVENT_B64, "base64")));
  assert.equal(a.clause, "account_discriminator_mismatch", `clause=${a && a.clause}`);
  assert.equal(b.clause, "account_discriminator_mismatch", `clause=${b && b.clause}`);
  console.log(`         both cross-decodes refused on the discriminator`);
});

/* ── 10. LOGS -> NOTICES, WITH NO CLOCK INSIDE ─────────────────────────────────────── */
console.log("\n10. LOGS TO NOTICES — pure, so a replay is byte-identical");
const REAL_CREATE_LOGS = Object.freeze([
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
  "Program log: Instruction: CreateV2",
  `Program data: ${CREATE_EVENT_B64}`,
  "Program log: Instruction: BuyV2",
  `Program data: ${TRADE_EVENT_BUY_B64}`,
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
]);
ok("one create notice comes out, carrying the caller's slot and arrival stamp", () => {
  const notices = noticesFromLogs({
    logs: REAL_CREATE_LOGS, signature: CREATE_TX_SIGNATURE, slot: CREATE_TX_SLOT,
    receivedAt: 1_789_087_342_000, source: "test",
  });
  assert.equal(notices.length, 1, `got ${notices.length} notices`);
  const [n] = notices;
  assert.equal(n.venue, PUMPFUN_VENUE_ID, `venue=${n.venue}`);
  assert.equal(n.mint, LAUNCH_MINT, `mint=${n.mint}`);
  assert.equal(n.slot, CREATE_TX_SLOT, `slot=${n.slot}`);
  assert.equal(n.noticeAt, 1_789_087_342_000, `noticeAt=${n.noticeAt}`);
  assert.equal(n.curve, bondingCurveAddress(n.mint).toBase58(), `curve=${n.curve}`);
  console.log(`         mint ${n.mint} creator ${n.creator.slice(0, 10)}… slot ${n.slot} at ${n.noticeAt}`);
});
ok("the same logs twice produce deep-equal notices — nothing inside reads a clock", () => {
  const args = { logs: REAL_CREATE_LOGS, slot: CREATE_TX_SLOT, receivedAt: 1, source: "replay" };
  assert.deepEqual(noticesFromLogs(args), noticesFromLogs(args), "two replays differed");
  console.log(`         two replays of the same logs are deep-equal`);
});
ok("both events are visible when nothing filters them, and each kind can be asked for", () => {
  assert.equal(eventsFromLogs(REAL_CREATE_LOGS).length, 2, `all -> ${eventsFromLogs(REAL_CREATE_LOGS).length}`);
  assert.equal(eventsFromLogs(REAL_CREATE_LOGS, { kind: "create" }).length, 1, "create filter");
  assert.equal(eventsFromLogs(REAL_CREATE_LOGS, { kind: "trade" }).length, 1, "trade filter");
  console.log(`         2 events total: 1 create, 1 trade`);
});
ok("noise, truncation and non-arrays yield NO notices rather than a throw or a guess", () => {
  const cases = [
    ["unrelated logs", ["Program log: Instruction: Transfer", "Program 111 success"]],
    ["a truncated payload", [`Program data: ${CREATE_EVENT_B64.slice(0, 80)}`]],
    ["not an array", null],
    ["an empty batch", []],
  ];
  for (const [label, logs] of cases) {
    const got = noticesFromLogs({ logs, slot: 1, receivedAt: 1 });
    assert.equal(got.length, 0, `${label} produced ${got.length} notices`);
    console.log(`         ${label.padEnd(22)} -> 0 notices`);
  }
});
ok("one malformed line does not blind the batch to a good launch beside it", () => {
  const mixed = [`Program data: ${CREATE_EVENT_B64.slice(0, 80)}`, ...REAL_CREATE_LOGS];
  const got = noticesFromLogs({ logs: mixed, slot: 7, receivedAt: 7 });
  assert.equal(got.length, 1, `got ${got.length} notices from a batch with one broken line`);
  console.log(`         broken line + real create -> ${got.length} notice (${got[0].mint.slice(0, 10)}…)`);
});

/* ── 11. WHAT THE ENCODERS REFUSE, NOW THAT THEY ENCODE ────────────────────────────── */
/* RE-ANCHORED 2026-09-11. This section asserted that buyIx, buildBuy, sellIx and
 * decodeBuyIx ALL refuse with layout_unverified, which was the correct assertion while the
 * account order was unknown. It is now known: thirty mainnet occurrences re-encode exactly
 * (see the round-trip block below), and the on-chain IDL names every position.
 *
 * The refusals did not go away — they moved to the things that are still genuinely unsafe,
 * and there are more of them than there were. A missing argument, a stale creator, an
 * unauthorised fee recipient and a destination the signer does not own are each refused by
 * name. What is gone is the blanket "this venue cannot encode anything". */
console.log("\n11. THE ENCODERS REFUSE WHAT IS STILL UNSAFE");
ok("an encoder called with nothing at all still refuses, rather than emitting a guess", () => {
  for (const [name, fn] of [["buyIx", buyIx], ["buildBuy", buildBuy], ["sellIx", sellIx]]) {
    const err = throws(() => fn());
    assert.ok(err instanceof PumpfunVenueError, `${name} threw ${err && err.name}`);
    assert.ok(["account_missing", "arg_invalid", "stale_curve"].includes(err.clause),
      `${name} refused with ${err.clause}, which is not one of the named input clauses`);
    console.log(`         ${name.padEnd(12)} -> ${err.clause}`);
  }
});
ok("the discriminators it emits are the ones the tape proved, twice over", () => {
  /* Each equals sha256("global:<name>")[0..8] AND the program logs that name. */
  assert.equal(PUMPFUN_IX.buyV2.toString("hex"), "b817ee6167c5d33d");
  assert.equal(PUMPFUN_IX.sellV2.toString("hex"), "5df6823ce7e940b2");
  console.log(`         buy_v2 ${PUMPFUN_IX.buyV2.toString("hex")} · sell_v2 ${PUMPFUN_IX.sellV2.toString("hex")}`);
});
ok("the derived legacy discriminator is NOT the one the live program runs", () => {
  const legacyBuy = crypto.createHash("sha256").update("global:buy").digest().subarray(0, 8).toString("hex");
  const liveBuy = crypto.createHash("sha256").update("global:buy_v2").digest().subarray(0, 8).toString("hex");
  assert.equal(liveBuy, PUMPFUN_LAYOUT_EVIDENCE.transactions.buyV2.discriminator,
    `sha256("global:buy_v2") = ${liveBuy}, the sampled BuyV2 = ${PUMPFUN_LAYOUT_EVIDENCE.transactions.buyV2.discriminator}`);
  assert.notEqual(legacyBuy, PUMPFUN_LAYOUT_EVIDENCE.transactions.buyV2.discriminator,
    "global:buy and the live instruction agree — the IDL-name trap this file documents is gone");
  console.log(`         global:buy    ${legacyBuy}  <- what an IDL reader would have emitted`);
  console.log(`         global:buy_v2 ${liveBuy}  <- what the chain actually ran`);
});
/* RE-ANCHORED 2026-09-11, from "declares layoutVerified false and offers NO proof".
   The account order was unknown when that was written and is known now; what this asserts
   instead is that the claim is BACKED — a boolean anyone can flip is not evidence, so the
   proof object must satisfy the contract's own shape and name the test that reproduces it. */
ok("the adapter declares layoutVerified TRUE and backs it with a proof the contract accepts", () => {
  assert.equal(PUMPFUN_VENUE.layoutVerified, true, `layoutVerified=${PUMPFUN_VENUE.layoutVerified}`);
  const proof = PUMPFUN_VENUE.layoutProof;
  assert.ok(proof, "layoutVerified is true with no proof — that is a claim, not evidence");
  assert.equal(proof.cluster, "mainnet-beta", "a devnet proof is not the program the money meets");
  assert.equal(proof.programId, PUMPFUN_PROGRAM_ID);
  assert.match(proof.provedBy, /test-snipe-venue-pumpfun\.mjs/,
    "the proof must name the test that reproduces it, so a reviewer can go and watch it happen");
  const covered = new Set(proof.roundTrips.map((rt) => rt.method));
  assert.deepEqual([...covered].sort(), ["buyIx", "decodeBuyIx", "sellIx"],
    "a buy layout proved while the sell layout is guessed is a position with no door");
  assert.ok(Object.isFrozen(PUMPFUN_VENUE), "the adapter is not frozen — layoutVerified could be set at runtime");
  console.log(`         layoutVerified ${PUMPFUN_VENUE.layoutVerified}, ${proof.roundTrips.length} round trips on ${proof.cluster}`);
});
/* RE-ANCHORED 2026-09-11, and this one is the important re-anchoring.
 *
 * It used to forbid Buffer.alloc, Buffer.concat and .write* — "structurally incapable of
 * encoding" — which was a true and useful property while the layout was unproved. Writing
 * instruction bytes is now this module's JOB, so keeping that list would have meant either
 * a dead test or a venue that cannot do the thing it was verified to do.
 *
 * The property that still matters, and that was always the real one, is NARROWER AND
 * UNCHANGED: this module may describe a transaction and may never authorise one. No
 * keypair, no signing, no sending, no network, no filesystem, no randomness. An adapter
 * that can build bytes but cannot sign them is exactly as safe as one that can do neither,
 * and it is useful. */
ok("IT MAY DESCRIBE A TRANSACTION AND MAY NEVER AUTHORISE ONE", () => {
  const src = fs.readFileSync(new URL("./snipe-venue-pumpfun.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/Keypair/, /sendTransaction/, /sendRawTransaction/, /partialSign/,
    /\bsignTransaction\b/, /\bsign\(/, /secretKey/, /Math\.random/, /node:fs/, /\bfetch\(/])
    assert.doesNotMatch(code, forbidden, `the adapter reaches ${forbidden}`);
  /* And it must still be building bytes, or the re-anchoring above silently disabled the
     encoder rather than re-scoping the rule. */
  assert.match(code, /Buffer\.concat/, "the encoder stopped building instruction data");
  console.log(`         encodes: yes · signs, sends, fetches, reads disk, or rolls dice: no`);
});
ok("and it imports nothing from the desk's exit path", () => {
  const src = fs.readFileSync(new URL("./snipe-venue-pumpfun.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["trade-policy.mjs", "strategy.mjs", "desk-mirror.mjs"])
    assert.doesNotMatch(code, new RegExp(`from\\s+["']\\./${forbidden.replace(".", "\\.")}["']`),
      `the adapter imports ${forbidden}`);
  console.log(`         no trade-policy.mjs, strategy.mjs or desk-mirror.mjs import`);
});

/* ── 12. THE VENUE CONTRACT — BOTH MODES, AND WHY ─────────────────────────────────── */
console.log("\n12. THE CONTRACT — the fence, run against this adapter");
ok("every required method is present, so the contract fails on the LAYOUT and not on shape", () => {
  const missing = REQUIRED_VENUE_METHODS.filter((m) => typeof PUMPFUN_VENUE[m] !== "function");
  assert.deepEqual(missing, [], `missing: ${missing.join(", ")}`);
  console.log(`         all ${REQUIRED_VENUE_METHODS.length} required methods present`);
});
ok("observe is admissible", () => {
  const v = venueContract(PUMPFUN_VENUE, { execute: false });
  assert.equal(v.ok, true, `refused observe with ${v.clause}: ${v.detail.message}`);
  assert.equal(v.detail.quoteSymbol, "SOL", `quoteSymbol=${v.detail.quoteSymbol}`);
  assert.equal(v.detail.quoteOracle, PYTH_SOL_USD_CACHE_SOURCE, `oracle=${v.detail.quoteOracle}`);
  console.log(`         observe ok — quoted in ${v.detail.quoteSymbol} against ${v.detail.quoteOracle}`);
});
/* RE-ANCHORED 2026-09-11 from "EXECUTE IS REFUSED". It is certified now, and the useful
   assertion is that the certification is EARNED: strip the proof and it refuses again. */
ok("EXECUTE IS CERTIFIED — and only because the proof is there", () => {
  const v = venueContract(PUMPFUN_VENUE, { execute: true });
  assert.equal(v.ok, true, `execute refused with ${v.clause}: ${v.detail.message}`);
  /* The counterfactual is the whole test. A certification that survives having its
     evidence removed was never reading the evidence. */
  const stripped = Object.freeze({ ...PUMPFUN_VENUE, layoutProof: undefined });
  const s2 = venueContract(stripped, { execute: true });
  assert.equal(s2.ok, false, "the contract certified a venue whose proof had been deleted");
  assert.equal(s2.clause, "layout_proof_missing", `clause=${s2.clause}`);
  const unverified = Object.freeze({ ...PUMPFUN_VENUE, layoutVerified: false });
  assert.equal(venueContract(unverified, { execute: true }).clause, "layout_unverified");
  console.log(`         execute -> certified; without the proof -> ${s2.clause}`);
});
ok("registerVenue accepts it for BOTH modes now, and still refuses an unproved one", () => {
  const reg = createVenueRegistry();
  const rec = registerVenue(PUMPFUN_VENUE, { registry: reg });
  assert.equal(rec.adapter.id, PUMPFUN_VENUE_ID, `registered as ${rec.adapter.id}`);
  const reg2 = createVenueRegistry();
  const rec2 = registerVenue(PUMPFUN_VENUE, { execute: true, registry: reg2 });
  assert.equal(rec2.adapter.id, PUMPFUN_VENUE_ID);
  /* The registry must still be a gate, not a formality. */
  const reg3 = createVenueRegistry();
  const err = throws(() => registerVenue(Object.freeze({ ...PUMPFUN_VENUE, layoutVerified: false }),
    { execute: true, registry: reg3 }));
  assert.ok(err instanceof VenueContractError, `threw ${err && err.name}`);
  assert.equal(err.clause, "layout_unverified", `clause=${err.clause}`);
  assert.equal(reg3.size, 0, `a refused execute registration still stored ${reg3.size} venue(s)`);
  console.log(`         observe and execute both registered; an unproved twin: ${err.clause}, registry left empty`);
});
ok("venueFor matches on the account owner and now serves execute too", () => {
  const reg = createVenueRegistry();
  registerVenue(PUMPFUN_VENUE, { registry: reg });
  const infos = [{ owner: PUMPFUN_PROGRAM_ID, data: LIVE() }, null];
  const obs = venueFor(LIVE_CURVE_MINT, infos, { registry: reg });
  assert.equal(obs.ok, true, `observe lookup refused: ${obs.clause}`);
  assert.equal(obs.venue.id, PUMPFUN_VENUE_ID, `matched ${obs.venue && obs.venue.id}`);
  const exe = venueFor(LIVE_CURVE_MINT, infos, { execute: true, registry: reg });
  assert.equal(exe.ok, true, `the execute lookup refused: ${exe.clause}`);
  assert.equal(exe.venue.id, PUMPFUN_VENUE_ID, "the execute lookup handed back no adapter");
  /* And a registry holding only an UNPROVED twin still hands back nothing for execute, so
     the lookup is reading the contract rather than the registry's optimism. */
  const reg2 = createVenueRegistry();
  registerVenue(Object.freeze({ ...PUMPFUN_VENUE, layoutVerified: false }), { registry: reg2 });
  const denied = venueFor(LIVE_CURVE_MINT, infos, { execute: true, registry: reg2 });
  assert.equal(denied.ok, false, "an unproved venue was handed back for execute");
  assert.equal(denied.venue, null, "a refused execute lookup handed back an adapter to call buyIx on");
  console.log(`         observe -> ${obs.venue.id}; execute -> ${exe.venue.id}; unproved twin -> ${denied.clause}`);
});
ok("a mint whose accounts belong to another program matches no venue", () => {
  const reg = createVenueRegistry();
  registerVenue(PUMPFUN_VENUE, { registry: reg });
  const r = venueFor(LAUNCH_MINT, [{ owner: TOKEN_2022_PROGRAM }], { registry: reg });
  assert.equal(r.ok, false, "a Token-2022-owned account matched the pump.fun venue");
  assert.equal(r.clause, "venue_unknown", `clause=${r.clause}`);
  console.log(`         owner ${TOKEN_2022_PROGRAM.slice(0, 10)}… -> ${r.clause}`);
});

/* ── 13. THE QUESTIONS THE LANE ASKS ───────────────────────────────────────────────── */
console.log("\n13. accountsFor / exitRoute / reserves");
ok("accountsFor returns the three roles the gates need, in the declared order", () => {
  const keys = PUMPFUN_VENUE.accountsFor(LIVE_CURVE_MINT);
  assert.equal(keys.length, PUMPFUN_ACCOUNT_ROLES.length, `${keys.length} accounts for ${PUMPFUN_ACCOUNT_ROLES.length} roles`);
  assert.ok(keys.every((k) => k instanceof PublicKey), "accountsFor returned something that is not a PublicKey");
  assert.equal(keys[0].toBase58(), LIVE_CURVE_ADDRESS, `bondingCurve=${keys[0].toBase58()}`);
  assert.equal(keys[1].toBase58(), globalAddress().toBase58(), `global=${keys[1].toBase58()}`);
  assert.equal(keys[2].toBase58(), LIVE_CURVE_MINT, `mint=${keys[2].toBase58()}`);
  console.log(`         ${PUMPFUN_ACCOUNT_ROLES.join(" / ")} = ${keys.map((k) => k.toBase58().slice(0, 8) + "…").join(" / ")}`);
});
ok("EXIT ROUTE: a live curve is NOT routable, and the reason is the unverified layout", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  const r = exitRoute(null, LIVE_CURVE_MINT, { curve: c });
  assert.equal(r.routable, false, `routable=${r.routable}`);
  assert.equal(r.via, null, `via=${r.via}`);
  assert.match(r.reason, /not verified/i, `reason=${r.reason}`);
  console.log(`         live curve -> via ${r.via}, routable ${r.routable}  (spec gate 10: exit_route_unimplemented)`);
});
ok("…and a COMPLETE curve routes to Jupiter — the method can say yes", () => {
  const c = decodeBondingCurve(GRAD(), { feeBps: FEE, mint: GRADUATED_CURVE_MINT, requireOwner: false });
  const r = exitRoute(null, GRADUATED_CURVE_MINT, { curve: c });
  assert.equal(r.routable, true, `routable=${r.routable}`);
  assert.equal(r.via, "jupiter", `via=${r.via}`);
  console.log(`         graduated curve -> via ${r.via}, routable ${r.routable}`);
});
ok("quoteReserveLamports reports exactly what the account holds, as a BigInt", () => {
  const c = decodeBondingCurve(LIVE_INFO(), { feeBps: FEE, mint: LIVE_CURVE_MINT });
  assert.equal(quoteReserveLamports(c), LIVE_CURVE_FEED_ROW.real_sol_reserves,
    `reserve=${quoteReserveLamports(c)}`);
  assert.equal(typeof quoteReserveLamports(c), "bigint", `type=${typeof quoteReserveLamports(c)}`);
  console.log(`         ${quoteReserveLamports(c)} lamports (${Number(quoteReserveLamports(c)) / 1e9} SOL)`);
});
ok("isComplete / quoteReserveLamports refuse a non-curve instead of answering", () => {
  for (const [name, fn] of [["isComplete", isComplete], ["quoteReserveLamports", quoteReserveLamports]]) {
    const err = throws(() => fn(null));
    assert.ok(err instanceof PumpfunVenueError, `${name} threw ${err && err.name}`);
    console.log(`         ${name}(null) -> ${err.clause}`);
  }
});

/* ── 14. SPEC GATE 11 AGAINST THE REAL LAUNCH MINT ─────────────────────────────────── */
console.log("\n14. THE MINT AUDIT — run over the real Token-2022 launch mint");
ok("a stock pump.fun launch mint PASSES the executor's own audit", () => {
  const data = bytes(LAUNCH_MINT_HEX);
  assert.equal(data.length, PUMPFUN_LAYOUT_EVIDENCE.accounts.launchMint.bytes, `mint is ${data.length} bytes`);
  const a = auditMintAccount({ owner: TOKEN_2022_PROGRAM, data }, LAUNCH_MINT);
  assert.equal(a.decimals, PUMPFUN_BASE_DECIMALS, `decimals=${a.decimals}`);
  assert.equal(a.freezeAuthority, null, `freezeAuthority=${a.freezeAuthority}`);
  assert.equal(a.mintAuthority, null, `mintAuthority=${a.mintAuthority}`);
  assert.deepEqual(a.extensionNames, ["MetadataPointer", "TokenMetadata"], `extensions=${a.extensionNames.join("+")}`);
  console.log(`         Token-2022, ${a.decimals}dp, extensions ${a.extensionNames.join(" + ")},` +
    ` mint auth ${a.mintAuthority}, freeze auth ${a.freezeAuthority}`);
});
ok("…and the SAME audit refuses the same mint with a freeze authority bolted on", () => {
  const bad = bytes(LAUNCH_MINT_HEX);
  bad.writeUInt32LE(1, 46);       // COption<Pubkey> tag for freeze authority
  bad.fill(7, 50, 82);
  const err = throws(() => auditMintAccount({ owner: TOKEN_2022_PROGRAM, data: bad }, LAUNCH_MINT));
  assert.ok(err, "a freezable mint passed the audit");
  assert.match(err.message, /freeze authority/, `message=${err.message}`);
  console.log(`         freeze authority added -> "${err.message.slice(0, 80)}…"`);
});

/* ── 15. THE EVIDENCE RECORD IS THE SAME EVIDENCE THIS FILE DRIVES ─────────────────── */
console.log("\n15. THE EVIDENCE RECORD");
ok("the module's evidence names the very accounts and transactions used above", () => {
  const e = PUMPFUN_LAYOUT_EVIDENCE;
  assert.equal(e.cluster, "mainnet-beta", `cluster=${e.cluster}`);
  assert.equal(e.accounts.liveCurve.address, LIVE_CURVE_ADDRESS, `liveCurve=${e.accounts.liveCurve.address}`);
  assert.equal(e.accounts.liveCurve.mint, LIVE_CURVE_MINT, `mint=${e.accounts.liveCurve.mint}`);
  assert.equal(e.accounts.liveCurve.bytes, LIVE().length, `bytes=${e.accounts.liveCurve.bytes} vs ${LIVE().length}`);
  assert.equal(e.accounts.graduatedCurve.bytes, GRAD().length, `bytes=${e.accounts.graduatedCurve.bytes}`);
  assert.equal(e.transactions.createV2.signature, CREATE_TX_SIGNATURE, `sig=${e.transactions.createV2.signature}`);
  assert.equal(e.transactions.createV2.slot, CREATE_TX_SLOT, `slot=${e.transactions.createV2.slot}`);
  console.log(`         curve ${e.accounts.liveCurve.address.slice(0, 12)}… (${e.accounts.liveCurve.bytes}B),` +
    ` graduated ${e.accounts.graduatedCurve.bytes}B, create ${e.transactions.createV2.slot}`);
});
ok("every signature in the record is a real 64-byte base58 signature, not a placeholder", () => {
  for (const [name, tx] of Object.entries(PUMPFUN_LAYOUT_EVIDENCE.transactions)) {
    const decoded = bs58.decode(tx.signature);
    assert.equal(decoded.length, 64, `${name} signature decodes to ${decoded.length} bytes`);
    assert.ok(decoded.some((b) => b !== 0), `${name} signature is all zeros — the unsigned default`);
    assert.ok(Number.isInteger(tx.slot) && tx.slot > 0, `${name} slot=${tx.slot}`);
    console.log(`         ${name.padEnd(9)} ${tx.signature.slice(0, 16)}… slot ${tx.slot} disc ${tx.discriminator}`);
  }
});
ok("the fee observation's own arithmetic closes on both sampled swaps", () => {
  const [buy, sell] = PUMPFUN_FEE_OBSERVATION.samples;
  assert.equal(buy.curveAmountLamports + buy.protocolFeeLamports + buy.creatorFeeLamports,
    buy.userPaidLamports, `buy: ${buy.curveAmountLamports}+fees != ${buy.userPaidLamports}`);
  assert.equal(sell.curveAmountLamports - sell.protocolFeeLamports - sell.creatorFeeLamports,
    sell.userReceivedLamports, `sell: ${sell.curveAmountLamports}-fees != ${sell.userReceivedLamports}`);
  assert.equal(PUMPFUN_FEE_OBSERVATION.protocolFeeBps + PUMPFUN_FEE_OBSERVATION.creatorFeeBps,
    PUMPFUN_FEE_OBSERVATION.totalFeeBps, `total=${PUMPFUN_FEE_OBSERVATION.totalFeeBps}`);
  console.log(`         buy ${buy.curveAmountLamports}+${buy.protocolFeeLamports}+${buy.creatorFeeLamports}` +
    ` = ${buy.userPaidLamports}; sell ${sell.curveAmountLamports}-${sell.protocolFeeLamports}` +
    `-${sell.creatorFeeLamports} = ${sell.userReceivedLamports}`);
});
ok("the adapter's identity is what the registry and the logs will show", () => {
  assert.equal(PUMPFUN_VENUE.id, "pumpfun", `id=${PUMPFUN_VENUE.id}`);
  assert.equal(PUMPFUN_VENUE.programId, "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", `programId=${PUMPFUN_VENUE.programId}`);
  assert.equal(bs58.decode(PUMPFUN_VENUE.programId).length, 32, "programId is not a 32-byte key");
  assert.equal(PUMPFUN_VENUE.version, PUMPFUN_VENUE_VERSION, `version=${PUMPFUN_VENUE.version}`);
  assert.equal(PUMPFUN_VENUE.supportsExactOut, true, `supportsExactOut=${PUMPFUN_VENUE.supportsExactOut}`);
  assert.equal(PUMPFUN_VENUE.quote.mint, WSOL, `quote mint=${PUMPFUN_VENUE.quote.mint}`);
  console.log(`         ${PUMPFUN_VENUE.id} @ ${PUMPFUN_VENUE.programId} (${PUMPFUN_VENUE.version}),` +
    ` quote ${PUMPFUN_VENUE.quote.symbol}`);
});

/* ── 16. watch() — asserted without a network ──────────────────────────────────────── */
console.log("\n16. watch() — dependency-injected, and it refuses to dial out on its own");
const watchChecks = async () => {
  {
    const err = await watch({}).next().then(() => null, (e) => e);
    assert.ok(err instanceof PumpfunVenueError, `watch({}) rejected with ${err && err.name}`);
    assert.match(err.message, /never opens one of its own/, `message=${err.message}`);
    console.log("  ok    watch() with no Connection refuses");
    console.log(`         "${err.message.slice(0, 78)}…"`);
    pass++;
  }
  {
    // A fake Connection: no network, no sockets, one canned log batch.
    let removed = null;
    const connection = {
      onLogs(_key, cb) {
        setTimeout(() => cb({ err: null, signature: CREATE_TX_SIGNATURE, slot: CREATE_TX_SLOT, logs: REAL_CREATE_LOGS }), 0);
        return Promise.resolve(4242);
      },
      removeOnLogsListener(id) { removed = id; return Promise.resolve(); },
    };
    const controller = new AbortController();
    const seen = [];
    for await (const notice of watch({ connection, signal: controller.signal, now: () => 1_000_000 })) {
      seen.push(notice);
      controller.abort();
      break;
    }
    assert.equal(seen.length, 1, `watch yielded ${seen.length} notices`);
    assert.equal(seen[0].mint, LAUNCH_MINT, `mint=${seen[0].mint}`);
    assert.equal(seen[0].noticeAt, 1_000_000, `noticeAt=${seen[0].noticeAt} — the injected clock was ignored`);
    assert.equal(removed, 4242, `subscription ${removed} was not removed on exit`);
    console.log("  ok    watch() yields a notice from an injected Connection and unsubscribes on exit");
    console.log(`         mint ${seen[0].mint}, slot ${seen[0].slot}, noticeAt ${seen[0].noticeAt},` +
      ` unsubscribed ${removed}`);
    pass++;
  }
};

await watchChecks().catch((error) => { console.log("  FAIL  watch()\n         ", error.message); fail++; });

/* ── A CURVE THAT IS NOT QUOTED IN SOL, FROM THE CHAIN ─────────────────────────────── */
/* §6 listed "whether a V2 curve may be quoted in a mint other than SOL" as unproved. It is
 * proved, and the answer is yes — which breaks the quote arithmetic, because on those
 * trades TradeEvent.solAmount reads 0 while real value moves. Driven against the REAL
 * bytes of a real mainnet SellV2 rather than a hand-built event: the bug is in what the
 * chain emits versus what this decoder assumed, and a fabricated event would only test
 * the assumption against itself. */
{
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/pumpfun-nonsol-sellv2.json", import.meta.url), "utf8"));
  const events = eventsFromLogs(fx.programDataLines.map((d) => "Program data: " + d));
  const trade = events.find((e) => e.kind === "trade");
  ok("a real non-SOL-quoted SellV2 decodes as a trade at all", () => {
    assert.ok(trade, `no trade event in ${fx.signature.slice(0, 12)}…`);
    assert.equal(trade.isBuy, false);
  });
  ok("...and its quote amount would go NEGATIVE, which is why it is refused not clamped", () => {
    assert.equal(trade.curveQuoteRaw, 0n, `solAmount = ${trade.curveQuoteRaw}`);
    assert.ok(trade.totalFeeRaw > 0n, "fees were charged, so value certainly moved");
    assert.ok(trade.userQuoteRaw < 0n,
      `userQuoteRaw = ${trade.userQuoteRaw}; if this is no longer negative the decoder changed`);
    assert.equal(trade.quoteUsable, false,
      "a negative quote amount was reported as usable — anything pricing a position on it is wrong");
    assert.match(trade.quoteRefusal, /not quoted in SOL/);
    console.log(`         ${fx.signature.slice(0, 12)}… slot ${fx.slot}: solAmount 0, fees ${trade.totalFeeRaw}, ` +
      `userQuoteRaw ${trade.userQuoteRaw} -> quoteUsable false`);
  });
  ok("the number is NOT clamped to zero — a clamp would look like a free trade", () => {
    /* Clamping would turn "this event cannot be priced" into "this trade returned nothing",
       which is a fact, and a false one. The refusal keeps the raw arithmetic visible. */
    assert.notEqual(trade.userQuoteRaw, 0n);
  });
  ok("a SOL-quoted trade is still usable, so the guard did not just disable pricing", () => {
    /* The failure mode of a refusal is refusing everything. These are the control cases:
       the same two real SOL-quoted events the rest of this file is built on. */
    for (const [name, b64] of [["buy", TRADE_EVENT_BUY_B64], ["sell", TRADE_EVENT_SELL_B64]]) {
      const normal = decodeTradeEvent(Buffer.from(b64, "base64"));
      assert.equal(normal.quoteUsable, true, `a normal SOL-quoted ${name} was refused`);
      assert.equal(normal.quoteRefusal, null);
      assert.ok(normal.userQuoteRaw > 0n, `${name} userQuoteRaw = ${normal.userQuoteRaw}`);
    }
  });
}

/* ── THE ROUND TRIP THAT EARNS layoutVerified ──────────────────────────────────────── */
/* Thirty real mainnet occurrences, re-encoded from (mint, signer, on-chain state) and
 * compared index by index against the account list the chain actually accepted. This is
 * the whole basis for layoutVerified: true. It is not a claim in a comment — it runs on
 * every suite, and a drift breaks the build instead of a wallet.
 *
 * The file's own warning is the reason it is shaped this way: "a wrong discriminator or a
 * transposed account in a hand-built buy does not refuse — it signs, it lands, and the
 * money goes somewhere nobody planned." There is no quote to check against. This IS the
 * check. */
{
  const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/pumpfun-v2-encode-cases.json", import.meta.url), "utf8"));
  const build = (c, over = {}) => {
    const args = {
      mint: c.mint, user: c.user,
      curve: { creator: c.creator, quoteMint: c.quoteMint, complete: false },
      curveReadSlot: c.slot, buildingForSlot: c.slot,
      feeRecipient: c.feeRecipient, buybackFeeRecipient: c.buybackFeeRecipient,
      baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
      associatedBaseUser: c.associatedBaseUser, associatedBaseUserOwner: c.user,
      globalFeeRecipients: cases.globalFeeRecipients,
      amountRaw: 1n, maxQuoteInRaw: 2n, minQuoteOutRaw: 2n, ...over,
    };
    return c.side === "buy" ? buyIx(args) : sellIx(args);
  };

  ok("every one of the 30 mainnet cases re-encodes to the EXACT account list the chain took", () => {
    let matched = 0, buys = 0, sells = 0, nonSol = 0;
    for (const c of cases.cases) {
      const mine = build(c).keys.map((k) => k.pubkey);
      assert.equal(mine.length, c.accounts.length,
        `${c.side} ${c.signature.slice(0, 12)}… produced ${mine.length} accounts, the chain took ${c.accounts.length}`);
      for (let i = 0; i < mine.length; i++) {
        assert.equal(mine[i], c.accounts[i],
          `${c.side} ${c.signature.slice(0, 12)}… index ${i}: encoded ${mine[i]}, chain had ${c.accounts[i]}`);
      }
      matched++;
      if (c.side === "buy") buys++; else sells++;
      if (c.quoteMint) nonSol++;
    }
    assert.equal(matched, 30, `${matched} cases — the fixture changed size`);
    console.log(`         ${matched}/${cases.cases.length} exact · ${buys} buy_v2, ${sells} sell_v2 · ${nonSol} on non-SOL-quoted curves`);
  });

  ok("the two sides differ by exactly one account, and it is global_volume_accumulator", () => {
    /* buy_v2 carries it at 19 and sell_v2 does not, so every index after 18 shifts by one.
       Asserted from the encoder's own output because an off-by-one in that tail is the
       single easiest way to transpose a fee vault and a volume accumulator. */
    /* Built from ONE case on both sides, so the two lists differ only by the instruction
       shape and not by any input — otherwise a difference could be a different mint. */
    const c = cases.cases.find((x) => x.side === "buy");
    const asBuy = build(c).keys.map((k) => k.pubkey);
    const asSell = build({ ...c, side: "sell" }).keys.map((k) => k.pubkey);
    assert.equal(asBuy.length, 27);
    assert.equal(asSell.length, 26);
    for (let i = 0; i <= 18; i++)
      assert.equal(asSell[i], asBuy[i], `the two sides diverge before index 19, at ${i}`);
    for (let i = 19; i < 26; i++)
      assert.equal(asSell[i], asBuy[i + 1],
        `sell index ${i} is not buy index ${i + 1} — the one-account tail shift is wrong, ` +
        "which is the easiest way to transpose a fee vault and a volume accumulator");
    console.log(`         buy 27 · sell 26 · the extra is ${asBuy[19].slice(0, 10)}… (global_volume_accumulator)`);
  });

  ok("the payload is 24 bytes and decodes back to the arguments that made it", () => {
    const c = cases.cases.find((x) => x.side === "buy");
    const ix = build(c, { amountRaw: 123_456_789n, maxQuoteInRaw: 987_654_321n });
    assert.equal(ix.data.length, 24);
    const back = decodeBuyIx(ix);
    assert.equal(back.instruction, "buy_v2");
    assert.equal(back.amountRaw, 123_456_789n);
    assert.equal(back.maxQuoteInRaw, 987_654_321n);
    assert.equal(back.minQuoteOutRaw, null, "a buy has no floor — naming it one invites the opposite trade");
    const sell = build(cases.cases.find((x) => x.side === "sell"), { amountRaw: 5n, minQuoteOutRaw: 7n });
    const sback = decodeBuyIx(sell);
    assert.equal(sback.instruction, "sell_v2");
    assert.equal(sback.minQuoteOutRaw, 7n);
    assert.equal(sback.maxQuoteInRaw, null);
  });

  ok("the decoder reads the BYTES, not the arguments it was handed", () => {
    /* A decoder that trusted the caller would confirm any mistake the caller made, which
       is the whole failure spec gate 20 exists to catch. Flip one byte; it must be seen. */
    const ix = build(cases.cases.find((x) => x.side === "buy"), { amountRaw: 1n, maxQuoteInRaw: 1n });
    const tampered = Buffer.from(ix.data); tampered[8] = 0xff;
    assert.equal(decodeBuyIx({ data: tampered }).amountRaw, 255n);
    const wrongDisc = Buffer.from(ix.data); wrongDisc[0] ^= 0xff;
    assert.throws(() => decodeBuyIx({ data: wrongDisc }), /neither buy_v2 nor sell_v2/);
    assert.throws(() => decodeBuyIx({ data: ix.data.subarray(0, 23) }), /24 bytes/);
  });

  /* ── THE THREE REFUSALS, each a measured way to lose money without an error ───────── */

  ok("A STALE CREATOR IS REFUSED — the race is real and this is its proof", () => {
    /* Measured: mint DNLwPEp8… was created at slot 446099885 and
       migrate_bonding_curve_creator rewrote BondingCurve.creator at 446099886 — ONE SLOT
       later, which is exactly a sniper's window. The two creators produce two different
       vaults, and a transaction carrying the wrong one is a valid pubkey pointing at the
       wrong account. This case mis-encoded by two positions on the first run, because the
       verification sweep had recorded the POST-migration creator for a PRE-migration
       transaction: the encoder was right and the input was from the future. */
    const race = cases.creatorRace;
    const c = cases.cases.find((x) => x.signature.startsWith("5GzeJnAbRL"));
    assert.ok(race && c, "the creator-race case is no longer in the fixture");
    const live = build(c).keys.map((k) => k.pubkey);
    assert.equal(live[16], race.preMigrationCreatorVault,
      "the case no longer encodes the vault that was live at its slot");
    /* The same mint, the same everything, with the creator read one slot too late: a
       DIFFERENT vault, silently. That is the whole hazard in two lines. */
    const stale = build(c, { curve: { creator: race.postMigrationCreator.split(" ")[0], quoteMint: c.quoteMint } })
      .keys.map((k) => k.pubkey);
    assert.notEqual(stale[16], live[16],
      "the two creator eras produced the SAME vault — then the race would not matter, and " +
      "this fixture no longer demonstrates anything");
    assert.equal(stale[16], race.postMigrationCreatorVault);
    console.log(`         slot ${c.slot}: ${live[16].slice(0, 10)}… · after the ${race.migrateSlot} migration: ${stale[16].slice(0, 10)}…`);
  });

  ok("...and building without stating WHEN the curve was read is refused outright", () => {
    const c = cases.cases.find((x) => x.side === "buy");
    assert.throws(() => build(c, { curveReadSlot: undefined }), /curveReadSlot is required/);
    assert.throws(() => build(c, { curveReadSlot: c.slot - 1, buildingForSlot: c.slot }),
      /re-read the curve rather than assume the creator held still/);
  });

  ok("a fee recipient outside the Global account's sets is refused, naming the set", () => {
    const c = cases.cases.find((x) => x.side === "buy");
    const stranger = "So11111111111111111111111111111111111111112";
    assert.throws(() => build(c, { feeRecipient: stranger }), /is not one of the 16/);
    assert.throws(() => build(c, { buybackFeeRecipient: stranger }), /is not one of the 8/);
    assert.throws(() => build(c, { buybackFeeRecipient: stranger }), /error 6057/);
  });

  ok("a destination the signer does not own is refused — the program will NOT refuse it", () => {
    /* Proven on chain: two top-level buys paid from one wallet and delivered the tokens to
       accounts owned by two OTHER wallets, with no error. The position can be handed away
       silently, so this is the only place it can be caught. */
    const c = cases.cases.find((x) => x.side === "buy");
    assert.throws(() => build(c, { associatedBaseUserOwner: "11111111111111111111111111111111" }),
      /not by the signer/);
    assert.throws(() => build(c, { associatedBaseUserOwner: "11111111111111111111111111111111" }),
      /loses the position silently/);
  });

  ok("the Global fee-recipient sets decode to 16 and 8 at the IDL's own offsets", () => {
    assert.equal(cases.globalFeeRecipients.feeRecipients.length, 16);
    assert.equal(cases.globalFeeRecipients.buybackFeeRecipients.length, 8);
    /* And every observed recipient across all 30 cases is a member — which is what makes
       the membership check a real gate rather than a formality. */
    for (const c of cases.cases) {
      assert.ok(cases.globalFeeRecipients.feeRecipients.includes(c.feeRecipient),
        `${c.signature.slice(0, 12)}… used a fee recipient outside the set`);
      assert.ok(cases.globalFeeRecipients.buybackFeeRecipients.includes(c.buybackFeeRecipient),
        `${c.signature.slice(0, 12)}… used a buyback recipient outside the set`);
    }
  });

  ok("LEGACY buy is still not emitted — 18 accounts, index 16 unnamed across 120 samples", () => {
    /* The exclusion is measured, not cautious: 47 distinct values at index 16, none
       reproduced by ~200k tested (program, seed) combinations. buyIx emits buy_v2. */
    const ix = build(cases.cases.find((x) => x.side === "buy"));
    assert.equal(ix.keys.length, 27, "buyIx emitted something other than the 27-account buy_v2");
    assert.equal(ix.data.subarray(0, 8).toString("hex"), "b817ee6167c5d33d");
  });
}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
