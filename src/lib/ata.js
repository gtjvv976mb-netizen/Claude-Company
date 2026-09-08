import { createHash } from "node:crypto";
import { decode, encode } from "./base58.js";

/**
 * THE ASSOCIATED TOKEN ADDRESS, DERIVED WITHOUT A DEPENDENCY.
 *
 * The desk wants to look at ONE account per coin — the creator's own token account — and
 * the chain does not index "the creator's balance of this mint"; it has to be asked by
 * address. That address is a program-derived one: sha256 over (owner, token program,
 * mint, bump, ATA program, "ProgramDerivedAddress"), taking the first bump from 255 down
 * whose hash is NOT a valid ed25519 point. The executor does this through
 * @solana/web3.js (executor/jupiter.mjs associatedTokenAddress); the hosted desk does
 * not carry that package and should not for one hash, so the two pieces of arithmetic it
 * needs are written out here: the hash, and the curve test.
 *
 * The curve test is the decompression in RFC 8032 §5.1.3 with the acceptance rule
 * web3.js uses (zip215 — the y coordinate is read with its top bit cleared and reduced,
 * never rejected for being non-canonical), so the two derivations agree on every bump.
 * Checked in test-launch-share-shadow.mjs against four addresses web3.js produced,
 * including a Token-2022 one and one whose first candidate hash landed ON the curve and
 * forced bump 254.
 */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

/* Field arithmetic mod 2^255 - 19. BigInt is slow and this runs at most 256 times per
   derivation, once per coin — measured well under a millisecond per address. */
const P = (1n << 255n) - 19n;
const mod = (a) => { const r = a % P; return r < 0n ? r + P : r; };
const pow = (base, exp) => {
  let r = 1n, b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; }
  return r;
};
const D = mod(-121665n * pow(121666n, P - 2n));      // the curve constant d = -121665/121666

/** Does this 32-byte string decode to a point on ed25519? A PDA is one that does not. */
export function isOnCurve(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = sqrt(u/v) by the p ≡ 5 (mod 8) method; a root exists iff v·x² is ±u.
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  const x = mod(u * v3 * pow(mod(u * v7), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}

/** find_program_address: the first bump from 255 down whose hash is off the curve. */
export function programAddress(seeds, programId) {
  const program = decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(program);
    h.update(PDA_MARKER);
    const digest = h.digest();
    if (!isOnCurve(digest)) return { address: encode(digest), bump };
  }
  return null;
}

/** The owner's associated token account for a mint under the given token program. */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return programAddress([decode(owner), decode(tokenProgram), decode(mint)], ATA_PROGRAM);
}
