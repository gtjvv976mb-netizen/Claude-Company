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

const { source: THREE_SRC, exportCount } = inlineThree();
const THREE_REV = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")
).version;

// index.html keeps its own small script; the 3D pages have exactly one module each.
const expectedClosers = (name) => (name === "index.html" ? 1 : 1);

fs.mkdirSync(OUT, { recursive: true });
const built = [];

for (const name of ["office3d.html", "tower.html", "index.html"]) {
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
  // the served favicon route does not exist off-origin
  html = html.replace(/<link rel="icon"[^>]*>\n?/, "");

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
