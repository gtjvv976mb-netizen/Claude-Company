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
];
const ASSETS = [
  "claudeco-512.png", "claudeco-256.png", "claudeco-64.png",
  "banner-1500x500.png", "banner-1200x630.png",
];
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

const { source: THREE_SRC, exportCount } = inlineThree();
const THREE_REV = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")
).version;

// index.html keeps its own small script; the 3D pages have exactly one module each.
const expectedClosers = (name) => (name === "index.html" ? 1 : 1);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const a of ASSETS) {
  fs.copyFileSync(path.join(ROOT, "token", a), path.join(OUT, "assets", a));
}
fs.copyFileSync(path.join(ROOT, "token", "claudeco-64.png"), path.join(OUT, "assets", "favicon.png"));

const built = [];

for (const { src: name, out } of PAGES) {
  const src = path.join(VIEWER, name);
  if (!fs.existsSync(src)) continue;
  let html = fs.readFileSync(src, "utf8");

  if (IMPORT_LINE.test(html)) {
    // A replacer FUNCTION, not a string: three's source contains `$'`-style sequences,
    // and String.replace would treat those as substitution patterns and splice the rest
    // of the document back in. That produced a 2x-duplicated, unparseable page.
    const block = `/* ── three.js ${THREE_REV}, inlined (MIT licence) ── */\n${THREE_SRC}\n/* ── end three.js ── */`;
    html = html.replace(IMPORT_LINE, () => block);
  }

  // Any `</script` inside the module would close the element early. There is none in
  // three today, but assert rather than hope — a silent break here is unparseable HTML.
  const closers = (html.match(/<\/script/gi) || []).length;
  if (closers !== expectedClosers(name)) {
    throw new Error(`${name}: expected ${expectedClosers(name)} </script> but found ${closers} — inlining corrupted the page`);
  }
  // the dev server's routes become relative links
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="assets/favicon.png" type="image/png">');
  html = html.replace(/href="\/tower"/g, 'href="tower.html"');
  html = html.replace(/href="\/floor\/\d+"/g, 'href="floor.html"');
  html = html.replace(/href="\/"(?=[ >])/g, 'href="index.html"');
  html = html.replace(/\/floor\/\$\{f\.n\}/g, "floor.html");        // tower.html directory links
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

  const out = path.join(OUT, name);
  fs.writeFileSync(out, html);
  built.push({ name, bytes: html.length, inlined: !html.includes("/vendor/three/") });
}

console.log(`three namespace entries: ${exportCount}`);
for (const b of built) console.log(`${b.name.padEnd(16)} ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  inlined=${b.inlined}`);
