/**
 * THE ONE NODE BUILT-IN THE SNIPER'S DECISION CODE TOUCHES.
 *
 * executor/token2022.mjs hashes a mint's bytes with `createHash("sha256")` to give the
 * two-RPC consensus a digest to compare. The browser has no `node:crypto`, and
 * SubtleCrypto is asynchronous, which a synchronous `.digest()` cannot wait on. So the
 * bundle swaps this file in for `node:crypto` (build.mjs) and computes SHA-256 with the
 * same @noble/hashes @solana/web3.js already brings along — one algorithm, the one
 * caller needs, and a loud refusal for anything else, so a future import that reaches
 * for `createHash("md5")` fails at the first call rather than hashing wrongly.
 */
import { sha256 } from "@noble/hashes/sha256";

const encoder = new TextEncoder();

function toBytes(data) {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError(`createHash shim: cannot hash a ${typeof data}`);
}

export function createHash(algorithm) {
  const name = String(algorithm).toLowerCase().replace("-", "");
  if (name !== "sha256")
    throw new Error(`createHash shim: only sha256 is available in the browser bundle, not ${algorithm}`);
  const hasher = sha256.create();
  const api = {
    update(data) { hasher.update(toBytes(data)); return api; },
    digest(encoding) {
      const out = hasher.digest();
      if (encoding === undefined) return Buffer.from(out);
      if (encoding === "hex") return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
      if (encoding === "base64") return Buffer.from(out).toString("base64");
      throw new Error(`createHash shim: unsupported digest encoding ${encoding}`);
    },
  };
  return api;
}

export default { createHash };
