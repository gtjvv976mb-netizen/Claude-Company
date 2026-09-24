// Token-2022 mint audit: the executor accepts a Token-2022 mint only when its extension
// list cannot tax, block, redirect, freeze, pause or re-denominate a transfer, and both
// RPC providers return byte-identical mint data. Everything else fails closed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ALLOWED_MINT_EXTENSIONS, EXTENSION_NAMES, MINT_CONSENSUS_FIELDS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
  auditMintAccount, describeMint, parseMintExtensions, token2022Enabled,
} from "./token2022.mjs";
import {
  associatedTokenAddress, independentClassicMintDecimals, independentMintProgram, mintTokenProgram,
  walletTokenAmount,
} from "./jupiter.mjs";

let passed = 0;
let failed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failed++; console.log(`FAIL - ${name}\n    ${error.message}`); }
};

const MINT = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const key = () => Keypair.generate().publicKey;

const baseMint = ({ decimals = 6, initialized = true, mintAuthority = null, freezeAuthority = null } = {}) => {
  const data = Buffer.alloc(82);
  if (mintAuthority) { data.writeUInt32LE(1, 0); mintAuthority.toBuffer().copy(data, 4); }
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  if (freezeAuthority) { data.writeUInt32LE(1, 46); freezeAuthority.toBuffer().copy(data, 50); }
  return data;
};
const entry = (type, value, declaredLength = value.length) => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(declaredLength, 2);
  return Buffer.concat([header, value]);
};
const PUMP_STYLE = [[18, Buffer.alloc(64, 1)], [19, Buffer.alloc(187, 2)]];
const token2022Mint = (opts = {}, entries = PUMP_STYLE,
  { accountType = 1, padByte = 0, trailer = Buffer.alloc(0) } = {}) => ({
  owner: new PublicKey(TOKEN_2022_PROGRAM),
  data: Buffer.concat([baseMint(opts), Buffer.alloc(83, padByte), Buffer.from([accountType]),
    ...entries.map((e) => Buffer.isBuffer(e) ? e : entry(e[0], e[1])), trailer]),
});
const classicMint = (opts = {}) => ({ owner: new PublicKey(TOKEN_PROGRAM), data: baseMint(opts) });
const connection = (value, rejection = null) => ({
  async getAccountInfo() { if (rejection) throw rejection; return value; },
});

await ok("a pump.fun-style Token-2022 mint (MetadataPointer + TokenMetadata) is accepted", async () => {
  const audit = auditMintAccount(token2022Mint(), MINT);
  assert.equal(audit.program, TOKEN_2022_PROGRAM);
  assert.equal(audit.decimals, 6);
  assert.equal(audit.extensions, "18,19");
  assert.deepEqual(audit.extensionNames, ["MetadataPointer", "TokenMetadata"]);
  assert.equal(audit.freezeAuthority, null);
  assert.equal(audit.mintAuthority, null);
  assert.equal(audit.dataLength, 166 + 4 + 64 + 4 + 187);
  assert.match(audit.dataHash, /^[0-9a-f]{64}$/);
});

await ok("classic SPL mints keep the exact 82-byte rule", async () => {
  const audit = auditMintAccount(classicMint({ decimals: 9 }), MINT);
  assert.equal(audit.program, TOKEN_PROGRAM);
  assert.equal(audit.decimals, 9);
  assert.equal(audit.extensions, "");
  assert.throws(() => auditMintAccount({ owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(83) }, MINT),
    /classic SPL mint layout/);
  assert.throws(() => auditMintAccount({ owner: PublicKey.default, data: baseMint() }, MINT),
    /not owned by classic SPL Token/);
  assert.throws(() => auditMintAccount(null, MINT), /mint account is unavailable/);
});

await ok("every extension that can interfere with a transfer is refused by name", async () => {
  const refused = {
    1: "TransferFeeConfig", 4: "ConfidentialTransferMint", 9: "NonTransferable",
    10: "InterestBearingConfig", 12: "PermanentDelegate", 14: "TransferHook",
    16: "ConfidentialTransferFeeConfig", 24: "ConfidentialMintBurn", 25: "ScaledUiAmount", 26: "Pausable",
  };
  for (const [type, name] of Object.entries(refused)) {
    assert.ok(!ALLOWED_MINT_EXTENSIONS.has(Number(type)), `${name} must not be allowed`);
    assert.throws(() => auditMintAccount(token2022Mint({}, [...PUMP_STYLE, [Number(type), Buffer.alloc(40)]]), MINT),
      new RegExp(`Token-2022 extension ${name} is refused`), name);
  }
  // Every allowed type is a descriptive extension listed in the enum.
  for (const type of ALLOWED_MINT_EXTENSIONS) assert.ok(EXTENSION_NAMES[type], `type ${type} named`);
});

await ok("DefaultAccountState is accepted only when new accounts open initialized", async () => {
  assert.equal(auditMintAccount(token2022Mint({}, [...PUMP_STYLE, [6, Buffer.from([1])]]), MINT).extensions, "18,19,6");
  assert.throws(() => auditMintAccount(token2022Mint({}, [...PUMP_STYLE, [6, Buffer.from([2])]]), MINT),
    /opens new token accounts frozen \(default state 2\)/);
  assert.throws(() => auditMintAccount(token2022Mint({}, [...PUMP_STYLE, [6, Buffer.from([1, 0])]]), MINT),
    /opens new token accounts frozen/);
});

await ok("a live freeze authority on a Token-2022 mint is refused; a mint authority is tolerated", async () => {
  const freezer = key();
  assert.throws(() => auditMintAccount(token2022Mint({ freezeAuthority: freezer }), MINT),
    new RegExp(`freeze authority ${freezer.toBase58()} could brick the exit`));
  const minter = key();
  const audit = auditMintAccount(token2022Mint({ mintAuthority: minter }), MINT);
  assert.equal(audit.mintAuthority, minter.toBase58());
  // Classic mints are unchanged: a freeze authority there was never a refusal.
  assert.equal(auditMintAccount(classicMint({ freezeAuthority: freezer }), MINT).freezeAuthority, freezer.toBase58());
});

await ok("malformed extension layouts fail closed", async () => {
  const cases = [
    ["unknown type", token2022Mint({}, [...PUMP_STYLE, [40, Buffer.alloc(8)]]), /unknown extension type 40/],
    ["repeated entry", token2022Mint({}, [...PUMP_STYLE, [18, Buffer.alloc(64)]]), /repeats extension MetadataPointer/],
    ["value overrun", token2022Mint({}, [[18, Buffer.alloc(64)], entry(19, Buffer.alloc(10), 500)]), /TokenMetadata overruns the account/],
    ["account type is a token account", token2022Mint({}, PUMP_STYLE, { accountType: 2 }), /account type 2 is not a mint/],
    ["non-zero padding", token2022Mint({}, PUMP_STYLE, { padByte: 1 }), /padding is not zero/],
    ["bytes after the terminator", token2022Mint({}, PUMP_STYLE, { trailer: Buffer.from([0, 0, 0, 0, 9]) }), /after the extension terminator/],
    ["trailing fragment", token2022Mint({}, PUMP_STYLE, { trailer: Buffer.from([1, 2, 3]) }), /trailing bytes after the extension list/],
    ["between 82 and 166 bytes", { owner: new PublicKey(TOKEN_2022_PROGRAM), data: Buffer.concat([baseMint(), Buffer.alloc(20)]) }, /invalid extension layout \(102 bytes\)/],
    ["uninitialized", token2022Mint({ initialized: false }), /is not initialized/],
    ["19 decimals", token2022Mint({ decimals: 19 }), /outside the live canary range/],
  ];
  for (const [label, account, pattern] of cases)
    assert.throws(() => auditMintAccount(account, MINT), pattern, label);
  // Zero-filled trailers are what the program itself leaves behind; they are fine.
  assert.equal(auditMintAccount(token2022Mint({}, PUMP_STYLE, { trailer: Buffer.alloc(3) }), MINT).extensions, "18,19");
  assert.equal(auditMintAccount(token2022Mint({}, PUMP_STYLE, { trailer: Buffer.alloc(8) }), MINT).extensions, "18,19");
  // A Token-2022 mint without any extension is exactly the 82-byte base layout.
  assert.equal(auditMintAccount({ owner: new PublicKey(TOKEN_2022_PROGRAM), data: baseMint() }, MINT).extensions, "");
  assert.deepEqual(parseMintExtensions(baseMint()), []);
});

await ok("CC_TOKEN_2022=0 is an entry switch and never blocks reading a held mint", async () => {
  assert.equal(token2022Enabled({}), true);
  assert.equal(token2022Enabled({ CC_TOKEN_2022: "1" }), true);
  assert.equal(token2022Enabled({ CC_TOKEN_2022: "0" }), false);
  // The audit itself must stay readable whatever the switch says: refusing to parse a
  // mint the wallet already holds would strand that position's balance check and stop.
  const previous = process.env.CC_TOKEN_2022;
  process.env.CC_TOKEN_2022 = "0";
  try {
    assert.equal(auditMintAccount(token2022Mint(), MINT).program, TOKEN_2022_PROGRAM);
    assert.equal(await mintTokenProgram(connection(token2022Mint()), MINT), TOKEN_2022_PROGRAM);
    assert.equal(await independentMintProgram(connection(token2022Mint()),
      connection(token2022Mint()), MINT), TOKEN_2022_PROGRAM);
  } finally {
    if (previous === undefined) delete process.env.CC_TOKEN_2022; else process.env.CC_TOKEN_2022 = previous;
  }
  // A caller that genuinely wants classic-only still gets it.
  assert.throws(() => auditMintAccount(token2022Mint(), MINT, { allowToken2022: false }),
    /uses Token-2022 and this caller accepts classic SPL Token only/);
  assert.equal(auditMintAccount(classicMint(), MINT, { allowToken2022: false }).program, TOKEN_PROGRAM);
  // The switch is enforced on the poller's entry path, against the audited program.
  const poller = fs.readFileSync(here + "poller.mjs", "utf8");
  assert.match(poller, /if \(!token2022Enabled\(\) && \(await mintProgramFor\(ev\.mint\)\) === TOKEN_2022_PROGRAM\)/);
});

await ok("two RPC views must agree byte-for-byte before a Token-2022 entry is priced", async () => {
  assert.ok(MINT_CONSENSUS_FIELDS.includes("dataHash") && MINT_CONSENSUS_FIELDS.at(-1) === "dataHash");
  assert.equal(await independentClassicMintDecimals(connection(token2022Mint()), connection(token2022Mint()), MINT), 6);
  assert.equal(await independentMintProgram(connection(token2022Mint()), connection(token2022Mint()), MINT), TOKEN_2022_PROGRAM);
  assert.equal(await independentMintProgram(connection(classicMint()), connection(classicMint()), MINT), TOKEN_PROGRAM);
  const altered = token2022Mint();
  altered.data[170] ^= 1; // one byte inside MetadataPointer's value
  await assert.rejects(() => independentClassicMintDecimals(connection(token2022Mint()), connection(altered), MINT),
    /disagree on dataHash/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(token2022Mint()), connection(token2022Mint({}, [[18, Buffer.alloc(64, 1)]])), MINT),
  /disagree on dataLength/);
  await assert.rejects(() => independentClassicMintDecimals(connection(token2022Mint()), connection(classicMint()), MINT),
    /disagree on owner/);
  await assert.rejects(() => independentClassicMintDecimals(
    connection(token2022Mint()), connection(token2022Mint({}, [...PUMP_STYLE, [1, Buffer.alloc(40)]])), MINT),
  /rejected an RPC view: .*TransferFeeConfig is refused/);
});

await ok("the digest ignores the two things honest providers legitimately disagree about", async () => {
  /* A bonding-curve mint's supply moves every few seconds and metadata can be edited at
   * any time. Hashing either makes two healthy RPC reads one slot apart refuse the call,
   * which on the entry path throws the trade away. Neither can change a safety decision;
   * everything that can, still must match. */
  const movedSupply = token2022Mint();
  movedSupply.data.writeBigUInt64LE(999_999_999_999n, 36);
  assert.notEqual(movedSupply.data.compare(token2022Mint().data), 0, "the fixture must actually differ");
  assert.equal(await independentClassicMintDecimals(connection(token2022Mint()), connection(movedSupply), MINT), 6);

  const editedMetadata = token2022Mint({}, [[18, Buffer.alloc(64, 1)], [19, Buffer.alloc(187, 9)]]);
  assert.equal(await independentClassicMintDecimals(connection(token2022Mint()), connection(editedMetadata), MINT), 6);
  // A metadata entry of a DIFFERENT length is still a different account length, which is
  // compared on its own, so a renamed token is refused for that tick and retried later.
  await assert.rejects(() => independentClassicMintDecimals(connection(token2022Mint()),
    connection(token2022Mint({}, [[18, Buffer.alloc(64, 1)], [19, Buffer.alloc(120, 2)]])), MINT),
  /disagree on dataLength/);

  // Every other extension's bytes are still covered, including a value we act on.
  const frozenDefault = token2022Mint({}, [...PUMP_STYLE, [6, Buffer.from([1])]]);
  const frozenAltered = token2022Mint({}, [...PUMP_STYLE, [6, Buffer.from([1])]]);
  frozenAltered.data[frozenAltered.data.length - 1] = 1;
  assert.equal(auditMintAccount(frozenDefault, MINT).dataHash, auditMintAccount(frozenAltered, MINT).dataHash);
  const classicMoved = classicMint();
  classicMoved.data.writeBigUInt64LE(7n, 36);
  assert.equal(auditMintAccount(classicMoved, MINT).dataHash, auditMintAccount(classicMint(), MINT).dataHash);
  const classicReDecimalled = classicMint({ decimals: 9 });
  assert.notEqual(auditMintAccount(classicReDecimalled, MINT).dataHash, auditMintAccount(classicMint(), MINT).dataHash);
});

await ok("mintTokenProgram answers from the same audit", async () => {
  assert.equal(await mintTokenProgram(connection(token2022Mint()), MINT), TOKEN_2022_PROGRAM);
  assert.equal(await mintTokenProgram(connection(classicMint()), MINT), TOKEN_PROGRAM);
  await assert.rejects(() => mintTokenProgram(connection(token2022Mint({}, [...PUMP_STYLE, [14, Buffer.alloc(64)]])), MINT),
    /TransferHook is refused/);
});

await ok("wallet custody checks work for a Token-2022 token account (ImmutableOwner, 170 bytes)", async () => {
  const account = (program, { amount = 5_000_000n, state = 1 } = {}) => {
    const data = Buffer.alloc(program === TOKEN_2022_PROGRAM ? 170 : 165);
    new PublicKey(MINT).toBuffer().copy(data, 0);
    new PublicKey(WALLET).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = state;
    if (program === TOKEN_2022_PROGRAM) { data[165] = 2; data.writeUInt16LE(7, 166); data.writeUInt16LE(0, 168); }
    return { owner: new PublicKey(program), data };
  };
  assert.equal(walletTokenAmount(account(TOKEN_2022_PROGRAM), { program: TOKEN_2022_PROGRAM, mint: MINT, wallet: WALLET }), 5_000_000n);
  // A token account opened directly under Token-2022 carries no extensions and is exactly
  // 165 bytes. If the capability scan cannot classify it, it cannot tell that such an
  // account is the wallet's own, and a route could make it writable unnoticed.
  const bare = account(TOKEN_2022_PROGRAM);
  bare.data = bare.data.subarray(0, 165);
  assert.equal(walletTokenAmount(bare, { program: TOKEN_2022_PROGRAM, mint: MINT, wallet: WALLET }), 5_000_000n);
  assert.equal(walletTokenAmount(account(TOKEN_PROGRAM), { program: TOKEN_PROGRAM, mint: MINT, wallet: WALLET }), 5_000_000n);
  assert.throws(() => walletTokenAmount(account(TOKEN_2022_PROGRAM), { program: TOKEN_PROGRAM, mint: MINT, wallet: WALLET }),
    /not the wallet's expected token account/);
  assert.throws(() => walletTokenAmount(account(TOKEN_2022_PROGRAM, { state: 2 }), { program: TOKEN_2022_PROGRAM, mint: MINT, wallet: WALLET }),
    /not initialized and unfrozen/);
  assert.throws(() => walletTokenAmount(account(TOKEN_PROGRAM), { program: "11111111111111111111111111111111", mint: MINT, wallet: WALLET }),
    /is not a token program/);
  assert.equal(walletTokenAmount(null, { program: TOKEN_2022_PROGRAM, mint: MINT, wallet: WALLET, allowMissing: true }), 0n);
  assert.notEqual(associatedTokenAddress(WALLET, MINT, TOKEN_2022_PROGRAM), associatedTokenAddress(WALLET, MINT, TOKEN_PROGRAM));
});

/* Quote mints. A pump.fun curve can be quoted in an xStock; the wallet PAYS with that
 * mint and never holds it as a position, so it is described, never judged. The fixture
 * is the real bytes of three xStock mints plus a live curve quoted in GLDx. */
const XSTOCK = JSON.parse(fs.readFileSync(here + "fixtures/pumpfun-xstock-quote.json", "utf8"));
const fixtureAccount = (address) => {
  const row = XSTOCK.accounts.find((a) => a.address === address);
  return { owner: row.owner, data: Buffer.from(row.data[0], "base64") }; // a fresh copy each call
};
const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const XSTOCK_DELEGATE = "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq";
const XSTOCK_PAUSER = "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs";
const XSTOCK_EXTENSIONS = ["MetadataPointer", "PermanentDelegate", "DefaultAccountState", "ScaledUiAmount",
  "Pausable", "ConfidentialTransferMint", "TransferHook", "TokenMetadata"];

await ok("the xStock quote fixture is the live bytes it claims to be", async () => {
  assert.ok(Number.isInteger(XSTOCK.slot) && XSTOCK.slot > 0);
  assert.deepEqual(XSTOCK.rentExemptLamports, { 165: 1488440, 170: 1513840, 179: 1559560 });
  const sizes = Object.fromEntries(XSTOCK.accounts.map((a) => [a.address, Buffer.from(a.data[0], "base64").length]));
  assert.deepEqual(sizes, {
    [GLDX]: 675, [TSLAX]: 678, [SPYX]: 676,
    JXJC7sJa235q7GbFjsQ9oorm6wHForQ8MZJoF1MedDP: 151, // the curve, quoted in GLDx
    "4oYp7TZ1tBrvHHfMTA8oVYATbVVfiE19vRTfbRvPd5EL": 179, // its GLDx vault: 165 + type + ImmutableOwner + TransferHookAccount + PausableAccount
  });
  for (const a of XSTOCK.accounts)
    assert.equal(a.owner, a.address.startsWith("JXJC") ? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" : TOKEN_2022_PROGRAM, a.address);
});

await ok("describeMint reads the live xStock quote mints that the audit refuses", async () => {
  for (const [address, symbol, name, multiplier] of [
    [GLDX, "GLDx", "Gold xStock", 1], [TSLAX, "TSLAx", "Tesla xStock", 1], [SPYX, "SPYx", "SP500 xStock", 1.003909240011759],
  ]) {
    const described = describeMint(fixtureAccount(address), address);
    assert.ok(Object.isFrozen(described));
    assert.equal(described.mint, address);
    assert.equal(described.program, TOKEN_2022_PROGRAM);
    assert.equal(described.decimals, 8);
    assert.equal(described.initialized, true);
    assert.equal(described.mintAuthority, "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj");
    assert.equal(described.freezeAuthority, XSTOCK_PAUSER);
    assert.deepEqual(described.extensionNames, XSTOCK_EXTENSIONS);
    assert.equal(described.paused, false, `${symbol} is not paused`);
    assert.equal(described.pausableAuthority, XSTOCK_PAUSER);
    assert.equal(described.transferHookProgram, null, `${symbol}'s hook is the zero program`);
    assert.equal(described.permanentDelegate, XSTOCK_DELEGATE);
    assert.equal(described.defaultAccountState, 1);
    assert.equal(described.metadataName, name);
    assert.equal(described.metadataSymbol, symbol);
    assert.ok(Math.abs(described.scaledUiMultiplier - multiplier) < 1e-12, `${symbol} multiplier ${described.scaledUiMultiplier}`);
  }
});

await ok("a paused xStock reads paused; the audit still refuses the same bytes", async () => {
  const flipped = fixtureAccount(GLDX);
  const pausable = parseMintExtensions(flipped.data).find((ext) => ext.type === 26);
  assert.equal(pausable.length, 33);
  pausable.value[32] = 1; // the subarray shares the copy's memory
  assert.equal(describeMint(flipped, GLDX).paused, true);
  assert.equal(describeMint(fixtureAccount(GLDX), GLDX).paused, false, "the fixture itself is untouched");
  // The point of describeMint: the SAME bytes are a kill for a base mint. Pin that the
  // audit keeps refusing them so nobody widens the kill set by routing a base mint here.
  assert.throws(() => auditMintAccount(fixtureAccount(GLDX), GLDX), /Token-2022 extension PermanentDelegate is refused/);
  assert.throws(() => auditMintAccount(fixtureAccount(SPYX), SPYX), /Token-2022 extension PermanentDelegate is refused/);
});

await ok("describeMint reads a classic SPL mint and refuses only what is not a mint", async () => {
  const classic = describeMint(classicMint(), MINT); // 82 bytes, option tags 0 at 0 and 46, decimals 6, initialized
  assert.equal(classic.program, TOKEN_PROGRAM);
  assert.equal(classic.decimals, 6);
  assert.equal(classic.initialized, true);
  assert.deepEqual(classic.extensionNames, []);
  assert.equal(classic.paused, false);
  for (const field of ["mintAuthority", "freezeAuthority", "pausableAuthority", "transferHookProgram",
    "permanentDelegate", "defaultAccountState", "scaledUiMultiplier", "metadataName", "metadataSymbol"])
    assert.equal(classic[field], null, field);
  // A pump-style base mint describes too, but with nothing to say; it is still not a judgement.
  assert.deepEqual(describeMint(token2022Mint(), MINT).extensionNames, ["MetadataPointer", "TokenMetadata"]);
  assert.throws(() => describeMint({ owner: PublicKey.default, data: baseMint() }, MINT), /not owned by a token program/);
  assert.throws(() => describeMint({ owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(81) }, MINT), /classic SPL mint layout/);
  assert.throws(() => describeMint(token2022Mint({}, [...PUMP_STYLE, [40, Buffer.alloc(8)]]), MINT), /unknown extension type 40/);
  assert.throws(() => describeMint(null, MINT), /mint account is unavailable/);
});

console.log(`${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
