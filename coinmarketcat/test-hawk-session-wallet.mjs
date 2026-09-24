/**
 * THE SESSION WALLET, END TO END, AGAINST A MAP AND A CLOCK.
 *
 * Nothing here touches a network or chrome.*: `storage` and `session` are Maps behind
 * the { get, set, remove } shape the host gives the keystore, the clock is a number the
 * test moves, and WebCrypto is Node's own. Every assertion prints what it measured.
 *
 * What is proved:
 *   1. a passphrase under 12 characters is refused; a created keystore is the shape the
 *      header promises, holds neither the passphrase nor the secret, and reports the same
 *      public key to a second keystore over the same storage;
 *   2. a wrong passphrase fails as "wrong passphrase", never as WebCrypto's OperationError;
 *      unlocking puts exactly one entry in the session store and nothing in storage;
 *      lock removes it; an expired entry is removed on sight and reported locked;
 *   3. an existing keystore is not replaced without its current passphrase; a changed
 *      passphrase re-seals the same key under a fresh salt and nonce;
 *   4. the exported key is the base58 of 64 bytes whose last 32 are the public key, and
 *      @solana/web3.js rebuilds the same wallet from it;
 *   5. the signer answers the engine's bridge shape: a real v0 transaction comes back
 *      signed with a signature ed25519 verifies over the unchanged message; a locked
 *      wallet says no_wallet; the wrong wallet, or a transaction that does not name the
 *      session wallet, says wallet_mismatch; the secret never appears in the result;
 *   6. the fund and sweep builders refuse zero, negative and self-transfers, the sweep's
 *      rent floor is the chain's 890,880, and the token sweep is an idempotent ATA create
 *      followed by SPL Transfer under either token program, refused for a transfer hook.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  createKeystore, createSessionSigner, buildFundTransaction, buildSweepTransaction, buildTokenSweepTransaction, sweepableLamports,
  KEYSTORE_STORAGE_KEY, SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS, PBKDF2_ITERATIONS, MIN_PASSPHRASE_LENGTH, DEFAULT_UNLOCK_TTL_MS, SessionWalletError,
} from "./src/lib/session-wallet.mjs";
import { SIGN_ERRORS, BridgeError } from "./src/lib/protocol.mjs";
import { fromBase64, sameMessage, signatureOf, associatedTokenAddress, ATA_PROGRAM, SYSTEM_PROGRAM } from "./src/lib/tx.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./vendor/executor/token2022.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);

/* ── doubles ───────────────────────────────────────────────────────────────────────── */

/** The { get, set, remove } shape the host wraps chrome.storage.local / .session into. */
function createStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async remove(k) { m.delete(k); },
    get size() { return m.size; },
    get keys() { return [...m.keys()]; },
    raw(k) { return m.get(k); },
    json() { return JSON.stringify([...m.entries()]); },
  };
}
const START = 1_758_700_000_000;
let now = START;
const clock = () => now;
const SECRET_ENTRY_KEY = "coinmarketcat:session-secret";
const PASS = "correct horse battery staple";
const PASS2 = "another passphrase, longer";
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));
const PHANTOM = Keypair.generate().publicKey.toBase58();
const threw = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
const compiled = (txBase64) => {
  const tx = VersionedTransaction.deserialize(fromBase64(txBase64));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  return {
    tx, keys,
    ixs: tx.message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex], data: Buffer.from(ix.data),
      accounts: ix.accountKeyIndexes.map((i) => ({ key: keys[i], signer: tx.message.isAccountSigner(i), writable: tx.message.isAccountWritable(i) })),
    })),
  };
};
const u64 = (buf) => buf.readBigUInt64LE(0);

let ed25519 = null;
try { ({ ed25519 } = await import("@noble/curves/ed25519")); } catch { ed25519 = null; }

/* ═══════════════════════════════════════════════════════════════════════════════════ */

section("1. CREATE: THE PASSPHRASE FLOOR, THE BLOB, AND A STABLE PUBLIC KEY");
const storage = createStore();
const session = createStore();
const keystore = createKeystore({ storage, session, clock });
let publicKey;
{
  ok("a keystore needs its stores", (await threw(async () => createKeystore({ storage }))) instanceof SessionWalletError);
  ok("a keystore needs SubtleCrypto", (await threw(async () => createKeystore({ storage, session, subtle: null })))?.code === "no_subtle");
  ok("before create: exists() is false and publicKey() is null", (await keystore.exists()) === false && (await keystore.publicKey()) === null);
  const short = await threw(() => keystore.create({ passphrase: "elevenchars" }));
  ok(`a passphrase under ${MIN_PASSPHRASE_LENGTH} characters is refused by name`, short?.code === "passphrase_too_short" && MIN_PASSPHRASE_LENGTH === 12, short?.message);
  ok("nothing was written by the refusal", storage.size === 0 && session.size === 0);
  const made = await keystore.create({ passphrase: PASS });
  publicKey = made.publicKey;
  let parsed = null;
  try { parsed = new PublicKey(publicKey); } catch { parsed = null; }
  ok("create returns a public key that is one", parsed && parsed.toBytes().length === 32 && made.createdAt === START, publicKey);
  ok("exists() is true and publicKey() reads it without a passphrase", (await keystore.exists()) === true && (await keystore.publicKey()) === publicKey);
  const blob = storage.raw(KEYSTORE_STORAGE_KEY);
  ok("the blob sits under the named storage key, and only that key", storage.keys.length === 1 && storage.keys[0] === "coinmarketcat:session-wallet", storage.keys.join(","));
  ok("the blob is v1, PBKDF2-SHA256 at 600,000 iterations, AES-GCM", blob.v === 1 && blob.kdf.name === "PBKDF2" && blob.kdf.hash === "SHA-256" && blob.kdf.iterations === 600_000 && PBKDF2_ITERATIONS === 600_000 && blob.cipher.name === "AES-GCM", JSON.stringify({ v: blob.v, kdf: { ...blob.kdf, salt: "…" }, cipher: { ...blob.cipher, iv: "…" } }));
  ok("the salt is 16 random bytes and the nonce 12", fromBase64(blob.kdf.salt).length === 16 && fromBase64(blob.cipher.iv).length === 12);
  ok("the ciphertext is 64 bytes plus the 16-byte GCM tag", fromBase64(blob.ct).length === 80, `${fromBase64(blob.ct).length} bytes`);
  ok("the blob carries the public key in the clear and the creation time", blob.publicKey === publicKey && blob.createdAt === START);
  ok("the blob does not contain the passphrase", !storage.json().includes(PASS));
  ok("create leaves the session store empty", session.size === 0);
  const again = createKeystore({ storage, session: createStore(), clock });
  ok("a second keystore over the same storage reports the same public key", (await again.exists()) === true && (await again.publicKey()) === publicKey);
  const dup = await threw(() => keystore.create({ passphrase: PASS2 }));
  ok("a second create over an existing keystore is refused", dup?.code === "exists" && /already exists/.test(dup.message), dup?.message);
  ok("the refusal changed nothing", storage.raw(KEYSTORE_STORAGE_KEY).ct === blob.ct);
  const broken = createKeystore({ storage: createStore(), session: createStore(), clock });
  await broken.exists();
  const s2 = createStore(); await s2.set(KEYSTORE_STORAGE_KEY, { v: 1, publicKey, kdf: { name: "scrypt" } });
  const malformed = await threw(() => createKeystore({ storage: s2, session: createStore(), clock }).exists());
  ok("a blob this version did not write is refused, not guessed at", malformed?.code === "malformed", malformed?.message);
}

section("2. UNLOCK, LOCK, EXPIRY: THE SECRET LIVES IN SESSION ONLY, AND ONLY FOR A WHILE");
{
  const wrong = await threw(() => keystore.unlock({ passphrase: "not the passphrase" }));
  ok("a wrong passphrase fails as \"wrong passphrase\"", wrong?.code === "wrong_passphrase" && /wrong passphrase/.test(wrong.message), wrong?.message);
  ok("…and not as WebCrypto's OperationError", wrong?.name === "SessionWalletError" && !/OperationError/.test(String(wrong)), wrong?.name);
  ok("a wrong passphrase leaves the session empty", session.size === 0 && (await keystore.isUnlocked()) === false);
  const unlocked = await keystore.unlock({ passphrase: PASS });
  ok("unlock returns the public key and an expiry eight hours out", unlocked.publicKey === publicKey && unlocked.expiresAt === START + DEFAULT_UNLOCK_TTL_MS && DEFAULT_UNLOCK_TTL_MS === 8 * 3600 * 1000, `expires ${unlocked.expiresAt}`);
  ok("isUnlocked() is true, and the synchronous snapshot agrees", (await keystore.isUnlocked()) === true && keystore.snapshot().unlocked === true && keystore.snapshot().publicKey === publicKey);
  ok("the session store holds exactly one entry, the secret's", session.size === 1 && session.keys[0] === SECRET_ENTRY_KEY, session.keys.join(","));
  const entry = session.raw(SECRET_ENTRY_KEY);
  const secret = fromBase64(entry.secretKey);
  ok("the entry is { secretKey, publicKey, expiresAt } and nothing else", Object.keys(entry).sort().join(",") === "expiresAt,publicKey,secretKey" && entry.publicKey === publicKey && entry.expiresAt === unlocked.expiresAt);
  ok("the secret is 64 bytes whose last 32 are the public key", secret.length === 64 && Buffer.from(secret.subarray(32)).equals(new PublicKey(publicKey).toBuffer()));
  ok("the plaintext is nowhere in storage", !storage.json().includes(entry.secretKey) && !storage.json().includes(bs58.encode(secret)));
  await keystore.lock();
  ok("lock removes it: isUnlocked() false, session empty, snapshot locked", (await keystore.isUnlocked()) === false && session.size === 0 && keystore.snapshot().unlocked === false);
  const badTtl = await threw(() => keystore.unlock({ passphrase: PASS, ttlMs: 0 }));
  ok("a zero ttl is refused", badTtl?.code === "bad_ttl", badTtl?.message);
  await keystore.unlock({ passphrase: PASS, ttlMs: 1_000 });
  now += 999;
  ok("at 999ms of a 1s ttl it is still unlocked", (await keystore.isUnlocked()) === true && keystore.snapshot().unlocked === true);
  now += 2;
  ok("the snapshot judges expiry against the clock, synchronously", keystore.snapshot().unlocked === false && keystore.snapshot().expiresAt === null);
  ok("past the ttl it reports locked and the entry is gone", (await keystore.isUnlocked()) === false && session.size === 0, `session entries ${session.size}`);
  // A worker restart: a fresh keystore over the same stores, the session entry still there.
  await keystore.unlock({ passphrase: PASS });
  const restarted = createKeystore({ storage, session, clock });
  ok("a fresh keystore knows nothing until it reads", restarted.snapshot().loaded === false && restarted.snapshot().publicKey === null && restarted.snapshot().unlocked === false);
  const view = await restarted.refresh();
  ok("refresh() reads the blob and the live session entry", view.loaded && view.publicKey === publicKey && view.unlocked === true, JSON.stringify(view));
  await keystore.lock();
}

section("3. REPLACE NEEDS THE CURRENT PASSPHRASE; A CHANGED PASSPHRASE RE-SEALS THE SAME KEY");
{
  const before = storage.raw(KEYSTORE_STORAGE_KEY);
  const noCurrent = await threw(() => keystore.create({ passphrase: PASS2, replace: true }));
  ok("replace without the current passphrase is refused", noCurrent?.code === "current_passphrase_required", noCurrent?.message);
  const wrongCurrent = await threw(() => keystore.create({ passphrase: PASS2, replace: true, currentPassphrase: "not the passphrase" }));
  ok("replace with a wrong current passphrase is refused as wrong passphrase", wrongCurrent?.code === "wrong_passphrase", wrongCurrent?.message);
  ok("neither refusal touched the blob", storage.raw(KEYSTORE_STORAGE_KEY).ct === before.ct && storage.raw(KEYSTORE_STORAGE_KEY).publicKey === publicKey);

  const wrongOld = await threw(() => keystore.changePassphrase({ current: "not the passphrase", next: PASS2 }));
  ok("changePassphrase with the wrong current passphrase is refused", wrongOld?.code === "wrong_passphrase", wrongOld?.message);
  const shortNew = await threw(() => keystore.changePassphrase({ current: PASS, next: "tooshort" }));
  ok("changePassphrase to a short passphrase is refused", shortNew?.code === "passphrase_too_short", shortNew?.message);
  now += 60_000;
  const changed = await keystore.changePassphrase({ current: PASS, next: PASS2 });
  const after = storage.raw(KEYSTORE_STORAGE_KEY);
  ok("the key is the same key", changed.publicKey === publicKey && after.publicKey === publicKey && after.createdAt === before.createdAt);
  ok("the blob was re-sealed under a fresh salt, nonce and ciphertext", after.kdf.salt !== before.kdf.salt && after.cipher.iv !== before.cipher.iv && after.ct !== before.ct && after.rotatedAt === now);
  const oldNow = await threw(() => keystore.unlock({ passphrase: PASS }));
  ok("the old passphrase no longer unlocks", oldNow?.code === "wrong_passphrase", oldNow?.message);
  const newNow = await keystore.unlock({ passphrase: PASS2 });
  ok("the new passphrase does, to the same public key", newNow.publicKey === publicKey && (await keystore.isUnlocked()) === true);

  // Replace, properly: unlocked, with the current passphrase. The old secret must not linger.
  const replaced = await keystore.create({ passphrase: PASS, replace: true, currentPassphrase: PASS2 });
  ok("replace with the current passphrase makes a new wallet and names the old one", replaced.publicKey !== publicKey && replaced.replaced === publicKey, `${replaced.replaced} → ${replaced.publicKey}`);
  ok("the old wallet's unlocked secret was dropped with it", (await keystore.isUnlocked()) === false && session.size === 0);
  ok("the blob now carries the new public key", storage.raw(KEYSTORE_STORAGE_KEY).publicKey === replaced.publicKey && (await keystore.publicKey()) === replaced.publicKey);
  publicKey = replaced.publicKey;
}

section("4. EXPORT: THE BASE58 PHANTOM IMPORTS, SO FUNDS ARE NEVER STRANDED");
{
  const wrong = await threw(() => keystore.exportSecret({ passphrase: PASS2 }));
  ok("export with the wrong passphrase is refused", wrong?.code === "wrong_passphrase", wrong?.message);
  const exported = await keystore.exportSecret({ passphrase: PASS });
  const bytes = bs58.decode(exported);
  ok("the export is base58 of 64 bytes", typeof exported === "string" && bytes.length === 64, `${exported.length} chars → ${bytes.length} bytes`);
  ok("its last 32 bytes are the public key", Buffer.from(bytes.subarray(32)).equals(new PublicKey(publicKey).toBuffer()));
  ok("@solana/web3.js rebuilds the same wallet from it", Keypair.fromSecretKey(bytes).publicKey.toBase58() === publicKey);
  ok("neither the export nor its base64 is in storage", !storage.json().includes(exported) && !storage.json().includes(Buffer.from(bytes).toString("base64")));
  ok("export does not unlock", (await keystore.isUnlocked()) === false && session.size === 0);
}

section("5. THE SIGNER: THE ENGINE'S BRIDGE, ANSWERED BY THE SESSION WALLET");
{
  ok("a signer needs a keystore made here", (await threw(async () => createSessionSigner({})))?.code === "bad_keystore" && (await threw(async () => createSessionSigner({ keystore: { snapshot() {} } })))?.code === "bad_keystore");
  const signer = createSessionSigner({ keystore, clock });
  await signer.refresh();
  ok("the signer has the bridge's shape", typeof signer.isReady === "function" && typeof signer.wallet === "function" && typeof signer.signTransaction === "function");
  ok("locked: isReady() false, wallet() still the address", signer.isReady() === false && signer.wallet() === publicKey, signer.wallet());
  const fund = buildFundTransaction({ from: publicKey, to: PHANTOM, lamports: 250_000_000, blockhash: BLOCKHASH });
  const lockedErr = await threw(() => signer.signTransaction({ txBase64: fund.txBase64, purpose: "buy", wallet: publicKey }));
  ok("locked: signTransaction throws no_wallet and says to unlock", lockedErr instanceof BridgeError && lockedErr.code === SIGN_ERRORS.NO_WALLET && /locked/.test(lockedErr.message), lockedErr?.message);

  await keystore.unlock({ passphrase: PASS, ttlMs: 60_000 });
  ok("unlocked: isReady() true, wallet() is the session wallet", signer.isReady() === true && signer.wallet() === publicKey);
  const signed = await signer.signTransaction({ txBase64: fund.txBase64, purpose: "buy", mint: "x", summary: "s", timeoutMs: 1, wallet: publicKey });
  ok("the result is { signedBase64 } and nothing else", Object.keys(signed).join(",") === "signedBase64" && typeof signed.signedBase64 === "string");
  const unsignedBytes = fromBase64(fund.txBase64), signedBytes = fromBase64(signed.signedBase64);
  const tx = VersionedTransaction.deserialize(signedBytes);
  ok("the signature is present", tx.signatures.length === 1 && tx.signatures[0].some((b) => b !== 0) && signatureOf(signedBytes).length > 60, signatureOf(signedBytes));
  ok("the message is byte-identical to the one asked for (the engine's own check)", sameMessage(unsignedBytes, signedBytes));
  ok("the fee payer of the message is the session wallet, as Keypair spells it", tx.message.staticAccountKeys[0].equals(new PublicKey(publicKey)));
  if (ed25519) {
    const message = tx.message.serialize();
    ok("ed25519 verifies the signature over the message under the session public key", ed25519.verify(tx.signatures[0], message, new PublicKey(publicKey).toBytes()));
    ok("…and not under another key", !ed25519.verify(tx.signatures[0], message, new PublicKey(PHANTOM).toBytes()));
    const tampered = Uint8Array.from(message); tampered[tampered.length - 1] ^= 1;
    ok("…and not over a changed message", !ed25519.verify(tx.signatures[0], tampered, new PublicKey(publicKey).toBytes()));
  } else {
    console.log("  (no @noble/curves in node_modules — signature verified structurally only)");
  }
  const secretB64 = session.raw(SECRET_ENTRY_KEY).secretKey;
  ok("the secret is not in the result", !signed.signedBase64.includes(secretB64.slice(0, 20)) && !JSON.stringify(signed).includes(secretB64));
  const mismatch = await threw(() => signer.signTransaction({ txBase64: fund.txBase64, wallet: PHANTOM }));
  ok("a request for another wallet throws wallet_mismatch", mismatch instanceof BridgeError && mismatch.code === SIGN_ERRORS.WALLET_MISMATCH, mismatch?.message);
  const notMine = buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: 1, blockhash: BLOCKHASH });
  const notSigner = await threw(() => signer.signTransaction({ txBase64: notMine.txBase64 }));
  ok("a transaction that does not name the session wallet as a signer throws wallet_mismatch", notSigner instanceof BridgeError && notSigner.code === SIGN_ERRORS.WALLET_MISMATCH && /not the session wallet/.test(notSigner.message), notSigner?.message);
  const garbage = await threw(() => signer.signTransaction({ txBase64: "bm90IGEgdHJhbnNhY3Rpb24=" }));
  ok("bytes that are not a transaction throw provider, not a raw error", garbage instanceof BridgeError && garbage.code === SIGN_ERRORS.PROVIDER, garbage?.message);
  const sweep = buildSweepTransaction({ from: publicKey, to: PHANTOM, lamports: 100_000_000, blockhash: BLOCKHASH });
  const sweepSigned = await signer.signTransaction({ txBase64: sweep.txBase64, wallet: publicKey });
  ok("a sweep signs the same way", sameMessage(fromBase64(sweep.txBase64), fromBase64(sweepSigned.signedBase64)) && signatureOf(fromBase64(sweepSigned.signedBase64)) !== signatureOf(signedBytes));
  now += 60_001;
  ok("past the ttl isReady() is false without any async read", signer.isReady() === false);
  const expired = await threw(() => signer.signTransaction({ txBase64: fund.txBase64, wallet: publicKey }));
  ok("…and signTransaction throws no_wallet, having removed the entry", expired?.code === SIGN_ERRORS.NO_WALLET && session.size === 0);
  await keystore.unlock({ passphrase: PASS });
  await keystore.lock();
  const afterLock = await threw(() => signer.signTransaction({ txBase64: fund.txBase64, wallet: publicKey }));
  ok("after lock() it throws no_wallet again", afterLock?.code === SIGN_ERRORS.NO_WALLET && signer.isReady() === false);
}

section("6. THE BUILDERS: FUND, SWEEP, AND THE TOKEN SWEEP");
{
  const refuse = async (name, fn, code, re = null) => { const e = await threw(fn); ok(name, e instanceof SessionWalletError && e.code === code && (!re || re.test(e.message)), e?.message ?? "no error"); };
  await refuse("fund refuses zero lamports", () => buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: 0, blockhash: BLOCKHASH }), "bad_amount");
  await refuse("fund refuses negative lamports", () => buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: -5, blockhash: BLOCKHASH }), "bad_amount");
  await refuse("fund refuses a non-integer amount", () => buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: 0.5, blockhash: BLOCKHASH }), "bad_amount");
  await refuse("fund refuses from === to", () => buildFundTransaction({ from: PHANTOM, to: PHANTOM, lamports: 1, blockhash: BLOCKHASH }), "same_account");
  await refuse("fund refuses an address that is not one", () => buildFundTransaction({ from: "phantom", to: publicKey, lamports: 1, blockhash: BLOCKHASH }), "bad_account");
  await refuse("fund needs a blockhash", () => buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: 1 }), "bad_blockhash");
  const fund = buildFundTransaction({ from: PHANTOM, to: publicKey, lamports: 500_000_000n, blockhash: BLOCKHASH });
  const f = compiled(fund.txBase64);
  ok("fund is budget, price, then one system transfer", f.ixs.length === 3 && f.ixs[2].program === SYSTEM_PROGRAM, f.ixs.map((i) => i.program).join(" "));
  ok("the transfer is instruction 2 for exactly the lamports", f.ixs[2].data.readUInt32LE(0) === 2 && u64(f.ixs[2].data.subarray(4)) === 500_000_000n, `${u64(f.ixs[2].data.subarray(4))} lamports`);
  ok("from Phantom (signer, writable) to the session wallet (writable)", f.ixs[2].accounts[0].key === PHANTOM && f.ixs[2].accounts[0].signer && f.ixs[2].accounts[0].writable && f.ixs[2].accounts[1].key === publicKey && f.ixs[2].accounts[1].writable && !f.ixs[2].accounts[1].signer);
  ok("Phantom pays, and the blockhash is the one given", f.keys[0] === PHANTOM && f.tx.message.recentBlockhash === BLOCKHASH);
  ok("the result names purpose, amount and a summary in SOL", fund.purpose === "fund" && fund.lamports === "500000000" && /0\.5 SOL/.test(fund.summary), fund.summary);

  ok("the rent floor is the chain's minimum for an empty account", SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS === 890_880, String(SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS));
  ok("sweepableLamports takes rent and fee off the balance", sweepableLamports({ balanceLamports: 1_000_000_000, feeLamports: 5_000 }) === 1_000_000_000n - 890_880n - 5_000n);
  ok("a balance at rent plus fee sweeps nothing", sweepableLamports({ balanceLamports: 895_880 }) === 0n && sweepableLamports({ balanceLamports: 100 }) < 0n);
  await refuse("sweep refuses zero, saying the balance is at rent", () => buildSweepTransaction({ from: publicKey, to: PHANTOM, lamports: 0, blockhash: BLOCKHASH }), "at_rent", /at rent/);
  await refuse("sweep refuses a negative amount the same way", () => buildSweepTransaction({ from: publicKey, to: PHANTOM, lamports: -1, blockhash: BLOCKHASH }), "at_rent", /890,?880/);
  await refuse("sweep refuses from === to", () => buildSweepTransaction({ from: publicKey, to: publicKey, lamports: 1, blockhash: BLOCKHASH }), "same_account");
  const sweep = buildSweepTransaction({ from: publicKey, to: PHANTOM, lamports: sweepableLamports({ balanceLamports: 1_000_000_000 }), blockhash: BLOCKHASH });
  const s = compiled(sweep.txBase64);
  ok("sweep is a system transfer from the session wallet to Phantom", s.ixs.length === 3 && s.ixs[2].program === SYSTEM_PROGRAM && s.ixs[2].accounts[0].key === publicKey && s.ixs[2].accounts[0].signer && s.ixs[2].accounts[1].key === PHANTOM && s.keys[0] === publicKey);
  ok("for exactly the amount the caller computed", u64(s.ixs[2].data.subarray(4)) === 1_000_000_000n - 890_880n - 5_000n && sweep.purpose === "sweep", sweep.summary);

  const MINT = Keypair.generate().publicKey.toBase58();
  for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const label = tokenProgram === TOKEN_PROGRAM ? "classic" : "Token-2022";
    const sweepTok = buildTokenSweepTransaction({ from: publicKey, to: PHANTOM, mint: MINT, amountRaw: "123456789012", tokenProgram, blockhash: BLOCKHASH });
    const t = compiled(sweepTok.txBase64);
    const src = associatedTokenAddress(publicKey, MINT, tokenProgram), dst = associatedTokenAddress(PHANTOM, MINT, tokenProgram);
    ok(`${label}: budget, price, ATA create, transfer`, t.ixs.length === 4 && t.ixs[2].program === ATA_PROGRAM && t.ixs[3].program === tokenProgram, t.ixs.map((i) => i.program).join(" "));
    ok(`${label}: the create is idempotent (data [1]) for Phantom's ATA under this token program`, t.ixs[2].data.equals(Buffer.from([1])) && t.ixs[2].accounts[1].key === dst && t.ixs[2].accounts[2].key === PHANTOM && t.ixs[2].accounts[3].key === MINT && t.ixs[2].accounts[5].key === tokenProgram && t.ixs[2].accounts[0].key === publicKey && t.ixs[2].accounts[0].signer);
    ok(`${label}: the transfer is SPL instruction 3 with the u64 amount LE`, t.ixs[3].data.length === 9 && t.ixs[3].data[0] === 3 && u64(t.ixs[3].data.subarray(1)) === 123_456_789_012n, Array.from(t.ixs[3].data).join(","));
    ok(`${label}: source ATA writable, destination ATA writable, owner signer`, t.ixs[3].accounts.length === 3 && t.ixs[3].accounts[0].key === src && t.ixs[3].accounts[0].writable && !t.ixs[3].accounts[0].signer && t.ixs[3].accounts[1].key === dst && t.ixs[3].accounts[1].writable && t.ixs[3].accounts[2].key === publicKey && t.ixs[3].accounts[2].signer);
    ok(`${label}: the result names both ATAs and the program`, sweepTok.sourceAta === src && sweepTok.destinationAta === dst && sweepTok.tokenProgram === tokenProgram && sweepTok.purpose === "sweep_token");
  }
  await refuse("a transfer-hook mint is refused", () => buildTokenSweepTransaction({ from: publicKey, to: PHANTOM, mint: MINT, amountRaw: 1, tokenProgram: TOKEN_2022_PROGRAM, blockhash: BLOCKHASH, transferHook: true }), "transfer_hook", /extra accounts/);
  await refuse("a token program that is neither is refused", () => buildTokenSweepTransaction({ from: publicKey, to: PHANTOM, mint: MINT, amountRaw: 1, tokenProgram: ATA_PROGRAM, blockhash: BLOCKHASH }), "bad_token_program");
  await refuse("a zero token amount is refused", () => buildTokenSweepTransaction({ from: publicKey, to: PHANTOM, mint: MINT, amountRaw: 0, tokenProgram: TOKEN_PROGRAM, blockhash: BLOCKHASH }), "bad_amount");
  await refuse("a token sweep to oneself is refused", () => buildTokenSweepTransaction({ from: publicKey, to: publicKey, mint: MINT, amountRaw: 1, tokenProgram: TOKEN_PROGRAM, blockhash: BLOCKHASH }), "same_account");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
