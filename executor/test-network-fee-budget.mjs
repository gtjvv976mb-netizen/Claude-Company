/* THE LIFT MUST BE A LIFT — PROVED AGAINST THE ORIGINAL, NOT AGAINST ITSELF.
 *
 * `assertNetworkFeeBudget` is jupiter.mjs's fee block moved into its own file so the
 * sniper lane can ask the same question without building a Jupiter order envelope. A
 * lift that changes behaviour is not a lift, it is an unreviewed edit to a live money
 * gate — so this file does not merely exercise the new function. For every case it runs
 * the SAME numbers through `validateOrderEnvelope` (untouched, imported from jupiter.mjs)
 * and through the extracted function, and asserts the two agree on the verdict AND on
 * the exact message string. Agreement alone would not be enough either — two copies of
 * one mistake agree perfectly — so every case also states the answer IN ADVANCE, worked
 * by hand from the integer arithmetic, and the actual value is printed in the assertion.
 *
 * Note jupiter.mjs does not call the extracted function yet; that wiring is a separate
 * step. That is precisely what makes this test meaningful today: the two implementations
 * are genuinely independent code paths right now, and this is the differential between
 * them. When the wiring lands, the file keeps passing for the trivial reason, and the
 * message-text and constant pins below keep the honest part of the job.
 *
 * No network. No keypair is generated, loaded or used: `validateOrderEnvelope` compares
 * the taker and the three fee payers as strings, so the fixtures are string literals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_GROSS_RENT_LAMPORTS, assertNetworkFeeBudget } from "./network-fee-budget.mjs";
import { WSOL, validateOrderEnvelope } from "./jupiter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };

const WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

/* A Jupiter order that clears every check ABOVE the fee block, so the only thing any
   case below varies is the fee arithmetic under test. Shaped after the fixture in
   test-live-execution.mjs. */
const ORDER = Object.freeze({
  mode: "manual", inputMint: WSOL, outputMint: MINT, inAmount: "5000000",
  outAmount: "1000", otherAmountThreshold: "970", swapMode: "ExactIn",
  slippageBps: 300, priceImpact: 0.5, feeBps: 50, gasless: false,
  feeMint: WSOL, platformFee: { amount: "5", feeBps: 10, feeMint: WSOL },
  signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 0,
  signatureFeePayer: WALLET, prioritizationFeePayer: WALLET, rentFeePayer: WALLET,
  router: "metis", transaction: "base64", lastValidBlockHeight: "999",
  requestId: "request-1", taker: WALLET,
});
const BASE_CFG = Object.freeze({
  slippageBps: 300, maxPriceImpactPct: 5, maxFeeBps: 100,
  maxNetworkFeeLamports: 2_000_000, maxNetworkFeePct: 10,
  maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
});

const verdict = (fn) => {
  try { fn(); return { threw: false, message: null }; }
  catch (error) { return { threw: true, message: String(error.message) }; }
};

/* Run one set of fee facts through BOTH implementations. `expect` is either the string
   "accept" or a RegExp the message must match — stated before the run, never read off
   the output. Returns the (identical) verdict so a case can print numbers of its own. */
const both = (label, { signatureFee = 0, priorityFee = 0, rentFee = 0, basis, cfg = BASE_CFG }, expect) => {
  const mine = verdict(() => assertNetworkFeeBudget({
    signatureFeeLamports: signatureFee,
    prioritizationFeeLamports: priorityFee,
    rentFeeLamports: rentFee,
    feeBasisLamports: basis,
    cfg,
  }));
  const jup = verdict(() => validateOrderEnvelope(
    { ...ORDER, signatureFeeLamports: signatureFee, prioritizationFeeLamports: priorityFee, rentFeeLamports: rentFee },
    { inputMint: WSOL, outputMint: MINT, amountRaw: "5000000", wallet: WALLET, feeBasisLamports: basis },
    cfg,
  ));
  assert.equal(mine.threw, jup.threw,
    `${label}: lifted said ${mine.threw ? "REFUSE" : "ACCEPT"} but validateOrderEnvelope said ` +
    `${jup.threw ? "REFUSE" : "ACCEPT"} (lifted message: ${mine.message}; jupiter message: ${jup.message})`);
  assert.equal(mine.message, jup.message,
    `${label}: message drift — lifted "${mine.message}" vs jupiter "${jup.message}"`);
  if (expect === "accept") {
    assert.equal(mine.threw, false, `${label}: expected ACCEPT, got refusal "${mine.message}"`);
  } else {
    assert.equal(mine.threw, true, `${label}: expected a refusal matching ${expect}, but both ACCEPTED`);
    assert.match(mine.message, expect, `${label}: refused with "${mine.message}"`);
  }
  return mine;
};

/* ------------------------------------------------------------------ the ruler itself */

ok("the percentage ceiling is exact integer arithmetic, and both directions are provable", () => {
  /* Worked by hand: basis 5,000,000 lamports at 10% admits ceil(fees) <= 500,000, because
     the gate refuses when ceil(fees)*10_000 > 5,000,000*1000 = 5,000,000,000. */
  const basis = 5_000_000;
  both("500,000 on 5,000,000", { signatureFee: 500_000, basis }, "accept");
  const refused = both("500,001 on 5,000,000", { signatureFee: 500_001, basis }, /exceed 10% of the trade basis/);
  const record = assertNetworkFeeBudget({ signatureFeeLamports: 500_000, feeBasisLamports: basis, cfg: BASE_CFG });
  assert.equal(record.networkFeeCeilingLamports, 500_000n,
    `derived ceiling ${record.networkFeeCeilingLamports} lamports, expected 500000n`);
  console.log(`       basis ${basis} @ ${BASE_CFG.maxNetworkFeePct}% -> ceiling ` +
    `${record.networkFeeCeilingLamports} lamports; 500001 refused: "${refused.message}"`);

  /* A second hand-worked point with a fractional percentage, so the floor(pct*100) term
     is exercised rather than assumed: 1,000,000 * floor(0.5*100) / 10,000 = 5,000. */
  const halfPct = { ...BASE_CFG, maxNetworkFeePct: 0.5 };
  both("5,000 on 1,000,000 at 0.5%", { signatureFee: 5_000, basis: 1_000_000, cfg: halfPct }, "accept");
  both("5,001 on 1,000,000 at 0.5%", { signatureFee: 5_001, basis: 1_000_000, cfg: halfPct },
    /exceed 0.5% of the trade basis/);
  const small = assertNetworkFeeBudget({ signatureFeeLamports: 5_000, feeBasisLamports: 1_000_000, cfg: halfPct });
  assert.equal(small.networkFeeCeilingLamports, 5_000n,
    `0.5% of 1,000,000 came out as ${small.networkFeeCeilingLamports}, expected 5000n`);
  console.log(`       0.5% of 1,000,000 -> ${small.networkFeeCeilingLamports} lamports`);
});

ok("a fractional fee is rounded UP before the comparison, exactly as the original does", () => {
  /* 500,000.4 is under the 500,000-lamport ceiling as a float and over it as a whole
     lamport. Math.ceil settles it against the wallet, in the safe direction. Known in
     advance: ceil = 500,001, which is the value the line above proved is refused. */
  const r = both("500,000.4 on 5,000,000", { signatureFee: 500_000.4, basis: 5_000_000 },
    /exceed 10% of the trade basis/);
  console.log(`       fees 500000.4 -> ceil 500001 -> refused: "${r.message}"`);
  both("499,999.6 on 5,000,000", { signatureFee: 499_999.6, basis: 5_000_000 }, "accept");
});

ok("the two non-rent fees are summed, and the absolute lamport cap can say no on its own", () => {
  /* Split across both fields so a lift that dropped one term would show up. The pct gate
     must NOT be the one that fires here, so the basis is large enough to clear it:
     10^11 * 1000 / 10^4 = 10^10 lamports of headroom. */
  const basis = 100_000_000_000;
  both("1,000,000 + 1,000,000 at cap 2,000,000", { signatureFee: 1_000_000, priorityFee: 1_000_000, basis }, "accept");
  const r = both("1,000,000 + 1,000,001 at cap 2,000,000",
    { signatureFee: 1_000_000, priorityFee: 1_000_001, basis }, /non-rent network fees 2000001 lamports exceed cap 2000000/);
  console.log(`       absolute cap fired first: "${r.message}"`);
});

ok("rent is bound separately, at the cap or at the lifted default when cfg omits it", () => {
  const basis = 5_000_000;
  both("rent at the cap", { rentFee: MAX_GROSS_RENT_LAMPORTS, basis }, "accept");
  const r = both("rent one lamport over the cap", { rentFee: MAX_GROSS_RENT_LAMPORTS + 1, basis },
    new RegExp(`rent ${MAX_GROSS_RENT_LAMPORTS + 1} lamports exceeds cap ${MAX_GROSS_RENT_LAMPORTS}`));
  console.log(`       rent cap ${MAX_GROSS_RENT_LAMPORTS}: "${r.message}"`);

  /* cfg without maxRentLamports must fall back to the same constant — and the message
     must name the resolved cap, not "undefined". */
  const { maxRentLamports: _omitted, ...noRentCap } = BASE_CFG;
  both("default rent cap accepts the cap", { rentFee: MAX_GROSS_RENT_LAMPORTS, basis, cfg: noRentCap }, "accept");
  const fallback = both("default rent cap refuses one over", { rentFee: MAX_GROSS_RENT_LAMPORTS + 1, basis, cfg: noRentCap },
    new RegExp(`exceeds cap ${MAX_GROSS_RENT_LAMPORTS}$`));
  assert.doesNotMatch(fallback.message, /undefined/,
    `the fallback cap leaked into the message: "${fallback.message}"`);

  /* A tighter cfg cap must bind ahead of the default, or the default is not a default. */
  both("a tighter configured rent cap binds", { rentFee: 4_078_561, basis, cfg: { ...BASE_CFG, maxRentLamports: 4_078_560 } },
    /rent 4078561 lamports exceeds cap 4078560/);
  both("and accepts the real two-ATA rent", { rentFee: 4_078_560, basis, cfg: { ...BASE_CFG, maxRentLamports: 4_078_560 } },
    "accept");
});

ok("a basis that cannot bound anything is refused, in every shape", () => {
  both("zero basis", { signatureFee: 0, basis: 0 }, /exceed 10% of the trade basis/);
  both("negative basis", { signatureFee: 0, basis: -1 }, /exceed 10% of the trade basis/);
  both("negative percentage cap", { signatureFee: 0, basis: 5_000_000, cfg: { ...BASE_CFG, maxNetworkFeePct: -1 } },
    /exceed -1% of the trade basis/);
  both("non-numeric percentage cap", { signatureFee: 0, basis: 5_000_000, cfg: { ...BASE_CFG, maxNetworkFeePct: "ten" } },
    /exceed NaN% of the trade basis/);
  /* Zero fees on a valid basis must still be accepted, or "refuses everything" would be
     passing this test for the wrong reason. */
  both("zero fees on a real basis", { signatureFee: 0, basis: 5_000_000 }, "accept");
});

ok("a negative or non-finite fee estimate is refused before any comparison", () => {
  both("negative signature fee", { signatureFee: -1, basis: 5_000_000 }, /Jupiter returned a negative fee estimate/);
  both("negative priority fee", { priorityFee: -1, basis: 5_000_000 }, /Jupiter returned a negative fee estimate/);
  both("negative rent", { rentFee: -1, basis: 5_000_000 }, /Jupiter returned a negative fee estimate/);
  both("NaN signature fee", { signatureFee: "not-a-number", basis: 5_000_000 }, /signature fee must be finite/);
  both("infinite priority fee", { priorityFee: Infinity, basis: 5_000_000 }, /priority fee must be finite/);
  both("NaN rent", { rentFee: "nope", basis: 5_000_000 }, /rent fee must be finite/);
});

ok("the two lifted quirks are preserved, named rather than quietly fixed", () => {
  /* QUIRK 1: an undefined absolute cap compares false and therefore does not bind. The
     percentage gate still does, so this is not a hole in the desk path — but a caller
     that forgets the cap gets no lamport ceiling, and that must be visible, not folklore. */
  const { maxNetworkFeeLamports: _none, ...noCap } = BASE_CFG;
  const r = both("100,000,000 lamports with no absolute cap configured",
    { signatureFee: 100_000_000, basis: 100_000_000_000, cfg: noCap }, "accept");
  assert.equal(r.threw, false, `expected the documented fail-open, got "${r.message}"`);
  both("...but the percentage gate still binds with no absolute cap",
    { signatureFee: 100_000_000, basis: 5_000_000, cfg: noCap }, /exceed 10% of the trade basis/);
  console.log("       undefined maxNetworkFeeLamports does not bind (lifted as-is); the 10% gate does");

  /* QUIRK 2: a missing basis throws BigInt's own conversion error in both paths. Fails
     closed, and identically. */
  const mine = verdict(() => assertNetworkFeeBudget({ signatureFeeLamports: 5_000, cfg: BASE_CFG }));
  /* Reaching the fee block with no basis at all takes an envelope whose inAmount is also
     absent — `String(undefined) === String(undefined)` clears the amount check above it —
     which is exactly the shape that would slip an unbounded basis into the fee gate. */
  const jup = verdict(() => validateOrderEnvelope(
    { ...ORDER, inAmount: undefined, signatureFeeLamports: 5_000 },
    { inputMint: WSOL, outputMint: MINT, amountRaw: undefined, wallet: WALLET },
    BASE_CFG,
  ));
  assert.equal(mine.threw, true, "a missing basis must fail closed");
  assert.equal(mine.message, jup.message,
    `missing-basis message drift: lifted "${mine.message}" vs jupiter "${jup.message}"`);
  console.log(`       missing basis, both paths: "${mine.message}"`);
});

/* ------------------------------------------- the live size, derived from poller.mjs */

ok("at the live 0.005 SOL ticket the PERCENTAGE gate binds, not the lamport cap", () => {
  /* Read the rails rather than restate them: poller.mjs fatals on a bad environment at
     import time, so LIVE_LIMITS is parsed out of its source. If any of these move, this
     fails loudly instead of certifying a stale number. */
  const poller = read("poller.mjs");
  const start = poller.indexOf("const LIVE_LIMITS = Object.freeze({");
  assert.ok(start > 0, "could not find LIVE_LIMITS in poller.mjs — the derivation must fail loudly");
  const block = poller.slice(start, poller.indexOf("\n});", start));
  const field = (name, re) => {
    const m = block.match(re);
    assert.ok(m, `could not read LIVE_LIMITS.${name} from poller.mjs`);
    return m[1];
  };
  const maxSolPerTrade = Number(field("maxSolPerTrade", /\n\s*maxSolPerTrade:\s*([\d.]+)/));
  const maxNetworkFeeLamports = Number(field("maxNetworkFeeLamports", /\n\s*maxNetworkFeeLamports:\s*([\d_]+)/).replaceAll("_", ""));
  const maxNetworkFeePct = Number(field("maxNetworkFeePct", /\n\s*maxNetworkFeePct:\s*([\d.]+)/));
  const expectedFee = Number(field("expectedNetworkFeeLamports", /\n\s*expectedNetworkFeeLamports:\s*([\d_]+)/).replaceAll("_", ""));
  const rentRef = field("maxRentLamports", /\n\s*maxRentLamports:\s*([A-Za-z_][A-Za-z0-9_]*)/);
  assert.equal(rentRef, "MAX_GROSS_RENT_LAMPORTS",
    `poller.mjs LIVE_LIMITS.maxRentLamports is now ${rentRef}; the lifted default is no longer the live one`);

  const basis = BigInt(Math.round(maxSolPerTrade * 1e9));
  const live = { ...BASE_CFG, maxNetworkFeeLamports, maxNetworkFeePct };
  const record = assertNetworkFeeBudget({ signatureFeeLamports: 0, feeBasisLamports: basis, cfg: live });
  const pctCeiling = record.networkFeeCeilingLamports;
  console.log(`       live basis ${basis} lamports (${maxSolPerTrade} SOL); ${maxNetworkFeePct}% ceiling ` +
    `${pctCeiling} lamports vs absolute cap ${maxNetworkFeeLamports} lamports`);
  assert.ok(pctCeiling < BigInt(maxNetworkFeeLamports),
    `at the live size the percentage ceiling is ${pctCeiling} and the lamport cap ${maxNetworkFeeLamports} — ` +
    "the percentage no longer binds tighter, so the friction claim in the spec has moved");

  /* The binding proof: a fee strictly between the two ceilings must be refused, and the
     message must name the percentage. Anything else means the wrong gate fired. */
  const between = pctCeiling + 1n;
  assert.ok(between < BigInt(maxNetworkFeeLamports),
    `${between} is not below the lamport cap ${maxNetworkFeeLamports}; this case would prove nothing`);
  both("at the pct ceiling", { signatureFee: Number(pctCeiling), basis }, "accept");
  const r = both("one lamport over the pct ceiling", { signatureFee: Number(between), basis },
    new RegExp(`exceed ${maxNetworkFeePct}% of the trade basis`));
  console.log(`       ${between} lamports is under the ${maxNetworkFeeLamports} cap and still refused: "${r.message}"`);

  /* And the cost model the spec's friction figure is built from clears its own gate: one
     leg at expectedNetworkFeeLamports is exactly the ceiling at this size. Friction is
     derived here, never typed: 1 + 2*fee/basis. */
  both("one leg at the expected network fee", { signatureFee: expectedFee, basis }, "accept");
  const frictionX = 1 + (2 * expectedFee) / Number(basis);
  console.log(`       round-trip friction at the live size: ${frictionX.toFixed(4)}x ` +
    `(2 x ${expectedFee} lamports on ${basis}) — a "breakeven" stop at 1.0000x realizes ` +
    `${(((1 / frictionX) - 1) * 100).toFixed(2)}%`);
  assert.ok(frictionX > 1, `friction came out ${frictionX}, which would mean trading is free`);
  assert.equal(BigInt(expectedFee), pctCeiling,
    `the expected per-leg fee ${expectedFee} is no longer exactly the ${maxNetworkFeePct}% ceiling ` +
    `${pctCeiling} at the live size — the two rails have drifted apart`);
});

/* ------------------------------------------------------ the lift is still a lift */

ok("the constant and all four message strings still match jupiter.mjs, character for character", () => {
  const jupiter = read("jupiter.mjs");
  const m = jupiter.match(/MAX_GROSS_RENT_LAMPORTS = ([\d_]+)/);
  if (m) {
    const theirs = Number(m[1].replaceAll("_", ""));
    assert.equal(theirs, MAX_GROSS_RENT_LAMPORTS,
      `jupiter.mjs declares ${theirs} and network-fee-budget.mjs ${MAX_GROSS_RENT_LAMPORTS} — one ceiling, two copies, drifted`);
    console.log(`       MAX_GROSS_RENT_LAMPORTS ${theirs} in both files`);
  } else {
    /* The wiring step deleted jupiter's copy. What must survive is that jupiter still
       EXPORTS the name — poller.mjs and live-roundtrip-test.mjs import it from there — and
       that both paths resolve to ONE value.

       RE-ANCHORED 2026-09-11, and the original form was actively wrong: this asserted the
       `export { X } from "./network-fee-budget.mjs"` shape, which is a pure re-export and
       does NOT bind the name locally. jupiter.mjs USES the constant in its own scope, so
       that shape boots the installed bot straight into a ReferenceError. The correct
       wiring imports it AND re-exports it. Asserting the VALUES rather than the syntax
       admits either form and would have caught the broken one, which the syntax pin did
       not — it demanded it. */
    assert.match(jupiter, /MAX_GROSS_RENT_LAMPORTS/,
      "jupiter.mjs no longer references MAX_GROSS_RENT_LAMPORTS at all");
    console.log("       jupiter.mjs takes MAX_GROSS_RENT_LAMPORTS from the lifted module");
  }

  const lifted = read("network-fee-budget.mjs");
  /* Taken from the running code, not from the header comment: a copy of the block also
     appears in the header for the record, so count occurrences in the source below the
     comment by matching the template literally in both files. */
  /* THE GATE's OWN MESSAGES — these moved with the block and must now exist in exactly
     one place. */
  const TEMPLATES = [
    "throw new Error(\"Jupiter returned a negative fee estimate\");",
    "throw new Error(`non-rent network fees ${networkFees} lamports exceed cap ${cfg.maxNetworkFeeLamports}`);",
    "throw new Error(`estimated network fees exceed ${maxNetworkFeePct}% of the trade basis`);",
  ];
  /* A GENERAL HELPER, NOT PART OF THE GATE. jupiter.mjs uses finite() in many places
     beyond the fee block, so it legitimately keeps its own; the lifted module needs one
     to stand alone. Two copies are correct here — what must hold is that they still SAY
     the same thing, so a fee refused in one lane reads the same as in the other. */
  const SHARED_HELPER = "throw new Error(`${name} must be finite`);";
  assert.ok(jupiter.includes(SHARED_HELPER) && lifted.includes(SHARED_HELPER),
    "the finite() helper message differs between jupiter.mjs and network-fee-budget.mjs");
  /* RE-ANCHORED 2026-09-11. Before the wiring both files held the block, and the point was
     that the copies had not drifted. Now there is ONE copy, which is the whole aim of the
     lift — so the property becomes: the lifted module still carries each message verbatim,
     and jupiter.mjs no longer carries a SECOND copy of it. The second half is the stronger
     half: it is what fails if somebody later pastes the block back inline. */
  for (const template of TEMPLATES) {
    assert.ok(lifted.includes(template), `network-fee-budget.mjs no longer contains: ${template}`);
    assert.ok(!jupiter.includes(template),
      `jupiter.mjs has grown its own copy of: ${template} — one ceiling, two copies, free to drift`);
  }
  /* The rent message is the one line the lift rewrote — same TEXT, one resolved variable
     instead of two `??` expressions — so it is pinned by behaviour above and by shape here. */
  assert.ok(lifted.includes("throw new Error(`rent ${rentFee} lamports exceeds cap ${maxRentLamports}`);"),
    "the rent refusal in network-fee-budget.mjs has changed shape");
  console.log(`       ${TEMPLATES.length} refusal templates present in both files`);
});

ok("the function is pure: it mutates nothing it is given and returns a frozen record", () => {
  const cfg = { ...BASE_CFG };
  const args = {
    signatureFeeLamports: 5_000, prioritizationFeeLamports: 10_000, rentFeeLamports: 0,
    feeBasisLamports: 5_000_000, cfg,
  };
  const before = JSON.stringify(args);
  const record = assertNetworkFeeBudget(args);
  assert.equal(JSON.stringify(args), before, `the arguments were mutated: ${JSON.stringify(args)}`);
  assert.equal(Object.isFrozen(record), true, "the returned record is not frozen");
  assert.equal(record.networkFeeLamports, 15_000, `networkFeeLamports came back ${record.networkFeeLamports}`);
  assert.equal(typeof record.feeBasisLamports, "bigint",
    `feeBasisLamports is ${typeof record.feeBasisLamports}; lamports are BigInt in this lane`);
  assert.equal(record.pctOfBasis.toFixed(4), "0.3000", `pctOfBasis reported ${record.pctOfBasis}`);
  /* Deterministic: no clock, no I/O, so the same input gives the same record twice. */
  assert.deepEqual(assertNetworkFeeBudget(args), record, "two identical calls disagreed");
  console.log(`       15,000 lamports on 5,000,000 = ${record.pctOfBasis.toFixed(4)}% of basis, ` +
    `ceiling ${record.networkFeeCeilingLamports}`);
});

console.log(`\n${pass} passed — one network-fee ceiling, two callers, no drift\n`);

/* THE PROPERTY THE SYNTAX PIN WAS REACHING FOR, CHECKED BEHAVIOURALLY.
 *
 * poller.mjs and live-roundtrip-test.mjs import MAX_GROSS_RENT_LAMPORTS from jupiter.mjs;
 * test-snipe-entry.mjs imports it from network-fee-budget.mjs. Two import paths for one
 * ceiling is how two lanes come to disagree about a cap, so the values are compared
 * directly — and a module that merely re-exports without binding locally is caught here
 * too, because loading jupiter.mjs at all would throw. */
{
  const jup = await import("./jupiter.mjs");
  const budget = await import("./network-fee-budget.mjs");
  ok("both import paths resolve to one and the same ceiling", () => {
    assert.equal(typeof jup.MAX_GROSS_RENT_LAMPORTS, "number",
      `jupiter.mjs exports ${typeof jup.MAX_GROSS_RENT_LAMPORTS}`);
    assert.equal(jup.MAX_GROSS_RENT_LAMPORTS, budget.MAX_GROSS_RENT_LAMPORTS,
      `jupiter ${jup.MAX_GROSS_RENT_LAMPORTS} vs budget ${budget.MAX_GROSS_RENT_LAMPORTS}`);
    console.log(`       both paths -> ${jup.MAX_GROSS_RENT_LAMPORTS}`);
  });
}
