/**
 * THE DESK MUST REFUSE WHAT THE BOT REFUSES — EXTENSION BY EXTENSION.
 *
 * Every pump.fun mint is Token-2022. WALL-ST-E accepts one only when NO extension can
 * tax, block, redirect, freeze, pause or re-denominate a transfer: token2022.mjs
 * `assertTradeableExtensions` throws on anything outside `ALLOWED_MINT_EXTENSIONS`, and
 * the poller classifies that throw as a DETERMINISTIC entry failure — the event is
 * acknowledged without a retry and the cursor advances. A call carrying such a mint is
 * therefore not a risky call, it is a call that can never be taken: the cohort slot, the
 * ~$1.30 workup and the publish are spent on a trade that will not happen.
 *
 * The desk screened THREE of the twenty extensions the bot rejects (permanentDelegate,
 * transferHook, defaultAccountState). transferFeeConfig was flagged in data/solana.js
 * and read by no check at all — it published, and the bot refused it on arrival.
 *
 * So the desk's list is now the bot's list, INVERTED, and this file is what keeps the
 * two honest. It is table-driven over the executor's own `EXTENSION_NAMES`: for every
 * discriminant it builds the mint TWICE — real TLV bytes for the bot, the jsonParsed
 * shape the RPC would return for the desk — runs the REAL `auditMintAccount` and the
 * REAL `mintInfo` + `screen()`, and demands the two refusal sets be identical.
 *
 * WHY THE LIST IS COPIED RATHER THAN IMPORTED, and why that needs a test: the plan for
 * this change recorded that executor/token2022.mjs "has no imports in its header". It
 * has two — `@solana/web3.js` and `node:crypto`, token2022.mjs:16-17 — and
 * @solana/web3.js is an EXECUTOR dependency (the desk's package.json declares three
 * dependencies; @solana lives only in executor/node_modules). Importing the constants
 * into src/ would make the desk fail to boot wherever the executor's tree is absent,
 * Render included. So the parity is asserted here instead, against the executor's own
 * exported constants, and a drift is a red test rather than a silent divergence.
 *
 * WHAT IS REAL: executor/token2022.mjs (auditMintAccount, parseMintExtensions,
 * assertTradeableExtensions, EXTENSION_NAMES, ALLOWED_MINT_EXTENSIONS), src/data/solana.js
 * mintInfo, src/data/evidence.js screen(), src/calls.js GATE_CLASS. WHAT IS STUBBED: the
 * RPC only — one fetch stub answering getAccountInfo exactly as a node would.
 *
 *   node test-token2022-mirror.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t2022-mirror-"));
process.env.CLAUDE_CO_DB = path.join(TMP, "mirror.db");
process.env.EXECUTE = "0";
process.env.SOLANA_RPC = "http://rpc.stub.invalid/";
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* ═══ THE RPC, ANSWERED AS A NODE WOULD ═════════════════════════════════════════════ */
let ACCOUNT = null;                       // the jsonParsed `value` the stub serves
const rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(String(opts.body || "{}"));
  rpcCalls.push(body.method);
  const result = body.method === "getAccountInfo" ? { value: ACCOUNT } : null;
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
};

/* ═══ THE TWO SIDES ═════════════════════════════════════════════════════════════════ */
const bot = await import("./executor/token2022.mjs");
const { mintInfo, BOT_ALLOWED_EXTENSIONS } = await import("./src/data/solana.js");
const { screen } = await import("./src/data/evidence.js");
const { GATE_CLASS, gateClass, SAFETY_GATES } = await import("./src/calls.js");

const { EXTENSION_NAMES, ALLOWED_MINT_EXTENSIONS, BASE_MINT_LENGTH, TLV_START,
  ACCOUNT_TYPE_OFFSET, ACCOUNT_TYPE_MINT, TOKEN_2022_PROGRAM, auditMintAccount } = bot;

/** jsonParsed spells the discriminant in camelCase; the TLV enum in PascalCase. */
const camel = (name) => name.charAt(0).toLowerCase() + name.slice(1);

const MINT = "S1MmirrorQwErTyUiOpAsDfGhJkLzXcVbNm12345pump";

/* ── the bot's view: real mint bytes ─────────────────────────────────────────────────
   base mint = 82 bytes ([0..4) mint-authority COption tag, 44 decimals, 45 initialized,
   [46..50) freeze-authority tag), zero padding to 165, byte 165 = account type, TLV from
   166 as u16 LE type + u16 LE length + value. `owner` is a plain string on purpose:
   token2022.mjs's ownerOf() takes `.toBase58?.() || String(owner)`, so the test needs no
   @solana/web3.js of its own (the desk does not have it installed). */
function mintBytes({ ext = [], decimals = 6, initialized = 1 } = {}) {
  const parts = [];
  for (const { type, value = Buffer.alloc(0) } of ext) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type, 0);
    header.writeUInt16LE(value.length, 2);
    parts.push(header, value);
  }
  const tlv = Buffer.concat(parts);
  const data = Buffer.alloc(ext.length ? TLV_START + tlv.length : BASE_MINT_LENGTH);
  data.writeUInt32LE(0, 0);                        // no mint authority
  data.writeUInt32LE(0, 46);                       // no freeze authority
  data[44] = decimals;
  data[45] = initialized;
  if (ext.length) { data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT; tlv.copy(data, TLV_START); }
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** Does the executor accept this mint? Returns null on acceptance, the reason on refusal. */
function botVerdict(spec) {
  try { auditMintAccount(mintBytes(spec), MINT); return null; }
  catch (error) { return error.message; }
}

/* ── the desk's view: the jsonParsed account the same mint would return ────────────── */
const parsedAccount = ({ extensions = [], decimals = 6, isInitialized = true } = {}) => ({
  owner: TOKEN_2022_PROGRAM,
  data: { parsed: { type: "mint", info: {
    decimals, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null,
    isInitialized, extensions } } },
});

/* A coin that is otherwise unremarkable, so the diff below isolates the MINT's codes.
   Whatever else this ev trips (it is a bare fixture, not a live coin) it trips
   identically in every case, so the baseline subtraction is what makes the comparison
   exact rather than a hand-maintained expectation. */
const cleanEv = (mintAccount) => ({
  mint: MINT, symbol: "MIRROR",
  pair: { priceUsd: 0.001, priceChange: { m5: 2 }, liquidityUsd: 90_000, ageHours: 30,
    volume: { h24: 90_000 }, txns: { h24: { buys: 300, sells: 250 } }, marketCap: 300_000 },
  pairs: { totalLiquidityUsd: 90_000, count: 2 },
  derived: { ageHours: 30 },
  exitProbe: { roundTripLossPct: 3.1 },
  holders: { ok: true, top1Pct: 4, top10Pct: 22 },
  mintAccount,
});
const codesFor = (mintAccount) => screen(cleanEv(mintAccount)).fails.map((f) => f.code).sort();
const BASELINE = codesFor({ ok: true, flags: [] });

/** Which MINT codes did this account add over the baseline? */
async function deskVerdict(spec) {
  ACCOUNT = parsedAccount(spec);
  const acct = await mintInfo(MINT);
  const codes = codesFor(acct);
  return { codes: codes.filter((c) => !BASELINE.includes(c)), acct };
}

/* ═══ 1. THE TWO LISTS ARE THE SAME LIST ════════════════════════════════════════════ */
console.log("\nSOURCE PARITY: the desk's allowlist IS the executor's, converted to jsonParsed names");
{
  const fromBot = [...ALLOWED_MINT_EXTENSIONS].sort((a, b) => a - b).map((t) => camel(EXTENSION_NAMES[t]));
  const fromDesk = [...BOT_ALLOWED_EXTENSIONS];
  ok("every type the executor allows is spelled in the desk's allowlist",
    same([...fromBot].sort(), [...fromDesk].sort()),
    `bot(${fromBot.length}) = ${fromBot.join(" ")}\n         desk(${fromDesk.length}) = ${fromDesk.join(" ")}`);
  ok("the executor allows exactly 8 mint extensions", ALLOWED_MINT_EXTENSIONS.size === 8,
    `ALLOWED_MINT_EXTENSIONS = {${[...ALLOWED_MINT_EXTENSIONS].sort((a, b) => a - b).join(",")}}`);
  // A copied constant is only safe while somebody checks the copy. This is that check:
  // if the executor ever adds or drops a type, the line above goes red on the next run.
  const srcHasAllowlist = fs.readFileSync(path.join(REPO, "executor/token2022.mjs"), "utf8")
    .includes("export const ALLOWED_MINT_EXTENSIONS");
  ok("the parity is read from the executor's own source, not from a second copy",
    srcHasAllowlist, "executor/token2022.mjs exports ALLOWED_MINT_EXTENSIONS");
}

/* ═══ 2. EVERY EXTENSION, BOTH SIDES ════════════════════════════════════════════════ */
console.log("\nEVERY EXTENSION IN THE ENUM: the bot's verdict and the desk's, side by side");
const table = [];
{
  for (const [typeStr, name] of Object.entries(EXTENSION_NAMES)) {
    const type = Number(typeStr);
    /* Type 0 is the TLV TERMINATOR, not an extension — parseMintExtensions stops there.
       It cannot be built as a one-extension mint, so it is asserted separately below. */
    if (type === 0) continue;
    // DefaultAccountState carries a state byte; every other type's value is irrelevant to
    // the acceptance decision, so a zero-length value keeps the fixture honest and small.
    const value = type === 6 ? Buffer.from([1]) : Buffer.alloc(0);
    const state = type === 6 ? { accountState: "initialized" } : {};
    const botWhy = botVerdict({ ext: [{ type, value }] });
    const desk = await deskVerdict({ extensions: [{ extension: camel(name), state }] });
    table.push({ type, name, jsonName: camel(name), botRefused: botWhy != null, botWhy,
      deskCodes: desk.codes });
  }
  const botRefuses = table.filter((r) => r.botRefused).map((r) => r.jsonName);
  const deskRefuses = table.filter((r) => r.deskCodes.length).map((r) => r.jsonName);
  console.log(`  bot refuses  (${botRefuses.length}): ${botRefuses.join(" ")}`);
  console.log(`  desk refuses (${deskRefuses.length}): ${deskRefuses.join(" ")}`);
  console.log(`  bot admits   (${table.length - botRefuses.length}): ` +
    table.filter((r) => !r.botRefused).map((r) => r.jsonName).join(" "));
  console.log(`  desk admits  (${table.length - deskRefuses.length}): ` +
    table.filter((r) => !r.deskCodes.length).map((r) => r.jsonName).join(" "));
  ok("the two refusal sets are identical, extension for extension",
    same(botRefuses, deskRefuses),
    `bot-only: ${botRefuses.filter((n) => !deskRefuses.includes(n)).join(" ") || "none"} · ` +
    `desk-only: ${deskRefuses.filter((n) => !botRefuses.includes(n)).join(" ") || "none"}`);
  ok("the desk admits exactly the 8 the executor allows",
    same(table.filter((r) => !r.deskCodes.length).map((r) => r.jsonName).sort(),
      [...BOT_ALLOWED_EXTENSIONS].sort()),
    table.filter((r) => !r.deskCodes.length).map((r) => r.jsonName).join(" "));
  for (const row of table)
    console.log(`    ${String(row.type).padStart(2)} ${row.jsonName.padEnd(30)} ` +
      `bot=${row.botRefused ? "REFUSE" : "admit "}  desk=${row.deskCodes.join(",") || "admit"}`);
}

/* ═══ 3. THE CODE EACH REFUSAL LANDS ON ═════════════════════════════════════════════ */
console.log("\nTHE THREE PRE-EXISTING CODES KEEP THEIR REFUSALS — no relabelling, no double count");
{
  const codeOf = (jsonName) => table.find((r) => r.jsonName === jsonName)?.deskCodes ?? [];
  for (const [jsonName, expected] of [["permanentDelegate", "seizable"],
                                      ["transferHook", "transfer_hook"]])
    ok(`${jsonName} still refuses as ${expected}, and as nothing else`,
      same(codeOf(jsonName), [expected]), `codes = ${codeOf(jsonName).join(",")}`);
  const newly = table.filter((r) => r.deskCodes.includes("bot_mint_refusal")).map((r) => r.jsonName);
  ok("every other refusal lands on bot_mint_refusal exactly once",
    table.every((r) => r.deskCodes.filter((c) => c === "bot_mint_refusal").length <= 1)
      && newly.length === table.filter((r) => r.botRefused).length - 2,
    `${newly.length} on bot_mint_refusal: ${newly.join(" ")}`);
  /* THE REGRESSION THIS STEP EXISTS FOR. transferFeeConfig was flagged by solana.js and
     screened by nothing, so it published and the bot refused it on arrival. */
  ok("transferFeeConfig — flagged for years, screened by nobody — now refuses",
    codeOf("transferFeeConfig").includes("bot_mint_refusal"),
    `codes = ${codeOf("transferFeeConfig").join(",") || "NONE — it would publish"}`);
}

/* ═══ 4. DEFAULT ACCOUNT STATE: THE ONE EXTENSION WITH A PAYLOAD ════════════════════ */
console.log("\nDefaultAccountState: Initialized passes on both sides, Frozen fails on both");
{
  const cases = [
    ["initialized", 1, false],
    ["frozen", 2, true],
    ["uninitialized", 0, true],
  ];
  for (const [stateName, stateByte, shouldRefuse] of cases) {
    const botWhy = botVerdict({ ext: [{ type: 6, value: Buffer.from([stateByte]) }] });
    const desk = await deskVerdict({ extensions: [{ extension: "defaultAccountState",
      state: { accountState: stateName } }] });
    ok(`defaultAccountState=${stateName}: bot ${shouldRefuse ? "refuses" : "accepts"}`,
      (botWhy != null) === shouldRefuse, botWhy ?? "accepted");
    ok(`defaultAccountState=${stateName}: desk ${shouldRefuse ? "refuses" : "accepts"}`,
      (desk.codes.length > 0) === shouldRefuse, `codes = ${desk.codes.join(",") || "none"}`);
    if (shouldRefuse)
      ok(`...and it is the PRE-EXISTING frozen_by_default code, unchanged`,
        desk.codes.includes("frozen_by_default"), desk.codes.join(","));
  }
  /* UNVERIFIED IS NOT SAFE: a state the RPC did not spell is not an accepted state. */
  const blind = await deskVerdict({ extensions: [{ extension: "defaultAccountState" }] });
  ok("a defaultAccountState whose state could not be read still refuses",
    blind.codes.includes("frozen_by_default"), `codes = ${blind.codes.join(",") || "none"}`);
}

/* ═══ 5. THE MINT-LEVEL FACTS: DECIMALS AND INITIALISATION ══════════════════════════ */
console.log("\nTHE REST OF THE EXECUTOR'S AUDIT: the decimal range and an uninitialized mint");
{
  for (const [decimals, shouldRefuse] of [[0, false], [6, false], [18, false], [19, true], [255, true]]) {
    const botWhy = botVerdict({ decimals });
    const desk = await deskVerdict({ decimals });
    ok(`decimals=${decimals}: bot ${shouldRefuse ? "refuses" : "accepts"}`,
      (botWhy != null) === shouldRefuse, botWhy ?? "accepted");
    ok(`decimals=${decimals}: desk ${shouldRefuse ? "refuses" : "accepts"}`,
      desk.codes.includes("bot_mint_refusal") === shouldRefuse,
      `codes = ${desk.codes.join(",") || "none"}`);
  }
  const botUninit = botVerdict({ initialized: 0 });
  const deskUninit = await deskVerdict({ isInitialized: false });
  ok("an uninitialized mint: the bot refuses", botUninit != null, botUninit ?? "accepted");
  ok("an uninitialized mint: the desk refuses",
    deskUninit.codes.includes("bot_mint_refusal"), `codes = ${deskUninit.codes.join(",") || "none"}`);
  /* An account that came back without a mint's shape at all. The bot refuses it from the
     bytes; the desk must not read a missing decimal count as a lenient one. */
  const botShapeless = (() => {
    try { auditMintAccount({ owner: TOKEN_2022_PROGRAM, data: Buffer.alloc(12) }, MINT); return null; }
    catch (error) { return error.message; }
  })();
  ACCOUNT = { owner: TOKEN_2022_PROGRAM, data: { parsed: { type: "mint", info: {} } } };
  const deskShapeless = codesFor(await mintInfo(MINT));
  ok("a mint account with no shape: the bot refuses", botShapeless != null, botShapeless ?? "accepted");
  ok("a mint account with no decimals: the desk refuses rather than passing an unknown",
    deskShapeless.includes("bot_mint_refusal"), `codes = ${deskShapeless.join(",") || "none"}`);
}

/* ═══ 6. THE UNKNOWN CASES, WHICH MUST FAIL CLOSED ═════════════════════════════════ */
console.log("\nUNKNOWN FAILS CLOSED on both sides");
{
  const botWhy = botVerdict({ ext: [{ type: 250 }] });
  ok("an extension type outside the enum: the bot refuses", botWhy != null, botWhy ?? "accepted");
  // The RPC's own name for a type it cannot decode.
  const desk = await deskVerdict({ extensions: [{ extension: "unparseableExtension" }] });
  ok("...and the desk refuses the RPC's `unparseableExtension`",
    desk.codes.includes("bot_mint_refusal"), `codes = ${desk.codes.join(",") || "none"}`);
  const invented = await deskVerdict({ extensions: [{ extension: "someExtensionInventedIn2027" }] });
  ok("...and a name neither side has ever seen", invented.codes.includes("bot_mint_refusal"),
    `codes = ${invented.codes.join(",") || "none"}`);
  /* THE ONE STATED DIVERGENCE, and it is in the safe direction: type 0 is the TLV
     TERMINATOR for the bot (parseMintExtensions stops and demands zeros after it), while
     jsonParsed would name it `uninitialized`, which is not on the desk's allowlist and so
     refuses. The desk is stricter; nothing publishes that the bot would have taken. */
  const zero = await deskVerdict({ extensions: [{ extension: "uninitialized" }] });
  ok("a jsonParsed `uninitialized` extension refuses (desk stricter than the terminator)",
    zero.codes.includes("bot_mint_refusal"), `codes = ${zero.codes.join(",") || "none"}`);
}

/* ═══ 7. A CLEAN PUMP.FUN MINT STILL PASSES ════════════════════════════════════════ */
console.log("\nTHE SHAPE EVERY PUMP.FUN COIN HAS still passes — this is a tightening, not a wall");
{
  const spec = { ext: [{ type: 18 }, { type: 19 }] };
  const botWhy = botVerdict(spec);
  const desk = await deskVerdict({ extensions: [{ extension: "metadataPointer" },
                                                { extension: "tokenMetadata" }] });
  ok("MetadataPointer + TokenMetadata: the bot accepts", botWhy == null, botWhy ?? "accepted");
  ok("MetadataPointer + TokenMetadata: the desk adds no code", desk.codes.length === 0,
    `codes = ${desk.codes.join(",") || "none"} · botRefusals = ${JSON.stringify(desk.acct.botRefusals)}`);
  ok("a classic SPL mint with no extensions passes too", (await deskVerdict({})).codes.length === 0);
  console.log(`  the screen's baseline for this fixture (subtracted from every case above): ` +
    `${BASELINE.join(",") || "no codes"}`);
  console.log(`  RPC methods the desk called: ${[...new Set(rpcCalls)].join(",")} ` +
    `(${rpcCalls.length} reads, all of them the account it already fetches)`);
}

/* ═══ 8. THE GATE ══════════════════════════════════════════════════════════════════ */
console.log("\nTHE GATE IS REGISTERED BY NAME AND IS SAFETY");
{
  ok("bot_mint_refusal is in GATE_CLASS BY NAME, not by default-deny",
    Object.hasOwn(GATE_CLASS, "bot_mint_refusal"), `= ${GATE_CLASS.bot_mint_refusal}`);
  ok("bot_mint_refusal is SAFETY", gateClass("bot_mint_refusal") === "SAFETY",
    `gateClass("bot_mint_refusal") = ${gateClass("bot_mint_refusal")}`);
  ok("...and it appears in SAFETY_GATES", SAFETY_GATES.includes("bot_mint_refusal"),
    `${SAFETY_GATES.length} safety gates`);
  for (const kept of ["seizable", "transfer_hook", "frozen_by_default", "freezable", "mintable"])
    ok(`${kept} is untouched and still SAFETY`, gateClass(kept) === "SAFETY", `= ${gateClass(kept)}`);
}

console.log(`\n${pass} passed, ${fail} failed.`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
