/**
 * THE LAUNCH PROXIES ARE EVIDENCE UNTIL THE SHADOW LOG SAYS OTHERWISE.
 *
 * No dev-holding, dev-sold or launch-share computation existed on this desk (grep, given);
 * openCall stamps "Thesis void if the deployer wallet sells" on every *pump call, so a
 * creator who already sold makes the invalidation true at publish; GoatPro's first candle
 * carried $6,189 on a ~$5k curve. Three rulers were added for that, and every one of them
 * is checked here against a case whose answer is already known BEFORE anything is ranked
 * or refused on it:
 *
 *   1. The associated token address is derived without a dependency (src/lib/ata.js) and
 *      pinned to four addresses @solana/web3.js produced, including a Token-2022 one and a
 *      bump-254 one, plus seven on-curve truths.
 *   2. topHolders reads the creator's share, presence and sale against a stub chain: the
 *      ATA rides the EXISTING getMultipleAccounts call, the ONE bounded signature read runs
 *      only inside the 30-minute window on a funded-then-emptied account, and every absence
 *      — unknown creator, unresolved owners, no account, a failed or hung read, one lone
 *      transaction, a coin past the window — reads null and makes no extra call.
 *   3. momentumFrom reads the launch minute only off a provably complete tape, and the
 *      ignition sweep asks for the 200-row birth tape for nano/micro coins inside their
 *      hunt window and the ordinary 40 for everyone else.
 *   4. The REAL gather() carries both readings onto the bundle (the seats never saw a
 *      launch minute before — workup() is handed a mint and nothing else), the REAL
 *      screen() refuses dev_dumped only on devSoldAll === true, the code is registered
 *      JUDGMENT explicitly, and no level of the ladder publishes past it.
 *   5. The shadow log: 200 synthetic paid workups record launchVolShare, devPctOfSupply
 *      and the deployer profile beside the X read's verdict; precision/recall per proxy is
 *      printed, and a proxy is promotable only past the stated bar over the stated sample.
 *      Nothing in the screen reads the scorecard: a promotable proxy still kills nothing.
 *
 * WHAT IS REAL: ata.js, topHolders, momentumFrom/momentumFor, ignitionSweep, gather(),
 * screen(), GATE_CLASS/gateFailures/cohortEligibility, launch-shadow.js, the cost-imperative
 * sweep. WHAT IS STUBBED: the network only — one fetch stub answering as each provider
 * would (DexScreener, Jupiter, pump.fun, the RPC), so what left the process IS the evidence.
 *
 *   node test-launch-share-shadow.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "launch-shadow-"));
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(TMP, "shadow.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";
delete process.env.DS_OFFLINE;
delete process.env.JUPITER_API_KEY;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const near = (a, b, eps = 1e-4) => Number.isFinite(a) && Math.abs(a - b) <= eps;
const src = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/* ═══ THE NETWORK, ANSWERED AS EACH PROVIDER WOULD ═══════════════════════════════════ */
const RPC_URL = "http://rpc.stub.invalid/";
const NET = { gets: [], rpc: [], priceIds: [], candleLimits: new Map(), unrouted: [] };
const jsonRes = (data, okFlag = true, status = 200) => ({ ok: okFlag, status, json: async () => data });
const hangUntilAborted = (signal) => new Promise((_, reject) => {
  const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  if (signal?.aborted) return abort();
  signal?.addEventListener("abort", abort, { once: true });
});

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATOR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";      // on the curve: a wallet
const CURVE_PDA = "CurvePDAowner111111111111111111111111111111";
const CURVE_ACCT = "CurveTokenAcct11111111111111111111111111111";
const DEV_ACCT = "DevTokenAcct111111111111111111111111111111111";
const SUPPLY_RAW = 1_000_000_000_000_000;                            // 1e9 tokens at 6 decimals

/* The chain fixture the RPC router reads. Mutated per scenario. */
const CHAIN = {
  mintOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  supply: String(SUPPLY_RAW),
  largest: [],            // [{ address, amount }]
  owners: {},             // token account -> owner wallet
  ownerPrograms: {},      // owner wallet -> program that owns it
  ata: {},                // ata address -> { owner, amount } (present accounts only)
  sigs: [],               // array | "fail" | "hang"
  failOwners: false,
};
function rpcRoute(body, signal) {
  const { method, params } = body;
  NET.rpc.push({ method, params });
  const res = (result) => jsonRes({ jsonrpc: "2.0", id: 1, result });
  const err = (message) => jsonRes({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } });
  if (method === "getAccountInfo")
    return res({ value: { owner: CHAIN.mintOwner, data: { parsed: { info: {
      decimals: 6, supply: CHAIN.supply, mintAuthority: null, freezeAuthority: null, extensions: [] } } } } });
  if (method === "getTokenLargestAccounts")
    return res({ value: CHAIN.largest.map((a) => ({ address: a.address, amount: String(a.amount) })) });
  if (method === "getMultipleAccounts") {
    const keys = params[0];
    if (params[1]?.encoding === "jsonParsed") {
      if (CHAIN.failOwners) return err("stub: owners unavailable");
      return res({ value: keys.map((k) => {
        const big = CHAIN.largest.find((a) => a.address === k);
        if (big) return { data: { parsed: { info: { owner: CHAIN.owners[k] ?? null, tokenAmount: { amount: String(big.amount) } } } } };
        const ata = CHAIN.ata[k];
        if (!ata) return null;
        return { data: { parsed: { info: { owner: ata.owner, tokenAmount: { amount: String(ata.amount) } } } } };
      }) });
    }
    return res({ value: keys.map((k) => ({ owner: CHAIN.ownerPrograms[k] ?? SYSTEM_PROGRAM })) });
  }
  if (method === "getSignaturesForAddress") {
    if (CHAIN.sigs === "fail") return err("stub: signatures unavailable");
    if (CHAIN.sigs === "hang") return hangUntilAborted(signal);
    return res(CHAIN.sigs);
  }
  return err(`stub: unexpected ${method}`);
}

/* The market fixture the GET router reads. Filled in once the modules are loaded. */
const MARKET = { pair: null, pfCoin: null, listing: [], tapes: new Map(), solUsd: 5000 / 30, priceUsd: null, mint: null };
function getRoute(u) {
  NET.gets.push(u);
  if (u.includes("/latest/dex/tokens/")) return jsonRes({ pairs: [MARKET.pair] });
  if (u.includes("/price/v3")) {
    const ids = (new URL(u).searchParams.get("ids") || "").split(",");
    NET.priceIds.push(ids);
    const out = {};
    for (const id of ids) {
      if (id === MARKET.mint) out[id] = { usdPrice: MARKET.priceUsd };
      if (id === "So11111111111111111111111111111111111111112") out[id] = { usdPrice: MARKET.solUsd };
    }
    return jsonRes(out);
  }
  if (u.includes("/swap/v1/quote")) {
    const q = new URL(u).searchParams;
    const amount = Number(q.get("amount"));
    const buying = q.get("inputMint") === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const out = buying ? Math.round(amount * 1000) : Math.round((amount / 1000) * 0.97);
    return jsonRes({ inAmount: String(amount), outAmount: String(out), priceImpactPct: "0.001",
      routePlan: [{ swapInfo: { label: "PumpSwap" } }] });
  }
  if (u.includes("/orders/v1/solana/")) return jsonRes({ orders: [] });
  if (u.includes("coingecko")) return jsonRes({}, false, 404);
  if (u.includes("frontend-api-v3.pump.fun/coins?creator=")) return jsonRes([]);
  if (u.includes("frontend-api-v3.pump.fun/coins?")) {
    const offset = Number(new URL(u).searchParams.get("offset"));
    return jsonRes(offset === 0 ? MARKET.listing : []);
  }
  if (u.includes("frontend-api-v3.pump.fun/coins/")) return jsonRes(MARKET.pfCoin);
  if (u.includes("swap-api.pump.fun/v1/coins/")) {
    const mint = u.split("/v1/coins/")[1].split("/")[0];
    NET.candleLimits.set(mint, Number(new URL(u).searchParams.get("limit")));
    return jsonRes(MARKET.tapes.get(mint) ?? []);
  }
  NET.unrouted.push(u);
  return jsonRes({ error: "unrouted" }, false, 404);
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (init.method === "POST" && u.startsWith(RPC_URL)) return rpcRoute(JSON.parse(init.body), init.signal);
  return getRoute(u);
};

/* ═══ THE MODULES UNDER TEST — loaded after the env and the stub are in place ══════════ */
const { associatedTokenAddress, isOnCurve, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } = await import("./src/lib/ata.js");
const { decode, isAddress } = await import("./src/lib/base58.js");
const { cfg, MINTS, floorsFor, MAX_ESCALATION_LEVEL } = await import("./src/config.js");
const { topHolders, DEV_SOLD_DEADLINE_MS, DEV_SOLD_WINDOW_MS, DEV_SOLD_SIG_LIMIT } = await import("./src/data/solana.js");
const { momentumFrom, BIRTH_TAPE_CANDLES } = await import("./src/data/pumpfun-live.js");
const { ignitionSweep, huntWindowMs } = await import("./src/ignition.js");
const { gather, screen, launchMomentum } = await import("./src/data/evidence.js");
const { bundle, FORENSICS_SYSTEM } = await import("./src/agents/analysts.js");
const { BESTPICK_SYSTEM } = await import("./src/agents/decision.js");
const { costImperatives } = await import("./src/lib/cost-imperative.js");
const { GATE_CLASS, SAFETY_GATES, JUDGMENT_GATES, gateClass, gateFailures } = await import("./src/calls.js");
const { cohortEligibility } = await import("./src/penthouse.js");
const shadow = await import("./src/launch-shadow.js");
cfg.rpc = RPC_URL;

const MIN = 60_000;
const NOW = Date.now();
const bucket = (ms) => Math.floor(ms / MIN) * MIN;
/** A tape from the birth minute: `n` candles, the first carrying `firstVol`, the rest 100. */
const tapeFrom = (bornMs, n, firstVol) => Array.from({ length: n }, (_, i) => ({
  timestamp: bucket(bornMs) + i * MIN, open: 1 + i * 0.05, high: 1 + i * 0.06, low: 1 + i * 0.04,
  close: 1 + i * 0.05, volume: i === 0 ? firstVol : 100,
}));
const rpcCalls = (method) => NET.rpc.filter((c) => c.method === method);

/* A pump.fun-shaped mint: 44 base58 characters ending in "pump" that decode to 32 bytes. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let MINT = null;
for (const c of ALPHABET) {
  const s = `${c}oatProShadowFixtureMintAddress111111111pump`;
  if (isAddress(s)) { MINT = s; break; }
}
MARKET.mint = MINT;
const ATA = associatedTokenAddress(CREATOR, MINT, TOKEN_PROGRAM).address;

console.log("\n1. THE ASSOCIATED TOKEN ADDRESS, DERIVED WITHOUT A DEPENDENCY");
{
  /* Produced by @solana/web3.js 1.98.4 (PublicKey.findProgramAddressSync) on 2026-09-08. */
  const vectors = [
    [CREATOR, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", TOKEN_PROGRAM, "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B", 254],
    [CREATOR, "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", TOKEN_2022_PROGRAM, "897krAvWH3RbymaCYE3o9emopUwocieHuKTUk9nySpq6", 255],
    [CURVE_PROGRAM, "So11111111111111111111111111111111111111112", TOKEN_PROGRAM, "39kquuPyNNW4j8eU3EznjknQgc47f8u2CY4QQAC7RXg6", 255],
    ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", TOKEN_PROGRAM, "BmeV7UWExZeSboQXYW4biUVEx2SyYDVTdWhHoQEQcUFu", 255],
  ];
  for (const [owner, mint, program, want, bump] of vectors) {
    const got = associatedTokenAddress(owner, mint, program);
    ok(`ATA(${owner.slice(0, 6)}…, ${mint.slice(0, 6)}…, ${program === TOKEN_PROGRAM ? "token" : "token-2022"}) matches web3.js`,
      got.address === want && got.bump === bump, `${got.address} bump ${got.bump} (want ${want} bump ${bump})`);
  }
  const truths = [[SYSTEM_PROGRAM, true], [CREATOR, true], [CURVE_PROGRAM, true],
    ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", true], [TOKEN_PROGRAM, true],
    ["So11111111111111111111111111111111111111112", true], ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", false]];
  const curve = truths.map(([k, want]) => [k, isOnCurve(decode(k)), want]);
  ok("the curve test agrees with web3.js isOnCurve on 7 addresses (6 wallets/programs on, 1 PDA off)",
    curve.every(([, got, want]) => got === want), curve.map(([k, got]) => `${k.slice(0, 6)}…=${got}`).join(" "));
  ok("the fixture mint is a real 32-byte address ending in pump", MINT && isAddress(MINT) && MINT.endsWith("pump"), MINT);
}

console.log("\n2. THE CREATOR IN THE BOOK — read from the chain, null on every absence");
const resetChain = () => {
  CHAIN.largest = [
    { address: CURVE_ACCT, amount: 793e12 },
    { address: DEV_ACCT, amount: 30e12 },
    { address: "Holder1Acct11111111111111111111111111111111", amount: 20e12 },
    { address: "Holder2Acct11111111111111111111111111111111", amount: 12e12 },
    { address: "Holder3Acct11111111111111111111111111111111", amount: 9e12 },
    { address: "Holder4Acct11111111111111111111111111111111", amount: 7e12 },
    { address: "Holder5Acct11111111111111111111111111111111", amount: 5e12 },
  ];
  CHAIN.owners = { [CURVE_ACCT]: CURVE_PDA, [DEV_ACCT]: CREATOR,
    Holder1Acct11111111111111111111111111111111: "Wallet1111111111111111111111111111111111111",
    Holder2Acct11111111111111111111111111111111: "Wallet2111111111111111111111111111111111111",
    Holder3Acct11111111111111111111111111111111: "Wallet3111111111111111111111111111111111111",
    Holder4Acct11111111111111111111111111111111: "Wallet4111111111111111111111111111111111111",
    Holder5Acct11111111111111111111111111111111: "Wallet5111111111111111111111111111111111111" };
  CHAIN.ownerPrograms = { [CURVE_PDA]: CURVE_PROGRAM };
  CHAIN.ata = {};
  CHAIN.sigs = [];
  CHAIN.failOwners = false;
  NET.rpc.length = 0;
};
const withoutDev = () => { CHAIN.largest = CHAIN.largest.filter((a) => a.address !== DEV_ACCT); };
const young = NOW - 5 * MIN;
const twoTxs = [{ signature: "sell1", blockTime: Math.floor((NOW - 2 * MIN) / 1000), err: null },
  { signature: "create1", blockTime: Math.floor((NOW - 5 * MIN) / 1000), err: null }];
{
  ok("the window and the deadline are the stated ones",
    DEV_SOLD_WINDOW_MS === 30 * MIN && DEV_SOLD_DEADLINE_MS === 8_000 && DEV_SOLD_SIG_LIMIT === 20,
    `window ${DEV_SOLD_WINDOW_MS / MIN}m, deadline ${DEV_SOLD_DEADLINE_MS}ms, limit ${DEV_SOLD_SIG_LIMIT}`);

  // A. the creator holds 3% through an account among the largest — present, not sold
  resetChain();
  let h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("A. a creator holding 3% in the book reads devPctOfSupply 3, present, devSoldAll false",
    h.ok && h.devPctOfSupply === 3 && h.devAccountPresent === true && h.devSoldAll === false,
    `pct=${h.devPctOfSupply} present=${h.devAccountPresent} soldAll=${h.devSoldAll} top1=${h.top1Pct}% pools=${h.poolsExcluded}`);
  ok("   ...and no signature read was made for a creator still holding",
    rpcCalls("getSignaturesForAddress").length === 0, `${rpcCalls("getSignaturesForAddress").length} reads`);
  const ownerCall = rpcCalls("getMultipleAccounts").find((c) => c.params[1]?.encoding === "jsonParsed");
  ok("   ...the ATA rode the EXISTING owner lookup as one more key, not a new call",
    ownerCall.params[0].length === CHAIN.largest.length + 1 && ownerCall.params[0].at(-1) === ATA
    && rpcCalls("getMultipleAccounts").length === 2,
    `${ownerCall.params[0].length} keys on the jsonParsed read (${CHAIN.largest.length} largest + ATA ${ATA.slice(0, 8)}…), ${rpcCalls("getMultipleAccounts").length} getMultipleAccounts calls total`);
  ok("   ...the curve is still excluded by owner and the dev is the largest real holder",
    h.poolsExcluded === 1 && h.top1Pct === 3, `poolsExcluded=${h.poolsExcluded} top1Pct=${h.top1Pct}`);

  // B. funded then emptied inside the window: the one positive case
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = twoTxs;
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  const sig = rpcCalls("getSignaturesForAddress");
  ok("B. an empty ATA with two confirmed transactions on a 5-minute-old coin reads devSoldAll TRUE",
    h.devSoldAll === true && h.devPctOfSupply === 0 && h.devAccountPresent === true && h.devAtaTxCount === 2,
    `soldAll=${h.devSoldAll} pct=${h.devPctOfSupply} present=${h.devAccountPresent} txs=${h.devAtaTxCount} lastTx=${h.devLastTxAt ? new Date(h.devLastTxAt).toISOString() : null}`);
  ok("   ...bought with exactly ONE bounded signature read on the creator's ATA",
    sig.length === 1 && sig[0].params[0] === ATA && sig[0].params[1].limit === DEV_SOLD_SIG_LIMIT,
    `${sig.length} read, address ${sig[0]?.params[0]?.slice(0, 8)}…, limit ${sig[0]?.params[1]?.limit}`);

  // C. the same account, but the coin is 45 minutes old: no read, no verdict
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = twoTxs;
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: NOW - 45 * MIN, now: NOW });
  ok("C. past the 30-minute window the read is not made and devSoldAll is null, not false",
    h.devSoldAll === null && rpcCalls("getSignaturesForAddress").length === 0 && h.devAccountPresent === true,
    `soldAll=${h.devSoldAll} sigReads=${rpcCalls("getSignaturesForAddress").length} present=${h.devAccountPresent}`);

  // D. the creator never opened an account: nothing to sell, nothing claimed
  resetChain(); withoutDev();
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("D. no ATA at all reads present false, pct 0, devSoldAll null — a creator who never bought did not sell",
    h.devAccountPresent === false && h.devPctOfSupply === 0 && h.devSoldAll === null
    && rpcCalls("getSignaturesForAddress").length === 0,
    `present=${h.devAccountPresent} pct=${h.devPctOfSupply} soldAll=${h.devSoldAll} sigReads=${rpcCalls("getSignaturesForAddress").length}`);

  // E. no creator known (not a pump.fun coin, or the launcher did not answer)
  resetChain();
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA });
  const ownerCallE = rpcCalls("getMultipleAccounts").find((c) => c.params[1]?.encoding === "jsonParsed");
  ok("E. an unknown creator reads null on all three and appends nothing to the owner lookup",
    h.ok && h.devPctOfSupply === null && h.devAccountPresent === null && h.devSoldAll === null && h.devAta === null
    && ownerCallE.params[0].length === CHAIN.largest.length,
    `pct=${h.devPctOfSupply} present=${h.devAccountPresent} soldAll=${h.devSoldAll} keys=${ownerCallE.params[0].length}`);

  // F. owners could not be resolved: the concentration is unverified and so is the creator
  resetChain(); CHAIN.failOwners = true;
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("F. unresolved owners read ownersResolved false and null creator fields — unmeasured, not clean",
    h.ok && h.ownersResolved === false && h.devPctOfSupply === null && h.devSoldAll === null && h.devAccountPresent === null,
    `ownersResolved=${h.ownersResolved} pct=${h.devPctOfSupply} soldAll=${h.devSoldAll}`);

  // G. the signature read fails
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = "fail";
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("G. a failed signature read leaves devSoldAll null after exactly one attempt",
    h.devSoldAll === null && rpcCalls("getSignaturesForAddress").length === 1,
    `soldAll=${h.devSoldAll} attempts=${rpcCalls("getSignaturesForAddress").length}`);

  // H. the signature read hangs: the deadline, not the coin, ends it
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = "hang";
  const t0 = performance.now();
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW, devSoldDeadlineMs: 250 });
  const elapsed = performance.now() - t0;
  ok("H. a hung signature read is abandoned at the deadline and reads null",
    h.ok && h.devSoldAll === null && elapsed >= 200 && elapsed < 2_000,
    `soldAll=${h.devSoldAll} after ${elapsed.toFixed(0)}ms against a 250ms deadline (production ${DEV_SOLD_DEADLINE_MS}ms)`);

  // I. an empty account with ONE transaction was opened and never filled
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = [twoTxs[1]];
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("I. one lone transaction on an empty account is not a sale — devSoldAll null",
    h.devSoldAll === null && h.devAtaTxCount === 1, `soldAll=${h.devSoldAll} txs=${h.devAtaTxCount}`);

  // J. the creator holds a little, below the largest twenty: seen through the ATA alone
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 5e12 };
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  ok("J. a 0.5% holding below the largest accounts is read off the ATA: pct 0.5, present, not sold",
    h.devPctOfSupply === 0.5 && h.devAccountPresent === true && h.devSoldAll === false
    && rpcCalls("getSignaturesForAddress").length === 0,
    `pct=${h.devPctOfSupply} present=${h.devAccountPresent} soldAll=${h.devSoldAll}`);

  // K. the creator's account in the book IS the ATA: counted once
  resetChain(); withoutDev(); CHAIN.largest.splice(1, 0, { address: ATA, amount: 30e12 }); CHAIN.owners[ATA] = CREATOR;
  h = await topHolders(MINT, SUPPLY_RAW, { bondingCurve: CURVE_PDA, creator: CREATOR, createdAt: young, now: NOW });
  const ownerCallK = rpcCalls("getMultipleAccounts").find((c) => c.params[1]?.encoding === "jsonParsed");
  ok("K. when the ATA already sits among the largest accounts it is neither re-requested nor double-counted",
    h.devPctOfSupply === 3 && ownerCallK.params[0].length === CHAIN.largest.length,
    `pct=${h.devPctOfSupply} keys=${ownerCallK.params[0].length} (largest=${CHAIN.largest.length})`);
}

console.log("\n3. THE LAUNCH MINUTE — read only off a tape that provably reaches birth");
{
  const born = NOW - 9 * MIN;
  const goat = tapeFrom(born, 10, 6189).map((k) => ({ ts: k.timestamp, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
  let m = momentumFrom(goat, { now: NOW, createdAt: born, curveOpenUsd: 5000, limit: BIRTH_TAPE_CANDLES });
  ok("GoatPro: $6,189 in the launch minute on a $5,000 curve reads launchVolShare 1.2378",
    m && m.firstCandle?.volUsd === 6189 && near(m.launchVolShare, 1.2378) && m.firstCandle.msAfterCreate === 0,
    `firstCandle=${JSON.stringify(m?.firstCandle)} share=${m?.launchVolShare} curveOpenUsd=${m?.curveOpenUsd}`);
  /* The create instant sits somewhere inside its minute, so "three buckets later" is not
     three minutes after creation. Anchor the birth ON a bucket edge for this reading, and
     separately show the unaligned case reads the true gap (3 min less the offset). */
  const bornAligned = bucket(born);
  const later = goat.map((k) => ({ ...k, ts: k.ts + 3 * MIN }));
  m = momentumFrom(later, { now: NOW, createdAt: bornAligned, curveOpenUsd: 5000, limit: BIRTH_TAPE_CANDLES });
  ok("a first trade three minutes after creation reports msAfterCreate 180000",
    m?.firstCandle?.msAfterCreate === 3 * MIN, `msAfterCreate=${m?.firstCandle?.msAfterCreate}`);
  m = momentumFrom(later, { now: NOW, createdAt: born, curveOpenUsd: 5000, limit: BIRTH_TAPE_CANDLES });
  ok("...and against an unaligned create instant it reports the true gap, not the bucket count",
    m?.firstCandle?.msAfterCreate === 3 * MIN - (born - bornAligned),
    `msAfterCreate=${m?.firstCandle?.msAfterCreate} = 180000 - ${born - bornAligned}ms offset into the birth minute`);
  const full = tapeFrom(NOW - 200 * MIN, BIRTH_TAPE_CANDLES, 6189).map((k) => ({ ts: k.timestamp, close: k.close, volume: k.volume }));
  m = momentumFrom(full, { now: NOW, createdAt: NOW - 200 * MIN, curveOpenUsd: 5000, limit: BIRTH_TAPE_CANDLES });
  ok("a tape that came back FULL (200 of 200) is cut somewhere: firstCandle null, share null — not a guess",
    m && m.firstCandle === null && m.launchVolShare === null, `candles=${m?.candles} firstCandle=${m?.firstCandle} share=${m?.launchVolShare}`);
  m = momentumFrom(goat, { now: NOW, createdAt: born, curveOpenUsd: null, limit: BIRTH_TAPE_CANDLES });
  ok("without a priced curve the minute is reported but the share is null",
    m?.firstCandle?.volUsd === 6189 && m.launchVolShare === null, `firstCandle.volUsd=${m?.firstCandle?.volUsd} share=${m?.launchVolShare}`);
  m = momentumFrom(goat, { now: NOW });
  ok("the ordinary sweep reading (no limit given) makes no launch claim at all",
    m && m.firstCandle === null && m.launchVolShare === null && typeof m.pct5m === "number",
    `firstCandle=${m?.firstCandle} share=${m?.launchVolShare} pct5m=${m?.pct5m?.toFixed(1)}`);
}

console.log("\n4. THE IGNITION SWEEP — the birth tape for nano/micro inside the window, forty for the rest");
{
  const row = (mint, symbol, mcap, ageMs) => ({ mint, symbol, name: symbol, usd_market_cap: mcap, total_supply: String(SUPPLY_RAW),
    created_timestamp: NOW - ageMs, last_trade_timestamp: NOW - MIN, reply_count: 5, ath_market_cap: mcap,
    virtual_sol_reserves: 32e9, real_sol_reserves: 2e9, virtual_token_reserves: 1043e12, real_token_reserves: 763e12,
    complete: false, creator: CREATOR });
  MARKET.listing = [row("NANO9", "N9", 9_000, 9 * MIN), row("MICRO5H", "M5", 30_000, 5 * 3600e3),
    row("LOW2H", "L2", 80_000, 2 * 3600e3), row("NANO8H", "N8", 8_000, 8 * 3600e3)];
  MARKET.tapes = new Map([
    ["NANO9", tapeFrom(NOW - 9 * MIN, 10, 6189)],
    ["MICRO5H", tapeFrom(NOW - 5 * 3600e3, BIRTH_TAPE_CANDLES, 6189)],   // full: cut somewhere
    ["LOW2H", tapeFrom(NOW - 2 * 3600e3, 12, 6189)],
  ]);
  NET.candleLimits.clear();
  const r = await ignitionSweep({ solUsd: MARKET.solUsd, now: NOW });
  const lim = (m) => NET.candleLimits.get(m);
  ok("nano inside its window (9m of 6h) and micro inside its (5h of 12h) asked for the 200-row birth tape",
    lim("NANO9") === BIRTH_TAPE_CANDLES && lim("MICRO5H") === BIRTH_TAPE_CANDLES,
    `NANO9 limit=${lim("NANO9")} MICRO5H limit=${lim("MICRO5H")} (nano window ${huntWindowMs("nano") / 3600e3}h, micro ${huntWindowMs("micro") / 3600e3}h)`);
  ok("a low-band coin got the ordinary forty; a nano coin past its window pulled no tape at all",
    lim("LOW2H") === 40 && lim("NANO8H") === undefined, `LOW2H limit=${lim("LOW2H")} NANO8H limit=${lim("NANO8H")}`);
  const n9 = r.ranked.find((c) => c.mint === "NANO9");
  ok("the nano coin's ranked row carries firstCandle and launchVolShare 1.2378 against its own curve",
    n9?.momentum?.firstCandle?.volUsd === 6189 && near(n9.momentum.launchVolShare, 1.2378) && near(n9.momentum.curveOpenUsd, 5000),
    `firstCandle=${JSON.stringify(n9?.momentum?.firstCandle)} share=${n9?.momentum?.launchVolShare} curveOpenUsd=${n9?.momentum?.curveOpenUsd?.toFixed(2)} curveOpenSol=${n9?.live?.curveOpenSol}`);
  const m5 = r.ranked.find((c) => c.mint === "MICRO5H");
  ok("the micro coin whose 200-row tape came back full makes no launch claim",
    m5?.momentum && m5.momentum.firstCandle === null && m5.momentum.launchVolShare === null,
    `candles=${m5?.momentum?.candles} firstCandle=${m5?.momentum?.firstCandle} share=${m5?.momentum?.launchVolShare}`);
  const l2 = r.ranked.find((c) => c.mint === "LOW2H");
  ok("the low-band coin has no launch share (no curve priced for it)",
    l2?.momentum && l2.momentum.launchVolShare === null, `share=${l2?.momentum?.launchVolShare}`);
  ok("no request escaped the stub", NET.unrouted.length === 0, NET.unrouted.join(" | ") || "none");
}

console.log("\n5. THE REAL gather() PUTS BOTH READINGS ON THE BUNDLE, AND THE REAL screen() REFUSES ONLY dev_dumped=true");
const MCAP = 9_000;
const fl = floorsFor(MCAP);
const BORN = NOW - 9 * MIN;
{
  MARKET.priceUsd = MCAP / 1e9;
  MARKET.pair = { chainId: "solana", dexId: "pumpfun", pairAddress: CURVE_PDA, url: "https://pump.fun/coin/" + MINT,
    baseToken: { symbol: "GOAT", name: "GoatPro" }, quoteToken: { symbol: "SOL" }, priceUsd: String(MARKET.priceUsd),
    /* Above the BAND's own floors (floorsFor), so the property — a coin the screen otherwise
       passes — holds if the floors move. */
    liquidity: { usd: fl.liq * 3 }, fdv: MCAP, marketCap: MCAP, pairCreatedAt: BORN,
    volume: { h24: fl.vol * 3 }, txns: { h24: { buys: fl.txns * 3, sells: fl.txns * 2 } }, priceChange: { m5: 3 } };
  MARKET.pfCoin = { mint: MINT, creator: CREATOR, created_timestamp: BORN, complete: false, usd_market_cap: MCAP,
    bonding_curve: CURVE_PDA, pool_address: null, virtual_sol_reserves: 32e9, real_sol_reserves: 2e9,
    virtual_token_reserves: 1043e12, real_token_reserves: 763e12, username: "goatdev", description: "GoatPro" };
  MARKET.tapes = new Map([[MINT, tapeFrom(BORN, 10, 6189)]]);

  // holding: the creator sits in the book with 3%
  resetChain(); NET.priceIds.length = 0; NET.candleLimits.clear();
  const ev = await gather(MINT, "test");
  ok("gather() succeeds on the fixture and reads it as a nano coin",
    ev.ok === true && ev.band === "nano", `ok=${ev.ok} band=${ev.band} error=${ev.error ?? "none"} age=${ev.pair?.ageHours}h`);
  ok("the Jupiter price request now carries SOL beside the coin (one request, two marks)",
    NET.priceIds.some((ids) => ids.includes(MINT) && ids.includes(MINTS.SOL)), JSON.stringify(NET.priceIds[0]));
  ok("holders on the bundle carry the creator's share, presence and (not) sold",
    ev.holders?.devPctOfSupply === 3 && ev.holders.devAccountPresent === true && ev.holders.devSoldAll === false && ev.holders.creator === CREATOR,
    `devPctOfSupply=${ev.holders?.devPctOfSupply} present=${ev.holders?.devAccountPresent} soldAll=${ev.holders?.devSoldAll}`);
  ok("momentum on the bundle carries the launch minute: 200-row birth tape, $6,189, share 1.2378",
    NET.candleLimits.get(MINT) === BIRTH_TAPE_CANDLES && ev.momentum?.firstCandle?.volUsd === 6189
    && near(ev.momentum.launchVolShare, 1.2378) && near(ev.momentum.curveOpenUsd, 5000),
    `limit=${NET.candleLimits.get(MINT)} firstCandle=${JSON.stringify(ev.momentum?.firstCandle)} share=${ev.momentum?.launchVolShare} curveOpenUsd=${ev.momentum?.curveOpenUsd?.toFixed(2)}`);
  const text = bundle(ev);
  ok("...and both are in the EVIDENCE BUNDLE string every seat reads",
    text.includes('"launchVolShare":1.2378') && text.includes('"devPctOfSupply":3') && text.includes('"devSoldAll":false'),
    `${text.length} chars; launchVolShare ${text.includes('"launchVolShare":1.2378')}, devPctOfSupply ${text.includes('"devPctOfSupply":3')}`);
  const sc = screen(ev);
  ok("the REAL screen passes a creator who is still holding — nothing fires on devSoldAll false",
    sc.pass === true, sc.fails.map((f) => f.code).join(",") || "no gate fired");

  // sold: the creator's ATA was funded and emptied 2 minutes ago, on a 9-minute-old coin
  resetChain(); withoutDev(); CHAIN.ata[ATA] = { owner: CREATOR, amount: 0 }; CHAIN.sigs = twoTxs;
  const ev2 = await gather(MINT, "test");
  const inWindow = (NOW - BORN) < DEV_SOLD_WINDOW_MS;
  ok(`a creator who sold reads devSoldAll ${inWindow ? "TRUE" : "null (fixture outside the window)"} off the real gather()`,
    ev2.ok && ev2.holders?.devSoldAll === (inWindow ? true : null),
    `age ${((NOW - BORN) / MIN).toFixed(1)}m of ${DEV_SOLD_WINDOW_MS / MIN}m window; soldAll=${ev2.holders?.devSoldAll} txs=${ev2.holders?.devAtaTxCount} pct=${ev2.holders?.devPctOfSupply}`);
  const sc2 = screen(ev2);
  ok("the REAL screen refuses it as dev_dumped, and names what it saw",
    sc2.pass === false && sc2.fails.some((f) => f.code === "dev_dumped" && /funded and is now empty/.test(f.detail)),
    sc2.fails.map((f) => `${f.code}: ${f.detail}`).join(" | ") || "nothing fired");
  const rec = { mint: MINT, symbol: "GOAT", outcome: "screened_out", fails: sc2.fails, ev: ev2, finalDecision: "screened_out" };
  const g = gateFailures(rec);
  ok("gateFailures classes it JUDGMENT — the coin is still sellable; the thesis is what is gone",
    g.length === 1 && g[0].code === "dev_dumped" && g[0].cls === "JUDGMENT", JSON.stringify(g.map((x) => `${x.code}=${x.cls}`)));
  /* The `safety` flag on this result is mandate.eligibility's (mandate.js:115-116), which
     labels EVERY screen refusal a safety decline whatever its code — too_big and too_small
     read the same way — so it is printed, not asserted. The classification that matters
     is gateFailures' (above), and the property that matters is that no level publishes. */
  const levels = Array.from({ length: MAX_ESCALATION_LEVEL + 1 }, (_, L) => cohortEligibility(rec, L));
  ok(`...and no level of the ladder (L0-L${MAX_ESCALATION_LEVEL}) publishes past it — JUDGMENT here has no knob`,
    levels.every((e) => e.publishable === false && e.gate === "dev_dumped"),
    levels.map((e, L) => `L${L}:${e.publishable}/${e.gate}`).join(" ") + ` (mandate safety flag: ${levels[0].safety})`);
  ok("no request escaped the stub during either gather", NET.unrouted.length === 0, NET.unrouted.join(" | ") || "none");
}

console.log("\n6. dev_dumped NEVER FIRES ON MISSING DATA, AND IS REGISTERED EXPLICITLY");
{
  /* The same fixture test-desk-says-what-and-when.mjs drives the real screen with. */
  const coin = (over = {}) => ({
    ok: true, mint: "Whn111111111111111111111111111111111111111", symbol: "WHEN",
    pair: { priceUsd: 1, liquidityUsd: 60_000, ageHours: 9, marketCap: 400_000,
      volume: { h24: 90_000 }, txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1 } },
    pairs: { count: 2, totalLiquidityUsd: 60_000 },
    derived: { totalLiquidityUsd: 60_000, volToLiqRatio: 1.5, fdvToLiqRatio: 7, txns24h: 700 },
    mintAccount: { ok: true, flags: [] }, holders: { ok: true, top1Pct: 8 },
    crosscheck: { verdicts: [] },
    exitProbe: { targetSizeUsd: 15, roundTripLossPct: 2 },
    ...over,
  });
  const codes = (ev) => screen(ev).fails.map((f) => f.code);
  const absent = [
    ["no creator fields at all", coin()],
    ["devSoldAll null", coin({ holders: { ok: true, top1Pct: 8, devSoldAll: null, devPctOfSupply: null } })],
    ["devSoldAll false", coin({ holders: { ok: true, top1Pct: 8, devSoldAll: false, devPctOfSupply: 3 } })],
    ["devSoldAll undefined with a dev share", coin({ holders: { ok: true, top1Pct: 8, devPctOfSupply: 40 } })],
    ["the string 'true' (not a boolean)", coin({ holders: { ok: true, top1Pct: 8, devSoldAll: "true" } })],
    ["devSoldAll true on an UNVERIFIED holder read", coin({ holders: { ok: false, error: "rpc 429", devSoldAll: true } })],
  ];
  for (const [label, ev] of absent) {
    const c = codes(ev);
    ok(`no dev_dumped on ${label}`, !c.includes("dev_dumped"), c.join(",") || "nothing fired");
  }
  const fired = codes(coin({ holders: { ok: true, top1Pct: 8, devSoldAll: true, devAtaTxCount: 2, devLastTxAt: NOW } }));
  ok("dev_dumped fires on devSoldAll === true and nothing else changes",
    fired.length === 1 && fired[0] === "dev_dumped", fired.join(",") || "nothing fired");
  ok("dev_dumped is in GATE_CLASS by name — never left to the SAFETY default",
    Object.hasOwn(GATE_CLASS, "dev_dumped") && gateClass("dev_dumped") === "JUDGMENT" && Object.isFrozen(GATE_CLASS),
    `GATE_CLASS.dev_dumped=${GATE_CLASS.dev_dumped}, frozen=${Object.isFrozen(GATE_CLASS)}`);
  ok("...it is not among the SAFETY gates, and it is among the JUDGMENT ones",
    !SAFETY_GATES.includes("dev_dumped") && JUDGMENT_GATES.includes("dev_dumped"),
    `${SAFETY_GATES.length} SAFETY codes untouched, ${JUDGMENT_GATES.length} JUDGMENT: ${JUDGMENT_GATES.join(", ")}`);
}

console.log("\n7. THE SHADOW LOG — 200 paid workups, precision/recall per proxy, promotion only past the bar");
{
  shadow._reset();
  /* 200 rows, 40 positives. Built so the answers are known:
   *   launch_share     36 of 40 positives >= 1, 6 of 160 negatives  -> precision 36/42 = 0.857, recall 0.9
   *   dev_holding      20 positives >= 10%, 40 negatives            -> precision 20/60 = 0.333
   *   dev_sold         measured on 30 rows only: 8 pos true, 2 neg  -> precision 0.8 but n = 30
   *   deployer_profile 12 positives flagged, 30 negatives           -> precision 12/42 = 0.286  */
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const positive = i < 40;
    const read = positive
      ? (i < 25 ? { verdict: "mixed", serial_rugger: true, paid_or_botted_signs: false, dev_handle: `@rug${i}` }
        : { verdict: "manufactured", serial_rugger: false, paid_or_botted_signs: true, dev_handle: `@paid${i}` })
      : { verdict: i % 3 === 0 ? "organic" : "mixed", serial_rugger: false, paid_or_botted_signs: false, dev_handle: `@dev${i}` };
    const launchShare = positive ? (i < 36 ? 1.2 + i * 0.01 : 0.4) : (i < 46 ? 1.05 : 0.3);
    const devPct = positive ? (i < 20 ? 12 : 2) : (i < 80 ? 15 : 1);
    // Measured on 30 rows only: positives 0-19 (true for 0-7) and negatives 160-169 (true for 160-161).
    const devSold = i < 20 ? i < 8 : (i >= 160 && i < 170) ? i < 162 : null;
    const priors = positive ? (i < 12 ? 4 : 0) : (i < 70 ? 5 : 1);
    const ev = { mint: `Shadow${i}`, symbol: `S${i}`, band: "nano", pair: { ageHours: 0.2, marketCap: 9_000 },
      holders: { ok: true, devPctOfSupply: devPct, devAccountPresent: true, devSoldAll: devSold },
      momentum: { launchVolShare: launchShare, firstCandle: { volUsd: launchShare * 5000, msAfterCreate: 0 }, curveOpenUsd: 5000 },
      deployer: { ok: true, priorLaunches: priors, graduated: 0, dead: priors } };
    rows.push([ev, read]);
    shadow.recordLaunchShadow(ev, read);
  }
  const card = shadow.proxyScorecard();
  console.log(`  rows=${card.rows} positives=${card.positives} bar=${card.bar} minRows=${card.minRows} minFlagged=${card.minFlagged}`);
  for (const [name, p] of Object.entries(card.proxies))
    console.log(`    ${name.padEnd(17)} n=${String(p.n).padStart(3)} flagged=${String(p.flagged).padStart(3)} tp=${p.tp} fp=${p.fp} fn=${p.fn} ` +
      `precision=${p.precision} recall=${p.recall} promotable=${p.promotable} — ${p.why}`);
  const P = card.proxies;
  ok("200 rows recorded with 40 positives (the read's two kill arms)", card.rows === 200 && card.positives === 40,
    `rows=${card.rows} positives=${card.positives}`);
  ok("launch_share: precision 0.857, recall 0.9 over 200 rows, 42 flagged — PROMOTABLE past the 0.8 bar",
    near(P.launch_share.precision, 0.857, 0.001) && near(P.launch_share.recall, 0.9, 0.001) && P.launch_share.n === 200
    && P.launch_share.flagged === 42 && P.launch_share.promotable === true,
    `precision=${P.launch_share.precision} recall=${P.launch_share.recall} n=${P.launch_share.n} flagged=${P.launch_share.flagged}`);
  ok("dev_holding: precision 0.333 — evidence only", near(P.dev_holding.precision, 0.333, 0.001) && P.dev_holding.promotable === false,
    `precision=${P.dev_holding.precision} recall=${P.dev_holding.recall}`);
  ok("dev_sold: precision 0.8 but only 30 rows measured — NOT promotable on sample alone",
    near(P.dev_sold.precision, 0.8, 0.001) && P.dev_sold.n === 30 && P.dev_sold.promotable === false && /sample/.test(P.dev_sold.why),
    `precision=${P.dev_sold.precision} n=${P.dev_sold.n} — ${P.dev_sold.why}`);
  ok("deployer_profile: precision 0.286 — evidence only", near(P.deployer_profile.precision, 0.286, 0.001) && P.deployer_profile.promotable === false,
    `precision=${P.deployer_profile.precision} recall=${P.deployer_profile.recall}`);
  ok("the stated bar and sample are the exported constants",
    shadow.PROMOTION_PRECISION_BAR === 0.8 && shadow.PROMOTION_MIN_ROWS === 200 && shadow.PROMOTION_MIN_FLAGGED === 10,
    `bar=${shadow.PROMOTION_PRECISION_BAR} rows=${shadow.PROMOTION_MIN_ROWS} flagged=${shadow.PROMOTION_MIN_FLAGGED}`);

  // One row short of the sample: the same 0.857 precision is not enough.
  shadow._reset();
  for (const [ev, read] of rows.slice(1)) shadow.recordLaunchShadow(ev, read);
  const short = shadow.proxyScorecard().proxies.launch_share;
  ok("with 199 rows the same proxy is NOT promotable — the sample is part of the bar",
    short.n === 199 && short.promotable === false && /sample/.test(short.why), `n=${short.n} precision=${short.precision} — ${short.why}`);

  // A row is written only beside a verdict; nothing recorded is ever read by the screen.
  ok("a workup with no read writes no row", shadow.recordLaunchShadow(rows[0][0], null) === null);
  /* The comments in evidence.js NAME the shadow log; what must not exist is an import of it
     or a call into it — so the check is on statements, not on the word. */
  const evidenceSrc = src("./src/data/evidence.js");
  const importsShadow = /from\s+["'][^"']*launch-shadow\.js["']/.test(evidenceSrc) || /import\(["'][^"']*launch-shadow/.test(evidenceSrc);
  const callsScorecard = /proxyScorecard\s*\(/.test(evidenceSrc) || /PROXIES\b/.test(evidenceSrc);
  ok("the screen never consults the scorecard — a promotable proxy still kills nothing until the owner wires it",
    !importsShadow && !callsScorecard, `imports launch-shadow.js: ${importsShadow}; calls the scorecard: ${callsScorecard}`);
  const deskSrc = src("./src/desk.js");
  const at = (re) => deskSrc.search(re);
  ok("desk.js writes the row right after the read comes back and before either arm acts on it",
    at(/await enrichWithXRead\(ev, hook\)/) < at(/recordLaunchShadow\(ev, read\)/) && at(/recordLaunchShadow\(ev, read\)/) < at(/const killArm =/),
    `enrich@${at(/await enrichWithXRead\(ev, hook\)/)} < record@${at(/recordLaunchShadow\(ev, read\)/)} < killArm@${at(/const killArm =/)}`);
}

console.log("\n8. THE BRIEFS NAME THE FIELDS, AND STAY CLEAN UNDER THE COST-IMPERATIVE SWEEP");
{
  ok("the Forensics brief names devPctOfSupply, devSoldAll and launchVolShare as EVIDENCE with null unmeasured",
    /holders\.devPctOfSupply/.test(FORENSICS_SYSTEM) && /holders\.devSoldAll/.test(FORENSICS_SYSTEM)
    && /momentum\.launchVolShare/.test(FORENSICS_SYSTEM) && /null/.test(FORENSICS_SYSTEM) && /EVIDENCE/.test(FORENSICS_SYSTEM));
  ok("the Best Pick brief names dev.pctOfSupply, dev.soldAll and launch.volShare",
    /dev\.pctOfSupply/.test(BESTPICK_SYSTEM) && /dev\.soldAll/.test(BESTPICK_SYSTEM) && /launch\.volShare/.test(BESTPICK_SYSTEM));
  const decisionSrc = src("./src/agents/decision.js");
  ok("the Best Pick candidate brief maps both readings off the bundle",
    /pctOfSupply: ev\.holders\?\.devPctOfSupply/.test(decisionSrc) && /soldAll: ev\.holders\?\.devSoldAll/.test(decisionSrc)
    && /volShare: ev\.momentum\?\.launchVolShare/.test(decisionSrc));
  for (const [name, text] of [["FORENSICS_SYSTEM", FORENSICS_SYSTEM], ["BESTPICK_SYSTEM", BESTPICK_SYSTEM]]) {
    const hits = costImperatives(text);
    ok(`${name} carries no cost-conditioned imperative`, hits.length === 0, hits[0]?.slice(0, 120) || `${text.length} chars swept, clean`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
