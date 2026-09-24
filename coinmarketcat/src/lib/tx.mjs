/**
 * THE BYTES PHANTOM IS ASKED TO SIGN, AND THE FILL READ BACK FROM THE CHAIN.
 *
 * Assembly mirrors executor/snipe-execute.mjs exactly: a compute-unit limit, a compute
 * price derived from the same lamport budget the fee gate judged, an idempotent
 * associated-token-account create on a buy, then the venue's own buy_v2 / sell_v2 — the
 * instruction the entry contract already decoded back and matched to its plan. Nothing is
 * rebuilt between the check and the signature request.
 *
 * `fillFromTransaction` is a port of the executor's, reading the fill from the confirmed
 * transaction's own balance arrays rather than from anything the lane expected. On a
 * curve quoted in a token (a pump.fun Custom Pair priced in an xStock such as GLDx) the
 * quote leg is read from the wallet's token balances of that mint, and the wallet's
 * lamports must have moved by the network fee and rent and nothing else.
 */
import {
  ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ATA_PROGRAM, WSOL, associatedTokenAddress } from "../shims/jupiter.mjs";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export { associatedTokenAddress, ATA_PROGRAM, WSOL };

export class TxError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "TxError";
    this.clause = clause;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export function createAtaIdempotentIx({ payer, ata, owner, mint, tokenProgram }) {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function toTransactionInstruction(ix) {
  if (!isPlainObject(ix) || !ix.programId || !Array.isArray(ix.keys))
    throw new TxError("malformed", "the venue instruction has no program id or key list");
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner === true, isWritable: k.isWritable === true })),
    data: Buffer.from(ix.data),
  });
}

/** Micro-lamports per compute unit that spend `priorityFeeLamports` over `computeUnitLimit`. */
export function computeUnitPriceFor({ priorityFeeLamports, computeUnitLimit }) {
  const total = Number(priorityFeeLamports);
  const units = Number(computeUnitLimit);
  if (Number.isFinite(total) && total > 0 && units > 0) return Math.max(1, Math.round((total * 1_000_000) / units));
  return 1;
}

/** The chain's per-signature base fee, in lamports. */
export const SIGNATURE_FEE_LAMPORTS = 5_000;
/**
 * The rent-exempt minimum of a system account holding 0 data bytes at the current rate
 * (3,480 lamports per byte-year, two years, over 0 + 128 overhead bytes = 890,880), as
 * `getMinimumBalanceForRentExemption(0)` returns it on mainnet. A wallet that pays for a
 * transaction must end it at 0 or at least this; anything between is InsufficientFundsForRent.
 * The session wallet's sweep leaves exactly this behind, and the lane's autopilot balance
 * check keeps it out of every buy.
 */
export const RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS = 890_880;

/**
 * What the chain charges for a transaction built by buildUnsignedTransaction: the base fee
 * per signature plus the prioritization fee, ceil(price × limit / 10^6), at the compute
 * price this file derives. Exact, so a sweep can move a balance to the lamport.
 */
export function transactionFeeLamports({ computeUnitLimit, priorityFeeLamports = 0, signatures = 1 }) {
  const price = BigInt(computeUnitPriceFor({ priorityFeeLamports, computeUnitLimit }));
  const limit = BigInt(Number(computeUnitLimit));
  const priority = (price * limit + 999_999n) / 1_000_000n;
  return BigInt(SIGNATURE_FEE_LAMPORTS) * BigInt(signatures) + priority;
}

/** An unsigned v0 transaction: budget, price, then the instructions given. */
export function buildUnsignedTransaction({ payer, blockhash, instructions, computeUnitLimit, priorityFeeLamports }) {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: Number(computeUnitLimit) }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceFor({ priorityFeeLamports, computeUnitLimit }) }),
      ...instructions,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
export const fromBase64 = (text) => new Uint8Array(Buffer.from(String(text), "base64"));

/** The signature (base58) a signed VersionedTransaction carries. */
export function signatureOf(signedBytes) {
  const tx = VersionedTransaction.deserialize(signedBytes);
  const sig = tx.signatures?.[0];
  if (!sig || sig.every((b) => b === 0)) throw new TxError("unsigned", "the transaction that came back carries no signature");
  return bs58encode(sig);
}

/** Two transactions are the same request when their messages are byte-identical: the
 *  wallet may add its signature and nothing else. */
export function sameMessage(unsignedBytes, signedBytes) {
  const a = VersionedTransaction.deserialize(unsignedBytes).message.serialize();
  const b = VersionedTransaction.deserialize(signedBytes).message.serialize();
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const byte of bytes) { if (byte === 0) out += ALPHABET[0]; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** The token amount a base64 SPL token account holds, or null when it is not one. */
export function tokenAmountOf(account, { mint = null, owner = null } = {}) {
  if (!account) return null;
  const data = account.data;
  let buf;
  try {
    buf = Array.isArray(data) ? Buffer.from(data[0], data[1] || "base64")
      : typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data ?? []);
  } catch { return null; }
  if (buf.length < 72) return null;
  if (mint && new PublicKey(buf.subarray(0, 32)).toBase58() !== mint) return null;
  if (owner && new PublicKey(buf.subarray(32, 64)).toBase58() !== owner) return null;
  return buf.readBigUInt64LE(64);
}

/**
 * Port of executor/snipe-execute.mjs fillFromTransaction: the fill as the chain records it.
 *
 * `quoteMint`/`quoteDecimals` name the token a Custom Pair curve is quoted in. Absent (or
 * wrapped SOL) the SOL path below runs exactly as it always has. Present, the quote leg is
 * the wallet's token-balance delta in that mint, every balance entry for it must carry the
 * decimals the lane read from the mint account, and the wallet's lamports must have moved
 * by the fee plus the rent of accounts this transaction created and not one lamport more:
 * an unexplained native drain on a token-quoted trade is refused by name rather than
 * booked as a fee nobody can account for.
 */
export function fillFromTransaction(tx, { wallet, mint, side, quoteMint = null, quoteDecimals = null }) {
  const meta = tx?.meta;
  if (!meta) throw new TxError("malformed", "the transaction has no meta");
  if (meta.err) throw new TxError("failed_on_chain", `the transaction landed and failed: ${JSON.stringify(meta.err)}`);
  const pre = meta.preBalances, post = meta.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || !pre.length)
    throw new TxError("malformed", "the transaction has no balance arrays");
  const fee = BigInt(meta.fee ?? 0);
  const payerDelta = BigInt(pre[0]) - BigInt(post[0]);
  let rent = 0n;
  for (let i = 1; i < pre.length; i++) {
    const before = BigInt(pre[i]), after = BigInt(post[i]);
    if (before === 0n && after > 0n) rent += after;
  }
  const amountFor = (list, m = mint) => {
    let total = 0n;
    for (const b of list ?? []) {
      if (b?.mint === m && b?.owner === wallet && b?.uiTokenAmount?.amount != null) total += BigInt(b.uiTokenAmount.amount);
    }
    return total;
  };
  const baseBefore = amountFor(meta.preTokenBalances);
  const baseAfter = amountFor(meta.postTokenBalances);
  if (quoteMint && quoteMint !== WSOL) return tokenQuotedFill({ meta, side, wallet, quoteMint, quoteDecimals, fee, rent, payerDelta, baseBefore, baseAfter, amountFor, slot: tx.slot });
  if (side === "buy") {
    const qtyRaw = baseAfter - baseBefore;
    if (qtyRaw <= 0n) throw new TxError("malformed", "the buy delivered no base tokens to the wallet");
    const spent = payerDelta;
    const quoteIn = spent - fee - rent;
    if (quoteIn <= 0n) throw new TxError("malformed", `the buy spent ${spent} lamports but fee ${fee} plus rent ${rent} leaves no swap input`);
    return Object.freeze({ side, qtyRaw: qtyRaw.toString(), spentLamports: spent.toString(), feeLamports: fee.toString(),
      rentLamports: rent.toString(), quoteInRaw: quoteIn.toString(), slot: Number(tx.slot) || null });
  }
  const sold = baseBefore - baseAfter;
  if (sold <= 0n) throw new TxError("malformed", "the sell moved no base tokens out of the wallet");
  const gross = (-payerDelta) + fee;
  if (gross <= 0n) throw new TxError("malformed", "the sell returned no SOL to the wallet");
  return Object.freeze({ side, qtyRaw: sold.toString(), quoteOutRaw: gross.toString(), feeLamports: fee.toString(),
    rentLamports: rent.toString(), slot: Number(tx.slot) || null });
}

/** The fill of a trade quoted in a token: both legs are token-balance deltas, and the
 *  lamports that left the wallet are the fee and the rent, exactly. */
function tokenQuotedFill({ meta, side, wallet, quoteMint, quoteDecimals, fee, rent, payerDelta, baseBefore, baseAfter, amountFor, slot }) {
  if (quoteDecimals !== null && quoteDecimals !== undefined) {
    for (const list of [meta.preTokenBalances, meta.postTokenBalances]) {
      for (const b of list ?? []) {
        if (b?.mint !== quoteMint || b?.owner !== wallet) continue;
        const d = b?.uiTokenAmount?.decimals;
        if (d !== quoteDecimals)
          throw new TxError("malformed", `a ${quoteMint} balance entry says ${d} decimals, not the ${quoteDecimals} the mint account says`);
      }
    }
  }
  const quoteBefore = amountFor(meta.preTokenBalances, quoteMint);
  const quoteAfter = amountFor(meta.postTokenBalances, quoteMint);
  const explained = fee + rent;
  if (payerDelta !== explained)
    throw new TxError("malformed", `lamports left the wallet beyond fee and rent on a token-quoted ${side}: ` +
      `${payerDelta} moved against ${fee} fee plus ${rent} rent`);
  const common = { quoteMint, quoteDecimals: quoteDecimals ?? null, feeLamports: fee.toString(), rentLamports: rent.toString(),
    spentLamports: explained.toString(), slot: Number(slot) || null };
  if (side === "buy") {
    const qtyRaw = baseAfter - baseBefore;
    if (qtyRaw <= 0n) throw new TxError("malformed", "the buy delivered no base tokens to the wallet");
    const quoteIn = quoteBefore - quoteAfter;
    if (quoteIn <= 0n) throw new TxError("malformed", `the buy took no ${quoteMint} tokens from the wallet`);
    return Object.freeze({ side, qtyRaw: qtyRaw.toString(), quoteInRaw: quoteIn.toString(), ...common });
  }
  const sold = baseBefore - baseAfter;
  if (sold <= 0n) throw new TxError("malformed", "the sell moved no base tokens out of the wallet");
  const quoteOut = quoteAfter - quoteBefore;
  if (quoteOut <= 0n) throw new TxError("malformed", `the sell returned no ${quoteMint} tokens to the wallet`);
  return Object.freeze({ side, qtyRaw: sold.toString(), quoteOutRaw: quoteOut.toString(), ...common });
}

/**
 * A decimal amount in a token's own units, as its raw integer — exactly, through the
 * decimal string, never through a float multiply. More precision than the mint carries
 * is refused rather than rounded: "0.123456789 GLDx" at eight decimals is not a number of
 * GLDx the chain can move.
 */
export function unitsToRaw(units, decimals, label = "amount") {
  if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18))
    throw new TxError("bad_decimals", `${label}: decimals ${JSON.stringify(decimals)} is outside 0..18`);
  const n = typeof units === "number" ? units : Number(units);
  if (!Number.isFinite(n) || n < 0) throw new TxError("bad_amount", `${label} must be a non-negative number, got ${JSON.stringify(units)}`);
  let text = typeof units === "string" ? units.trim() : String(units);
  if (/e/i.test(text)) text = n.toFixed(Math.min(20, decimals + 2));
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new TxError("bad_amount", `${label} is not a plain decimal: ${JSON.stringify(units)}`);
  const whole = m[1] || "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new TxError("bad_amount", `${label} ${text} has more precision than the mint's ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** A raw integer as a decimal string in the token's own units, exact: 5000000 at 8 is "0.05". */
export function rawToUnits(raw, decimals) {
  const big = BigInt(raw);
  const neg = big < 0n;
  const s = (neg ? -big : big).toString().padStart(decimals + 1, "0");
  const whole = decimals === 0 ? s : s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? "" : s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
