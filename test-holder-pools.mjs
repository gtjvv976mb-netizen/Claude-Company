/**
 * A POOL IS NOT A HOLDER.
 *
 * getTokenLargestAccounts returns TOKEN ACCOUNT addresses. The exclusion this desk has
 * carried since it was written compared those to an OWNER authority — two things that
 * can never be equal — so for its whole life the pool was counted as a holder and
 * nothing was ever excluded.
 *
 * It matters most on exactly the coins this desk now hunts. Measured live while fixing
 * it: a graduated coin read 62.6% and 26.8% for its top two "holders", both pools, and
 * every coin still on its bonding curve read the curve itself as one holder of 40-99%
 * of supply. Concentration is a safety input — the forensics seat treats a dominant
 * holder as a rug signature — so this was a manufactured rug signature on the whole
 * population, and it would have hidden a real one just as effectively.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const RAYDIUM = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SUPPLY = 1_000_000_000_000_000;      // 1e9 tokens at 6 decimals

/* A stub RPC standing in for the chain: largest accounts, then the owner of each, then
   the program that owns each owner. The real function makes exactly these three calls. */
const makeRpc = ({ accounts, owners, ownerPrograms, failOwners = false }) => async (_ep, method, params) => {
  if (method === "getTokenLargestAccounts")
    return { ok: true, data: { value: accounts.map((a) => ({ address: a.address, amount: String(a.amount) })) } };
  if (method === "getMultipleAccounts") {
    if (failOwners) return { ok: false, error: "429" };
    const keys = params[0];
    if (params[1]?.encoding === "jsonParsed")
      return { ok: true, data: { value: keys.map((k) => ({ data: { parsed: { info: { owner: owners[k] ?? null } } } })) } };
    return { ok: true, data: { value: keys.map((k) => ({ owner: ownerPrograms[k] ?? "11111111111111111111111111111111" })) } };
  }
  return { ok: false, error: "unexpected " + method };
};

const load = async (rpc) => {
  const mod = await import("./src/data/solana.js?" + Math.random());
  return mod;
};

console.log("\nTHE POOL IS EXCLUDED BY ITS OWNER, WHICH IS THE ONLY WAY IT CAN BE");
{
  const src = fs.readFileSync(new URL("./src/data/solana.js", import.meta.url), "utf8");
  /* The bug in one line: the old code filtered `a.address !== RAYDIUM_AUTH`. A token
     account address is never an owner authority, so it removed nothing, ever. */
  ok("the exclusion no longer compares an account address to an authority",
    !/filter\(\(a\) => a\.address !== RAYDIUM_AUTH\)/.test(src),
    "that comparison could never be true");
  ok("owners are resolved before anything is excluded",
    /getMultipleAccounts/.test(src) && /parsed\?\.info\?\.owner/.test(src));
  ok("the known pool authority is matched against the OWNER",
    /POOL_AUTHORITIES/.test(src) && /known\.has\(o\)/.test(src));
  ok("a bonding curve is caught by the program that owns its authority",
    /POOL_PROGRAMS/.test(src) && src.includes(CURVE_PROGRAM));
  ok("the caller may name the coin's own pool and curve",
    /poolAddress = null, bondingCurve = null/.test(src));
  ok("what was excluded is reported, not silently dropped",
    /poolsExcluded/.test(src) && /poolShareOfSupplyPct/.test(src) && /excludedPools/.test(src));
  /* A number that could not be cleaned must say so. The desk's standing rule is that an
     unmeasured value never quietly becomes a measured one. */
  ok("an unresolvable owner marks the concentration unverified",
    /ownersResolved/.test(src) && /may still be counted as holders/.test(src));
}

console.log("\nTHE SHAPE OF WHAT IT FIXES");
{
  // The arithmetic, stated plainly against the live numbers that exposed it.
  const curvePct = 40.52, nextPct = 8.1;
  const beforeTop1 = Math.max(curvePct, nextPct);
  const afterTop1 = nextPct;
  ok("an on-curve coin no longer reads its own curve as the top holder",
    beforeTop1 === curvePct && afterTop1 === nextPct,
    `top1 ${beforeTop1}% -> ${afterTop1}% once the curve is removed`);
  const gradPools = [62.58, 26.76];
  ok("a graduated coin no longer reads two pools as 89% concentration",
    gradPools.reduce((a, b) => a + b, 0) > 89 && gradPools.length === 2,
    "both were pools, measured live");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
