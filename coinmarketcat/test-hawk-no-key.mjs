/**
 * ONE FILE MAY HOLD A KEY, AND NOTHING ELSE MAY. This scan is the proof, run on every suite.
 *
 * Upstream, Claude-Company's executor/test-snipe-lane.mjs scans the lane for a key on
 * every run because "the decision code cannot reach a key" is a claim that has to stay
 * true through every edit. The browser lane's claim used to be stronger — NOTHING in it
 * could reach one; the only signer was Phantom, behind its own approval window. The
 * session wallet (src/lib/session-wallet.mjs) is the one deliberate exception: a key the
 * extension generates, keeps encrypted under a passphrase the user holds, unlocks into
 * memory-only session storage, and signs with when the lane is armed on it. So the claim
 * is now: exactly one file under src/ may touch a secret key, and it is that one.
 *
 * What is banned everywhere else under src/: constructing or importing a Keypair, reading
 * a secret key, deriving a key from a seed or mnemonic, and signing with anything but
 * the bridge. `signTransaction` appears exactly where it should — the bridge request in
 * the engine, the worker's relay, the injected script's call into Phantom, and the
 * session signer — and those sites are named.
 *
 * What is pinned about the exception itself: nothing but the background host may import
 * it (the engine, tx.mjs, the content and injected scripts, the popup and the options
 * page may not); it never logs, never touches localStorage, never touches chrome.*; the
 * secret entry is written to `session` and never to `storage`; and even there a seed or
 * mnemonic derivation, nacl, signMessage, signAllTransactions and signAndSendTransaction
 * stay banned. The built bundles for the page-facing scripts and the UI must not carry
 * the secret's storage key at all.
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

const KEY_FILE = path.join("src", "lib", "session-wallet.mjs");   // the ONE file allowed to hold a key
const KEY_HOST = path.join("src", "background.mjs");              // the one file allowed to import it

/** Banned in every file under src/ except the key file. */
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
/** Banned even in the key file: it rebuilds a Keypair from its own 64 bytes and nothing else. */
const BANNED_EVEN_IN_KEY_FILE = [
  [/\bnacl\b|tweetnacl/, "nacl"],
  [/fromSeed|fromMnemonic|mnemonicToSeed|bip39|derivePath/, "seed or mnemonic derivation"],
  [/signAndSendTransaction/, "signAndSendTransaction (the lane sends through its own RPC)"],
  [/signMessage/, "signMessage (nothing here needs a signed message)"],
  [/signAllTransactions/, "signAllTransactions (one window per trade)"],
];
const ALLOWED_SIGN_SITES = new Set([
  path.join("src", "lib", "engine.mjs"),      // bridge.signTransaction(...) — the request
  path.join("src", "background.mjs"),         // bridge.signTransaction — the relay to the tab
  path.join("src", "injected.mjs"),           // p.signTransaction(tx) — Phantom's own window
  KEY_FILE,                                   // the session signer's own signTransaction
]);
const SECRET_ENTRY_KEY = "coinmarketcat:session-secret";

console.log("\nTHE SOURCE\n──────────");
const files = walk(path.join(here, "src")).filter((f) => /\.(mjs|js|html|css)$/.test(f));
ok("there are source files to scan", files.length > 8, `${files.length} files`);
ok("the key file exists to be scanned", files.some((f) => path.relative(here, f) === KEY_FILE), KEY_FILE);
for (const file of files) {
  const rel = path.relative(here, file);
  const text = fs.readFileSync(file, "utf8");
  const banned = rel === KEY_FILE ? BANNED_EVEN_IN_KEY_FILE : BANNED;
  for (const [re, what] of banned) ok(`${rel}: no ${what}`, !re.test(text));
  const signs = (text.match(/signTransaction/g) ?? []).length;
  if (signs) ok(`${rel}: signTransaction appears only where the bridge is`, ALLOWED_SIGN_SITES.has(rel), `${signs} occurrence(s)`);
  if (rel !== KEY_FILE && rel !== KEY_HOST)
    ok(`${rel}: does not import the session wallet`, !/session-wallet/.test(text));
}
ok("engine.mjs imports no signing helper from the executor", !/snipe-execute\.mjs|createSnipeExecutor|keypair/i.test(fs.readFileSync(path.join(here, "src", "lib", "engine.mjs"), "utf8")));
ok("nothing under src/ imports the executor's journal (the money record stays on the owner's machine)", files.every((f) => !/journal\.mjs/.test(fs.readFileSync(f, "utf8"))));

console.log("\nTHE KEY FILE\n────────────");
{
  const text = fs.readFileSync(path.join(here, KEY_FILE), "utf8");
  /* The header may SAY "the host wraps chrome.storage.local"; the code may not touch it.
     So the code-level bans run over the source with its comments stripped, and the
     prose checks run over the header with its line wraps joined. */
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const prose = text.replace(/\n\s*\*\s?/g, " ");
  const lines = text.split("\n");
  ok("it never logs (no console.* at all)", !/console\./.test(code));
  ok("it never touches localStorage or sessionStorage", !/localStorage|sessionStorage/.test(code));
  ok("it never touches chrome.* — everything is injected", !/\bchrome\./.test(code));
  ok("it never touches the network", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code));
  const secretLines = lines.filter((l) => l.includes(SECRET_ENTRY_KEY));
  ok("the secret entry key is used", secretLines.length >= 3, `${secretLines.length} lines`);
  ok("every use of the secret entry key goes through `session.`", secretLines.every((l) => /\bsession\./.test(l)), secretLines.filter((l) => !/\bsession\./.test(l)).join(" | "));
  ok("no use of the secret entry key goes through `storage.`", secretLines.every((l) => !/\bstorage\./.test(l)));
  ok("its header states the trade-off plainly", /bigger attack surface than one on a server/.test(prose));
  ok("its header states the rule", /only this file may touch a secret key/i.test(prose));
  const importers = files.map((f) => path.relative(here, f)).filter((rel) => rel !== KEY_FILE && /session-wallet/.test(fs.readFileSync(path.join(here, rel), "utf8")));
  ok("nothing but the background host imports it", importers.every((rel) => rel === KEY_HOST), importers.length ? importers.join(", ") : "no importer yet; background.mjs may wire it");
}

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
    if (name !== "background.js") ok(`${name}: the session secret's key is not in the bundle`, !text.includes(SECRET_ENTRY_KEY));
  }
} else {
  console.log("  (no dist/ — the bundle is scanned by test-hawk-bundle.mjs after it builds)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
