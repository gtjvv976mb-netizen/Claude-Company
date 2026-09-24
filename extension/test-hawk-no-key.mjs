/**
 * THE EXTENSION NEVER HOLDS A KEY. This scan is the proof, run on every suite.
 *
 * executor/test-snipe-lane.mjs scans the lane for a key on every run because "the
 * decision code cannot reach a key" is a claim that has to stay true through every
 * edit. The browser lane makes a stronger claim — NOTHING in it can reach one; the only
 * signer is Phantom, behind its own approval window — so the scan covers every source
 * file under src/, and the bundle the user actually loads, when it has been built.
 *
 * What is banned: constructing or importing a Keypair, reading a secret key, deriving a
 * key from a seed or mnemonic, and signing with anything but the bridge. `signTransaction`
 * appears exactly where it should — the bridge request in the engine, the worker's relay,
 * the injected script's call into Phantom — and those three sites are named.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const BANNED = [
  [/\bKeypair\b/, "Keypair"],
  [/secretKey/, "secretKey"],
  [/\bnacl\b|tweetnacl/, "nacl"],
  [/fromSeed|fromSecretKey|fromMnemonic|mnemonicToSeed|bip39|derivePath/, "key derivation"],
  [/\.sign\(\s*\[/, "tx.sign([keypair])"],
  [/signAndSendTransaction/, "signAndSendTransaction (the lane sends through its own RPC)"],
  [/signMessage/, "signMessage (nothing here needs a signed message)"],
  [/signAllTransactions/, "signAllTransactions (one window per trade)"],
];
const ALLOWED_SIGN_SITES = new Set([
  path.join("src", "lib", "engine.mjs"),      // bridge.signTransaction(...) — the request
  path.join("src", "background.mjs"),         // bridge.signTransaction — the relay to the tab
  path.join("src", "injected.mjs"),           // p.signTransaction(tx) — Phantom's own window
]);

console.log("\nTHE SOURCE\n──────────");
const files = walk(path.join(here, "src")).filter((f) => /\.(mjs|js|html|css)$/.test(f));
ok("there are source files to scan", files.length > 8, `${files.length} files`);
for (const file of files) {
  const rel = path.relative(here, file);
  const text = fs.readFileSync(file, "utf8");
  for (const [re, what] of BANNED) ok(`${rel}: no ${what}`, !re.test(text));
  const signs = (text.match(/signTransaction/g) ?? []).length;
  if (signs) ok(`${rel}: signTransaction appears only where the bridge is`, ALLOWED_SIGN_SITES.has(rel), `${signs} occurrence(s)`);
}
ok("engine.mjs imports no signing helper from the executor", !/snipe-execute\.mjs|createSnipeExecutor|keypair/i.test(fs.readFileSync(path.join(here, "src", "lib", "engine.mjs"), "utf8")));
ok("nothing under src/ imports the executor's journal (the money record stays on the owner's machine)", files.every((f) => !/journal\.mjs/.test(fs.readFileSync(f, "utf8"))));

console.log("\nTHE BUNDLE\n──────────");
const dist = path.join(here, "dist");
if (fs.existsSync(dist)) {
  for (const name of ["background.js", "content.js", "injected.js", "popup.js", "options.js"]) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) { ok(`${name} was built`, false); continue; }
    const text = fs.readFileSync(file, "utf8");
    /* @solana/web3.js defines Keypair inside every bundle that imports it; what is banned is
       our code USING one. So the bundle check is for the executor's signing port and for
       secret-key construction at our call sites, which the source scan above already pins. */
    ok(`${name}: the executor's signing port is not in the bundle`, !/createSnipeExecutor|snipe-execute\.mjs/.test(text));
    ok(`${name}: no node: import survived`, !/from\s+"node:|require\("node:/.test(text));
  }
} else {
  console.log("  (no dist/ — the bundle is scanned by test-hawk-bundle.mjs after it builds)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
