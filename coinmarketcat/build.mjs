#!/usr/bin/env node
/**
 * BUILD THE EXTENSION.
 *
 * Six bundles (the worker, the console relay, the injected Phantom bridge, the popup,
 * the options page and the first-run setup page), one manifest, three icons, into ./dist —
 * the folder Chrome loads unpacked. The point of this file is the plugin, not the entry list:
 *
 *   · the engine imports the executor's snipe modules from vendor/executor/, copied
 *     verbatim from a named commit of Claude-Company by scripts/sync-executor.mjs and
 *     hashed in PROVENANCE.json, so the browser runs THE SAME entry contract, curve
 *     arithmetic, buy_v2/sell_v2 encoders and exit determiner WALL-ST-E runs. What
 *     this bot refuses is decided upstream and synced, never edited here.
 *   · two imports in that closure are Node-only. `node:crypto` (token2022's digest)
 *     is redirected to src/shims/node-crypto.mjs; `./jupiter.mjs` (which pulls the
 *     SQLite journal) is redirected to src/shims/jupiter.mjs. Any OTHER `node:` import
 *     that ever creeps into the closure fails the build by name, rather than shipping
 *     a bundle that throws at first use.
 *   · @solana/web3.js, bs58, buffer and @noble/hashes resolve from this repository's
 *     node_modules, pinned to the executor's exact versions, so one copy of web3.js
 *     exists in every bundle and a PublicKey made in one module is a PublicKey in another.
 *
 * Usage: node build.mjs [--watch]   (after `npm ci`)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const SRC = path.join(here, "src");
const DIST = path.join(here, "dist");
const EXECUTOR_MODULES = path.join(ROOT, "node_modules");
const watch = process.argv.includes("--watch");

const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require("esbuild"); }
catch {
  console.error("esbuild is not installed: run `npm ci` here first");
  process.exit(1);
}
if (!fs.existsSync(path.join(EXECUTOR_MODULES, "@solana", "web3.js"))) {
  console.error("the dependencies are not installed: run `npm ci` here first");
  process.exit(1);
}

export const SHIMS = Object.freeze({
  "node:crypto": path.join(SRC, "shims", "node-crypto.mjs"),
  "jupiter.mjs": path.join(SRC, "shims", "jupiter.mjs"),
});

/** The packages the bundle may take from the executor's tree, by name. */
const EXECUTOR_PACKAGES = /^(@solana\/web3\.js|bs58|buffer|@noble\/hashes)(\/.*)?$/;

export const shimPlugin = {
  name: "coinmarketcat-shims",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      const hit = SHIMS[args.path];
      if (hit) return { path: hit };
      return { errors: [{ text: `${args.path} reached the browser bundle from ${args.importer} — ` +
        "a Node built-in with no shim; add one to build.mjs or cut the import" }] };
    });
    build.onResolve({ filter: /(^|\/)jupiter\.mjs$/ }, (args) => {
      if (args.importer.startsWith(SRC)) return null;   // our own files may not import it at all
      return { path: SHIMS["jupiter.mjs"] };
    });
    build.onResolve({ filter: EXECUTOR_PACKAGES }, (args) => {
      /* Let esbuild do the package-exports and "browser"-field walk, but anchored at the
         executor's node_modules so both trees resolve to the same files. build.resolve
         re-enters every onResolve hook, this one included; the pluginData marker is what
         stops that being an infinite loop. */
      if (args.pluginData?.hawkAnchored) return null;
      return build.resolve(args.path, {
        kind: args.kind, resolveDir: ROOT, importer: args.importer,
        pluginData: { hawkAnchored: true },
      });
    });
  },
};

export const ENTRIES = Object.freeze({
  "background.js": "background.mjs",
  "content.js": "content.mjs",
  "injected.js": "injected.mjs",
  "popup.js": "popup/popup.mjs",
  "options.js": "options/options.mjs",
  "welcome.js": "welcome/welcome.mjs",     // the first-run setup page the worker opens on install
});

export const STATIC = Object.freeze([
  ["manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/welcome/welcome.html", "welcome.html"],
  ["src/welcome/welcome.css", "welcome.css"],
]);

/* The icons are the building's own marks, carried here under the bot's name. */
const ICONS = Object.freeze([
  ["icons/coinmarketcat-32.png", "icons/coinmarketcat-32.png"],
  ["icons/coinmarketcat-128.png", "icons/coinmarketcat-128.png"],
  ["icons/coinmarketcat-512.png", "icons/coinmarketcat-512.png"],
]);

export function buildOptions({ outdir = DIST } = {}) {
  return {
    entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([out, src]) => [out.replace(/\.js$/, ""), path.join(SRC, src)])),
    outdir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome116"],
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    inject: [path.join(SRC, "shims", "buffer-inject.mjs")],
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
    nodePaths: [EXECUTOR_MODULES],
    plugins: [shimPlugin],
  };
}

export function copyStatic(outdir = DIST) {
  for (const [from, to] of STATIC) {
    const dest = path.join(outdir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(here, from), dest);
  }
  for (const [from, to] of ICONS) {
    const dest = path.join(outdir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), dest);
  }
}

export async function buildOnce({ outdir = DIST } = {}) {
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  const result = await esbuild.build(buildOptions({ outdir }));
  copyStatic(outdir);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (watch) {
    fs.mkdirSync(DIST, { recursive: true });
    copyStatic(DIST);
    const ctx = await esbuild.context(buildOptions());
    await ctx.watch();
    console.log(`watching ${SRC} → ${DIST}`);
  } else {
    await buildOnce();
    const files = fs.readdirSync(DIST).filter((f) => f.endsWith(".js"));
    for (const f of files) {
      const kb = (fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0);
      console.log(`  ${f.padEnd(16)} ${kb} KB`);
    }
    console.log(`built into ${DIST} — load it unpacked at chrome://extensions`);
  }
}
