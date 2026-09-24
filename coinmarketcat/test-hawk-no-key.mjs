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
 *
 * What is pinned about the autopilot wallet's wiring: the AUTOPILOT message table is
 * exactly seven messages; only create, unlock and export carry a passphrase, and the
 * worker reads one in those three handlers and nowhere else; only the export returns the
 * key; no message carries transaction bytes; fund asks Phantom and sweep asks only the
 * autopilot wallet; no worker log line names a passphrase or the key; the pages that take
 * a passphrase use password fields, clear them, store nothing and log nothing; and the
 * exported key is shown as text and cleared.
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

console.log("\nTHE UI MESSAGES\n───────────────");
{
  /* The popup and the options page talk to the worker through the UI table only. Every
     entry is a switch, a read or a bookkeeping act (the stock list's "clear the block"
     among them); none may name a signature or a secret, so no page of this extension can
     ask the worker to sign or to hand anything key-shaped back. */
  const { UI } = await import("./src/lib/protocol.mjs");
  const names = Object.values(UI);
  const bad = names.filter((t) => /sign|secret|seed|mnemonic|private|keypair|passphrase/i.test(t));
  ok("no popup or options message asks for a signature or a secret", bad.length === 0, bad.join(", ") || `${names.length} message types`);
  ok("the stock list's one new message is a bookkeeping act", names.includes("hawk:ui:clear-stock-canary"));
  const options = fs.readFileSync(path.join(here, "src", "options", "options.mjs"), "utf8");
  ok("the options page's stock editor stores nothing itself (the worker's normalizeConfig is the only writer)", !/chrome\.storage|localStorage|sessionStorage/.test(options));
}

console.log("\nTHE AUTOPILOT MESSAGES\n──────────────────────");
{
  /* The autopilot wallet is driven from the extension's own pages through a table apart
     from UI, because three of its messages carry a passphrase and one hands the key back
     for recovery. What is pinned: exactly which; that the worker reads a passphrase in
     those three handlers and nowhere else; that the key leaves only through the export;
     that no message carries transaction bytes from a page; that nothing logs either;
     and that only the extension's own pages are answered. */
  const P = await import("./src/lib/protocol.mjs");
  const types = Object.values(P.AUTOPILOT ?? {});
  ok("the AUTOPILOT table is exactly status, create, unlock, lock, fund, sweep and the recovery export", JSON.stringify([...types].sort()) === JSON.stringify([
    "hawk:autopilot:create", "hawk:autopilot:export-secret", "hawk:autopilot:fund", "hawk:autopilot:lock", "hawk:autopilot:status", "hawk:autopilot:sweep", "hawk:autopilot:unlock",
  ]), types.join(", "));
  ok("exactly three carry a passphrase: create, unlock, export", JSON.stringify([...P.AUTOPILOT_CARRIES_PASSPHRASE].sort()) === JSON.stringify([P.AUTOPILOT.CREATE, P.AUTOPILOT.EXPORT_SECRET, P.AUTOPILOT.UNLOCK].sort()));
  ok("exactly one returns a secret: the recovery export", P.AUTOPILOT_RETURNS_SECRET.length === 1 && P.AUTOPILOT_RETURNS_SECRET[0] === P.AUTOPILOT.EXPORT_SECRET);
  ok("no autopilot message names a signature request", types.every((t) => !/sign(?!ed)|tx|transaction/i.test(t.replace("hawk:autopilot:", ""))), types.join(", "));
  ok("no web page can send one: the page-to-extension relay carries none", [...P.HAWK_FROM_PAGE].every((t) => !t.startsWith("hawk:autopilot:")) && [...P.HAWK_TO_PAGE].every((t) => !t.startsWith("hawk:autopilot:")));
  for (const rel of [path.join("src", "content.mjs"), path.join("src", "injected.mjs")]) {
    const t = fs.readFileSync(path.join(here, rel), "utf8");
    ok(`${rel}: never names an autopilot message`, !/hawk:autopilot|AUTOPILOT/.test(t));
  }

  const bg = fs.readFileSync(path.join(here, KEY_HOST), "utf8");
  /* Each autopilot handler is an `async function autopilotX(msg) {…}` ending at a line "}". */
  const fn = (name) => { const m = bg.match(new RegExp(`async function ${name}\\((?:msg)?\\) \\{[\\s\\S]*?\\n\\}\\n`)); return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null; };
  const handlers = Object.fromEntries(["autopilotStatus", "autopilotCreate", "autopilotUnlock", "autopilotLock", "autopilotExport", "autopilotFund", "autopilotSweep"].map((n) => [n, fn(n)]));
  ok("the worker has one handler per autopilot message", Object.values(handlers).every(Boolean), Object.entries(handlers).filter(([, v]) => !v).map(([k]) => k).join(", ") || "all seven");
  const within = (index, names) => names.some((n) => handlers[n] && index >= handlers[n].start && index < handlers[n].end);
  const reads = [...bg.matchAll(/msg\.(passphrase|confirm|currentPassphrase)\b/g)];
  ok("the worker reads a passphrase in the create, unlock and export handlers, and nowhere else", reads.length >= 4 && reads.every((m) => within(m.index, ["autopilotCreate", "autopilotUnlock", "autopilotExport"])), `${reads.length} reads`);
  const secretUses = [...bg.matchAll(/secretBase58/g)];
  ok("the key leaves the worker only through the recovery export", secretUses.length >= 1 && secretUses.every((m) => within(m.index, ["autopilotExport"])), `${secretUses.length} uses`);
  ok("the export asks the keystore, which asks for the passphrase", /keystore\.exportSecret\(\{ passphrase: msg\.passphrase \}\)/.test(handlers.autopilotExport?.text ?? ""));
  ok("no autopilot handler reads transaction bytes from a message (the worker builds every byte)", !/msg\.(txBase64|tx|transaction|signed|signedBase64|instructions?)\b/.test(bg));
  ok("the fund is the one Phantom approval, through the bridge", /bridge\.signTransaction\(/.test(handlers.autopilotFund?.text ?? "") && !/sessionSigner/.test(handlers.autopilotFund?.text ?? ""));
  ok("the sweep is signed by the autopilot wallet and never asks Phantom", /sessionSigner\.signTransaction\(/.test(handlers.autopilotSweep?.text ?? "") && !/bridge\.signTransaction/.test(handlers.autopilotSweep?.text ?? ""));
  ok("the sweep goes only to the destination the user confirmed", /msg\.expectTo !== to/.test(handlers.autopilotSweep?.text ?? ""));
  const logLines = bg.split("\n").filter((l) => /\blog\(|console\.\w+\(/.test(l));
  const leaky = logLines.filter((l) => /passphrase|secretBase58|currentPassphrase|msg\.confirm/i.test(l));
  ok("no log or console line in the worker mentions a passphrase or the exported key", leaky.length === 0, leaky.join(" | ") || `${logLines.length} log lines`);
  ok("the autopilot messages are answered for the extension's own pages only", /if \(!fromExtensionPage\(sender\)\) return \{ ok: false/.test(bg) && /sender\.id !== chrome\.runtime\.id/.test(bg) && /sender\.url\.startsWith\(base\)/.test(bg));
  ok("the unlocked key's area is pinned to trusted contexts", /setAccessLevel\?\.\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/.test(bg));
  ok("the keystore's unlocked secret goes to chrome.storage.session, its blob to chrome.storage.local", /createKeystore\(\{ storage: chromeArea\(chrome\.storage\.local\), session: chromeArea\(chrome\.storage\.session\) \}\)/.test(bg));

  /* The pages that take a passphrase: password fields, cleared after use, never stored,
     never logged; the exported key shown as text, in one box, and cleared. */
  const PAGES = [
    [path.join("src", "popup", "popup.html"), path.join("src", "popup", "popup.mjs"), ["apPass1", "apPass2", "apPassUnlock", "apPassExport", "apPassCurrent", "apPassNew1", "apPassNew2"]],
    [path.join("src", "welcome", "welcome.html"), path.join("src", "welcome", "welcome.mjs"), ["pass1", "pass2"]],
  ];
  for (const [htmlRel, jsRel, ids] of PAGES) {
    const html = fs.readFileSync(path.join(here, htmlRel), "utf8");
    const js = fs.readFileSync(path.join(here, jsRel), "utf8");
    for (const id of ids) {
      ok(`${htmlRel}: #${id} is a password field`, new RegExp(`<input id="${id}" type="password"`).test(html));
      /* Either `$("id").value = ""` directly, or `x = $("id")` then `x.value = ""`. */
      const direct = new RegExp(`\\$\\("${id}"\\)\\.value = ""`).test(js);
      const bound = js.match(new RegExp(`\\b(\\w+) = \\$\\("${id}"\\)`));
      const viaName = bound ? new RegExp(`\\b${bound[1]}\\.value = ""`).test(js.slice(bound.index)) : false;
      ok(`${jsRel}: #${id} is cleared after it is read`, direct || viaName, bound ? `as ${bound[1]}` : "directly");
    }
    ok(`${jsRel}: logs nothing`, !/console\./.test(js));
    ok(`${jsRel}: stores nothing itself (no chrome.storage, localStorage or sessionStorage)`, !/chrome\.storage|localStorage|sessionStorage/.test(js));
  }
  const popup = fs.readFileSync(path.join(here, "src", "popup", "popup.mjs"), "utf8");
  ok("the popup shows the exported key as text, never as HTML", /\$\("apSecret"\)\.textContent = res\.secretBase58/.test(popup) && !/innerHTML[^;\n]*secretBase58/.test(popup));
  ok("…and clears it: on hide, when its section closes, and after two minutes", /function clearSecret\(\) \{\s*\$\("apSecret"\)\.textContent = "";/.test(popup) && /btnApSecretHide"\)\.addEventListener\("click", clearSecret\)/.test(popup) && /setTimeout\(clearSecret, 120_000\)/.test(popup) && /apExportBox"\)\.addEventListener\("toggle"/.test(popup));
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const holders = files.filter((f) => /secretBase58/.test(stripComments(fs.readFileSync(f, "utf8")))).map((f) => path.relative(here, f)).sort();
  ok("only the worker and the popup ever name the exported key", JSON.stringify(holders) === JSON.stringify([KEY_HOST, path.join("src", "popup", "popup.mjs")].sort()), holders.join(", "));
}

console.log("\nTHE xSTOCK VENUE'S NETWORK\n──────────────────────────");
{
  /* The second venue is the extension's first code that talks to hosts other than the RPC
     the user pasted: public new-pool feeds and Jupiter. What is pinned: those files name
     only the four hosts the venue needs; nothing in them can read, name or send a key or a
     passphrase; the one request body that carries a wallet carries its PUBLIC key; and the
     venue reaches a signature only through the engine's signSendConfirm (which refuses a
     signed message that is not the one asked for), each call after the pre-sign check. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const NET = [path.join("src", "lib", "xstock-discovery.mjs"), path.join("src", "lib", "jupiter-swap.mjs")];
  const LANE = path.join("src", "lib", "xstock-lane.mjs");
  const ALLOWED_HOSTS = new Set(["api.geckoterminal.com", "api.dexscreener.com", "datapi.jup.ag", "api.jup.ag"]);
  for (const rel of [...NET, LANE]) {
    const code = strip(fs.readFileSync(path.join(here, rel), "utf8"));
    const hosts = [...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    ok(`${rel}: names only the venue's hosts`, hosts.every((h) => ALLOWED_HOSTS.has(h)), [...new Set(hosts)].join(", ") || "none");
    ok(`${rel}: no plain-http URL`, !/http:\/\//i.test(code));
    ok(`${rel}: nothing key-shaped or passphrase-shaped in its code`, !/secret|passphrase|privateKey|mnemonic|seed\b/i.test(code));
    ok(`${rel}: touches no storage and no chrome API`, !/chrome\.|localStorage|sessionStorage|indexedDB/.test(code));
    ok(`${rel}: signs nothing itself`, !/\.sign\(|signTransaction|partialSign/.test(code));
  }
  const jup = strip(fs.readFileSync(path.join(here, NET[1]), "utf8"));
  const swapBody = jup.match(/request\("\/swap", \{ priority, body: \{([\s\S]*?)\} \}\);/)?.[1] ?? "";
  const keys = [...swapBody.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => !["priorityLevelWithMaxLamports", "maxLamports", "priorityLevel", "global"].includes(k));
  ok("the one body that names the wallet sends Jupiter its public key and nothing else of it", JSON.stringify(keys) === JSON.stringify(["quoteResponse", "userPublicKey", "wrapAndUnwrapSol", "dynamicComputeUnitLimit", "prioritizationFeeLamports"]), keys.join(", "));
  ok("…and it asks Jupiter never to wrap SOL: this venue pays in the stock", /wrapAndUnwrapSol: false/.test(swapBody));
  const lane = strip(fs.readFileSync(path.join(here, LANE), "utf8"));
  const signs = [...lane.matchAll(/host\.signSendConfirm\(\{ txBase64: swap\.swapTransaction/g)].map((m) => m.index);
  const checks = [...lane.matchAll(/checkBeforeSigning\(\{ txBase64: swap\.swapTransaction/g)].map((m) => m.index);
  ok("the venue asks for a signature only through the engine's signSendConfirm, for the buy and the sell", signs.length === 2 && (lane.match(/signSendConfirm/g) ?? []).length === 2);
  ok("…each after its own pre-sign check of the same bytes (check, sign, check, sign)", signs.length === 2 && checks.length === 2 && checks[0] < signs[0] && signs[0] < checks[1] && checks[1] < signs[1], `checks at ${checks.join(",")}, signs at ${signs.join(",")}`);
  ok("…whose check resolves the lookup tables on the lane's own RPC", /loadLookupTables\(rpc, lookupTableKeysOf\(txBase64\)\)/.test(lane));
  const engine = fs.readFileSync(path.join(here, "src", "lib", "engine.mjs"), "utf8");
  ok("the engine hands the venue its own simulateGuard and signSendConfirm, not a signer's raw call", /simulateGuard, signSendConfirm, recordClose,/.test(engine) && !/createXstockLane\(\{[\s\S]*?signTransaction[\s\S]*?\}\);/.test(engine));
}

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
  for (const name of ["background.js", "content.js", "injected.js", "popup.js", "options.js", "welcome.js"]) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) { ok(`${name} was built`, false); continue; }
    const text = fs.readFileSync(file, "utf8");
    /* @solana/web3.js defines Keypair inside every bundle that imports it; what is banned is
       our code USING one. So the bundle check is for the executor's signing port and for
       secret-key construction at our call sites, which the source scan above already pins. */
    /* Two proofs the signing port is absent. esbuild heads every module it bundles with a
       `// <path>` line, so a bundled snipe-execute.mjs would carry that header. And the
       CODE, comments stripped, names neither the port nor its file. A vendored comment
       that only MENTIONS the file (snipe-lane.mjs's note on why the Node lane stays
       SOL-only rides inside SNIPE_LANE_DEFAULTS, and esbuild keeps it) is prose, not the port. */
    ok(`${name}: esbuild bundled no module named snipe-execute.mjs`, !/^\/\/ [^\n]*snipe-execute\.mjs\s*$/m.test(text));
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    ok(`${name}: the executor's signing port is not in the bundle's code`, !/createSnipeExecutor|snipe-execute\.mjs/.test(code));
    ok(`${name}: the comment strip left the code to scan`, code.length > text.length / 3 && /chrome\.|postMessage|PublicKey/.test(code), `${(code.length / 1024).toFixed(0)} of ${(text.length / 1024).toFixed(0)} KB`);
    ok(`${name}: no node: import survived`, !/from\s+"node:|require\("node:/.test(text));
    if (name !== "background.js") ok(`${name}: the session secret's key is not in the bundle`, !text.includes(SECRET_ENTRY_KEY));
  }
} else {
  console.log("  (no dist/ — the bundle is scanned by test-hawk-bundle.mjs after it builds)");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
