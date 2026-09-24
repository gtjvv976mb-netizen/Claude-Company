/**
 * THE BROWSER LANE, END TO END, AGAINST A SCRIPTED CHAIN AND A SCRIPTED PHANTOM.
 *
 * Nothing here touches a network. The chain double decodes the bytes the lane asks it to
 * simulate and send — the same buy_v2 / sell_v2 the venue encodes — and executes them
 * against a constant-product curve, so a fill the lane books is a fill the curve's own
 * arithmetic produced. The wallet double signs with a throwaway keypair, or declines, or
 * sits, as each scenario says. Every assertion prints what it measured.
 *
 * What is proved:
 *   1. a real pump.fun create log becomes a notice, clears the contract at first read,
 *      and opens a WOULD-HAVE position with a shadow row in the executor's schema;
 *   2. an armed lane waits `entryWaitMs`, re-reads, and asks Phantom only if the launch
 *      still marks at or above the follow-through; a launch nobody followed is never bought;
 *   3. the fill is read from the chain's balances, booked live, charged to the day;
 *   4. the determiner's take at 1.5x becomes a sell request; a declined sell is asked
 *      again after `sellReaskMs`; an approved sell closes the row with the realized SOL;
 *   5. a declined buy leaves the would-have row watching and never re-asks;
 *   6. a signed transaction whose message differs from the one requested is refused;
 *   7. the lane never holds a key: the bridge is the only signer, and observe mode
 *      never calls it;
 *   8. the daily cap and one-window-at-a-time hold; the shadow export is JSONL the grader
 *      can read, and the scorecard runs over it.
 */
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createHawkEngine, memoryStore, freshState } from "./src/lib/engine.mjs";
import { CONFIG_DEFAULTS, snipeArmSentence, browserArmability, normalizeConfig, RECORD } from "./src/lib/config.mjs";
import { SIGN_ERRORS, BridgeError } from "./src/lib/protocol.mjs";
import { fromBase64, toBase64, associatedTokenAddress } from "./src/lib/tx.mjs";
import {
  PUMPFUN_VENUE, PUMPFUN_PROGRAM_ID, PUMPFUN_IX, decodeBuyIx, decodeCreateEvent, bondingCurveAddress, globalAddress,
  BONDING_CURVE_DISCRIMINATOR, GLOBAL_DISCRIMINATOR, quoteExactOut, sellExactIn, decodeBondingCurve,
} from "./vendor/executor/snipe-venue-pumpfun.mjs";
import { TOKEN_PROGRAM } from "./vendor/executor/token2022.mjs";
import { readShadowRows } from "./vendor/executor/shadow-sink.mjs";
import { snipeScorecard, outcomeKnown } from "./vendor/executor/snipe-shadow.mjs";
import { SNIPE_DEFAULTS } from "./vendor/executor/snipe-policy.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);

/* ── fixtures ──────────────────────────────────────────────────────────────────────── */

/** The real `Program data:` payload of a pump.fun CreateEvent (tx 3X3mQJn8…, slot
 *  446,023,102), the same bytes Claude-Company's executor/test-snipe-venue-pumpfun.mjs pins. */
const CREATE_EVENT_B64 =
  "G3KpTd7rY3YUAAAAT2ZmaWNpYWwgQm9uemkgQnVkZHkFAAAAQk9OWklQAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvYmFma3JlaWRmdXJuM2Nuamd2Z2RuaWlieTNwcGJxYnp3d2gzd3NhbXBxY3Q0bDV5ZnR0ZHB4c2Rjcm0NZ5R4DNvGl0tdsj/oi5NhqzmUroaJv1bVWiRWfUFub6w6hiMVms8iL7nS7iRC5+rcowQNHOvPJZKmxhphQWFNdSHpBIjrPE5vfQmu9Yn2YsBxf4PapMpSIufJGz/xsdZ1IekEiOs8Tm99Ca71ifZiwHF/g9qkylIi58kbP/Gx1m5Oo2oAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAA";
const CREATE = decodeCreateEvent(Buffer.from(CREATE_EVENT_B64, "base64"));
const MINT = CREATE.mint;
const CREATOR = CREATE.creator;
const CREATE_LOGS = [
  `Program ${PUMPFUN_PROGRAM_ID} invoke [1]`,
  "Program log: Instruction: Create",
  `Program data: ${CREATE_EVENT_B64}`,
  `Program ${PUMPFUN_PROGRAM_ID} success`,
];

const WALLET_KP = Keypair.generate();
const WALLET = WALLET_KP.publicKey.toBase58();
const FEE_RECIPIENT = Keypair.generate().publicKey.toBase58();
const BUYBACK = Keypair.generate().publicKey.toBase58();
const MAYHEM_RECIPIENT = Keypair.generate().publicKey.toBase58();
const LAMPORTS = 1_000_000_000n;
const TX_FEE = 5_000n;
const ATA_RENT = 2_039_280n;

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const key = (k) => new PublicKey(k).toBuffer();

/** A bonding-curve account in the WITH_QUOTE_MINT layout (115 bytes), SOL-quoted. */
function curveAccount({ vBase, vQuote, realBase, realQuote, complete = false, creator = CREATOR }) {
  const buf = Buffer.alloc(115);
  Buffer.from(BONDING_CURVE_DISCRIMINATOR, "hex").copy(buf, 0);
  u64(vBase).copy(buf, 8); u64(vQuote).copy(buf, 16); u64(realBase).copy(buf, 24); u64(realQuote).copy(buf, 32);
  u64(CREATE.tokenTotalSupplyRaw).copy(buf, 40);
  buf[48] = complete ? 1 : 0;
  key(creator).copy(buf, 49);
  buf[81] = 0; buf[82] = 0;                       // standard coin, not cashback
  Buffer.alloc(32).copy(buf, 83);                 // zeroed quote mint = SOL
  return { data: [buf.toString("base64"), "base64"], owner: PUMPFUN_PROGRAM_ID, lamports: 1_500_000 };
}
/** A Global account with the eight+eight+eight recipient sets where decodeGlobalFeeRecipients reads them. */
function globalAccount() {
  const buf = Buffer.alloc(1_000);
  Buffer.from(GLOBAL_DISCRIMINATOR, "hex").copy(buf, 0);
  buf[8] = 1;
  key(Keypair.generate().publicKey).copy(buf, 9);
  key(FEE_RECIPIENT).copy(buf, 41);
  u64(CREATE.vBaseRaw).copy(buf, 73); u64(CREATE.vQuoteRaw).copy(buf, 81); u64(CREATE.realBaseRaw).copy(buf, 89);
  u64(CREATE.tokenTotalSupplyRaw).copy(buf, 97); u64(100).copy(buf, 105);
  for (let i = 0; i < 7; i++) key(FEE_RECIPIENT).copy(buf, 162 + i * 32);
  key(MAYHEM_RECIPIENT).copy(buf, 483);
  for (let i = 0; i < 7; i++) key(MAYHEM_RECIPIENT).copy(buf, 516 + i * 32);
  for (let i = 0; i < 8; i++) key(BUYBACK).copy(buf, 741 + i * 32);
  return { data: [buf.toString("base64"), "base64"], owner: PUMPFUN_PROGRAM_ID, lamports: 10_000_000 };
}
/** A classic SPL mint: no mint authority, no freeze authority, 6 decimals, initialized. */
function mintAccount() {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(0, 0);                        // mint authority: None
  u64(CREATE.tokenTotalSupplyRaw).copy(buf, 36);
  buf[44] = 6; buf[45] = 1;
  buf.writeUInt32LE(0, 46);                       // freeze authority: None
  return { data: [buf.toString("base64"), "base64"], owner: TOKEN_PROGRAM, lamports: 1_461_600 };
}
function tokenAccount({ mint, owner, amount }) {
  const buf = Buffer.alloc(165);
  key(mint).copy(buf, 0); key(owner).copy(buf, 32); u64(amount).copy(buf, 64);
  buf.writeUInt32LE(1, 108);                      // state: initialized
  return { data: [buf.toString("base64"), "base64"], owner: TOKEN_PROGRAM, lamports: Number(ATA_RENT) };
}

/* ── the chain double ───────────────────────────────────────────────────────────────── */

/**
 * Holds one curve, one wallet and its token account, and executes the instructions the
 * lane asks it to simulate and send exactly as the venue's own quoting says they would
 * land. `bump(x)` moves the curve as if buyers arrived; `dump(x)` as if they left.
 */
function createChain({ curve: initial, walletLamports = 2n * LAMPORTS, now }) {
  const state = {
    curve: { ...initial }, walletLamports, walletTokens: 0n, ataExists: false, slot: 446_023_200, blockHeight: 300_000_000,
    sent: new Map(), calls: [], confirmAfterPolls: 1,
  };
  const ata = associatedTokenAddress(WALLET, MINT, TOKEN_PROGRAM);
  const decoded = () => decodeBondingCurve(curveAccount(state.curve), { feeBps: 100, mint: MINT });
  const accountFor = (address) => {
    const a = String(address);
    if (a === bondingCurveAddress(MINT).toBase58()) return curveAccount(state.curve);
    if (a === globalAddress().toBase58()) return globalAccount();
    if (a === MINT) return mintAccount();
    if (a === WALLET) return { data: ["", "base64"], owner: "11111111111111111111111111111111", lamports: Number(state.walletLamports) };
    if (a === ata) return state.ataExists ? tokenAccount({ mint: MINT, owner: WALLET, amount: state.walletTokens }) : null;
    return null;
  };
  /** Execute a v0 transaction's pump.fun instruction against the curve; returns the effects. */
  function execute(bytes) {
    const tx = VersionedTransaction.deserialize(bytes);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === PUMPFUN_PROGRAM_ID);
    if (!ix) throw new Error("no pump.fun instruction in the transaction");
    const args = decodeBuyIx(Buffer.from(ix.data));
    const before = { lamports: state.walletLamports, tokens: state.walletTokens, ataExists: state.ataExists };
    let rent = 0n;
    if (args.instruction === "buy_v2") {
      const q = quoteExactOut(decoded(), args.baseOutRaw);
      if (q.quoteInRaw > args.maxQuoteInRaw) throw new Error(`TooMuchSolRequired: ${q.quoteInRaw} > ${args.maxQuoteInRaw}`);
      if (!state.ataExists) { rent = ATA_RENT; state.ataExists = true; }
      state.walletLamports -= q.quoteInRaw + TX_FEE + rent;
      state.walletTokens += args.baseOutRaw;
      state.curve.vQuote += q.curveQuoteInRaw; state.curve.vBase -= args.baseOutRaw;
      state.curve.realQuote += q.curveQuoteInRaw; state.curve.realBase -= args.baseOutRaw;
    } else {
      const q = sellExactIn(decoded(), args.baseInRaw);
      if (q.quoteOutRaw < args.minQuoteOutRaw) throw new Error(`TooLittleSolReceived: ${q.quoteOutRaw} < ${args.minQuoteOutRaw}`);
      state.walletLamports += q.quoteOutRaw - TX_FEE;
      state.walletTokens -= args.baseInRaw;
      state.curve.vQuote -= q.grossQuoteOutRaw; state.curve.vBase += args.baseInRaw;
      state.curve.realQuote -= q.grossQuoteOutRaw; state.curve.realBase += args.baseInRaw;
    }
    return { before, after: { lamports: state.walletLamports, tokens: state.walletTokens }, rent, side: args.instruction === "buy_v2" ? "buy" : "sell" };
  }
  const rpc = {
    url: "https://chain.double",
    async getMultipleAccounts(addresses) { state.calls.push("gma"); return { slot: state.slot, accounts: addresses.map(accountFor) }; },
    async getBalance() { return state.walletLamports; },
    async getTokenAccountBalance(address) { return String(address) === ata && state.ataExists ? state.walletTokens : 0n; },
    async getLatestBlockhash() { return { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: state.blockHeight + 150 }; },
    async getBlockHeight() { return state.blockHeight; },
    async simulateTransaction(txBase64) {
      state.calls.push("sim");
      const snapshot = JSON.stringify(state.curve, (k, v) => (typeof v === "bigint" ? v.toString() : v));
      const saved = { lamports: state.walletLamports, tokens: state.walletTokens, ataExists: state.ataExists };
      try {
        execute(fromBase64(txBase64));
        const post = [
          { lamports: Number(state.walletLamports), owner: "11111111111111111111111111111111", data: ["", "base64"] },
          { lamports: Number(ATA_RENT), owner: TOKEN_PROGRAM, data: tokenAccount({ mint: MINT, owner: WALLET, amount: state.walletTokens }).data },
        ];
        return { err: null, logs: [], unitsConsumed: 120_000, accounts: post };
      } catch (error) {
        return { err: { InstructionError: [2, { Custom: 6002 }] }, logs: [`Program log: ${error.message}`], accounts: null };
      } finally {
        state.curve = JSON.parse(snapshot, (k, v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v));
        state.walletLamports = saved.lamports; state.walletTokens = saved.tokens; state.ataExists = saved.ataExists;
      }
    },
    async sendTransaction(txBase64) {
      state.calls.push("send");
      const bytes = fromBase64(txBase64);
      const tx = VersionedTransaction.deserialize(bytes);
      const sig = bs58.encode(tx.signatures[0]);
      if (!state.sent.has(sig)) {
        let effects, err = null;
        try { effects = execute(bytes); } catch (error) { err = { InstructionError: [2, { Custom: 6002 }] }; effects = null; }
        state.sent.set(sig, { polls: 0, effects, err, slot: ++state.slot, fee: Number(TX_FEE) });
      }
      return sig;
    },
    async getSignatureStatus(sig) {
      const s = state.sent.get(sig);
      if (!s) return null;
      s.polls++;
      if (s.polls < state.confirmAfterPolls) return null;
      return { err: s.err, confirmationStatus: "confirmed" };
    },
    async getTransaction(sig) {
      const s = state.sent.get(sig);
      if (!s) return null;
      if (s.err) return { slot: s.slot, meta: { err: s.err, fee: s.fee, preBalances: [0], postBalances: [0] } };
      const e = s.effects;
      const amount = (n) => ({ mint: MINT, owner: WALLET, uiTokenAmount: { amount: n.toString(), decimals: 6 } });
      return {
        slot: s.slot,
        meta: {
          err: null, fee: s.fee,
          preBalances: [Number(e.before.lamports), e.before.ataExists ? Number(ATA_RENT) : 0],
          postBalances: [Number(e.after.lamports), Number(ATA_RENT)],
          preTokenBalances: e.before.tokens > 0n ? [amount(e.before.tokens)] : [],
          postTokenBalances: e.after.tokens > 0n ? [amount(e.after.tokens)] : [],
        },
      };
    },
  };
  return {
    rpc, state, ata,
    /** Buyers arrive: `solIn` lamports of SOL into the curve. */
    bump(solIn) { const q = PUMPFUN_VENUE.quoteExactIn(decoded(), BigInt(solIn)); state.curve.vQuote += q.curveQuoteInRaw; state.curve.vBase -= q.baseOutRaw; state.curve.realQuote += q.curveQuoteInRaw; state.curve.realBase -= q.baseOutRaw; },
    /** Sellers leave: `baseOut` base units sold into the curve. */
    dump(baseOut) { const q = sellExactIn(decoded(), BigInt(baseOut)); state.curve.vQuote -= q.grossQuoteOutRaw; state.curve.vBase += BigInt(baseOut); state.curve.realQuote -= q.grossQuoteOutRaw; state.curve.realBase += BigInt(baseOut); },
    markOf(qtyRaw, entryInputLamports) { return Number(sellExactIn(decoded(), BigInt(qtyRaw)).quoteOutRaw) / Number(BigInt(entryInputLamports)); },
  };
}

/* ── the wallet double ──────────────────────────────────────────────────────────────── */
function createBridge({ wallet = WALLET, ready = true } = {}) {
  const b = {
    requests: [],
    mode: "approve",               // approve | reject | sit | tamper
    isReady: () => ready,
    wallet: () => wallet,
    async signTransaction({ txBase64, purpose, mint, summary, timeoutMs }) {
      b.requests.push({ purpose, mint, summary, timeoutMs });
      if (b.mode === "reject") throw new BridgeError(SIGN_ERRORS.REJECTED, "User rejected the request");
      if (b.mode === "sit") throw new BridgeError(SIGN_ERRORS.TIMEOUT, `no answer inside ${timeoutMs}ms`);
      const tx = VersionedTransaction.deserialize(fromBase64(txBase64));
      if (b.mode === "tamper") {
        const other = VersionedTransaction.deserialize(fromBase64(txBase64));
        other.message.recentBlockhash = bs58.encode(Buffer.alloc(32, 9));
        other.sign([WALLET_KP]);
        return { signedBase64: toBase64(other.serialize()) };
      }
      tx.sign([WALLET_KP]);
      return { signedBase64: toBase64(tx.serialize()) };
    },
  };
  return b;
}

/* ── a manual clock and timers, so nothing waits on the wall ───────────────────────── */
function createClock(start = 1_758_700_000_000) {
  let now = start;
  const timeouts = [];
  return {
    now: () => now,
    advance(ms) { now += ms; },
    timers: {
      setTimeout(fn, ms) { const id = { fn, at: now + ms }; timeouts.push(id); return id; },
      clearTimeout(id) { const i = timeouts.indexOf(id); if (i >= 0) timeouts.splice(i, 1); },
      setInterval() { return null; }, clearInterval() {},
    },
    /** Fire every pending timeout whose time has come (used by the engine's sleep()). */
    async flush() { for (;;) { const due = timeouts.filter((t) => t.at <= now); if (!due.length) return; for (const t of due) { timeouts.splice(timeouts.indexOf(t), 1); t.fn(); } await new Promise((r) => setImmediate(r)); } },
  };
}
/** Run an engine call while draining its sleeps as the clock advances. */
async function drive(clock, promise, { stepMs = 800, maxSteps = 400 } = {}) {
  let done = false; let result; let error;
  promise.then((r) => { done = true; result = r; }, (e) => { done = true; error = e; });
  for (let i = 0; i < maxSteps && !done; i++) {
    await new Promise((r) => setImmediate(r));
    await clock.flush();
    if (done) break;
    clock.advance(stepMs);
  }
  await new Promise((r) => setImmediate(r));
  if (error) throw error;
  if (!done) throw new Error("drive: the call never settled");
  return result;
}

const socialsOk = async () => Object.freeze({ ok: true, socials: { any: true, present: ["twitter"] }, message: "the launch names twitter" });
const CURVE_AT_CREATE = { vBase: CREATE.vBaseRaw, vQuote: CREATE.vQuoteRaw, realBase: CREATE.realBaseRaw, realQuote: 0n };

function makeEngine({ chain, bridge, clock, config = {}, store = memoryStore(), socials = socialsOk, notes = [] } = {}) {
  const lines = [];
  const engine = createHawkEngine({
    rpc: chain.rpc, bridge, store, clock: clock.now, timers: clock.timers,
    log: (l) => lines.push(l), notify: (n) => notes.push(n), socialsReader: socials,
    config: { rpcUrl: "https://chain.double", ...config },
  });
  return { engine, lines, notes };
}
const armedConfig = (over = {}) => ({
  lane: "execute", maxSolPerTrade: 0.05, dailySolCap: 0.5, stopFrac: 0.5, entryWaitMs: 10_000, entryFollowThroughX: 1.0,
  liveAck: snipeArmSentence(WALLET, 0.05, 0.5), forwardIntervalMs: 5_000, forwardSamples: 12, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════════════ */

section("1. A REAL CREATE LOG BECOMES A WOULD-HAVE POSITION AND A SHADOW ROW");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);                                   // 1.5 SOL already in: a real launch minute
  const bridge = createBridge({ wallet: null, ready: false });
  /* 24 forward samples at 5s is a two-minute window, long enough for the 90s stall to
     be the thing that closes a flat launch rather than the window itself. */
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: { lane: "observe", forwardSamples: 24 } });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig1", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  const st = engine.status();
  ok("the notice was counted", st.counters.notices === 1, `notices ${st.counters.notices}`);
  ok("the launch cleared every gate at first read", st.counters.cleared === 1 && st.counters.refused === 0, `cleared ${st.counters.cleared} refused ${st.counters.refused}`);
  const pos = st.open[0];
  ok("a would-have position is open, not live", pos && pos.mint === MINT && pos.live === false, pos ? `${pos.mint} live=${pos.live} size ${pos.sizeSol} SOL` : "no position");
  ok("its raw amounts are digit strings the book can journal", /^\d+$/.test(pos.qtyRaw) && /^\d+$/.test(pos.entryInputLamports), `qty ${pos.qtyRaw} input ${pos.entryInputLamports}`);
  ok("the would-have fill is at most the ticket", BigInt(pos.entryInputLamports) <= BigInt(Math.round(CONFIG_DEFAULTS.maxSolPerTrade * 1e9)), `${pos.entryInputLamports} <= ${CONFIG_DEFAULTS.maxSolPerTrade} SOL`);
  ok("nothing was asked of the wallet in observe mode", bridge.requests.length === 0, `${bridge.requests.length} sign requests`);
  const row = engine.state.shadow[MINT];
  ok("a shadow row exists in the executor's schema", row && row.shadowVersion === "snipe-shadow-v1" && row.gate.ok === true && row.wouldHaveSigned === true, row ? `${row.shadowVersion} gate.ok=${row.gate.ok} launchShare=${row.gate.launchSharePct}` : "no row");
  ok("the row measured launch_share for the grader", Number.isFinite(row.gate.launchSharePct) && row.gate.launchSharePct > 0, `launch_share ${row.gate.launchSharePct}%`);
  ok("the row says nothing was signed or sent", row.signed === false && row.sent === false, `signed ${row.signed} sent ${row.sent}`);
  ok("the same log again is not a second notice", (engine.onLogs({ logs: CREATE_LOGS, signature: "sig1", slot: 446_023_102, err: null, receivedAt: clock.now() }), true) && engine.status().counters.notices === 1, `notices ${engine.status().counters.notices}`);

  // Sample forward through the window; the launch goes nowhere, so the stall sells it at 90s.
  for (let i = 0; i < 24; i++) { clock.advance(5_000); await engine.tick(); }
  const after = engine.status();
  ok("the would-have position closed", after.open.length === 0, `open ${after.open.length}`);
  const close = after.closes[0];
  ok("it closed on the stall exit, as the record prescribes for a flat launch", close && /stall/.test(close.reason), close?.reason);
  ok("the close is flagged paper, never live", close.live === false, `live ${close.live}`);
  const rowAfter = engine.state.shadow[MINT];
  ok("the shadow row carries forward samples and an outcome", rowAfter.forward.length >= 18 && rowAfter.outcome && rowAfter.outcome.action === "would_have_exited", `${rowAfter.forward.length} samples, outcome ${rowAfter.outcome?.action}`);
  ok("the outcome is judgeable: nobody followed", outcomeKnown(rowAfter) && rowAfter.outcome.followed === false, `followed ${rowAfter.outcome.followed}`);
  ok("the log said what it would have done", lines.some((l) => /would have entered/.test(l)) && lines.some((l) => /would have SOLD/.test(l)), lines.slice(0, 3).join(" | "));
}

section("2. AN ARMED LANE WAITS, RE-READS, AND ONLY BUYS A LAUNCH SOMEBODY FOLLOWED");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);
  const bridge = createBridge();
  const notes = [];
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: armedConfig(), notes });
  await engine.load();
  ok("the lane reports executing with the sentence typed for the connected wallet", engine.status().executing === true, `executing ${engine.status().executing}; blocking ${engine.status().armability.blocking.join(",")}`);
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig2", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  ok("first notice opens a would-have row, and asks nothing yet", engine.status().open[0]?.live === false && bridge.requests.length === 0, `open live=${engine.status().open[0]?.live} requests ${bridge.requests.length}`);
  clock.advance(5_000); await engine.tick();
  ok("at 5s nothing is asked — the wait is 10s", bridge.requests.length === 0, `requests ${bridge.requests.length}`);
  // Buyers arrive during the wait: the would-have fill now marks above 1.0x.
  chain.bump(2_000_000_000n);
  const pos = engine.status().open[0];
  const markNow = chain.markOf(pos.qtyRaw, pos.entryInputLamports);
  ok("the curve marks the would-have fill above the follow-through", markNow >= 1.0, `mark ${markNow.toFixed(4)}x`);
  clock.advance(5_000);
  const result = await drive(clock, engine.tick());
  ok("at 10s the lane asked Phantom for exactly one buy", bridge.requests.length === 1 && bridge.requests[0].purpose === "buy", `${bridge.requests.length} requests: ${bridge.requests.map((r) => r.purpose).join(",")}`);
  ok("the buy summary names the ceiling in SOL", /BUY .* up to 0\.0\d+ SOL/.test(bridge.requests[0].summary), bridge.requests[0].summary);
  ok("the user was notified to look at Phantom", notes.some((n) => n.kind === "buy"), notes.map((n) => n.kind).join(","));
  const st = engine.status();
  const live = st.open.find((p) => p.live === true);
  ok("the fill is booked live, one position for the mint", live && st.open.length === 1, live ? `live qty ${live.qtyRaw} input ${live.entryInputLamports} fee ${live.entryFeeLamports}` : "no live position");
  ok("the fill's quantity is what the wallet holds on the chain double", BigInt(live.qtyRaw) === chain.state.walletTokens, `${live.qtyRaw} vs wallet ${chain.state.walletTokens}`);
  ok("the swap input is the chain's own number, fee and rent excluded", BigInt(live.entryInputLamports) + BigInt(live.entryFeeLamports) + ATA_RENT === 2n * LAMPORTS - chain.state.walletLamports, `input ${live.entryInputLamports} + fee ${live.entryFeeLamports} + rent ${ATA_RENT} = spent ${2n * LAMPORTS - chain.state.walletLamports}`);
  ok("the day was charged the input plus the fee", Math.abs(st.deployedTodaySol - Number(BigInt(live.entryInputLamports) + BigInt(live.entryFeeLamports)) / 1e9) < 1e-12, `deployed ${st.deployedTodaySol} SOL`);
  ok("the position records how late it was", Number.isFinite(live.msSinceNotice) && live.msSinceNotice >= 10_000, `${live.msSinceNotice}ms after the notice`);
  ok("the paper row that watched was superseded, not counted as a paper trade", !st.closes.some((c) => c.mint === MINT && c.live === false), `closes ${st.closes.length}`);
  ok("the transaction the wallet signed was simulated first", chain.state.calls.indexOf("sim") < chain.state.calls.indexOf("send"), chain.state.calls.join(" "));
  ok("the log says ENTERED with the signature", lines.some((l) => /ENTERED/.test(l) && /sig /.test(l)), lines.find((l) => /ENTERED/.test(l)));

  section("3. THE TAKE AT 1.5x BECOMES A SELL; DECLINED IS ASKED AGAIN; APPROVED CLOSES THE ROW");
  const before = chain.state.walletLamports;
  chain.bump(10_000_000_000n);                                   // the coin runs
  const mark = chain.markOf(live.qtyRaw, live.entryInputLamports);
  ok("the coin now marks above the 1.5x take", mark >= 1.5, `mark ${mark.toFixed(4)}x, take ${engine.status().policy.takeAtEntryX}x`);
  bridge.mode = "reject";
  clock.advance(1_000);
  await drive(clock, engine.tick());
  ok("the determiner ordered a sell and Phantom was asked", bridge.requests.length === 2 && bridge.requests[1].purpose === "sell" && /take/.test(bridge.requests[1].summary), bridge.requests[1]?.summary);
  ok("the declined sell left the position open and pending", engine.status().open[0]?.pendingSell?.attempts === 1, `pendingSell ${JSON.stringify(engine.status().open[0]?.pendingSell)}`);
  ok("the user was told the sell needs approval", notes.some((n) => n.kind === "sell"), notes.map((n) => n.kind).join(","));
  clock.advance(2_000);
  await drive(clock, engine.tick());
  ok("inside sellReaskMs it is not asked again", bridge.requests.length === 2, `requests ${bridge.requests.length}`);
  bridge.mode = "approve";
  clock.advance(engine.config.sellReaskMs);
  await drive(clock, engine.tick());
  ok("after sellReaskMs it asked again, and the approval sold", bridge.requests.length === 3 && engine.status().open.length === 0, `requests ${bridge.requests.length} open ${engine.status().open.length}`);
  const closed = engine.status().closes[0];
  ok("the close is live, on the take, with realized SOL from the chain", closed.live === true && /take/.test(closed.reason) && closed.realizedLamports !== null, `${closed.reason}; realized ${closed.realizedLamports}`);
  ok("the realized P&L is positive and matches the wallet's SOL delta", BigInt(closed.pnlLamports) > 0n && BigInt(closed.realizedLamports) === chain.state.walletLamports - before, `pnl ${closed.pnlSol} SOL; realized ${closed.realizedLamports} vs delta ${chain.state.walletLamports - before}`);
  ok("the book counts one live win", engine.status().book.liveTrades === 1 && engine.status().book.liveWins === 1, JSON.stringify(engine.status().book));
  ok("the wallet holds none of the mint afterwards", chain.state.walletTokens === 0n, `tokens ${chain.state.walletTokens}`);
  const row = engine.state.shadow[MINT];
  ok("the shadow row closed as exited, with forward samples from the live ticks", row.outcome?.action === "exited" && row.forward.length >= 2, `${row.outcome?.action}, ${row.forward.length} samples`);
}

section("4. A LAUNCH NOBODY FOLLOWED IS NEVER BOUGHT");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);
  const bridge = createBridge();
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: armedConfig() });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig4", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  const pos = engine.status().open[0];
  chain.dump(BigInt(pos.qtyRaw) * 3n);                            // the bundle sells into it
  clock.advance(10_000);
  await drive(clock, engine.tick());
  ok("nothing was asked of Phantom", bridge.requests.length === 0, `requests ${bridge.requests.length}`);
  ok("the row is marked waited-out", engine.status().open[0]?.waitedOut && engine.status().counters.waitedOut === 1, engine.status().open[0]?.waitedOut);
  ok("the log says nobody followed", lines.some((l) => /nobody followed/.test(l)), lines.find((l) => /nobody followed/.test(l)));
  for (let i = 0; i < 24; i++) { clock.advance(5_000); await engine.tick(); }
  ok("it never asks later either", bridge.requests.length === 0 && engine.status().open.length === 0, `requests ${bridge.requests.length}, open ${engine.status().open.length}`);
}

section("5. A DECLINED BUY, A WINDOW THAT SAT, AND A TAMPERED SIGNATURE");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);
  const bridge = createBridge();
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: armedConfig() });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig5", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  chain.bump(2_000_000_000n);
  bridge.mode = "reject";
  clock.advance(10_000);
  await drive(clock, engine.tick());
  ok("the declined buy asked once", bridge.requests.length === 1, `requests ${bridge.requests.length}`);
  ok("the would-have row keeps watching, and no live position exists", engine.status().open.length === 1 && engine.status().open[0].live === false && engine.status().open[0].liveAttempted === true, `open ${engine.status().open.length} live=${engine.status().open[0]?.live} attempted=${engine.status().open[0]?.liveAttempted}`);
  ok("nothing was sent to the chain", !chain.state.calls.includes("send"), chain.state.calls.join(" "));
  ok("the day was not charged", engine.status().deployedTodaySol === 0, `deployed ${engine.status().deployedTodaySol}`);
  clock.advance(5_000);
  await drive(clock, engine.tick());
  ok("a declined buy is never re-asked", bridge.requests.length === 1, `requests ${bridge.requests.length}`);
  ok("the rejection was counted", engine.status().counters.signRejected === 1, `signRejected ${engine.status().counters.signRejected}`);

  const clock2 = createClock();
  const chain2 = createChain({ curve: CURVE_AT_CREATE, now: clock2.now });
  chain2.bump(1_500_000_000n);
  const bridge2 = createBridge();
  bridge2.mode = "sit";
  const e2 = makeEngine({ chain: chain2, bridge: bridge2, clock: clock2, config: armedConfig() });
  await e2.engine.load();
  e2.engine.onLogs({ logs: CREATE_LOGS, signature: "sig5b", slot: 446_023_102, err: null, receivedAt: clock2.now() });
  await new Promise((r) => setTimeout(r, 30));
  chain2.bump(2_000_000_000n);
  clock2.advance(10_000);
  await drive(clock2, e2.engine.tick());
  ok("a window that sat past approvalTimeoutMs is abandoned and counted", e2.engine.status().counters.signTimeouts === 1 && e2.engine.status().open[0]?.live === false, `signTimeouts ${e2.engine.status().counters.signTimeouts}`);
  ok("the log says it was abandoned", e2.lines.some((l) => /abandoned/.test(l)), e2.lines.find((l) => /abandoned/.test(l)));

  const clock3 = createClock();
  const chain3 = createChain({ curve: CURVE_AT_CREATE, now: clock3.now });
  chain3.bump(1_500_000_000n);
  const bridge3 = createBridge();
  bridge3.mode = "tamper";
  const e3 = makeEngine({ chain: chain3, bridge: bridge3, clock: clock3, config: armedConfig() });
  await e3.engine.load();
  e3.engine.onLogs({ logs: CREATE_LOGS, signature: "sig5c", slot: 446_023_102, err: null, receivedAt: clock3.now() });
  await new Promise((r) => setTimeout(r, 30));
  chain3.bump(2_000_000_000n);
  clock3.advance(10_000);
  await drive(clock3, e3.engine.tick());
  ok("a signed transaction whose message differs is refused before any send", bridge3.requests.length === 1 && !chain3.state.calls.includes("send"), chain3.state.calls.join(" "));
  ok("the refusal names the tampering", e3.lines.some((l) => /not the one it was asked to sign/.test(l)), e3.lines.find((l) => /ENTRY FAILED/.test(l)));
}

section("6. THE CAPS: THE DAY, ONE WINDOW AT A TIME, HARD STOP");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);
  const bridge = createBridge();
  const { engine } = makeEngine({ chain, bridge, clock, config: armedConfig({ maxSolPerTrade: 0.05, dailySolCap: 0.05, liveAck: snipeArmSentence(WALLET, 0.05, 0.05) }) });
  await engine.load();
  engine.state.spend.push({ at: clock.now() - 1_000, sol: 0.01, kind: "entry" });   // 0.01 already deployed today
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig6", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  const st = engine.status();
  ok("a ticket the day cannot fund is refused at daily_capacity, before any read of the wallet", st.refusals[0]?.gate === "daily_capacity" && bridge.requests.length === 0, st.refusals[0]?.message);
  engine.state.spend.length = 0;
  engine.state.attempts = {};
  engine.setControl({ hardStop: true });
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig6b", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  ok("the hard stop refuses at the gate named for it", engine.status().refusals[0]?.gate === "hard_stop", engine.status().refusals[0]?.message);
}

section("7. CONFIG, THE ARM SENTENCE, AND THE RECORD BESIDE THE SWITCH");
{
  ok("the browser default take is the record's 1.5x, not the policy's 2x", CONFIG_DEFAULTS.takeAtEntryX === 1.5 && SNIPE_DEFAULTS.takeAtEntryX === 2, `browser ${CONFIG_DEFAULTS.takeAtEntryX}x, policy ${SNIPE_DEFAULTS.takeAtEntryX}x`);
  ok("the browser default waits ten seconds and requires follow-through", CONFIG_DEFAULTS.entryWaitMs === 10_000 && CONFIG_DEFAULTS.entryFollowThroughX === 1.0, `${CONFIG_DEFAULTS.entryWaitMs}ms, ${CONFIG_DEFAULTS.entryFollowThroughX}x`);
  ok("the lane is off by default", CONFIG_DEFAULTS.lane === "off", CONFIG_DEFAULTS.lane);
  ok("the arm sentence is the executor's own", snipeArmSentence(WALLET, 0.05, 0.5) === `I arm HAWK-AI v1 for ${WALLET}: 0.05 SOL per launch, 0.5 SOL per day, sold in full at the take, the stop, the creator's exit or the clock`);
  const cfg = normalizeConfig({ ...CONFIG_DEFAULTS, rpcUrl: "https://x.y", lane: "execute", maxSolPerTrade: 0.2, dailySolCap: 1, liveAck: snipeArmSentence(WALLET, 0.2, 1) });
  const arm = browserArmability({ config: cfg, wallet: WALLET, hasBridge: true });
  ok("a 0.2 SOL ticket without a chosen stop cannot arm", !arm.armable && arm.blocking.includes("stop_chosen_above_canary"), arm.blocking.join(","));
  ok("and the record's size warning is beside the switch", arm.warnings.some((w) => w.name === "size_above_the_record"), arm.warnings.map((w) => w.name).join(","));
  const cfg2 = normalizeConfig({ ...cfg, stopFrac: 0.5 });
  const arm2 = browserArmability({ config: cfg2, wallet: WALLET, hasBridge: true });
  ok("with a stop chosen it arms", arm2.armable, arm2.blocking.join(",") || "nothing blocking");
  ok("the wrong wallet's sentence does not arm", !browserArmability({ config: cfg2, wallet: Keypair.generate().publicKey.toBase58(), hasBridge: true }).armable);
  ok("the record's headline is always in the warnings", arm2.warnings.some((w) => w.name === "the_record_loses" && /48 down/.test(w.detail)), arm2.warnings.find((w) => w.name === "the_record_loses")?.detail);
  ok("RECORD carries the README's numbers", RECORD.first58.netSol === -1.5793 && RECORD.tenMinuteClock.ran === 18 && RECORD.tenMinuteClock.won === 0 && RECORD.bySecondsLate[0].wonPct === 0);
  let threw = null;
  try { normalizeConfig({ maxSolPerTrade: 2 }); } catch (error) { threw = error; }
  ok("a ticket over the operator maximum is refused by name", threw?.key === "maxSolPerTrade", threw?.message);
}

section("8. THE SHADOW EXPORT IS WHAT THE GRADER READS");
{
  const clock = createClock();
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now });
  chain.bump(1_500_000_000n);
  const bridge = createBridge({ wallet: null, ready: false });
  const store = memoryStore();
  const { engine } = makeEngine({ chain, bridge, clock, config: { lane: "observe" }, store });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig8", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 20; i++) { clock.advance(5_000); await engine.tick(); }
  const jsonl = engine.exportShadow();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hawk-shadow-")), "book.jsonl");
  fs.writeFileSync(file, jsonl);
  const read = readShadowRows({ file });
  const rows = Array.isArray(read) ? read : read.rows;
  ok("the export is JSONL executor/shadow-sink.mjs reads back", rows.length === 1 && rows[0].mint === MINT, `${rows.length} rows read; keys ${Object.keys(read).join(",")}`);
  const card = snipeScorecard(rows);
  ok("snipeScorecard runs over it and judged the row", card.judged === 1 && card.proxies.launch_share.n === 1, `judged ${card.judged}; launch_share n=${card.proxies.launch_share.n}`);
  ok("the status carries the same scorecard", engine.status().shadow.scorecard.judged === 1, `status judged ${engine.status().shadow.scorecard.judged}`);
  // Persistence: a second engine on the same store sees the row and the closes.
  const again = makeEngine({ chain, bridge, clock, config: { lane: "observe" }, store });
  await again.engine.load();
  ok("a restart reloads the book from the store", again.engine.status().shadow.rows === 1 && again.engine.status().closes.length === 1, `rows ${again.engine.status().shadow.rows}, closes ${again.engine.status().closes.length}`);
  const saved = store.snapshot;
  ok("the persisted state has no BigInt in it", (() => { try { JSON.stringify(saved); return true; } catch { return false; } })());
  ok("freshState has the shape the store expects", Object.keys(freshState()).every((k) => k in saved), Object.keys(freshState()).join(","));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
