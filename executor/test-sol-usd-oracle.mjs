import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_CACHE_SOURCE, PYTH_SOL_USD_FEED_ID,
  independentSolUsdPrice, parsePythSolUsdAccount, usableSolUsdCache,
} from "./sol-usd-oracle.mjs";

const DISC = Buffer.from("22f123639d7ef4cd", "hex");
const OWNER = new PublicKey(PYTH_RECEIVER_PROGRAM);
const nowMs = 1_788_264_000_000;

function account({ price = 10_200_000_000n, conf = 1_000_000n, exponent = -8,
  publishTime = Math.floor(nowMs / 1_000) - 30, owner = OWNER, full = true,
  feed = PYTH_SOL_USD_FEED_ID, trailing = 0 } = {}) {
  const bytes = Buffer.alloc(134);
  DISC.copy(bytes, 0);
  // write authority bytes 8..39 intentionally do not matter to a read-only consumer.
  bytes[40] = full ? 1 : 0;
  let offset = 41;
  if (!full) bytes[offset++] = 5;
  Buffer.from(feed, "hex").copy(bytes, offset); offset += 32;
  bytes.writeBigInt64LE(price, offset); offset += 8;
  bytes.writeBigUInt64LE(conf, offset); offset += 8;
  bytes.writeInt32LE(exponent, offset); offset += 4;
  bytes.writeBigInt64LE(BigInt(publishTime), offset); offset += 8;
  bytes.writeBigInt64LE(BigInt(publishTime - 1), offset); offset += 8;
  bytes.writeBigInt64LE(price, offset); offset += 8;
  bytes.writeBigUInt64LE(conf, offset); offset += 8;
  bytes.writeBigUInt64LE(443_000_000n, offset);
  bytes[133] = trailing;
  return { owner, data: bytes };
}

const parsed = parsePythSolUsdAccount(account(), { nowMs });
assert.equal(parsed.price, 102);
assert.equal(parsed.publishTime, Math.floor(nowMs / 1_000) - 30);
assert.ok(parsed.confidencePct < 0.02);

// A static byte-for-byte sample read from the official sponsored account on
// 2026-09-01. This pins the real Full-variant offsets, including the pad byte.
const real = {
  owner: OWNER,
  data: Buffer.from("IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bUg6yWACAAAAcCoUAAAAAAD4////+L2WagAAAAD3vZZqAAAAAN6t52ECAAAADrETAAAAAAA/BW4aAAAAAAA=", "base64"),
};
const realParsed = parsePythSolUsdAccount(real, { nowMs: 1_788_263_950_000 });
assert.ok(realParsed.price > 102 && realParsed.price < 103);
assert.equal(realParsed.postedSlot, 443_417_919);

assert.throws(() => parsePythSolUsdAccount(account({ owner: PublicKey.default }), { nowMs }), /wrong owner/);
const wrongDisc = account(); wrongDisc.data[0] ^= 0xff;
assert.throws(() => parsePythSolUsdAccount(wrongDisc, { nowMs }), /discriminator/);
assert.throws(() => parsePythSolUsdAccount(account({ full: false }), { nowMs }), /not fully verified/);
assert.throws(() => parsePythSolUsdAccount(account({ feed: "00".repeat(32) }), { nowMs }), /wrong feed/);
assert.throws(() => parsePythSolUsdAccount(account({ trailing: 1 }), { nowMs }), /trailing/);
assert.throws(() => parsePythSolUsdAccount(account({ publishTime: Math.floor(nowMs / 1_000) - 181 }), { nowMs }), /stale/);
assert.throws(() => parsePythSolUsdAccount(account({ publishTime: Math.floor(nowMs / 1_000) + 61 }), { nowMs }), /future/);
assert.throws(() => parsePythSolUsdAccount(account({ conf: 300_000_000n }), { nowMs }), /confidence/);

const connection = (value, rejection = null) => ({
  async getAccountInfo() { if (rejection) throw rejection; return value; },
});
const consensus = await independentSolUsdPrice(connection(account()), connection(account({ price: 10_210_000_000n })), { nowMs });
assert.ok(consensus.price > 102 && consensus.price < 103);
assert.ok(consensus.divergencePct < 1);
assert.equal(consensus.source, "pyth-sol-usd-shard0-v1");
await assert.rejects(() => independentSolUsdPrice(connection(account()), connection(account({ price: 10_400_000_000n })), { nowMs }), /diverge/);
await assert.rejects(() => independentSolUsdPrice(connection(account()), connection(null, new Error("secret endpoint")), { nowMs }),
  /successful reads from both/);
await assert.rejects(() => independentSolUsdPrice(connection(account()), connection(account({ publishTime: Math.floor(nowMs / 1_000) - 200 })), { nowMs }), /rejected.*stale/);

const cache = {
  v: consensus.price,
  ts: nowMs - 10_000,
  publishTime: Math.floor(nowMs / 1_000) - 30,
  source: PYTH_SOL_USD_CACHE_SOURCE,
};
assert.equal(usableSolUsdCache(cache, { nowMs, maxAgeMs: 60_000 }).price, consensus.price);
assert.equal(usableSolUsdCache({ ...cache, publishTime: undefined }, { nowMs, maxAgeMs: 60_000 }), null);
assert.equal(usableSolUsdCache({ ...cache,
  // A fresh local write must not launder an old oracle publication.
  ts: nowMs - 1_000, publishTime: Math.floor(nowMs / 1_000) - 61,
}, { nowMs, maxAgeMs: 60_000 }), null);
assert.equal(usableSolUsdCache({ ...cache, ts: nowMs - 60_001 }, { nowMs, maxAgeMs: 60_000 }), null);
assert.equal(usableSolUsdCache({ ...cache,
  publishTime: Math.floor(nowMs / 1_000) + 1,
}, { nowMs, maxAgeMs: 60_000 }), null);
assert.equal(usableSolUsdCache({ ...cache, source: "legacy-jupiter-sol-usdc" },
  { nowMs, maxAgeMs: 60_000 }), null);

console.log("\nindependent, two-RPC Pyth SOL/USD oracle is fail-closed\n");
