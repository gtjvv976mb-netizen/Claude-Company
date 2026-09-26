/**
 * THE CLAIM, PINNED TO MAINNET — because this instruction moves money and a plausible
 * wrong address is worse than a missing one.
 *
 * Every layout assertion in this file is checked against transactions that LANDED. Three
 * independent claims, three different creators, fetched from mainnet and decoded:
 *
 *   agent 59  4x8cpVhKu6LxECtqzquUJQqLEsoZpERpAhrLH2Lo8Cjkfcbt7fwGdRZHTi4QCPnAs8jJX29JQhdyJWw5Q7GZgQBF
 *   agent 25  2u8Ck3foJquAzH6xTKn6NSBWeQJ3VfVJ4nxhjaahnHmUyYZ2nWbp3x4oD5J1VGyXEsApj4Dw8CuHtjLEahWrepXa
 *   agent 11  5Hw6ukFQb5sB7ABcjKXBqxYnyL3NNSHw47DvonMJLcYvLf9KYupFNhnqFyzJ3GHgtyeWXMBwGDnv8foarXarb6Qc
 *
 * The creators and the accounts each transaction actually used are the fixtures below. If
 * a future edit changes a seed, a discriminator or an account position, these stop
 * matching real addresses — which is the only test that can catch a change that still
 * produces a valid-looking key.
 *
 * THE ONE THAT WOULD HAVE COST REAL MONEY: the two programs spell the same seed
 * differently — `creator-vault` with a hyphen on the bonding curve, `creator_vault` with
 * an underscore on pump-amm. Both derive fine. The wrong one owns nothing. A test that
 * only round-tripped the module against itself would pass on both, so the hyphen and the
 * underscore are each pinned against a real vault below, and a case asserts that swapping
 * them produces a DIFFERENT address so nobody can tidy the two into one constant.
 *
 *   node test-pumpfun-fees.mjs
 */
import fs from "node:fs";
import {
  PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_EVENT_AUTHORITY, PUMP_AMM_EVENT_AUTHORITY,
  COLLECT_CREATOR_FEE_DISCRIMINATOR, COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR,
  CURVE_VAULT_SEED, AMM_VAULT_SEED, PumpfunFeeError,
  curveCreatorVault, ammCreatorVaultAuthority, ammCreatorVaultAta,
  collectCreatorFeeIx, collectCoinCreatorFeeIx, buildFeeClaim, readClaimable,
} from "./pumpfun-fees.mjs";
import { WSOL } from "./jupiter.mjs";
import { TOKEN_PROGRAM } from "./token2022.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/** Exactly what the three landed transactions used. Copied from the decoded instructions,
 *  not from any documentation. */
const LANDED = [
  { no: 59, creator: "y98CuQXtpMkmAzv4F3qNkRDiSUtBJZu7F282sRSgYVV",
    curveVault: "CJng31JkG5QuudRHMt4udy998YEM4oS4KJexMDJzjHZt",
    ammAuth: "Cf1hLZggx99YR8Ar6oDtHB7eRYi6VJXkqakXi4HxRLdF",
    ammAta: "2wAjMWgG1xcZXmUXEmF7wZcu9Jh2JsMDHTraXe1uEFai",
    dest: "6g6VFipnutBXh4XnEgDVdWYSeuEd2aA5BwcnqJUHrB4Y" },
  { no: 25, creator: "ByuASCrQJ81XMmc757s9GPGigRVnwy8WbEsjvvBvnMpQ",
    curveVault: "8nVgLNYAkmNMfdfutuZUTRnXN3cEXJ9JzgJsDWxJphaA",
    ammAuth: "FdsU1bYZECs3nCxH2faPNAXTw81CYqNfFTedoJRnQEp7",
    ammAta: "4HdnNjq71RJRehchGMRtj6Tq5BpGu9XKSG36qmmSvHA6",
    dest: "7dyQMih5wygw2SjochynJ6f6vgsnM3F3z7PYGvJopSYN" },
  { no: 11, creator: "6c3SWAWdVhzBFtCjcswjwykhyMtczYWRLq3yNCrtFQdw",
    curveVault: "AGy7c1zBcMMkgtTN3VZd9133pGuougTPWjK2QsgDgEgf",
    ammAuth: "CYQQJJF6pVxYg4BsGokta1K52UYqrzFFpEZiCVUMucqJ",
    ammAta: "2FuthV4UcRyi98nupqzCTiwqeuz8r6uusEbrUQdenQBR",
    dest: "2XDGyiKxCQhuja7xToygyhX4yVuSUsdeM25LoWfEqTqU" },
];

console.log("\nEVERY ACCOUNT DERIVES TO WHAT MAINNET ACTUALLY USED");
for (const t of LANDED) {
  ok(`agent ${t.no}: bonding-curve vault`, curveCreatorVault(t.creator) === t.curveVault,
    curveCreatorVault(t.creator));
  ok(`agent ${t.no}: amm vault authority`, ammCreatorVaultAuthority(t.creator) === t.ammAuth,
    ammCreatorVaultAuthority(t.creator));
  ok(`agent ${t.no}: amm vault token account`, ammCreatorVaultAta(t.creator) === t.ammAta,
    ammCreatorVaultAta(t.creator));
}

console.log("\nTHE HYPHEN AND THE UNDERSCORE ARE NOT THE SAME SEED");
{
  ok("the two seeds are spelled differently, on purpose",
    CURVE_VAULT_SEED === "creator-vault" && AMM_VAULT_SEED === "creator_vault",
    `${CURVE_VAULT_SEED} vs ${AMM_VAULT_SEED}`);
  /* If someone "tidies" these into one constant, the derivations still succeed and the
     addresses silently become wrong. This is the case that notices. */
  ok("they derive DIFFERENT addresses, so tidying them into one breaks this test",
    curveCreatorVault(LANDED[0].creator) !== ammCreatorVaultAuthority(LANDED[0].creator));
  ok("...and each matches its own program's real vault, not the other's",
    curveCreatorVault(LANDED[0].creator) === LANDED[0].curveVault &&
    ammCreatorVaultAuthority(LANDED[0].creator) === LANDED[0].ammAuth);
}

console.log("\nthe discriminators are the bytes that were on the wire, and carry no arguments");
{
  const a = collectCreatorFeeIx({ creator: LANDED[0].creator });
  const b = collectCoinCreatorFeeIx({ creator: LANDED[0].creator });
  ok("CollectCreatorFee data is exactly the observed 8 bytes",
    a.data.toString("hex") === COLLECT_CREATOR_FEE_DISCRIMINATOR && a.data.length === 8,
    a.data.toString("hex"));
  ok("collect_coin_creator_fee likewise",
    b.data.toString("hex") === COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR && b.data.length === 8,
    b.data.toString("hex"));
  ok("neither carries an amount — the program sends the whole vault",
    a.data.length === 8 && b.data.length === 8);
  ok("the two discriminators are different instructions",
    COLLECT_CREATOR_FEE_DISCRIMINATOR !== COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR);
}

console.log("\nthe account ORDER is the order the landed transactions used");
{
  const t = LANDED[0];
  const a = collectCreatorFeeIx({ creator: t.creator }).keys.map((k) => k.pubkey.toBase58());
  ok("curve leg: 5 accounts", a.length === 5, `${a.length}`);
  ok("  [0] creator  [1] vault  [2] system  [3] event authority  [4] program",
    a[0] === t.creator && a[1] === t.curveVault && a[2] === "11111111111111111111111111111111" &&
    a[3] === PUMP_EVENT_AUTHORITY && a[4] === PUMP_PROGRAM, a.join(" "));

  const b = collectCoinCreatorFeeIx({ creator: t.creator }).keys.map((k) => k.pubkey.toBase58());
  ok("amm leg: 8 accounts", b.length === 8, `${b.length}`);
  ok("  [0] quote mint  [1] token program  [2] creator",
    b[0] === WSOL && b[1] === TOKEN_PROGRAM && b[2] === t.creator);
  ok("  [3] vault authority  [4] vault ATA  [5] destination",
    b[3] === t.ammAuth && b[4] === t.ammAta && b[5] === t.dest, b.slice(3, 6).join(" "));
  ok("  [6] event authority  [7] program",
    b[6] === PUMP_AMM_EVENT_AUTHORITY && b[7] === PUMP_AMM_PROGRAM);
}

console.log("\nsigner and writable flags match what the chain required");
{
  const t = LANDED[0];
  const a = collectCreatorFeeIx({ creator: t.creator }).keys;
  ok("the creator signs the curve claim", a[0].isSigner === true);
  ok("...and both the creator and the vault are writable — lamports move between them",
    a[0].isWritable === true && a[1].isWritable === true);
  ok("the event authority and program are read-only",
    a[3].isWritable === false && a[4].isWritable === false);

  const b = collectCoinCreatorFeeIx({ creator: t.creator }).keys;
  ok("the creator signs the amm claim but is not written to — the TOKENS move, not its lamports",
    b[2].isSigner === true && b[2].isWritable === false);
  ok("the vault ATA and the destination are writable", b[4].isWritable === true && b[5].isWritable === true);
  ok("the vault AUTHORITY is not writable — it only authorises", b[3].isWritable === false);
}

console.log("\nthe whole claim: both vaults, then unwrap");
{
  const t = LANDED[0];
  const { instructions, accounts } = buildFeeClaim({ creator: t.creator });
  ok("four instructions: curve claim, create ATA, amm claim, close", instructions.length === 4,
    `${instructions.length}`);
  const progs = instructions.map((i) => i.programId.toBase58());
  ok("...in that order", progs[0] === PUMP_PROGRAM && progs[2] === PUMP_AMM_PROGRAM &&
    progs[3] === TOKEN_PROGRAM, progs.join(" "));
  ok("the ATA is created idempotently, so a second claim does not fail on an existing account",
    instructions[1].data[0] === 1);
  /* THE LEG THAT IS EASY TO FORGET. Without the close, every claim leaves a rent-funded
     wrapped account behind and the fee lane slowly spends its own revenue on rent. */
  ok("the close sends the unwrapped SOL to the creator, not to a token account",
    instructions[3].data[0] === 9 &&
    instructions[3].keys[1].pubkey.toBase58() === t.creator, instructions[3].keys[1].pubkey.toBase58());
  ok("the reported accounts are the derived ones, so a caller can check them before signing",
    accounts.curveVault === t.curveVault && accounts.ammVaultAuthority === t.ammAuth &&
    accounts.ammVaultAta === t.ammAta);

  ok("curve only: one instruction, no wrapped account at all",
    buildFeeClaim({ creator: t.creator, includeAmm: false }).instructions.length === 1);
  ok("amm only: three, and still closes", (() => {
    const only = buildFeeClaim({ creator: t.creator, includeCurve: false }).instructions;
    return only.length === 3 && only[2].data[0] === 9;
  })());
  ok("neither is refused rather than producing an empty transaction",
    threw(() => buildFeeClaim({ creator: t.creator, includeCurve: false, includeAmm: false }))?.reason === "nothing_to_claim");
}

console.log("\nit refuses a key it cannot verify");
{
  ok("a non-base58 creator is refused before any derivation",
    threw(() => curveCreatorVault("not-a-key"))?.reason === "key_invalid");
  ok("...and by the instruction builders too",
    threw(() => collectCreatorFeeIx({ creator: "" }))?.reason === "key_invalid");
  ok("a bad quote mint is refused",
    threw(() => collectCoinCreatorFeeIx({ creator: LANDED[0].creator, quoteMint: "nope" }))?.reason === "key_invalid");
}

console.log("\nWHAT IS THERE: zero is a fact, unreadable is not");
{
  const t = LANDED[0];
  const both = await readClaimable({ creator: t.creator,
    readLamports: async () => 1_500_000, readTokenAmount: async () => 2_500_000 });
  ok("both vaults readable: the total is their sum", both.totalLamports === 4_000_000, String(both.totalLamports));
  ok("...and it names the accounts it read", both.curveVault === t.curveVault && both.ammVaultAta === t.ammAta);

  const empty = await readClaimable({ creator: t.creator,
    readLamports: async () => 0, readTokenAmount: async () => 0 });
  ok("an empty pair of vaults reads 0 and is readable", empty.totalLamports === 0 && empty.readable === true);

  /* THE DISTINCTION THIS LANE LIVES ON. A lane that reads an RPC failure as "nothing to
     claim" stops claiming the moment an endpoint hiccups, and says nothing. */
  const dead = await readClaimable({ creator: t.creator,
    readLamports: async () => { throw new Error("RPC down"); },
    readTokenAmount: async () => { throw new Error("RPC down"); } });
  ok("both unreadable: null, NOT zero", dead.totalLamports === null && dead.readable === false,
    JSON.stringify({ total: dead.totalLamports, readable: dead.readable }));
  const half = await readClaimable({ creator: t.creator,
    readLamports: async () => { throw new Error("down"); }, readTokenAmount: async () => 700 });
  ok("one readable, one not: the known side still counts and the unknown reads null",
    half.totalLamports === 700 && half.curveLamports === null && half.readable === true,
    JSON.stringify({ curve: half.curveLamports, amm: half.ammLamports }));
  const junk = await readClaimable({ creator: t.creator,
    readLamports: async () => -5, readTokenAmount: async () => "abc" });
  ok("a negative or unparseable balance is unknown, never a number",
    junk.curveLamports === null && junk.ammLamports === null);
  await readClaimable({ creator: t.creator, readLamports: () => 1, readTokenAmount: () => 1 });
  ok("synchronous readers work too", true);
  let e = null;
  try { await readClaimable({ creator: t.creator }); } catch (err) { e = err; }
  ok("missing readers are refused rather than defaulted", e?.reason === "readers_missing");
}

console.log("\nit opens nothing and ships no destination of its own");
{
  const src = fs.readFileSync(new URL("./pumpfun-fees.mjs", import.meta.url), "utf8");
  ok("no Connection is constructed in this module", !/new Connection\(/.test(src));
  ok("no RPC URL is embedded", !/https?:\/\/(?!raw\.|.*solscan)/.test(src.replace(/^ \*.*$/gm, "")));
  /* Every account this file names is either derived from the creator or a program id read
     off the wire. There is no operator-supplied address and no hardcoded destination: the
     money can only ever go to the creator that signed. */
  ok("the only destination is the signing creator itself",
    /destination: owner/.test(src) || /closeAccountIx\(\{ account: quoteAta, destination: owner, owner \}\)/.test(src));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-pumpfun-fees  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
