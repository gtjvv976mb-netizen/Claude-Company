// Produce self-contained pages: the published artifact CSP forbids any external fetch,
// so three.js is inlined rather than served from /vendor.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inlineThree } from "./inline-three.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const VIEWER = path.join(ROOT, "viewer");
const OUT = path.join(ROOT, "dist");

const IMPORT_LINE = /^import \* as THREE from "\/vendor\/three\/three\.module\.js";.*$/m;

// Source pages use the dev server's routes. The static build has no server, so every
// route becomes a plain relative link — which also keeps the site working when GitHub
// Pages hosts it under a /claude-tower/ subpath.
const PAGES = [
  { src: "index.html",    out: "index.html" },
  { src: "tower.html",    out: "tower.html" },
  { src: "office3d.html", out: "floor.html" },
  { src: "buy.html",      out: "buy.html" },
  { src: "404.html",      out: "404.html" },
];
const ASSETS = [
  "claudeco-512.png", "claudeco-256.png", "claudeco-64.png",
  "banner-1500x500.png", "banner-1200x630.png",
];
const SITE_URL = (process.env.SITE_URL || "https://claudedotcompany.com").replace(/\/$/, "");
// Where the API lives. Empty means "same origin", which is right for local dev and wrong
// for a static host — Pages cannot run the scanner or the database.
const API_BASE = (process.env.API_BASE || "").replace(/\/$/, "");

const { source: THREE_SRC, exportCount } = inlineThree();
const THREE_REV = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")
).version;



fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const a of ASSETS) {
  fs.copyFileSync(path.join(ROOT, "token", a), path.join(OUT, "assets", a));
}
fs.copyFileSync(path.join(ROOT, "token", "claudeco-64.png"), path.join(OUT, "assets", "favicon.png"));

// The self-hosted executor, served static so the one-command install resolves.
fs.mkdirSync(path.join(OUT, "executor"), { recursive: true });
for (const f of ["poller.mjs", "install.sh", "executor.mjs", "README.md", "strategy.mjs", "simulate.mjs"]) {
  const src = path.join(ROOT, "executor", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, "executor", f));
}

// GitHub Pages reads dist/CNAME to bind the custom domain.
const cnameSrc = path.join(VIEWER, "CNAME");
if (fs.existsSync(cnameSrc)) fs.copyFileSync(cnameSrc, path.join(OUT, "CNAME"));

const built = [];

for (const { src: name, out } of PAGES) {
  const src = path.join(VIEWER, name);
  if (!fs.existsSync(src)) continue;
  let html = fs.readFileSync(src, "utf8");
  const srcClosers = (html.match(/<\/script/gi) || []).length;

  if (IMPORT_LINE.test(html)) {
    // A replacer FUNCTION, not a string: three's source contains `$'`-style sequences,
    // and String.replace would treat those as substitution patterns and splice the rest
    // of the document back in. That produced a 2x-duplicated, unparseable page.
    const block = `/* ── three.js ${THREE_REV}, inlined (MIT licence) ── */\n${THREE_SRC}\n/* ── end three.js ── */`;
    html = html.replace(IMPORT_LINE, () => block);
  }

  // Any `</script` inside the inlined module would close the element early. Assert the
  // output has no more terminators than the source did — the `$'`-in-replacement bug
  // spliced the whole document back in and doubled them, and this catches that class.
  const closers = (html.match(/<\/script/gi) || []).length;
  if (closers !== srcClosers) {
    throw new Error(`${name}: source had ${srcClosers} </script> but output has ${closers} — inlining corrupted the page`);
  }
  // A visible build stamp, so "am I seeing the new version?" is answerable by
  // anyone in two seconds: view-source or the console, no guessing about caches.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  html = html.replace(/<style>/, () =>
    `<meta name="cc-build" content="${stamp}">\n<script>console.log("Claude Company build ${stamp}")</script>\n<style>`);

  if (API_BASE) {
    html = html.replace(/<style>/, () =>
      `<script>window.__API_BASE__=${JSON.stringify(API_BASE)};</script>\n<style>`);
  }

  // the dev server's routes become relative links
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="assets/favicon.png" type="image/png">');
  html = html.replace(/href="\/tower"/g, 'href="tower.html"');
  html = html.replace(/href="\/floor\/(\d+)"/g, (_, n) => `href="floor.html?floor=${n}"`);
  html = html.replace(/href="\/"(?=[ >])/g, 'href="index.html"');
  html = html.replace(/\/floor\/\$\{f\.n\}/g, "floor.html?floor=${f.n}");   // keep the floor number
  html = html.replace(/\/buy\?floor=\$\{f\.n\}/g, "buy.html?floor=${f.n}");
  // link previews need an absolute image URL; relative is a harmless fallback
  if (SITE_URL) html = html.replace(/content="assets\//g, `content="${SITE_URL}/assets/`);

  // The published-artifact origin has no assets/ directory and its CSP forbids fetching
  // one, so an artifact build carries its images inline.
  if (process.env.INLINE_ASSETS === "1") {
    html = html.replace(/src="assets\/([\w.-]+\.png)"/g, (_, file) => {
      const b64 = fs.readFileSync(path.join(ROOT, "token", file)).toString("base64");
      return `src="data:image/png;base64,${b64}"`;
    });
  }

  // Standalone pages have no server, so the app routes have to point somewhere real.
  // Supply published URLs via env; otherwise the links are left as-is.
  const TOWER = process.env.ARTIFACT_TOWER_URL;
  const FLOOR = process.env.ARTIFACT_FLOOR_URL;
  if (TOWER) html = html.replace(/href="\/tower"/g, () => `href="${TOWER}" target="_blank" rel="noopener"`);
  if (FLOOR) html = html.replace(/href="\/floor\/50"/g, () => `href="${FLOOR}" target="_blank" rel="noopener"`);

  const outPath = path.join(OUT, out);
  fs.writeFileSync(outPath, html);
  built.push({ name: out, bytes: html.length, inlined: !html.includes("/vendor/three/") });
}

console.log(`three namespace entries: ${exportCount}`);
for (const b of built) console.log(`${b.name.padEnd(16)} ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  inlined=${b.inlined}`);
