// Solana addresses and signatures are base58 (Bitcoin alphabet). Decoding them is the
// only thing standing between an address string and the 32 raw bytes ed25519 needs.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decode(str) {
  if (typeof str !== "string" || str.length === 0) throw new Error("base58: empty");
  // Must start empty. Seeding with [0] adds a spurious leading zero byte, which only
  // shows up on addresses that begin with '1' (i.e. real leading zero bytes) — the
  // all-zero System Program address decoded to 33 bytes instead of 32.
  const bytes = [];
  for (const ch of str) {
    const v = MAP.get(ch);
    if (v === undefined) throw new Error(`base58: bad character ${JSON.stringify(ch)}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // leading '1's are leading zero bytes
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function encode(buf) {
  const bytes = [...buf];
  const digits = [];      // empty, not [0] — same spurious-leading-zero trap as decode
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
  return out + digits.reverse().map((d) => ALPHABET[d]).join("");
}

/** A Solana address is 32 bytes and round-trips through base58. */
export function isAddress(s) {
  try { return typeof s === "string" && s.length >= 32 && s.length <= 44 && decode(s).length === 32; }
  catch { return false; }
}
