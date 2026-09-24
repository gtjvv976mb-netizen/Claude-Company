/**
 * WHAT THE VENUE NEEDS FROM jupiter.mjs, AND NOTHING ELSE.
 *
 * executor/jupiter.mjs is the desk executor's whole Jupiter path — 150 KB that imports
 * the SQLite journal and the exit ruler. The pump.fun venue and the venue contract import
 * exactly one thing from it: the wrapped-SOL mint address. Bundling the real file for
 * that would drag `node:sqlite` into a browser and fail the build, so build.mjs points
 * every `./jupiter.mjs` import at this file instead.
 *
 * The values are copied verbatim from Claude-Company's executor/jupiter.mjs (:23 and :53)
 * and pinned by test-hawk-bundle.mjs against the literals it carries — the real module is
 * not vendored, so a drift upstream shows on the next sync, not here. This same file is
 * also written to vendor/executor/jupiter.mjs by the sync, as the stand-in Node imports.
 */
import { PublicKey } from "@solana/web3.js";

export const WSOL = "So11111111111111111111111111111111111111112";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export function associatedTokenAddress(wallet, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync([
    new PublicKey(wallet).toBuffer(),
    new PublicKey(tokenProgram).toBuffer(),
    new PublicKey(mint).toBuffer(),
  ], new PublicKey(ATA_PROGRAM))[0].toBase58();
}
