/**
 * THE ONE FILE THAT MAY HOLD A KEY: THE SESSION WALLET (the popup calls it the AUTOPILOT WALLET).
 *
 * Phantom cannot sign for a bot. Every trade the lane makes through it is one approval
 * window, and a stop that needs a click is a weaker stop than a key's — the README says
 * so, and the record says the clicks come late. This file is the other answer: a keypair
 * the extension generates itself, funded from Phantom with ONE approved transfer equal to
 * the budget, that signs the lane's buys and sells on its own, and is swept back to
 * Phantom when the session is done.
 *
 * The budget becomes the balance. A wallet holding 0.5 SOL cannot spend 0.6 SOL, whatever
 * the lane's arithmetic says, whatever a bug says, whatever a tampered config says: the
 * chain refuses. That is the hardest cap there is — harder than any check in engine.mjs —
 * and it is why this exists rather than an auto-approve Phantom does not offer.
 *
 * THE TRADE, PLAINLY. A private key in a browser is a bigger attack surface than one on a
 * server. The executor's burner key sits in an environment variable on a machine one
 * person administers. This one sits in a browser profile that also runs every other
 * extension the user installed and every page they open. What this file does about it,
 * and what it cannot:
 *
 *   · AT REST the 64-byte secret is AES-GCM-256 ciphertext under a key PBKDF2-SHA256
 *     derives from the passphrase: 600,000 iterations, a fresh 16-byte salt, a fresh
 *     12-byte nonce, every time it is written. The passphrase is never stored, anywhere,
 *     in any form. The keystore blob goes to `storage` (the host wraps chrome.storage.local).
 *     It carries the public key in the clear, so the popup can show the address without
 *     a passphrase, and nothing a passphrase-less reader can spend.
 *
 *   · UNLOCKED the plaintext secret goes to `session` (the host wraps chrome.storage.session:
 *     memory only, extension-private, gone when the browser closes) with an expiry, eight
 *     hours by default. Every read checks the expiry; an expired entry is removed on sight.
 *     Plaintext bytes this file holds are zeroed after use; the copies @solana/web3.js
 *     makes while signing are not reachable and are left to the collector.
 *
 *   · NOT PROTECTED: a compromised browser profile. Anything that can read the extension's
 *     session storage while the wallet is unlocked — malware on the machine, a debugger
 *     attached to the worker, an extension with the wrong permissions — can read the
 *     secret, and a keylogger has the passphrase. So: fund it with what you are willing
 *     to lose, sweep when the session ends, and LOCK when done. A locked wallet is
 *     ciphertext on disk and a passphrase in your head.
 *
 *   · RECOVERY is always possible. `exportSecret` gives the base58 form Phantom and
 *     Solflare import, so funds are never stranded in a wallet the extension made. It is
 *     for recovery; a key that is routinely exported is a key that is routinely exposed.
 *
 * THE RULE THIS FILE LIVES UNDER: only this file may touch a secret key. It is the one
 * exemption in test-hawk-no-key.mjs, which scans every other file under src/ for a
 * Keypair, a secret, a derivation or a signer and refuses the build if one appears, and
 * refuses any file but the background host importing this one. Nothing here logs — not
 * the secret, not the passphrase, not the ciphertext, not a "wallet unlocked" line. Nothing
 * here touches chrome.*: storage, session, WebCrypto, randomness and the clock are all
 * injected, so the whole file runs in Node for its tests (test-hawk-session-wallet.mjs).
 *
 * `storage` and `session` are both { get(key) → value|undefined, set(key, value), remove(key) },
 * async. The secret entry is written to `session` and only ever to `session`; the no-key
 * test scans this file for the line that says otherwise.
 *
 * `createSessionSigner` is the engine's bridge shape, { isReady(), wallet(), signTransaction() }.
 * The engine reads isReady() and wallet() synchronously, so the signer answers from the
 * keystore's last read; the host calls `refresh()` when the worker starts and after every
 * keystore call, and every signTransaction re-reads the session before it signs.
 */
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../../vendor/executor/token2022.mjs";
import {
  ATA_PROGRAM, associatedTokenAddress, buildUnsignedTransaction, createAtaIdempotentIx, toBase64, fromBase64, bs58encode,
  RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS, rawToUnits,
} from "./tx.mjs";
import { BridgeError, SIGN_ERRORS } from "./protocol.mjs";

export const KEYSTORE_STORAGE_KEY = "coinmarketcat:session-wallet";
export const KEYSTORE_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;
export const PBKDF2_ITERATIONS = 600_000;
export const DEFAULT_UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
/** The rent-exempt minimum for a system account holding 0 data bytes at the current rate
 *  (3,480 lamports per byte-year, two years, over 0 + 128 overhead bytes = 890,880), as
 *  `getMinimumBalanceForRentExemption(0)` returns it on mainnet. A sweep must leave this
 *  behind or the transfer fails with InsufficientFundsForRent. If the rate ever changes,
 *  the caller's live read of getMinimumBalanceForRentExemption(0) wins over this constant.
 *  One number, kept in tx.mjs, so the lane's balance check and the sweep agree on it. */
export const SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS = RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SECRET_BYTES = 64;
/* spl-token TokenInstruction::TransferChecked, both programs: [12, u64 amount LE, u8 decimals];
   source, mint, destination, owner. NOT the plain Transfer (3): Token-2022 refuses a plain
   Transfer out of any account carrying PausableAccount or TransferHookAccount with
   MintRequiredForTransfer, and every xStock account carries both (the live 179-byte
   Token-2022 GLDx account in vendor/executor/fixtures/pumpfun-xstock-quote.json does). */
const SPL_TRANSFER_CHECKED_INSTRUCTION = 12;
const SPL_CLOSE_ACCOUNT_INSTRUCTION = 9;   // [9]; account, destination, owner — a zero-balance account only
const LAMPORTS_PER_SOL = 1_000_000_000n;

export class SessionWalletError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SessionWalletError";
    this.code = code;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isStore = (s) => isPlainObject(s) && typeof s.get === "function" && typeof s.set === "function" && typeof s.remove === "function";
const short = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : String(k));
const sol = (lamports) => (Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL)).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
const utf8 = (text) => new TextEncoder().encode(text);

/** The secret readers of keystores made here, unreachable from outside this module: the
 *  signer finds its keystore's reader by identity and nothing else can. */
const SECRET_READERS = new WeakMap();

/* ── the keystore ──────────────────────────────────────────────────────────────────── */

export function createKeystore({
  storage,                                   // { get, set, remove } — the host wraps chrome.storage.local
  session,                                   // { get, set, remove } — the host wraps chrome.storage.session
  subtle = globalThis.crypto?.subtle,
  random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  clock = Date.now,
} = {}) {
  if (!isStore(storage)) throw new SessionWalletError("bad_storage", "createKeystore needs a storage with get(), set() and remove()");
  if (!isStore(session)) throw new SessionWalletError("bad_storage", "createKeystore needs a session store with get(), set() and remove()");
  if (!subtle || typeof subtle.deriveKey !== "function" || typeof subtle.encrypt !== "function")
    throw new SessionWalletError("no_subtle", "WebCrypto's SubtleCrypto is not available here; the keystore cannot run");

  /** The last read, for the synchronous answers the engine wants. */
  const mirror = { loaded: false, publicKey: null, expiresAt: null };

  async function deriveKey(passphrase, salt, iterations) {
    const material = utf8(passphrase);
    try {
      const base = await subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"]);
      return await subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      );
    } finally { material.fill(0); }
  }

  async function encryptSecret(secret, passphrase) {
    const salt = random(SALT_BYTES);
    const iv = random(IV_BYTES);
    if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES || !(iv instanceof Uint8Array) || iv.length !== IV_BYTES)
      throw new SessionWalletError("bad_random", "the random source did not return the bytes asked of it");
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, secret));
    return {
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
      cipher: { name: "AES-GCM", iv: toBase64(iv) },
      ct: toBase64(ct),
    };
  }

  /** The 64 plaintext bytes, or a "wrong passphrase" refusal; the caller zeroes them. */
  async function decryptSecret(blob, passphrase) {
    requirePassphrase(passphrase, "the passphrase");
    const key = await deriveKey(passphrase, fromBase64(blob.kdf.salt), blob.kdf.iterations);
    let plain;
    try { plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromBase64(blob.cipher.iv) }, key, fromBase64(blob.ct))); }
    catch { throw new SessionWalletError("wrong_passphrase", "wrong passphrase"); }
    if (plain.length !== SECRET_BYTES || !sameBytes(plain.subarray(32), new PublicKey(blob.publicKey).toBytes())) {
      plain.fill(0);
      throw new SessionWalletError("malformed", "the keystore decrypted to something that is not this wallet's key");
    }
    return plain;
  }

  function requirePassphrase(passphrase, what) {
    if (typeof passphrase !== "string" || !passphrase.length) throw new SessionWalletError("passphrase_required", `${what} is required`);
  }
  function requireNewPassphrase(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH)
      throw new SessionWalletError("passphrase_too_short", `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }

  async function readBlob() {
    const raw = await storage.get(KEYSTORE_STORAGE_KEY);
    if (raw == null) { mirror.loaded = true; mirror.publicKey = null; return null; }
    const ok = isPlainObject(raw) && raw.v === KEYSTORE_VERSION && typeof raw.publicKey === "string"
      && isPlainObject(raw.kdf) && raw.kdf.name === "PBKDF2" && raw.kdf.hash === "SHA-256"
      && Number.isInteger(raw.kdf.iterations) && raw.kdf.iterations > 0 && typeof raw.kdf.salt === "string"
      && isPlainObject(raw.cipher) && raw.cipher.name === "AES-GCM" && typeof raw.cipher.iv === "string" && typeof raw.ct === "string";
    if (!ok) throw new SessionWalletError("malformed", "the stored keystore is not one this version wrote");
    mirror.loaded = true; mirror.publicKey = raw.publicKey;
    return raw;
  }

  /** The session entry when it is present and unexpired; an expired one is removed on sight. */
  async function readSecretEntry() {
    const entry = await session.get("coinmarketcat:session-secret");
    if (entry == null) { mirror.expiresAt = null; return null; }
    const live = isPlainObject(entry) && typeof entry.secretKey === "string" && typeof entry.publicKey === "string"
      && Number.isFinite(entry.expiresAt) && entry.expiresAt > clock();
    if (!live) { await session.remove("coinmarketcat:session-secret"); mirror.expiresAt = null; return null; }
    mirror.expiresAt = entry.expiresAt;
    return entry;
  }

  async function writeBlob(blob) {
    await storage.set(KEYSTORE_STORAGE_KEY, blob);
    mirror.loaded = true; mirror.publicKey = blob.publicKey;
  }

  const keystore = {
    async exists() { return (await readBlob()) !== null; },

    async publicKey() { return (await readBlob())?.publicKey ?? null; },

    /** A new keypair under a new passphrase. An existing keystore is never overwritten
     *  unless `replace` is true AND its current passphrase is given: a wallet with funds
     *  in it is not lost to a mis-click. Any unlocked secret is dropped first. */
    async create({ passphrase, replace = false, currentPassphrase } = {}) {
      requireNewPassphrase(passphrase);
      const existing = await readBlob();
      if (existing) {
        if (replace !== true)
          throw new SessionWalletError("exists", `a session wallet already exists (${short(existing.publicKey)}); sweep it, then replace it with its current passphrase`);
        if (typeof currentPassphrase !== "string" || !currentPassphrase.length)
          throw new SessionWalletError("current_passphrase_required", "replacing the session wallet needs its current passphrase");
        (await decryptSecret(existing, currentPassphrase)).fill(0);
      }
      await keystore.lock();
      const keypair = Keypair.generate();
      const secret = keypair.secretKey;                 // a copy; the keypair's own bytes are left to the collector
      try {
        const publicKey = keypair.publicKey.toBase58();
        const sealed = await encryptSecret(secret, passphrase);
        const blob = { v: KEYSTORE_VERSION, publicKey, ...sealed, createdAt: clock() };
        await writeBlob(blob);
        return Object.freeze({ publicKey, createdAt: blob.createdAt, replaced: existing?.publicKey ?? null });
      } finally { secret.fill(0); }
    },

    /** Decrypt into the session store until `expiresAt`. */
    async unlock({ passphrase, ttlMs = DEFAULT_UNLOCK_TTL_MS } = {}) {
      const blob = await readBlob();
      if (!blob) throw new SessionWalletError("no_keystore", "there is no session wallet to unlock");
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new SessionWalletError("bad_ttl", "ttlMs must be a positive number of milliseconds");
      const secret = await decryptSecret(blob, passphrase);
      try {
        const expiresAt = clock() + ttlMs;
        await session.set("coinmarketcat:session-secret", { secretKey: toBase64(secret), publicKey: blob.publicKey, expiresAt });
        mirror.expiresAt = expiresAt;
        return Object.freeze({ publicKey: blob.publicKey, expiresAt });
      } finally { secret.fill(0); }
    },

    async lock() {
      await session.remove("coinmarketcat:session-secret");
      mirror.expiresAt = null;
    },

    async isUnlocked() { return (await readSecretEntry()) !== null; },

    /** Re-seal the same key under a new passphrase, with a fresh salt and nonce. The
     *  session entry, if any, is untouched: the key did not change. */
    async changePassphrase({ current, next } = {}) {
      requireNewPassphrase(next);
      const blob = await readBlob();
      if (!blob) throw new SessionWalletError("no_keystore", "there is no session wallet whose passphrase could change");
      const secret = await decryptSecret(blob, current);
      try {
        const sealed = await encryptSecret(secret, next);
        await writeBlob({ ...blob, ...sealed, rotatedAt: clock() });
        return Object.freeze({ publicKey: blob.publicKey });
      } finally { secret.fill(0); }
    },

    /** The base58 secret key Phantom and Solflare import. For recovery. */
    async exportSecret({ passphrase } = {}) {
      const blob = await readBlob();
      if (!blob) throw new SessionWalletError("no_keystore", "there is no session wallet to export");
      const secret = await decryptSecret(blob, passphrase);
      try { return bs58encode(secret); } finally { secret.fill(0); }
    },

    /** What the last read said, synchronously; `unlocked` is judged against the clock now. */
    snapshot() {
      const unlocked = mirror.expiresAt != null && mirror.expiresAt > clock();
      return Object.freeze({ loaded: mirror.loaded, publicKey: mirror.publicKey, unlocked, expiresAt: unlocked ? mirror.expiresAt : null });
    },

    /** Re-read the blob and the session entry; what the host calls at start and after every change. */
    async refresh() {
      await readBlob();
      await readSecretEntry();
      return keystore.snapshot();
    },
  };
  SECRET_READERS.set(keystore, readSecretEntry);
  return keystore;
}

/* ── the signer: the engine's bridge, answered by the session wallet ───────────────── */

export function createSessionSigner({ keystore, clock = Date.now } = {}) {
  const readSecretEntry = keystore ? SECRET_READERS.get(keystore) : null;
  if (typeof readSecretEntry !== "function") throw new SessionWalletError("bad_keystore", "createSessionSigner needs a keystore made by createKeystore");
  return {
    kind: "session",
    isReady() { return keystore.snapshot().unlocked; },
    wallet() { return keystore.snapshot().publicKey; },
    refresh() { return keystore.refresh(); },
    /** The same call the engine makes of Phantom. `purpose`, `mint`, `summary` and
     *  `timeoutMs` are accepted and unused: there is no window to title and nobody to wait for. */
    async signTransaction({ txBase64, wallet = null } = {}) {
      const entry = await readSecretEntry();
      if (!entry) throw new BridgeError(SIGN_ERRORS.NO_WALLET, "the session wallet is locked — unlock it with your passphrase");
      if (wallet && wallet !== entry.publicKey)
        throw new BridgeError(SIGN_ERRORS.WALLET_MISMATCH, `the lane is armed for ${short(wallet)} but the session wallet is ${short(entry.publicKey)}`);
      let tx;
      try { tx = VersionedTransaction.deserialize(fromBase64(txBase64)); }
      catch (error) { throw new BridgeError(SIGN_ERRORS.PROVIDER, `the session wallet could not read the transaction: ${error?.message ?? error}`); }
      const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
      if (!signers.includes(entry.publicKey))
        throw new BridgeError(SIGN_ERRORS.WALLET_MISMATCH, `the transaction names ${signers.map(short).join(", ")} as signer, not the session wallet ${short(entry.publicKey)}`);
      const secret = fromBase64(entry.secretKey);
      try {
        if (secret.length !== SECRET_BYTES) throw new BridgeError(SIGN_ERRORS.PROVIDER, "the session entry is not a 64-byte key");
        tx.sign([Keypair.fromSecretKey(secret)]);   // holds `secret` by reference; zeroed below
        return { signedBase64: toBase64(tx.serialize()) };
      } finally { secret.fill(0); }
    },
  };
}

/* ── the transfers around a session: fund it, sweep it, sweep what it still holds ──── */

function accountsOf(from, to) {
  let fromKey, toKey;
  try { fromKey = new PublicKey(from); } catch { throw new SessionWalletError("bad_account", `"${from}" is not a public key`); }
  try { toKey = new PublicKey(to); } catch { throw new SessionWalletError("bad_account", `"${to}" is not a public key`); }
  if (fromKey.equals(toKey)) throw new SessionWalletError("same_account", `a transfer from ${short(from)} to itself moves nothing`);
  return { fromKey, toKey };
}
function lamportsOf(value, what) {
  let amount;
  try { amount = BigInt(value); } catch { throw new SessionWalletError("bad_amount", `${what} must be an integer number of lamports`); }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new SessionWalletError("bad_amount", `${what} must be an integer number of lamports`);
  return amount;
}
function requireBlockhash(blockhash) {
  if (typeof blockhash !== "string" || !blockhash.length) throw new SessionWalletError("bad_blockhash", "a recent blockhash is required");
  return blockhash;
}
const u64le = (value) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value), true); return b; };

/** Phantom → session wallet: the one approved transfer that is the budget. */
export function buildFundTransaction({ from, to, lamports, blockhash, computeUnitLimit = 20_000, priorityFeeLamports = 0 } = {}) {
  const { fromKey, toKey } = accountsOf(from, to);
  const amount = lamportsOf(lamports, "the funding amount");
  if (amount <= 0n) throw new SessionWalletError("bad_amount", "the funding amount must be more than zero lamports");
  const tx = buildUnsignedTransaction({
    payer: fromKey.toBase58(), blockhash: requireBlockhash(blockhash), computeUnitLimit, priorityFeeLamports,
    instructions: [SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: toKey, lamports: amount })],
  });
  return Object.freeze({
    purpose: "fund", txBase64: toBase64(tx.serialize()), from: fromKey.toBase58(), to: toKey.toBase58(), lamports: amount.toString(),
    summary: `FUND the autopilot wallet ${short(toKey.toBase58())} with ${sol(amount)} SOL`,
  });
}

/** What a sweep can move: the balance less the rent floor and the fee; at or below zero
 *  there is nothing to sweep. */
export function sweepableLamports({ balanceLamports, feeLamports = 5_000, priorityFeeLamports = 0 } = {}) {
  return lamportsOf(balanceLamports, "the balance") - BigInt(SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS)
    - lamportsOf(feeLamports, "the fee") - lamportsOf(priorityFeeLamports, "the priority fee");
}

/** Session wallet → Phantom: the caller has already taken rent and fee off the balance. */
export function buildSweepTransaction({ from, to, lamports, blockhash, computeUnitLimit = 20_000, priorityFeeLamports = 0 } = {}) {
  const { fromKey, toKey } = accountsOf(from, to);
  const amount = lamportsOf(lamports, "the sweep amount");
  if (amount <= 0n)
    throw new SessionWalletError("at_rent", `nothing to sweep: after the rent-exempt minimum (${SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS} lamports) and the fee, the balance is at rent`);
  const tx = buildUnsignedTransaction({
    payer: fromKey.toBase58(), blockhash: requireBlockhash(blockhash), computeUnitLimit, priorityFeeLamports,
    instructions: [SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: toKey, lamports: amount })],
  });
  return Object.freeze({
    purpose: "sweep", txBase64: toBase64(tx.serialize()), from: fromKey.toBase58(), to: toKey.toBase58(), lamports: amount.toString(),
    summary: `SWEEP ${sol(amount)} SOL from the autopilot wallet ${short(fromKey.toBase58())} to ${short(toKey.toBase58())}`,
  });
}

/** The token transfer both directions share: an idempotent create of the destination's
 *  associated account (paid by the sender), then TransferChecked for the whole amount,
 *  and — for a sweep that asks — CloseAccount on the emptied source, its rent to the sender. */
function buildTokenTransfer({
  purpose, from, to, mint, amountRaw, tokenProgram, decimals, blockhash, computeUnitLimit, priorityFeeLamports,
  transferHook, closeSource = false, symbol = null,
}) {
  if (transferHook) throw new SessionWalletError("transfer_hook", "a Token-2022 mint with a transfer hook needs the hook's extra accounts; this builder does not resolve them");
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM)
    throw new SessionWalletError("bad_token_program", `"${tokenProgram}" is neither the token program nor Token-2022`);
  if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18))
    throw new SessionWalletError("bad_decimals", `TransferChecked needs the mint's decimals (0..18), got ${JSON.stringify(decimals)}`);
  const { fromKey, toKey } = accountsOf(from, to);
  let mintKey;
  try { mintKey = new PublicKey(mint); } catch { throw new SessionWalletError("bad_account", `"${mint}" is not a mint address`); }
  const amount = lamportsOf(amountRaw, "the token amount");
  if (amount <= 0n) throw new SessionWalletError("bad_amount", "the token amount must be more than zero");
  const owner = fromKey.toBase58(), recipient = toKey.toBase58(), mintAddress = mintKey.toBase58();
  const sourceAta = associatedTokenAddress(owner, mintAddress, tokenProgram);
  const destinationAta = associatedTokenAddress(recipient, mintAddress, tokenProgram);
  const transfer = new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: new PublicKey(sourceAta), isSigner: false, isWritable: true },
      { pubkey: mintKey, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(destinationAta), isSigner: false, isWritable: true },
      { pubkey: fromKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([SPL_TRANSFER_CHECKED_INSTRUCTION, ...u64le(amount), decimals]),
  });
  const instructions = [
    createAtaIdempotentIx({ payer: owner, ata: destinationAta, owner: recipient, mint: mintAddress, tokenProgram }),
    transfer,
  ];
  if (closeSource) instructions.push(closeAccountIx({ account: sourceAta, destination: owner, owner, tokenProgram }));
  const tx = buildUnsignedTransaction({ payer: owner, blockhash: requireBlockhash(blockhash), computeUnitLimit, priorityFeeLamports, instructions });
  const shown = `${rawToUnits(amount, decimals)} ${symbol ?? short(mintAddress)}`;
  return Object.freeze({
    purpose, txBase64: toBase64(tx.serialize()), from: owner, to: recipient, mint: mintAddress, amountRaw: amount.toString(), decimals,
    tokenProgram, sourceAta, destinationAta, ataProgram: ATA_PROGRAM, closesSource: closeSource === true,
    summary: purpose === "fund_token"
      ? `FUND the autopilot wallet ${short(recipient)} with ${shown}`
      : `SWEEP ${shown} from the autopilot wallet ${short(owner)} to ${short(recipient)}${closeSource ? ", closing the emptied account" : ""}`,
  });
}

function closeAccountIx({ account, destination, owner, tokenProgram }) {
  return new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([SPL_CLOSE_ACCOUNT_INSTRUCTION]),
  });
}

/** Session wallet → Phantom, for a token the lane still holds (a curve that graduated,
 *  a sell that never landed, a stock it was funded with): an idempotent create of the
 *  destination's ATA, then TransferChecked (instruction 12: [12, u64 amount LE, u8
 *  decimals]; source ATA, mint, destination ATA, owner as signer), which both the classic
 *  token program and Token-2022 accept for every account — including the xStock accounts
 *  a plain Transfer is refused on. `closeSource` appends CloseAccount on the emptied
 *  source so its rent comes back to the session wallet and leaves with the SOL sweep.
 *  A Token-2022 mint with a LIVE transfer hook needs the hook program's extra accounts
 *  resolved and appended, which this builder does not do: it refuses when `transferHook`
 *  is set. Sell such a token by hand from the exported key. */
export function buildTokenSweepTransaction({
  from, to, mint, amountRaw, tokenProgram, decimals, blockhash, computeUnitLimit = 60_000, priorityFeeLamports = 0, transferHook = false,
  closeSource = false, symbol = null,
} = {}) {
  return buildTokenTransfer({ purpose: "sweep_token", from, to, mint, amountRaw, tokenProgram, decimals, blockhash, computeUnitLimit, priorityFeeLamports, transferHook, closeSource, symbol });
}

/** Phantom → session wallet, for a stock the lane may pay in: the same TransferChecked,
 *  the session wallet's account created by Phantom if missing. One Phantom approval. */
export function buildTokenFundTransaction({
  from, to, mint, amountRaw, tokenProgram, decimals, blockhash, computeUnitLimit = 60_000, priorityFeeLamports = 0, transferHook = false, symbol = null,
} = {}) {
  return buildTokenTransfer({ purpose: "fund_token", from, to, mint, amountRaw, tokenProgram, decimals, blockhash, computeUnitLimit, priorityFeeLamports, transferHook, closeSource: false, symbol });
}

/** Close token accounts the session wallet holds at zero balance — the launch-token
 *  accounts every buy creates and every sell leaves empty — so their rent (about 0.002
 *  SOL each) comes back to it before the SOL sweep. At most eight per transaction. */
export const MAX_CLOSES_PER_TRANSACTION = 8;
export function buildCloseTokenAccountsTransaction({ owner, accounts, blockhash, computeUnitLimit = 40_000, priorityFeeLamports = 0 } = {}) {
  let ownerKey;
  try { ownerKey = new PublicKey(owner); } catch { throw new SessionWalletError("bad_account", `"${owner}" is not a public key`); }
  if (!Array.isArray(accounts) || accounts.length === 0) throw new SessionWalletError("nothing_to_close", "no empty token accounts to close");
  if (accounts.length > MAX_CLOSES_PER_TRANSACTION)
    throw new SessionWalletError("too_many", `at most ${MAX_CLOSES_PER_TRANSACTION} accounts per transaction, got ${accounts.length}`);
  const instructions = accounts.map(({ address, tokenProgram }) => {
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM)
      throw new SessionWalletError("bad_token_program", `"${tokenProgram}" is neither the token program nor Token-2022`);
    try { new PublicKey(address); } catch { throw new SessionWalletError("bad_account", `"${address}" is not a token account address`); }
    return closeAccountIx({ account: address, destination: ownerKey.toBase58(), owner: ownerKey.toBase58(), tokenProgram });
  });
  const tx = buildUnsignedTransaction({ payer: ownerKey.toBase58(), blockhash: requireBlockhash(blockhash), computeUnitLimit, priorityFeeLamports, instructions });
  return Object.freeze({
    purpose: "close_empty", txBase64: toBase64(tx.serialize()), owner: ownerKey.toBase58(), accounts: accounts.map((a) => a.address),
    summary: `CLOSE ${accounts.length} empty token account${accounts.length === 1 ? "" : "s"} of the autopilot wallet ${short(ownerKey.toBase58())}; their rent returns to it`,
  });
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
