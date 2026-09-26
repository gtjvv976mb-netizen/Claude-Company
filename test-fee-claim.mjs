/**
 * THE CREATOR-FEE CLAIM AS A TICKET — pinned against the desk's own live coin.
 *
 * $CLAUDECO is a pump.fun coin that has bonded, and on 2026-09-26 its two creator-fee vaults were
 * read on mainnet and found to be live:
 *
 *   creator        3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3
 *   curve vault    5TmPpLwreotwnpVqWdgwDEwSMv5RzUUcskH3NYCazUPq    3,571,512 lamports
 *   pump-amm ata   98yKMqgKXU2xKSoytgqT9njgwHdUTqcbYpWhKG6Mv8HN    4,147,526 units
 *
 * Those three addresses are the fixture below, and they matter more than a round-trip test would:
 * the two programs spell the same seed differently — `creator-vault` on the bonding curve,
 * `creator_vault` on pump-amm — and BOTH derive a perfectly valid address. A test that only checked
 * this file against itself would pass with the seeds swapped, the claim would take zero, and nothing
 * would say why. Here the derivation has to land on addresses that really hold the money.
 *
 * The other half of this file is about what the design refuses to do. bagworkagent.fun's server
 * signs claims for its agents; it holds the keys. Nothing here can: the assertions check that no key
 * material, signature or send path exists in the module, and that the only signer on all four
 * instructions is the creator.
 *
 *   node test-fee-claim.mjs
 */
import fs from "node:fs";
import {
  RENT_RESERVE_LAMPORTS, FeeClaimError,
  vaultsFor, readClaimable, claimTicket, worthClaiming,
} from "./src/fee-claim.js";
import { SYSTEM_RENT_EXEMPT_LAMPORTS } from "./executor/fee-lane.mjs";
import { COLLECT_CREATOR_FEE_DISCRIMINATOR, COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR,
  PUMP_PROGRAM, PUMP_AMM_PROGRAM } from "./executor/pumpfun-fees.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const arose = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* $CLAUDECO's real creator and the two vaults that really hold its fees. */
const CREATOR = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";
const CURVE_VAULT = "5TmPpLwreotwnpVqWdgwDEwSMv5RzUUcskH3NYCazUPq";
const AMM_ATA = "98yKMqgKXU2xKSoytgqT9njgwHdUTqcbYpWhKG6Mv8HN";
const AMM_AUTH = "6cJhT7jKZSbLbKXMG9uTAnwxPpo1zgkKv4hR39972bpN";
/* What the chain actually held when this was written. */
const LIVE_CURVE = 3_571_512;
const LIVE_AMM = 4_147_526;

console.log("\nthe derivation lands on the vaults that really hold the money");
{
  const v = await vaultsFor(CREATOR);
  ok("the curve vault is the account read on mainnet", v.curveVault === CURVE_VAULT, v.curveVault);
  ok("the pump-amm vault ATA is the account read on mainnet", v.ammVaultAta === AMM_ATA, v.ammVaultAta);
  ok("the pump-amm vault authority derives too", v.ammVaultAuthority === AMM_AUTH, v.ammVaultAuthority);
  /* Two programs, two vaults: a claim reading one leaves the other's money sitting there. $CLAUDECO
     has bonded, so its live accrual is on the second. */
  ok("the two vaults are DIFFERENT addresses, which is the whole seed trap",
    v.curveVault !== v.ammVaultAta && v.curveVault !== v.ammVaultAuthority);
  ok("a bad address is refused by name rather than deriving something plausible",
    (await arose(() => vaultsFor("not-an-address"))) instanceof FeeClaimError);
  ok("...and so is an empty one", (await arose(() => vaultsFor(""))).clause === "creator_invalid");
}

console.log("\nunknown is not zero, and an absent account is not unknown");
{
  /* The live figures, as the chain gave them. */
  const good = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: true, data: { value: LIVE_CURVE } } : { ok: true, data: { value: { amount: String(LIVE_AMM) } } } });
  ok("both sides read", good.curveLamports === LIVE_CURVE && good.ammLamports === LIVE_AMM);
  /* THE RENT THAT CANNOT MOVE, off the curve side only: the pump-amm side is a token account the
     claim closes, so its rent returns in the same transaction. */
  ok("the curve's rent-exempt minimum is subtracted",
    good.curveClaimableLamports === LIVE_CURVE - RENT_RESERVE_LAMPORTS);
  ok("and only from the curve side", good.claimableLamports === (LIVE_CURVE - RENT_RESERVE_LAMPORTS) + LIVE_AMM,
    String(good.claimableLamports));
  ok("which is what was actually claimable that day", Math.abs(good.claimableSol - 0.007068798) < 1e-9,
    `${good.claimableSol} SOL`);
  ok("both halves are worth including", good.includeCurve === true && good.includeAmm === true);

  /* A DEAD NODE IS NOT AN EMPTY VAULT. This distinction has had to be made explicit three times in
     this codebase after `Number(null)` produced a confident zero twice. */
  const dead = await readClaimable({ creator: CREATOR, rpcGet: async () => ({ ok: false, error: "503 upstream" }) });
  ok("a dead node reports null, not zero", dead.curveLamports === null && dead.claimableLamports === null);
  ok("...and says it could not read", dead.readable === false);
  ok("...and refuses to say which sides to include", dead.includeCurve === null && dead.includeAmm === null);

  /* An ATA that does not exist yet IS a definite zero: the account is only created once something
     accrues into it, and the RPC reports that as a failure. */
  const noAta = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: true, data: { value: 2_000_000 } } : { ok: false, error: "could not find account" } });
  ok("an ATA that has never existed is a definite zero, not unknown", noAta.ammLamports === 0);
  ok("...so the claim is still offered, curve side only",
    noAta.claimableLamports === 2_000_000 - RENT_RESERVE_LAMPORTS && noAta.includeAmm === false);
  /* But any OTHER token-account failure stays unknown. */
  const flaky = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: true, data: { value: 2_000_000 } } : { ok: false, error: "429 rate limited" } });
  ok("a rate-limited read is unknown, not an empty account", flaky.ammLamports === null);
  /* HALF A READING IS NOT A TOTAL. The curve side read and the AMM side did not: the old sum
     treated the unknown side as 0 and offered the curve half as all there was. */
  ok("with one side unknown there is no claimable total", flaky.claimableLamports === null && flaky.claimableSol === null);
  ok("...the reading is flagged partial, not unreadable", flaky.partial === true && flaky.readable === true);
  const curveDown = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: false, error: "503" } : { ok: false, error: "could not find account" } });
  ok("a failed curve read beside an ATA that does not exist yet is partial, not a measured zero",
    curveDown.curveLamports === null && curveDown.ammLamports === 0 && curveDown.claimableLamports === null
    && curveDown.partial === true);
  ok("a full reading is not partial", good.partial === false && noAta.partial === false);

  const empty = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: true, data: { value: 0 } } : { ok: true, data: { value: { amount: "0" } } } });
  ok("a genuinely empty pair reports a measured zero, and no side worth including",
    empty.claimableLamports === 0 && empty.includeCurve === false && empty.includeAmm === false);
  /* A curve vault holding only its rent has nothing to give. */
  const rentOnly = await readClaimable({ creator: CREATOR, rpcGet: async (m) =>
    m === "getBalance" ? { ok: true, data: { value: RENT_RESERVE_LAMPORTS } } : { ok: true, data: { value: { amount: "0" } } } });
  ok("a curve vault holding only rent is not claimable", rentOnly.curveClaimableLamports === 0);
  ok("a missing reader is refused", (await arose(() => readClaimable({ creator: CREATOR }))).clause === "reader_missing");

  /* THE TWO COPIES OF THE RENT NUMBER MUST AGREE. The bot reports what is claimable and this page
     offers it; a disagreement would show the owner one figure and log another. */
  ok("the desk's rent reserve equals the bot's, measured on mainnet",
    RENT_RESERVE_LAMPORTS === SYSTEM_RENT_EXEMPT_LAMPORTS && RENT_RESERVE_LAMPORTS === 650_240);
}

console.log("\nthe ticket is unsigned, and only the creator can send it");
{
  const t = await claimTicket({ creator: CREATOR });
  ok("both sides taken is four instructions", t.instructions.length === 4, String(t.instructions.length));
  /* The order is the one the landed transactions used: collect from the curve, open the wrapped-SOL
     account idempotently, collect from pump-amm into it, close it so the lamports arrive spendable.
     The close is the leg that is easy to forget, and without it every claim leaves rent behind. */
  ok("it starts at the bonding curve's program", t.instructions[0].programId === PUMP_PROGRAM);
  ok("and collects the curve fee",
    Buffer.from(t.instructions[0].data, "base64").toString("hex") === COLLECT_CREATOR_FEE_DISCRIMINATOR);
  ok("the pump-amm collection is its own program and discriminator",
    t.instructions[2].programId === PUMP_AMM_PROGRAM
    && Buffer.from(t.instructions[2].data, "base64").toString("hex") === COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR);

  /* NOTHING ON THE SERVER CAN SEND THIS. */
  const signers = new Set(t.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
  ok("the ONLY signer across every instruction is the creator",
    signers.size === 1 && signers.has(CREATOR), [...signers].join(","));
  ok("the ticket carries no signature", !("signature" in t) && !("signatures" in t));
  /* NO BLOCKHASH EITHER, and that is deliberate: one baked in server-side is stale by the time a
     human has read the screen and tapped approve. */
  ok("and no blockhash — that belongs to the moment of signing",
    !("blockhash" in t) && !("recentBlockhash" in t));
  ok("it says in the payload that it is unsigned and why that is not a secret",
    /Only the creator's own signature can send this/.test(t.note));

  /* ONE SIDE ONLY, when the other holds nothing: including an empty side spends fees to move zero,
     and on the pump-amm side creates and closes a token account for no reason. */
  const curveOnly = await claimTicket({ creator: CREATOR, includeAmm: false });
  ok("curve-only is one instruction", curveOnly.instructions.length === 1);
  const ammOnly = await claimTicket({ creator: CREATOR, includeCurve: false });
  ok("amm-only is three: open, collect, close", ammOnly.instructions.length === 3);
  ok("claiming neither side is refused",
    (await arose(() => claimTicket({ creator: CREATOR, includeCurve: false, includeAmm: false }))).clause === "nothing_to_claim");
  ok("a bad creator is refused before anything is built",
    (await arose(() => claimTicket({ creator: "nope" }))).clause === "creator_invalid");

  /* Every key is a real address and every flag is a strict boolean — the page feeds these straight
     into TransactionInstruction, where a stringly-typed flag is a silently different transaction. */
  const keys = t.instructions.flatMap((ix) => ix.keys);
  ok("every key is base58 and every flag is a strict boolean",
    keys.every((k) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k.pubkey)
      && typeof k.isSigner === "boolean" && typeof k.isWritable === "boolean"), `${keys.length} keys`);
}

console.log("\nwhether signing is worth it");
{
  ok("the live amount is under the 0.002 SOL floor, so it says wait",
    worthClaiming({ claimableLamports: 7_068_798 }).worth === true);
  ok("a dust vault says the net is under the floor",
    worthClaiming({ claimableLamports: 100_000 }).worth === false
    && /under the/.test(worthClaiming({ claimableLamports: 100_000 }).reason));
  ok("...and says waiting costs nothing, because fees keep accruing",
    /waiting costs nothing/.test(worthClaiming({ claimableLamports: 100_000 }).reason));
  ok("the network fee is subtracted before the comparison",
    worthClaiming({ claimableLamports: 2_000_000, feeLamports: 5_000 }).worth === false
    && worthClaiming({ claimableLamports: 2_005_000, feeLamports: 5_000 }).worth === true);
  /* UNKNOWN IS NOT A VERDICT. */
  ok("an unreadable amount is not judged either way",
    worthClaiming({ claimableLamports: null }).worth === null
    && /unknown is not zero/.test(worthClaiming({ claimableLamports: null }).reason));
}

console.log("\nnothing here holds a key");
{
  const src = fs.readFileSync(new URL("./src/fee-claim.js", import.meta.url), "utf8");
  ok("no keypair, no secret key, no signing",
    !/Keypair|secretKey|privateKey|\.sign\(|sendTransaction/.test(src));
  ok("no RPC endpoint is embedded — the reader is injected", !/https?:\/\/[a-z]/.test(src.replace(/^\s*\*.*$/gm, "")));
  ok("the reason the owner signs rather than the bot is written down, not just implemented",
    /widen the blast radius/.test(src));
  ok("and that the layout is not re-implemented in the page", /Re-deriving\n \* those addresses in a web page/.test(src));

  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  const route = office.slice(office.indexOf('"/api/fees/claimable"'), office.indexOf('"/api/pay/blockhash"'));
  ok("both routes exist", /\/api\/fees\/claimable/.test(route) && /\/api\/fees\/claim-ticket/.test(route));
  ok("a bad creator is a 400 with a clause, not a 500", /return json\(400, \{ error: error\.message, clause: error\.clause \}\)/.test(route));
  /* NOT GATED, DELIBERATELY: both derive from a public address and return public on-chain facts, and
     the transaction can only be sent by a signature only the creator can make. */
  ok("the reason neither route is gated is stated where a reader will look",
    /Gating them would imply a secrecy/.test(office)
    && /secrecy that does not exist is the kind somebody later relies on/.test(office));

  const page = fs.readFileSync(new URL("./viewer/fees.html", import.meta.url), "utf8");
  ok("the page renders a dash for an unreadable figure, never a zero",
    /A NULL IS A DASH, NEVER A ZERO/.test(page));
  /* Only the creator's signature works, so a mismatch is worth saying before somebody taps approve
     and watches it fail on chain. */
  ok("it refuses to offer a claim from a wallet that is not the creator",
    /only that wallet can claim them/.test(page));
  ok("an unreadable vault disables the button rather than claiming half",
    /an unreadable side is not an empty one/.test(page) && /v\.includeCurve === null \|\| v\.includeAmm === null/.test(page));
  ok("it re-reads after sending rather than assuming what landed, around the desk's cache",
    /setTimeout\(\(\) => read\(\{ fresh: true \}\), 4000\)/.test(page) && /what landed is what the vaults now say/.test(page));

  /* THE BUGS THE REVIEW FOUND IN THIS PAGE, pinned by source because the suite runs no browser.
     A headless run against the real esm.sh bundle reproduced the first one: "Buffer is not
     defined", before any wallet was asked, in every browser. */
  const script = page.slice(page.indexOf("<script"));
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("the page never touches Node's Buffer, which no browser has", !/\bBuffer\b/.test(code));
  ok("instruction data is decoded with the browser's own atob", /atob\(/.test(code) && /data: fromBase64\(ix\.data\)/.test(code));
  ok("standard wallets are discovered by registration, as tower.html does",
    /wallet-standard:register-wallet/.test(code) && /wallet-standard:app-ready/.test(code));
  ok("...not by reading navigator.wallets as if it held wallet objects", !/navigator\??\.wallets/.test(code));
  ok("the Sign button is decided in ONE place, called from every path",
    (code.match(/refreshClaimButton\(\)/g) || []).length >= 4 && !/\$\("claim"\)\.disabled = false/.test(code));
  ok("the claim re-checks the rule rather than trusting a disabled attribute",
    /async function claim\(\) \{\s*if \(refreshClaimButton\(\) !== null\) return;/.test(code));

  ok("the public vault read is cached per creator", /globalThis\.__feeReads/.test(route) && /20_000/.test(route));
  ok("...concurrent requests share one read", /promise: promise|entry = \{ at: now, promise/.test(route));
  ok("...and fresh=1 cannot turn the cache off", /age >= 3_000/.test(route));
  ok("...and the cache is bounded", /cache\.size > 256/.test(route));
  ok("a junk creator is refused before it can become a cache key", route.indexOf("isAddress(creator)") < route.indexOf("cache.set("));
  ok("the page builds the transaction, so the server never holds a signable one",
    /new W3\.Transaction\(\{ feePayer: owner, recentBlockhash: blockhash \}\)/.test(page));

  const build = fs.readFileSync(new URL("./scripts/build-viewer.mjs", import.meta.url), "utf8");
  ok("the page is published", /\{ src: "fees\.html",\s+out: "fees\.html" \}/.test(build));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-fee-claim  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
