/* THE VENUE CONTRACT, DRIVEN AGAINST ADAPTERS WHOSE VERDICT IS KNOWN IN ADVANCE.
 *
 * This is the fence that decides whether hand-built program bytes may be signed, so it
 * gets the treatment the rest of the money path gets: both failure directions are
 * asserted (a ruler that only ever says no is not a ruler), the ruler itself is validated
 * against keys whose byte length is known before the test runs, and every assertion
 * prints the value it actually saw.
 *
 * THE THREE CLAIMS THE TASK ASKS FOR, and where each is proved below:
 *   · a malformed adapter is refused, and the reason names what was wrong      — §2, §3
 *   · a missing method is refused, and the reason names the method             — §4
 *   · an unverified layout is refused for EXECUTE and allowed for OBSERVE      — §6
 *
 * AND WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. The contract checks that a layout proof
 * is NAMED and WELL-FORMED. It does not and cannot check that the named transaction
 * exists on chain or that it decodes to the adapter's layout — that needs an RPC round
 * trip, and a boot fence that needs the network cannot refuse while the machine is
 * offline. The signature fixtures below are therefore synthetic and obviously so; the
 * real proof is the adapter's own decode round-trip test against a mainnet transaction,
 * which is a separate deliverable. §9 asserts that limitation out loud rather than
 * leaving a reader to assume the stronger thing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import bs58 from "bs58";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import {
  VENUE_CONTRACT_VERSION, VENUE_CONTRACT_CLAUSES, VENUE_REGISTRY_CLAUSES,
  REQUIRED_VENUE_METHODS, LAYOUT_PROVED_METHODS, SUPPORTED_QUOTE_ORACLES, PROOF_CLUSTER,
  VenueContractError, venueContract, assertVenueContract,
  createVenueRegistry, registerVenue, registeredVenues, venueFor,
} from "./snipe-venue.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log("  ok   ", name); pass++; }
  catch (error) { console.log("  FAIL ", name, "\n         ", error.message); fail++; }
};

/* ── fixtures ──────────────────────────────────────────────────────────────────────── */

const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";   // src/data/solana.js:171
const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"; // the stonk.fun-class venue
const SYSTEM_PROGRAM = "11111111111111111111111111111111";               // 32 zero bytes
const A_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/* Signature-shaped and plainly not from any chain: 64 bytes of 0x07. The contract judges
   SHAPE; nothing here pretends to be a real transaction. */
const SYNTHETIC_SIG = bs58.encode(Buffer.alloc(64, 7));
const SYNTHETIC_SIG_2 = bs58.encode(Buffer.alloc(64, 9));
/* base58 of 64 zero bytes is "1" x 64 — the DEFAULT signature on an unsigned or simulated
   transaction, and the single most plausible thing to find pasted into a proof by mistake. */
const UNSIGNED_SIG = "1".repeat(64);

const noop = () => {};
const methods = () => Object.fromEntries(REQUIRED_VENUE_METHODS.map((m) => [m, noop]));

const proof = (overrides = {}) => ({
  cluster: PROOF_CLUSTER,
  programId: PUMPFUN_PROGRAM,
  provedBy: "executor/test-snipe-venue-pumpfun-layout.mjs",
  roundTrips: LAYOUT_PROVED_METHODS.map((method, i) => ({
    method, signature: i % 2 ? SYNTHETIC_SIG_2 : SYNTHETIC_SIG,
    slot: 300_000_000 + i, instructionIndex: i,
  })),
  ...overrides,
});

/** A structurally complete adapter whose layout is NOT verified — the honest default
 *  state of every adapter in this repo today. */
const unverified = (overrides = {}) => ({
  id: "pumpfun",
  programId: PUMPFUN_PROGRAM,
  supportsExactOut: true,
  quote: { mint: WSOL, decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE },
  layoutVerified: false,
  ...methods(),
  ...overrides,
});

/** The same adapter with a well-formed (synthetic) layout proof attached. */
const verified = (overrides = {}) =>
  unverified({ layoutVerified: true, layoutProof: proof(), ...overrides });

const refusal = (adapter, mode) => venueContract(adapter, mode);

/* ── 1. THE RULER, VALIDATED BEFORE IT IS TRUSTED ──────────────────────────────────── */
console.log("\n1. THE RULER — base58 BYTE LENGTH, ON KEYS WHOSE LENGTH IS KNOWN FIRST");
ok("the contract measures decoded BYTES, not characters — proved on known keys", () => {
  /* Known before the run: a Solana public key is 32 bytes, a signature is 64. The
     character counts differ (43 vs 44 vs 87) and would have been the wrong ruler. */
  assert.equal(bs58.decode(PUMPFUN_PROGRAM).length, 32, "pump.fun program id is not 32 bytes");
  assert.equal(bs58.decode(WSOL).length, 32, "WSOL mint is not 32 bytes");
  assert.equal(bs58.decode(SYNTHETIC_SIG).length, 64, "the synthetic signature is not 64 bytes");
  console.log(`         chars: programId ${PUMPFUN_PROGRAM.length}, WSOL ${WSOL.length}, sig ${SYNTHETIC_SIG.length}` +
    ` — bytes: 32, 32, 64`);
});
ok("a 31-byte key is refused even though its character count looks like a key", () => {
  const short = bs58.encode(Buffer.alloc(31, 5));
  const r = refusal(unverified({ programId: short }), { execute: false });
  assert.equal(r.ok, false, `a ${bs58.decode(short).length}-byte programId was accepted`);
  assert.equal(r.clause, "program_id_invalid", `clause=${r.clause}`);
  assert.match(r.detail.message, /31 bytes/, r.detail.message);
  console.log(`         "${short.slice(0, 12)}…" is ${short.length} chars / ${bs58.decode(short).length} bytes -> ${r.clause}`);
});
ok("the all-zero System Program id is refused as a venue program", () => {
  const r = refusal(unverified({ programId: SYSTEM_PROGRAM }), { execute: false });
  assert.equal(r.ok, false, "the System Program was accepted as a venue");
  assert.equal(r.clause, "program_id_invalid", `clause=${r.clause}`);
  assert.match(r.detail.message, /zero bytes/, r.detail.message);
  console.log(`         ${SYSTEM_PROGRAM} -> ${r.clause}`);
});

/* ── 2. THE FROZEN, ORDERED CLAUSE LIST ────────────────────────────────────────────── */
console.log("\n2. THE CLAUSE LIST IS FROZEN, ORDERED AND UNAMBIGUOUS");
ok("VENUE_CONTRACT_CLAUSES is frozen and every name is unique", () => {
  assert.ok(Object.isFrozen(VENUE_CONTRACT_CLAUSES), "clause list is not frozen");
  assert.equal(new Set(VENUE_CONTRACT_CLAUSES).size, VENUE_CONTRACT_CLAUSES.length,
    `${VENUE_CONTRACT_CLAUSES.length} clauses, ${new Set(VENUE_CONTRACT_CLAUSES).size} unique`);
  console.log(`         ${VENUE_CONTRACT_CLAUSES.length} clauses: ${VENUE_CONTRACT_CLAUSES.join(" > ")}`);
});
ok("registry refusals are a separate, disjoint vocabulary", () => {
  const overlap = VENUE_REGISTRY_CLAUSES.filter((c) => VENUE_CONTRACT_CLAUSES.includes(c));
  assert.deepEqual(overlap, [], `overlapping names: ${overlap.join(", ")}`);
  console.log(`         registry: ${VENUE_REGISTRY_CLAUSES.join(", ")}`);
});
ok("the required method list and the proved-method list are frozen and consistent", () => {
  assert.ok(Object.isFrozen(REQUIRED_VENUE_METHODS) && Object.isFrozen(LAYOUT_PROVED_METHODS));
  const orphans = LAYOUT_PROVED_METHODS.filter((m) => !REQUIRED_VENUE_METHODS.includes(m));
  assert.deepEqual(orphans, [], `proved methods not in the required list: ${orphans.join(", ")}`);
  assert.ok(REQUIRED_VENUE_METHODS.includes("quoteExactOut"),
    "exact-out is the spine of the entry ceiling and must be a required method");
  console.log(`         ${REQUIRED_VENUE_METHODS.length} required, ${LAYOUT_PROVED_METHODS.length} need a layout proof` +
    ` (${LAYOUT_PROVED_METHODS.join(", ")})`);
});
ok("every clause this file can provoke is a declared clause", () => {
  const provoked = [
    refusal(unverified(), { execute: "0" }),
    refusal(null, { execute: false }),
    refusal(unverified({ id: "" }), { execute: false }),
    refusal(unverified({ programId: "0OIl" }), { execute: false }),
    refusal(unverified({ buyIx: undefined }), { execute: false }),
    refusal(unverified({ quote: null }), { execute: false }),
    refusal(unverified({ supportsExactOut: false }), { execute: false }),
    refusal(verified({ quote: { mint: A_MINT, decimals: 6, symbol: "SPYx", oracle: "none" } }), { execute: true }),
    refusal(verified({ quote: { mint: A_MINT, decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE } }), { execute: true }),
    refusal(unverified(), { execute: true }),
    refusal(unverified({ layoutVerified: true }), { execute: true }),
    refusal(verified({ layoutProof: proof({ cluster: "devnet" }) }), { execute: true }),
    refusal(verified({ layoutProof: proof({ programId: LAUNCHLAB_PROGRAM }) }), { execute: true }),
    refusal(verified({ layoutProof: proof({ roundTrips: [{ method: "buyIx", signature: UNSIGNED_SIG, slot: 1, instructionIndex: 0 }] }) }), { execute: true }),
    refusal(verified({ layoutProof: proof({ provedBy: "" }) }), { execute: true }),
    refusal(verified({ layoutProof: proof({ roundTrips: [{ method: "buyIx", signature: SYNTHETIC_SIG, slot: 1, instructionIndex: 0 }] }) }), { execute: true }),
  ];
  const seen = provoked.map((r) => r.clause);
  for (const clause of seen)
    assert.ok(VENUE_CONTRACT_CLAUSES.includes(clause), `undeclared clause ${clause}`);
  assert.equal(new Set(seen).size, VENUE_CONTRACT_CLAUSES.length,
    `provoked ${new Set(seen).size} distinct clauses of ${VENUE_CONTRACT_CLAUSES.length}: ` +
    `unreached = ${VENUE_CONTRACT_CLAUSES.filter((c) => !seen.includes(c)).join(", ") || "none"}`);
  console.log(`         all ${VENUE_CONTRACT_CLAUSES.length} clauses reached by a real adapter`);
});

/* ── 3. A MALFORMED ADAPTER IS REFUSED, AND THE REASON NAMES WHAT WAS WRONG ────────── */
console.log("\n3. MALFORMED ADAPTERS");
for (const [label, value, clause] of [
  ["null", null, "adapter_missing"],
  ["undefined", undefined, "adapter_missing"],
  ["a string", "pumpfun", "adapter_missing"],
  ["an array", [], "adapter_missing"],
  ["a function", () => {}, "adapter_missing"],
]) {
  ok(`${label} is refused as an adapter`, () => {
    const r = refusal(value, { execute: false });
    assert.equal(r.ok, false, `${label} was certified`);
    assert.equal(r.clause, clause, `clause=${r.clause}`);
    console.log(`         ${label} -> ${r.clause}: ${r.detail.message}`);
  });
}
ok("an adapter with no id is refused, and the message shows the id it saw", () => {
  for (const id of [undefined, "", "   ", 7]) {
    const r = refusal(unverified({ id }), { execute: false });
    assert.equal(r.clause, "venue_id_invalid", `id ${JSON.stringify(id)} -> clause ${r.clause}`);
    assert.match(r.detail.message, /has no id/, r.detail.message);
  }
  console.log(`         "", "   ", 7 and undefined all -> venue_id_invalid`);
});
ok("a non-base58 programId is refused and the message says so", () => {
  const r = refusal(unverified({ programId: "0OIl-not-base58" }), { execute: false });
  assert.equal(r.clause, "program_id_invalid", `clause=${r.clause}`);
  assert.match(r.detail.message, /is not base58/, r.detail.message);
  console.log(`         -> ${r.detail.message}`);
});
ok("a malformed quote asset is refused for each of its four fields", () => {
  const cases = [
    ["no quote at all", undefined],
    ["quote is a string", "SOL"],
    ["quote mint is not a key", { mint: "nope!", decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE }],
    ["quote decimals are fractional", { mint: WSOL, decimals: 9.5, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE }],
    ["quote decimals are a string", { mint: WSOL, decimals: "9", symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE }],
    ["quote has no symbol", { mint: WSOL, decimals: 9, oracle: PYTH_SOL_USD_CACHE_SOURCE }],
    ["quote names no oracle", { mint: WSOL, decimals: 9, symbol: "SOL" }],
  ];
  for (const [label, quote] of cases) {
    const r = refusal(unverified({ quote }), { execute: false });
    assert.equal(r.clause, "quote_asset_invalid", `${label} -> clause ${r.clause}`);
    console.log(`         ${label} -> ${r.detail.message}`);
  }
});
ok("an adapter that cannot state an absolute max cost is refused — including a truthy STRING", () => {
  for (const declared of [undefined, false, "true", 1, "yes"]) {
    const r = refusal(unverified({ supportsExactOut: declared }), { execute: false });
    assert.equal(r.clause, "exact_out_unsupported",
      `supportsExactOut ${JSON.stringify(declared)} -> clause ${r.clause}`);
  }
  const good = refusal(unverified({ supportsExactOut: true }), { execute: false });
  assert.equal(good.ok, true, `a declaring adapter was refused: ${good.clause} ${good.detail.message}`);
  console.log(`         undefined,false,"true",1,"yes" refused; literal true accepted`);
});

/* ── 4. A MISSING METHOD IS REFUSED, AND THE REASON NAMES THE METHOD ───────────────── */
console.log("\n4. MISSING METHODS — every one of them, named in the refusal");
ok(`each of the ${REQUIRED_VENUE_METHODS.length} required methods is individually load-bearing`, () => {
  for (const name of REQUIRED_VENUE_METHODS) {
    const adapter = unverified();
    delete adapter[name];
    const r = refusal(adapter, { execute: false });
    assert.equal(r.ok, false, `an adapter missing ${name} was certified`);
    assert.equal(r.clause, "method_missing", `${name} -> clause ${r.clause}`);
    assert.ok(r.detail.message.includes(name),
      `the refusal for a missing ${name} does not name it: ${r.detail.message}`);
    assert.deepEqual([...r.detail.missingMethods], [name],
      `missingMethods=${JSON.stringify(r.detail.missingMethods)}`);
  }
  console.log(`         ${REQUIRED_VENUE_METHODS.length}/${REQUIRED_VENUE_METHODS.length} methods each produced a refusal naming themselves`);
});
ok("a method that is present but is not callable is refused, with its type printed", () => {
  const r = refusal(unverified({ decodeBuyIx: "later" }), { execute: false });
  assert.equal(r.clause, "method_missing", `clause=${r.clause}`);
  assert.match(r.detail.message, /decodeBuyIx \(string\)/, r.detail.message);
  console.log(`         -> ${r.detail.message}`);
});
ok("several missing methods are all named at once, not just the first", () => {
  const adapter = unverified();
  delete adapter.buyIx; delete adapter.sellIx; delete adapter.exitRoute;
  const r = refusal(adapter, { execute: false });
  assert.deepEqual([...r.detail.missingMethods].sort(), ["buyIx", "exitRoute", "sellIx"],
    `missingMethods=${JSON.stringify(r.detail.missingMethods)}`);
  console.log(`         -> ${r.detail.message}`);
});

/* ── 5. THE MODE ARGUMENT ITSELF ───────────────────────────────────────────────────── */
console.log('\n5. THE MODE ARGUMENT — "0" OUT OF AN ENV VAR IS TRUTHY');
ok("a non-boolean execute is the FIRST refusal, before the adapter is even read", () => {
  for (const mode of ["0", "1", 1, 0, "true", null]) {
    const r = venueContract(verified(), { execute: mode });
    assert.equal(r.ok, false, `execute=${JSON.stringify(mode)} certified a venue`);
    assert.equal(r.clause, "mode_invalid", `execute=${JSON.stringify(mode)} -> clause ${r.clause}`);
  }
  console.log(`         "0","1",1,0,"true",null all -> mode_invalid (a perfectly good adapter each time)`);
});
ok("omitting execute entirely defaults to OBSERVE, never to execute", () => {
  for (const [label, bag] of [["omitted", undefined], ["empty bag", {}], ["a string bag", "execute"]]) {
    const r = bag === undefined ? venueContract(verified()) : venueContract(verified(), bag);
    assert.equal(r.ok, true, `${label}: ${r.clause} ${r.detail.message}`);
    assert.equal(r.detail.mode, "observe", `${label} -> mode ${r.detail.mode}`);
  }
  /* The one direction that matters: a caller who fumbles the options bag gets the lane
     that cannot sign, never the one that can. */
  console.log(`         omitted / {} / a stray string all -> mode observe`);
});

/* ── 6. THE LINE THIS FILE EXISTS TO DRAW ──────────────────────────────────────────── */
console.log("\n6. AN UNVERIFIED LAYOUT: OBSERVE MAY RUN IT, EXECUTE MAY NOT");
ok("an unverified adapter is ADMISSIBLE for observe", () => {
  const r = venueContract(unverified(), { execute: false });
  assert.equal(r.ok, true, `observe refused a structurally sound adapter: ${r.clause} ${r.detail.message}`);
  assert.equal(r.detail.layoutVerified, false, `layoutVerified=${r.detail.layoutVerified}`);
  assert.match(r.detail.message, /OBSERVE only/, r.detail.message);
  console.log(`         -> ${r.detail.message}`);
});
ok("...and is REFUSED for execute, with the reason naming the unverified layout", () => {
  const r = venueContract(unverified(), { execute: true });
  assert.equal(r.ok, false, "an unverified layout was certified for execute");
  assert.equal(r.clause, "layout_unverified", `clause=${r.clause}`);
  assert.match(r.detail.message, /layout is not verified/, r.detail.message);
  assert.match(r.detail.message, /ENTRY REFUSAL/, r.detail.message);
  console.log(`         -> ${r.clause}: ${r.detail.message}`);
});
ok("layoutVerified must be the literal true — a truthy value does not open the gate", () => {
  for (const claimed of ["true", "false", 1, {}, [], "verified"]) {
    const r = venueContract(unverified({ layoutVerified: claimed, layoutProof: proof() }), { execute: true });
    assert.equal(r.clause, "layout_unverified",
      `layoutVerified=${JSON.stringify(claimed)} -> clause ${r.clause}`);
  }
  console.log(`         "true","false",1,{},[],"verified" all -> layout_unverified`);
});
ok("a bare layoutVerified:true with no proof is refused — the claim must be falsifiable", () => {
  const r = venueContract(unverified({ layoutVerified: true }), { execute: true });
  assert.equal(r.clause, "layout_proof_missing", `clause=${r.clause}`);
  assert.match(r.detail.message, /name the on-chain transaction/, r.detail.message);
  console.log(`         -> ${r.detail.message}`);
});
ok("A VERIFIED ADAPTER IS CERTIFIED — the fence can say yes", () => {
  const r = venueContract(verified(), { execute: true });
  assert.equal(r.ok, true, `a well-formed proof was refused: ${r.clause} — ${r.detail.message}`);
  assert.equal(r.clause, null, `clause=${r.clause}`);
  assert.equal(r.detail.mode, "execute", `mode=${r.detail.mode}`);
  assert.equal(r.detail.provedSignatures.length, LAYOUT_PROVED_METHODS.length,
    `provedSignatures=${r.detail.provedSignatures.length}`);
  console.log(`         -> ${r.detail.message}; proved by ${r.detail.provedBy}`);
  for (const s of r.detail.provedSignatures) console.log(`            ${s}`);
});

/* ── 7. THE PROOF ITSELF ───────────────────────────────────────────────────────────── */
console.log("\n7. WHAT A LAYOUT PROOF HAS TO SURVIVE");
ok("a devnet proof is not a mainnet layout proof", () => {
  for (const cluster of ["devnet", "testnet", "localnet", undefined]) {
    const r = venueContract(verified({ layoutProof: proof({ cluster }) }), { execute: true });
    assert.equal(r.clause, "layout_proof_cluster", `cluster ${JSON.stringify(cluster)} -> ${r.clause}`);
  }
  console.log(`         devnet/testnet/localnet/absent -> layout_proof_cluster (only ${PROOF_CLUSTER} passes)`);
});
ok("a proof against a DIFFERENT program is refused", () => {
  const r = venueContract(verified({ layoutProof: proof({ programId: LAUNCHLAB_PROGRAM }) }), { execute: true });
  assert.equal(r.clause, "layout_proof_program_mismatch", `clause=${r.clause}`);
  console.log(`         -> ${r.detail.message}`);
});
ok("a proof nobody can re-run is refused — provedBy must name the test", () => {
  for (const provedBy of [undefined, "", "  ", 42]) {
    const r = venueContract(verified({ layoutProof: proof({ provedBy }) }), { execute: true });
    assert.equal(r.clause, "layout_proof_unattributed", `provedBy ${JSON.stringify(provedBy)} -> ${r.clause}`);
  }
  console.log(`         -> an unattributed proof is an assertion, and is refused`);
});
ok("THE UNSIGNED-TRANSACTION SIGNATURE is refused — 64 zero bytes is the default, not a proof", () => {
  const rt = LAYOUT_PROVED_METHODS.map((method, i) => ({ method, signature: UNSIGNED_SIG, slot: 100 + i, instructionIndex: 0 }));
  const r = venueContract(verified({ layoutProof: proof({ roundTrips: rt }) }), { execute: true });
  assert.equal(r.clause, "layout_proof_malformed", `clause=${r.clause}`);
  assert.match(r.detail.message, /zero bytes/, r.detail.message);
  assert.equal(r.detail.signatureBytes, 64, `signatureBytes=${r.detail.signatureBytes}`);
  console.log(`         "${UNSIGNED_SIG.slice(0, 8)}…" (${bs58.decode(UNSIGNED_SIG).length} bytes, all zero) -> ${r.detail.message}`);
});
ok("a signature that is not 64 bytes is refused, with the byte count printed", () => {
  const short = bs58.encode(Buffer.alloc(32, 3));
  const rt = LAYOUT_PROVED_METHODS.map((method) => ({ method, signature: short, slot: 5, instructionIndex: 0 }));
  const r = venueContract(verified({ layoutProof: proof({ roundTrips: rt }) }), { execute: true });
  assert.equal(r.clause, "layout_proof_malformed", `clause=${r.clause}`);
  assert.equal(r.detail.signatureBytes, 32, `signatureBytes=${r.detail.signatureBytes}`);
  console.log(`         a 32-byte value in the signature slot -> ${r.detail.message}`);
});
ok("a round trip with no slot, a zero slot or a negative instruction index is refused", () => {
  const cases = [
    ["no slot", { slot: undefined }],
    ["slot 0", { slot: 0 }],
    ["fractional slot", { slot: 1.5 }],
    ["negative instructionIndex", { instructionIndex: -1 }],
    ["no instructionIndex", { instructionIndex: undefined }],
    ["a method nobody proves", { method: "quoteExactIn" }],
    ["a round trip that is a string", null],
  ];
  for (const [label, patch] of cases) {
    const rt = LAYOUT_PROVED_METHODS.map((method, i) => ({
      method, signature: SYNTHETIC_SIG, slot: 900 + i, instructionIndex: i,
    }));
    rt[0] = patch === null ? "buyIx proved, trust me" : { ...rt[0], ...patch };
    const r = venueContract(verified({ layoutProof: proof({ roundTrips: rt }) }), { execute: true });
    assert.equal(r.clause, "layout_proof_malformed", `${label} -> clause ${r.clause}`);
    console.log(`         ${label} -> ${r.detail.message}`);
  }
});
ok("a proof covering only the BUY is refused — a position with no proved door", () => {
  const rt = [{ method: "buyIx", signature: SYNTHETIC_SIG, slot: 7, instructionIndex: 0 }];
  const r = venueContract(verified({ layoutProof: proof({ roundTrips: rt }) }), { execute: true });
  assert.equal(r.clause, "layout_proof_incomplete", `clause=${r.clause}`);
  assert.deepEqual([...r.detail.uncoveredMethods].sort(), ["decodeBuyIx", "sellIx"],
    `uncovered=${JSON.stringify(r.detail.uncoveredMethods)}`);
  console.log(`         -> ${r.detail.message}`);
});
ok("an empty or missing roundTrips list is refused", () => {
  for (const roundTrips of [[], undefined, "buyIx", {}]) {
    const r = venueContract(verified({ layoutProof: proof({ roundTrips }) }), { execute: true });
    assert.equal(r.clause, "layout_proof_missing", `roundTrips ${JSON.stringify(roundTrips)} -> ${r.clause}`);
  }
  console.log(`         [], undefined, a string and an object all -> layout_proof_missing`);
});

/* ── 8. THE QUOTE-ASSET ORACLE RULE ────────────────────────────────────────────────── */
console.log("\n8. EXECUTE IS SOL-ONLY, BY ARITHMETIC — a non-SOL quote is observe-only");
const spyx = (overrides = {}) => verified({
  id: "stonkfun", programId: LAUNCHLAB_PROGRAM,
  quote: { mint: A_MINT, decimals: 6, symbol: "SPYx", oracle: "spyx-somewhere" },
  layoutProof: proof({ programId: LAUNCHLAB_PROGRAM }), ...overrides,
});
ok("a SPYx-quoted venue with a PERFECT layout proof is still refused for execute", () => {
  const r = venueContract(spyx(), { execute: true });
  assert.equal(r.ok, false, "a non-SOL quote was certified for execute");
  assert.equal(r.clause, "quote_oracle_unsupported", `clause=${r.clause}`);
  assert.match(r.detail.message, /denominated in SOL/, r.detail.message);
  console.log(`         -> ${r.clause}: ${r.detail.message}`);
});
ok("...and the SAME adapter is admissible for observe, so it accumulates shadow rows", () => {
  const r = venueContract(spyx(), { execute: false });
  assert.equal(r.ok, true, `observe refused it too: ${r.clause} ${r.detail.message}`);
  console.log(`         -> ${r.detail.message}`);
});
ok("naming the SOL oracle while quoting something else is refused", () => {
  const r = venueContract(spyx({ quote: { mint: A_MINT, decimals: 6, symbol: "SPYx", oracle: PYTH_SOL_USD_CACHE_SOURCE } }),
    { execute: true });
  assert.equal(r.clause, "quote_mint_mismatch", `clause=${r.clause}`);
  console.log(`         -> ${r.detail.message}`);
});
ok("the supported-oracle table has exactly the one oracle this repo can actually price", () => {
  const ids = Object.keys(SUPPORTED_QUOTE_ORACLES);
  assert.deepEqual(ids, [PYTH_SOL_USD_CACHE_SOURCE], `supported oracles: ${ids.join(", ")}`);
  assert.equal(SUPPORTED_QUOTE_ORACLES[ids[0]].mint, WSOL, "the one supported quote asset is not WSOL");
  assert.equal(SUPPORTED_QUOTE_ORACLES[ids[0]].sources, 2, "a single-source oracle is not an independent price");
  console.log(`         ${ids[0]} -> ${SUPPORTED_QUOTE_ORACLES[ids[0]].symbol} ${SUPPORTED_QUOTE_ORACLES[ids[0]].mint}` +
    ` from ${SUPPORTED_QUOTE_ORACLES[ids[0]].sources} sources (${SUPPORTED_QUOTE_ORACLES[ids[0]].module})`);
});

/* ── 9. FIRST FAILURE WINS, AND WHAT THE CONTRACT DOES NOT PROVE ───────────────────── */
console.log("\n9. ORDERING, AND AN HONEST STATEMENT OF THE LIMIT");
ok("an adapter that is wrong twice names the EARLIER clause", () => {
  const both = unverified({ layoutVerified: false });
  delete both.sellIx;
  const r = venueContract(both, { execute: true });
  assert.equal(r.clause, "method_missing",
    `expected the structural clause first, got ${r.clause}`);
  assert.ok(VENUE_CONTRACT_CLAUSES.indexOf("method_missing") < VENUE_CONTRACT_CLAUSES.indexOf("layout_unverified"),
    "clause order does not match the declared list");
  console.log(`         missing sellIx AND unverified -> ${r.clause} (index ` +
    `${VENUE_CONTRACT_CLAUSES.indexOf("method_missing")} < ${VENUE_CONTRACT_CLAUSES.indexOf("layout_unverified")})`);
});
ok("THE LIMIT, STATED: a well-formed but fictitious signature passes — shape, not chain", () => {
  /* SYNTHETIC_SIG is 64 bytes of 0x07 and is on no chain. It is certified, and that is
     the contract's honest boundary: it enforces that a proof is named, attributed and
     well-formed. Whether the named transaction exists and decodes to this layout is the
     adapter's own round-trip test against mainnet, which is a separate deliverable and
     has NOT been run for any venue in this repo. */
  const r = venueContract(verified(), { execute: true });
  assert.equal(r.ok, true, `clause=${r.clause}`);
  console.log(`         certified on signature ${SYNTHETIC_SIG.slice(0, 16)}… which exists nowhere —`);
  console.log(`         the contract proves NAMING, the adapter's round-trip test proves the LAYOUT`);
});

/* ── 10. assertVenueContract — throw shape, certificate shape, purity ──────────────── */
console.log("\n10. THE BOOT ASSERTION");
ok("assertVenueContract throws a VenueContractError carrying the clause", () => {
  let caught = null;
  try { assertVenueContract(unverified(), { execute: true }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VenueContractError, `threw ${caught && caught.name}`);
  assert.equal(caught.clause, "layout_unverified", `clause=${caught && caught.clause}`);
  assert.ok(caught.message.length > 0, "the error carries no message");
  console.log(`         ${caught.name}(${caught.clause}): ${caught.message.slice(0, 90)}…`);
});
ok("it returns a FROZEN certificate on a pass, and the certificate cannot be doctored", () => {
  const cert = assertVenueContract(verified(), { execute: true });
  assert.equal(cert.ok, true);
  assert.equal(cert.mode, "execute", `mode=${cert.mode}`);
  assert.equal(cert.contractVersion, VENUE_CONTRACT_VERSION, `version=${cert.contractVersion}`);
  assert.ok(Object.isFrozen(cert) && Object.isFrozen(cert.detail), "the certificate is not frozen");
  try { cert.mode = "nope"; } catch { /* strict mode throws; either way it must not change */ }
  assert.equal(cert.mode, "execute", `certificate was mutated to ${cert.mode}`);
  console.log(`         ${cert.venueId} / ${cert.programId} / mode ${cert.mode} / ${cert.contractVersion}`);
});
ok("the contract mutates nothing it is handed", () => {
  const adapter = verified();
  const before = JSON.stringify(adapter, (k, v) => (typeof v === "function" ? "fn" : v));
  venueContract(adapter, { execute: true });
  venueContract(adapter, { execute: false });
  assertVenueContract(adapter, { execute: true });
  const after = JSON.stringify(adapter, (k, v) => (typeof v === "function" ? "fn" : v));
  assert.equal(after, before, "the adapter was mutated by being judged");
  console.log(`         adapter byte-identical across 3 certifications (${before.length} chars)`);
});
ok("the same adapter always gets the same verdict — no clock, no randomness", () => {
  const adapter = verified();
  assert.deepEqual(venueContract(adapter, { execute: true }), venueContract(adapter, { execute: true }));
  assert.deepEqual(venueContract(unverified(), { execute: true }), venueContract(unverified(), { execute: true }));
  console.log(`         two runs, identical verdicts, both directions`);
});
ok("VENUE_CONTRACT_VERSION is pinned", () => {
  assert.equal(VENUE_CONTRACT_VERSION, "snipe-venue-v1", `version=${VENUE_CONTRACT_VERSION}`);
});

/* ── 11. THE REGISTRY ──────────────────────────────────────────────────────────────── */
console.log("\n11. THE REGISTRY — and NO ADAPTER IS EVER HANDED BACK WITH A REFUSAL");
const infosOwnedBy = (programId) => [{ owner: programId }, null, { account: { owner: programId } }];

ok("registering refuses a malformed adapter at boot, naming the clause", () => {
  const reg = createVenueRegistry();
  let caught = null;
  try { registerVenue(unverified({ quote: null }), { registry: reg }); } catch (e) { caught = e; }
  assert.ok(caught instanceof VenueContractError, `threw ${caught && caught.name}`);
  assert.equal(caught.clause, "quote_asset_invalid", `clause=${caught && caught.clause}`);
  assert.equal(registeredVenues(reg).length, 0, `${registeredVenues(reg).length} venues registered after a refusal`);
  console.log(`         -> ${caught.clause}, registry still empty`);
});
ok("registering with {execute:true} asserts the EXECUTE contract at boot", () => {
  const reg = createVenueRegistry();
  let caught = null;
  try { registerVenue(unverified(), { execute: true, registry: reg }); } catch (e) { caught = e; }
  assert.equal(caught && caught.clause, "layout_unverified", `clause=${caught && caught.clause}`);
  assert.equal(registeredVenues(reg).length, 0, "an execute-refused venue was still registered");
  /* And the same adapter registers fine as observe-only — this is exactly the stonk.fun
     shape from the spec: present, watched, unsignable. */
  registerVenue(unverified(), { registry: reg });
  assert.equal(registeredVenues(reg).length, 1, `${registeredVenues(reg).length} venues`);
  console.log(`         execute-refused at boot; the same adapter registers observe-only`);
});
ok("a duplicate id, and a second venue on the same program, are both refused", () => {
  const reg = createVenueRegistry();
  registerVenue(unverified(), { registry: reg });
  assert.throws(() => registerVenue(unverified(), { registry: reg }),
    (e) => e.clause === "venue_duplicate", "a duplicate id was accepted");
  assert.throws(() => registerVenue(unverified({ id: "pumpfun-2" }), { registry: reg }),
    (e) => e.clause === "venue_duplicate", "two venues on one program were accepted");
  assert.equal(registeredVenues(reg).length, 1, `${registeredVenues(reg).length} venues`);
  console.log(`         both refused; registry holds ${registeredVenues(reg).length}`);
});
ok("venueFor matches a mint to the venue whose PROGRAM owns its accounts", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  const r = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: true, registry: reg });
  assert.equal(r.ok, true, `${r.clause}: ${r.detail.message}`);
  assert.equal(r.venue.id, "pumpfun", `venue=${r.venue && r.venue.id}`);
  assert.equal(r.certificate.mode, "execute", `mode=${r.certificate.mode}`);
  console.log(`         ${A_MINT.slice(0, 8)}… owned by ${PUMPFUN_PROGRAM.slice(0, 8)}… -> ${r.venue.id} (execute)`);
});
ok("an unknown owner returns NO venue, and says which owners it saw", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  const r = venueFor(A_MINT, infosOwnedBy(LAUNCHLAB_PROGRAM), { execute: false, registry: reg });
  assert.equal(r.ok, false, "an unregistered program matched a venue");
  assert.equal(r.clause, "venue_unknown", `clause=${r.clause}`);
  assert.equal(r.venue, null, "an adapter was handed back with a refusal");
  console.log(`         -> ${r.detail.message}`);
});
ok("two venues claiming one mint is AMBIGUOUS and hands back nothing", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  registerVenue(spyx(), { registry: reg });
  const r = venueFor(A_MINT, [{ owner: PUMPFUN_PROGRAM }, { owner: LAUNCHLAB_PROGRAM }], { registry: reg });
  assert.equal(r.clause, "venue_ambiguous", `clause=${r.clause}`);
  assert.equal(r.venue, null, "an adapter was handed back on an ambiguous match");
  console.log(`         -> ${r.detail.message}`);
});
ok("an execute lookup on an unverified venue returns clause AND a null venue", () => {
  const reg = createVenueRegistry();
  registerVenue(unverified(), { registry: reg });
  const live = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: true, registry: reg });
  assert.equal(live.ok, false, "an unverified venue was returned for execute");
  assert.equal(live.clause, "layout_unverified", `clause=${live.clause}`);
  assert.equal(live.venue, null, "THE ADAPTER WAS HANDED BACK — a caller could have signed with it");
  assert.equal(live.certificate, null, `certificate=${live.certificate}`);
  /* The same lookup in observe mode DOES return it: that is the whole point of the lane. */
  const shadow = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: false, registry: reg });
  assert.equal(shadow.ok, true, `observe refused it: ${shadow.clause}`);
  assert.equal(shadow.venue.id, "pumpfun", `venue=${shadow.venue && shadow.venue.id}`);
  console.log(`         execute -> ${live.clause} / venue ${live.venue}; observe -> ok / venue ${shadow.venue.id}`);
});
ok("NO STALE PERMISSION: flipping layoutVerified after registration changes the next lookup", () => {
  const reg = createVenueRegistry();
  const adapter = verified();
  registerVenue(adapter, { execute: true, registry: reg });
  const before = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: true, registry: reg });
  assert.equal(before.ok, true, `a venue certified at boot was refused at lookup: ${before.clause}`);
  adapter.layoutVerified = false;                       // the proof was withdrawn
  const after = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: true, registry: reg });
  assert.equal(after.ok, false, "a withdrawn proof kept signing on a certificate cached at boot");
  assert.equal(after.clause, "layout_unverified", `clause=${after.clause}`);
  assert.equal(after.venue, null, "the adapter was still handed back");
  /* And the reverse direction, which is the one that matters for a self-granting adapter:
     setting the flag WITHOUT a proof grants nothing. */
  adapter.layoutVerified = true; delete adapter.layoutProof;
  const forged = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: true, registry: reg });
  assert.equal(forged.clause, "layout_proof_missing", `clause=${forged.clause}`);
  console.log(`         boot ok -> flag off: ${after.clause} -> flag on, proof deleted: ${forged.clause}`);
});
ok("a malformed mint is refused before any venue is consulted", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  for (const mint of [null, "", "not!base58", SYSTEM_PROGRAM, bs58.encode(Buffer.alloc(31, 1))]) {
    const r = venueFor(mint, infosOwnedBy(PUMPFUN_PROGRAM), { registry: reg });
    assert.equal(r.clause, "mint_invalid", `mint ${JSON.stringify(mint)} -> clause ${r.clause}`);
    assert.equal(r.venue, null, "an adapter was handed back for a malformed mint");
  }
  console.log(`         null, "", non-base58, 32 zero bytes and a 31-byte key all -> mint_invalid`);
});
ok("a non-boolean execute at lookup refuses rather than coercing", () => {
  const reg = createVenueRegistry();
  registerVenue(unverified(), { registry: reg });
  const r = venueFor(A_MINT, infosOwnedBy(PUMPFUN_PROGRAM), { execute: "0", registry: reg });
  assert.equal(r.clause, "mode_invalid", `clause=${r.clause}`);
  assert.equal(r.venue, null, 'execute:"0" handed back an adapter');
  console.log(`         venueFor(..., {execute: "0"}) -> ${r.clause}, venue ${r.venue}`);
});
ok("missing accounts on one endpoint are skipped, never counted against a venue", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  const r = venueFor(A_MINT, [null, undefined, { owner: PUMPFUN_PROGRAM }], { execute: true, registry: reg });
  assert.equal(r.ok, true, `a null account info broke the match: ${r.clause}`);
  console.log(`         [null, undefined, owner] -> ${r.venue.id}`);
});
ok("a PublicKey-like owner is matched as well as a string one", () => {
  const reg = createVenueRegistry();
  registerVenue(verified(), { registry: reg });
  const r = venueFor(A_MINT, [{ owner: { toBase58: () => PUMPFUN_PROGRAM } }], { execute: true, registry: reg });
  assert.equal(r.ok, true, `${r.clause}: ${r.detail && r.detail.message}`);
  console.log(`         owner.toBase58() -> ${r.venue.id}`);
});

/* ── 12. NOTHING ON THIS PATH SIGNS, AND NOTHING TOUCHES THE DESK ──────────────────── */
console.log("\n12. THE SOURCE-LEVEL FENCE");
ok("snipe-venue.mjs imports nothing from the desk's exit path", () => {
  const src = fs.readFileSync(new URL("./snipe-venue.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["trade-policy.mjs", "strategy.mjs", "desk-mirror.mjs"])
    assert.doesNotMatch(code, new RegExp(`from\\s+["']\\./${forbidden.replace(".", "\\.")}["']`),
      `the venue contract imports ${forbidden}`);
  console.log(`         no import of trade-policy.mjs, strategy.mjs or desk-mirror.mjs`);
});
ok("it loads no keypair, signs nothing and sends nothing", () => {
  const src = fs.readFileSync(new URL("./snipe-venue.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/Keypair/, /\bsign\w*\(/, /sendTransaction/, /sendRawTransaction/,
    /fetch\(/, /node:fs/, /node:http/, /Date\.now\(\)/, /Math\.random/])
    assert.doesNotMatch(code, forbidden, `the venue contract reaches ${forbidden}`);
  console.log(`         no Keypair, no sign*, no send*, no fetch, no fs, no clock, no randomness`);
});

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
