/**
 * RECLAIM-RENT — the selection rules, driven rather than read.
 *
 * The owner's burner had 82 empty token accounts holding about 0.13 SOL of rent it
 * could not spend. Closing an empty account returns that rent; closing the wrong one
 * would be a different kind of day. So the two things this file has to pin are what
 * gets closed and what does not:
 *
 *   · AN ACCOUNT THAT STILL HOLDS A BALANCE IS NEVER INCLUDED. The SPL Token program
 *     refuses this on chain regardless — that refusal, not this code, is what makes
 *     the tool safe — but building the instruction at all would burn a fee and take
 *     every other close in its batch down with it.
 *   · A MINT WITH AN INTENT IN FLIGHT IS NEVER INCLUDED. An account that reads empty
 *     because the buy has not landed yet is indistinguishable from one that is empty
 *     because the position closed, and only the journal knows which.
 *   · WRAPPED SOL IS NEVER INCLUDED. The swap path opens and closes its own WSOL
 *     account inside a trade; that is the one account where interfering mid-flight
 *     costs real money rather than a rejected transaction.
 *
 * And the instruction itself is asserted byte for byte, because CloseAccount is one
 * opcode and three accounts in a fixed order — a silent transposition of `account`
 * and `destination` is a valid transaction that does the wrong thing.
 *
 *   node test-reclaim-rent.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import { chunk, closeAccountInstruction, inFlightMints, selectClosable } from "./reclaim-rent.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./token2022.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const WSOL = "So11111111111111111111111111111111111111112";
const RENT = 2039280;
const acct = (pubkey, mint, amount, extra = {}) => ({
  pubkey, programId: TOKEN_PROGRAM,
  account: { lamports: RENT, data: { parsed: { info: { mint, tokenAmount: { amount }, ...extra } } } },
});

console.log("\nwhat gets closed");
{
  const { closable, skipped } = selectClosable([
    acct("A", "mint-a", "0"),
    acct("B", "mint-b", "0"),
  ]);
  ok("an empty account with rent in it is closable", closable.length === 2 && skipped.length === 0);
  ok("...and it carries the program that owns it, so Token-2022 closes through its own program",
    closable.every((c) => c.programId === TOKEN_PROGRAM));
  const t22 = selectClosable([{ ...acct("C", "mint-c", "0"), programId: TOKEN_2022_PROGRAM }]);
  ok("a Token-2022 account closes through Token-2022",
    t22.closable[0]?.programId === TOKEN_2022_PROGRAM);
}

console.log("\nwhat is left alone, and why");
{
  const { closable, skipped } = selectClosable([
    acct("HOLD", "mint-held", "1"),
    acct("DUST", "mint-dust", "1"),
    acct("WSOL", WSOL, "0"),
    acct("NATIVE", "mint-native", "0", { isNative: true }),
    acct("FINE", "mint-fine", "0"),
  ]);
  ok("only the empty non-native account survives the filter",
    closable.length === 1 && closable[0].pubkey === "FINE",
    closable.map((c) => c.pubkey).join(",") || "none");
  const why = Object.fromEntries(skipped.map((s) => [s.pubkey, s.reason]));
  /* ONE UNIT IS A BALANCE. A "dust" threshold here would be a tool that silently
     burns the tail of a position, and there is no amount of dust worth that. */
  ok("a single raw unit still counts as held", /holds 1/.test(why.DUST || ""));
  ok("a position is left alone and the reason says what it holds", /holds 1/.test(why.HOLD || ""));
  ok("wrapped SOL is named as the swap path's own", /wrapped SOL/i.test(why.WSOL || ""));
  ok("...and so is anything flagged native, whatever its mint reads as",
    /wrapped SOL/i.test(why.NATIVE || ""));
}
{
  const { closable, skipped } = selectClosable([acct("X", "mint-inflight", "0"), acct("Y", "mint-idle", "0")],
    { inFlight: new Set(["mint-inflight"]) });
  ok("a mint with an intent in flight is never closed under it",
    closable.length === 1 && closable[0].pubkey === "Y");
  ok("...and says so by name", /in flight/.test(skipped[0]?.reason || ""));
}
{
  const { closable, skipped } = selectClosable([acct("Z", "mint-z", "0")].map(
    (a) => ({ ...a, account: { ...a.account, lamports: 0 } })));
  ok("an account with no rent in it is not worth a fee", closable.length === 0 &&
    /no rent/.test(skipped[0]?.reason || ""));
}
{
  const many = Array.from({ length: 10 }, (_, i) => acct(`P${i}`, `mint-${i}`, "0"));
  const { closable, skipped } = selectClosable(many, { max: 4 });
  ok("--max is a hard stop, and the rest are reported rather than dropped",
    closable.length === 4 && skipped.length === 6 && skipped.every((s) => /--max/.test(s.reason)));
}
{
  const { closable, skipped } = selectClosable([
    { pubkey: "BAD", account: { lamports: RENT, data: {} } },
    { account: { lamports: RENT, data: { parsed: { info: { mint: "m", tokenAmount: { amount: "0" } } } } } },
  ]);
  ok("an account it cannot read is refused, never guessed at",
    closable.length === 0 && skipped.length === 2 &&
    skipped.every((s) => /unreadable/.test(s.reason)));
}

console.log("\nthe in-flight set comes from the journal's own states");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-rent-"));
  const db = new DatabaseSync(path.join(dir, "j.sqlite"));
  db.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, kind TEXT, mint TEXT, state TEXT)");
  const add = (id, mint, state) =>
    db.prepare("INSERT INTO intents (id,kind,mint,state) VALUES (?,?,?,?)").run(id, "entry", mint, state);
  add("1", "m-signed", "signed");
  add("2", "m-submitted", "submitted");
  add("3", "m-confirmed", "confirmed");
  add("4", "m-ambiguous", "ambiguous");
  add("5", "m-planned", "planned");
  add("6", "m-accounted", "accounted");
  add("7", "m-failed", "failed");
  add("8", null, "signed");
  const set = inFlightMints(db);
  ok("every state where bytes may already be on the wire is in flight",
    ["m-signed", "m-submitted", "m-confirmed", "m-ambiguous"].every((m) => set.has(m)));
  /* `planned` has signed nothing and `accounted`/`failed` are over. Treating those as
     in flight would make the tool useless on exactly the wallet it is for: every mint
     the bot ever touched is `accounted`. */
  ok("a finished or unsigned intent does not pin an account for ever",
    !set.has("m-planned") && !set.has("m-accounted") && !set.has("m-failed"));
  ok("an intent with no mint cannot poison the set", !set.has("null") && set.size === 4,
    [...set].join(","));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nthe instruction, byte for byte");
{
  const account = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  const ix = closeAccountInstruction({ programId: TOKEN_PROGRAM, account, destination: owner, owner });
  ok("it is SPL Token's CloseAccount, opcode 9, and carries nothing else",
    ix.data.length === 1 && ix.data[0] === 9, [...ix.data].join(","));
  ok("it is addressed to the program that owns the account",
    ix.programId.toBase58() === TOKEN_PROGRAM);
  /* ORDER IS THE WHOLE INSTRUCTION. Swap keys 0 and 1 and you have a valid transaction
     that tries to close the wallet. */
  ok("account, then destination, then the signing owner — in that order",
    ix.keys.length === 3 &&
    ix.keys[0].pubkey.toBase58() === account && ix.keys[0].isWritable && !ix.keys[0].isSigner &&
    ix.keys[1].pubkey.toBase58() === owner && ix.keys[1].isWritable && !ix.keys[1].isSigner &&
    ix.keys[2].pubkey.toBase58() === owner && ix.keys[2].isSigner && !ix.keys[2].isWritable);
  ok("the rent can only ever go back to the wallet that owns the account",
    ix.keys[1].pubkey.toBase58() === ix.keys[2].pubkey.toBase58());
}

console.log("\nbatching");
{
  ok("a batch never exceeds its size", chunk([1, 2, 3, 4, 5, 6, 7], 3)
    .every((g) => g.length <= 3));
  ok("...and nothing is lost between batches",
    chunk([1, 2, 3, 4, 5, 6, 7], 3).flat().join(",") === "1,2,3,4,5,6,7");
  ok("an empty list makes no batches", chunk([], 12).length === 0);
}

console.log("\nthe tool itself");
{
  const source = fs.readFileSync(new URL("./reclaim-rent.mjs", import.meta.url), "utf8");
  /* IT SIGNS ONE KIND OF INSTRUCTION. A maintenance tool that can also transfer is a
     maintenance tool that can also be wrong about where. Checked structurally rather
     than by looking for words: the prose in this file legitimately says "swap path". */
  for (const forbidden of ["SystemProgram", "createTransferInstruction", "jupiter.mjs", "snipe-execute.mjs"])
    ok(`it has no path that can reach ${forbidden}`, !source.includes(forbidden));
  const built = [...source.matchAll(/new TransactionInstruction\(/g)].length;
  ok("it builds exactly one instruction of its own, and that one is CloseAccount",
    built === 1 && /data: Buffer\.from\(\[CLOSE_ACCOUNT_IX\]\)/.test(source), `${built} built`);
  ok("...the only other thing it adds to a transaction is a compute budget",
    [...source.matchAll(/tx\.add\(/g)].length === 2 &&
    /tx\.add\(ComputeBudgetProgram\.setComputeUnitLimit/.test(source) &&
    /tx\.add\(closeAccountInstruction\(/.test(source));
  ok("looking is the default; sending takes a flag", /const SEND = flag\("--send"\)/.test(source) &&
    /if \(!SEND\)/.test(source));
  ok("it refuses a keypair any other account can read",
    /\(st\.mode & 0o077\) !== 0/.test(source));
  ok("an unreadable journal is reported, not silently treated as 'nothing in flight'",
    /the in-flight guard was NOT applied/.test(source));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-reclaim-rent  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
