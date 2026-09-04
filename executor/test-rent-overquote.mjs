/**
 * A RENT OVER-ESTIMATE IS THE SAFE DIRECTION, AND IT REFUSED A REAL TRADE.
 *
 * On 2026-09-04 the bot took its first ever autonomous entry to the final gate and was
 * refused there, one second later:
 *
 *   14:53:18  ENTRY Mobi — 0.0175 SOL | stop 0.000118 target 0.000165
 *   14:53:19  SKIP Mobi: secondary RPC canonical ATA rent facts do not match Jupiter's
 *             rent estimate (chain 3,742,803 gross; Jupiter reports 4,078,560)
 *
 * Measured against public mainnet, the CHAIN is right and Jupiter is stale: a 165-byte
 * token account is rent-exempt at 1,855,569 lamports and a 170-byte one at 1,887,234,
 * while Jupiter still quotes the older 2,039,280. Both providers agreed with the chain.
 * Jupiter disagreed HIGH — it wanted to reserve more rent than would be taken.
 *
 * That cannot hurt: the rent goes to an account we own and returns when it closes, the
 * simulation check bounds what actually leaves the wallet, and the absolute cap still
 * applies. Under-quoting is the dangerous direction and is what these assertions are
 * mostly about.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const src = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
const MULT = Number((src.match(/RENT_OVER_ESTIMATE_MULTIPLE = ([\d.]+)/) || [])[1]);
const CAP = Number((src.match(/MAX_GROSS_RENT_LAMPORTS = ([0-9_]+)/) || [])[1]?.replace(/_/g, "")) || 4_200_000;

/* The rule, lifted from the source so the test cannot drift from it. */
const accepts = (reported, chainFigures, cap = CAP) => {
  const set = new Set(chainFigures);
  const chainGross = Math.max(...chainFigures);
  const ceiling = Math.min(Math.floor(chainGross * MULT), cap);
  return set.has(reported) || (reported > chainGross && reported <= ceiling);
};
// The exact figures from the live refusal.
const MOBI = [1_887_234, 1_855_569, 3_742_803, 3_711_138];

console.log("\nTHE TRADE THAT WAS REFUSED IS NOW TAKEN");
{
  ok("Jupiter's stale over-estimate is accepted", accepts(4_078_560, MOBI),
    `4,078,560 vs chain 3,742,803 — ${(4_078_560 / 3_742_803).toFixed(2)}x`);
  for (const exact of MOBI)
    ok(`an exact chain figure is still accepted: ${exact.toLocaleString()}`, accepts(exact, MOBI));
}

console.log("\nUNDER-QUOTING IS NEVER ACCEPTED, AT ANY MARGIN");
{
  /* The dangerous direction: Jupiter claiming rent will cost LESS than the chain will
     take leaves the wallet short of what the transaction actually needs. */
  for (const under of [0, 1, 1_000_000, 3_000_000, 3_742_802])
    ok(`refused: ${under.toLocaleString()} (below the chain's ${(3_742_803).toLocaleString()})`,
      !accepts(under, MOBI) || MOBI.includes(under));
  ok("a value between two chain figures is not accepted either",
    !accepts(2_500_000, MOBI), "not an exact figure, and below the gross");
}

console.log("\nTHE OVER-ESTIMATE IS BOUNDED, NOT OPEN-ENDED");
{
  ok("the margin is modest", MULT > 1 && MULT <= 1.5, `${MULT}x`);
  const ceiling = Math.min(Math.floor(3_742_803 * MULT), CAP);
  ok("a wildly inflated quote is still refused", !accepts(ceiling + 1, MOBI),
    `ceiling ${ceiling.toLocaleString()}`);
  ok("the absolute rent cap still binds", !accepts(CAP + 1, MOBI, CAP), `cap ${CAP.toLocaleString()}`);
  /* With a small chain figure the multiple binds; with a large one the cap does. Both
     must hold, so neither can be escaped by choosing the other. */
  ok("on a small chain figure the multiple is what binds, not the absolute cap",
    !accepts(2_000_001, [800_000, 1_600_000]), "one lamport above 1.25x of 1,600,000");
  ok("...and it accepts right up to that bound", accepts(2_000_000, [800_000, 1_600_000]));
}

console.log("\nTHE GUARD IS STILL THE GUARD");
{
  ok("the refusal still exists and still names both sides",
    /RPC canonical ATA rent facts do not match Jupiter's rent estimate/.test(src));
  ok("an over-estimate must be strictly above the chain figure to take that path",
    /reportedRentLamports > chainGross && reportedRentLamports <= overEstimateCeiling/.test(src));
  ok("the ceiling is the tighter of the multiple and the absolute cap",
    /Math\.min\(\s*Math\.floor\(chainGross \* RENT_OVER_ESTIMATE_MULTIPLE\)/.test(src));
  ok("a non-integer quote is still refused", /Number\.isSafeInteger\(reportedRentLamports\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
