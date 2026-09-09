/**
 * ONE-CLICK DEPOSIT — SENDING SOL TO THE BOT WITHOUT THE DESK EVER TOUCHING A KEY.
 *
 * The owner, 2026-09-09: "a one click deposit from solflare/phantom/jupiter/raydium etc".
 * Until this change the page printed the burner's address next to a Copy button and left
 * the reader to paste it into a wallet by hand. Measured the same day: the burner holds
 * 0.107 SOL, one 0.4 SOL trade needs ~0.42 including the fee-and-rent reserve, and the
 * hand-copy is the step that has kept it short.
 *
 * WHAT THIS FILE REFUSES TO TAKE ON TRUST. A deposit button is a button that moves
 * somebody's real money to an address, so every claim about it is checked against
 * something that did not produce it:
 *
 *   - THE MESSAGE IS PARSED BY THE REAL LIBRARY, NOT DIFFED. The page hand-encodes a
 *     legacy Solana message because it loads no web3 library. Asserting the bytes
 *     against bytes I also wrote would prove nothing — a wrong account order round-trips
 *     through its own encoder perfectly. So @solana/web3.js `Message.from()` +
 *     `SystemInstruction.decodeTransfer()` parse the output and the DESTINATION and
 *     LAMPORTS are read off that parse. (This is the ruler lesson: the metric has to be
 *     one that can disagree with the thing it measures.)
 *   - THE ADDRESS IS FOLLOWED, NOT ASSUMED. The dialog is driven twice with two
 *     different burner addresses and the parsed destination is required to change with
 *     it, so a hard-coded address could not pass by accident.
 *   - THE BLOCK IS RUN, NOT READ. The deposit code is sliced out of office3d.html and
 *     evaluated against a small DOM shim, with a FAKE wallet provider that records what
 *     it was handed. Nothing here talks to a network, a wallet, or a chain.
 *
 * WHAT IS STUBBED, PLAINLY: the wallet provider, the blockhash route, and the DOM. This
 * file proves the page builds and hands over the right transfer and never reaches for a
 * key; it does NOT prove Phantom's or Solflare's extension accepts it — that needs a
 * live browser and a funded wallet, and is called out as unverified in the report.
 *
 *   CLAUDE_CO_DB=/tmp/deposit-$$.db node test-deposit-button.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const HTML = fs.readFileSync(path.join(ROOT, "viewer", "office3d.html"), "utf8");
/* @solana/web3.js is installed under executor/, not at the root — the desk keeps the
   trading dependency out of the server's tree. Resolved from there, as test-sim-c.mjs
   and test-bot-onoff.mjs do. */
const { Message, SystemInstruction, TransactionInstruction, SystemProgram } =
  createRequire(path.join(ROOT, "executor/"))("@solana/web3.js");
const { decode: b58decodeRef, encode: b58encodeRef } = await import("./src/lib/base58.js");

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  cond ? pass++ : (fail++, failures.push(name));
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/* Two real 32-byte addresses, generated here, so nothing in this file could be
   satisfied by a constant that happens to live in the page. */
const BURNER_A = b58encodeRef(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));
const BURNER_B = b58encodeRef(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 91) & 0xff)));
const PAYER = b58encodeRef(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 13 + 200) & 0xff)));
const BLOCKHASH = b58encodeRef(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 5 + 41) & 0xff)));

/* ══════════════════════════════════════════════════════════════════════════════
   THE BLOCK ITSELF — sliced out of the page and evaluated.
   ══════════════════════════════════════════════════════════════════════════════ */
const slice = (from, to) => {
  const a = HTML.indexOf(from);
  const b = HTML.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`could not slice ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  return HTML.slice(a, b);
};
const DEPOSIT_SRC = slice("/* ═══ ONE-CLICK DEPOSIT — BEGIN", "/* ═══ ONE-CLICK DEPOSIT — END");
const HELPERS =
  slice("const dashNode = (tag, cls, text) => {", "const dashCompact") +
  slice("const dashSol = (value) => {", "const dashAge") +
  slice("const infoButton = (title, text) => {", "/** Lead sentence") +
  slice("const plainLead = (text,", "/** Up to three chips") +
  slice("const chipRow = (chips) => {", "/** The one button.");

/* A DOM small enough to read and big enough to run the dialog. Every method here is one
   the sliced code actually calls; anything else it reached for would throw rather than
   silently no-op, which is the point. */
function makeDom() {
  const text = (t) => ({ nodeType: 3, textContent: String(t), children: [] });
  const mk = (tag) => ({
    tagName: String(tag).toUpperCase(), className: "", children: [], style: {}, attrs: {},
    listeners: {}, type: "", value: "", href: "", title: "", rel: "", disabled: false,
    parentNode: null, _text: "",
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? text(c) : c); },
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    focus() {}, remove() {},
  });
  const document = { createElement: mk, createTextNode: text, getElementById: () => null };
  return { mk, document };
}
const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
};
const allText = (node) => walk(node).map((n) => n._text || "").join(" • ");

/** Evaluate the sliced block with a given window, and hand back its exports. */
function loadDeposit({ window, document, openSwap = () => {}, call_api = async () => ({ status: 200, body: {} }) }) {
  const body = HELPERS + "\n" + DEPOSIT_SRC +
    "\nreturn { DEPOSIT, openDeposit, DEPOSIT_TRUTH, DEPOSIT_SWAP_IN };";
  // eslint-disable-next-line no-new-func
  return new Function("window", "document", "openSwap", "call_api", "navigator", "setTimeout", body)(
    window, document, openSwap, call_api, { clipboard: { writeText: async () => {} } }, () => {});
}

console.log("\nTHE BLOCK LOADS, AND ITS BASE58 AGREES WITH THE SERVER'S");
let API;
{
  const { mk, document } = makeDom();
  const window = { openDialog: null };
  API = loadDeposit({ window, document }).DEPOSIT;
  ok("the deposit core evaluates out of the page as written", typeof API?.transferMessage === "function",
    `${DEPOSIT_SRC.length} chars sliced`);
  /* THE RULER, CHECKED FIRST. Every address in every assertion below passes through this
     encoder. If it disagreed with the server's own base58 the whole file would be
     measuring itself. */
  const roundTrip = API.b58encode(b58decodeRef(BURNER_A));
  ok("the page's base58 encoder agrees with src/lib/base58.js", roundTrip === BURNER_A,
    `${roundTrip.slice(0, 12)}… === ${BURNER_A.slice(0, 12)}…`);
  const sys = Buffer.from(API.b58decode(API.SYSTEM_PROGRAM));
  ok("...and decodes the System Program to 32 zero bytes, the case a seeded decoder breaks on",
    sys.length === 32 && sys.every((b) => b === 0), `${sys.length} bytes, all zero`);
  ok("a string that is not 32 bytes is refused as an address",
    API.isAddress(BURNER_A) === true && API.isAddress("not-an-address") === false &&
    API.isAddress(BURNER_A.slice(0, 20)) === false,
    `isAddress(burner)=${API.isAddress(BURNER_A)} isAddress("not-an-address")=${API.isAddress("not-an-address")}`);
}

console.log("\nTHE TRANSFER IS WHAT THE PAGE SAYS IT IS — PARSED BY @solana/web3.js");
{
  const LAMPORTS = 320_000_000;                       // 0.32 SOL, the measured shortfall
  const bytes = API.transferMessage({ from: PAYER, to: BURNER_A, lamports: LAMPORTS, blockhash: BLOCKHASH });
  const msg = Message.from(Buffer.from(bytes));
  ok("the hand-encoded message parses at all", msg.instructions.length === 1,
    `${bytes.length} bytes, ${msg.accountKeys.length} accounts, ${msg.instructions.length} instruction`);
  ok("it asks for exactly one signature — the sender's",
    msg.header.numRequiredSignatures === 1 && msg.header.numReadonlySignedAccounts === 0 &&
    msg.header.numReadonlyUnsignedAccounts === 1,
    `header ${msg.header.numRequiredSignatures}/${msg.header.numReadonlySignedAccounts}/${msg.header.numReadonlyUnsignedAccounts}`);
  ok("the blockhash is the one it was handed", msg.recentBlockhash === BLOCKHASH,
    `${msg.recentBlockhash.slice(0, 12)}…`);

  const ix = msg.instructions[0];
  const programId = msg.accountKeys[ix.programIdIndex];
  ok("the instruction runs on the System Program", programId.equals(SystemProgram.programId),
    programId.toBase58());
  const tix = new TransactionInstruction({
    programId,
    keys: ix.accounts.map((i) => ({
      pubkey: msg.accountKeys[i], isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i),
    })),
    data: Buffer.from(b58decodeRef(ix.data)),
  });
  const kind = SystemInstruction.decodeInstructionType(tix);
  ok("...and the library calls it a Transfer, not something else", kind === "Transfer", `decoded type = ${kind}`);
  const decoded = SystemInstruction.decodeTransfer(tix);
  console.log(`       DECODED BY @solana/web3.js: from=${decoded.fromPubkey.toBase58()}`);
  console.log(`                                   to  =${decoded.toPubkey.toBase58()}`);
  console.log(`                                   lamports=${decoded.lamports} (${Number(decoded.lamports) / 1e9} SOL)`);
  ok("the money goes to the address the page was given", decoded.toPubkey.toBase58() === BURNER_A,
    `${decoded.toPubkey.toBase58()} === ${BURNER_A}`);
  ok("...and it is paid by the connected wallet, not by anything of the desk's",
    decoded.fromPubkey.toBase58() === PAYER, decoded.fromPubkey.toBase58());
  ok("the amount is the amount", Number(decoded.lamports) === LAMPORTS,
    `${decoded.lamports} lamports = ${Number(decoded.lamports) / 1e9} SOL`);
  ok("the sender signs and the recipient does not",
    msg.isAccountSigner(0) === true && msg.isAccountSigner(1) === false && msg.isAccountWritable(1) === true,
    `signer(0)=${msg.isAccountSigner(0)} signer(1)=${msg.isAccountSigner(1)} writable(1)=${msg.isAccountWritable(1)}`);

  /* THE DESTINATION IS AN ARGUMENT, NOT A CONSTANT. A hard-coded address would survive
     every assertion above; it cannot survive this one. */
  const second = Message.from(Buffer.from(
    API.transferMessage({ from: PAYER, to: BURNER_B, lamports: LAMPORTS, blockhash: BLOCKHASH })));
  const secondTo = SystemInstruction.decodeTransfer(new TransactionInstruction({
    programId: second.accountKeys[second.instructions[0].programIdIndex],
    keys: second.instructions[0].accounts.map((i) => ({
      pubkey: second.accountKeys[i], isSigner: second.isAccountSigner(i), isWritable: second.isAccountWritable(i) })),
    data: Buffer.from(b58decodeRef(second.instructions[0].data)),
  })).toPubkey.toBase58();
  ok("a second, different burner produces a transfer to THAT burner",
    secondTo === BURNER_B && secondTo !== BURNER_A, `${secondTo} !== ${BURNER_A}`);

  /* Refusals, each in its dangerous direction. */
  const refuses = (args) => { try { API.transferMessage(args); return false; } catch { return true; } };
  ok("a malformed destination is refused rather than encoded",
    refuses({ from: PAYER, to: "totally-not-an-address", lamports: 1, blockhash: BLOCKHASH }));
  ok("a zero or negative amount is refused",
    refuses({ from: PAYER, to: BURNER_A, lamports: 0, blockhash: BLOCKHASH }) &&
    refuses({ from: PAYER, to: BURNER_A, lamports: -5, blockhash: BLOCKHASH }));
  ok("sending to yourself is refused", refuses({ from: PAYER, to: PAYER, lamports: 1, blockhash: BLOCKHASH }));
}

console.log("\nTHE AMOUNT OFFERED IS THE MEASURED SHORTFALL, ROUNDED UP");
{
  /* The figures are today's: a 0.4 SOL cap gives a readiness reserve of
     0.4 + 0.0005 fee + 0.0042 two-ATA rent + 0.01 untouched = 0.4147, against 0.107 in
     the wallet. src/executor-dashboard.js computes that reserve; this only splits the
     difference and rounds up. */
  const required = 0.4 + 0.0005 + 0.0042 + 0.01;
  const offered = API.suggestedSol({ requiredForReadinessSol: required, balanceSol: 0.107 });
  console.log(`       required=${required} balance=0.107 shortfall=${(required - 0.107).toFixed(6)} offered=${offered}`);
  ok("it offers the shortfall, rounded up to the hundredth", offered === 0.31,
    `${offered} SOL offered against a ${(required - 0.107).toFixed(4)} SOL shortfall`);
  ok("...and it never rounds DOWN below what is needed", offered >= required - 0.107,
    `${offered} >= ${(required - 0.107).toFixed(6)}`);
  ok("a wallet that already clears the reserve is offered nothing",
    API.suggestedSol({ requiredForReadinessSol: required, balanceSol: 5 }) === null,
    "null — the reader types their own");
  ok("no reported reserve means no invented figure",
    API.suggestedSol({ requiredForReadinessSol: null, balanceSol: 0.107 }) === null &&
    API.suggestedSol({}) === null, "null in both directions");
}

console.log("\nTHE NO-WALLET PATH STILL OFFERS THE ADDRESS");
{
  const uri = API.payUri({ to: BURNER_A, sol: 0.31 });
  console.log(`       payUri = ${uri}`);
  ok("the Solana Pay URI carries the burner and the amount, and nothing else does the carrying",
    uri.startsWith("solana:" + BURNER_A + "?") && uri.includes("amount=0.31"),
    uri.slice(0, 60) + "…");
  ok("a different burner gives a different URI",
    API.payUri({ to: BURNER_B, sol: 0.31 }).includes(BURNER_B) &&
    !API.payUri({ to: BURNER_B, sol: 0.31 }).includes(BURNER_A));
  let refused = false;
  try { API.payUri({ to: "nope", sol: 1 }); } catch { refused = true; }
  ok("a bad address never reaches a URI at all", refused);
  ok("with no amount typed, the URI still names the address so a reader can type it there",
    API.payUri({ to: BURNER_A, sol: NaN }).startsWith("solana:" + BURNER_A) &&
    !API.payUri({ to: BURNER_A, sol: NaN }).includes("amount="),
    API.payUri({ to: BURNER_A, sol: NaN }));

  /* No injected wallet of any kind: the dialog must still render, and must still put the
     whole address and the link in front of the reader. */
  const { document } = makeDom();
  const dialogs = [];
  const window = {
    openDialog: ({ label }) => {
      const d = { label, body: document.createElement("div"), foot: document.createElement("div"), dismiss: () => {} };
      dialogs.push(d); return d;
    },
  };
  const mod = loadDeposit({ window, document });
  ok("with no wallet injected, injectedWallet() finds none", mod.DEPOSIT.injectedWallet() === null);
  const d = mod.openDeposit({ address: BURNER_A, requiredForReadinessSol: 0.4147, balanceSol: 0.107 });
  const texts = allText(d.body);
  const nodes = walk(d.body);
  const anchor = nodes.find((n) => n.tagName === "A");
  console.log(`       no-wallet dialog: ${nodes.length} nodes · anchor href = ${anchor?.href}`);
  ok("the whole address is on screen, not only a truncated one",
    nodes.some((n) => n.tagName === "CODE" && n.textContent === BURNER_A), BURNER_A);
  ok("the Solana Pay link points at that same address with the offered amount",
    anchor?.href === "solana:" + BURNER_A + "?amount=0.31&label=Claude%20Company&message=Fund%20your%20trading%20bot",
    anchor?.href);
  const shown = nodes.map((n) => n._text || "").find((t) => t.startsWith("This link opens: "));
  ok("...and the page prints that URI in full before anyone follows it",
    typeof shown === "string" && shown.includes(BURNER_A) && shown.includes("amount=0.31"), shown);
  ok("the reader is told plainly that nothing here can be signed without a wallet",
    /No Solana wallet is available in this browser/.test(texts),
    "\"No Solana wallet is available in this browser, so nothing here can be signed on this page.\"");
  ok("the foot offers Close, never a dead Send button", d.foot.children[0]?.textContent === "Close",
    d.foot.children[0]?.textContent);

  /* An address the bot has not reported yet must produce a refusal, not a send button. */
  const none = mod.openDeposit({ address: null });
  ok("with no reported wallet the dialog refuses instead of offering to send",
    /has not reported a wallet yet/.test(allText(none.body)) && none.foot.children[0]?.textContent === "Got it",
    "\"Your bot has not reported a wallet yet.\"");
}

console.log("\nTHE COPY SAYS THE MONEY IS THE BOT'S AND THE DESK CANNOT GET IT BACK");
{
  const { document } = makeDom();
  const window = {
    openDialog: () => ({ body: document.createElement("div"), foot: document.createElement("div"), dismiss: () => {} }),
  };
  const mod = loadDeposit({ window, document });
  console.log(`       DEPOSIT_TRUTH = ${JSON.stringify(mod.DEPOSIT_TRUTH)}`);
  ok("the standing sentence names real money, sole spender, and no way back",
    /real SOL/.test(mod.DEPOSIT_TRUTH) &&
    /only thing that can spend it/.test(mod.DEPOSIT_TRUTH) &&
    /cannot send it back/.test(mod.DEPOSIT_TRUTH), mod.DEPOSIT_TRUTH);
  const d = mod.openDeposit({ address: BURNER_A, requiredForReadinessSol: 0.4147, balanceSol: 0.107 });
  ok("...and it is in the dialog's lead, not buried behind the ⓘ",
    walk(d.body).some((n) => n.className === "sub" && n.textContent === mod.DEPOSIT_TRUTH),
    "rendered as the plainLead sub");
  const texts = allText(d.body);
  ok("the swap is named as a swap into the READER'S wallet, never a deposit into the bot",
    /lands in YOUR wallet, not your bot's/.test(texts),
    "\"The swap lands in YOUR wallet, not your bot's — you come back here and send it on.\"");
  ok("SOL only is stated, because anything else sent there is stuck",
    /SOL only: anything else sent there is stuck/.test(texts),
    "\"SOL only: anything else sent there is stuck.\"");
}

console.log("\nA WALLET IS HANDED THE TRANSFER; NO KEY IS EVER ASKED FOR");
{
  const { document } = makeDom();
  const handed = [];
  /* A fake Phantom-shaped provider. It records what it is given and — the point of the
     shape — exposes NO key, so any code path that tried to read one would throw here
     rather than quietly succeed against a mock that offered one. */
  const provider = {
    publicKey: { toString: () => PAYER },
    connect: async () => { handed.push({ event: "connect" }); return { publicKey: { toString: () => PAYER } }; },
    request: async ({ method, params }) => {
      handed.push({ event: "request", method, params });
      return { signature: "5" + "z".repeat(63) };
    },
  };
  const window = {
    solana: provider,
    openDialog: () => ({ body: document.createElement("div"), foot: document.createElement("div"), dismiss: () => {} }),
  };
  let blockhashCalls = 0;
  const mod = loadDeposit({ window, document,
    call_api: async (p) => { blockhashCalls++; return { status: 200, body: { blockhash: BLOCKHASH }, path: p }; } });
  ok("an injected wallet is found", mod.DEPOSIT.injectedWallet() === provider);

  const d = mod.openDeposit({ address: BURNER_B, requiredForReadinessSol: 0.4147, balanceSol: 0.107 });
  const send = d.foot.children[0];
  ok("the foot's one action is Send from my wallet", send?.textContent === "Send from my wallet", send?.textContent);
  await send.onclick();

  const req = handed.find((h) => h.event === "request");
  console.log(`       provider saw: ${handed.map((h) => h.event + (h.method ? ":" + h.method : "")).join(", ")}`);
  console.log(`       blockhash route called ${blockhashCalls}x`);
  ok("the wallet is asked to sign AND send it, so the page never holds a signed transaction",
    req?.method === "signAndSendTransaction", req?.method);
  ok("the wallet is handed a base58 MESSAGE and nothing else",
    Object.keys(req?.params || {}).join(",") === "message" && typeof req.params.message === "string",
    `params = {${Object.keys(req?.params || {}).join(", ")}}`);

  /* And the message it was handed is decoded by the real library, once more. */
  const msg = Message.from(Buffer.from(mod.DEPOSIT.b58decode(req.params.message)));
  const ix = msg.instructions[0];
  const decoded = SystemInstruction.decodeTransfer(new TransactionInstruction({
    programId: msg.accountKeys[ix.programIdIndex],
    keys: ix.accounts.map((i) => ({ pubkey: msg.accountKeys[i], isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })),
    data: Buffer.from(b58decodeRef(ix.data)),
  }));
  console.log(`       handed to the wallet: ${Number(decoded.lamports) / 1e9} SOL → ${decoded.toPubkey.toBase58()}`);
  ok("what the wallet was handed pays THIS floor's reported burner",
    decoded.toPubkey.toBase58() === BURNER_B, `${decoded.toPubkey.toBase58()} === ${BURNER_B}`);
  ok("...for the amount the dialog offered", Number(decoded.lamports) === 310_000_000,
    `${decoded.lamports} lamports = ${Number(decoded.lamports) / 1e9} SOL`);
  ok("the confirmation says it cannot be recalled",
    /cannot be recalled/.test(allText(d.body)),
    walk(d.body).map((n) => n._text || "").find((t) => t.startsWith("Sent ✓")));

  /* A refusal in the wallet is not a failure of the page, and must not read like one. */
  const cancelling = { ...provider, request: async () => { throw new Error("User rejected the request."); } };
  const d2 = loadDeposit({ window: { solana: cancelling, openDialog: window.openDialog }, document,
    call_api: async () => ({ status: 200, body: { blockhash: BLOCKHASH } }) })
    .openDeposit({ address: BURNER_B, requiredForReadinessSol: 0.4147, balanceSol: 0.107 });
  await d2.foot.children[0].onclick();
  const cancelled = walk(d2.body).map((n) => n._text || "").find((t) => /cancelled/i.test(t));
  ok("a signature the reader declines is reported as a cancellation, not an error",
    cancelled === "You cancelled it. Nothing was sent.", cancelled);
}

console.log("\nNOTHING IN THIS BLOCK CAN READ, HOLD OR TRANSMIT A KEY");
{
  /* The whole point of the architecture. Named in both directions: the words that would
     mean key material must not appear, and the words that mean "the wallet does it" must. */
  const forbidden = /privateKey|secretKey|seed\s*phrase|mnemonic|Keypair|burner\.json|fromSecretKey|signMessage\(/;
  const hit = forbidden.exec(DEPOSIT_SRC);
  ok("no private key, secret key, seed phrase, mnemonic or Keypair appears anywhere in it",
    hit === null, hit ? `found ${hit[0]}` : "none of privateKey|secretKey|seed phrase|mnemonic|Keypair|burner.json");
  ok("...and it never signs: it builds a message and hands it over",
    /signAndSendTransaction/.test(DEPOSIT_SRC) && !/\bsign\(/.test(DEPOSIT_SRC) &&
    !/signTransaction\b/.test(DEPOSIT_SRC),
    "signAndSendTransaction is the only signing verb, and it is the wallet's");
  ok("it sends nothing anywhere except the one blockhash read",
    (DEPOSIT_SRC.match(/call_api\(/g) || []).length === 1 &&
    /call_api\("\/api\/pay\/blockhash"\)/.test(DEPOSIT_SRC) && !/fetch\(/.test(DEPOSIT_SRC),
    "one call_api, to /api/pay/blockhash, and no bare fetch");

  /* NO HARD-CODED DESTINATION. Every 32-byte address literal in the block is listed, and
     only two are allowed: the System Program (a program id, not a destination) and the
     Jupiter swap INPUT — which is where money comes FROM, into the reader's own wallet.
     THE RULER, CORRECTED. The first version of this scan matched any 32-44 character run
     of base58 characters ANYWHERE in the source, and reported three hits: it had chewed
     44 characters off the middle of the base58 ALPHABET constant, which of course
     decodes to 32 bytes like any other 44 base58 characters do. That is a measurement
     artefact, not a hard-coded address, and loosening the count to 3 would have been
     writing the artefact into the test. The scan now matches whole quoted STRING
     LITERALS, which is what a hard-coded destination would actually be, and the
     58-character alphabet no longer qualifies. Validated below against a case whose
     answer is known. */
  const addressLiterals = (src) => [...new Set([...src.matchAll(/["']([1-9A-HJ-NP-Za-km-z]{32,44})["']/g)]
    .map((m) => m[1])
    .filter((s) => { try { return b58decodeRef(s).length === 32; } catch { return false; } }))];
  const planted = addressLiterals(`const dest = "${BURNER_A}";\nsend(dest);`);
  ok("the scan is a ruler that can fail: a planted hard-coded address IS caught",
    planted.length === 1 && planted[0] === BURNER_A, `planted ${BURNER_A} → found ${planted.join(",")}`);
  const literals = addressLiterals(DEPOSIT_SRC);
  console.log(`       32-byte address literals in the block: ${literals.join(", ") || "(none)"}`);
  const allowed = new Set(["11111111111111111111111111111111", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
  ok("the only address constants are the System Program and the swap's input token",
    literals.every((s) => allowed.has(s)) && literals.length === 2,
    `${literals.length} literals: ${literals.join(", ")}`);
  ok("...and neither of them is ever a transfer destination",
    !/transferMessage\([^)]*to:\s*["']/.test(DEPOSIT_SRC) &&
    /transferMessage\(\{ from, to, lamports, blockhash \}\)/.test(DEPOSIT_SRC),
    "`to` is always the caller's argument");
}

console.log("\nTHE CONTROL IS ON BOTH SURFACES, POINTED AT THE HEARTBEAT'S OWN ADDRESS");
{
  const overview = HTML.slice(HTML.indexOf("async function loadOverviewDashboard"),
    HTML.indexOf("const CANDIDATE_BANDS"));
  const overviewCall = /openDeposit\(\{ address: execWallet\.address,\s*requiredForReadinessSol: execWallet\.requiredForReadinessSol,\s*balanceSol: execWallet\.balanceSol \}\)/.test(overview);
  console.log(`       Overview: has a Send SOL control=${/"Send SOL"/.test(overview)} · ` +
    `targets execWallet.address=${overviewCall} · beside the SOL figure=${overview.indexOf("el.appendChild(facts)") < overview.indexOf("openDeposit(")}`);
  ok("the Overview — where the SOL figure lives — has the Send SOL control",
    /"Send SOL"/.test(overview) && /openDeposit\(/.test(overview),
    "on the tab that shows the bot is short");
  ok("...and it sends to the wallet the BOT reported, not to anything written in the page",
    overviewCall, "openDeposit({ address: execWallet.address, … })");
  ok("...built from the page's own primitives, with no new layout system",
    /dashNode\("button", "dp-btn ghost", "Send SOL"\)/.test(overview) &&
    /leadButton\("Send SOL", openIt/.test(overview),
    "dp-btn inside the existing .lead-actions row");
  ok("...and no dropdown bar, accordion or <details> came with it",
    !/<details/.test(overview) && !/detailsFold\(/.test(overview) && !/show more/i.test(overview),
    "the owner rejected those explicitly");

  const funding = HTML.slice(HTML.indexOf('funding.appendChild(dashNode("h4", "", "Fund the bot\'s wallet"))'),
    HTML.indexOf('const healthCard = dashNode("section", "dashsection")'));
  const fundingCall = /openDeposit\(\{ address: wallet\.address,\s*requiredForReadinessSol: wallet\.requiredForReadinessSol, balanceSol: wallet\.balanceSol \}\)/.test(funding);
  console.log(`       Bot tab funding card: has Send SOL=${/"Send SOL"/.test(funding)} · ` +
    `targets wallet.address=${fundingCall} · disabled while stale=${/send\.disabled = !connected/.test(funding)}`);
  ok("the bot tab's funding card has it too", /dashNode\("button", "dp-btn", "Send SOL"\)/.test(funding));
  ok("...pointed at the heartbeat's wallet.address", fundingCall);
  ok("...and it is disabled on a STALE heartbeat, exactly as Copy address is",
    /send\.disabled = !connected/.test(funding) && /copy\.disabled = !connected/.test(funding),
    "funding a stale address is funding a wallet that may not be the bot's");
  ok("the card no longer claims the page has no transfer control, which stopped being true",
    !/This page has no transfer control/.test(HTML) &&
    /never receives the burner key, and it cannot move or return what you send/.test(funding),
    "\"…this page never receives the burner key, and it cannot move or return what you send.\"");
}

console.log("\nNO FUNDING SURFACE CALLS AN UNREADABLE BALANCE ZERO");
{
  /* FOUND WHILE BUILDING THE BUTTON, AND IT IS THE EXPENSIVE KIND OF WRONG.
     showBotWallet() reads the balance from /api/bot/rpc, which src/execution-gates.js
     RETIRED: it answers 410 with an {error} body and no `result`. The old line was
     `(d?.result?.value ?? 0) / 1e9`, so every tenant on the team tab was told
     "0.0000 SOL — empty, it cannot trade" over a wallet that may hold plenty — the one
     sentence most likely to make somebody deposit money they did not need to deposit.
     refreshBotBalance() twenty lines below already got this right; both must. */
  const fn = HTML.slice(HTML.indexOf("function showBotWallet(after, wallet)"),
    HTML.indexOf("/* THE BOT'S BALANCE, IN ONE PLACE."));
  const route = /\/api\/bot\/rpc/.test(fn);
  const retired = fs.readFileSync(path.join(ROOT, "src", "execution-gates.js"), "utf8");
  console.log(`       showBotWallet reads ${route ? "/api/bot/rpc" : "(unknown route)"}, ` +
    `which the server answers ${(retired.match(/status:\s*(\d+)/) || [])[1]} with no result field`);
  ok("an unreadable balance reads 'unavailable', never '0.0000 SOL — empty'",
    /if \(!Number\.isFinite\(lamports\)\) \{ bal\.textContent = "balance unavailable"; return; \}/.test(fn),
    "the missing-value branch returns before any figure is painted");
  ok("...and the `?? 0` that produced the false zero is gone",
    !/result\?\.value \?\? 0/.test(fn), "no `d?.result?.value ?? 0` remains");
  ok("the other reader of the same balance still distinguishes empty from unreadable",
    /Number\.isFinite\(Number\(lamports\)\)/.test(HTML.slice(HTML.indexOf("async function refreshBotBalance"),
      HTML.indexOf("function updateBotHb"))),
    "refreshBotBalance keeps sol:null on a bad read");
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE FROZEN SAFETY SET — this change reclassifies nothing.
   ══════════════════════════════════════════════════════════════════════════════ */
{
  const { GATE_CLASS } = await import("./src/calls.js");
  const safety = Object.entries(GATE_CLASS).filter(([, v]) => v === "SAFETY").map(([k]) => k);
  console.log(`\n       SAFETY gates after this change: ${safety.length}`);
  ok("the 31 original SAFETY gates plus bot_mint_refusal and target_inside_zone are intact",
    safety.length === 33 && safety.includes("bot_mint_refusal") && safety.includes("target_inside_zone"),
    `${safety.length} SAFETY gates`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failing: " + failures.join(" | "));
console.log("");
process.exit(fail ? 1 : 0);
