/**
 * AUTOPILOT THROUGH THE SERVICE WORKER, AND THE FIRST-RUN SETUP.
 *
 * The real src/background.mjs is loaded under a `chrome` double (storage.local and
 * storage.session over Maps, alarms, tabs, notifications, the runtime's message and port
 * events) with `fetch` answered by a JSON-RPC chain double. That chain executes what it is
 * sent — system transfers, idempotent ATA creates, TransferChecked, CloseAccount — verifies
 * every required ed25519 signature over the message, charges the fee the compute budget
 * implies, refuses Token-2022's plain Transfer out of a pausable, hooked xStock account
 * exactly as the program does (MintRequiredForTransfer), and applies the runtime's rent
 * rule (a payer ends at 0 or at 890,880 lamports, never between). Phantom is a console
 * port that signs with a throwaway key, or declines. Nothing touches a network.
 *
 * What is proved:
 *   1. install opens the setup page once; an update or a browser start does not;
 *   2. the three styles: Cautious and Balanced no looser than the lane's defaults on any
 *      dial, Bold labelled looser; every style keeps the entry rule and can be armed;
 *      the stock choices are real keys, the fixture's three first;
 *   3. only the extension's own pages can drive the autopilot wallet;
 *   4. create: the passphrase typed twice, 12 characters or more; the blob in
 *      storage.local, nothing in session, the passphrase nowhere;
 *   5. the signer switch: on autopilot the lane's wallet is the autopilot wallet, the
 *      checklist is the autopilot one, the console tab still sees Phantom's wallet;
 *   6. FUND: needs Phantom; one Phantom approval per funding, a transfer the worker built
 *      for exactly the amount (default: the daily budget); a listed stock by
 *      TransferChecked; a declined approval moves nothing;
 *   7. UNLOCK with a TTL: the session entry and the expiry alarm; out-of-range refused;
 *   8. EXPORT: the passphrase is required, the key comes back once and is the wallet's;
 *   9. SWEEP: refused locked or to a destination not confirmed; unlocked, every token
 *      (TransferChecked, the emptied account closed), every empty account closed, and the
 *      SOL down to exactly the rent floor — all signed by the autopilot key, Phantom
 *      asked nothing;
 *   10. LOCK clears the unlocked key; an unlock that ran out locks itself, says so;
 *   11. nothing the worker logged or stored carries the passphrase or the key;
 *   11b. REPLACE: refused while the wallet holds SOL above the floor, refused with the
 *       wrong current passphrase, and once swept it makes a new wallet, locked, the old
 *       unlocked key dropped;
 *   12. a sweep, or a replace, is refused while the autopilot wallet holds a live position.
 */
import { Keypair, PublicKey, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { UI, AUTOPILOT, BRIDGE } from "./src/lib/protocol.mjs";
import {
  CONFIG_DEFAULTS, STYLE_PRESETS, STOCK_FOCUS_CHOICES, KNOWN_STOCK_QUOTES, normalizeConfig, browserArmability, browserArmSentence,
  RECORD, CANARY_SOL,
} from "./src/lib/config.mjs";
import { SNIPE_DEFAULTS as POLICY_DEFAULTS } from "./vendor/executor/snipe-policy.mjs";
import { SNIPE_LANE_DEFAULTS } from "./vendor/executor/snipe-lane.mjs";
import { associatedTokenAddress, fromBase64, toBase64, ATA_PROGRAM, SYSTEM_PROGRAM } from "./src/lib/tx.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./vendor/executor/token2022.mjs";
import { ENGINE_VERSION } from "./src/lib/engine.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ── what the worker says, captured ───────────────────────────────────────────────── */
const captured = [];
const realLog = console.log;
for (const level of ["log", "warn", "error", "info", "debug"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    if (!/^\s{2}(ok|FAIL) |^\n?\S.*\n─+$/.test(line)) captured.push(line);
    if (/^hawk: /.test(line)) return;            // the worker's own lines: captured and scanned below, not echoed
    original(...args);
  };
}

/* ── constants ─────────────────────────────────────────────────────────────────────── */
const EXT = "coinmarketcatextensionid";
const PAGE = { id: EXT, url: `chrome-extension://${EXT}/popup.html` };
const PASS = "a long enough passphrase for a cat";
const PHANTOM_KP = Keypair.generate();
const PHANTOM = PHANTOM_KP.publicKey.toBase58();
const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const XFIX = JSON.parse(fs.readFileSync(new URL("./vendor/executor/fixtures/pumpfun-xstock-quote.json", import.meta.url), "utf8"));
const fixtureAccount = (address) => XFIX.accounts.find((a) => a.address === address);
const GLDX_VAULT_BYTES = Buffer.from(fixtureAccount("4oYp7TZ1tBrvHHfMTA8oVYATbVVfiE19vRTfbRvPd5EL").data[0], "base64");
const RENT_FLOOR = 890_880n;
const RENT_CLASSIC_ATA = 2_039_280n;
const RENT_XSTOCK_ATA = BigInt(XFIX.rentExemptLamports["179"]);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/* ── the chain double, behind fetch ───────────────────────────────────────────────── */
function createChain() {
  const state = {
    lamports: new Map([[PHANTOM, 5_000_000_000n]]),
    tokens: new Map(),        // ata → { mint, owner, amount, programId, decimals }
    sent: [], sims: 0, height: 300_000_000, slot: 450_000_000, statuses: new Map(),
  };
  const mintInfo = (mint) => (mint === GLDX ? { programId: TOKEN_2022_PROGRAM, decimals: 8, rent: RENT_XSTOCK_ATA, pausableHooked: true } : { programId: TOKEN_PROGRAM, decimals: 6, rent: RENT_CLASSIC_ATA, pausableHooked: false });
  const u64 = (buf, at) => Buffer.from(buf).readBigUInt64LE(at);
  function execute(bytes, s, { verify }) {
    const tx = VersionedTransaction.deserialize(bytes);
    const msg = tx.message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const nSig = msg.header.numRequiredSignatures;
    const signers = new Set(keys.slice(0, nSig));
    if (verify) {
      for (let i = 0; i < nSig; i++)
        if (!ed25519.verify(tx.signatures[i], msg.serialize(), new PublicKey(keys[i]).toBytes())) throw new Error(`SignatureFailure: ${keys[i]} did not sign this message`);
    }
    let limit = 200_000n, price = 0n;
    for (const ix of msg.compiledInstructions) if (keys[ix.programIdIndex] === COMPUTE_BUDGET) {
      const d = Buffer.from(ix.data);
      if (d[0] === 2) limit = BigInt(d.readUInt32LE(1));
      if (d[0] === 3) price = u64(d, 1);
    }
    const fee = 5_000n * BigInt(nSig) + (price * limit + 999_999n) / 1_000_000n;
    const payer = keys[0];
    const bal = (k) => s.lamports.get(k) ?? 0n;
    if (bal(payer) < fee) throw new Error("InsufficientFundsForFee");
    s.lamports.set(payer, bal(payer) - fee);
    const touched = new Set([payer]);
    for (const ix of msg.compiledInstructions) {
      const program = keys[ix.programIdIndex];
      const acc = ix.accountKeyIndexes.map((i) => keys[i]);
      const d = Buffer.from(ix.data);
      if (program === COMPUTE_BUDGET) continue;
      if (program === SYSTEM_PROGRAM) {
        if (d.readUInt32LE(0) !== 2) throw new Error("unsupported system instruction");
        const [from, to] = acc; const amount = u64(d, 4);
        if (!signers.has(from)) throw new Error("MissingRequiredSignature: the transfer's source");
        if (bal(from) < amount) throw new Error("InsufficientFunds: system transfer");
        s.lamports.set(from, bal(from) - amount); s.lamports.set(to, bal(to) + amount);
        touched.add(from); touched.add(to);
        continue;
      }
      if (program === ATA_PROGRAM) {
        const [payerKey, ata, owner, mint, , tokenProgram] = acc;
        const info = mintInfo(mint);
        if (d[0] !== 1) throw new Error("only the idempotent create is modelled");
        if (tokenProgram !== info.programId) throw new Error(`IncorrectProgramId: ${mint} is owned by ${info.programId}`);
        if (associatedTokenAddress(owner, mint, tokenProgram) !== ata) throw new Error("InvalidSeeds");
        if (!s.tokens.has(ata)) {
          if (bal(payerKey) < info.rent) throw new Error("InsufficientFunds: ATA rent");
          s.lamports.set(payerKey, bal(payerKey) - info.rent); s.lamports.set(ata, info.rent);
          s.tokens.set(ata, { mint, owner, amount: 0n, programId: tokenProgram, decimals: info.decimals });
          touched.add(payerKey);
        }
        continue;
      }
      if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
        const op = d[0];
        if (op === 3) {
          const src = s.tokens.get(acc[0]);
          if (src && mintInfo(src.mint).pausableHooked) throw new Error("MintRequiredForTransfer: a plain Transfer out of an account with PausableAccount / TransferHookAccount");
          throw new Error("plain Transfer is not modelled beyond its refusal");
        }
        if (op === 12) {
          const [srcA, mint, dstA, owner] = acc;
          const amount = u64(d, 1), decimals = d[9];
          const src = s.tokens.get(srcA), dst = s.tokens.get(dstA);
          if (!src || !dst) throw new Error("AccountNotInitialized");
          if (src.mint !== mint || dst.mint !== mint) throw new Error("MintMismatch");
          if (src.programId !== program) throw new Error("IncorrectProgramId");
          if (decimals !== mintInfo(mint).decimals) throw new Error("MintDecimalsMismatch");
          if (src.owner !== owner || !signers.has(owner)) throw new Error("OwnerMismatch");
          if (src.amount < amount) throw new Error("InsufficientFunds: tokens");
          src.amount -= amount; dst.amount += amount;
          continue;
        }
        if (op === 9) {
          const [account, dest, owner] = acc;
          const t = s.tokens.get(account);
          if (!t) throw new Error("AccountNotInitialized: close");
          if (t.amount !== 0n) throw new Error("NonNativeHasBalance");
          if (t.owner !== owner || !signers.has(owner)) throw new Error("OwnerMismatch: close");
          s.lamports.set(dest, bal(dest) + bal(account)); s.lamports.delete(account); s.tokens.delete(account);
          touched.add(dest);
          continue;
        }
        throw new Error(`unsupported token instruction ${op}`);
      }
      throw new Error(`unsupported program ${program}`);
    }
    for (const k of touched) {
      if (s.tokens.has(k)) continue;
      const v = bal(k);
      if (v !== 0n && v < RENT_FLOOR) throw new Error(`InsufficientFundsForRent: ${k} would hold ${v}`);
    }
    return { fee, signature: bs58.encode(tx.signatures[0]), keys, instructions: msg.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map((i) => keys[i]) })) };
  }
  const clone = () => ({ ...state, lamports: new Map(state.lamports), tokens: new Map([...state.tokens].map(([k, v]) => [k, { ...v }])) });
  const commit = (s) => { state.lamports = s.lamports; state.tokens = s.tokens; };
  const account = (address) => {
    if (address === GLDX) { const a = fixtureAccount(GLDX); return { data: a.data, owner: a.owner, lamports: a.lamports, executable: false }; }
    if (state.lamports.has(address)) return { data: ["", "base64"], owner: SYSTEM_PROGRAM, lamports: Number(state.lamports.get(address)), executable: false };
    return null;
  };
  const handlers = {
    getBalance: ([address]) => ({ context: { slot: state.slot }, value: Number(state.lamports.get(address) ?? 0n) }),
    getLatestBlockhash: () => ({ context: { slot: state.slot }, value: { blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: state.height + 150 } }),
    getBlockHeight: () => state.height,
    getMultipleAccounts: ([addresses]) => ({ context: { slot: state.slot }, value: addresses.map(account) }),
    getTokenAccountsByOwner: ([owner, { programId }]) => ({ context: { slot: state.slot }, value: [...state.tokens].filter(([, t]) => t.owner === owner && t.programId === programId).map(([pubkey, t]) => ({
      pubkey, account: { owner: programId, lamports: Number(state.lamports.get(pubkey) ?? 0n), data: { program: "spl-token", parsed: { type: "account", info: { mint: t.mint, owner: t.owner, tokenAmount: { amount: t.amount.toString(), decimals: t.decimals } } } } },
    })) }),
    simulateTransaction: ([b64]) => {
      state.sims++;
      try { execute(fromBase64(b64), clone(), { verify: false }); return { context: { slot: state.slot }, value: { err: null, logs: [], accounts: null, unitsConsumed: 5_000 } }; }
      catch (error) { return { context: { slot: state.slot }, value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: [`Program log: ${error.message}`], accounts: null } }; }
    },
    sendTransaction: ([b64, opts]) => {
      const s = clone();
      const effects = execute(fromBase64(b64), s, { verify: true });   // a bad signature throws: the RPC refuses it
      commit(s);
      state.sent.push({ ...effects, bytes: fromBase64(b64), preflight: opts?.skipPreflight === false });
      state.statuses.set(effects.signature, { err: null, confirmationStatus: "confirmed" });
      return effects.signature;
    },
    getSignatureStatuses: ([sigs]) => ({ context: { slot: state.slot }, value: sigs.map((sig) => state.statuses.get(sig) ?? null) }),
  };
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    const handler = handlers[body.method];
    let payload;
    if (!handler) payload = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `method ${body.method} is not in the double` } };
    else {
      try { payload = { jsonrpc: "2.0", id: body.id, result: handler(body.params ?? []) }; }
      catch (error) { payload = { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: error.message } }; }
    }
    return { ok: true, status: 200, async json() { return payload; } };
  }
  return { state, fetchImpl, giveTokens(owner, mint, amount) {
    const info = mintInfo(mint); const ata = associatedTokenAddress(owner, mint, info.programId);
    state.tokens.set(ata, { mint, owner, amount: BigInt(amount), programId: info.programId, decimals: info.decimals });
    state.lamports.set(ata, info.rent);
    return ata;
  } };
}

/* ── the chrome double ────────────────────────────────────────────────────────────── */
function createChrome({ local = new Map(), session = new Map() } = {}) {
  const listeners = { message: [], connect: [], installed: [], startup: [], alarm: [] };
  const alarms = new Map(), notes = [], tabs = [], accessLevels = [];
  const area = (m, name) => ({
    async get(keys) {
      const list = keys == null ? [...m.keys()] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {}; for (const k of list) if (m.has(k)) out[k] = structuredClone(m.get(k)); return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) m.delete(k); },
    ...(name === "session" ? { async setAccessLevel(o) { accessLevels.push(o.accessLevel); } } : {}),
  });
  const chrome = {
    runtime: {
      id: EXT, getURL: (p) => `chrome-extension://${EXT}/${p}`,
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onConnect: { addListener: (f) => listeners.connect.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      sendMessage: async () => undefined,
      openOptionsPage() {},
    },
    storage: { local: area(local, "local"), session: area(session, "session") },
    alarms: { create: (name, info) => alarms.set(name, info), clear: async (name) => alarms.delete(name), onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
    notifications: { create: (id, opts) => notes.push({ id, ...opts }), clear() {}, onClicked: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: { create: async (o) => { tabs.push(o); return { id: tabs.length }; }, query: async () => [], update: async () => ({}) },
    windows: { update: async () => ({}) },
  };
  return { chrome, listeners, alarms, notes, tabs, local, session, accessLevels };
}
function sendMessage(ch, msg, sender = PAGE) {
  return new Promise((resolve) => {
    for (const f of ch.listeners.message) {
      const r = f(msg, sender, resolve);
      if (r === true) return;
    }
    resolve(undefined);
  });
}
/** A console tab with Phantom on it: a port that signs with PHANTOM_KP, or declines. */
function connectPhantom(ch) {
  const onMessage = [], onDisconnect = [];
  const p = { posted: [], signs: [], mode: "approve" };
  const deliver = (m) => { for (const f of onMessage) f(m); };
  p.port = {
    name: "hawk-console", sender: { tab: { id: 7 }, origin: "https://gtjvv976mb-netizen.github.io", url: "https://gtjvv976mb-netizen.github.io/coinmarketcat/console/" },
    onMessage: { addListener: (f) => onMessage.push(f) }, onDisconnect: { addListener: (f) => onDisconnect.push(f) },
    disconnect() {},
    postMessage(msg) {
      p.posted.push(msg);
      if (msg.type !== BRIDGE.SIGN) return;
      p.signs.push(msg);
      setTimeout(() => {
        if (p.mode === "reject") return deliver({ type: BRIDGE.REPLY, id: msg.id, ok: false, error: { code: "rejected", message: "you declined in Phantom" } });
        const tx = VersionedTransaction.deserialize(fromBase64(msg.txBase64));
        tx.sign([PHANTOM_KP]);
        deliver({ type: BRIDGE.REPLY, id: msg.id, ok: true, result: { signedBase64: toBase64(tx.serialize()) } });
      }, 5);
    },
  };
  for (const f of ch.listeners.connect) f(p.port);
  deliver({ type: BRIDGE.ACCOUNT, publicKey: PHANTOM });
  p.deliver = deliver;
  return p;
}

/* ═══════════════════════════════════════════════════════════════════════════════════ */

section("1. INSTALL OPENS THE SETUP PAGE — ONCE");
const chain = createChain();
globalThis.fetch = chain.fetchImpl;
globalThis.WebSocket = class { constructor() { throw new Error("no sockets in this test"); } };
const ch = createChrome();
globalThis.chrome = ch.chrome;
await import("./src/background.mjs");
let res = await sendMessage(ch, { type: UI.GET_STATUS });
ok("the worker boots under the double and answers", res?.ok === true && res.status.signerMode === "phantom" && res.status.lane === "off", `lane ${res?.status?.lane}, signer ${res?.status?.signerMode}`);
ok("the unlocked key's area is pinned to trusted contexts", ch.accessLevels.includes("TRUSTED_CONTEXTS"));
for (const f of ch.listeners.installed) f({ reason: "update", previousVersion: "0.0.9" });
for (const f of ch.listeners.startup) f();
ok("an update and a browser start open nothing", ch.tabs.length === 0);
for (const f of ch.listeners.installed) f({ reason: "install" });
await tick(5);
ok("install opens welcome.html, the extension's own page", ch.tabs.length === 1 && ch.tabs[0].url === `chrome-extension://${EXT}/welcome.html`, JSON.stringify(ch.tabs));
ok("…and arms the keepalive the lane has always had", ch.alarms.has("hawk-keepalive") && ch.alarms.get("hawk-keepalive").periodInMinutes === 0.5);
ok("the popup is told setup has not run", res.status.setupCompletedAt === 0 || res.status.setupCompletedAt === undefined);

section("2. THE STYLES, AND THE STOCKS A NEW USER CAN PICK");
{
  const D = { maxSolPerTrade: CONFIG_DEFAULTS.maxSolPerTrade, dailySolCap: CONFIG_DEFAULTS.dailySolCap, takeAtEntryX: CONFIG_DEFAULTS.takeAtEntryX, stallMs: POLICY_DEFAULTS.stallMs, timeStopMs: POLICY_DEFAULTS.timeStopMs, entryWaitMs: CONFIG_DEFAULTS.entryWaitMs, entryFollowThroughX: CONFIG_DEFAULTS.entryFollowThroughX, stopFrac: POLICY_DEFAULTS.stopFrac };
  ok("the record-derived defaults are what the lane ships: 0.005 SOL, 0.01 SOL a day, 1.5x, 90 s, 180 s, 10 s, 1.0x", D.maxSolPerTrade === 0.005 && D.dailySolCap === 0.01 && D.takeAtEntryX === 1.5 && D.stallMs === 90_000 && D.timeStopMs === 180_000 && D.entryWaitMs === 10_000 && D.entryFollowThroughX === 1.0, JSON.stringify(D));
  const looser = (v) => {
    const out = [];
    if (v.maxSolPerTrade > D.maxSolPerTrade) out.push("ticket");
    if (v.dailySolCap > D.dailySolCap) out.push("day");
    if (v.takeAtEntryX > D.takeAtEntryX) out.push("take");
    if (!(v.stallMs > 0) || v.stallMs > D.stallMs) out.push("stall");
    if (!(v.timeStopMs > 0) || v.timeStopMs > D.timeStopMs) out.push("time stop");
    if (v.entryWaitMs < D.entryWaitMs) out.push("wait");
    if (v.entryFollowThroughX < D.entryFollowThroughX) out.push("follow-through");
    if (v.stopFrac !== null && v.stopFrac < D.stopFrac) out.push("stop");
    return out;
  };
  for (const id of ["cautious", "balanced"]) {
    const p = STYLE_PRESETS[id];
    ok(`${p.label}: no looser than the defaults on any dial`, looser(p.values).length === 0 && p.looser === false, looser(p.values).join(",") || JSON.stringify(p.values));
  }
  ok("Balanced IS the defaults", JSON.stringify(Object.keys(D).map((k) => STYLE_PRESETS.balanced.values[k] ?? null)) === JSON.stringify(Object.keys(D).map((k) => (k === "stopFrac" ? null : D[k]))));
  ok("Cautious is tighter than Balanced somewhere, and says its tighter exits are not a measurement", looser(STYLE_PRESETS.cautious.values).length === 0 && (STYLE_PRESETS.cautious.values.dailySolCap < D.dailySolCap || STYLE_PRESETS.cautious.values.stallMs < D.stallMs) && /not a measured improvement/.test(STYLE_PRESETS.cautious.summary));
  const bold = STYLE_PRESETS.bold;
  ok("Bold is looser, and labelled so in its name, its flag and its words", looser(bold.values).length >= 3 && bold.looser === true && /looser/i.test(bold.label) && /LOOSER than the record supports/.test(bold.summary), looser(bold.values).join(", "));
  ok("Bold's words quote the record, not an invented number", bold.summary.includes(`${RECORD.reached.find((r) => r.x === 2).of64} of the record's 64 coins ever reached 2×`) && /won 0 of 3/.test(bold.summary));
  ok("every style keeps the entry rule: a 10 s wait and a 1.0x follow-through", Object.values(STYLE_PRESETS).every((p) => p.values.entryWaitMs === 10_000 && p.values.entryFollowThroughX === 1.0));
  const W = Keypair.generate().publicKey.toBase58();
  for (const p of Object.values(STYLE_PRESETS)) {
    const cfg = normalizeConfig({ ...CONFIG_DEFAULTS, ...p.values, rpcUrl: "https://rpc.test/", lane: "execute", stylePreset: p.id });
    const arm = browserArmability({ config: { ...cfg, liveAck: browserArmSentence(W, cfg.maxSolPerTrade, cfg.dailySolCap, []) }, wallet: W, hasBridge: true });
    ok(`${p.label}: a valid config that can arm once its sentence is typed`, arm.armable, arm.blocking.join(",") || "nothing blocking");
    ok(`${p.label}: a ticket above the ${CANARY_SOL} SOL canary carries a stop`, p.values.maxSolPerTrade <= CANARY_SOL || p.values.stopFrac !== null);
  }
  ok("the stock choices start with the fixture's three, then name where the rest came from", JSON.stringify(STOCK_FOCUS_CHOICES.slice(0, 3).map((k) => k.mint)) === JSON.stringify(KNOWN_STOCK_QUOTES.map((k) => k.mint)) && STOCK_FOCUS_CHOICES.slice(3).every((k) => k.source !== "fixture" && /not in the vendored fixture/.test(k.sourceNote)), STOCK_FOCUS_CHOICES.map((k) => `${k.symbol}:${k.source}`).join(" "));
  ok("every choice is a real 32-byte key with an Xs vanity prefix, and GLDx, TSLAx, SPYx are there", STOCK_FOCUS_CHOICES.every((k) => new PublicKey(k.mint).toBase58() === k.mint && k.mint.startsWith("Xs")) && ["GLDx", "TSLAx", "SPYx"].every((s) => STOCK_FOCUS_CHOICES.some((k) => k.symbol === s)));
  const listed = normalizeConfig({ quoteMints: STOCK_FOCUS_CHOICES.map((k) => ({ mint: k.mint, symbol: k.symbol, maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.5 })) });
  ok("all five fit the stock list the engine reads (quoteMints), which the setup page writes into", listed.quoteMints.length === 5);
  for (const [key, bad] of [["signerMode", "robot"], ["autopilotUnlockMinutes", 2], ["autopilotUnlockMinutes", 2000], ["stylePreset", "yolo"], ["stallMs", -1]]) {
    let got = null; try { normalizeConfig({ [key]: bad }); } catch (error) { got = error.key; }
    ok(`normalizeConfig refuses ${key} = ${JSON.stringify(bad)} by name`, got === key);
  }
  ok("the signer is Phantom by default, and the lane is off", CONFIG_DEFAULTS.signerMode === "phantom" && CONFIG_DEFAULTS.lane === "off" && CONFIG_DEFAULTS.autopilotUnlockMinutes === 480);
}

section("3. ONLY THE EXTENSION'S OWN PAGES DRIVE THE AUTOPILOT WALLET");
{
  const fromPage = await sendMessage(ch, { type: AUTOPILOT.STATUS }, { id: EXT, url: "https://evil.example/", tab: { id: 3 } });
  ok("a content script's sender (a web page URL) is refused", fromPage?.ok === false && /extension's own pages/.test(fromPage.error), fromPage?.error);
  const otherExt = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: PASS, confirm: PASS }, { id: "someotherextension", url: "chrome-extension://someotherextension/x.html" });
  ok("another extension is refused", otherExt?.ok === false);
  ok("…and neither created anything", ch.local.size === 0 || ![...ch.local.keys()].includes("coinmarketcat:session-wallet"));
  const fromWelcome = await sendMessage(ch, { type: AUTOPILOT.STATUS }, { id: EXT, url: `chrome-extension://${EXT}/welcome.html`, tab: { id: 9 } });
  ok("the setup page (an extension page in a tab) is answered", fromWelcome?.ok === true && fromWelcome.autopilot.exists === false);
}

section("4. CREATE: TYPED TWICE, TWELVE CHARACTERS, STORED SEALED");
let AUTO;
{
  const mismatch = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: PASS, confirm: `${PASS}!` });
  ok("two different passphrases are refused", mismatch?.ok === false && /do not match/.test(mismatch.error), mismatch?.error);
  const short = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: "elevenchars", confirm: "elevenchars" });
  ok("a passphrase under 12 characters is refused", short?.ok === false && short.code === "passphrase_too_short", short?.error);
  const made = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: PASS, confirm: PASS });
  AUTO = made?.publicKey;
  ok("created: a public key comes back", made?.ok === true && new PublicKey(AUTO).toBase58() === AUTO, AUTO);
  const blob = ch.local.get("coinmarketcat:session-wallet");
  ok("the sealed blob is in storage.local under its key, PBKDF2-SHA256 600k + AES-GCM", blob?.publicKey === AUTO && blob.kdf.iterations === 600_000 && blob.cipher.name === "AES-GCM");
  ok("nothing is in session storage: a new wallet is locked", ch.session.size === 0);
  ok("the passphrase is nowhere in storage", !JSON.stringify([...ch.local]).includes(PASS));
  const again = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: PASS, confirm: PASS });
  ok("a second create over it is refused (a funded wallet is not lost to a click)", again?.ok === false && again.code === "exists", again?.error);
  const st = await sendMessage(ch, { type: AUTOPILOT.STATUS });
  ok("status: exists, locked, no RPC read yet", st.autopilot.exists === true && st.autopilot.publicKey === AUTO && st.autopilot.unlocked === false && st.autopilot.balanceLamports === null);
}

section("5. THE SIGNER SWITCH");
let phantom;
{
  res = await sendMessage(ch, { type: UI.SET_CONFIG, config: { rpcUrl: "https://rpc.test/", signerMode: "autopilot" } });
  ok("the signer is a setting like any other", res?.ok === true && res.config.signerMode === "autopilot" && res.config.rpcUrl === "https://rpc.test/", res?.error);
  phantom = connectPhantom(ch);
  await tick(20);
  const s = (await sendMessage(ch, { type: UI.GET_STATUS })).status;
  ok("on autopilot the lane's wallet is the autopilot wallet; Phantom's is reported apart", s.signerMode === "autopilot" && s.wallet === AUTO && s.phantomWallet === PHANTOM, `lane ${s.wallet}, phantom ${s.phantomWallet}`);
  const names = s.armability.items.map((i) => i.name);
  ok("the checklist is the autopilot one: created ✓, unlocked ✗, funded ✗ (empty)", names.includes("autopilot_wallet_created") && s.armability.items.find((i) => i.name === "autopilot_wallet_created").ok && s.armability.blocking.includes("autopilot_unlocked") && s.armability.blocking.includes("autopilot_funded"), s.armability.blocking.join(","));
  ok("the sentence to type is for the autopilot wallet and says nothing will ask", s.armability.expectedAck.includes(AUTO) && /signed without asking me/.test(s.armability.expectedAck));
  const toPage = phantom.posted.filter((m) => m.type === BRIDGE.STATUS).at(-1)?.status;
  ok("the console tab still sees PHANTOM's wallet as its wallet, and the lane's apart", toPage?.wallet === PHANTOM && toPage?.laneWallet === AUTO && toPage?.signerMode === "autopilot", JSON.stringify({ wallet: toPage?.wallet, laneWallet: toPage?.laneWallet }));
}

section("6. FUND FROM PHANTOM: ONE APPROVAL, BUILT BY THE WORKER");
{
  const sentBefore = chain.state.sent.length;
  res = await sendMessage(ch, { type: AUTOPILOT.FUND, asset: "SOL" });
  ok("the default amount is the daily budget (0.01 SOL), and it landed", res?.ok === true && chain.state.lamports.get(AUTO) === 10_000_000n, res?.error ?? res?.summary);
  ok("exactly one Phantom approval was asked, for purpose fund", phantom.signs.length === 1 && phantom.signs[0].purpose === "fund" && phantom.signs[0].wallet === PHANTOM, phantom.signs.map((m) => m.purpose).join(","));
  const fundTx = chain.state.sent[sentBefore];
  const transfer = fundTx.instructions.find((ix) => ix.program === SYSTEM_PROGRAM);
  ok("what Phantom signed is one system transfer, Phantom → the autopilot wallet, for exactly that amount", fundTx.keys[0] === PHANTOM && transfer.accounts[0] === PHANTOM && transfer.accounts[1] === AUTO && transfer.data.readBigUInt64LE(4) === 10_000_000n && fundTx.instructions.filter((ix) => ix.program !== COMPUTE_BUDGET).length === 1);
  ok("it was simulated before Phantom was asked, and sent with preflight on", chain.state.sims >= 1 && fundTx.preflight === true);
  res = await sendMessage(ch, { type: AUTOPILOT.FUND, asset: "SOL", amount: "0.05" });
  ok("a typed amount funds that amount: 0.05 SOL more", res?.ok === true && chain.state.lamports.get(AUTO) === 60_000_000n && phantom.signs.length === 2);
  for (const [label, payload, re] of [
    ["zero", { asset: "SOL", amount: "0" }, /more than zero/],
    ["more precision than SOL has", { asset: "SOL", amount: "0.0000000001" }, /more precision/],
    ["a stock that is not listed", { asset: GLDX, amount: "0.01" }, /listed in Options/],
    ["more than Phantom holds", { asset: "SOL", amount: "999" }, /would fail, so Phantom was not asked/],
  ]) {
    const signs = phantom.signs.length;
    const r = await sendMessage(ch, { type: AUTOPILOT.FUND, ...payload });
    ok(`refused, and Phantom not asked: ${label}`, r?.ok === false && re.test(r.error) && phantom.signs.length === signs, r?.error);
  }
  phantom.mode = "reject";
  const before = chain.state.lamports.get(AUTO);
  const declined = await sendMessage(ch, { type: AUTOPILOT.FUND, asset: "SOL", amount: "0.01" });
  ok("declined in Phantom: nothing moved, and the refusal says so", declined?.ok === false && /declined/.test(declined.error) && chain.state.lamports.get(AUTO) === before, declined?.error);
  phantom.mode = "approve";

  /* A listed stock, by TransferChecked, the autopilot wallet's Token-2022 account created by Phantom. */
  const phantomGldx = chain.giveTokens(PHANTOM, GLDX, 300_000_000n);                   // 3 GLDx
  await sendMessage(ch, { type: UI.SET_CONFIG, config: { quoteMints: [{ mint: GLDX, symbol: "GLDx", maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.5 }] } });
  res = await sendMessage(ch, { type: AUTOPILOT.FUND, asset: GLDX, amount: "0.02" });
  const autoGldx = associatedTokenAddress(AUTO, GLDX, TOKEN_2022_PROGRAM);
  ok("funding GLDx moves exactly 0.02 GLDx into the autopilot wallet's Token-2022 account", res?.ok === true && chain.state.tokens.get(autoGldx)?.amount === 2_000_000n && chain.state.tokens.get(phantomGldx).amount === 298_000_000n, res?.error ?? res?.summary);
  const tokTx = chain.state.sent.at(-1);
  ok("…by TransferChecked with the mint's 8 decimals, the account created and paid for by Phantom", tokTx.keys[0] === PHANTOM && tokTx.instructions.some((ix) => ix.program === TOKEN_2022_PROGRAM && ix.data[0] === 12 && ix.data[9] === 8) && tokTx.instructions.some((ix) => ix.program === ATA_PROGRAM && ix.accounts[0] === PHANTOM));
  ok("the sweep destination is remembered as the Phantom wallet that funded it", (await sendMessage(ch, { type: AUTOPILOT.STATUS })).autopilot.sweepTo === PHANTOM);
}

section("7. UNLOCK, WITH A TTL");
let secretB64;
{
  const outOfRange = await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: PASS, minutes: 2 });
  ok("an unlock under 5 minutes is refused", outOfRange?.ok === false && /5 to 1440/.test(outOfRange.error));
  const wrong = await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: "not the passphrase at all" });
  ok("a wrong passphrase is refused as such", wrong?.ok === false && wrong.code === "wrong_passphrase" && ch.session.size === 0);
  const t0 = Date.now();
  res = await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: PASS, minutes: 30 });
  ok("unlocked for 30 minutes", res?.ok === true && Math.abs(res.expiresAt - (t0 + 30 * 60_000)) < 5_000, new Date(res?.expiresAt ?? 0).toISOString());
  const entry = ch.session.get("coinmarketcat:session-secret");
  secretB64 = entry?.secretKey;
  ok("the key sits in session storage only, until the expiry", entry?.publicKey === AUTO && entry.expiresAt === res.expiresAt && !JSON.stringify([...ch.local]).includes(secretB64));
  ok("an alarm is set for the expiry, so the lane says so when it locks", ch.alarms.get("coinmarketcat-autopilot-expiry")?.when === res.expiresAt + 1_000);
  const s = (await sendMessage(ch, { type: UI.GET_STATUS })).status;
  ok("the checklist turns green for the wallet: unlocked, and funded for a 0.005 SOL ticket", ["autopilot_wallet_created", "autopilot_unlocked", "autopilot_funded"].every((n) => s.armability.items.find((i) => i.name === n)?.ok), s.armability.items.filter((i) => /autopilot/.test(i.name)).map((i) => `${i.name}:${i.ok}`).join(" "));
  ok("the default unlock is the Options value, 480 minutes", (await sendMessage(ch, { type: AUTOPILOT.STATUS })).autopilot.unlockMinutes === 480);
}

section("8. EXPORT, FOR RECOVERY");
let exported;
{
  const wrong = await sendMessage(ch, { type: AUTOPILOT.EXPORT_SECRET, passphrase: "not the passphrase at all" });
  ok("without the passphrase there is no export", wrong?.ok === false && wrong.code === "wrong_passphrase" && !("secretBase58" in wrong));
  const none = await sendMessage(ch, { type: AUTOPILOT.EXPORT_SECRET });
  ok("with no passphrase at all, none either", none?.ok === false && !("secretBase58" in none));
  res = await sendMessage(ch, { type: AUTOPILOT.EXPORT_SECRET, passphrase: PASS });
  exported = res?.secretBase58;
  const bytes = exported ? bs58.decode(exported) : new Uint8Array();
  ok("the export is the wallet's own 64-byte key, in the base58 Phantom imports", res?.ok === true && bytes.length === 64 && Keypair.fromSecretKey(bytes).publicKey.toBase58() === AUTO);
}

section("9. SWEEP BACK TO PHANTOM");
{
  const leftover = Keypair.generate().publicKey.toBase58();
  const emptyAta = chain.giveTokens(AUTO, leftover, 0n);                      // a launch token bought and sold: empty, holding rent
  const wrongTo = await sendMessage(ch, { type: AUTOPILOT.SWEEP, expectTo: Keypair.generate().publicKey.toBase58() });
  ok("a sweep to anything but the confirmed Phantom wallet is refused", wrongTo?.ok === false && /not to/.test(wrongTo.error), wrongTo?.error);
  const signsBefore = phantom.signs.length, sentBefore = chain.state.sent.length;
  const phantomBefore = chain.state.lamports.get(PHANTOM);
  const autoBefore = chain.state.lamports.get(AUTO);
  res = await sendMessage(ch, { type: AUTOPILOT.SWEEP, expectTo: PHANTOM });
  ok("the sweep ran", res?.ok === true && res.to === PHANTOM, res?.error ?? JSON.stringify({ sol: res?.sol, tokens: res?.tokens?.length, closed: res?.closed, skipped: res?.skipped }));
  ok("GLDx went back by TransferChecked, its emptied account closed", res.tokens.length === 1 && res.tokens[0].mint === GLDX && res.tokens[0].closed === true && chain.state.tokens.get(associatedTokenAddress(PHANTOM, GLDX, TOKEN_2022_PROGRAM)).amount === 300_000_000n && !chain.state.tokens.has(associatedTokenAddress(AUTO, GLDX, TOKEN_2022_PROGRAM)));
  ok("the empty launch-token account was closed for its rent", res.closed === 1 && !chain.state.tokens.has(emptyAta));
  ok("the SOL is down to exactly the rent floor — the fee computed, not guessed", chain.state.lamports.get(AUTO) === RENT_FLOOR, `${chain.state.lamports.get(AUTO)} lamports left`);
  const sweptTxs = chain.state.sent.slice(sentBefore);
  const fees = sweptTxs.reduce((a, t) => a + t.fee, 0n);
  ok("Phantom got back everything above the floor, the closed accounts' rent included, less the sweep's own fees", chain.state.lamports.get(PHANTOM) - phantomBefore === autoBefore + RENT_XSTOCK_ATA + RENT_CLASSIC_ATA - RENT_FLOOR - fees, `+${chain.state.lamports.get(PHANTOM) - phantomBefore} lamports over ${sweptTxs.length} transactions`);
  ok("every sweep transaction was signed by the autopilot key (the chain verified each), and Phantom was asked nothing", sweptTxs.length === 3 && sweptTxs.every((t) => t.keys[0] === AUTO) && phantom.signs.length === signsBefore);
  const again = await sendMessage(ch, { type: AUTOPILOT.SWEEP, expectTo: PHANTOM });
  ok("a second sweep finds nothing above the floor and says so", again?.ok === true && again.sol === null && /rent floor/.test(again.solNote) && again.tokens.length === 0, again?.solNote);
}

section("10. LOCK, AND AN UNLOCK THAT RUNS OUT");
{
  res = await sendMessage(ch, { type: AUTOPILOT.LOCK });
  ok("lock clears the unlocked key from session storage", res?.ok === true && !ch.session.has("coinmarketcat:session-secret"));
  ok("…clears the expiry alarm, and the lane reports it locked", !ch.alarms.has("coinmarketcat-autopilot-expiry") && (await sendMessage(ch, { type: UI.GET_STATUS })).status.autopilot.unlocked === false);
  const locked = await sendMessage(ch, { type: AUTOPILOT.SWEEP, expectTo: PHANTOM });
  ok("locked, it signs nothing: a sweep is refused", locked?.ok === false && /unlock the autopilot wallet first/.test(locked.error));
  await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: PASS, minutes: 5 });
  const entry = ch.session.get("coinmarketcat:session-secret");
  ch.session.set("coinmarketcat:session-secret", { ...entry, expiresAt: Date.now() - 1 });   // the five minutes have passed
  const notesBefore = ch.notes.length;
  for (const f of ch.listeners.alarm) f({ name: "coinmarketcat-autopilot-expiry" });
  await tick(300);
  ok("when the unlock runs out the expired key is removed, and the lane says so", !ch.session.has("coinmarketcat:session-secret") && ch.notes.slice(notesBefore).some((n) => /locked itself/.test(n.title)) && captured.some((l) => /unlock ran out/.test(l)));
}

section("11. NOTHING LOGGED OR STORED CARRIES THE PASSPHRASE OR THE KEY");
{
  const secret58 = secretB64 ? bs58.encode(Buffer.from(secretB64, "base64")) : "missing";
  const logged = captured.join("\n");
  ok("the worker logged plenty — and none of it is the passphrase or the key", captured.some((l) => /autopilot wallet created/.test(l)) && !logged.includes(PASS) && !logged.includes(secretB64) && !logged.includes(secret58) && !logged.includes(exported), `${captured.length} lines`);
  const stored = JSON.stringify([...ch.local].map(([k, v]) => [k, v]), (k, v) => (typeof v === "bigint" ? v.toString() : v));
  ok("storage.local holds the sealed blob and the book, never the passphrase or the plaintext key", !stored.includes(PASS) && !stored.includes(secretB64) && !stored.includes(secret58));
  ok("the notifications carry neither", !JSON.stringify(ch.notes).includes(PASS) && !JSON.stringify(ch.notes).includes(secret58));
  ok("no status the popup or the console tab received carries either", !JSON.stringify(phantom.posted).includes(secret58) && !JSON.stringify(phantom.posted).includes(PASS));
}

section("11b. REPLACE: ONLY A SWEPT WALLET, ONLY WITH ITS PASSPHRASE");
let held = { publicKey: AUTO, secretB64 };
{
  const NEWPASS = "a brand new passphrase for the cat";
  chain.state.lamports.set(AUTO, RENT_FLOOR + 50_000_000n);             // money arrived after the sweep
  const funded = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: NEWPASS, confirm: NEWPASS, replace: true, currentPassphrase: PASS });
  ok("a wallet that holds SOL above the floor is not replaced", funded?.ok === false && /sweep it back to Phantom before replacing it/.test(funded.error) && ch.local.get("coinmarketcat:session-wallet").publicKey === AUTO, funded?.error);
  chain.state.lamports.set(AUTO, RENT_FLOOR);
  const wrong = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: NEWPASS, confirm: NEWPASS, replace: true, currentPassphrase: "not the passphrase at all" });
  ok("the wrong current passphrase does not replace it", wrong?.ok === false && wrong.code === "wrong_passphrase" && ch.local.get("coinmarketcat:session-wallet").publicKey === AUTO);
  await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: PASS, minutes: 30 });
  const replaced = await sendMessage(ch, { type: AUTOPILOT.CREATE, passphrase: NEWPASS, confirm: NEWPASS, replace: true, currentPassphrase: PASS });
  ok("swept, with its passphrase, it is replaced by a new wallet", replaced?.ok === true && replaced.replaced === AUTO && replaced.publicKey !== AUTO && ch.local.get("coinmarketcat:session-wallet").publicKey === replaced.publicKey, `${AUTO} → ${replaced?.publicKey}`);
  ok("the old wallet's unlocked key went with it; the new one starts locked", !ch.session.has("coinmarketcat:session-secret") && (await sendMessage(ch, { type: UI.GET_STATUS })).status.autopilot.unlocked === false);
  ok("the old passphrase no longer unlocks anything", (await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: PASS }))?.code === "wrong_passphrase");
  await sendMessage(ch, { type: AUTOPILOT.UNLOCK, passphrase: NEWPASS, minutes: 30 });
  held = { publicKey: replaced.publicKey, secretB64: ch.session.get("coinmarketcat:session-secret")?.secretKey };
  ok("the new passphrase unlocks the new wallet", held.secretB64 && ch.session.get("coinmarketcat:session-secret").publicKey === replaced.publicKey);
  chain.state.lamports.set(replaced.publicKey, 20_000_000n);
}

section("12. NO SWEEP WHILE THE AUTOPILOT WALLET HOLDS A POSITION");
{
  /* A second worker over storage that already holds the wallet (unlocked) and a live
     position it bought: the sweep must refuse, or the position would have no SOL to sell. */
  const local = new Map([...ch.local].map(([k, v]) => [k, structuredClone(v)]));
  const MINTX = Keypair.generate().publicKey.toBase58();
  local.set("hawk:state", { version: ENGINE_VERSION, snipes: { [MINTX]: { mint: MINTX, live: true, wallet: held.publicKey, openedAt: Date.now(), entry: 1, qtyRaw: "1000", entryInputLamports: "5000000", sizeSol: 0.005, feeSolPerLeg: 0.0005, symbol: "HELD" } }, closes: [], spend: [], attempts: {}, refusals: [], shadow: {}, log: [], counters: {} });
  const session = new Map([["coinmarketcat:session-secret", { secretKey: held.secretB64, publicKey: held.publicKey, expiresAt: Date.now() + 600_000 }]]);
  const ch2 = createChrome({ local, session });
  globalThis.chrome = ch2.chrome;
  await import("./src/background.mjs?second-worker");
  connectPhantom(ch2);
  await tick(20);
  const st = (await sendMessage(ch2, { type: UI.GET_STATUS })).status;
  ok("the second worker reads the unlocked wallet and the live position it holds", st.autopilot?.unlocked === true && st.autopilotHeld === 1, `held ${st.autopilotHeld}`);
  const refused = await sendMessage(ch2, { type: AUTOPILOT.SWEEP, expectTo: PHANTOM });
  ok("the sweep is refused while it holds one, and says why", refused?.ok === false && /holds 1 live position/.test(refused.error) && /no SOL to sell with/.test(refused.error), refused?.error);
  const replace = await sendMessage(ch2, { type: AUTOPILOT.CREATE, passphrase: "yet another long passphrase", confirm: "yet another long passphrase", replace: true, currentPassphrase: "a brand new passphrase for the cat" });
  ok("…and it is not replaced while it holds one either", replace?.ok === false && /holds a live position/.test(replace.error), replace?.error);
}

realLog(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
