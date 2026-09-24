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
 *
 * And for a launch QUOTED IN A STOCK (pump.fun Custom Pairs), against a second chain
 * double whose curve, stock mint and stock account are the live bytes in
 * vendor/executor/fixtures/pumpfun-xstock-quote.json (the GLDx mint, a GLDx-quoted curve,
 * its 179-byte Token-2022 GLDx account), and which refuses a quote ATA or a quote token
 * program the way the program would:
 *   9.  nothing listed: refused at quote_not_sol, and the read carries no stock mint;
 *   10. GLDx listed: its mint rides on the same read, is described, and a would-have
 *       row is filed in GLDx (8 decimals, feeSolPerLeg 0, the SOL fee beside it);
 *   11. armed: the first buy is the CANARY at minPerTrade; the signed bytes carry two
 *       ATA creates (the stock's under Token-2022) and a buy_v2 whose quote accounts are
 *       Token-2022's; the simulate guard reads the GLDx account; the fill is read in
 *       GLDx's decimals; GLDx is charged to its own day and only fee + rent to SOL;
 *   12. the take sells for GLDx and the close is booked in GLDx, fees beside it;
 *   13. once proven the ticket is full; the day cap is per stock; the SOL day still
 *       binds the SOL a stock buy spends;
 *   14. a wallet short of GLDx, a paused GLDx, and a landed buy that cannot be read
 *       back (which blocks the stock until cleared);
 *   15. one book, two populations: SOL and GLDx rows are graded apart;
 *   16. the stock list is fenced by normalizeConfig, and the arm sentence binds it;
 *   17. the fill reader alone, and the exact unit conversions.
 *
 * And ON AUTOPILOT, with the REAL session wallet — a keystore over Maps, a key generated
 * and sealed under a passphrase, unlocked, and createSessionSigner's own signTransaction:
 *   18. locked, the lane does not arm; unlocked and funded it arms on a sentence that says
 *       nothing will ask; the buy and the sell are signed by the autopilot key (ed25519
 *       verifies both over the bytes that reached the chain) and Phantom is asked nothing;
 *       the key reaches no log, note or store; the balance is a cap — a wallet that cannot
 *       cover a ticket does not arm, and one that fell short since the last read is refused
 *       at the moment of asking; switching to Phantom never strands a position the
 *       autopilot wallet holds; locked, a sell waits and says so, and sells once unlocked;
 *       an unlock that runs out disarms the lane without a read.
 */
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createHawkEngine, memoryStore, freshState } from "./src/lib/engine.mjs";
import {
  CONFIG_DEFAULTS, snipeArmSentence, browserArmability, normalizeConfig, RECORD,
  browserArmSentence, laneConfigFor, feeModelFor, STOCK_CANARY_RULE, MAX_QUOTE_MINTS, KNOWN_STOCK_QUOTES,
  autopilotBuyNeedLamports, AUTOPILOT_ARM_CLAUSE,
} from "./src/lib/config.mjs";
import { createKeystore, createSessionSigner } from "./src/lib/session-wallet.mjs";
import { ed25519 } from "@noble/curves/ed25519";
import { SIGN_ERRORS, BridgeError } from "./src/lib/protocol.mjs";
import {
  fromBase64, toBase64, associatedTokenAddress, fillFromTransaction, unitsToRaw, rawToUnits, ATA_PROGRAM, WSOL,
} from "./src/lib/tx.mjs";
import {
  PUMPFUN_VENUE, PUMPFUN_PROGRAM_ID, PUMPFUN_IX, decodeBuyIx, decodeCreateEvent, bondingCurveAddress, globalAddress,
  BONDING_CURVE_DISCRIMINATOR, GLOBAL_DISCRIMINATOR, quoteExactOut, sellExactIn, decodeBondingCurve, decodeGlobalFeeRecipients,
} from "./vendor/executor/snipe-venue-pumpfun.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, describeMint } from "./vendor/executor/token2022.mjs";
import { readShadowRows } from "./vendor/executor/shadow-sink.mjs";
import { snipeScorecard, outcomeKnown, rowQuoteMint } from "./vendor/executor/snipe-shadow.mjs";
import { SNIPE_DEFAULTS } from "./vendor/executor/snipe-policy.mjs";
import { SNIPE_LANE_DEFAULTS } from "./vendor/executor/snipe-lane.mjs";
import { main as gradeEntryGates } from "./vendor/executor/grade-entry-gates.mjs";
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
function createChain({ curve: initial, walletLamports = 2n * LAMPORTS, now, wallet: WALLET_ = WALLET, enforceRentFloor = false }) {
  const WALLET = WALLET_;          // the wallet this chain holds: Phantom's double, or the autopilot wallet
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
    /* The runtime's rent rule, when asked for: a payer may end at 0 or at the rent-exempt
       floor, never between. The autopilot wallet's balance check must keep buys off it. */
    if (enforceRentFloor && state.walletLamports < 890_880n && state.walletLamports !== 0n) throw new Error(`InsufficientFundsForRent: the payer would hold ${state.walletLamports} lamports`);
    if (state.walletLamports < 0n) throw new Error("insufficient lamports");
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
        const saved = { lamports: state.walletLamports, tokens: state.walletTokens, ataExists: state.ataExists };
        try { effects = execute(bytes); } catch (error) { err = { InstructionError: [2, { Custom: 6002 }] }; effects = null; state.walletLamports = saved.lamports; state.walletTokens = saved.tokens; state.ataExists = saved.ataExists; }
        state.sent.set(sig, { polls: 0, effects, err, slot: ++state.slot, fee: Number(TX_FEE), bytes });
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
      b.requests.push({ purpose, mint, summary, timeoutMs, txBase64 });
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

/* ═══════════════════════════════════════════════════════════════════════════════════
   STOCK-QUOTED LAUNCHES: pump.fun Custom Pairs, priced in an xStock (GLDx)
   ═══════════════════════════════════════════════════════════════════════════════════ */

const XFIX = JSON.parse(fs.readFileSync(new URL("./vendor/executor/fixtures/pumpfun-xstock-quote.json", import.meta.url), "utf8"));
const xAccount = (address) => {
  const row = XFIX.accounts.find((a) => a.address === address);
  if (!row) throw new Error(`the fixture has no ${address}`);
  return { owner: row.owner, lamports: row.lamports, data: Buffer.from(row.data[0], "base64") };
};
const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const GLDX_CURVE = "JXJC7sJa235q7GbFjsQ9oorm6wHForQ8MZJoF1MedDP";
const GLDX_VAULT = "4oYp7TZ1tBrvHHfMTA8oVYATbVVfiE19vRTfbRvPd5EL";
const GLDX_UNIT = 100_000_000n;                                  // one GLDx at 8 decimals
const QUOTE_ATA_RENT = BigInt(XFIX.rentExemptLamports["179"]);   // 1,559,560: a 179-byte Token-2022 account
const WALLET_GLDX_ATA = associatedTokenAddress(WALLET, GLDX, TOKEN_2022_PROGRAM);
const MINT2 = Keypair.generate().publicKey.toBase58();
const MINT3 = Keypair.generate().publicKey.toBase58();
const LIVE_GLDX_CURVE = decodeBondingCurve({ owner: PUMPFUN_PROGRAM_ID, data: [xAccount(GLDX_CURVE).data.toString("base64"), "base64"] }, { feeBps: 100 });

/** The live 151-byte GLDx-quoted curve, reserves rewritten to the double's state. The
 *  quote mint at byte 83 and the tail stay exactly as mainnet wrote them. */
function stockCurveAccount({ vBase, vQuote, realBase, realQuote, complete = false, creator = CREATOR }) {
  const buf = Buffer.from(xAccount(GLDX_CURVE).data);
  u64(vBase).copy(buf, 8); u64(vQuote).copy(buf, 16); u64(realBase).copy(buf, 24); u64(realQuote).copy(buf, 32);
  buf[48] = complete ? 1 : 0;
  key(creator).copy(buf, 49);
  return { data: [buf.toString("base64"), "base64"], owner: PUMPFUN_PROGRAM_ID, lamports: 1_766_907 };
}
/** The wallet's GLDx account: the live 179-byte Token-2022 vault's bytes (ImmutableOwner,
 *  PausableAccount, TransferHookAccount), with the owner and the amount rewritten. */
function walletGldxAccount(amount) {
  const buf = Buffer.from(xAccount(GLDX_VAULT).data);
  key(WALLET).copy(buf, 32); u64(amount).copy(buf, 64);
  return { data: [buf.toString("base64"), "base64"], owner: TOKEN_2022_PROGRAM, lamports: Number(QUOTE_ATA_RENT) };
}
/** Where the Pausable extension's `paused` byte sits in a Token-2022 mint's TLV. */
function pausedByteOffset(buf) {
  for (let o = 166; o + 4 <= buf.length;) {
    const type = buf.readUInt16LE(o), len = buf.readUInt16LE(o + 2);
    if (type === 26) return o + 4 + 32;
    if (type === 0) break;
    o += 4 + len;
  }
  throw new Error("no Pausable extension in the mint");
}

/**
 * A chain with several launches, each quoted in SOL or in GLDx, one wallet holding SOL
 * and GLDx. It executes the venue's own buy_v2 / sell_v2 arithmetic and REFUSES what the
 * program would: an ATA create whose token program is not the mint's owner, a buy or a
 * sell whose quote mint, quote token program or user quote account is not the curve's,
 * a paused quote, a wallet short of the quote. Simulation rolls everything back.
 */
function createStockChain({ launches, walletLamports = 2n * LAMPORTS, walletQuoteRaw = 10n * GLDX_UNIT, quoteAtaExists = true }) {
  const state = {
    launches: new Map(launches.map((l) => [l.mint, { curve: { ...l.curve }, quoteMint: l.quoteMint ?? null }])),
    walletLamports, walletQuote: walletQuoteRaw, quoteAtaExists, tokens: new Map(), baseAtas: new Map(),
    gldxMint: Buffer.from(xAccount(GLDX).data), slot: 449_986_300, blockHeight: 300_000_000,
    sent: new Map(), calls: [], reads: [], confirmAfterPolls: 1, metaHook: null, lastSim: null,
  };
  const baseAta = (mint) => associatedTokenAddress(WALLET, mint, TOKEN_PROGRAM);
  const curveAcct = (mint) => { const l = state.launches.get(mint); return l.quoteMint ? stockCurveAccount(l.curve) : curveAccount(l.curve); };
  const decoded = (mint) => decodeBondingCurve(curveAcct(mint), { feeBps: 100, mint });
  const paused = () => state.gldxMint[pausedByteOffset(state.gldxMint)] === 1;
  const accountFor = (address) => {
    const a = String(address);
    for (const mint of state.launches.keys()) {
      if (a === bondingCurveAddress(mint).toBase58()) return curveAcct(mint);
      if (a === mint) return mintAccount();
      if (a === baseAta(mint)) return state.baseAtas.get(mint) ? tokenAccount({ mint, owner: WALLET, amount: state.tokens.get(mint) ?? 0n }) : null;
    }
    if (a === globalAddress().toBase58()) return globalAccount();
    if (a === GLDX) return { data: [state.gldxMint.toString("base64"), "base64"], owner: TOKEN_2022_PROGRAM, lamports: 5_588_880 };
    if (a === WALLET) return { data: ["", "base64"], owner: "11111111111111111111111111111111", lamports: Number(state.walletLamports) };
    if (a === WALLET_GLDX_ATA) return state.quoteAtaExists ? walletGldxAccount(state.walletQuote) : null;
    return null;
  };
  const snapshot = () => structuredClone({ ...state, sent: null, calls: null, reads: null, metaHook: null, lastSim: null });
  const restore = (s) => { for (const k of ["launches", "walletLamports", "walletQuote", "quoteAtaExists", "tokens", "baseAtas", "gldxMint"]) state[k] = s[k]; state.gldxMint = Buffer.from(s.gldxMint); };
  function execute(bytes) {
    const tx = VersionedTransaction.deserialize(bytes);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const before = { lamports: state.walletLamports, quote: state.walletQuote, quoteAtaExists: state.quoteAtaExists, tokens: new Map(state.tokens), baseAtas: new Map(state.baseAtas) };
    let rent = 0n;
    const shape = [];
    for (const ix of tx.message.compiledInstructions) {
      const program = keys[ix.programIdIndex];
      const acc = ix.accountKeyIndexes.map((i) => keys[i]);
      if (program === ATA_PROGRAM) {
        const [, ata, owner, mint, , tokenProgram] = acc;
        const mintOwner = mint === GLDX ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
        if (tokenProgram !== mintOwner) throw new Error(`IncorrectProgramId: ${mint} is owned by ${mintOwner}, the create named ${tokenProgram}`);
        if (associatedTokenAddress(owner, mint, tokenProgram) !== ata) throw new Error("InvalidSeeds: not the associated account");
        shape.push({ ata: { mint, tokenProgram, ata } });
        if (mint === GLDX) { if (!state.quoteAtaExists) { state.quoteAtaExists = true; rent += QUOTE_ATA_RENT; } }
        else if (!state.baseAtas.get(mint)) { state.baseAtas.set(mint, true); rent += ATA_RENT; }
        continue;
      }
      if (program !== PUMPFUN_PROGRAM_ID) continue;
      const args = decodeBuyIx(Buffer.from(ix.data));
      const mint = acc[1];
      const l = state.launches.get(mint);
      if (!l) throw new Error(`no curve for ${mint}`);
      const wantQuote = l.quoteMint ?? WSOL;
      const wantQuoteProgram = l.quoteMint ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      if (acc[2] !== wantQuote) throw new Error(`MintDoesNotMatchBondingCurve (6004): quote_mint ${acc[2]}`);
      if (acc[4] !== wantQuoteProgram) throw new Error(`IncorrectProgramId: quote_token_program ${acc[4]}`);
      if (l.quoteMint && acc[15] !== WALLET_GLDX_ATA) throw new Error(`AccountNotInitialized: associated_quote_user ${acc[15]}`);
      if (l.quoteMint && acc[12] !== associatedTokenAddress(bondingCurveAddress(mint).toBase58(), GLDX, TOKEN_2022_PROGRAM)) throw new Error("the curve's quote vault is not its Token-2022 GLDx account");
      if (l.quoteMint && paused()) throw new Error("TokenPaused: the quote mint is paused");
      shape.push({ pump: { instruction: args.instruction, accounts: acc, args } });
      const d = decoded(mint);
      if (args.instruction === "buy_v2") {
        const q = quoteExactOut(d, args.baseOutRaw);
        if (q.quoteInRaw > args.maxQuoteInRaw) throw new Error(`TooMuchSolRequired: ${q.quoteInRaw} > ${args.maxQuoteInRaw}`);
        if (l.quoteMint) {
          if (!state.quoteAtaExists || state.walletQuote < q.quoteInRaw) throw new Error("InsufficientFunds: the wallet's GLDx");
          state.walletQuote -= q.quoteInRaw;
        } else state.walletLamports -= q.quoteInRaw;
        state.tokens.set(mint, (state.tokens.get(mint) ?? 0n) + args.baseOutRaw);
        l.curve.vQuote += q.curveQuoteInRaw; l.curve.vBase -= args.baseOutRaw; l.curve.realQuote += q.curveQuoteInRaw; l.curve.realBase -= args.baseOutRaw;
      } else {
        const q = sellExactIn(d, args.baseInRaw);
        if (q.quoteOutRaw < args.minQuoteOutRaw) throw new Error(`TooLittleSolReceived: ${q.quoteOutRaw} < ${args.minQuoteOutRaw}`);
        if (l.quoteMint) { if (!state.quoteAtaExists) throw new Error("AccountNotInitialized: the wallet's GLDx account"); state.walletQuote += q.quoteOutRaw; }
        else state.walletLamports += q.quoteOutRaw;
        state.tokens.set(mint, (state.tokens.get(mint) ?? 0n) - args.baseInRaw);
        l.curve.vQuote -= q.grossQuoteOutRaw; l.curve.vBase += args.baseInRaw; l.curve.realQuote -= q.grossQuoteOutRaw; l.curve.realBase += args.baseInRaw;
      }
    }
    const pump = shape.find((x) => x.pump);
    if (!pump) throw new Error("no pump.fun instruction in the transaction");
    state.walletLamports -= TX_FEE + rent;
    const mint = pump.pump.accounts[1];
    return { before, after: { lamports: state.walletLamports, quote: state.walletQuote, quoteAtaExists: state.quoteAtaExists, tokens: new Map(state.tokens), baseAtas: new Map(state.baseAtas) }, rent, mint, stock: Boolean(state.launches.get(mint).quoteMint), shape };
  }
  const rpc = {
    url: "https://chain.double",
    async getMultipleAccounts(addresses) { state.calls.push("gma"); state.reads.push(addresses.map(String)); return { slot: state.slot, accounts: addresses.map(accountFor) }; },
    async getBalance() { return state.walletLamports; },
    async getTokenAccountBalance(address) {
      const a = String(address);
      if (a === WALLET_GLDX_ATA) return state.quoteAtaExists ? state.walletQuote : 0n;
      for (const mint of state.launches.keys()) if (a === baseAta(mint)) return state.baseAtas.get(mint) ? state.tokens.get(mint) ?? 0n : 0n;
      return 0n;
    },
    async getLatestBlockhash() { return { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: state.blockHeight + 150 }; },
    async getBlockHeight() { return state.blockHeight; },
    async simulateTransaction(txBase64, { addresses = [] } = {}) {
      state.calls.push("sim");
      const saved = snapshot();
      try {
        const effects = execute(fromBase64(txBase64));
        state.lastSim = { addresses: addresses.map(String), shape: effects.shape };
        return { err: null, logs: [], unitsConsumed: 150_000, accounts: addresses.map(accountFor) };
      } catch (error) {
        state.lastSim = { error: error.message };
        return { err: { InstructionError: [3, { Custom: 6002 }] }, logs: [`Program log: ${error.message}`], accounts: null };
      } finally { restore(saved); }
    },
    async sendTransaction(txBase64) {
      state.calls.push("send");
      const bytes = fromBase64(txBase64);
      const tx = VersionedTransaction.deserialize(bytes);
      const sig = bs58.encode(tx.signatures[0]);
      if (!state.sent.has(sig)) {
        let effects = null, err = null;
        try { effects = execute(bytes); } catch { err = { InstructionError: [3, { Custom: 6002 }] }; }
        state.sent.set(sig, { polls: 0, effects, err, slot: ++state.slot, fee: Number(TX_FEE), bytes });
      }
      return sig;
    },
    async getSignatureStatus(sig) {
      const s = state.sent.get(sig);
      if (!s) return null;
      s.polls++;
      return s.polls < state.confirmAfterPolls ? null : { err: s.err, confirmationStatus: "confirmed" };
    },
    async getTransaction(sig) {
      const s = state.sent.get(sig);
      if (!s) return null;
      if (s.err) return { slot: s.slot, meta: { err: s.err, fee: s.fee, preBalances: [0], postBalances: [0] } };
      const e = s.effects;
      const mint = e.mint;
      const base = (tokens) => (tokens.get(mint) ?? 0n) > 0n ? [{ mint, owner: WALLET, uiTokenAmount: { amount: tokens.get(mint).toString(), decimals: 6 } }] : [];
      const quote = (exists, amount) => (e.stock && exists ? [{ mint: GLDX, owner: WALLET, uiTokenAmount: { amount: amount.toString(), decimals: 8 } }] : []);
      const meta = {
        err: null, fee: s.fee,
        preBalances: [Number(e.before.lamports), e.before.baseAtas.get(mint) ? Number(ATA_RENT) : 0, ...(e.stock ? [e.before.quoteAtaExists ? Number(QUOTE_ATA_RENT) : 0] : [])],
        postBalances: [Number(e.after.lamports), Number(ATA_RENT), ...(e.stock ? [Number(QUOTE_ATA_RENT)] : [])],
        preTokenBalances: [...base(e.before.tokens), ...quote(e.before.quoteAtaExists, e.before.quote)],
        postTokenBalances: [...base(e.after.tokens), ...quote(e.after.quoteAtaExists, e.after.quote)],
      };
      return { slot: s.slot, meta: state.metaHook ? state.metaHook(meta) : meta };
    },
  };
  return {
    rpc, state,
    /** Buyers arrive: `quoteIn` raw units of the launch's quote (lamports, or GLDx raw). */
    bump(mint, quoteIn) { const l = state.launches.get(mint); const q = PUMPFUN_VENUE.quoteExactIn(decoded(mint), BigInt(quoteIn)); l.curve.vQuote += q.curveQuoteInRaw; l.curve.vBase -= q.baseOutRaw; l.curve.realQuote += q.curveQuoteInRaw; l.curve.realBase -= q.baseOutRaw; },
    dump(mint, baseOut) { const l = state.launches.get(mint); const q = sellExactIn(decoded(mint), BigInt(baseOut)); l.curve.vQuote -= q.grossQuoteOutRaw; l.curve.vBase += BigInt(baseOut); l.curve.realQuote -= q.grossQuoteOutRaw; l.curve.realBase += BigInt(baseOut); },
    markOf(mint, qtyRaw, entryInput) { return Number(sellExactIn(decoded(mint), BigInt(qtyRaw)).quoteOutRaw) / Number(BigInt(entryInput)); },
    setPaused(on) { state.gldxMint[pausedByteOffset(state.gldxMint)] = on ? 1 : 0; },
    tokensOf(mint) { return state.tokens.get(mint) ?? 0n; },
  };
}

/** The live GLDx curve's own shape (vQuote ~10.74 GLDx virtual), freshly launched. */
const GLDX_CURVE_AT_CREATE = { vBase: LIVE_GLDX_CURVE.vBaseRaw, vQuote: LIVE_GLDX_CURVE.vQuoteRaw - LIVE_GLDX_CURVE.realQuoteRaw, realBase: LIVE_GLDX_CURVE.vBaseRaw - 279_900_000_000_000n, realQuote: 0n };
const GLDX_ENTRY = Object.freeze({ mint: GLDX, symbol: "GLDx", maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.5 });
const stockNotice = (mint, clock) => ({ mint, creator: CREATOR, slot: 449_986_250, noticeAt: clock.now(), source: "logsSubscribe" });
const armedStockConfig = (over = {}) => {
  const quoteMints = over.quoteMints ?? [GLDX_ENTRY];
  const maxSol = over.maxSolPerTrade ?? 0.05, cap = over.dailySolCap ?? 0.5;
  return armedConfig({ quoteMints, liveAck: browserArmSentence(WALLET, maxSol, cap, normalizeConfig({ quoteMints }).quoteMints), ...over });
};
const short4 = (k) => `${k.slice(0, 4)}…`;
/** The instructions of a transaction the wallet was asked to sign, by program. */
function instructionsOf(txBase64) {
  const tx = VersionedTransaction.deserialize(fromBase64(txBase64));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  return tx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ix.data) }));
}

section("9. A STOCK-QUOTED LAUNCH WITH NO STOCK LISTED IS REFUSED, AND NOTHING EXTRA IS READ");
{
  ok("the fixture's curve decodes as quoted in GLDx, 151 bytes of mainnet", LIVE_GLDX_CURVE.quoteMint === GLDX && LIVE_GLDX_CURVE.quoteIsSol === false && LIVE_GLDX_CURVE.bytes === 151, `quote ${LIVE_GLDX_CURVE.quoteMint.slice(0, 6)}… bytes ${LIVE_GLDX_CURVE.bytes}`);
  const gd = describeMint(xAccount(GLDX), GLDX);
  ok("describeMint reads the fixture's GLDx as Token-2022, 8 decimals, unpaused, no hook, symbol GLDx", gd.program === TOKEN_2022_PROGRAM && gd.decimals === 8 && gd.paused === false && gd.transferHookProgram === null && gd.metadataSymbol === "GLDx");
  ok("the wallet's GLDx account is the fixture vault's 179-byte layout, and it derives under Token-2022", Buffer.from(walletGldxAccount(1n).data[0], "base64").length === 179 && WALLET_GLDX_ATA !== associatedTokenAddress(WALLET, GLDX, TOKEN_PROGRAM));
  const clock = createClock();
  const chain = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain.bump(MINT, GLDX_UNIT / 2n);
  const bridge = createBridge({ wallet: null, ready: false });
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: { lane: "observe" } });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig9", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  const st = engine.status();
  ok("refused at quote_not_sol", st.refusals[0]?.gate === "quote_not_sol" && st.open.length === 0, st.refusals[0]?.message?.slice(0, 120));
  ok("the refusal says the allowlist is empty and the lane pays in SOL only", /allowlist is empty: this lane pays in SOL only/.test(st.refusals[0]?.message ?? ""));
  ok("the one read carried the curve, Global and the mint — no stock mint was read", chain.state.reads.length === 1 && chain.state.reads[0].length === 3 && !chain.state.reads[0].includes(GLDX), JSON.stringify(chain.state.reads.map((r) => r.length)));
  const row = engine.state.shadow[MINT];
  ok("the shadow row still says the launch was quoted in GLDx", row?.curve?.quoteMint === GLDX && rowQuoteMint(row) === GLDX, `curve.quoteMint ${row?.curve?.quoteMint}`);
  ok("the log line names the gate", lines.some((l) => /refused at quote_not_sol/.test(l)));
}

section("10. GLDx LISTED: ITS MINT RIDES ON THE SAME READ, AND THE WOULD-HAVE ROW IS IN GLDx");
{
  const clock = createClock();
  const chain = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain.bump(MINT, GLDX_UNIT / 2n);
  const bridge = createBridge({ wallet: null, ready: false });
  const { engine, lines } = makeEngine({ chain, bridge, clock, config: { lane: "observe", quoteMints: [GLDX_ENTRY] } });
  await engine.load();
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig10", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  const st = engine.status();
  ok("exactly one read for the notice, and GLDx's mint is on it", chain.state.reads.length === 1 && chain.state.reads[0].length === 4 && chain.state.reads[0][3] === GLDX, JSON.stringify(chain.state.reads.map((r) => r.length)));
  ok("the launch cleared every gate in GLDx", st.counters.cleared === 1 && st.counters.refused === 0, `${st.refusals[0]?.gate ?? "pass"}: ${st.refusals[0]?.message ?? ""}`);
  const pos = st.open[0];
  ok("the would-have row is quoted in GLDx at 8 decimals, under Token-2022", pos?.quoteMint === GLDX && pos.quoteDecimals === 8 && pos.quoteSymbol === "GLDx" && pos.quoteTokenProgram === TOKEN_2022_PROGRAM, pos ? `${pos.quoteSymbol} ${pos.quoteDecimals}dp` : "no row");
  ok("its ceiling is at most the full 0.05 GLDx ticket (the canary binds live buys, not the research row)", BigInt(pos.entryInputLamports) <= 5_000_000n && BigInt(pos.entryInputLamports) > 1_000_000n, `${pos.entryInputLamports} raw`);
  ok("its size is the ceiling in GLDx units, exactly", pos.sizeSol === Number(pos.entryInputLamports) / 1e8, `${pos.sizeSol} GLDx`);
  ok("its fee leg is 0 and the SOL fee travels beside it", pos.feeSolPerLeg === 0 && pos.entryFeeLamports === "0" && pos.networkFeeLamports === String(Math.round(SNIPE_LANE_DEFAULTS.networkFeeReserveSol * 1e9)), `feeSolPerLeg ${pos.feeSolPerLeg}, networkFeeLamports ${pos.networkFeeLamports}`);
  const row = engine.state.shadow[MINT];
  ok("the shadow row carries the quote and its decimals, and the ceiling says what it was sized in", row.curve.quoteMint === GLDX && row.curve.quoteDecimals === 8 && row.ceiling.quoteMint === GLDX && row.wouldHaveSigned === true);
  ok("the log line prices the ceiling in GLDx with the SOL fee beside it", lines.some((l) => /would have entered for at most 0\.0\d+ GLDx \(network fee ~0\.0005 SOL beside it\)/.test(l)), lines.find((l) => /would have entered/.test(l)));
  ok("status lists GLDx with the decimals read off its mint, on the canary", st.quoteMints[0]?.decimals === 8 && st.quoteMints[0].canary === "canary" && st.quoteMints[0].nextLiveTicket === 0.01 && st.quoteMints[0].paused === false, JSON.stringify(st.quoteMints[0]));
  ok("status carries the canary rule verbatim", st.stockCanaryRule === STOCK_CANARY_RULE && /minPerTrade/.test(st.stockCanaryRule));
  for (let i = 0; i < 3; i++) { clock.advance(5_000); await engine.tick(); }
  ok("a forward sample re-reads GLDx on the same call as the curve", chain.state.reads.slice(1).every((r) => r[r.length - 1] === GLDX), JSON.stringify(chain.state.reads.slice(1).map((r) => r.length)));

  const clock2 = createClock();
  const chain2 = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain2.bump(MINT, GLDX_UNIT / 2n);
  const e2 = makeEngine({ chain: chain2, bridge: createBridge({ wallet: null, ready: false }), clock: clock2, config: { lane: "observe", quoteMints: [{ ...GLDX_ENTRY, symbol: "TSLAx" }] } });
  await e2.engine.load();
  e2.engine.onLogs({ logs: CREATE_LOGS, signature: "sig10b", slot: 446_023_102, err: null, receivedAt: clock2.now() });
  await new Promise((r) => setTimeout(r, 30));
  const r2 = e2.engine.status().refusals[0];
  ok("a listed symbol that is not the mint's own is refused, naming the mint's own", r2?.gate === "quote_not_sol" && /calls itself GLDx/.test(r2.message), r2?.message?.slice(-140));
}

section("11. ARMED: THE CANARY BUY PAYS IN GLDx, UNDER TOKEN-2022, AND IS READ BACK IN EIGHT DECIMALS");
let provenEngine = null, provenChain = null, provenClock = null, provenBridge = null, provenNotes = null;
{
  const clock = createClock();
  const chain = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }, { mint: MINT2, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain.bump(MINT, GLDX_UNIT / 2n);
  const bridge = createBridge();
  const notes = [];
  const solOnly = makeEngine({ chain, bridge, clock, config: armedConfig({ quoteMints: [GLDX_ENTRY] }) });
  await solOnly.engine.load();
  const s0 = solOnly.engine.status();
  ok("with GLDx listed, the SOL-only sentence does not arm", s0.executing === false && s0.armability.blocking.includes("live_ack_typed"), s0.armability.blocking.join(","));
  ok("the sentence the lane asks for names GLDx, its canary, its cap and its mint", /0\.05 GLDx per launch \(the first at 0\.01 GLDx\), 0\.5 GLDx per day \(Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re\)/.test(s0.armability.expectedAck ?? ""), s0.armability.expectedAck?.slice(-110));
  const noStop = makeEngine({ chain, bridge, clock, config: armedStockConfig({ stopFrac: null, maxSolPerTrade: 0.005, dailySolCap: 0.5 }) });
  await noStop.engine.load();
  const s1 = noStop.engine.status();
  ok("a matching sentence with GLDx listed and no stop chosen does not arm: the checklist is the condition", s1.executing === false && s1.armability.blocking.includes("stop_chosen_for_stock_quotes") && s1.armability.blocking.length === 1, s1.armability.blocking.join(","));

  const { engine, lines } = makeEngine({ chain, bridge, clock, config: armedStockConfig(), notes });
  await engine.load();
  ok("with the stock sentence typed and a stop chosen, the lane executes", engine.status().executing === true, engine.status().armability.blocking.join(",") || "nothing blocking");
  ok("the checklist warns that stock-quoted launches are unmeasured, and states the canary", engine.status().armability.warnings.some((w) => w.name === "stock_quote_unmeasured") && engine.status().armability.warnings.some((w) => w.name === "stock_canary" && w.detail.includes(STOCK_CANARY_RULE)));
  engine.onLogs({ logs: CREATE_LOGS, signature: "sig11", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  ok("first notice opens a GLDx would-have row and asks nothing", engine.status().open[0]?.quoteMint === GLDX && bridge.requests.length === 0);
  chain.bump(MINT, GLDX_UNIT);                                   // 1 GLDx of buyers during the wait
  const lamportsBefore = chain.state.walletLamports, gldxBefore = chain.state.walletQuote;
  clock.advance(10_000);
  await drive(clock, engine.tick());
  ok("after the wait the lane asked Phantom for exactly one buy", bridge.requests.length === 1 && bridge.requests[0].purpose === "buy", `${bridge.requests.length} requests`);
  const req = bridge.requests[0];
  ok("the window's summary prices the buy in GLDx, says it is the canary, and that fees are SOL", /up to 0\.0\d+ GLDx/.test(req.summary) && /canary/.test(req.summary) && /network fee and rent in SOL/.test(req.summary), req.summary);
  const ixs = instructionsOf(req.txBase64).filter((i) => i.program !== "ComputeBudget111111111111111111111111111111");
  ok("the signed bytes are: the launch token's ATA create, the GLDx ATA create, buy_v2", ixs.length === 3 && ixs[0].program === ATA_PROGRAM && ixs[1].program === ATA_PROGRAM && ixs[2].program === PUMPFUN_PROGRAM_ID, ixs.map((i) => i.program.slice(0, 6)).join(" "));
  ok("the launch token's account is created under its own program (Token)", ixs[0].accounts[3] === MINT && ixs[0].accounts[5] === TOKEN_PROGRAM);
  ok("the GLDx account is created under GLDx's owner, Token-2022, at the wallet's Token-2022 address", ixs[1].accounts[3] === GLDX && ixs[1].accounts[5] === TOKEN_2022_PROGRAM && ixs[1].accounts[1] === WALLET_GLDX_ATA);
  const buy = ixs[2];
  const decodedBuy = decodeBuyIx(buy.data);
  ok("buy_v2 names GLDx as quote_mint (2) and Token-2022 as the quote token program (4)", decodedBuy.instruction === "buy_v2" && buy.accounts[2] === GLDX && buy.accounts[4] === TOKEN_2022_PROGRAM, `2=${buy.accounts[2].slice(0, 6)} 4=${buy.accounts[4].slice(0, 6)}`);
  ok("…the curve's GLDx vault (12) and the wallet's GLDx account (15) are the Token-2022 derivations", buy.accounts[12] === associatedTokenAddress(bondingCurveAddress(MINT).toBase58(), GLDX, TOKEN_2022_PROGRAM) && buy.accounts[15] === WALLET_GLDX_ATA);
  /* The bug this replaces, pinned: the Token program hard-coded as the quote's names a
     wallet account and a curve vault that do not exist for a Token-2022 stock. */
  const g = decodeGlobalFeeRecipients(Buffer.from(globalAccount().data[0], "base64"));
  const legacy = PUMPFUN_VENUE.buyIx({ mint: MINT, user: WALLET, curve: decodeBondingCurve(stockCurveAccount(GLDX_CURVE_AT_CREATE), { feeBps: 100, mint: MINT }), curveReadSlot: 1, buildingForSlot: 1,
    feeRecipient: FEE_RECIPIENT, buybackFeeRecipient: BUYBACK, baseTokenProgram: TOKEN_PROGRAM, quoteTokenProgram: TOKEN_PROGRAM,
    associatedBaseUser: associatedTokenAddress(WALLET, MINT, TOKEN_PROGRAM), associatedBaseUserOwner: WALLET, globalFeeRecipients: g, amountRaw: 1n, maxQuoteInRaw: 1n });
  ok("(a quote program hard-coded to Token would have named a GLDx account the wallet does not have)", legacy.keys[4].pubkey === TOKEN_PROGRAM && legacy.keys[15].pubkey !== WALLET_GLDX_ATA && legacy.keys[15].pubkey !== buy.accounts[15]);
  ok("THE CANARY: the ceiling is at most minPerTrade (0.01 GLDx), not the 0.05 ticket", decodedBuy.maxQuoteInRaw > 0n && decodedBuy.maxQuoteInRaw <= 1_000_000n, `maxQuoteInRaw ${decodedBuy.maxQuoteInRaw}`);
  ok("the simulation read the wallet, the base account and the GLDx account, and preceded the send", chain.state.calls.indexOf("sim") < chain.state.calls.indexOf("send") && JSON.stringify(chain.state.lastSim?.addresses) === JSON.stringify([WALLET, associatedTokenAddress(WALLET, MINT, TOKEN_PROGRAM), WALLET_GLDX_ATA]), JSON.stringify(chain.state.lastSim?.addresses?.map((a) => a.slice(0, 4))));
  const st = engine.status();
  const live = st.open.find((p) => p.live === true);
  const spentGldx = gldxBefore - chain.state.walletQuote;
  const spentLamports = lamportsBefore - chain.state.walletLamports;
  ok("the fill is booked live in GLDx, one position for the mint", live && st.open.length === 1 && live.quoteMint === GLDX && live.canary === true, live ? `qty ${live.qtyRaw} input ${live.entryInputLamports} GLDx-raw` : st.log.slice(0, 3).map((l) => l.line).join(" | "));
  ok("its quantity is what the chain delivered", BigInt(live.qtyRaw) === chain.tokensOf(MINT), `${live.qtyRaw} vs ${chain.tokensOf(MINT)}`);
  ok("its input is the wallet's GLDx delta, read in 8 decimals", BigInt(live.entryInputLamports) === spentGldx && live.quoteDecimals === 8 && live.sizeSol === Number(spentGldx) / 1e8, `${live.entryInputLamports} raw = ${live.sizeSol} GLDx`);
  ok("SOL moved by the fee and the one account created, nothing else — and the row carries it", spentLamports === TX_FEE + ATA_RENT && live.networkFeeLamports === String(TX_FEE + ATA_RENT) && live.feeSolPerLeg === 0, `spent ${spentLamports} lamports`);
  ok("GLDx is charged to its own day", st.deployedTodayQuote[GLDX]?.raw === spentGldx.toString() && st.quoteMints[0].deployedToday === Number(spentGldx) / 1e8, JSON.stringify(st.deployedTodayQuote[GLDX]));
  ok("…and only the fee and rent to the SOL day", Math.abs(st.deployedTodaySol - Number(TX_FEE + ATA_RENT) / 1e9) < 1e-12, `${st.deployedTodaySol} SOL`);
  ok("the canary is now proven, and the next GLDx buy may use the full ticket", st.quoteMints[0].canary === "proven" && st.quoteMints[0].nextLiveTicket === 0.05 && typeof st.quoteMints[0].canarySignature === "string", JSON.stringify({ c: st.quoteMints[0].canary, next: st.quoteMints[0].nextLiveTicket }));
  ok("the log says the canary was read back, and ENTERED in GLDx with the SOL fee beside it", lines.some((l) => /GLDx canary buy was read back off the chain/.test(l)) && lines.some((l) => /ENTERED — \d+ base for 0\.0\d+ GLDx \(the canary\), plus \d+ lamports of network fee and rent in SOL/.test(l)), lines.find((l) => /ENTERED/.test(l)));
  provenEngine = engine; provenChain = chain; provenClock = clock; provenBridge = bridge; provenNotes = notes;
}

section("12. THE TAKE SELLS FOR GLDx; THE CLOSE IS BOOKED IN GLDx WITH ITS SOL FEES BESIDE IT");
{
  const engine = provenEngine, chain = provenChain, clock = provenClock, bridge = provenBridge;
  const live = engine.status().open.find((p) => p.live);
  chain.bump(MINT, 4n * GLDX_UNIT);                              // the coin runs, in GLDx
  const mark = chain.markOf(MINT, live.qtyRaw, live.entryInputLamports);
  ok("the coin marks above the 1.5x take, measured in GLDx", mark >= 1.5, `mark ${mark.toFixed(3)}x`);
  const gldxBefore = chain.state.walletQuote, lamportsBefore = chain.state.walletLamports;
  clock.advance(1_000);
  await drive(clock, engine.tick());
  const req = bridge.requests[1];
  ok("the determiner ordered the sell and Phantom was asked once", bridge.requests.length === 2 && req?.purpose === "sell" && /take/.test(req.summary), req?.summary);
  ok("the sell's floor is in GLDx", /floor 0\.\d+ GLDx; network fee in SOL/.test(req.summary), req.summary);
  const ixs = instructionsOf(req.txBase64).filter((i) => i.program !== "ComputeBudget111111111111111111111111111111");
  ok("the sell's bytes: an idempotent GLDx account create under Token-2022, then sell_v2", ixs.length === 2 && ixs[0].program === ATA_PROGRAM && ixs[0].accounts[5] === TOKEN_2022_PROGRAM && ixs[0].accounts[1] === WALLET_GLDX_ATA && decodeBuyIx(ixs[1].data).instruction === "sell_v2");
  ok("sell_v2 names Token-2022 as the quote program and the wallet's GLDx account at 15", ixs[1].accounts[4] === TOKEN_2022_PROGRAM && ixs[1].accounts[15] === WALLET_GLDX_ATA && ixs[1].accounts[2] === GLDX);
  const st = engine.status();
  const closed = st.closes[0];
  const gotGldx = chain.state.walletQuote - gldxBefore;
  ok("the position closed live on the take", st.open.length === 0 && closed.live === true && /take/.test(closed.reason), closed?.reason);
  ok("realized is the GLDx the wallet received, and P&L is realized less the GLDx basis", closed.realizedQuoteRaw === gotGldx.toString() && BigInt(closed.pnlQuoteRaw) === gotGldx - BigInt(live.entryInputLamports) && BigInt(closed.pnlQuoteRaw) > 0n, `realized ${closed.realizedQuoteRaw} pnl ${closed.pnlQuoteRaw} (${closed.pnlQuote} GLDx)`);
  ok("no SOL P&L is invented for a GLDx trade", closed.pnlSol === null && closed.pnlLamports === null && closed.quoteSymbol === "GLDx");
  ok("the SOL it paid in fees is reported beside it: the entry's fee and rent plus the sell's fee", closed.feeLamportsPaid === String(TX_FEE + ATA_RENT + TX_FEE) && lamportsBefore - chain.state.walletLamports === TX_FEE, `feeLamportsPaid ${closed.feeLamportsPaid}`);
  ok("the book counts one live win, and sums GLDx apart from SOL", st.book.liveTrades === 1 && st.book.liveWins === 1 && st.book.realizedSol === 0 && st.book.realizedByQuote[GLDX]?.trades === 1 && st.book.realizedByQuote[GLDX].raw === closed.pnlQuoteRaw, JSON.stringify(st.book.realizedByQuote[GLDX]));
  let serialisable = true; try { JSON.stringify(engine.status()); JSON.stringify(engine.state); } catch { serialisable = false; }
  ok("the status and the persisted state carry no BigInt (the popup and the store can take them)", serialisable);
  const again = makeEngine({ chain, bridge: createBridge({ wallet: null, ready: false }), clock, config: { lane: "observe", quoteMints: [GLDX_ENTRY] }, store: memoryStore(engine.state) });
  await again.engine.load();
  const restored = again.engine.state.shadow[MINT];
  ok("a restart keeps the shadow row's quote, on the curve and on the ceiling", restored?.curve?.quoteMint === GLDX && restored?.ceiling?.quoteMint === GLDX && again.engine.status().quoteMints[0].canary === "proven", `curve ${restored?.curve?.quoteMint?.slice(0, 4)} ceiling ${restored?.ceiling?.quoteMint?.slice(0, 4)}`);
  ok("the SOL day was charged the sell's fee too (SOL spent is SOL spent)", Math.abs(st.deployedTodaySol - Number(TX_FEE + ATA_RENT + TX_FEE) / 1e9) < 1e-12, `${st.deployedTodaySol}`);
}

section("13. ONCE PROVEN THE TICKET IS FULL; THE DAY CAP IS PER STOCK; THE SOL DAY STILL BINDS");
{
  const engine = provenEngine, chain = provenChain, clock = provenClock, bridge = provenBridge;
  chain.bump(MINT2, GLDX_UNIT / 2n);
  await engine.handleNotice(stockNotice(MINT2, clock));
  chain.bump(MINT2, GLDX_UNIT);
  clock.advance(10_000);
  await drive(clock, engine.tick());
  const req = bridge.requests[2];
  const max = req ? decodeBuyIx(instructionsOf(req.txBase64).find((i) => i.program === PUMPFUN_PROGRAM_ID).data).maxQuoteInRaw : null;
  ok("the second GLDx buy is sized at the full ticket (above the 0.01 canary, at most 0.05)", req?.purpose === "buy" && max > 1_000_000n && max <= 5_000_000n && !/canary/.test(req.summary), `maxQuoteInRaw ${max}; ${req?.summary}`);

  const clock2 = createClock();
  const chain2 = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }, { mint: MINT3, curve: CURVE_AT_CREATE }] });
  chain2.bump(MINT, GLDX_UNIT / 2n); chain2.bump(MINT3, 1_500_000_000n);
  const tight = { ...GLDX_ENTRY, dailyCap: 0.06 };
  const e2 = makeEngine({ chain: chain2, bridge: createBridge({ wallet: null, ready: false }), clock: clock2, config: { lane: "observe", quoteMints: [tight], maxSolPerTrade: 0.05, dailySolCap: 0.05 } });
  await e2.engine.load();
  e2.engine.state.spend.push({ at: clock2.now() - 1_000, sol: 0, kind: "entry", quoteMint: GLDX, quoteRaw: "2000000", quoteDecimals: 8 });
  await e2.engine.handleNotice(stockNotice(MINT, clock2));
  const r = e2.engine.status().refusals[0];
  ok("0.02 GLDx already spent + a 0.05 ticket against a 0.06 GLDx cap: refused at daily_capacity, in GLDx", r?.gate === "daily_capacity" && /GLDx ticket would take the day to 0\.07000000 GLDx against a 0\.06000000 GLDx cap/.test(r.message), r?.message);
  await e2.engine.handleNotice(stockNotice(MINT3, clock2));
  ok("…and a SOL launch on the same day is not charged the GLDx ledger (0.05 of 0.05 SOL clears)", e2.engine.status().open.some((p) => p.mint === MINT3 && !p.quoteMint), `open: ${e2.engine.status().open.map((p) => `${short4(p.mint)} ${p.quoteSymbol ?? "SOL"}`).join(", ")}`);

  const clock3 = createClock();
  const chain3 = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain3.bump(MINT, GLDX_UNIT / 2n);
  const bridge3 = createBridge();
  const e3 = makeEngine({ chain: chain3, bridge: bridge3, clock: clock3, config: armedStockConfig({ maxSolPerTrade: 0.05, dailySolCap: 0.05 }) });
  await e3.engine.load();
  e3.engine.state.spend.push({ at: clock3.now() - 1_000, sol: 0.049, kind: "entry" });
  await e3.engine.handleNotice(stockNotice(MINT, clock3));
  chain3.bump(MINT, GLDX_UNIT);
  clock3.advance(10_000);
  await drive(clock3, e3.engine.tick());
  ok("the SOL day binds the SOL a GLDx buy would spend: refused before Phantom", bridge3.requests.length === 0 && e3.lines.some((l) => /daily_capacity_sol/.test(l) && /network fee and rent/.test(l)), e3.lines.find((l) => /daily_capacity_sol/.test(l)));
}

section("14. A WALLET SHORT OF GLDx, A PAUSED GLDx, AND A BUY THAT CANNOT BE READ BACK");
{
  const armedChain = (over = {}) => {
    const clock = createClock();
    const chain = createStockChain({ launches: [{ mint: MINT, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }, { mint: MINT2, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }], ...over });
    chain.bump(MINT, GLDX_UNIT / 2n);
    const bridge = createBridge();
    const notes = [];
    const made = makeEngine({ chain, bridge, clock, config: armedStockConfig(), notes });
    return { clock, chain, bridge, notes, ...made };
  };
  {
    const t = armedChain({ walletQuoteRaw: 500_000n });           // 0.005 GLDx, under the 0.01 canary
    await t.engine.load();
    await t.engine.handleNotice(stockNotice(MINT, t.clock));
    t.chain.bump(MINT, GLDX_UNIT);
    t.clock.advance(10_000);
    await drive(t.clock, t.engine.tick());
    ok("a wallet holding less GLDx than the ceiling is refused before Phantom is asked", t.bridge.requests.length === 0 && t.lines.some((l) => /quote_balance_short/.test(l) && /holds 0\.005 GLDx/.test(l)), t.lines.find((l) => /quote_balance_short/.test(l)));
    ok("nothing was simulated or sent", !t.chain.state.calls.includes("send"));
  }
  {
    const t = armedChain();
    t.chain.setPaused(true);
    await t.engine.load();
    await t.engine.handleNotice(stockNotice(MINT, t.clock));
    const r = t.engine.status().refusals[0];
    ok("a PAUSED GLDx is refused at quote_not_sol at first notice", r?.gate === "quote_not_sol" && /PAUSED/.test(r.message), r?.message?.slice(0, 120));
    ok("status shows GLDx paused by its issuer", t.engine.status().quoteMints[0].paused === true);
  }
  {
    const t = armedChain();
    await t.engine.load();
    await t.engine.handleNotice(stockNotice(MINT, t.clock));
    t.chain.bump(MINT, GLDX_UNIT);
    t.clock.advance(10_000);
    await drive(t.clock, t.engine.tick());
    ok("(a live GLDx position is open)", t.engine.status().open.some((p) => p.live && p.quoteMint === GLDX), t.lines.slice(0, 2).join(" | "));
    t.chain.setPaused(true);
    t.chain.bump(MINT, 4n * GLDX_UNIT);
    t.clock.advance(1_000);
    await drive(t.clock, t.engine.tick());
    ok("paused mid-hold: the take fires but no sell window opens", t.bridge.requests.length === 1 && t.engine.status().open.some((p) => p.live && p.quotePaused === true), `requests ${t.bridge.requests.length}`);
    ok("…and the lane said why, and told the user", t.lines.some((l) => /is PAUSED by its issuer/.test(l)) && t.lines.some((l) => /cannot settle; holding/.test(l)) && t.notes.some((n) => n.kind === "attention" && /paused/.test(n.title)), t.lines.find((l) => /cannot settle/.test(l)));
    t.chain.setPaused(false);
    t.clock.advance(1_000);
    await drive(t.clock, t.engine.tick());
    ok("unpaused: the sell is asked and lands", t.bridge.requests.length === 2 && t.bridge.requests[1].purpose === "sell" && t.engine.status().open.length === 0 && t.lines.some((l) => /unpaused/.test(l)), `requests ${t.bridge.requests.length}, open ${t.engine.status().open.length}`);
  }
  {
    const t = armedChain();
    t.chain.state.metaHook = (meta) => ({ ...meta, postBalances: [meta.postBalances[0] - 1, ...meta.postBalances.slice(1)] });   // one unexplained lamport
    await t.engine.load();
    await t.engine.handleNotice(stockNotice(MINT, t.clock));
    t.chain.bump(MINT, GLDX_UNIT);
    t.clock.advance(10_000);
    await drive(t.clock, t.engine.tick());
    const st = t.engine.status();
    ok("a landed GLDx buy whose fill does not add up is not booked, and says so loudly", t.bridge.requests.length === 1 && t.chain.state.calls.includes("send") && !st.open.some((p) => p.live) && t.lines.some((l) => /BOUGHT WITH GLDx BUT its fill could not be read back/.test(l) && /beyond fee and rent/.test(l)), t.lines.find((l) => /BOUGHT WITH/.test(l))?.slice(0, 160));
    ok("…the user is told to sell by hand", t.notes.some((n) => n.kind === "attention" && /sell it by hand/i.test(n.body)));
    ok("…GLDx is BLOCKED, visibly, and the canary is not proven", st.quoteMints[0].canary === "blocked" && st.quoteMints[0].nextLiveTicket === null && /could not be read back/.test(st.quoteMints[0].canaryDetail), JSON.stringify({ c: st.quoteMints[0].canary, d: st.quoteMints[0].canaryDetail?.slice(0, 60) }));
    ok("…and the day is charged as if the whole ceiling was spent", BigInt(st.deployedTodayQuote[GLDX].raw) > 0n && BigInt(st.deployedTodayQuote[GLDX].raw) <= 1_000_000n, st.deployedTodayQuote[GLDX].raw);
    t.chain.state.metaHook = null;
    t.chain.bump(MINT2, GLDX_UNIT / 2n);
    await t.engine.handleNotice(stockNotice(MINT2, t.clock));
    t.chain.bump(MINT2, GLDX_UNIT);
    t.clock.advance(10_000);
    await drive(t.clock, t.engine.tick());
    ok("the next GLDx launch is refused before Phantom while the block stands", t.bridge.requests.length === 1 && t.lines.some((l) => /stock_canary_blocked/.test(l)), t.lines.find((l) => /stock_canary_blocked/.test(l))?.slice(0, 140));
    ok("clearing the block puts GLDx back on the canary", (await t.engine.clearStockCanary(GLDX)) === true && t.engine.status().quoteMints[0].canary === "canary" && t.engine.status().quoteMints[0].nextLiveTicket === 0.01);
    ok("a stock that is not blocked cannot be 'cleared'", (await t.engine.clearStockCanary(GLDX)) === false);
  }
}

section("15. ONE BOOK, TWO POPULATIONS: SOL AND GLDx LAUNCHES ARE GRADED APART");
{
  const clock = createClock();
  const chain = createStockChain({ launches: [{ mint: MINT3, curve: CURVE_AT_CREATE }, { mint: MINT2, curve: GLDX_CURVE_AT_CREATE, quoteMint: GLDX }] });
  chain.bump(MINT3, 1_500_000_000n); chain.bump(MINT2, GLDX_UNIT / 2n);
  const { engine } = makeEngine({ chain, bridge: createBridge({ wallet: null, ready: false }), clock, config: { lane: "observe", quoteMints: [GLDX_ENTRY] } });
  await engine.load();
  await engine.handleNotice(stockNotice(MINT3, clock));
  await engine.handleNotice(stockNotice(MINT2, clock));
  ok("both launches opened would-have rows, one in SOL and one in GLDx", engine.status().open.length === 2 && engine.status().open.filter((p) => p.quoteMint === GLDX).length === 1);
  for (let i = 0; i < 24; i++) { clock.advance(5_000); await engine.tick(); }
  const st = engine.status();
  ok("the SOL card judged the SOL row only", st.shadow.scorecard.judged === 1 && st.shadow.scorecard.excludedByQuote?.[GLDX] === 1, `judged ${st.shadow.scorecard.judged}, excluded ${JSON.stringify(st.shadow.scorecard.excludedByQuote)}`);
  ok("the GLDx card judged the GLDx row only", st.shadow.scorecardByQuote[GLDX]?.judged === 1 && st.shadow.scorecardByQuote[WSOL]?.judged === 1, JSON.stringify(Object.fromEntries(Object.entries(st.shadow.scorecardByQuote).map(([k, v]) => [k.slice(0, 4), v.judged]))));
  const paperGldx = st.closes.find((c) => c.quoteMint === GLDX);
  ok("the GLDx paper close is in GLDx (a mark, no SOL figure)", paperGldx && paperGldx.live === false && paperGldx.pnlSol === null && paperGldx.quoteSymbol === "GLDx");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hawk-shadow-")), "mixed.jsonl");
  fs.writeFileSync(file, engine.exportShadow());
  const read = readShadowRows({ file });
  const rows = Array.isArray(read) ? read : read.rows;
  ok("the export carries both, and each says its quote", rows.length === 2 && rows.filter((r) => rowQuoteMint(r) === GLDX).length === 1 && rows.filter((r) => rowQuoteMint(r) === WSOL).length === 1);
  const out = [];
  const code = await gradeEntryGates(["--file", file], process.env, (l) => out.push(l));
  const text = out.join("\n");
  ok("the grader prints the SOL block and a separate GLDx block", code === 0 && /1 judged row in Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re graded separately below/.test(text) && text.includes(`── quote ${GLDX}`), text.split("\n").filter((l) => /quote/.test(l)).join(" | "));
}

section("16. CONFIG: THE STOCK LIST IS FENCED, AND THE ARM SENTENCE BINDS IT");
{
  const refusedKey = (quoteMints) => { try { normalizeConfig({ quoteMints }); return null; } catch (error) { return `${error.key}: ${error.message}`; } };
  ok("the default is SOL only: no stock listed, no allowlist handed to the contract", CONFIG_DEFAULTS.quoteMints.length === 0 && laneConfigFor(normalizeConfig({})).quoteMintAllowlist.length === 0);
  ok("a listed stock becomes the contract's allowlist", JSON.stringify(laneConfigFor(normalizeConfig({ quoteMints: [GLDX_ENTRY] })).quoteMintAllowlist) === JSON.stringify([GLDX]));
  for (const [label, list, re] of [
    ["a mint that is not a key", [{ ...GLDX_ENTRY, mint: "GLDx" }], /not a base58 32-byte address/],
    ["wrapped SOL", [{ ...GLDX_ENTRY, mint: WSOL, symbol: "WSOL" }], /wrapped SOL is not a stock quote/],
    ["a day cap under the ticket", [{ ...GLDX_ENTRY, dailyCap: 0.01 }], /dailyCap 0\.01 GLDx is under maxPerTrade/],
    ["a canary above the ticket", [{ ...GLDX_ENTRY, minPerTrade: 0.5 }], /minPerTrade 0\.5 GLDx is above maxPerTrade/],
    ["a zero ticket", [{ ...GLDX_ENTRY, maxPerTrade: 0 }], /maxPerTrade must be a positive number/],
    ["a symbol with a space", [{ ...GLDX_ENTRY, symbol: "GLD x" }], /symbol must be 1 to 12 characters/],
    ["the same mint twice", [GLDX_ENTRY, GLDX_ENTRY], /lists .* twice/],
    [`more than ${MAX_QUOTE_MINTS}`, Array.from({ length: MAX_QUOTE_MINTS + 1 }, () => ({ ...GLDX_ENTRY, mint: Keypair.generate().publicKey.toBase58() })), /at most 8 stock quotes/],
    ["text that is not JSON", "[{mint:", /not valid JSON/],
  ]) {
    const got = refusedKey(list);
    ok(`refused by key quoteMints: ${label}`, got !== null && got.startsWith("quoteMints:") && re.test(got), got?.slice(0, 110));
  }
  const fromText = normalizeConfig({ quoteMints: JSON.stringify([{ mint: GLDX, symbol: "GLDx", maxPerTrade: "0.05", dailyCap: "0.5" }]) }).quoteMints;
  ok("the options page's text form is accepted, numbers coerced, the canary defaulting to the ticket", fromText.length === 1 && fromText[0].maxPerTrade === 0.05 && fromText[0].minPerTrade === 0.05 && Object.isFrozen(fromText[0]));
  const arm = browserArmability({ config: normalizeConfig({ ...CONFIG_DEFAULTS, rpcUrl: "https://x.y", quoteMints: fromText }), wallet: WALLET, hasBridge: true });
  ok("a canary equal to the ticket is warned about by name", arm.warnings.some((w) => w.name === "stock_canary_is_full_ticket" && /GLDx/.test(w.detail)));
  ok("with no stock listed the sentence is the executor's own, byte for byte", browserArmSentence(WALLET, 0.05, 0.5, []) === snipeArmSentence(WALLET, 0.05, 0.5));
  const sentence = browserArmSentence(WALLET, 0.05, 0.5, [GLDX_ENTRY]);
  ok("with GLDx listed it extends that sentence with GLDx's numbers and mint", sentence.startsWith(snipeArmSentence(WALLET, 0.05, 0.5)) && sentence.includes(GLDX) && sentence.includes("(the first at 0.01 GLDx)"), sentence.slice(-120));
  ok("a sentence typed before the list changed does not match after", browserArmSentence(WALLET, 0.05, 0.5, [{ ...GLDX_ENTRY, dailyCap: 1 }]) !== sentence);
  const fm = feeModelFor(normalizeConfig({}), { quoteAtaCreate: true });
  ok("a stock buy's rent is modelled at two account creates, inside the lane's rent cap", fm.rentFeeLamports === 2 * SNIPE_LANE_DEFAULTS.rentFeeLamports && fm.rentFeeLamports <= SNIPE_LANE_DEFAULTS.maxRentLamports && fm.rentFeeLamports >= Number(ATA_RENT + QUOTE_ATA_RENT), `${fm.rentFeeLamports} <= ${SNIPE_LANE_DEFAULTS.maxRentLamports}`);
  ok("a SOL buy's fee model is unchanged", feeModelFor(normalizeConfig({})).rentFeeLamports === SNIPE_LANE_DEFAULTS.rentFeeLamports);
  const shortcuts = KNOWN_STOCK_QUOTES.map((k) => [k.symbol, describeMint(xAccount(k.mint), k.mint)]);
  ok("every Options shortcut is a mint whose own metadata carries that symbol, Token-2022, 8 decimals", shortcuts.length === 3 && shortcuts.every(([sym, d]) => d.metadataSymbol === sym && d.program === TOKEN_2022_PROGRAM && d.decimals === 8), shortcuts.map(([sym, d]) => `${sym}=${d.metadataSymbol}`).join(" "));
  ok("…and SPYx's display multiplier is read, not assumed to be 1", shortcuts.find(([sym]) => sym === "SPYx")[1].scaledUiMultiplier > 1);
}

section("17. THE FILL READER ALONE, AND THE EXACT UNIT CONVERSIONS");
{
  const W = WALLET, M = MINT, fee = 5_000n;
  const bal = (mint, amount, decimals) => ({ mint, owner: W, uiTokenAmount: { amount: String(amount), decimals } });
  const solBuy = { slot: 7, meta: { err: null, fee: Number(fee), preBalances: [2_000_000_000, 0], postBalances: [2_000_000_000 - 50_000_000 - 5_000 - 2_039_280, 2_039_280], preTokenBalances: [], postTokenBalances: [bal(M, 123, 6)] } };
  const f1 = fillFromTransaction(solBuy, { wallet: W, mint: M, side: "buy" });
  assert.deepEqual({ ...f1 }, { side: "buy", qtyRaw: "123", spentLamports: "52044280", feeLamports: "5000", rentLamports: "2039280", quoteInRaw: "50000000", slot: 7 });
  ok("a SOL buy reads exactly as before (the SOL path is unchanged)", true, `quoteIn ${f1.quoteInRaw}`);
  ok("wrapped SOL named as the quote takes the SOL path too", JSON.stringify(fillFromTransaction(solBuy, { wallet: W, mint: M, side: "buy", quoteMint: WSOL, quoteDecimals: 9 })) === JSON.stringify(f1));
  const rentBase = BigInt(XFIX.rentExemptLamports["170"]), rentQuote = QUOTE_ATA_RENT;
  const stockBuy = (over = {}) => ({ slot: 8, meta: { err: null, fee: Number(fee),
    preBalances: [1_000_000_000, 0, 0], postBalances: [1_000_000_000 - Number(fee + rentBase + rentQuote), Number(rentBase), Number(rentQuote)],
    preTokenBalances: [bal(GLDX, 10n * GLDX_UNIT, 8)], postTokenBalances: [bal(M, 4_900_000, 6), bal(GLDX, 10n * GLDX_UNIT - 1_000_000n, 8)], ...over } });
  const f2 = fillFromTransaction(stockBuy(), { wallet: W, mint: M, side: "buy", quoteMint: GLDX, quoteDecimals: 8 });
  ok("a GLDx buy: the input is the GLDx delta, rent is both account creates, and SOL spent is fee plus rent", f2.quoteInRaw === "1000000" && f2.qtyRaw === "4900000" && f2.rentLamports === String(rentBase + rentQuote) && f2.spentLamports === String(fee + rentBase + rentQuote) && f2.quoteMint === GLDX && f2.quoteDecimals === 8, JSON.stringify(f2));
  const throws = (tx, opts) => { try { fillFromTransaction(tx, opts); return null; } catch (error) { return `${error.clause}: ${error.message}`; } };
  const drained = stockBuy(); drained.meta.postBalances[0] -= 1;
  ok("one unexplained lamport on a GLDx buy is refused as malformed", /^malformed: lamports left the wallet beyond fee and rent/.test(throws(drained, { wallet: W, mint: M, side: "buy", quoteMint: GLDX, quoteDecimals: 8 }) ?? ""));
  ok("a GLDx balance entry in the wrong decimals is refused as malformed", /^malformed: .* says 6 decimals, not the 8/.test(throws(stockBuy({ postTokenBalances: [bal(M, 4_900_000, 6), bal(GLDX, 10n * GLDX_UNIT - 1_000_000n, 6)] }), { wallet: W, mint: M, side: "buy", quoteMint: GLDX, quoteDecimals: 8 }) ?? ""));
  ok("a buy that took no GLDx is refused", /took no .* tokens/.test(throws(stockBuy({ postTokenBalances: [bal(M, 4_900_000, 6), bal(GLDX, 10n * GLDX_UNIT, 8)] }), { wallet: W, mint: M, side: "buy", quoteMint: GLDX, quoteDecimals: 8 }) ?? ""));
  const stockSell = { slot: 9, meta: { err: null, fee: Number(fee), preBalances: [900_000_000, Number(rentBase), 0], postBalances: [900_000_000 - Number(fee + rentQuote), Number(rentBase), Number(rentQuote)],
    preTokenBalances: [bal(M, 4_900_000, 6)], postTokenBalances: [bal(GLDX, 1_480_000, 8)] } };
  const f3 = fillFromTransaction(stockSell, { wallet: W, mint: M, side: "sell", quoteMint: GLDX, quoteDecimals: 8 });
  ok("a GLDx sell that re-created the GLDx account: proceeds in GLDx, the rent beside them, not in them", f3.quoteOutRaw === "1480000" && f3.qtyRaw === "4900000" && f3.rentLamports === String(rentQuote) && f3.feeLamports === "5000", JSON.stringify(f3));
  ok("unitsToRaw is exact: 0.05 GLDx is 5,000,000 raw; 0.01 is 1,000,000", unitsToRaw(0.05, 8) === 5_000_000n && unitsToRaw("0.01", 8) === 1_000_000n && unitsToRaw(1e-7, 8) === 10n);
  let fine = null; try { unitsToRaw("0.123456789", 8); } catch (error) { fine = error.message; }
  ok("…and refuses more precision than the mint carries rather than rounding", /more precision than the mint's 8 decimals/.test(fine ?? ""), fine);
  ok("rawToUnits is exact both ways", rawToUnits(5_000_000n, 8) === "0.05" && rawToUnits(-2_500n, 8) === "-0.000025" && rawToUnits(123n, 0) === "123");
}

section("18. AUTOPILOT: THE AUTOPILOT WALLET SIGNS — THE REAL ONE — AND ITS BALANCE IS A CAP");
{
  const mapStore = () => {
    const m = new Map();
    return { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async set(k, v) { m.set(k, structuredClone(v)); }, async remove(k) { m.delete(k); }, dump: () => JSON.stringify([...m]), raw: (k) => m.get(k) };
  };
  const PASS = "the cat keeps its own counsel";
  /** A fresh autopilot wallet: keystore, signer, unlocked for 30 minutes on `clock`. */
  async function autopilotWallet(clock) {
    const storage = mapStore(), session = mapStore();
    const keystore = createKeystore({ storage, session, clock: clock.now });
    const { publicKey } = await keystore.create({ passphrase: PASS });
    const signer = createSessionSigner({ keystore, clock: clock.now });
    return { keystore, signer, storage, session, publicKey };
  }
  const verifies = (bytes, key) => {
    const tx = VersionedTransaction.deserialize(bytes);
    return ed25519.verify(tx.signatures[0], tx.message.serialize(), new PublicKey(key).toBytes());
  };
  const autoConfig = (wallet, over = {}) => armedConfig({ signerMode: "autopilot", liveAck: browserArmSentence(wallet, 0.05, 0.5, [], { autopilot: true }), ...over });
  function autoEngine({ chain, clock, ap, config, phantom = createBridge(), store = memoryStore() }) {
    const lines = [], notes = [];
    const engine = createHawkEngine({
      rpc: chain.rpc, bridge: phantom, sessionSigner: ap.signer, store, clock: clock.now, timers: clock.timers,
      log: (l) => lines.push(l), notify: (n) => notes.push(n), socialsReader: socialsOk, config: { rpcUrl: "https://chain.double", ...config },
    });
    return { engine, lines, notes, phantom, store };
  }
  const need = autopilotBuyNeedLamports(normalizeConfig(armedConfig()));

  const clock = createClock();
  const ap = await autopilotWallet(clock);
  const AUTO = ap.publicKey;
  const chain = createChain({ curve: CURVE_AT_CREATE, now: clock.now, wallet: AUTO, walletLamports: 100_000_000n, enforceRentFloor: true });
  chain.bump(1_500_000_000n);
  const t = autoEngine({ chain, clock, ap, config: autoConfig(AUTO) });
  await t.engine.load();
  await t.engine.refreshSigner();
  let st = t.engine.status();
  ok("locked: the autopilot lane does not arm, and says why", st.executing === false && st.armability.blocking.includes("autopilot_unlocked") && st.signerMode === "autopilot", st.armability.blocking.join(","));
  ok("the autopilot checklist replaces Phantom's: wallet created, unlocked, funded — no console tab item", ["autopilot_wallet_created", "autopilot_unlocked", "autopilot_funded"].every((n) => st.armability.items.some((i) => i.name === n)) && !st.armability.items.some((i) => i.name === "console_page_open" || i.name === "phantom_connected"));
  ok("the autopilot sentence is the executor's, then the stock part, then words that say nothing will ask", st.armability.expectedAck === snipeArmSentence(AUTO, 0.05, 0.5) + AUTOPILOT_ARM_CLAUSE && /without asking me/.test(AUTOPILOT_ARM_CLAUSE), st.armability.expectedAck.slice(-90));
  const phantomSentence = normalizeConfig({ ...autoConfig(AUTO), rpcUrl: "https://x.y", liveAck: snipeArmSentence(AUTO, 0.05, 0.5) });
  ok("a sentence typed for Phantom cannot arm autopilot, even for the same address", browserArmability({ config: phantomSentence, wallet: AUTO, autopilot: { publicKey: AUTO, unlocked: true, expiresAt: clock.now() + 60_000, balanceLamports: 10n ** 9n } }).blocking.includes("live_ack_typed"));
  ok("the warnings say what autopilot changes: no window, and a key in the browser", ["autopilot_no_window", "autopilot_key_in_browser"].every((n) => st.armability.warnings.some((w) => w.name === n)) && /bigger attack surface/.test(st.armability.warnings.find((w) => w.name === "autopilot_key_in_browser").detail));

  await ap.keystore.unlock({ passphrase: PASS, ttlMs: 30 * 60_000 });
  await t.engine.refreshSigner();
  st = t.engine.status();
  ok("unlocked and funded: armed on autopilot, trading from the autopilot wallet", st.executing === true && st.wallet === AUTO && st.autopilot?.unlocked === true && st.autopilot?.balanceLamports === "100000000", `executing ${st.executing}; blocking ${st.armability.blocking.join(",") || "none"}`);
  ok("Phantom's own wallet is still reported apart, for the console tab", st.phantomWallet === WALLET && st.bridgeReady === true);

  t.engine.onLogs({ logs: CREATE_LOGS, signature: "sig18", slot: 446_023_102, err: null, receivedAt: clock.now() });
  await new Promise((r) => setTimeout(r, 30));
  clock.advance(5_000); await t.engine.tick();
  chain.bump(2_000_000_000n);
  clock.advance(5_000);
  await drive(clock, t.engine.tick());
  st = t.engine.status();
  const live = st.open.find((p) => p.live === true);
  ok("after the wait the autopilot wallet bought, and Phantom was asked nothing", live && live.wallet === AUTO && t.phantom.requests.length === 0 && st.counters.signRequests === 1, live ? `qty ${live.qtyRaw} for ${live.entryInputLamports} lamports` : t.lines.slice(0, 4).join(" | "));
  const sentBuy = [...chain.state.sent.values()][0];
  ok("the buy that reached the chain carries an ed25519 signature by the autopilot key over its own message", sentBuy && verifies(sentBuy.bytes, AUTO) && !verifies(sentBuy.bytes, WALLET));
  ok("…with the autopilot wallet as the fee payer", VersionedTransaction.deserialize(sentBuy.bytes).message.staticAccountKeys[0].toBase58() === AUTO);
  ok("it was simulated before it was signed", chain.state.calls.indexOf("sim") < chain.state.calls.indexOf("send"), chain.state.calls.join(" "));
  ok("the user was told after the fact, never asked to approve", t.notes.some((n) => n.kind === "buy" && /autopilot: bought/.test(n.title)) && !t.notes.some((n) => /approve/i.test(n.title)), t.notes.map((n) => n.title).join(" | "));
  ok("the log says who signed", t.lines.some((l) => /ENTERED/.test(l) && /signed by the autopilot wallet/.test(l)));

  const secretB64 = ap.session.raw("coinmarketcat:session-secret")?.secretKey;
  const secret58 = bs58.encode(Buffer.from(secretB64, "base64"));
  const everywhere = [t.lines.join("\n"), JSON.stringify(t.notes), JSON.stringify(t.store.snapshot), JSON.stringify(t.engine.status())].join("\n");
  ok("the key reached no log line, notification, persisted state or status", typeof secretB64 === "string" && secretB64.length > 40 && !everywhere.includes(secretB64) && !everywhere.includes(secret58) && !everywhere.includes(PASS));

  chain.bump(10_000_000_000n);
  clock.advance(1_000);
  await drive(clock, t.engine.tick());
  st = t.engine.status();
  ok("the take sold it, signed by the autopilot wallet, without a window", st.open.length === 0 && st.closes[0]?.live === true && /take/.test(st.closes[0]?.reason) && t.phantom.requests.length === 0, st.closes[0]?.reason);
  const sentSell = [...chain.state.sent.values()][1];
  ok("the sell's signature verifies under the autopilot key", sentSell && verifies(sentSell.bytes, AUTO));
  ok("the realized SOL is the chain's", BigInt(st.closes[0].realizedLamports) > 0n && BigInt(st.closes[0].pnlLamports) > 0n, `pnl ${st.closes[0].pnlSol} SOL`);
  ok("the balance the lane reports is re-read after the trade", st.autopilot.balanceLamports === String(chain.state.walletLamports), `${st.autopilot.balanceLamports} vs chain ${chain.state.walletLamports}`);

  /* THE BALANCE IS A CAP, TWICE. */
  const clock2 = createClock();
  const ap2 = await autopilotWallet(clock2);
  await ap2.keystore.unlock({ passphrase: PASS, ttlMs: 30 * 60_000 });
  const chain2 = createChain({ curve: CURVE_AT_CREATE, now: clock2.now, wallet: ap2.publicKey, walletLamports: need.total - 1n, enforceRentFloor: true });
  chain2.bump(1_500_000_000n);
  const t2 = autoEngine({ chain: chain2, clock: clock2, ap: ap2, config: autoConfig(ap2.publicKey) });
  await t2.engine.load(); await t2.engine.refreshSigner();
  st = t2.engine.status();
  ok(`a wallet one lamport short of a buy's ${need.total} does not arm: autopilot_funded is red`, st.executing === false && st.armability.blocking.join(",") === "autopilot_funded", st.armability.items.find((i) => i.name === "autopilot_funded")?.detail);
  chain2.state.walletLamports = need.total * 3n;
  await t2.engine.refreshSigner();
  ok("funded enough, it arms", t2.engine.status().executing === true, t2.engine.status().armability.blocking.join(","));
  t2.engine.onLogs({ logs: CREATE_LOGS, signature: "sig18b", slot: 446_023_102, err: null, receivedAt: clock2.now() });
  await new Promise((r) => setTimeout(r, 30));
  chain2.bump(2_000_000_000n);
  chain2.state.walletLamports = need.total - 1n;          // spent elsewhere since the last read
  clock2.advance(10_000);
  await drive(clock2, t2.engine.tick());
  ok("a wallet that fell short since the last read is refused at the moment of asking, by name, before anything is signed", t2.lines.some((l) => /autopilot_balance_short/.test(l)) && !chain2.state.calls.includes("send") && t2.engine.status().counters.signRequests === 0, t2.lines.find((l) => /autopilot_balance_short/.test(l))?.slice(0, 160));
  ok("…and the refusal says the budget is the balance", t2.lines.some((l) => /The budget is the balance; nothing was signed/.test(l)));

  /* SWITCHING TO PHANTOM NEVER STRANDS A POSITION; A LOCKED WALLET WAITS AND SAYS SO. */
  const clock3 = createClock();
  const ap3 = await autopilotWallet(clock3);
  await ap3.keystore.unlock({ passphrase: PASS, ttlMs: 30 * 60_000 });
  const chain3 = createChain({ curve: CURVE_AT_CREATE, now: clock3.now, wallet: ap3.publicKey, walletLamports: 100_000_000n, enforceRentFloor: true });
  chain3.bump(1_500_000_000n);
  const t3 = autoEngine({ chain: chain3, clock: clock3, ap: ap3, config: autoConfig(ap3.publicKey) });
  await t3.engine.load(); await t3.engine.refreshSigner();
  t3.engine.onLogs({ logs: CREATE_LOGS, signature: "sig18c", slot: 446_023_102, err: null, receivedAt: clock3.now() });
  await new Promise((r) => setTimeout(r, 30));
  chain3.bump(2_000_000_000n);
  clock3.advance(10_000);
  await drive(clock3, t3.engine.tick());
  ok("bought on autopilot", t3.engine.status().open.some((p) => p.live && p.wallet === ap3.publicKey) && t3.engine.status().autopilotHeld === 1);
  await t3.engine.setConfig({ signerMode: "phantom" });
  ok("switched to Phantom: the lane is no longer armed (the sentence named the autopilot key)", t3.engine.status().executing === false && t3.engine.status().signerMode === "phantom");
  await ap3.keystore.lock();
  await t3.engine.refreshSigner();
  chain3.bump(10_000_000_000n);
  clock3.advance(1_000);
  await drive(clock3, t3.engine.tick());
  ok("locked while holding: the sell waits, nothing is sent, Phantom is not asked in its place", t3.engine.status().open.length === 1 && chain3.state.sent.size === 1 && t3.phantom.requests.length === 0);
  ok("…and the lane says so, loudly", t3.lines.some((l) => /autopilot wallet that holds it is LOCKED/.test(l)) && t3.notes.some((n) => /unlock the autopilot wallet to sell/i.test(n.title)), t3.notes.map((n) => n.title).join(" | "));
  await ap3.keystore.unlock({ passphrase: PASS, ttlMs: 30 * 60_000 });
  await t3.engine.refreshSigner();
  clock3.advance(engine3ReaskMs(t3.engine));
  await drive(clock3, t3.engine.tick());
  const st3 = t3.engine.status();
  ok("unlocked, it sells — signed by the autopilot wallet that holds it, though the lane is now on Phantom", st3.open.length === 0 && st3.closes[0]?.live === true && t3.phantom.requests.length === 0 && verifies([...chain3.state.sent.values()][1].bytes, ap3.publicKey), st3.closes[0]?.reason);

  /* AN UNLOCK THAT RUNS OUT DISARMS WITHOUT A READ. */
  const clock4 = createClock();
  const ap4 = await autopilotWallet(clock4);
  await ap4.keystore.unlock({ passphrase: PASS, ttlMs: 60_000 });
  const chain4 = createChain({ curve: CURVE_AT_CREATE, now: clock4.now, wallet: ap4.publicKey, walletLamports: 100_000_000n });
  const t4 = autoEngine({ chain: chain4, clock: clock4, ap: ap4, config: autoConfig(ap4.publicKey) });
  await t4.engine.load(); await t4.engine.refreshSigner();
  ok("armed inside the unlock", t4.engine.status().executing === true);
  clock4.advance(60_001);
  ok("one millisecond past it, disarmed — judged against the clock, no read needed", t4.engine.status().executing === false && t4.engine.status().armability.blocking.includes("autopilot_unlocked"));
}
function engine3ReaskMs(engine) { return Number(engine.config.sellReaskMs); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
