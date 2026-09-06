import assert from "node:assert/strict";
import fs from "node:fs";

/* ── TWO SUBDOMAINS OF ONE PROVIDER ARE ONE PROVIDER ──────────────────────────
 * The live gate compared full hostnames, so us1.alchemy.com and us2.alchemy.com
 * satisfied "SOLANA_RPC_SECONDARY must use an independent provider hostname".
 * Every second opinion the executor buys with that endpoint — the SOL/USD price
 * agreement, the independent mint audit, the independent finalized confirmation —
 * then asks one operator to check itself, and all of them still report success.
 * That is the worst shape a safety check can have: present, passing, and empty.
 *
 * poller.mjs cannot be imported (it fatals at module scope without CC_SECRET), so
 * the function is extracted and evaluated. This tests BEHAVIOUR, not the presence
 * of a string — a regex assertion here would pass against a function that returns
 * its input. */
const src = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");

const suffixes = src.match(/const TWO_PART_SUFFIXES = new Set\(\[[^\]]*\]\);/)?.[0];
const fn = src.match(/export function registrableDomain\(host\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(suffixes && fn, "could not extract registrableDomain from poller.mjs");
const registrableDomain = new Function(
  `${suffixes}\n${fn.replace("export function", "function")}\nreturn registrableDomain;`)();

/* the exact case that motivated this */
assert.equal(registrableDomain("us1.alchemy.com"), registrableDomain("us2.alchemy.com"),
  "two subdomains of one vendor must collapse to the same registrable domain");
assert.notEqual(registrableDomain("solana-mainnet.g.alchemy.com"), registrableDomain("mainnet.helius-rpc.com"),
  "genuinely different vendors must stay different");

for (const [host, want] of [
  ["us1.alchemy.com", "alchemy.com"],
  ["solana-mainnet.g.alchemy.com", "alchemy.com"],
  ["alchemy.com", "alchemy.com"],
  ["MAINNET.Helius-RPC.COM", "helius-rpc.com"],          // case-insensitive
  ["rpc.example.com.", "example.com"],                    // trailing root dot
  ["a.b.c.quicknode.pro", "quicknode.pro"],
  ["x.foo.co.uk", "foo.co.uk"],                           // two-part suffix kept
  ["y.foo.co.uk", "foo.co.uk"],
  ["foo.co.uk", "foo.co.uk"],
  ["localhost", "localhost"],
  ["", ""],
]) assert.equal(registrableDomain(host), want, `registrableDomain(${JSON.stringify(host)})`);

/* co.uk is a public suffix: two DIFFERENT registrants under it are independent */
assert.notEqual(registrableDomain("x.foo.co.uk"), registrableDomain("x.bar.co.uk"),
  "different registrants under a two-part suffix are different providers");

/* and the gate must actually consult it, on top of the hostname equality test */
assert.match(src, /if \(primaryHost === secondaryHost \|\| registrableDomain\(primaryHost\) === registrableDomain\(secondaryHost\)\)/,
  "the live gate must reject a second endpoint at the same registrable domain");
assert.match(src, /fatal\("SOLANA_RPC_SECONDARY must use an independent provider, not another hostname at the same one"\)/);

/* the public endpoint stays refused for both slots */
assert.match(src, /primaryHost === "api\.mainnet-beta\.solana\.com" \|\| secondaryHost === "api\.mainnet-beta\.solana\.com"/);

console.log("rpc independence: judged on the registrable domain, 13 host cases verified");
