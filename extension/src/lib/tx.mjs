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
 * transaction's own balance arrays rather than from anything the lane expected.
 */
import {
  ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ATA_PROGRAM, associatedTokenAddress } from "../shims/jupiter.mjs";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export { associatedTokenAddress, ATA_PROGRAM };

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

/** Port of executor/snipe-execute.mjs fillFromTransaction: the fill as the chain records it. */
export function fillFromTransaction(tx, { wallet, mint, side }) {
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
  const amountFor = (list) => {
    let total = 0n;
    for (const b of list ?? []) {
      if (b?.mint === mint && b?.owner === wallet && b?.uiTokenAmount?.amount != null) total += BigInt(b.uiTokenAmount.amount);
    }
    return total;
  };
  const baseBefore = amountFor(meta.preTokenBalances);
  const baseAfter = amountFor(meta.postTokenBalances);
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
