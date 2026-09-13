/**
 * THE TOKEN LOGO, UNDER THE DESK'S ORIGIN (owner, 2026-09-13: "put the logo image before
 * the name of the token" on BIG C's board).
 *
 * The walls are WebGL canvases. A cross-origin image with no CORS header taints the
 * canvas and WebGL refuses the upload, and the DexScreener CDN the calls point at sends
 * no such header — so the desk serves the logo itself. This test starts the real
 * office on a throwaway database, stubs only the upstream fetch, and proves: the route
 * serves a published call's art with the CORS and cache headers, from cache on the
 * second ask; refuses a mint the desk never published, and a URL on a host the
 * scanner does not use; answers 502 on an upstream failure with nothing cached, and
 * serves the stale copy when there is one. Then the board's own drawing is pinned.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-logo-proxy-" + process.pid + ".db");
import assert from "node:assert/strict";
import { once } from "node:events";
import db from "./src/lib/store.js";
import { startOffice } from "./src/office.js";

const MINT = "So11111111111111111111111111111111111111112";       // any valid base58 key
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FOREIGN = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cfc00000030101007e9dd6e40000000049454e44ae426082", "hex");

db.prepare(`INSERT INTO calls (mint, symbol, status, opened_at, image_url) VALUES (?, ?, 'closed', ?, ?)`)
  .run(MINT, "LOGO", Date.now(), "https://cdn.dexscreener.com/cms/images/abc?width=800&height=800&quality=95&format=auto");
db.prepare(`INSERT INTO calls (mint, symbol, status, opened_at, image_url) VALUES (?, ?, 'closed', ?, ?)`)
  .run(FOREIGN, "ELSE", Date.now(), "https://evil.example/steal.png");

/* Only the upstream is stubbed; requests to the office go through the real fetch. */
const realFetch = globalThis.fetch;
let upstreamCalls = 0, upstreamMode = "ok";
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof URL ? input.href : input);
  if (!/^https:\/\/cdn\.dexscreener\.com\//.test(url)) return realFetch(input, init);
  upstreamCalls++;
  if (upstreamMode === "down") throw new Error("upstream unreachable");
  assert.match(url, /width=96&height=96&quality=85/, "the desk asks the CDN for the small rendition");
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
};

const { server: office } = startOffice(0);
await once(office, "listening");
const BASE = `http://127.0.0.1:${office.address().port}`;
try {
  const first = await realFetch(`${BASE}/api/logo/${MINT}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.equal(first.headers.get("access-control-allow-origin"), "*", "the wall's canvas must be allowed to use it");
  assert.match(first.headers.get("cache-control") || "", /max-age=3600/);
  assert.equal(Buffer.compare(Buffer.from(await first.arrayBuffer()), PNG), 0, "the bytes are the CDN's");
  assert.equal(upstreamCalls, 1);

  const second = await realFetch(`${BASE}/api/logo/${MINT}`);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 1, "the second ask is served from the hour cache");

  const unknown = await realFetch(`${BASE}/api/logo/${OTHER}`);
  assert.equal(unknown.status, 404, "a mint the desk never published has no logo here");
  const foreign = await realFetch(`${BASE}/api/logo/${FOREIGN}`);
  assert.equal(foreign.status, 404, "a URL on a host the scanner does not use is never fetched");
  const garbage = await realFetch(`${BASE}/api/logo/not-a-mint`);
  assert.notEqual(garbage.status, 200, "the route matches only a base58 key");
  assert.equal(upstreamCalls, 1, "none of those touched upstream");

  upstreamMode = "down";
  const stale = await realFetch(`${BASE}/api/logo/${MINT}`);
  assert.equal(stale.status, 200, "…and the cached copy is still served while upstream is down");
  db.prepare(`INSERT INTO calls (mint, symbol, status, opened_at, image_url) VALUES (?, ?, 'closed', ?, ?)`)
    .run(OTHER, "COLD", Date.now(), "https://cdn.dexscreener.com/cms/images/xyz?width=800&height=800");
  const cold = await realFetch(`${BASE}/api/logo/${OTHER}`);
  assert.equal(cold.status, 502, "with nothing cached, an upstream failure is a 502, not a blank 200");
} finally {
  office.close();
  globalThis.fetch = realFetch;
}

/* The board draws it before the name. */
const viewer = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
assert.match(viewer, /img\.crossOrigin = "anonymous";/, "the board loads the logo CORS-clean so the canvas stays uploadable");
assert.match(viewer, /"\/api\/logo\/" \+ encodeURIComponent\(mint\)/, "…from the desk's own route");
assert.match(viewer, /drawTokenMark\(x, p\.mint, p\.symbol, 36, py\);\n\s*text\(String\(p\.symbol/, "the logo is drawn, then the symbol, on every live-trade row");
assert.match(viewer, /drawTokenMark\(x, last\.mint, last\.symbol, 122, 378, 10\);/, "…and before the last sale");
assert.match(viewer, /x\.fillText\(String\(symbol \|\| mint \|\| "\?"\)\.slice\(0, 1\)\.toUpperCase\(\), cx, cy \+ 1\);/, "a token with no art gets its initial in a disc");
assert.match(viewer, /img\.onload = \(\) => \{ bossLogos\.set\(mint, img\); try \{ drawBossBoard\(\); \} catch \{\} \};/, "a logo that arrives redraws the wall");

console.log("\nthe token logo is served under the desk's origin and drawn before the name on BIG C's board\n");
