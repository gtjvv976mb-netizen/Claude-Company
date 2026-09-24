/**
 * THE xSTOCK VENUE: NEW POOLS PAIRED WITH A TOKENISED STOCK, TRADED THROUGH JUPITER.
 *
 * Nothing here touches a network. `fetch` is a router that answers only the four hosts the
 * venue may call (api.jup.ag, api.geckoterminal.com, api.dexscreener.com, datapi.jup.ag)
 * and throws on anything else; the RPC is a chain double. The discovery answers and the
 * Jupiter answers are either the CAPTURED LIVE RESPONSES in fixtures/xstock-pools/ (read
 * 2026-09-24) or scripted in their exact shape. The chain double resolves every lookup
 * table from its own accounts, verifies every ed25519 signature on send, charges the fee
 * the compute budget implies, runs the associated-account creates, and executes Jupiter's
 * route_v2 against a constant-product pool — so a fill the lane books is one the pool's
 * arithmetic produced.
 *
 * What is proved:
 *   1.  config: the venue is OFF by default and observe-only unless armed; its dials are
 *       fenced; the built-in list is the official addresses; with the venue off the arm
 *       sentence is byte-for-byte what it was, and on it names the venue;
 *   2.  the feed parsers on the captured GeckoTerminal and DexScreener pages: the one
 *       xStock pool on the GeckoTerminal page is found (cap / METAx, a pump.fun curve); the
 *       GLDx pairs are classified launch / money pair / stock pair;
 *   3.  the poller: a 429 with retry-after 0 rests the feed a minute, not zero; the rest
 *       doubles; a resting feed is not asked; dedupe; pools older than the horizon are
 *       counted, not handed over;
 *   4.  the Jupiter client: 0.5 requests a second, a background mark skipped rather than
 *       queued, a 429 rests it, TOKEN_NOT_TRADABLE is `no_route`;
 *   5.  the quote check and the transaction check on the LIVE bytes (GLDx → GAYMF and back,
 *       their lookup table): both pass; then every hostile edit of the live transaction —
 *       another source account, another destination, a changed amount, another output
 *       mint, a System transfer, a second signer, an account for a third mint, a priority
 *       fee over budget, an unresolvable lookup table — is refused by name;
 *   6.  observe: the venue off asks nothing of any host; on, every pool found is recorded
 *       with its source and its age, and refused by name at left_to_pumpfun_lane,
 *       no_new_token, notice_stale, mint_refused (the live GAYMF mint's TransferFee),
 *       no_route, stock_not_listed; the one that clears opens a would-have row; nothing
 *       is signed;
 *   7.  armed on Phantom: the wait and the follow-through, then Jupiter's transaction —
 *       checked, simulated, one Phantom window — the fill read from the chain in GLDx, the
 *       canary ticket, the day ledgers; the 1.5x take sells back through Jupiter and the
 *       close is booked in GLDx; a launch nobody followed is never bought;
 *   8.  HOSTILE JUPITER: a transaction that spends from another account, changes the
 *       amount, sends the output elsewhere, drains SOL, adds a signer, swaps a lookup
 *       table, or whose pool drains SOL or plants a delegate in simulation, is refused
 *       BEFORE SIGNING — Phantom is asked nothing and the chain is sent nothing;
 *   9.  budgets: the full ticket once the canary is proven; the stock's day cap; the SOL
 *       day; a wallet short of the stock;
 *   10. autopilot: the real session wallet signs the Jupiter buy, Phantom is asked nothing;
 *   11. the pump.fun lane unchanged: its launch goes through its own gates with the venue
 *       on or off; one mint is never held by both; a held position is still managed when
 *       the venue is switched off.
 */
import fs from "node:fs";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { createHawkEngine, memoryStore } from "./src/lib/engine.mjs";
import {
  CONFIG_DEFAULTS, normalizeConfig, browserArmSentence, browserArmability, snipeArmSentence, XSTOCK_BUILTIN, XSTOCK_SOURCES,
  XSTOCK_ARM_CLAUSE, xstockFocusList, STOCK_FOCUS_CHOICES,
} from "./src/lib/config.mjs";
import {
  parseGeckoTerminalPools, parseDexScreenerPairs, parseJupiterGems, classifyPool, createPoolDiscovery, DISCOVERY_BACKOFF,
} from "./src/lib/xstock-discovery.mjs";
import {
  createJupiterClient, checkQuote, checkSwapTransaction, loadLookupTables, JupiterError, SwapCheckError, JUPITER_PROGRAM,
  JUPITER_EVENT_AUTHORITY, LOOKUP_TABLE_PROGRAM,
} from "./src/lib/jupiter-swap.mjs";
import { XSTOCK_GATES, isPumpfunCurve } from "./src/lib/xstock-lane.mjs";
import { createKeystore, createSessionSigner } from "./src/lib/session-wallet.mjs";
import { SIGN_ERRORS, BridgeError } from "./src/lib/protocol.mjs";
import { associatedTokenAddress, fromBase64, toBase64, ATA_PROGRAM, WSOL } from "./src/lib/tx.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, auditMintAccount } from "./vendor/executor/token2022.mjs";
import { decodeCreateEvent } from "./vendor/executor/snipe-venue-pumpfun.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);

/* ── fixtures ──────────────────────────────────────────────────────────────────────── */
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const XFIX = read("./vendor/executor/fixtures/pumpfun-xstock-quote.json");
const JFIX = read("./fixtures/xstock-pools/jupiter-gldx-swap.json");
const GT = read("./fixtures/xstock-pools/geckoterminal-new-pools.json");
const GT429 = read("./fixtures/xstock-pools/geckoterminal-429.json");
const DS = read("./fixtures/xstock-pools/dexscreener-token-pairs-gldx.json");
const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const SPCXX = "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const T22 = TOKEN_2022_PROGRAM, TK = TOKEN_PROGRAM;
const GLDX_MINT_ACCOUNT = (() => { const a = XFIX.accounts.find((x) => x.address === GLDX); return { owner: a.owner, lamports: a.lamports, data: a.data }; })();
const GAYMF = JFIX.tokenMint;                      // the live TransferFee Token-2022 mint
const GAYMF_MINT_ACCOUNT = { owner: JFIX.mints.token.owner, lamports: JFIX.mints.token.lamports, data: JFIX.mints.token.data };
const RENT = { [TK]: BigInt(XFIX.rentExemptLamports["165"]), [T22]: BigInt(XFIX.rentExemptLamports["170"]) };
const POOL_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const COMPUTE = ComputeBudgetProgram.programId.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();
const ROUTE_V2 = Buffer.from("bb64facc31c4af14", "hex");

const WALLET_KP = Keypair.generate();
const WALLET = WALLET_KP.publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();
const VICTIM = Keypair.generate().publicKey.toBase58();
const key = (k) => new PublicKey(k).toBuffer();
const newKey = () => Keypair.generate().publicKey.toBase58();
const LAMPORTS = 1_000_000_000n;

/* ── account bytes ──────────────────────────────────────────────────────────────────── */
/** A classic SPL mint: no mint authority, no freeze authority, initialized. */
function classicMint({ decimals = 6, supply = 1_000_000_000_000_000n, mintAuthority = null } = {}) {
  const b = Buffer.alloc(82);
  if (mintAuthority) { b.writeUInt32LE(1, 0); key(mintAuthority).copy(b, 4); }
  b.writeBigUInt64LE(supply, 36); b[44] = decimals; b[45] = 1;
  return { owner: TK, lamports: 1_461_600, data: [b.toString("base64"), "base64"] };
}
function tokenAccountBytes({ mint, owner, amount, program, delegate = null }) {
  const b = Buffer.alloc(program === T22 ? 170 : 165);
  key(mint).copy(b, 0); key(owner).copy(b, 32); b.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) { b.writeUInt32LE(1, 72); key(delegate).copy(b, 76); b.writeBigUInt64LE(BigInt(amount), 121); }
  b[108] = 1;
  if (program === T22) { b[165] = 2; b.writeUInt16LE(7, 166); b.writeUInt16LE(0, 168); }   // AccountType::Account, ImmutableOwner
  return b;
}
/** An address lookup table account, in the layout AddressLookupTableAccount.deserialize reads. */
function altBytes(addresses) {
  const b = Buffer.alloc(56 + 32 * addresses.length);
  b.writeUInt32LE(1, 0); b.writeBigUInt64LE(2n ** 64n - 1n, 4); b.writeBigUInt64LE(1n, 12);
  addresses.forEach((a, i) => key(a).copy(b, 56 + 32 * i));
  return b;
}
const altObject = (address, addresses) => new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(altBytes(addresses)) });

/* ── the manual clock ───────────────────────────────────────────────────────────────── */
function createClock(start = 1_790_252_790_000) {
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
    async flush() { for (;;) { const due = timeouts.filter((t) => t.at <= now); if (!due.length) return; for (const t of due) { timeouts.splice(timeouts.indexOf(t), 1); t.fn(); } await new Promise((r) => setImmediate(r)); } },
  };
}
async function drive(clock, promise, { stepMs = 700, maxSteps = 600 } = {}) {
  let done = false, result, error;
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

/* ── a response, the way fetch returns one ──────────────────────────────────────────── */
const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

/* ═══ THE WORLD: a chain, a Jupiter and the feeds, behind one RPC and one fetch ═══════ */
function createWorld({ clock, wallet = WALLET, walletLamports = LAMPORTS, walletStockRaw = 100_000_000n } = {}) {
  const st = {
    lamports: new Map([[wallet, walletLamports]]),
    tokens: new Map(),          // address → { mint, owner, amount, program, delegate, lamports }
    mints: new Map([[GLDX, GLDX_MINT_ACCOUNT], [GAYMF, GAYMF_MINT_ACCOUNT]]),
    decimals: new Map([[GLDX, 8], [GAYMF, 6]]),
    pools: new Map(),           // pool address → { stock, token, stockReserve, tokenReserve, feeBps, vaultStock, vaultToken, authority }
    alts: new Map(),            // address → [addresses]
    extra: new Map(),           // other plain accounts
    sent: new Map(), slot: 450_030_000, blockHeight: 428_070_000, hostilePool: null,
  };
  const programOf = (mint) => (st.mints.get(mint)?.owner ?? TK);
  const ataOf = (owner, mint) => associatedTokenAddress(owner, mint, programOf(mint));
  const walletStockAta = ataOf(wallet, GLDX);
  st.tokens.set(walletStockAta, { mint: GLDX, owner: wallet, amount: walletStockRaw, program: T22, delegate: null, lamports: RENT[T22] });
  const ALT_MAIN = newKey();
  st.alts.set(ALT_MAIN, [JUPITER_EVENT_AUTHORITY]);
  const ALT_TRICK = newKey();
  /* The trick table: on THIS chain it holds a victim's GLDx account; the Jupiter below
     compiles against a copy that says it holds the wallet's own. */
  st.tokens.set(ataOf(VICTIM, GLDX), { mint: GLDX, owner: VICTIM, amount: 500_000_000n, program: T22, delegate: null, lamports: RENT[T22] });
  st.alts.set(ALT_TRICK, [ataOf(VICTIM, GLDX)]);

  const clone = () => ({
    ...st, lamports: new Map(st.lamports), tokens: new Map([...st.tokens].map(([k, v]) => [k, { ...v }])),
    pools: new Map([...st.pools].map(([k, v]) => [k, { ...v }])),
  });
  const accountOf = (address, s = st) => {
    const a = String(address);
    if (s.mints.has(a)) return s.mints.get(a);
    if (s.alts.has(a)) return { owner: LOOKUP_TABLE_PROGRAM, lamports: 1_000_000, data: [altBytes(s.alts.get(a)).toString("base64"), "base64"] };
    if (s.tokens.has(a)) { const t = s.tokens.get(a); return { owner: t.program, lamports: Number(t.lamports), data: [tokenAccountBytes(t).toString("base64"), "base64"] }; }
    if (s.lamports.has(a)) return { owner: SYSTEM, lamports: Number(s.lamports.get(a)), data: ["", "base64"] };
    if (s.pools.has(a)) return { owner: POOL_PROGRAM, lamports: 2_000_000, data: [Buffer.alloc(64).toString("base64"), "base64"] };
    if (s.extra.has(a)) return s.extra.get(a);
    return null;
  };
  const cpmm = (pool, inMint, amountIn) => {
    const inNet = BigInt(amountIn) * BigInt(10_000 - pool.feeBps) / 10_000n;
    const [rin, rout] = inMint === pool.stock ? [pool.stockReserve, pool.tokenReserve] : [pool.tokenReserve, pool.stockReserve];
    return rout * inNet / (rin + inNet);
  };
  const poolFor = (a, b) => [...st.pools.entries()].find(([, p]) => (p.stock === a && p.token === b) || (p.stock === b && p.token === a)) ?? null;

  /** Execute a v0 transaction against `s`. The lookup tables are resolved from `s`. */
  function execute(bytes, s, { verify }) {
    const tx = VersionedTransaction.deserialize(bytes);
    const msg = tx.message;
    const tables = (msg.addressTableLookups ?? []).map((l) => {
      const addrs = s.alts.get(l.accountKey.toBase58());
      if (!addrs) throw new Error(`lookup table ${l.accountKey.toBase58()} not found`);
      return altObject(l.accountKey.toBase58(), addrs);
    });
    const m = TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables });
    const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
    const nSig = msg.header.numRequiredSignatures;
    const signers = new Set(staticKeys.slice(0, nSig));
    if (verify) for (let i = 0; i < nSig; i++)
      if (!ed25519.verify(tx.signatures[i], msg.serialize(), new PublicKey(staticKeys[i]).toBytes())) throw new Error(`SignatureFailure: ${staticKeys[i]}`);
    let limit = 200_000n, price = 0n;
    for (const ix of m.instructions) if (ix.programId.toBase58() === COMPUTE) {
      const d = Buffer.from(ix.data);
      if (d[0] === 2) limit = BigInt(d.readUInt32LE(1));
      if (d[0] === 3) price = d.readBigUInt64LE(1);
    }
    const fee = 5_000n * BigInt(nSig) + (price * limit + 999_999n) / 1_000_000n;
    const payer = staticKeys[0];
    const bal = (k) => s.lamports.get(k) ?? 0n;
    if (bal(payer) < fee) throw new Error("InsufficientFundsForFee");
    s.lamports.set(payer, bal(payer) - fee);
    const created = [];
    for (const ix of m.instructions) {
      const program = ix.programId.toBase58();
      const k = ix.keys.map((x) => x.pubkey.toBase58());
      if (program === COMPUTE) continue;
      if (program === ATA_PROGRAM) {
        const [payerKey, ata, owner, mint, , tokenProgram] = k;
        if (s.tokens.has(ata)) continue;
        if (associatedTokenAddress(owner, mint, tokenProgram) !== ata) throw new Error("the ATA address does not derive");
        if (tokenProgram !== programOf(mint)) throw new Error(`IncorrectProgramId for ${mint}`);
        const rent = RENT[tokenProgram];
        if (bal(payerKey) < rent) throw new Error("insufficient lamports for rent");
        s.lamports.set(payerKey, bal(payerKey) - rent);
        s.tokens.set(ata, { mint, owner, amount: 0n, program: tokenProgram, delegate: null, lamports: rent });
        created.push(ata);
        continue;
      }
      if (program === SYSTEM) {
        const d = Buffer.from(ix.data);
        if (d.readUInt32LE(0) !== 2) throw new Error("unsupported system instruction");
        const amount = d.readBigUInt64LE(4);
        if (!signers.has(k[0])) throw new Error("MissingRequiredSignature");
        if (bal(k[0]) < amount) throw new Error("insufficient lamports");
        s.lamports.set(k[0], bal(k[0]) - amount); s.lamports.set(k[1], bal(k[1]) + amount);
        continue;
      }
      if (program === JUPITER_PROGRAM) {
        const d = Buffer.from(ix.data);
        const amount = d.readBigUInt64LE(8), quotedOut = d.readBigUInt64LE(16), slip = d.readUInt16LE(24);
        const [authority, srcAta, dstAta, srcMint, dstMint] = k;
        if (!signers.has(authority)) throw new Error("the route's authority did not sign");
        const src = s.tokens.get(srcAta), dst = s.tokens.get(dstAta);
        if (!src || src.mint !== srcMint) throw new Error("the source account is not a token account of the input mint");
        if (src.owner !== authority && src.delegate !== authority) throw new Error("OwnerMismatch: the authority does not own the source account");
        if (!dst || dst.mint !== dstMint) throw new Error("the destination is not a token account of the output mint");
        if (src.amount < amount) throw new Error("InsufficientFunds: the source account holds too little");
        const poolAddress = k[12];
        const pool = s.pools.get(poolAddress);
        if (!pool) throw new Error(`no pool at ${poolAddress}`);
        const out = cpmm(pool, srcMint, amount);
        const floor = quotedOut * BigInt(10_000 - slip) / 10_000n;
        if (out < floor) throw new Error(`SlippageToleranceExceeded: ${out} < ${floor}`);
        src.amount -= amount; dst.amount += out;
        if (srcMint === pool.stock) { pool.stockReserve += amount; pool.tokenReserve -= out; } else { pool.tokenReserve += amount; pool.stockReserve -= out; }
        /* The hostile pools: code the decode cannot see, doing what only a simulation shows. */
        if (s.hostilePool === "drain_sol") s.lamports.set(authority, bal(authority) - 50_000_000n);
        if (s.hostilePool === "delegate") src.delegate = ATTACKER;
        continue;
      }
      throw new Error(`the chain double does not run ${program}`);
    }
    return { fee, created, payer };
  }
  const walletTokenAccounts = (s, owner) => [...s.tokens.entries()].filter(([, t]) => t.owner === owner).map(([a]) => a);

  const rpc = {
    url: "https://chain.double",
    calls: [],
    async getMultipleAccounts(addresses) { rpc.calls.push(["gma", addresses.map(String)]); return { slot: st.slot, accounts: addresses.map((a) => accountOf(a)) }; },
    async getBalance(a) { return st.lamports.get(String(a)) ?? 0n; },
    async getTokenAccountBalance(a) { return st.tokens.get(String(a))?.amount ?? 0n; },
    async getLatestBlockhash() { return { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: st.blockHeight + 150 }; },
    async getBlockHeight() { return st.blockHeight; },
    async simulateTransaction(txBase64, { addresses = [] } = {}) {
      rpc.calls.push(["sim"]);
      const s = clone();
      try {
        execute(fromBase64(txBase64), s, { verify: false });
        return { err: null, logs: [], unitsConsumed: 180_000, accounts: addresses.map((a) => accountOf(a, s)) };
      } catch (error) { return { err: { InstructionError: [3, { Custom: 1 }] }, logs: [`Program log: ${error.message}`], accounts: null }; }
    },
    async sendTransaction(txBase64) {
      rpc.calls.push(["send"]);
      const bytes = fromBase64(txBase64);
      const tx = VersionedTransaction.deserialize(bytes);
      const sig = bs58.encode(tx.signatures[0]);
      if (st.sent.has(sig)) return sig;
      const payer = tx.message.staticAccountKeys[0].toBase58();
      const accountsBefore = [payer, ...walletTokenAccounts(st, payer)];
      const pre = accountsBefore.map((a) => ({ a, lamports: a === payer ? st.lamports.get(a) ?? 0n : st.tokens.get(a)?.lamports ?? 0n, token: st.tokens.get(a) ? { ...st.tokens.get(a) } : null }));
      let err = null, effects = null;
      const s = clone();
      try { effects = execute(bytes, s, { verify: true }); Object.assign(st, { lamports: s.lamports, tokens: s.tokens, pools: s.pools }); }
      catch (error) { err = { InstructionError: [3, { Custom: 1 }], message: error.message }; }
      const accountsAfter = [...new Set([...accountsBefore, ...walletTokenAccounts(st, payer)])];
      const lam = (a) => (a === payer ? st.lamports.get(a) ?? 0n : st.tokens.get(a)?.lamports ?? 0n);
      const preOf = (a) => pre.find((p) => p.a === a);
      const tb = (list) => list.filter((x) => x.token).map((x) => ({ accountIndex: x.i, mint: x.token.mint, owner: x.token.owner, uiTokenAmount: { amount: x.token.amount.toString(), decimals: st.decimals.get(x.token.mint) ?? 6 } }));
      const meta = {
        err, fee: effects ? Number(effects.fee) : 5_000,
        preBalances: accountsAfter.map((a) => Number(preOf(a)?.lamports ?? 0n)),
        postBalances: accountsAfter.map((a) => Number(err ? preOf(a)?.lamports ?? 0n : lam(a))),
        preTokenBalances: tb(accountsAfter.map((a, i) => ({ i, token: preOf(a)?.token ?? null }))),
        postTokenBalances: tb(accountsAfter.map((a, i) => ({ i, token: err ? preOf(a)?.token ?? null : st.tokens.get(a) ? { ...st.tokens.get(a) } : null }))),
      };
      st.sent.set(sig, { err, meta, slot: ++st.slot, bytes });
      return sig;
    },
    async getSignatureStatus(sig) { const s = st.sent.get(sig); return s ? { err: s.err, confirmationStatus: "confirmed" } : null; },
    async getTransaction(sig) { const s = st.sent.get(sig); return s && !st.hideTransactions ? { slot: s.slot, meta: s.meta } : null; },
  };

  /* ── Jupiter, scripted in the shape the live API answered ────────────────────────── */
  const jup = { mode: null, quoteMode: null, requests: [] };
  function quote(q) {
    const found = poolFor(q.inputMint, q.outputMint);
    if (!found) return response(400, { error: `The token ${q.outputMint} is not tradable`, errorCode: "TOKEN_NOT_TRADABLE" });
    const [address, pool] = found;
    const out = cpmm(pool, q.inputMint, BigInt(q.amount));
    const s = Number(q.slippageBps);
    const threshold = (out * BigInt(10_000 - s) + 9_999n) / 10_000n;     // /swap/v1 rounds up (fixtures/xstock-pools)
    const routePlan = jup.quoteMode === "multi_hop"
      ? [{ swapInfo: { ammKey: newKey(), label: "Hop A", inputMint: q.inputMint, outputMint: USDC, inAmount: q.amount, outAmount: "1" }, percent: null, bps: 10_000 },
        { swapInfo: { ammKey: address, label: "Hop B", inputMint: USDC, outputMint: q.outputMint, inAmount: "1", outAmount: out.toString() }, percent: null, bps: 10_000 }]
      : [{ swapInfo: { ammKey: address, label: "Scripted CPMM", inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.amount, outAmount: out.toString() }, percent: null, bps: 10_000 }];
    return response(200, {
      inputMint: q.inputMint, inAmount: q.amount, outputMint: q.outputMint, outAmount: out.toString(), otherAmountThreshold: threshold.toString(),
      swapMode: q.swapMode, slippageBps: s, platformFee: null, priceImpactPct: "0.004", routePlan, contextSlot: st.slot, instructionVersion: "V2",
    });
  }
  function swap(body) {
    const q = body.quoteResponse;
    const user = body.userPublicKey;
    const found = poolFor(q.inputMint, q.outputMint);
    if (!found) return response(400, { error: "no route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" });
    const [poolAddress, pool] = found;
    const mode = jup.mode;
    let inMint = q.inputMint, outMint = q.outputMint;
    if (mode === "wrong_output") outMint = GAYMF;
    const inProg = programOf(inMint), outProg = programOf(outMint);
    let srcAta = associatedTokenAddress(user, inMint, inProg);
    const dstAta = mode === "other_destination" ? associatedTokenAddress(ATTACKER, outMint, outProg) : associatedTokenAddress(user, outMint, outProg);
    if (mode === "other_source") srcAta = associatedTokenAddress(VICTIM, inMint, inProg);
    const limit = 1_400_000;
    let price = Math.floor(Number(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports) * 1e6 / limit);
    if (mode === "priority") price *= 10;
    const data = Buffer.alloc(8 + 8 + 8 + 2 + 2 + 2 + 4 + 5);
    ROUTE_V2.copy(data, 0);
    data.writeBigUInt64LE(BigInt(q.inAmount) + (mode === "amount" ? 1n : 0n), 8);
    data.writeBigUInt64LE(BigInt(q.outAmount), 16);
    data.writeUInt16LE(Number(q.slippageBps), 24);
    data.writeUInt32LE(1, 30); Buffer.from([0x2e, 0x10, 0x27, 0x00, 0x01]).copy(data, 34);
    const [vaultIn, vaultOut] = inMint === pool.stock ? [pool.vaultStock, pool.vaultToken] : [pool.vaultToken, pool.vaultStock];
    const meta = (k, s, w) => ({ pubkey: new PublicKey(k), isSigner: s, isWritable: w });
    const route = new TransactionInstruction({
      programId: new PublicKey(JUPITER_PROGRAM), data,
      keys: [meta(user, true, true), meta(srcAta, false, true), meta(dstAta, false, true), meta(inMint, false, false), meta(outMint, false, false),
        meta(inProg, false, false), meta(outProg, false, false), meta(JUPITER_PROGRAM, false, false), meta(JUPITER_EVENT_AUTHORITY, false, false),
        meta(JUPITER_PROGRAM, false, false), meta(POOL_PROGRAM, false, false), meta(user, true, true), meta(poolAddress, false, true),
        meta(vaultIn, false, true), meta(vaultOut, false, true), meta(srcAta, false, true), meta(dstAta, false, true)],
    });
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [meta(user, true, true), meta(dstAta, false, true), meta(mode === "other_destination" ? ATTACKER : user, false, false), meta(outMint, false, false), meta(SYSTEM, false, false), meta(outProg, false, false)] }),
      ...(mode === "extra_ata" ? [new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [meta(user, true, true), meta(associatedTokenAddress(user, USDC, TK), false, true), meta(user, false, false), meta(USDC, false, false), meta(SYSTEM, false, false), meta(TK, false, false)] })] : []),
      route,
      ...(mode === "drain" ? [SystemProgram.transfer({ fromPubkey: new PublicKey(user), toPubkey: new PublicKey(ATTACKER), lamports: 100_000_000 })] : []),
    ];
    const payerKey = new PublicKey(mode === "fee_payer" ? ATTACKER : user);
    let tables = [altObject(ALT_MAIN, st.alts.get(ALT_MAIN))];
    if (mode === "alt_swap") tables = [altObject(ALT_TRICK, [srcAta])];          // Jupiter's copy says the wallet's own account
    if (mode === "alt_missing") tables = [altObject(newKey(), [JUPITER_EVENT_AUTHORITY])];
    const message = new TransactionMessage({ payerKey, recentBlockhash: bs58.encode(Buffer.alloc(32, 9)), instructions: ixs }).compileToV0Message(tables);
    const tx = new VersionedTransaction(message);
    return response(200, { swapTransaction: toBase64(tx.serialize()), lastValidBlockHeight: st.blockHeight + 150, prioritizationFeeLamports: Math.ceil(price * limit / 1e6), computeUnitLimit: limit });
  }

  /* ── the feeds ───────────────────────────────────────────────────────────────────── */
  const feeds = { gecko: [], dexExtra: [], gems: [], asked: [] };
  function dexPairs(mint) {
    const pairs = [];
    for (const [address, p] of st.pools) {
      if (p.stock !== mint && p.token !== mint) continue;
      const stockSym = p.stockSymbol ?? "GLDx";
      const tokenFirst = p.stockSide !== "base";
      pairs.push({ chainId: "solana", dexId: p.dex, labels: p.labels ?? [], pairAddress: address,
        baseToken: tokenFirst ? { address: p.token, symbol: p.symbol } : { address: p.stock, symbol: stockSym },
        quoteToken: tokenFirst ? { address: p.stock, symbol: stockSym } : { address: p.token, symbol: p.symbol },
        pairCreatedAt: p.createdAtMs, liquidity: { usd: 5_000 } });
    }
    return [...pairs, ...feeds.dexExtra.filter((x) => x.baseToken.address === mint || x.quoteToken.address === mint)];
  }
  const fetched = [];
  const wire = [];              // every URL and body that left, verbatim, for the leak scan
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    fetched.push(`${init.method ?? "GET"} ${u.host}${u.pathname}`);
    wire.push(`${url}\n${init.body ?? ""}`);
    if (u.host === "api.jup.ag" && u.pathname === "/swap/v1/quote") { jup.requests.push(["quote", Object.fromEntries(u.searchParams)]); return quote(Object.fromEntries(u.searchParams)); }
    if (u.host === "api.jup.ag" && u.pathname === "/swap/v1/swap") { const body = JSON.parse(init.body); jup.requests.push(["swap", body]); return swap(body); }
    if (u.host === "api.dexscreener.com" && u.pathname.startsWith("/token-pairs/v1/solana/")) return response(200, dexPairs(u.pathname.split("/").pop()));
    if (u.host === "api.geckoterminal.com") { const next = feeds.gecko.shift(); return next ?? response(200, { data: [], included: [] }); }
    if (u.host === "datapi.jup.ag") return response(200, { recent: { pools: feeds.gems } });
    throw new Error(`the test network refuses ${u.host}: nothing here may leave the machine`);
  }

  /** A pool pairing `token` with the stock, created `agoMs` before now. */
  function addPool({ token = newKey(), mintAccount = classicMint(), decimals = 6, symbol = "CAT", stock = GLDX, stockReserve = 5_000_000_000n, tokenReserve = 50_000_000_000_000n,
    agoMs = 20_000, dex = "raydium", labels = ["CPMM"], feeBps = 25, stockSide = "quote", stockSymbol = "GLDx", listMint = true } = {}) {
    const address = newKey(), authority = newKey();
    if (listMint) { st.mints.set(token, mintAccount); st.decimals.set(token, decimals); }
    const vaultStock = newKey(), vaultToken = newKey();
    st.tokens.set(vaultStock, { mint: stock, owner: authority, amount: stockReserve, program: programOf(stock), delegate: null, lamports: 2_000_000n });
    st.tokens.set(vaultToken, { mint: token, owner: authority, amount: tokenReserve, program: programOf(token), delegate: null, lamports: 2_000_000n });
    st.pools.set(address, { stock, token, stockReserve, tokenReserve, feeBps, vaultStock, vaultToken, authority, dex, labels, symbol, stockSide, stockSymbol, createdAtMs: clock.now() - agoMs });
    st.alts.set(ALT_MAIN, [...st.alts.get(ALT_MAIN), address, vaultStock, vaultToken]);
    return { token, pool: address };
  }
  /** Buyers arrive (factor > 1) or leave (< 1): the stock side of the pool scales. */
  function move(pool, factorPct) { const p = st.pools.get(pool); p.stockReserve = p.stockReserve * BigInt(factorPct) / 100n; }
  return { st, rpc, jup, feeds, fetched, wire, fetchImpl, addPool, move, walletStockAta, ataOf, ALT_MAIN, ALT_TRICK };
}

/* ── the wallet double: Phantom ─────────────────────────────────────────────────────── */
function createBridge({ wallet = WALLET, keypair = WALLET_KP } = {}) {
  const b = {
    requests: [], mode: "approve",
    isReady: () => true, wallet: () => wallet,
    async signTransaction({ txBase64, purpose, mint, summary }) {
      b.requests.push({ purpose, mint, summary, txBase64 });
      if (b.mode === "reject") throw new BridgeError(SIGN_ERRORS.REJECTED, "User rejected the request");
      const tx = VersionedTransaction.deserialize(fromBase64(txBase64));
      tx.sign([keypair]);
      return { signedBase64: toBase64(tx.serialize()) };
    },
  };
  return b;
}

const STOCKS = [{ mint: GLDX, symbol: "GLDx", maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.2 }];
const venueConfig = (over = {}) => ({
  rpcUrl: "https://chain.double", lane: "observe", quoteMints: STOCKS, xstockVenue: true, xstockSources: ["dexscreener"],
  maxSolPerTrade: 0.05, dailySolCap: 0.5, stopFrac: 0.5, entryWaitMs: 10_000, entryFollowThroughX: 1.0, forwardIntervalMs: 5_000, forwardSamples: 24, ...over,
});
const armedConfig = (over = {}) => {
  const cfg = venueConfig({ lane: "execute", ...over });
  return { ...cfg, liveAck: browserArmSentence(WALLET, cfg.maxSolPerTrade, cfg.dailySolCap, normalizeConfig({ ...CONFIG_DEFAULTS, ...cfg, liveAck: "" }).quoteMints, { xstockVenue: cfg.xstockVenue === true }) };
};
function makeEngine({ world, clock, config, bridge = createBridge(), sessionSigner = null, store = memoryStore() }) {
  const lines = [], notes = [];
  const engine = createHawkEngine({
    rpc: world.rpc, bridge, sessionSigner, store, clock: clock.now, timers: clock.timers, fetchImpl: world.fetchImpl,
    log: (l) => lines.push(l), notify: (n) => notes.push(n), socialsReader: async () => ({ ok: true, socials: { any: true } }), config,
  });
  return { engine, lines, notes, bridge };
}
const cand = (engine, pool) => engine.status().xstock.candidates.find((c) => c.pool === pool);

/* ═══════════════════════════════════════════════════════════════════════════════════ */

section("1. CONFIG: OFF BY DEFAULT, FENCED, AND NAMED IN THE ARM SENTENCE WHEN ON");
{
  const d = normalizeConfig(CONFIG_DEFAULTS);
  ok("the xStock venue is off by default, and the lane itself starts off", d.xstockVenue === false && d.lane === "off");
  ok("the default feeds are the two documented ones; the undocumented one is opt-in", JSON.stringify(d.xstockSources) === JSON.stringify(["geckoterminal", "dexscreener"]) && XSTOCK_SOURCES.includes("jupiter-gems"));
  ok("the dials default to a 30 s poll, a 5 min age bound, the executor's 300 bps slippage, two marked rows", d.xstockPollMs === 30_000 && d.xstockMaxPoolAgeMs === 300_000 && d.xstockSlippageBps === 300 && d.xstockMaxOpen === 2);
  ok("feeds arrive as text from a form and are split and checked", JSON.stringify(normalizeConfig({ ...CONFIG_DEFAULTS, xstockSources: "dexscreener, jupiter-gems" }).xstockSources) === JSON.stringify(["dexscreener", "jupiter-gems"]));
  const refused = (over, key) => { try { normalizeConfig({ ...CONFIG_DEFAULTS, ...over }); return false; } catch (e) { return e.key === key; } };
  ok("an unknown feed is refused by name", refused({ xstockSources: "birdeye" }, "xstockSources"));
  ok("the venue on with no feed is refused", refused({ xstockVenue: true, xstockSources: "" }, "xstockSources"));
  ok("a slippage cap over 1000 bps is refused", refused({ xstockSlippageBps: 5_000 }, "xstockSlippageBps"));
  ok("a poll faster than 15 s is refused", refused({ xstockPollMs: 1_000 }, "xstockPollMs"));
  ok("more than five marked rows is refused (each mark is a Jupiter request)", refused({ xstockMaxOpen: 9 }, "xstockMaxOpen"));
  ok("the built-in list is fifteen official xStock addresses, each starting Xs", XSTOCK_BUILTIN.length === 15 && XSTOCK_BUILTIN.every((b) => b.mint.startsWith("Xs") && /xstocks\.com/.test(b.source)));
  ok("…and agrees with every stock the setup page offers", STOCK_FOCUS_CHOICES.every((c) => XSTOCK_BUILTIN.some((b) => b.mint === c.mint && b.symbol === c.symbol)));
  ok("…including METAx, whose address GeckoTerminal's own page carried", XSTOCK_BUILTIN.some((b) => b.symbol === "METAx" && b.mint === "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"));
  ok("the focus list is the listed stocks when any is listed", JSON.stringify(xstockFocusList(normalizeConfig({ ...CONFIG_DEFAULTS, quoteMints: STOCKS })).map((f) => [f.symbol, f.listed])) === JSON.stringify([["GLDx", true]]));
  ok("…and the built-in list, unlisted, when none is", xstockFocusList(d).length === 15 && xstockFocusList(d).every((f) => f.listed === false));
  const w = Keypair.generate().publicKey.toBase58();
  ok("with the venue off the arm sentence is byte-for-byte the executor's", browserArmSentence(w, 0.05, 0.5, [], { xstockVenue: false }) === snipeArmSentence(w, 0.05, 0.5));
  ok("with it on the sentence names the venue, so a sentence typed before does not arm it", browserArmSentence(w, 0.05, 0.5, STOCKS, { xstockVenue: true }).endsWith(XSTOCK_ARM_CLAUSE) && /through Jupiter/.test(XSTOCK_ARM_CLAUSE));
  const cfgOn = normalizeConfig({ ...CONFIG_DEFAULTS, ...venueConfig({ lane: "execute", liveAck: browserArmSentence(w, 0.05, 0.5, normalizeConfig({ ...CONFIG_DEFAULTS, quoteMints: STOCKS }).quoteMints) }) });
  const arm = browserArmability({ config: cfgOn, wallet: w, hasBridge: true });
  ok("a sentence typed without the venue does not arm a lane with the venue on", arm.blocking.includes("live_ack_typed"), arm.blocking.join(","));
  ok("the checklist warns, in words, what is unmeasured and who builds the transaction", ["xstock_venue_unmeasured", "xstock_venue_pays_in_stock", "xstock_venue_jupiter_builds"].every((n) => arm.warnings.some((x) => x.name === n)) && /Nothing about new pools/.test(arm.warnings.find((x) => x.name === "xstock_venue_unmeasured").detail));
  ok("the gate list is ordered and complete", XSTOCK_GATES.length === 28 && new Set(XSTOCK_GATES).size === 28 && XSTOCK_GATES[0] === "lane_off" && XSTOCK_GATES.indexOf("mint_refused") < XSTOCK_GATES.indexOf("no_route") && XSTOCK_GATES.indexOf("no_route") < XSTOCK_GATES.indexOf("transaction_refused"));
}

section("2. THE FEED PARSERS, ON THE CAPTURED LIVE PAGES");
{
  const gt = parseGeckoTerminalPools(GT.response);
  ok("the GeckoTerminal page parses to one pool shape (one pool was trimmed from the capture)", gt.length === GT.response.data.length && GT.removed === 1 && gt.every((p) => p.pool && p.baseMint && p.quoteMint && Number.isFinite(p.createdAtMs)), `${gt.length} pools`);
  const builtin = xstockFocusList(normalizeConfig(CONFIG_DEFAULTS));
  const hits = gt.map((p) => ({ p, k: classifyPool(p, builtin) })).filter((x) => x.k);
  ok("exactly one pool on the page pairs with an xStock: cap / METAx", hits.length === 1 && hits[0].k.stockSymbol === "METAx" && hits[0].k.stockSide === "quote" && hits[0].k.kind === "launch", hits.map((h) => h.p.name).join(", "));
  ok("…and it is a pump.fun curve, which this venue leaves to the pump.fun lane", hits[0].p.dex === "pump-fun" && isPumpfunCurve(hits[0].p.dex));
  ok("its token symbol came from the page's included tokens", hits[0].k.tokenSymbol === "cap");
  const ds = parseDexScreenerPairs(DS.response);
  ok("the DexScreener page for GLDx parses to its 30 Solana pairs", ds.length === 30 && ds.every((p) => p.dex && p.pool), `${ds.length}`);
  const focus = [{ mint: GLDX, symbol: "GLDx", listed: true }];
  const kinds = Object.fromEntries(ds.map((p) => [p.name, classifyPool(p, focus)?.kind]));
  ok("GAYMF / GLDx is a launch, GLDx as its quote", kinds["GAYMF / GLDx"] === "launch" && classifyPool(ds.find((p) => p.name === "GAYMF / GLDx"), focus).tokenMint === GAYMF);
  ok("GLDx / USDC and GLDx / SOL are markets in the stock, not launches", kinds["GLDx / USDC"] === "money_pair" && kinds["GLDx / SOL"] === "money_pair");
  ok("GLDx / SPCXx is two stocks, not a launch", kinds["GLDx / SPCXx"] === "stock_pair");
  ok("BATO / GLDx, the newest, is a pump.fun curve", ds.find((p) => p.name === "BATO / GLDx")?.dex === "pumpfun" && isPumpfunCurve("pumpfun"));
  ok("…while graduated pump pools are ordinary pools here", !isPumpfunCurve("pumpswap") && !isPumpfunCurve("pumpfun-amm"));
  const gems = parseJupiterGems({ recent: { pools: [{ id: "EnKnQJfvmbexsTHGh9e24bpnAfGT7iLejcJVm2aqoSNa", type: "stonkfun", quoteAsset: SPCXX, createdAt: "2026-09-24T09:04:35Z", baseAsset: { id: newKey(), symbol: "MOONINU" } }] } });
  ok("the gems feed's shape (quote mint beside the pool) parses too", gems.length === 1 && gems[0].quoteMint === SPCXX && gems[0].dex === "stonkfun" && gems[0].createdAtMs === Date.parse("2026-09-24T09:04:35Z"));
  let threw = null; try { parseGeckoTerminalPools(GT429.body); } catch (e) { threw = e; }
  ok("a 429 body is not a page: the parser refuses it", /without a data list/.test(threw?.message ?? ""));
}

section("3. THE POLLER: BACKOFF, DEDUPE, THE HORIZON");
{
  let now = DS.capturedAtMs;
  const asked = [];
  let geckoQueue = [response(429, GT429.body, GT429.headers), response(200, GT.response)];
  const fetchImpl = async (url) => {
    const u = new URL(url); asked.push(u.host);
    if (u.host === "api.geckoterminal.com") return geckoQueue.shift() ?? response(503, "down");
    if (u.host === "api.dexscreener.com") return response(200, DS.response);
    throw new Error(`refused ${u.host}`);
  };
  const disco = createPoolDiscovery({ fetchImpl, clock: () => now, timers: { setTimeout: () => 0, clearTimeout: () => {} },
    sources: () => ["geckoterminal", "dexscreener"], focus: () => [{ mint: GLDX, symbol: "GLDx", listed: true }, { mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", symbol: "METAx", listed: false }], horizonMs: () => 600_000 });
  const first = await disco.poll();
  const g = disco.status().feeds.find((f) => f.id === "geckoterminal");
  ok("a 429 with retry-after 0 rests the feed a minute, not zero seconds", g.rateLimited === 1 && g.backoffUntil - now === DISCOVERY_BACKOFF.rateLimitedMs, `${g.backoffUntil - now} ms`);
  ok("DexScreener answered for both watched stocks", asked.filter((h) => h === "api.dexscreener.com").length === 2);
  ok("only the pools inside the horizon are handed over: BATO / GLDx, minutes old", first.length === 1 && first[0].baseSymbol === "BATO" && first[0].sources[0] === "dexscreener" && first[0].ageAtFirstSightMs < 600_000, first.map((c) => `${c.name} ${Math.round(c.ageAtFirstSightMs / 1000)}s`).join(", "));
  ok("the other 29 were seen and counted, not handed over", disco.status().olderThanHorizon === 29, `${disco.status().olderThanHorizon}`);
  ok("every candidate carries its source, its first sight and its age", first[0].firstSeenAt === now && Number.isFinite(first[0].ageAtFirstSightMs) && first[0].classification.kind === "launch");
  now += 10_000;
  const beforeAsk = asked.length;
  const second = await disco.poll();
  ok("a resting feed is not asked again", asked.slice(beforeAsk).every((h) => h !== "api.geckoterminal.com"));
  ok("the same pool is never handed over twice", second.length === 0);
  now += DISCOVERY_BACKOFF.rateLimitedMs + 60_000;                   // past the rest, and past the METAx pool's creation (12:27:42Z)
  const third = await disco.poll();
  ok("after the rest the feed is asked again, and its METAx pool is found", third.length === 1 && third[0].classification.stockSymbol === "METAx" && third[0].sources[0] === "geckoterminal", third.map((c) => c.name).join(","));
  now += 1_000;
  geckoQueue = [response(503, "down")];
  await disco.poll();
  const g2 = disco.status().feeds.find((f) => f.id === "geckoterminal");
  ok("a 5xx rests the feed on the error floor", g2.errors === 1 && g2.backoffUntil - now === DISCOVERY_BACKOFF.errorMs, `${g2.backoffUntil - now}`);
  now += DISCOVERY_BACKOFF.errorMs;
  geckoQueue = [response(503, "down")];
  await disco.poll();
  const g3 = disco.status().feeds.find((f) => f.id === "geckoterminal");
  ok("a second failure doubles the rest", g3.backoffUntil - now === 2 * DISCOVERY_BACKOFF.errorMs, `${g3.backoffUntil - now}`);
  ok("nothing but the two feeds was asked", asked.every((h) => h === "api.geckoterminal.com" || h === "api.dexscreener.com"));
}

section("4. THE JUPITER CLIENT: HALF A REQUEST A SECOND, AND NAMED FAILURES");
{
  const clock = createClock();
  const hits = [];
  let answer = () => response(200, JFIX.quoteBuy);
  const client = createJupiterClient({ fetchImpl: async (url) => { hits.push([clock.now(), new URL(url).pathname]); return answer(); }, clock: clock.now, sleep: (ms) => new Promise((r) => clock.timers.setTimeout(r, ms)), timers: clock.timers });
  const args = { inputMint: GLDX, outputMint: GAYMF, amountRaw: 1_000_000n, slippageBps: 300 };
  await drive(clock, (async () => { await client.quote(args); await client.quote(args); })());
  ok("two requests are at least 2.1 s apart (keyless: 0.5 a second)", hits.length === 2 && hits[1][0] - hits[0][0] >= 2_100, `${hits[1][0] - hits[0][0]} ms`);
  const urls = [];
  const c2 = createJupiterClient({ fetchImpl: async (url) => { urls.push(url); return response(200, JFIX.quoteBuy); }, clock: () => 0, sleep: async () => {} });
  await c2.quote(args);
  ok("the quote goes to api.jup.ag/swap/v1 and asks for direct routes, exact-in and the V2 instruction",
    urls.length === 1 && urls[0].startsWith("https://api.jup.ag/swap/v1/quote?") && /onlyDirectRoutes=true/.test(urls[0]) && /swapMode=ExactIn/.test(urls[0]) && /instructionVersion=V2/.test(urls[0]) && /amount=1000000&/.test(urls[0]), urls[0]);
  let skipped = null;
  try { await client.quote({ ...args, priority: "background" }); } catch (e) { skipped = e; }
  ok("a background mark with no free slot is skipped, not queued", skipped instanceof JupiterError && skipped.code === "rate_budget");
  clock.advance(3_000);
  answer = () => response(400, JFIX.noRoute.body);
  let nr = null;
  try { await client.quote(args); } catch (e) { nr = e; }
  ok("the live TOKEN_NOT_TRADABLE answer is `no_route`", nr?.code === "no_route" && /TOKEN_NOT_TRADABLE/.test(nr.message), nr?.message);
  clock.advance(3_000);
  answer = () => response(429, { error: "slow down" }, { "x-ratelimit-reset": String(Math.floor(clock.now() / 1000) + 40) });
  let rl = null;
  try { await client.quote(args); } catch (e) { rl = e; }
  ok("a 429 is `rate_limited` and rests the client until the reset", rl?.code === "rate_limited" && client.status().restingForMs >= 30_000, `${client.status().restingForMs} ms`);
  let bg = null;
  try { await client.quote({ ...args, priority: "background" }); } catch (e) { bg = e; }
  ok("…during which even a mark is skipped", bg?.code === "rate_budget");
}

section("5. THE QUOTE AND THE TRANSACTION, CHECKED ON THE LIVE BYTES");
{
  const qargs = { inputMint: GLDX, outputMint: GAYMF, amountRaw: "1000000", slippageBps: 300, slippageCapBps: 300, maxPriceImpactPct: 5 };
  const q = checkQuote(JFIX.quoteBuy, qargs);
  ok("the live buy quote passes: one direct hop on the discovered Raydium pool", q.hops.length === 1 && q.hops[0].ammKey === JFIX.pool.pairAddress && q.outRaw === 11_104_888_164n);
  ok("its minimum output is the quoted output less 300 bps, rounded up as /swap/v1 does", q.minOutRaw === 10_771_741_520n && (11_104_888_164n * 9_700n) / 10_000n === 10_771_741_519n);
  ok("its impact reads as a fraction: 0.0126 is 1.26%", Math.abs(q.impactPct - 1.2569932229751846) < 1e-9);
  const refuses = (edit, clause, over = qargs) => { try { checkQuote({ ...JFIX.quoteBuy, ...edit }, over); return false; } catch (e) { return e instanceof SwapCheckError && e.clause === clause; } };
  ok("a quote for another input amount is refused", refuses({ inAmount: "1000001" }, "quote_mismatch"));
  ok("a quote for another output mint is refused", refuses({ outputMint: USDC }, "quote_mismatch"));
  ok("a quote whose slippage is over the cap is refused", refuses({ slippageBps: 500 }, "quote_mismatch"));
  ok("a quote with a platform fee is refused", refuses({ platformFee: { amount: "10", feeBps: 50 } }, "quote_mismatch"));
  ok("a minimum output that is not the slippage off the quote is refused", refuses({ otherAmountThreshold: "10000000000" }, "quote_mismatch"));
  ok("an impact over the cap is refused by name", refuses({ priceImpactPct: "0.09" }, "impact_over_cap"));
  ok("a route through a third token is refused: only direct routes", refuses({ routePlan: [{ swapInfo: { inputMint: GLDX, outputMint: USDC }, bps: 10_000 }, { swapInfo: { inputMint: USDC, outputMint: GAYMF }, bps: 10_000 }] }, "route_not_direct"));

  const rpc = { async getMultipleAccounts(a) { return { slot: 1, accounts: a.map((x) => JFIX.lookupTables.find((t) => t.address === x) ?? null) }; } };
  const tables = await loadLookupTables(rpc, JFIX.lookupTables.map((t) => t.address));
  const base = { wallet: JFIX.user, inputMint: GLDX, outputMint: GAYMF, inputProgram: T22, outputProgram: T22, amountRaw: "1000000", quote: JFIX.quoteBuy, slippageCapBps: 300, lookupTables: tables, maxPriorityFeeLamports: 100_000 };
  const c = checkSwapTransaction({ ...base, txBase64: JFIX.swapBuy.swapTransaction });
  ok("the live buy transaction passes: route_v2, exactly the 1,000,000 raw GLDx ticket, one account created", c.route.name === "route_v2" && c.route.amount === 1_000_000n && c.createdAtas.length === 1 && c.createdAtas[0] === c.outputAta);
  ok("…its lookup table resolved from the RPC's copy, not Jupiter's word", c.lookupTables.length === 1 && c.lookupTables[0] === JFIX.lookupTables[0].address);
  const sell = checkSwapTransaction({ ...base, txBase64: JFIX.swapSell.swapTransaction, inputMint: GAYMF, outputMint: GLDX, amountRaw: JFIX.quoteBuy.outAmount, quote: JFIX.quoteSell, maxPriorityFeeLamports: 92_207 });
  ok("the live sell transaction passes, the GLDx account created idempotently for the proceeds", sell.route.amount === 11_104_888_164n && sell.createdAtas[0] === sell.outputAta && sell.priorityFeeLamports === 92_207n);
  let ownerRefused = null;
  try { checkSwapTransaction({ ...base, txBase64: JFIX.swapBuy.swapTransaction, wallet: WALLET }); } catch (e) { ownerRefused = e; }
  ok("the same bytes for any other wallet are refused: the signer is not the wallet", ownerRefused?.clause === "signers");

  /* Hostile edits OF THE LIVE TRANSACTION: decompile it against the real table, change one
     thing, recompile against the same table. Each is refused before any signature exists. */
  const table = tables.get(JFIX.lookupTables[0].address);
  const liveMsg = TransactionMessage.decompile(VersionedTransaction.deserialize(fromBase64(JFIX.swapBuy.swapTransaction)).message, { addressLookupTableAccounts: [table] });
  const rebuild = (edit, { payer = JFIX.user, alts = [table] } = {}) => {
    const ixs = liveMsg.instructions.map((ix) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k) => ({ ...k })), data: Buffer.from(ix.data) }));
    edit(ixs);
    return toBase64(new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: liveMsg.recentBlockhash, instructions: ixs }).compileToV0Message(alts)).serialize());
  };
  const route = (ixs) => ixs.find((ix) => ix.programId.toBase58() === JUPITER_PROGRAM);
  const clauseOf = (txBase64, over = {}) => { try { checkSwapTransaction({ ...base, txBase64, ...over }); return "passed"; } catch (e) { return e.clause ?? e.message; } };
  ok("rebuilt unchanged, the live transaction still passes (the edit harness is honest)", clauseOf(rebuild(() => {})) === "passed");
  ok("spending from another account (a victim's GLDx account as the source) is refused", clauseOf(rebuild((ixs) => { route(ixs).keys[1].pubkey = new PublicKey(associatedTokenAddress(VICTIM, GLDX, T22)); })) === "route_accounts");
  ok("sending the output to another account is refused", clauseOf(rebuild((ixs) => { route(ixs).keys[2].pubkey = new PublicKey(associatedTokenAddress(ATTACKER, GAYMF, T22)); })) === "route_accounts");
  ok("changing the amount in the route is refused", clauseOf(rebuild((ixs) => { route(ixs).data.writeBigUInt64LE(1_000_001n, 8); })) === "route_mismatch");
  ok("a slippage in the route other than the quote's is refused", clauseOf(rebuild((ixs) => { route(ixs).data.writeUInt16LE(1_000, 24); })) === "route_mismatch");
  ok("a positive-slippage fee in the route is refused", clauseOf(rebuild((ixs) => { route(ixs).data.writeUInt16LE(50, 28); })) === "route_mismatch");
  ok("another output mint is refused", clauseOf(rebuild((ixs) => { route(ixs).keys[4].pubkey = new PublicKey(USDC); })) === "route_accounts");
  ok("a System transfer out of the wallet is refused", clauseOf(rebuild((ixs) => { ixs.push(SystemProgram.transfer({ fromPubkey: new PublicKey(JFIX.user), toPubkey: new PublicKey(ATTACKER), lamports: 1 })); })) === "program_not_allowed");
  ok("a token instruction at the top level is refused", clauseOf(rebuild((ixs) => { ixs.push(new TransactionInstruction({ programId: new PublicKey(T22), keys: [{ pubkey: new PublicKey(associatedTokenAddress(JFIX.user, GLDX, T22)), isSigner: false, isWritable: true }], data: Buffer.from([4]) })); })) === "program_not_allowed");
  ok("an account created for a third mint is refused", clauseOf(rebuild((ixs) => { ixs.splice(2, 0, new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [JFIX.user, associatedTokenAddress(JFIX.user, USDC, TK), JFIX.user, USDC, SYSTEM, TK].map((k, i) => ({ pubkey: new PublicKey(k), isSigner: i === 0, isWritable: i < 2 })) })); })) === "account_create");
  ok("a second route is refused", clauseOf(rebuild((ixs) => { ixs.push(route(ixs)); })) === "route_count");
  ok("another fee payer is refused", clauseOf(rebuild(() => {}, { payer: ATTACKER })) === "signers");
  ok("a priority fee over the lane's budget is refused", clauseOf(rebuild(() => {}), { maxPriorityFeeLamports: 50_000 }) === "priority_fee_over_budget");
  ok("a lookup table the RPC does not have is refused", clauseOf(JFIX.swapBuy.swapTransaction, { lookupTables: new Map() }) === "lookup_table_unavailable");
  let lt = null;
  try { await loadLookupTables({ async getMultipleAccounts(a) { return { slot: 1, accounts: a.map(() => ({ owner: SYSTEM, data: ["", "base64"] })) }; } }, [JFIX.lookupTables[0].address]); } catch (e) { lt = e; }
  ok("a 'lookup table' not owned by the lookup-table program is refused", lt?.clause === "lookup_table_unavailable");
}

section("6. OBSERVE: POOLS FOUND, WITH SOURCE AND AGE, AND EACH REFUSAL NAMED");
{
  const clock = createClock();
  const world = createWorld({ clock });
  const good = world.addPool({ symbol: "CAT", agoMs: 20_000 });
  const pumpCurve = world.addPool({ symbol: "PUMPY", dex: "pumpfun", labels: [], agoMs: 15_000 });
  const moneyPool = world.addPool({ token: WSOL, listMint: false, symbol: "SOL", agoMs: 25_000 });
  const stockPool = world.addPool({ token: SPCXX, listMint: false, symbol: "SPCXx", agoMs: 25_000 });
  const oldPool = world.addPool({ symbol: "OLDIE", agoMs: 420_000 });
  const feePool = world.addPool({ token: GAYMF, mintAccount: GAYMF_MINT_ACCOUNT, symbol: "GAYMF", agoMs: 30_000 });
  const mintAuth = world.addPool({ symbol: "PRINTER", mintAccount: classicMint({ mintAuthority: newKey() }), agoMs: 30_000 });
  /* A pool DexScreener lists but Jupiter cannot route (its answer is the live 400). */
  const unrouted = newKey();
  world.st.mints.set(unrouted, classicMint());
  world.feeds.dexExtra.push({ chainId: "solana", dexId: "meteora", labels: ["DYN2"], pairAddress: newKey(), baseToken: { address: unrouted, symbol: "NOROUTE" }, quoteToken: { address: GLDX, symbol: "GLDx" }, pairCreatedAt: clock.now() - 10_000, liquidity: { usd: 10 } });

  const off = makeEngine({ world, clock, config: venueConfig({ xstockVenue: false }) });
  await off.engine.load();
  await drive(clock, off.engine.xstockTick());
  ok("with the venue off, a tick asks nothing of any host", world.fetched.length === 0 && off.engine.status().xstock.enabled === false, `${world.fetched.length} requests`);

  const t = makeEngine({ world, clock, config: venueConfig() });
  await t.engine.load();
  await drive(clock, t.engine.xstockTick());
  const st = t.engine.status();
  const x = st.xstock;
  ok("the pools pairing a token with GLDx were found and recorded, each with its source and its age", x.candidates.length >= 8 && x.candidates.every((c) => c.sources.includes("dexscreener") && Number.isFinite(c.ageAtFirstSightMs) && Number.isFinite(c.firstSeenAt)), `${x.candidates.length} candidates`);
  const gateOf = (p) => cand(t.engine, p)?.gate;
  ok("a pump.fun curve is left to the pump.fun lane, by name", gateOf(pumpCurve.pool) === "left_to_pumpfun_lane");
  ok("GLDx against SOL is refused: no new token to buy", gateOf(moneyPool.pool) === "no_new_token" && /market in the stock/.test(cand(t.engine, moneyPool.pool).message));
  ok("GLDx against another stock is refused the same way", gateOf(stockPool.pool) === "no_new_token");
  ok("a pool first seen seven minutes after its creation is refused at notice_stale", gateOf(oldPool.pool) === "notice_stale" && /first seen 7m after/.test(cand(t.engine, oldPool.pool).message), cand(t.engine, oldPool.pool)?.message);
  ok("the live GAYMF mint is refused by the executor's audit: its TransferFee extension", gateOf(feePool.pool) === "mint_refused" && /TransferFeeConfig is refused/.test(cand(t.engine, feePool.pool).message));
  ok("a token whose mint authority is live is refused", gateOf(mintAuth.pool) === "mint_refused" && /mint authority .* is live/.test(cand(t.engine, mintAuth.pool).message));
  const nr = x.candidates.find((c) => c.tokenSymbol === "NOROUTE");
  ok("a pool Jupiter cannot price is refused at no_route, with Jupiter's own code", nr?.gate === "no_route" && /TOKEN_NOT_TRADABLE/.test(nr.message), nr?.message);
  const g = cand(t.engine, good.pool);
  ok("the pool that clears opens a would-have row, marked at once by a round trip", g?.state === "watching" && /round trip marks 0\.9\d\dx/.test(g.message), g?.message);
  const row = st.open.find((p) => p.mint === good.token);
  ok("the would-have row is in the new venue's book, sized in GLDx at the canary", row && row.live === false && row.venue === "jupiter-xstock" && row.quoteMint === GLDX && row.entryInputLamports === "1000000" && row.quoteDecimals === 8 && row.feeSolPerLeg === 0, row ? `${row.entryInputLamports} raw GLDx for ${row.qtyRaw}` : "no row");
  let gldxAudit = null;
  try { auditMintAccount(GLDX_MINT_ACCOUNT, GLDX); } catch (e) { gldxAudit = e; }
  ok("the audit runs on the new token and never on the stock: GLDx itself would fail it (PermanentDelegate), yet its pool cleared", /PermanentDelegate is refused/.test(gldxAudit?.message ?? "") && g?.state === "watching" && world.rpc.calls.filter(([k]) => k === "gma").every(([, a]) => a[0] !== GLDX));
  ok("observe signed nothing and sent nothing", t.bridge.requests.length === 0 && !world.rpc.calls.some(([k]) => k === "send"));
  ok("every request went to the feeds and Jupiter only", world.fetched.every((f) => /api\.dexscreener\.com|api\.jup\.ag/.test(f)), [...new Set(world.fetched.map((f) => f.split(" ")[1].split("/")[0]))].join(", "));

  /* The built-in list watches, and cannot trade: no stock listed, no ticket. */
  const clock2 = createClock();
  const world2 = createWorld({ clock: clock2 });
  const p2 = world2.addPool({ symbol: "CAT2", agoMs: 20_000 });
  const t2 = makeEngine({ world: world2, clock: clock2, config: venueConfig({ quoteMints: [] }) });
  await t2.engine.load();
  await drive(clock2, t2.engine.xstockTick());
  ok("with no stock listed the built-in list is watched, and a GLDx pool is refused at stock_not_listed", cand(t2.engine, p2.pool)?.gate === "stock_not_listed" && t2.engine.status().xstock.focus.length === 15);
  ok("…the DexScreener feed was asked for each of the fifteen", world2.fetched.filter((f) => f.includes("dexscreener")).length === 15);
}

section("7. ARMED ON PHANTOM: WAIT, FOLLOW-THROUGH, BUY THROUGH JUPITER, SELL THROUGH JUPITER");
{
  const clock = createClock();
  const world = createWorld({ clock });
  const good = world.addPool({ symbol: "CAT", agoMs: 20_000 });
  const t = makeEngine({ world, clock, config: armedConfig() });
  await t.engine.load();
  let st = t.engine.status();
  ok("the lane is armed on the sentence that names the venue", st.executing === true, st.armability.blocking.join(","));
  await drive(clock, t.engine.xstockTick());
  ok("first sight: a would-have row, and Phantom is asked nothing yet", t.engine.status().open.some((p) => p.mint === good.token && !p.live) && t.bridge.requests.length === 0);
  world.move(good.pool, 125);                                           // buyers arrive
  clock.advance(5_000);
  await drive(clock, t.engine.xstockTick());
  ok("five seconds in: still watching, not bought", t.bridge.requests.length === 0);
  clock.advance(5_000);
  const stockBefore = world.st.tokens.get(world.walletStockAta).amount;
  await drive(clock, t.engine.xstockTick());
  st = t.engine.status();
  const live = st.open.find((p) => p.mint === good.token && p.live);
  ok("after the wait, still above its would-have fill: ONE Phantom window, for the buy", t.bridge.requests.length === 1 && t.bridge.requests[0].purpose === "buy" && /through Jupiter/.test(t.bridge.requests[0].summary), t.lines.slice(0, 3).join(" | "));
  const asked = VersionedTransaction.deserialize(fromBase64(t.bridge.requests[0].txBase64));
  const swapTx = world.jup.requests.filter(([k]) => k === "swap").map(([, b]) => b);
  ok("what Phantom was asked to sign is Jupiter's transaction for this wallet, unaltered", swapTx.length === 1 && swapTx[0].userPublicKey === WALLET && asked.message.staticAccountKeys[0].toBase58() === WALLET && swapTx[0].wrapAndUnwrapSol === false);
  ok("it was checked and simulated before the window opened", world.rpc.calls.findIndex(([k]) => k === "sim") >= 0 && world.rpc.calls.findIndex(([k]) => k === "sim") < world.rpc.calls.findIndex(([k]) => k === "send"));
  ok("the buy landed and the position is live in GLDx, the fill read from the chain", live && live.venue === "jupiter-xstock" && live.quoteMint === GLDX && live.entryInputLamports === "1000000" && BigInt(live.qtyRaw) > 0n && live.entrySignature, live ? `${live.qtyRaw} base for ${live.entryInputLamports} raw GLDx` : "no live row");
  ok("exactly the canary ticket left the wallet's GLDx account", stockBefore - world.st.tokens.get(world.walletStockAta).amount === 1_000_000n);
  ok("the tokens are in the wallet's own account", world.st.tokens.get(world.ataOf(WALLET, good.token))?.amount === BigInt(live.qtyRaw));
  const spend = t.engine.state.spend;
  ok("GLDx is charged to its own day, the SOL fee and rent to the SOL day", spend.some((e) => e.quoteMint === GLDX && e.quoteRaw === "1000000" && e.sol > 0 && e.sol < 0.01), JSON.stringify(spend));
  ok("the venue's canary for GLDx is proven by the read-back fill", st.xstock.canary[GLDX]?.state === "proven");
  ok("the pool's candidate row says it was bought", cand(t.engine, good.pool)?.state === "entered");

  world.move(good.pool, 170);                                          // it runs
  clock.advance(3_000);
  await drive(clock, t.engine.xstockTick());
  st = t.engine.status();
  ok("the take fires and is one more Phantom window, the sell", t.bridge.requests.length === 2 && t.bridge.requests[1].purpose === "sell", t.lines.slice(0, 2).join(" | "));
  const close = st.closes.find((c) => c.mint === good.token && c.live);
  ok("the close is booked in GLDx, tagged with the venue and the pool", close && close.venue === "jupiter-xstock" && close.pool === good.pool && close.quoteMint === GLDX && close.pnlQuote > 0 && close.feeSolPaid > 0, close ? `${close.pnlQuote} GLDx, fees ${close.feeSolPaid} SOL` : "no close");
  ok("the position is gone from the book", !st.open.some((p) => p.mint === good.token));
  ok("nothing here asked for a signature any other way", t.bridge.requests.every((r) => r.purpose === "buy" || r.purpose === "sell"));

  /* NOBODY FOLLOWED: the pool falls after first sight, and it is never bought. */
  const b = world.addPool({ symbol: "DUD", agoMs: 20_000 });
  clock.advance(30_000);
  await drive(clock, t.engine.xstockTick());
  world.move(b.pool, 90);
  clock.advance(10_500);
  await drive(clock, t.engine.xstockTick());
  ok("a pool that marks under its would-have fill after the wait is not bought", t.bridge.requests.length === 2 && cand(t.engine, b.pool)?.state === "waited_out", cand(t.engine, b.pool)?.message);
}

section("8. HOSTILE JUPITER: REFUSED BEFORE ANYTHING IS SIGNED");
{
  const hostile = [
    ["other_source", "transaction_refused", /route_accounts: route_v2 source token account/, "spends from another account"],
    ["amount", "transaction_refused", /route_mismatch: the instruction spends 1000001/, "changes the amount"],
    ["other_destination", "transaction_refused", /account_create|route_accounts/, "sends the tokens elsewhere"],
    ["wrong_output", "transaction_refused", /route_accounts|account_create/, "buys another token"],
    ["drain", "transaction_refused", /program_not_allowed: the transaction calls 11111111111111111111111111111111/, "adds a SOL transfer out of the wallet"],
    ["fee_payer", "transaction_refused", /signers/, "names another fee payer and signer"],
    ["extra_ata", "transaction_refused", /account_create/, "creates an account for a third mint"],
    ["priority", "transaction_refused", /priority_fee_over_budget/, "bids a priority fee over the budget"],
    ["alt_swap", "transaction_refused", /route_accounts: route_v2 source token account/, "hides another account behind a lookup table"],
    ["alt_missing", "transaction_refused", /lookup_table_unavailable/, "names a lookup table the RPC does not have"],
  ];
  for (const [mode, gate, why, words] of hostile) {
    const clock = createClock();
    const world = createWorld({ clock });
    const p = world.addPool({ symbol: "BAIT", agoMs: 20_000 });
    const t = makeEngine({ world, clock, config: armedConfig() });
    await t.engine.load();
    await drive(clock, t.engine.xstockTick());
    world.move(p.pool, 125);
    world.jup.mode = mode;
    clock.advance(10_500);
    await drive(clock, t.engine.xstockTick());
    const c = cand(t.engine, p.pool);
    ok(`a Jupiter transaction that ${words} is refused at ${gate}, and Phantom is never asked`, c?.gate === gate && why.test(c.message) && t.bridge.requests.length === 0 && !world.rpc.calls.some(([k]) => k === "send"), `${c?.gate}: ${c?.message?.slice(0, 110)}`);
  }
  for (const [pool, gate, why, words] of [
    ["drain_sol", "simulation_refused", /unexplained drain/, "whose pool drains SOL inside the swap (only the simulation shows it)"],
    ["delegate", "transaction_refused", /custody: after the simulation the GLDx account has a delegate/, "whose pool plants a delegate on the wallet's GLDx account"],
  ]) {
    const clock = createClock();
    const world = createWorld({ clock });
    const p = world.addPool({ symbol: "BAIT", agoMs: 20_000 });
    const t = makeEngine({ world, clock, config: armedConfig() });
    await t.engine.load();
    await drive(clock, t.engine.xstockTick());
    world.move(p.pool, 125);
    world.st.hostilePool = pool;
    clock.advance(10_500);
    await drive(clock, t.engine.xstockTick());
    const c = cand(t.engine, p.pool);
    ok(`a swap ${words} is refused at ${gate}, before signing`, c?.gate === gate && why.test(c.message) && t.bridge.requests.length === 0 && !world.rpc.calls.some(([k]) => k === "send"), `${c?.gate}: ${c?.message?.slice(0, 120)}`);
  }
  {
    const clock = createClock();
    const world = createWorld({ clock });
    const p = world.addPool({ symbol: "HOPS", agoMs: 20_000 });
    world.jup.quoteMode = "multi_hop";
    const t = makeEngine({ world, clock, config: armedConfig() });
    await t.engine.load();
    await drive(clock, t.engine.xstockTick());
    ok("a quote that hops through a third token is refused at first sight, by name", cand(t.engine, p.pool)?.gate === "route_not_direct");
  }
}

section("9. BUDGETS: THE CANARY, THE FULL TICKET, THE DAY CAPS, THE WALLET");
{
  const clock = createClock();
  const world = createWorld({ clock });
  const cfg = armedConfig({ quoteMints: [{ mint: GLDX, symbol: "GLDx", maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.06 }], maxOpenPositions: 1 });
  const t = makeEngine({ world, clock, config: cfg });
  await t.engine.load();
  const buyOne = async (symbol) => {
    const p = world.addPool({ symbol, agoMs: 20_000 });
    clock.advance(31_000);
    await drive(clock, t.engine.xstockTick());
    world.move(p.pool, 125);
    clock.advance(10_500);
    await drive(clock, t.engine.xstockTick());
    return p;
  };
  const a = await buyOne("ONE");
  const liveA = t.engine.status().open.find((p) => p.mint === a.token && p.live);
  ok("the first live buy in GLDx is the canary: 0.01 GLDx", liveA?.entryInputLamports === "1000000", liveA?.entryInputLamports);
  await t.engine.forgetPosition(a.token);                               // sold by hand, say
  const b = await buyOne("TWO");
  const liveB = t.engine.status().open.find((p) => p.mint === b.token && p.live);
  ok("once proven, the next is the full ticket: 0.05 GLDx", liveB?.entryInputLamports === "5000000", liveB?.entryInputLamports);
  await t.engine.forgetPosition(b.token);
  const c = world.addPool({ symbol: "THREE", agoMs: 20_000 });
  clock.advance(31_000);
  await drive(clock, t.engine.xstockTick());
  ok("the GLDx day is at its 0.06 cap: the next pool is refused at daily_capacity", cand(t.engine, c.pool)?.gate === "daily_capacity", cand(t.engine, c.pool)?.message);
  ok("…and forgetting a row does not give the day back", t.engine.state.spend.filter((e) => e.quoteMint === GLDX).reduce((s, e) => s + BigInt(e.quoteRaw), 0n) === 6_000_000n);

  const clock2 = createClock();
  const world2 = createWorld({ clock: clock2 });
  const p2 = world2.addPool({ symbol: "SOLDAY", agoMs: 20_000 });
  const t2 = makeEngine({ world: world2, clock: clock2, config: venueConfig({ maxSolPerTrade: 0.001, dailySolCap: 0.002 }) });
  await t2.engine.load();
  await drive(clock2, t2.engine.xstockTick());
  ok("a buy whose SOL fee and rent would break the SOL day is refused at daily_capacity_sol", cand(t2.engine, p2.pool)?.gate === "daily_capacity_sol", cand(t2.engine, p2.pool)?.message);

  const clock3 = createClock();
  const world3 = createWorld({ clock: clock3, walletStockRaw: 500_000n });
  const p3 = world3.addPool({ symbol: "SHORT", agoMs: 20_000 });
  const t3 = makeEngine({ world: world3, clock: clock3, config: armedConfig() });
  await t3.engine.load();
  await drive(clock3, t3.engine.xstockTick());
  world3.move(p3.pool, 125);
  clock3.advance(10_500);
  await drive(clock3, t3.engine.xstockTick());
  ok("a wallet holding less GLDx than the ticket is refused at quote_balance_short, nothing asked", cand(t3.engine, p3.pool)?.gate === "quote_balance_short" && t3.bridge.requests.length === 0 && world3.jup.requests.every(([k]) => k !== "swap"), cand(t3.engine, p3.pool)?.message);
}

section("9b. A BUY THAT CANNOT BE READ BACK BLOCKS THE STOCK; A DECLINED BUY IS NEVER RE-ASKED");
{
  const clock = createClock();
  const world = createWorld({ clock });
  const t = makeEngine({ world, clock, config: armedConfig() });
  await t.engine.load();
  const p = world.addPool({ symbol: "GHOST", agoMs: 20_000 });
  await drive(clock, t.engine.xstockTick());
  world.move(p.pool, 125);
  world.st.hideTransactions = true;                                   // it lands, and the RPC will not show it
  clock.advance(10_500);
  await drive(clock, t.engine.xstockTick());
  let st = t.engine.status();
  ok("a buy that was sent and cannot be read back blocks GLDx in this venue, loudly", t.bridge.requests.length === 1 && st.xstock.canary[GLDX]?.state === "blocked" && t.notes.some((n) => n.kind === "attention" && /could not take/.test(n.title)), st.xstock.canary[GLDX]?.detail);
  ok("…the day is charged as if the ticket was spent", t.engine.state.spend.some((e) => e.kind === "entry_unread" && e.quoteRaw === "1000000"));
  world.st.hideTransactions = false;
  const q = world.addPool({ symbol: "NEXT", agoMs: 20_000 });
  clock.advance(31_000);
  await drive(clock, t.engine.xstockTick());
  ok("the next GLDx pool is refused at stock_canary_blocked, naming the signature to check", cand(t.engine, q.pool)?.gate === "stock_canary_blocked" && /clear the block/.test(cand(t.engine, q.pool)?.message ?? ""));
  ok("clearing the pump.fun lane's block does not clear this venue's", (await t.engine.clearStockCanary(GLDX)) === false && t.engine.status().xstock.canary[GLDX]?.state === "blocked");
  ok("clearing this venue's block does", (await t.engine.clearStockCanary(GLDX, { venue: "jupiter-xstock" })) === true && !t.engine.status().xstock.canary[GLDX]);
  const r = world.addPool({ symbol: "AGAIN", agoMs: 20_000 });
  clock.advance(31_000);
  await drive(clock, t.engine.xstockTick());
  world.move(r.pool, 125);
  t.bridge.mode = "reject";
  clock.advance(12_500);                                              // the wait runs from the would-have fill, a quote or two after first sight
  await drive(clock, t.engine.xstockTick());
  const asks = t.bridge.requests.length;
  ok("after the block is cleared the next buy is a canary again, and a declined window buys nothing", asks === 2 && world.jup.requests.filter(([k]) => k === "swap").at(-1)[1].quoteResponse.inAmount === "1000000" && !t.engine.status().open.some((x) => x.mint === r.token && x.live));
  clock.advance(10_000);
  await drive(clock, t.engine.xstockTick());
  clock.advance(10_000);
  await drive(clock, t.engine.xstockTick());
  ok("…and a declined buy is never asked again", t.bridge.requests.length === asks);
}

section("10. AUTOPILOT: THE AUTOPILOT WALLET SIGNS THE JUPITER BUY");
{
  const mapStore = () => { const m = new Map(); return { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async set(k, v) { m.set(k, structuredClone(v)); }, async remove(k) { m.delete(k); } }; };
  const clock = createClock();
  const keystore = createKeystore({ storage: mapStore(), session: mapStore(), clock: clock.now });
  const { publicKey: AUTO } = await keystore.create({ passphrase: "a cat that waits ten seconds" });
  await keystore.unlock({ passphrase: "a cat that waits ten seconds", ttlMs: 30 * 60_000 });
  const signer = createSessionSigner({ keystore, clock: clock.now });
  const world = createWorld({ clock, wallet: AUTO, walletLamports: 200_000_000n });
  const p = world.addPool({ symbol: "AUTO", agoMs: 20_000 });
  const phantom = createBridge();
  const cfgBase = venueConfig({ lane: "execute", signerMode: "autopilot" });
  const liveAck = browserArmSentence(AUTO, cfgBase.maxSolPerTrade, cfgBase.dailySolCap, normalizeConfig({ ...CONFIG_DEFAULTS, quoteMints: STOCKS }).quoteMints, { autopilot: true, xstockVenue: true });
  const t = makeEngine({ world, clock, config: { ...cfgBase, liveAck }, bridge: phantom, sessionSigner: signer });
  await t.engine.load();
  await t.engine.refreshSigner();
  ok("armed on autopilot, with the venue named in the sentence", t.engine.status().executing === true, t.engine.status().armability.blocking.join(","));
  await drive(clock, t.engine.xstockTick());
  world.move(p.pool, 125);
  clock.advance(10_500);
  await drive(clock, t.engine.xstockTick());
  const live = t.engine.status().open.find((x) => x.mint === p.token && x.live);
  const sent = [...world.st.sent.values()][0];
  const tx = sent ? VersionedTransaction.deserialize(sent.bytes) : null;
  ok("the autopilot wallet bought through Jupiter, and Phantom was asked nothing", live?.wallet === AUTO && phantom.requests.length === 0, t.lines.slice(0, 3).join(" | "));
  ok("the bytes that reached the chain carry the autopilot key's signature over Jupiter's message", tx && ed25519.verify(tx.signatures[0], tx.message.serialize(), new PublicKey(AUTO).toBytes()) && tx.message.staticAccountKeys[0].toBase58() === AUTO);
  ok("no log line or notification names a secret", !t.lines.concat(t.notes.map((n) => JSON.stringify(n))).some((l) => /secret|passphrase|a cat that waits/i.test(l)));
  const exported = await keystore.exportSecret({ passphrase: "a cat that waits ten seconds" });
  const raw = Buffer.from(bs58.decode(exported));
  const secretForms = [exported, raw.toString("base64"), raw.toString("hex"), "a cat that waits ten seconds"];
  const sentAnything = world.wire.length > 5 && world.wire.some((w) => w.includes(AUTO));
  ok("nothing this venue sent over the network carries the key or the passphrase — only the wallet's public key", sentAnything && world.wire.every((w) => secretForms.every((s) => !w.includes(s))), `${world.wire.length} requests scanned`);
  ok("…and the engine's stored state holds neither", !JSON.stringify(t.engine.state).includes(exported) && !JSON.stringify(t.engine.state).includes(raw.toString("base64")) && !JSON.stringify(t.engine.state).includes("a cat that waits"));
}

section("11. THE PUMP.FUN LANE, UNCHANGED; ONE MINT, ONE BOOK; HELD POSITIONS OUTLIVE THE SWITCH");
{
  /* pump.fun's own create log, handled with the venue off and with it on: same verdict. */
  const CREATE_EVENT_B64 = "G3KpTd7rY3YUAAAAT2ZmaWNpYWwgQm9uemkgQnVkZHkFAAAAQk9OWklQAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvYmFma3JlaWRmdXJuM2Nuamd2Z2RuaWlieTNwcGJxYnp3d2gzd3NhbXBxY3Q0bDV5ZnR0ZHB4c2Rjcm0NZ5R4DNvGl0tdsj/oi5NhqzmUroaJv1bVWiRWfUFub6w6hiMVms8iL7nS7iRC5+rcowQNHOvPJZKmxhphQWFNdSHpBIjrPE5vfQmu9Yn2YsBxf4PapMpSIufJGz/xsdZ1IekEiOs8Tm99Ca71ifZiwHF/g9qkylIi58kbP/Gx1m5Oo2oAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAA";
  const CREATE = decodeCreateEvent(Buffer.from(CREATE_EVENT_B64, "base64"));
  const verdicts = [];
  for (const venueOn of [false, true]) {
    const clock = createClock();
    const world = createWorld({ clock });
    const t = makeEngine({ world, clock, config: venueConfig({ xstockVenue: venueOn, quoteMints: [] }) });
    await t.engine.load();
    const res = await t.engine.handleNotice({ mint: CREATE.mint, creator: CREATE.creator, slot: 1, noticeAt: clock.now(), source: "logsSubscribe", raw: {} });
    verdicts.push(`${res?.verdict?.gate}`);
    ok(`venue ${venueOn ? "on" : "off"}: the pump.fun notice went through the pump.fun contract and nowhere else`, res?.verdict && world.fetched.length === 0 && Object.keys(t.engine.state.xstock.snipes).length === 0, `${res?.verdict?.gate}: ${res?.verdict?.detail?.message?.slice(0, 80)}`);
  }
  ok("…and was refused at the same gate either way", verdicts[0] === verdicts[1], verdicts.join(" / "));

  /* One mint, one book: a mint the pump.fun lane holds is refused by this venue. */
  const clock = createClock();
  const world = createWorld({ clock });
  const p = world.addPool({ symbol: "BOTH", agoMs: 20_000 });
  const t = makeEngine({ world, clock, config: venueConfig() });
  await t.engine.load();
  t.engine.state.snipes[p.token] = { mint: p.token, lane: "snipe", venue: "pumpfun", entry: 1, openedAt: clock.now(), sizeSol: 0.01, feeSolPerLeg: 0.0005, qtyRaw: "1000", entryInputLamports: "9500000", entryFeeLamports: "500000", live: false };
  await drive(clock, t.engine.xstockTick());
  ok("a mint the pump.fun book holds is refused here at already_holding", cand(t.engine, p.pool)?.gate === "already_holding");

  /* Held through the switch: a live position is managed with the venue turned off. */
  const clock2 = createClock();
  const world2 = createWorld({ clock: clock2 });
  const p2 = world2.addPool({ symbol: "HOLD", agoMs: 20_000 });
  const t2 = makeEngine({ world: world2, clock: clock2, config: armedConfig() });
  await t2.engine.load();
  await drive(clock2, t2.engine.xstockTick());
  world2.move(p2.pool, 125);
  clock2.advance(10_500);
  await drive(clock2, t2.engine.xstockTick());
  const held = t2.engine.status().open.filter((x) => x.live);
  ok("bought, and the live row is in the one open list the popup, the console and the sweep's refusal read", held.length === 1 && held[0].mint === p2.token && held[0].venue === "jupiter-xstock" && held[0].wallet === WALLET);
  await t2.engine.setConfig({ xstockVenue: false });
  const before = world2.fetched.filter((f) => f.includes("dexscreener")).length;
  world2.move(p2.pool, 170);
  clock2.advance(35_000);
  await drive(clock2, t2.engine.xstockTick());
  ok("with the venue switched off, no pool is polled, and the held position still sells on its take", world2.fetched.filter((f) => f.includes("dexscreener")).length === before && !t2.engine.status().open.some((x) => x.mint === p2.token) && t2.bridge.requests.filter((r) => r.purpose === "sell").length === 1, t2.lines.slice(0, 2).join(" | "));
  ok("…and switching it off disarmed the lane: the sentence named the venue", t2.engine.status().executing === false && t2.engine.status().armability.blocking.includes("live_ack_typed"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
