/**
 * THE SIGNING PATH, DRIVEN AGAINST A SCRIPTED CHAIN — offline, a real journal, a real
 * keypair that is generated here and thrown away, and a fake pair of RPC connections
 * whose every answer this file wrote.
 *
 * What this file is trying to catch, said before the assertions:
 *
 *   1. BYTES SIGNED THAT THE CONTRACT DID NOT DECODE. buy() must refuse a prepared
 *      instruction whose numbers differ from the plan it is handed, and nothing may be
 *      signed before both providers have simulated the exact bytes.
 *   2. A ONE-NODE STORY. A provider that errs, that disagrees with the other by more than
 *      the tolerance, that shows a spend above the ceiling plus the caps, or a delivery
 *      short of the instruction, must refuse the buy BEFORE a signature exists — the
 *      journal must hold no attempt and no RPC may have been asked to send.
 *   3. THE JOURNAL LYING ABOUT THE CHAIN. Every outcome the chain can hand back —
 *      confirmed, failed, expired, silent — must leave the intent in the state recovery
 *      expects, and the fill returned to the lane must be what the chain's own balances
 *      say, never the plan.
 *   4. THE GATES. Hard stop refuses both sides; pause refuses buys only; the boundary
 *      proof's refusal is a refusal; an unresolved intent on ANY mint freezes new exposure.
 *   5. RECOVERY THAT TOUCHES THE DESK. recoverPending() must resolve the sniper's own
 *      intents and step around the desk's.
 *
 * Every assertion prints what it measured. Time is virtual: the injected clock advances
 * only when the executor sleeps, so the confirm and finality timeouts are exact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import {
  SNIPE_EXECUTE_CLAUSES, SNIPE_EXECUTE_DEFAULTS, SNIPE_EXECUTE_VERSION, SNIPE_TX_PROTOCOL,
  SnipeExecuteError, createAtaIdempotentIx, createSnipeExecutor, fillFromTransaction,
  toTransactionInstruction, tokenAmountOf,
} from "./snipe-execute.mjs";
import { CURRENT_TX_ATTEMPT_PROTOCOL, ExecutionJournal } from "./journal.mjs";
import { PUMPFUN_CURVE_TYPE, PUMPFUN_PROGRAM_ID, PUMPFUN_VENUE, decodeBuyIx, sellExactIn } from "./snipe-venue-pumpfun.mjs";
import { associatedTokenAddress, WSOL } from "./jupiter.mjs";
import { TOKEN_PROGRAM } from "./token2022.mjs";
import { freshState } from "./strategy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);
const rejects = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (cond, turns = 400) => {
  for (let i = 0; i < turns; i++) { if (cond()) return true; await tick(); }
  return cond();
};

/* ── the scripted chain ────────────────────────────────────────────────────────────── */

const SYSTEM = "11111111111111111111111111111111";
const ZERO32 = Buffer.alloc(32);

/** A 165-byte SPL token account: mint, owner, amount, then the rest zero. */
const tokenAccountBytes = ({ mint, owner, amount }) => {
  const b = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(b, 0);
  new PublicKey(owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(BigInt(amount), 64);
  return b;
};

/** A Global account with one fee recipient at 41 and one buyback recipient at 741 —
 *  the IDL's own offsets, which decodeGlobalFeeRecipients reads. */
const FEE_RECIPIENT = Keypair.generate().publicKey.toBase58();
const BUYBACK_RECIPIENT = Keypair.generate().publicKey.toBase58();
const globalBytes = () => {
  const b = Buffer.alloc(1000);
  new PublicKey(FEE_RECIPIENT).toBuffer().copy(b, 41);
  new PublicKey(BUYBACK_RECIPIENT).toBuffer().copy(b, 741);
  return b;
};

const CREATOR = Keypair.generate().publicKey.toBase58();
/* The live pump.fun opening state, the same three numbers test-pumpfun-curve.mjs pins. */
const curveState = (over = {}) => Object.freeze({
  kind: "bonding-curve", venue: "pumpfun", curveType: PUMPFUN_CURVE_TYPE, mint: null,
  vBaseRaw: 1073000000000000n, vQuoteRaw: 30000000000n,
  realBaseRaw: 793100000000000n, realQuoteRaw: 110014725n, tokenTotalSupplyRaw: 1000000000000000n,
  complete: false, creator: CREATOR, feeBps: 125, feeBpsKnown: true,
  baseDecimals: 6, quoteMint: WSOL, quoteDecimals: 9, ...over,
});

/**
 * One chain, two connections over it. `plan` scripts the next transaction's outcome:
 *   spend      lamports into the curve (buy) / proceeds out of it (sell), net of fee
 *   fee        the network fee the chain charges
 *   rent       lamports that fund a new account (the ATA on a first buy)
 *   deliver    base tokens delivered (buy) or removed (sell)
 *   outcome    "confirm" | "fail" | "expire" | "silent"
 *   secondarySpendSkew  extra lamports the secondary's simulation shows leaving
 *   simError   { primary?: string, secondary?: string } — a provider that errs
 */
function makeChain({ wallet, mint }) {
  const chain = {
    height: 250_000_000, slot: 300_000_000,
    walletLamports: 5_000_000_000n, ataAmount: 0n, ataExists: false,
    statuses: new Map(), txs: new Map(), calls: [],
    plan: {},
  };
  const ata = associatedTokenAddress(wallet, mint, TOKEN_PROGRAM);
  const b64 = (buf) => [Buffer.from(buf).toString("base64"), "base64"];
  const accountsAt = (side, id) => {
    const p = chain.plan;
    const skew = id === "secondary" ? BigInt(p.secondarySpendSkew ?? 0) : 0n;
    const fee = BigInt(p.fee ?? 0), rent = chain.ataExists ? 0n : BigInt(p.rent ?? 0);
    const walletAfter = side === "buy"
      ? chain.walletLamports - BigInt(p.spend) - fee - rent - skew
      : chain.walletLamports + BigInt(p.spend) - fee - skew;
    const baseAfter = side === "buy" ? chain.ataAmount + BigInt(p.deliver) : chain.ataAmount - BigInt(p.deliver);
    return [
      { lamports: Number(walletAfter), owner: SYSTEM, data: b64(Buffer.alloc(0)), executable: false, rentEpoch: 0 },
      { lamports: 2_039_280, owner: TOKEN_PROGRAM, data: b64(tokenAccountBytes({ mint, owner: wallet, amount: baseAfter })),
        executable: false, rentEpoch: 0 },
    ];
  };
  const sideOf = (tx) => {
    const ixs = tx.message.compiledInstructions;
    const last = ixs[ixs.length - 1];
    return Buffer.from(last.data).subarray(0, 8).toString("hex") === "b817ee6167c5d33d" ? "buy" : "sell";
  };
  const land = (signature, side) => {
    const p = chain.plan;
    const fee = BigInt(p.fee ?? 0), rent = chain.ataExists ? 0n : BigInt(p.rent ?? 0);
    const pre = chain.walletLamports, preAta = chain.ataExists ? 2_039_280n : 0n, preBase = chain.ataAmount;
    if (p.outcome === "fail") {
      chain.walletLamports -= fee;
      chain.statuses.set(signature, { slot: chain.slot, confirmations: 3, err: { InstructionError: [2, { Custom: 6002 }] }, confirmationStatus: "confirmed" });
      chain.txs.set(signature, { slot: chain.slot, meta: { err: { InstructionError: [2, { Custom: 6002 }] }, fee: Number(fee),
        preBalances: [Number(pre), Number(preAta)], postBalances: [Number(pre - fee), Number(preAta)],
        preTokenBalances: [], postTokenBalances: [] } });
      return;
    }
    if (p.outcome === "expire") { chain.height += 500; return; }
    if (p.outcome === "silent") return;
    const post = side === "buy" ? pre - BigInt(p.spend) - fee - rent : pre + BigInt(p.spend) - fee;
    const baseAfter = side === "buy" ? preBase + BigInt(p.deliver) : preBase - BigInt(p.deliver);
    const bal = (amount) => ({ accountIndex: 1, mint, owner: wallet, uiTokenAmount: { amount: String(amount), decimals: 6 } });
    chain.txs.set(signature, { slot: chain.slot, meta: { err: null, fee: Number(fee),
      preBalances: [Number(pre), Number(preAta)], postBalances: [Number(post), Number(preAta + rent)],
      preTokenBalances: chain.ataExists ? [bal(preBase)] : [], postTokenBalances: [bal(baseAfter)] } });
    chain.statuses.set(signature, { slot: chain.slot, confirmations: 4, err: null, confirmationStatus: "confirmed" });
    chain.walletLamports = post; chain.ataAmount = baseAfter; chain.ataExists = true;
  };
  chain.finalizeAll = () => { for (const s of chain.statuses.values()) { s.confirmationStatus = "finalized"; s.confirmations = null; } };
  chain.callsTo = (id, method) => chain.calls.filter((c) => c.id === id && c.method === method).length;
  chain.connection = (id) => ({
    async simulateTransaction(tx, opts) {
      chain.calls.push({ id, method: "simulateTransaction" });
      const p = chain.plan;
      if (p.simError?.[id]) return { value: { err: { InstructionError: [2, "Custom"] }, logs: [`Program log: ${p.simError[id]}`], accounts: null } };
      const side = sideOf(tx);
      return { context: { slot: chain.slot }, value: { err: null, logs: [], unitsConsumed: 121_000,
        accounts: opts?.accounts ? accountsAt(side, id) : null } };
    },
    async sendRawTransaction(bytes) {
      chain.calls.push({ id, method: "sendRawTransaction", at: Date.now() });
      const tx = VersionedTransaction.deserialize(bytes);
      const signature = bs58.encode(tx.signatures[0]);
      if (!chain.txs.has(signature) && !chain.statuses.has(signature) && !chain.landed?.has(signature)) {
        (chain.landed ??= new Set()).add(signature);
        land(signature, sideOf(tx));
      }
      return signature;
    },
    async getMultipleAccountsInfo() {
      chain.calls.push({ id, method: "getMultipleAccountsInfo" });
      return [
        { lamports: Number(chain.walletLamports), owner: new PublicKey(SYSTEM), data: Buffer.alloc(0) },
        chain.ataExists ? { lamports: 2_039_280, owner: new PublicKey(TOKEN_PROGRAM),
          data: tokenAccountBytes({ mint, owner: wallet, amount: chain.ataAmount }) } : null,
      ];
    },
    async getMultipleAccountsInfoAndContext() {
      chain.calls.push({ id, method: "getMultipleAccountsInfoAndContext" });
      return { context: { slot: chain.slot }, value: [
        { lamports: 1, owner: new PublicKey(PUMPFUN_PROGRAM_ID), data: Buffer.alloc(81) },
        { lamports: 1, owner: new PublicKey(PUMPFUN_PROGRAM_ID), data: globalBytes() },
        { lamports: 1, owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(82) },
      ] };
    },
    async getLatestBlockhash() {
      chain.calls.push({ id, method: "getLatestBlockhash" });
      /* A fresh blockhash per request, as a cluster gives: two attempts with the same
         bytes and the same blockhash would share a signature, which the journal's unique
         constraint rightly refuses. */
      chain.nonce = (chain.nonce ?? 0) + 1;
      return { blockhash: bs58.encode(Buffer.from(String(chain.height * 1000 + chain.nonce).padStart(32, "7"))), lastValidBlockHeight: chain.height + 150 };
    },
    async getSignatureStatuses(sigs) {
      chain.calls.push({ id, method: "getSignatureStatuses" });
      return { value: sigs.map((s) => chain.statuses.get(s) ?? null) };
    },
    async getBlockHeight() { return chain.height; },
    async getTransaction(signature) {
      chain.calls.push({ id, method: "getTransaction" });
      return chain.txs.get(signature) ?? null;
    },
  });
  chain.ata = ata;
  return chain;
}

/** The lane's two-endpoint read, as prepareBuy sees it: [curve, global, mint]. */
const laneRead = (slot = 300_000_000) => ({ slot, accounts: [
  { owner: PUMPFUN_PROGRAM_ID, data: Buffer.alloc(81) },
  { owner: PUMPFUN_PROGRAM_ID, data: globalBytes() },
  { owner: TOKEN_PROGRAM, data: Buffer.alloc(82) },
] });

/* ── the harness ───────────────────────────────────────────────────────────────────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-snipe-execute-"));
const keypair = Keypair.generate();
const WALLET = keypair.publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

function harness({ control, boundary, cfg, chain: given } = {}) {
  const chain = given ?? makeChain({ wallet: WALLET, mint: MINT });
  const journal = new ExecutionJournal(path.join(dir, `journal-${Math.random().toString(36).slice(2)}.sqlite`), { wallet: WALLET });
  const runtime = { cursor: 0, primed: true, state: freshState(1_700_000_000_000), positions: {}, snipes: {} };
  let now = 1_700_000_000_000;
  const logs = [];
  const state = { control: control ?? { hardStop: false, pauseEntries: false }, persisted: 0 };
  const executor = createSnipeExecutor({
    keypair, connections: [chain.connection("primary"), chain.connection("secondary")], journal, venue: PUMPFUN_VENUE,
    cfg: { statusPollMs: 250, confirmTimeoutMs: 5_000, finalityTimeoutMs: 20_000, ...cfg },
    control: () => state.control,
    boundary: boundary ?? (() => {}),
    runtime: () => runtime, persist: () => { state.persisted++; },
    clock: () => now,
    sleep: async (ms) => { now += ms; await tick(); },
    log: (m) => logs.push(m),
  });
  return { chain, journal, runtime, executor, logs, state, clock: () => now };
}

const BASE_OUT = 17_000_000_000_000n;      // 17M tokens at 6 decimals
const CEILING = 500_000_000n;              // 0.5 SOL
const PLAN_BUY = { spend: 480_000_000n, fee: 1_305_000n, rent: 2_039_280n, deliver: BASE_OUT, outcome: "confirm" };

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("1. THE PORT IS ITS OWN OBJECT, AND REFUSES TO BE BUILT HALF-MADE");
{
  const chain = makeChain({ wallet: WALLET, mint: MINT });
  const journal = new ExecutionJournal(path.join(dir, "port.sqlite"), { wallet: WALLET });
  const two = [chain.connection("primary"), chain.connection("secondary")];
  const built = (over) => { try { createSnipeExecutor({ keypair, connections: two, journal, venue: PUMPFUN_VENUE, ...over }); return null; } catch (e) { return e; } };
  ok("no keypair is port_invalid", built({ keypair: null })?.clause === "port_invalid", built({ keypair: null })?.message);
  ok("one connection is port_invalid — both must simulate and both must send",
    built({ connections: [two[0]] })?.clause === "port_invalid", built({ connections: [two[0]] })?.message);
  ok("no journal is port_invalid", built({ journal: null })?.clause === "port_invalid");
  ok("a venue without encoders is port_invalid", built({ venue: { id: "x" } })?.clause === "port_invalid");
  const x = createSnipeExecutor({ keypair, connections: two, journal, venue: PUMPFUN_VENUE });
  ok("the port names the wallet it signs for", x.wallet === WALLET, x.wallet);
  ok("the port names its version and its protocol marker",
    x.version === SNIPE_EXECUTE_VERSION && x.protocol === SNIPE_TX_PROTOCOL, `${x.version} / ${x.protocol}`);
  ok("the sniper's protocol marker is not the desk's",
    SNIPE_TX_PROTOCOL !== CURRENT_TX_ATTEMPT_PROTOCOL, `${SNIPE_TX_PROTOCOL} vs ${CURRENT_TX_ATTEMPT_PROTOCOL}`);
  ok("the port exposes exactly the four verbs the lane and the poller use",
    ["prepareBuy", "buy", "sell", "recoverPending"].every((k) => typeof x[k] === "function"));
  ok("every clause SnipeExecuteError can carry is listed, and an unlisted one throws",
    (() => { try { new SnipeExecuteError("nope", "x"); return false; } catch { return true; } })() &&
      SNIPE_EXECUTE_CLAUSES.includes("simulation_failed"), `${SNIPE_EXECUTE_CLAUSES.length} clauses`);
  ok("the defaults poll fast: a quarter-second status poll and a bounded confirm wait",
    SNIPE_EXECUTE_DEFAULTS.statusPollMs <= 250 && SNIPE_EXECUTE_DEFAULTS.confirmTimeoutMs <= 30_000,
    `${SNIPE_EXECUTE_DEFAULTS.statusPollMs}ms poll, ${SNIPE_EXECUTE_DEFAULTS.confirmTimeoutMs}ms confirm`);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("2. THE FILL IS READ FROM THE CHAIN'S OWN BALANCES, WORKED BY HAND FIRST");
{
  /* pre 5,000,000,000; post 4,516,655,720 → 483,344,280 left the wallet. fee 1,305,000,
     the ATA went 0 → 2,039,280 (rent), so the swap input is 483,344,280 − 1,305,000 −
     2,039,280 = 480,000,000. Tokens 0 → 17,000,000,000,000. */
  const tx = { slot: 5, meta: { err: null, fee: 1_305_000,
    preBalances: [5_000_000_000, 0, 1], postBalances: [4_516_655_720, 2_039_280, 1],
    preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "17000000000000" } }] } };
  const fill = fillFromTransaction(tx, { wallet: WALLET, mint: MINT, side: "buy" });
  ok("a buy's spend is everything that left the wallet, fee included", fill.spentLamports === "483344280", fill.spentLamports);
  ok("the swap input is spend less fee less rent", fill.quoteInRaw === "480000000", fill.quoteInRaw);
  ok("the rent is the lamports that funded the new account", fill.rentLamports === "2039280", fill.rentLamports);
  ok("the quantity is the tokens the wallet gained", fill.qtyRaw === "17000000000000", fill.qtyRaw);
  /* A sell: pre 4,516,655,720 → post 4,900,000,000 with fee 5,000: gross proceeds are
     383,344,280 + 5,000 = 383,349,280 before the fee. Tokens 17e12 → 0. */
  const sold = fillFromTransaction({ slot: 6, meta: { err: null, fee: 5_000,
    preBalances: [4_516_655_720, 2_039_280], postBalances: [4_900_000_000, 2_039_280],
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "17000000000000" } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "0" } }] } },
  { wallet: WALLET, mint: MINT, side: "sell" });
  ok("a sell's proceeds are the SOL gained plus the fee the chain took from it", sold.quoteOutRaw === "383349280", sold.quoteOutRaw);
  ok("a sell's quantity is the tokens that left", sold.qtyRaw === "17000000000000", sold.qtyRaw);
  const failed = (() => { try { fillFromTransaction({ ...tx, meta: { ...tx.meta, err: { InstructionError: [1, "Custom"] } } }, { wallet: WALLET, mint: MINT, side: "buy" }); return null; } catch (e) { return e; } })();
  ok("a landed-and-failed transaction is failed_on_chain, not a fill", failed?.clause === "failed_on_chain", failed?.message);
  const foreign = fillFromTransaction({ ...tx, meta: { ...tx.meta, postTokenBalances: [{ ...tx.meta.postTokenBalances[0], owner: CREATOR },
    tx.meta.postTokenBalances[0]] } }, { wallet: WALLET, mint: MINT, side: "buy" });
  ok("tokens delivered to another owner do not count as ours", foreign.qtyRaw === "17000000000000", foreign.qtyRaw);
  const amount = tokenAmountOf({ owner: TOKEN_PROGRAM, data: tokenAccountBytes({ mint: MINT, owner: WALLET, amount: 42n }) }, { mint: MINT, owner: WALLET });
  ok("tokenAmountOf reads the u64 at 64 of a token account", amount === 42n, String(amount));
  ok("tokenAmountOf is zero for a foreign mint or a non-token owner",
    tokenAmountOf({ owner: TOKEN_PROGRAM, data: tokenAccountBytes({ mint: CREATOR, owner: WALLET, amount: 42n }) }, { mint: MINT }) === 0n &&
    tokenAmountOf({ owner: SYSTEM, data: tokenAccountBytes({ mint: MINT, owner: WALLET, amount: 42n }) }) === 0n);
  const ataIx = createAtaIdempotentIx({ payer: WALLET, ata: associatedTokenAddress(WALLET, MINT), owner: WALLET, mint: MINT, tokenProgram: TOKEN_PROGRAM });
  ok("the idempotent ATA create is one byte of data and six accounts, payer signing",
    ataIx.data.length === 1 && ataIx.data[0] === 1 && ataIx.keys.length === 6 && ataIx.keys[0].isSigner === true);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("3. PREPARE BUILDS THE EXACT BYTES GATE 20 DECODES");
{
  const h = harness();
  const prepared = h.executor.prepareBuy({ mint: MINT, curve: curveState({ mint: MINT }), read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  const decoded = decodeBuyIx(prepared.instruction);
  ok("prepareBuy emits buy_v2 with the plan's quantity and ceiling",
    decoded.instruction === "buy_v2" && decoded.amountRaw === BASE_OUT && decoded.maxQuoteInRaw === CEILING,
    `${decoded.instruction} ${decoded.amountRaw} base ≤ ${decoded.maxQuoteInRaw} lamports`);
  ok("the fee recipients are the ones the Global account names",
    prepared.feeRecipient === FEE_RECIPIENT && prepared.buybackFeeRecipient === BUYBACK_RECIPIENT);
  ok("the tokens are routed to the signer's own ATA", prepared.associatedBaseUser === h.chain.ata, prepared.associatedBaseUser);
  ok("the mint's owner picks the token program", prepared.baseTokenProgram === TOKEN_PROGRAM);
  ok("the instruction converts to web3 with the signer flagged",
    toTransactionInstruction(prepared.instruction).keys.some((k) => k.pubkey.toBase58() === WALLET && k.isSigner));
  const noGlobal = (() => { try { h.executor.prepareBuy({ mint: MINT, curve: curveState(), read: { slot: 1, accounts: [laneRead().accounts[0], null, laneRead().accounts[2]] }, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }); return null; } catch (e) { return e; } })();
  ok("a read without the Global account is prepare_failed", noGlobal?.clause === "prepare_failed", noGlobal?.message);
  const notToken = (() => { try { h.executor.prepareBuy({ mint: MINT, curve: curveState(), read: { slot: 1, accounts: [laneRead().accounts[0], laneRead().accounts[1], { owner: SYSTEM, data: Buffer.alloc(0) }] }, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }); return null; } catch (e) { return e; } })();
  ok("a mint not owned by a token program is prepare_failed", notToken?.clause === "prepare_failed", notToken?.message);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("4. A BUY, END TO END: SIMULATED ON BOTH, SIGNED ONCE, SENT TO BOTH, FILLED FROM THE CHAIN");
{
  const h = harness();
  h.chain.plan = { ...PLAN_BUY };
  const curve = curveState({ mint: MINT });
  const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  const fill = await h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING, creator: CREATOR });
  ok("the fill's quantity is what the chain delivered", fill.qtyRaw === String(BASE_OUT), fill.qtyRaw);
  ok("the fill's swap input is what went into the curve, not the ceiling", fill.quoteInRaw === "480000000", fill.quoteInRaw);
  ok("the fill's spend is input + fee + rent", fill.spentLamports === String(480_000_000n + 1_305_000n + 2_039_280n), fill.spentLamports);
  ok("the fill carries the signature, the intent id and the attempt",
    typeof fill.signature === "string" && fill.intentId === `snipe-entry:${MINT}` && fill.attempt === 1, `${fill.intentId} #${fill.attempt}`);
  ok("both providers simulated", h.chain.callsTo("primary", "simulateTransaction") === 1 && h.chain.callsTo("secondary", "simulateTransaction") === 1);
  ok("both providers were sent the bytes", h.chain.callsTo("primary", "sendRawTransaction") === 1 && h.chain.callsTo("secondary", "sendRawTransaction") === 1);
  const order = h.chain.calls.map((c) => c.method);
  ok("simulation came before the send", order.lastIndexOf("simulateTransaction") < order.indexOf("sendRawTransaction"),
    order.filter((m) => m === "simulateTransaction" || m === "sendRawTransaction").join(" → "));
  const attempt = h.journal.latestAttempt(fill.intentId);
  ok("the journal holds the signed bytes under the sniper's own protocol",
    attempt?.protocol === SNIPE_TX_PROTOCOL && attempt.signature === fill.signature && attempt.signedTx.length > 0,
    `${attempt?.protocol}, ${attempt?.signedTx.length} bytes`);
  ok("the attempt's order records what both providers simulated",
    attempt.order.simulatedSpendLamports === String(480_000_000n + 1_305_000n + 2_039_280n) && attempt.order.simulatedDelta === String(BASE_OUT),
    JSON.stringify({ spend: attempt.order.simulatedSpendLamports, delta: attempt.order.simulatedDelta }));
  const intent = h.journal.getIntent(fill.intentId);
  ok("the intent is snipe_entry, submitted, and still blocking new exposure until finality",
    intent.kind === "snipe_entry" && intent.state === "submitted" && h.journal.hasBlockingIntent() === fill.intentId, intent.state);
  ok("the intent's context is the plan, for recovery", intent.context.baseOutRaw === String(BASE_OUT) && intent.context.creator === CREATOR &&
    intent.context.associatedBaseUser === h.chain.ata);
  ok("the fill came back at confirmed — the position is under management before finality",
    h.executor.stats().confirmed === 1 && h.executor.stats().finalized === 0, JSON.stringify(h.executor.stats()));
  h.chain.finalizeAll();
  const accounted = await until(() => h.journal.getIntent(fill.intentId).state === "accounted");
  ok("finality moves the journal to confirmed then accounted in the background", accounted, h.journal.getIntent(fill.intentId).state);
  const risk = h.journal.rollingRisk(h.clock());
  ok("the deployment counts in the shared rolling risk: input plus fee",
    Math.abs(risk.deployedTodaySol - (480_000_000 + 1_305_000) / 1e9) < 1e-12, `${risk.deployedTodaySol} SOL`);
  ok("finality bookkeeping logged no failure", !h.logs.some((l) => /bookkeeping failed|FINALIZED AS FAILED/.test(l)), h.logs.join(" | ") || "quiet");
  ok("the poller's save ran after the journal moved", h.state.persisted >= 1, `${h.state.persisted} persists`);
  ok("nothing was refused and one signature was made", h.executor.stats().signed === 1 && h.executor.stats().refused === 0);

  const again = await rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  ok("a second buy of the same mint is in_flight: the accounted intent is not replayed", again?.clause === "in_flight", again?.message);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("5. THE GATES: NOTHING IS BUILT, LET ALONE SIGNED, WHEN ONE SAYS NO");
{
  const curve = curveState({ mint: MINT });
  const attempt = async (h) => {
    h.chain.plan = { ...PLAN_BUY };
    const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
    return rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  };
  const untouched = (h) => h.chain.calls.length === 0 && h.journal.getIntent(`snipe-entry:${MINT}`) === null && h.executor.stats().signed === 0;

  let h = harness({ control: { hardStop: true, pauseEntries: false } });
  let e = await attempt(h);
  ok("a hard stop refuses the buy before any RPC is asked", e?.clause === "refused" && untouched(h), e?.message);
  h = harness({ control: { hardStop: false, pauseEntries: true } });
  e = await attempt(h);
  ok("a pause refuses the buy before any RPC is asked", e?.clause === "refused" && untouched(h), e?.message);
  h = harness({ boundary: () => { throw new Error("the Mac is on battery"); } });
  e = await attempt(h);
  ok("the boundary proof's refusal is the buy's refusal", e?.clause === "refused" && /on battery/.test(e?.message) && untouched(h), e?.message);

  h = harness();
  const desk = { id: "entry:9:entry:1", kind: "entry", eventId: "9:entry:1", feedId: 1, mint: CREATOR, inputMint: WSOL, outputMint: CREATOR, amountRaw: "1000", context: {} };
  h.journal.ensureIntent(desk);
  h.journal.recordSigned(desk.id, { attempt: 1, requestId: "r", signedTx: Buffer.from([1]), signature: "s".repeat(64), blockhash: "b", lastValidBlockHeight: 1, quotedOutputRaw: "1", minOutputRaw: "1", order: {} });
  e = await attempt(h);
  ok("an unresolved DESK intent on another mint freezes the sniper's new exposure", e?.clause === "exposure_frozen" && untouched(h), e?.message);

  h = harness();
  const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  e = await rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING + 1n }));
  ok("a plan that differs from the prepared bytes is malformed — nothing signed the contract did not decode",
    e?.clause === "malformed" && untouched(h), e?.message);
  e = await rejects(() => h.executor.buy({ mint: MINT, curve, prepared: null, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  ok("no prepared instruction is malformed", e?.clause === "malformed");
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("6. SIMULATION: ONE NODE'S WORD IS NOT ACTED ON, AND A DRAIN IS REFUSED UNSIGNED");
{
  const curve = curveState({ mint: MINT });
  const run = async (plan, cfg) => {
    const h = harness({ cfg });
    h.chain.plan = { ...PLAN_BUY, ...plan };
    const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
    const e = await rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
    const unsigned = h.executor.stats().signed === 0 && h.journal.latestAttempt(`snipe-entry:${MINT}`) === null &&
      h.chain.callsTo("primary", "sendRawTransaction") === 0 && h.chain.callsTo("secondary", "sendRawTransaction") === 0;
    return { e, unsigned, h };
  };
  let r = await run({ secondarySpendSkew: 10_000_000n });
  ok("providers 2% apart on the spend refuse the buy, unsigned", r.e?.clause === "simulation_failed" && /disagree/.test(r.e?.message) && r.unsigned, r.e?.message);
  r = await run({ secondarySpendSkew: 2_000_000n });
  ok("providers within 1% agree, and the buy proceeds", r.e === null, r.e?.message ?? "bought");
  r = await run({ spend: 508_000_000n });
  ok("a spend above ceiling + fee cap + rent cap is an unexplained drain, refused unsigned",
    r.e?.clause === "simulation_failed" && /drain/.test(r.e?.message) && r.unsigned, r.e?.message);
  r = await run({ deliver: BASE_OUT - 1n });
  ok("a delivery short of the instruction's quantity is refused unsigned",
    r.e?.clause === "simulation_failed" && /deliver/.test(r.e?.message) && r.unsigned, r.e?.message);
  r = await run({ simError: { primary: "custom program error: 0x1772" } });
  ok("a provider whose simulation errs refuses the buy, by name",
    r.e?.clause === "simulation_failed" && /primary/.test(r.e?.message) && r.unsigned, r.e?.message);
  r = await run({ simError: { secondary: "Blockhash not found" } });
  ok("…and the secondary erring is just as much a refusal", r.e?.clause === "simulation_failed" && /secondary/.test(r.e?.message) && r.unsigned, r.e?.message);
  ok("a refused simulation leaves the intent planned, so the next launch is not frozen by it",
    r.h.journal.getIntent(`snipe-entry:${MINT}`)?.state === "planned" && r.h.journal.hasBlockingIntent() === null,
    r.h.journal.getIntent(`snipe-entry:${MINT}`)?.state);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("7. WHAT THE CHAIN HANDS BACK: FAILED, EXPIRED, SILENT — EACH LEAVES THE JOURNAL TELLING THE TRUTH");
{
  const curve = curveState({ mint: MINT });
  const go = async (h) => {
    const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
    return rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  };
  const id = `snipe-entry:${MINT}`;

  let h = harness();
  h.chain.plan = { ...PLAN_BUY, outcome: "fail" };
  let e = await go(h);
  ok("a landed-and-failed buy is failed_on_chain", e?.clause === "failed_on_chain", e?.message);
  ok("…the journal intent is failed with the fee charged as evidence",
    h.journal.getIntent(id).state === "failed" && h.journal.latestAttempt(id).state === "failed" && h.journal.hasBlockingIntent() === null,
    `${h.journal.getIntent(id).state}; blocking ${h.journal.hasBlockingIntent()}`);
  h.chain.plan = { ...PLAN_BUY };
  const retry = await go(h);
  ok("a failed intent may be retried, as attempt 2", retry === null && h.journal.latestAttempt(id).attempt === 2,
    retry?.message ?? `attempt ${h.journal.latestAttempt(id).attempt}`);
  h.chain.finalizeAll(); await until(() => h.journal.getIntent(id).state === "accounted");

  h = harness();
  h.chain.plan = { ...PLAN_BUY, outcome: "expire" };
  e = await go(h);
  ok("a buy whose blockhash lifetime passes with no status is expired", e?.clause === "expired", e?.message);
  ok("…the journal intent is expired and not blocking",
    h.journal.getIntent(id).state === "expired" && h.journal.hasBlockingIntent() === null, h.journal.getIntent(id).state);

  h = harness({ cfg: { confirmTimeoutMs: 3_000 } });
  h.chain.plan = { ...PLAN_BUY, outcome: "silent" };
  const t0 = h.clock();
  e = await go(h);
  ok("a buy with no status inside the confirm window is ambiguous", e?.clause === "ambiguous", e?.message);
  ok("…it waited the whole window, polling at the configured cadence",
    h.clock() - t0 >= 3_000 && h.chain.callsTo("primary", "getSignatureStatuses") >= 10,
    `${h.clock() - t0}ms, ${h.chain.callsTo("primary", "getSignatureStatuses")} polls`);
  ok("…the journal intent is ambiguous and FREEZES new exposure until recovery",
    h.journal.getIntent(id).state === "ambiguous" && h.journal.hasBlockingIntent() === id, h.journal.getIntent(id).state);
  const otherMint = Keypair.generate().publicKey.toBase58();
  const frozen = await rejects(() => h.executor.buy({ mint: otherMint, curve, prepared: { instruction: {}, baseOutRaw: "1", maxQuoteInRaw: "1" }, baseOutRaw: 1n, maxQuoteInRaw: 1n }));
  ok("…and a buy of a different mint is exposure_frozen", frozen?.clause === "exposure_frozen", frozen?.message);
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("8. A SELL: THE WHOLE POSITION, FLOORED FROM THE CURVE'S OWN QUOTE, ACCOUNTED AS REALIZED");
{
  const curve = curveState({ mint: MINT });
  const h = harness();
  h.chain.plan = { ...PLAN_BUY };
  const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  const bought = await h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  h.chain.finalizeAll(); await until(() => h.journal.getIntent(bought.intentId).state === "accounted");

  const quoted = sellExactIn(curve, BASE_OUT).quoteOutRaw;
  const floor = quoted * 9_000n / 10_000n;
  h.chain.plan = { spend: quoted, fee: 1_305_000n, rent: 0n, deliver: BASE_OUT, outcome: "confirm" };
  const position = { qtyRaw: bought.qtyRaw, costBasisLamports: bought.spentLamports };
  const sold = await h.executor.sell({ mint: MINT, curve, qtyRaw: bought.qtyRaw, position, reason: "take" });
  ok("the sell moved the whole position", sold.qtyRaw === bought.qtyRaw, sold.qtyRaw);
  ok("the proceeds are what the chain returned", sold.quoteOutRaw === String(quoted), `${sold.quoteOutRaw} lamports`);
  const attempt = h.journal.latestAttempt(sold.intentId);
  ok("the exit's floor is the curve's quote less the exit tolerance",
    attempt.minOutputRaw === String(floor) && attempt.order.quotedOutRaw === String(quoted), `${floor} of ${quoted}`);
  const intent = h.journal.getIntent(sold.intentId);
  ok("the exit intent is snipe_exit with the position's basis in its context",
    intent.kind === "snipe_exit" && intent.context.position.costBasisLamports === bought.spentLamports && intent.context.reason === "take");
  ok("a sell reads Global and the mint fresh from the primary", h.chain.callsTo("primary", "getMultipleAccountsInfoAndContext") === 1);
  h.chain.finalizeAll();
  const accounted = await until(() => h.journal.getIntent(sold.intentId).state === "accounted");
  ok("finality accounts the exit as realized", accounted, h.journal.getIntent(sold.intentId).state);
  const risk = h.journal.rollingRisk(h.clock());
  const expectedRealized = Number(quoted - 1_305_000n - BigInt(bought.spentLamports)) / 1e9;
  ok("realized = proceeds − fee − cost basis, in the shared ledger", Math.abs(risk.realizedTodaySol - expectedRealized) < 1e-12, `${risk.realizedTodaySol} SOL`);

  const graduated = await rejects(() => h.executor.sell({ mint: MINT, curve: curveState({ mint: MINT, complete: true }), qtyRaw: "1" }));
  ok("a graduated curve refuses the sell — the pool route is not this path's", graduated?.clause === "refused" && /graduated/.test(graduated?.message), graduated?.message);
  const stopped = harness({ control: { hardStop: true, pauseEntries: false } });
  const s = await rejects(() => stopped.executor.sell({ mint: MINT, curve, qtyRaw: "1" }));
  ok("a hard stop refuses a sell too — no automated submission of any kind", s?.clause === "refused" && stopped.chain.calls.length === 0, s?.message);
  const paused = harness({ control: { hardStop: false, pauseEntries: true } });
  paused.chain.ataExists = true; paused.chain.ataAmount = BASE_OUT;
  paused.chain.plan = { spend: quoted, fee: 1_305_000n, rent: 0n, deliver: BASE_OUT, outcome: "confirm" };
  const p = await rejects(() => paused.executor.sell({ mint: MINT, curve, qtyRaw: BASE_OUT, position }));
  ok("a pause does NOT refuse a sell: paused entries still leave", p === null, p?.message ?? "sold under pause");
  const short = await rejects(() => h.executor.sell({ mint: MINT, curve, qtyRaw: "0" }));
  ok("a zero quantity is malformed", short?.clause === "malformed");
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("9. RECOVERY: THE SNIPER'S OWN PENDING INTENTS ARE RESOLVED; THE DESK'S ARE STEPPED AROUND");
{
  const curve = curveState({ mint: MINT });
  const h = harness({ cfg: { confirmTimeoutMs: 1_000 } });
  h.chain.plan = { ...PLAN_BUY, outcome: "silent" };
  const prepared = h.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  const e = await rejects(() => h.executor.buy({ mint: MINT, curve, prepared, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  const id = `snipe-entry:${MINT}`;
  ok("setup: a buy went ambiguous", e?.clause === "ambiguous" && h.journal.getIntent(id).state === "ambiguous");
  /* The desk's own signed intent sits beside it. */
  const desk = { id: "entry:9:entry:1", kind: "entry", eventId: "9:entry:1", feedId: 1, mint: CREATOR, inputMint: WSOL, outputMint: CREATOR, amountRaw: "1000", context: {} };
  h.journal.ensureIntent(desk);
  h.journal.recordSigned(desk.id, { attempt: 1, requestId: "r", signedTx: Buffer.from([1]), signature: "s".repeat(64), blockhash: "b", lastValidBlockHeight: 1, quotedOutputRaw: "1", minOutputRaw: "1", order: {} });

  /* The chain now says the sniper's transaction landed and finalized. */
  const signature = h.journal.latestAttempt(id).signature;
  h.chain.plan = { ...PLAN_BUY, outcome: "confirm" };
  h.chain.landed.delete(signature);
  await h.chain.connection("primary").sendRawTransaction(h.journal.latestAttempt(id).signedTx);
  h.chain.finalizeAll();
  const recovered = await h.executor.recoverPending();
  const mine = recovered.find((r) => r.id === id);
  ok("recovery finalizes the ambiguous buy from the chain's own record", mine?.outcome === "finalized" && mine.fill.qtyRaw === String(BASE_OUT), JSON.stringify(mine));
  ok("…and the journal is accounted", h.journal.getIntent(id).state === "accounted", h.journal.getIntent(id).state);
  ok("the desk's intent was not touched", !recovered.some((r) => r.id === desk.id) && h.journal.getIntent(desk.id).state === "signed");

  const h2 = harness({ cfg: { confirmTimeoutMs: 1_000 } });
  h2.chain.plan = { ...PLAN_BUY, outcome: "silent" };
  const p2 = h2.executor.prepareBuy({ mint: MINT, curve, read: laneRead(), baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING });
  await rejects(() => h2.executor.buy({ mint: MINT, curve, prepared: p2, baseOutRaw: BASE_OUT, maxQuoteInRaw: CEILING }));
  h2.chain.height += 500;
  const r2 = await h2.executor.recoverPending();
  ok("an ambiguous buy past its blockhash lifetime with no record is expired on recovery",
    r2.find((r) => r.id === id)?.outcome === "expired" && h2.journal.getIntent(id).state === "expired" && h2.journal.hasBlockingIntent() === null,
    JSON.stringify(r2));
}

/* ══════════════════════════════════════════════════════════════════════════════════ */
section("10. THE BOUNDARY: THIS FILE IS THE ONLY SNIPER FILE THAT SIGNS, AND IT DECIDES NOTHING");
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const code = strip(fs.readFileSync(path.join(HERE, "snipe-execute.mjs"), "utf8"));
  const laneCode = strip(fs.readFileSync(path.join(HERE, "snipe-lane.mjs"), "utf8"));
  ok("snipe-execute.mjs does not import the lane — it is a port the lane is handed, never the other way",
    !/from\s+["']\.\/snipe-lane\.mjs["']/.test(code));
  ok("snipe-lane.mjs does not import snipe-execute.mjs — the poller injects it on a live install only",
    !/from\s+["']\.\/snipe-execute\.mjs["']/.test(laneCode) && !/import\(\s*["']\.\/snipe-execute\.mjs["']\s*\)/.test(laneCode));
  ok("this file never reads the policy or the entry contract: it takes a plan, it does not make one",
    !/snipe-policy\.mjs|snipe-entry\.mjs|snipe-shadow\.mjs/.test(code));
  ok("every send skips preflight — the dual simulation above IS the preflight",
    (code.match(/sendRawTransaction\(/g) || []).length === 1 && /skipPreflight:\s*true/.test(code));
  ok("no timer of its own: the poller owns the clock, this file only sleeps what it is handed",
    !/setInterval\(/.test(code) && !/setTimeout\(/.test(code.replace(/const sleepDefault[^\n]*/, "")));
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
