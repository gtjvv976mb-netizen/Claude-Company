import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("./", import.meta.url);
const html = fs.readFileSync(new URL("viewer/index.html", root), "utf8");
const build = fs.readFileSync(new URL("scripts/build-viewer.mjs", root), "utf8");
const office = fs.readFileSync(new URL("src/office.js", root), "utf8");
const vendor = new URL("viewer/vendor/wc/", root);

/* ── THE BUNDLE IS OURS, NOT A CDN'S ──────────────────────────────────────────
 * The whole reason the WalletConnect graph is committed here is that the connect
 * button must not stop working because a third-party host had a bad minute. One
 * surviving absolute import puts the wallet door back on someone else's uptime,
 * silently — the page looks fine until the moment a person tries to connect. */
{
  const files = fs.readdirSync(vendor).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.includes("universal-provider.mjs"), "the provider bundle is vendored");
  assert.ok(files.includes("qrcode-generator.mjs"), "the QR encoder is vendored");
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, vendor), "utf8");
    const external = [...src.matchAll(/(?:from|import)\s*"([^"]+)"/g)]
      .map((m) => m[1]).filter((s) => !s.startsWith("./"));
    assert.deepEqual(external, [], `${f} still imports from outside the vendored folder`);
  }
  assert.match(html, /import\("\.\/vendor\/wc\/universal-provider\.mjs"\)/,
    "the provider is imported lazily, by relative path, from the vendored copy");
  assert.doesNotMatch(html, /cdn\.jsdelivr|esm\.sh|unpkg\.com/,
    "no CDN is on the connect path");
}

/* ── AN EXTENSION'S ICON IS UNTRUSTED INPUT ───────────────────────────────────
 * walletIcon renders a string handed over by a browser extension. Built through
 * innerHTML, a wallet supplying a raw svg data uri containing a quote closes the
 * src attribute and injects markup into the gateway — measured, with an icon of
 * data:image/svg+xml,<svg xmlns="..."/> rendering its own closing quote as the
 * button label. It is built with DOM calls now, and the scheme test is narrow. */
{
  const fn = html.slice(html.indexOf("function walletIcon"), html.indexOf("function offer"));
  assert.doesNotMatch(fn, /innerHTML/, "walletIcon never builds markup from an extension string");
  assert.match(fn, /document\.createElement\("img"\)/, "the icon is a real element");
  assert.match(fn, /\^data:image\\\/\|\^https:/, "only image data uris and https are accepted as icons");
  const offer = html.slice(html.indexOf("function offer"), html.indexOf("/* ── WALLETCONNECT"));
  assert.doesNotMatch(offer, /innerHTML\s*=\s*walletIcon/,
    "the picker button is assembled from nodes, not from a concatenated string");
  assert.match(offer, /label\.textContent = w\.name/, "the wallet's name is set as text, never parsed");
}

/* ── A DEAD RELAY MUST SAY SO ─────────────────────────────────────────────────
 * MEASURED: with a project id the relay does not recognise, the socket closes
 * with code 3000 ("Project not found") and the SDK RETRIES FOREVER — connect()
 * never rejects. Without a deadline the button sat disabled under "Opening
 * WalletConnect…" indefinitely, telling the reader nothing. An id can be absent,
 * mistyped or past its quota, so this is a live failure mode. */
{
  assert.match(html, /Promise\.race\(\[\s*p\.connect\(\{ optionalNamespaces: ns \}\)/,
    "the pairing is raced against a deadline");
  assert.match(html, /if\(!gotUri\) reject\(new Error\("its relay did not answer/,
    "...and a deadline that fires before any QR appears names the cause");
  assert.match(html, /gotUri = true; clearTimeout\(deadline\)/,
    "once the QR is up the reader gets as long as they like to scan");
  assert.match(html, /if\(!gotUri && p\)\{ try\{ p\.abortPairingAttempt/,
    "a timed-out pairing stops retrying instead of running on behind the error");
}

/* ── NO ID, NO OPTION, NOTHING ELSE CHANGES ───────────────────────────────────
 * The project id is public by design — it names the app to the relay and
 * authorises nothing — but it is injected, so a fork builds with its own and an
 * unconfigured build offers exactly the page it offered before. */
{
  assert.match(html, /var WC_ID = String\(window\.__WC_PROJECT_ID__ \|\| ""\)\.trim\(\);/);
  assert.match(html, /function wcEntry\(\)\{ return WC_ID \? \[\{ name:"WalletConnect"/,
    "the option exists only when an id was built in");
  for (const list of ["return out.concat(wcEntry());"])
    assert.equal((html.match(new RegExp(list.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 2,
      "both the Solana and the EVM discovery lists offer it");
  assert.match(html, /if\(w\.wc\) return wcConnect\("sol"\)/);
  assert.match(html, /if\(w\.wc\) return wcConnect\("rh"\)/);
  assert.match(build, /const WC_PROJECT_ID = String\(process\.env\.WC_PROJECT_ID \|\| ""\)\.trim\(\)/);
  assert.match(build, /if \(WC_PROJECT_ID\) \{[\s\S]*?window\.__WC_PROJECT_ID__=/,
    "an empty id injects nothing at all");
}

/* ── THE VENDORED FILES REACH THE PUBLISHED SITE AND THE DEV SERVER ───────────
 * Served as text/plain, a module import is refused on MIME grounds and the
 * failure looks like a broken wallet rather than a wrong header. */
{
  assert.match(build, /fs\.cpSync\(vendorSrc, path\.join\(OUT, "vendor"\), \{ recursive: true \}\)/,
    "the build copies the vendored graph into dist");
  assert.match(office, /if \(url\.pathname\.startsWith\("\/vendor\/"\)\)/,
    "the dev server serves it too, so local does not drift from live");
  assert.match(office, /\/\\\.m\?js\$\/\.test\(vf\)\s*\?\s*"text\/javascript; charset=utf-8"/,
    "...as JavaScript");
  assert.match(office, /!vf\.startsWith\(base \+ path\.sep\)/,
    "and never above the vendored folder");
}

/* Robinhood Chain is OPTIONAL, never required: a required namespace a wallet does
 * not carry is a flat rejection at the door, and almost no wallet has 4663. */
assert.match(html, /optionalNamespaces: ns/);
assert.doesNotMatch(html, /requiredNamespaces/);
assert.match(html, /chains:\["eip155:4663","eip155:1"\]/);
assert.match(html, /solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/, "Solana mainnet-beta by its genesis hash");

console.log("walletconnect: vendored, injection-safe, deadlined, and inert without an id");
