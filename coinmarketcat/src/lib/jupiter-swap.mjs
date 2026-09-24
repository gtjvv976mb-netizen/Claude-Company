/**
 * JUPITER, FOR THE xSTOCK VENUE: A QUOTE, A TRANSACTION, AND THE CHECK BEFORE SIGNING.
 *
 * Jupiter builds the transaction here, which the pump.fun lane never lets anyone do: that
 * lane encodes its own buy_v2 and decodes it back. So the whole weight of "what is being
 * signed" sits on the check in this file, and the check is a port of the executor's own —
 * upstream executor/jupiter.mjs `validateTransaction`, `decodeJupiterExactIn`,
 * `validateRouteAccounts` and `tokenAccountDetails` — which cannot be vendored because it
 * imports the SQLite journal. The port keeps every refusal that applies to a swap paid
 * in a token and drops the wrapped-SOL branches, because this venue never spends SOL on
 * a swap: it pays in the pool's own stock.
 *
 * WHAT WAS READ OFF THE LIVE API ON 2026-09-24 (fixtures/xstock-pools/jupiter-gldx-swap.json):
 *   · base https://api.jup.ag/swap/v1; keyless requests allowed at 0.5 a second (Jupiter's
 *     portal docs; responses carried x-ratelimit-remaining 4 of 5). lite-api.jup.ag is
 *     being retired and is not used.
 *   · GET /quote with onlyDirectRoutes=true and instructionVersion=V2 for GLDx → GAYMF
 *     returned one hop on the Raydium CPMM pool the discovery feed had found.
 *   · POST /swap for that quote returned a v0 transaction with one lookup table and four
 *     top-level instructions: compute-unit limit, compute-unit price, one idempotent
 *     associated-account create (the token's), and one Jupiter `route_v2` whose data held
 *     the input amount, the quoted output and the slippage at the offsets decoded below.
 *   · `priceImpactPct` is a FRACTION measured against Jupiter's reference price: 0.0126 at
 *     0.01 GLDx and 0.0258 at 1 GLDx, and the 1.32-point difference is the 1.34% worse
 *     effective rate the larger fill got.
 *   · `otherAmountThreshold` on /swap/v1 is the CEILING of out × (10000 − slippage) / 10000
 *     (three quotes, three round-ups); the executor's /swap/v2 path floors it. Either is
 *     accepted, and the lane's floor is the threshold itself, never below it.
 *   · A pool Jupiter cannot route answers HTTP 400 {"errorCode":"TOKEN_NOT_TRADABLE"} (the
 *     brand-new pump.fun curve quoted in GLDx did); that is a refusal by name, `no_route`.
 *
 * What is NOT known: whether /swap/v1 keeps answering (Jupiter calls it "no longer actively
 * maintained" and names /swap/v2/build its successor; no sunset date is published), and
 * how Jupiter routes a pool in its first seconds (its listing rules key a grace period to
 * the token's age). Both surface here as refusals, never as guesses.
 */
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../../vendor/executor/token2022.mjs";
import { ATA_PROGRAM, associatedTokenAddress, fromBase64 } from "./tx.mjs";

export const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
export const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const COMPUTE_PROGRAM = ComputeBudgetProgram.programId.toBase58();
/** Keyless: 0.5 requests a second, per the portal's rate-limit table. A little slack on top. */
export const JUPITER_KEYLESS_INTERVAL_MS = 2_100;
/** The compute-unit ceiling a Jupiter swap may ask for (its default limit is this). */
export const JUPITER_MAX_COMPUTE_UNITS = 1_400_000;
/** Codes Jupiter answers when it cannot price a pair. Each is `no_route` here. */
export const JUPITER_NO_ROUTE_CODES = Object.freeze(new Set([
  "NO_ROUTES_FOUND", "COULD_NOT_FIND_ANY_ROUTE", "TOKEN_NOT_TRADABLE", "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT",
]));

/* Anchor's eight-byte discriminators of the two exact-in instructions whose safety fields
   sit at fixed offsets (executor/jupiter.mjs JUPITER_EXACT_IN). Any other Jupiter
   instruction — the v1 `route`, an exact-out route — is refused: its limits follow a
   variable-length route plan and cannot be read without guessing. */
const JUPITER_EXACT_IN = new Map([
  ["bb64facc31c4af14", { name: "route_v2", shared: false }],
  ["d19853937cfed8e9", { name: "shared_accounts_route_v2", shared: true }],
]);

export class JupiterError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = "JupiterError"; this.code = code; this.detail = detail; }
}
/** A transaction the check refused. `clause` names which rule. */
export class SwapCheckError extends Error {
  constructor(clause, message, detail = {}) { super(message); this.name = "SwapCheckError"; this.clause = clause; this.detail = detail; }
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const positiveRaw = (v, label) => {
  const t = String(v ?? "");
  if (!/^\d+$/.test(t) || BigInt(t) <= 0n) throw new SwapCheckError("quote_malformed", `${label} must be a positive integer, got ${JSON.stringify(v)}`);
  return BigInt(t);
};

/* ── the client: two requests and a rate budget ──────────────────────────────────── */

/**
 * `priority` on each request:
 *   "live"        a sell, a live entry, a live mark: waits for the next slot (up to 15 s)
 *   "entry"       a first-notice evaluation: waits too
 *   "background"  a would-have row's mark: skipped (JupiterError "rate_budget") when no
 *                 slot is free now — a missed paper sample costs nothing, a late sell does
 */
export function createJupiterClient({
  fetchImpl = globalThis.fetch, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  baseUrl = JUPITER_SWAP_API, intervalMs = JUPITER_KEYLESS_INTERVAL_MS, timeoutMs = 10_000, maxWaitMs = 15_000,
} = {}) {
  let nextAt = 0;
  let backoffUntil = 0;
  const counters = { requests: 0, ok: 0, noRoute: 0, rateLimited: 0, errors: 0, skipped: 0 };
  let lastError = null;

  async function slot(priority) {
    const now = clock();
    const readyAt = Math.max(nextAt, backoffUntil);
    if (readyAt > now) {
      if (priority === "background") { counters.skipped++; throw new JupiterError("rate_budget", "no Jupiter request slot is free this tick (keyless: 0.5 a second)"); }
      if (readyAt - now > maxWaitMs) throw new JupiterError("rate_limited", `Jupiter asked for a pause until ${new Date(readyAt).toISOString()}`);
      await sleep(readyAt - now);
    }
    nextAt = Math.max(clock(), nextAt) + intervalMs;
  }

  async function request(path, { query = null, body = null, priority = "entry" } = {}) {
    await slot(priority);
    counters.requests++;
    const url = `${baseUrl}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? timers.setTimeout(() => controller.abort(), timeoutMs) : null;
    let res, text;
    try {
      res = await fetchImpl(url, {
        method: body === null ? "GET" : "POST", signal: controller?.signal,
        headers: body === null ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
    } catch (error) {
      counters.errors++; lastError = String(error?.message ?? error);
      throw new JupiterError("network", error?.name === "AbortError" ? `Jupiter did not answer inside ${timeoutMs}ms` : `Jupiter unreachable: ${lastError}`);
    } finally { if (timer !== null) timers.clearTimeout(timer); }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (res.status === 429) {
      counters.rateLimited++;
      const reset = Number(typeof res.headers?.get === "function" ? res.headers.get("x-ratelimit-reset") : NaN);
      const resetMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
      backoffUntil = Math.max(clock() + 10_000, Math.min(resetMs, clock() + 120_000));
      lastError = "HTTP 429";
      throw new JupiterError("rate_limited", "Jupiter answered 429: over the keyless rate limit");
    }
    if (!res.ok) {
      const code = isStr(parsed?.errorCode) ? parsed.errorCode : null;
      const message = isStr(parsed?.error) ? parsed.error : `HTTP ${res.status}`;
      if (code && JUPITER_NO_ROUTE_CODES.has(code)) { counters.noRoute++; throw new JupiterError("no_route", `${message} (${code})`, { errorCode: code }); }
      counters.errors++; lastError = `${res.status} ${code ?? ""} ${message}`.trim();
      throw new JupiterError("http", `Jupiter ${res.status}: ${message}${code ? ` (${code})` : ""}`, { status: res.status, errorCode: code });
    }
    if (parsed === null || typeof parsed !== "object") { counters.errors++; throw new JupiterError("malformed", "Jupiter answered with something that is not JSON"); }
    counters.ok++;
    return parsed;
  }

  return Object.freeze({
    /** An exact-in quote on DIRECT routes only: the pool pairs the two mints, and a hop
     *  through a third token would put accounts on the wallet this venue never checks. */
    quote({ inputMint, outputMint, amountRaw, slippageBps, priority = "entry" }) {
      return request("/quote", { priority, query: {
        inputMint, outputMint, amount: String(amountRaw), slippageBps: String(slippageBps), swapMode: "ExactIn",
        onlyDirectRoutes: "true", restrictIntermediateTokens: "true", instructionVersion: "V2",
      } });
    },
    /** The unsigned transaction for a quote, for `wallet`. No SOL wrapping (this venue never
     *  spends SOL on a swap), a fixed compute limit, the priority fee capped at the lane's. */
    swapTransaction({ quote, wallet, priorityFeeLamports, priority = "live" }) {
      return request("/swap", { priority, body: {
        quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: false, dynamicComputeUnitLimit: false,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Number(priorityFeeLamports), priorityLevel: "veryHigh", global: false } },
      } });
    },
    status() { const now = clock(); return { ...counters, lastError, nextSlotInMs: Math.max(0, nextAt - now), restingForMs: Math.max(0, backoffUntil - now) }; },
  });
}

/* ── the quote: does it say what was asked? ──────────────────────────────────────── */

/**
 * Port of executor/jupiter.mjs `validateOrderEnvelope` for the /swap/v1 quote shape. The
 * quote must echo the pair, the exact input and exact-in mode; its slippage must be the one
 * asked for and inside the cap; the minimum output must be the quoted output less that
 * slippage (either rounding); no platform fee; the impact inside the cap; and every hop
 * must go straight from the input to the output.
 */
export function checkQuote(quote, { inputMint, outputMint, amountRaw, slippageBps, slippageCapBps, maxPriceImpactPct }) {
  const q = quote ?? {};
  const bad = (clause, message) => { throw new SwapCheckError(clause, message); };
  if (q.inputMint !== inputMint) bad("quote_mismatch", `Jupiter quoted input ${q.inputMint}, not ${inputMint}`);
  if (q.outputMint !== outputMint) bad("quote_mismatch", `Jupiter quoted output ${q.outputMint}, not ${outputMint}`);
  if (String(q.inAmount) !== String(amountRaw)) bad("quote_mismatch", `Jupiter quoted an input of ${q.inAmount}, not the ${amountRaw} asked for`);
  if (q.swapMode !== "ExactIn") bad("quote_mismatch", `Jupiter quoted swap mode ${q.swapMode}, not ExactIn`);
  const slip = Number(q.slippageBps);
  if (!Number.isInteger(slip) || slip !== Number(slippageBps) || slip > Number(slippageCapBps))
    bad("quote_mismatch", `Jupiter quoted slippage ${q.slippageBps} bps; asked ${slippageBps}, cap ${slippageCapBps}`);
  const out = positiveRaw(q.outAmount, "outAmount");
  const min = positiveRaw(q.otherAmountThreshold, "otherAmountThreshold");
  if (min > out) bad("quote_mismatch", `the minimum output ${min} is above the quoted output ${out}`);
  const scaled = out * BigInt(10_000 - slip);
  const floor = scaled / 10_000n, ceil = (scaled + 9_999n) / 10_000n;
  if (min !== floor && min !== ceil) bad("quote_mismatch", `the minimum output ${min} is not ${out} less ${slip} bps (${floor}–${ceil})`);
  const fee = q.platformFee == null ? 0 : Number(q.platformFee.feeBps ?? q.platformFee.amount ?? NaN);
  if (q.platformFee != null && fee !== 0) bad("quote_mismatch", `the quote carries a platform fee (${JSON.stringify(q.platformFee)}); none was asked for`);
  const impactFraction = Number(q.priceImpactPct);
  if (!Number.isFinite(impactFraction)) bad("quote_malformed", `the quote's priceImpactPct is not a number (${JSON.stringify(q.priceImpactPct)})`);
  const impactPct = Math.abs(impactFraction) * 100;
  if (impactPct > Number(maxPriceImpactPct)) bad("impact_over_cap", `price impact ${impactPct.toFixed(3)}% is over the ${maxPriceImpactPct}% cap`);
  const hops = Array.isArray(q.routePlan) ? q.routePlan : [];
  if (!hops.length) bad("quote_malformed", "the quote has no route plan");
  let bps = 0;
  for (const h of hops) {
    const s = h?.swapInfo ?? {};
    if (s.inputMint !== inputMint || s.outputMint !== outputMint)
      bad("route_not_direct", `a hop goes ${s.inputMint} → ${s.outputMint}${s.label ? ` on ${s.label}` : ""}: only a direct ${inputMint} → ${outputMint} route is accepted`);
    bps += Number(h?.bps ?? 0);
  }
  if (bps !== 10_000) bad("route_not_direct", `the route's parts add up to ${bps} bps, not 10000`);
  return Object.freeze({ outRaw: out, minOutRaw: min, impactPct, slippageBps: slip,
    hops: Object.freeze(hops.map((h) => Object.freeze({ ammKey: h.swapInfo?.ammKey ?? null, label: h.swapInfo?.label ?? null, bps: Number(h.bps) }))) });
}

/* ── the transaction: decode, bind, refuse ───────────────────────────────────────── */

/** Port of executor/jupiter.mjs `decodeJupiterExactIn`: the fixed safety fields of a
 *  route_v2 / shared_accounts_route_v2, bound to what the quote said. */
export function decodeJupiterRoute(data, expected) {
  const bytes = Buffer.from(data || []);
  const bad = (message) => { throw new SwapCheckError("route_mismatch", message); };
  if (bytes.length < 8) bad("the Jupiter instruction is shorter than its discriminator");
  const variant = JUPITER_EXACT_IN.get(bytes.subarray(0, 8).toString("hex"));
  if (!variant) throw new SwapCheckError("route_unsupported", `Jupiter instruction ${bytes.subarray(0, 8).toString("hex")} is not an exact-in route_v2`);
  const amountOffset = variant.shared ? 9 : 8;
  const routeCountOffset = variant.shared ? 31 : 30;
  if (bytes.length <= routeCountOffset + 4) bad(`the ${variant.name} instruction is truncated`);
  const amount = bytes.readBigUInt64LE(amountOffset);
  const quotedOut = bytes.readBigUInt64LE(amountOffset + 8);
  const slippageBps = bytes.readUInt16LE(amountOffset + 16);
  const platformFeeBps = bytes.readUInt16LE(amountOffset + 18);
  const positiveSlippageBps = bytes.readUInt16LE(amountOffset + 20);
  const routeSteps = bytes.readUInt32LE(routeCountOffset);
  if (!(routeSteps >= 1 && routeSteps <= 16)) bad(`the route plan has ${routeSteps} steps`);
  if (amount !== BigInt(expected.amountRaw)) bad(`the instruction spends ${amount}, not the ticket's ${expected.amountRaw}`);
  if (quotedOut !== BigInt(expected.quotedOutRaw)) bad(`the instruction's quoted output ${quotedOut} is not the quote's ${expected.quotedOutRaw}`);
  if (slippageBps !== Number(expected.slippageBps) || slippageBps > Number(expected.slippageCapBps))
    bad(`the instruction's slippage is ${slippageBps} bps; the quote said ${expected.slippageBps}, the cap is ${expected.slippageCapBps}`);
  if (platformFeeBps !== 0) bad(`the instruction takes a ${platformFeeBps} bps platform fee`);
  if (positiveSlippageBps !== 0) bad(`the instruction takes an unrequested ${positiveSlippageBps} bps positive-slippage fee`);
  return Object.freeze({ ...variant, amount, quotedOut, slippageBps, routeSteps });
}

const keyOf = (meta) => meta?.pubkey?.toBase58?.() ?? null;
function exactKey(meta, expected, label, { signer = false, writable = false } = {}) {
  if (keyOf(meta) !== String(expected)) throw new SwapCheckError("route_accounts", `${label} is ${keyOf(meta)}, not ${expected}`);
  if (signer && !meta.isSigner) throw new SwapCheckError("route_accounts", `${label} is not a signer`);
  if (writable && !meta.isWritable) throw new SwapCheckError("route_accounts", `${label} is not writable`);
}

/** Port of executor/jupiter.mjs `validateRouteAccounts`: the route spends from the
 *  wallet's own input account, pays into its own output account, in the named mints and
 *  programs, and nowhere else. */
export function checkRouteAccounts(ix, route, { wallet, inputMint, outputMint, inputProgram, outputProgram, inputAta, outputAta }) {
  const k = ix.keys;
  if (route.name === "route_v2") {
    if (k.length < 10) throw new SwapCheckError("route_accounts", "the route_v2 account list is truncated");
    exactKey(k[0], wallet, "route_v2 transfer authority", { signer: true });
    exactKey(k[1], inputAta, "route_v2 source token account", { writable: true });
    exactKey(k[2], outputAta, "route_v2 destination token account", { writable: true });
    exactKey(k[3], inputMint, "route_v2 source mint");
    exactKey(k[4], outputMint, "route_v2 destination mint");
    exactKey(k[5], inputProgram, "route_v2 source token program");
    exactKey(k[6], outputProgram, "route_v2 destination token program");
    if (keyOf(k[7]) !== JUPITER_PROGRAM && keyOf(k[7]) !== outputAta) throw new SwapCheckError("route_accounts", "route_v2's optional destination sends the output away from the wallet");
    exactKey(k[8], JUPITER_EVENT_AUTHORITY, "route_v2 event authority");
    exactKey(k[9], JUPITER_PROGRAM, "route_v2 program account");
    return;
  }
  if (k.length < 12) throw new SwapCheckError("route_accounts", "the shared_accounts_route_v2 account list is truncated");
  exactKey(k[1], wallet, "shared route_v2 transfer authority", { signer: true });
  exactKey(k[2], inputAta, "shared route_v2 source token account", { writable: true });
  exactKey(k[5], outputAta, "shared route_v2 destination token account", { writable: true });
  exactKey(k[6], inputMint, "shared route_v2 source mint");
  exactKey(k[7], outputMint, "shared route_v2 destination mint");
  exactKey(k[8], inputProgram, "shared route_v2 source token program");
  exactKey(k[9], outputProgram, "shared route_v2 destination token program");
  exactKey(k[10], JUPITER_EVENT_AUTHORITY, "shared route_v2 event authority");
  exactKey(k[11], JUPITER_PROGRAM, "shared route_v2 program account");
}

/** The lookup-table addresses a transaction names, so the caller can resolve them on its
 *  own RPC before the check. An undecodable transaction names none; the check refuses it. */
export function lookupTableKeysOf(txBase64) {
  try { return (VersionedTransaction.deserialize(fromBase64(txBase64)).message.addressTableLookups ?? []).map((l) => l.accountKey.toBase58()); }
  catch { return []; }
}

/** The lookup tables a v0 message names, resolved from THIS lane's RPC (never from what
 *  Jupiter says they hold): each must exist and be owned by the lookup-table program. */
export async function loadLookupTables(rpc, addresses) {
  const list = [...new Set(addresses.map(String))];
  if (!list.length) return new Map();
  const read = await rpc.getMultipleAccounts(list);
  const out = new Map();
  list.forEach((address, i) => {
    const account = read.accounts?.[i];
    if (!account?.data) throw new SwapCheckError("lookup_table_unavailable", `lookup table ${address} was not found on this RPC`);
    if (String(account.owner) !== LOOKUP_TABLE_PROGRAM) throw new SwapCheckError("lookup_table_unavailable", `${address} is owned by ${account.owner}, not the lookup-table program`);
    const bytes = Array.isArray(account.data) ? Buffer.from(account.data[0], account.data[1] || "base64") : Buffer.from(account.data);
    let state;
    try { state = AddressLookupTableAccount.deserialize(bytes); }
    catch (error) { throw new SwapCheckError("lookup_table_unavailable", `lookup table ${address} does not decode: ${error.message}`); }
    out.set(address, new AddressLookupTableAccount({ key: new PublicKey(address), state }));
  });
  return out;
}

/**
 * THE CHECK BEFORE SIGNING. Port of executor/jupiter.mjs `validateTransaction`, for a swap
 * paid in a token. Refuses (SwapCheckError, by clause) unless:
 *   · the wallet is the fee payer and the ONLY signer;
 *   · every lookup table resolves from the lane's RPC and the message decompiles against it;
 *   · the only top-level programs are the compute budget (limit ≤ the cap, a price), the
 *     associated-token program (idempotent creates of the wallet's OWN account for the
 *     input or output mint, under that mint's program, paid by the wallet), and exactly one
 *     Jupiter exact-in route — no System transfer, no token instruction, nothing else;
 *   · the route spends exactly `amountRaw` from the wallet's input account into its output
 *     account, at the quote's output and slippage (inside the cap), with no fee of its own;
 *   · the priority fee its compute budget implies is inside `maxPriorityFeeLamports`.
 * It is pure: the lookup tables arrive resolved. What it returns (the writable accounts,
 * the two custody accounts) is what the lane pre-reads and simulates next.
 */
export function checkSwapTransaction({
  txBase64, wallet, inputMint, outputMint, inputProgram, outputProgram, amountRaw, quote,
  slippageCapBps, lookupTables = new Map(), maxPriorityFeeLamports, maxComputeUnits = JUPITER_MAX_COMPUTE_UNITS,
}) {
  const bad = (clause, message) => { throw new SwapCheckError(clause, message); };
  for (const [label, program] of [["input", inputProgram], ["output", outputProgram]])
    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) bad("token_program", `the ${label} mint's program ${program} is not a token program`);
  let tx;
  try { tx = VersionedTransaction.deserialize(fromBase64(txBase64)); }
  catch (error) { bad("malformed", `the transaction Jupiter returned does not decode: ${error.message}`); }
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  const required = msg.header.numRequiredSignatures;
  if (required !== 1 || staticKeys[0] !== wallet)
    bad("signers", `the transaction's signers are ${staticKeys.slice(0, required).join(", ") || "none"}; only ${wallet} may sign it`);
  const lookups = msg.addressTableLookups ?? [];
  const tables = lookups.map((l) => {
    const t = lookupTables.get(l.accountKey.toBase58());
    if (!t) bad("lookup_table_unavailable", `lookup table ${l.accountKey.toBase58()} was not resolved`);
    return t;
  });
  let message;
  try { message = TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables }); }
  catch (error) { bad("lookup_table_mismatch", `the message does not decompile against its lookup tables: ${error.message}`); }
  if (message.payerKey.toBase58() !== wallet) bad("signers", `the fee payer is ${message.payerKey.toBase58()}, not ${wallet}`);

  const inputAta = associatedTokenAddress(wallet, inputMint, inputProgram);
  const outputAta = associatedTokenAddress(wallet, outputMint, outputProgram);
  const programOf = new Map([[inputMint, inputProgram], [outputMint, outputProgram]]);
  const ataOf = new Map([[inputMint, inputAta], [outputMint, outputAta]]);
  let routes = 0, route = null, computeLimit = null, computePrice = 0n;
  const createdAtas = [];
  for (const ix of message.instructions) {
    const program = ix.programId.toBase58();
    for (const meta of ix.keys) if (meta.isSigner && keyOf(meta) !== wallet) bad("signers", `${program} asks ${keyOf(meta)} to sign`);
    if (program === COMPUTE_PROGRAM) {
      const d = Buffer.from(ix.data);
      if (d[0] === 2 && d.length >= 5) {
        computeLimit = d.readUInt32LE(1);
        if (!(computeLimit > 0 && computeLimit <= maxComputeUnits)) bad("compute_budget", `a compute-unit limit of ${computeLimit} is outside 1..${maxComputeUnits}`);
      } else if (d[0] === 3 && d.length >= 9) computePrice = d.readBigUInt64LE(1);
      else bad("compute_budget", `compute-budget instruction ${d[0]} is not one this lane accepts`);
      continue;
    }
    if (program === ATA_PROGRAM) {
      const opcode = ix.data.length ? ix.data[0] : 0;
      if (![0, 1].includes(opcode) || ix.keys.length < 6) bad("account_create", "an associated-token instruction other than a create");
      if (keyOf(ix.keys[0]) !== wallet || keyOf(ix.keys[2]) !== wallet) bad("account_create", `an account create is paid by ${keyOf(ix.keys[0])} or owned by ${keyOf(ix.keys[2])}, not the wallet`);
      const mint = keyOf(ix.keys[3]);
      if (!programOf.has(mint)) bad("account_create", `an account create for ${mint}, which is neither side of this swap`);
      if (keyOf(ix.keys[1]) !== ataOf.get(mint)) bad("account_create", `the account created for ${mint} is ${keyOf(ix.keys[1])}, not the wallet's own ${ataOf.get(mint)}`);
      if (keyOf(ix.keys[5]) !== programOf.get(mint)) bad("account_create", `the account for ${mint} is created under ${keyOf(ix.keys[5])}, not its mint's program`);
      createdAtas.push(ataOf.get(mint));
      continue;
    }
    if (program === JUPITER_PROGRAM) {
      routes++;
      route = decodeJupiterRoute(ix.data, { amountRaw, quotedOutRaw: quote.outAmount, slippageBps: quote.slippageBps, slippageCapBps });
      checkRouteAccounts(ix, route, { wallet, inputMint, outputMint, inputProgram, outputProgram, inputAta, outputAta });
      continue;
    }
    /* A System transfer, a token instruction, a memo, anything else: this swap needs none. */
    bad("program_not_allowed", `the transaction calls ${program}, which a ${inputMint} → ${outputMint} swap does not need`);
  }
  if (routes !== 1) bad("route_count", `the transaction holds ${routes} Jupiter routes, not one`);
  if (createdAtas.length > 2) bad("account_create", `${createdAtas.length} account creates`);
  const limit = BigInt(computeLimit ?? 200_000 * message.instructions.length);
  const priorityFeeLamports = (computePrice * limit + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > BigInt(maxPriorityFeeLamports))
    bad("priority_fee_over_budget", `the compute budget implies a ${priorityFeeLamports} lamport priority fee, over the ${maxPriorityFeeLamports} this lane allows`);
  const writableAddresses = [...new Set(message.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map(keyOf)))];
  if (writableAddresses.length > 64) bad("too_many_writable", `${writableAddresses.length} writable accounts is more than can be inspected`);
  return Object.freeze({
    route, priorityFeeLamports, computeUnitLimit: Number(limit), computeUnitPrice: computePrice,
    createdAtas: Object.freeze(createdAtas), inputAta, outputAta, writableAddresses: Object.freeze(writableAddresses),
    lookupTables: Object.freeze(lookups.map((l) => l.accountKey.toBase58())),
  });
}

/* ── token accounts: whose, and who else can move them ───────────────────────────── */

/** Port of executor/jupiter.mjs `tokenAccountDetails`: a Token or Token-2022 account's
 *  mint, owner, amount, delegate and close authority, or null when it is not one. */
export function tokenAccountDetails(account) {
  if (!account?.data) return null;
  const program = String(account.owner ?? "");
  const data = Array.isArray(account.data) ? Buffer.from(account.data[0], account.data[1] || "base64") : Buffer.from(account.data);
  const classic = program === TOKEN_PROGRAM && data.length === 165;
  const t22 = program === TOKEN_2022_PROGRAM && (data.length === 165 || (data.length >= 166 && data[165] === 2));
  if (!classic && !t22) return null;
  const optionKey = (offset) => { const tag = data.readUInt32LE(offset); if (tag === 0) return null; if (tag !== 1) throw new SwapCheckError("custody", "a token account has an invalid option tag"); return new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58(); };
  return Object.freeze({
    program, mint: new PublicKey(data.subarray(0, 32)).toBase58(), owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64), delegate: optionKey(72), state: data[108], delegatedAmount: data.readBigUInt64LE(121), closeAuthority: optionKey(129),
  });
}

/** No token account the wallet owns may be writable in the swap except the two it trades
 *  through: a route that touches the wallet's other balances is refused. `accounts` is the
 *  lane's own read of `writableAddresses`, in order. */
export function checkWritableCustody({ wallet, writableAddresses, accounts, allowed }) {
  const ok = new Set(allowed);
  writableAddresses.forEach((address, i) => {
    let d = null;
    try { d = tokenAccountDetails(accounts[i]); } catch (error) { throw new SwapCheckError("custody", `${address}: ${error.message}`); }
    if (d && d.owner === wallet && !ok.has(address)) throw new SwapCheckError("custody", `the swap writes to ${address}, another token account of this wallet (${d.mint})`);
  });
}

/** After the simulation: the two custody accounts are initialised, unfrozen, and nobody
 *  else may spend or close them (executor/jupiter.mjs `assertSafeTokenAccount`). */
export function checkSafeAfter(account, { wallet, mint, label }) {
  const d = tokenAccountDetails(account);
  if (!d) throw new SwapCheckError("custody", `after the simulation the ${label} account is not a token account`);
  if (d.owner !== wallet || d.mint !== mint) throw new SwapCheckError("custody", `after the simulation the ${label} account belongs to ${d.owner} in ${d.mint}`);
  if (d.state !== 1) throw new SwapCheckError("custody", `after the simulation the ${label} account is not initialised and unfrozen`);
  if (d.delegate || d.delegatedAmount !== 0n) throw new SwapCheckError("custody", `after the simulation the ${label} account has a delegate (${d.delegate})`);
  if (d.closeAuthority) throw new SwapCheckError("custody", `after the simulation the ${label} account has a close authority (${d.closeAuthority})`);
}
