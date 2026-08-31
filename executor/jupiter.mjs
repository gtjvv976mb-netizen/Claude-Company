/**
 * Jupiter Swap V2 execution for WALL-ST-E.
 *
 * Only Metis is enabled for the first live release: one locally signed v0
 * transaction, one deterministic signature, and one recovery path. The exact
 * signed bytes are journaled before /execute ever sees them.
 */
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_PROGRAM = ComputeBudgetProgram.programId.toBase58();

// Anchor's eight-byte instruction discriminators. The first live canary accepts only
// v2 exact-in routes, whose safety fields have fixed offsets. Legacy v1 route plans put
// variable Borsh data before their limits; inferring those limits from a trailing tail
// is ambiguous and therefore fails closed.
const JUPITER_EXACT_IN = new Map([
  ["bb64facc31c4af14", { name: "route_v2", version: 2, shared: false }],
  ["d19853937cfed8e9", { name: "shared_accounts_route_v2", version: 2, shared: true }],
]);

const positiveRaw = (value, name) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${name} must be a positive integer`);
  return text;
};

const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
};

const sameKey = (key, expected) => key?.toBase58?.() === String(expected);
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
};
const sameRpcError = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Normalize Jupiter's two historically-used impact fields to percentage points.
 * `priceImpact` is already percentage points; `priceImpactPct` is a fraction.
 * Missing or contradictory safety data is never interpreted as zero. */
export function priceImpactPercent(order) {
  const hasImpact = order?.priceImpact !== undefined && order?.priceImpact !== null && order?.priceImpact !== "";
  const hasImpactPct = order?.priceImpactPct !== undefined && order?.priceImpactPct !== null && order?.priceImpactPct !== "";
  if (!hasImpact && !hasImpactPct) throw new Error("price impact is missing");
  const direct = hasImpact ? finite(order.priceImpact, "price impact") : null;
  const fractional = hasImpactPct ? finite(order.priceImpactPct, "priceImpactPct") * 100 : null;
  if (direct != null && fractional != null) {
    const tolerance = Math.max(1e-9, Math.abs(direct) * 1e-9, Math.abs(fractional) * 1e-9);
    if (Math.abs(direct - fractional) > tolerance)
      throw new Error("Jupiter returned conflicting price-impact fields");
  }
  return Math.abs(direct ?? fractional);
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${label} returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`${label} ${response.status}: ${body?.error || body?.errorMessage || "request failed"}`);
  return body;
}

export function validateOrderEnvelope(order, expected, cfg) {
  if (!order || typeof order !== "object") throw new Error("Jupiter order is missing");
  if (order.inputMint !== expected.inputMint) throw new Error("Jupiter changed the input mint");
  if (order.outputMint !== expected.outputMint) throw new Error("Jupiter changed the output mint");
  if (String(order.inAmount) !== String(expected.amountRaw)) throw new Error("Jupiter changed the raw input amount");
  if (order.taker !== expected.wallet) throw new Error("Jupiter changed the taker wallet");
  if (order.swapMode !== "ExactIn") throw new Error(`unsupported swap mode ${order.swapMode}`);
  if (order.router !== "metis") throw new Error(`unexpected router ${order.router}; first live release is Metis-only`);
  if (!order.transaction || typeof order.transaction !== "string")
    throw new Error(`Jupiter could not build the transaction (${order.errorCode ?? "no code"})`);
  if (!order.requestId || typeof order.requestId !== "string") throw new Error("Jupiter order omitted requestId");
  const expiry = Number(order.lastValidBlockHeight);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new Error("Jupiter order omitted a valid block-height expiry");
  positiveRaw(order.outAmount, "quoted output");
  positiveRaw(order.otherAmountThreshold, "minimum output");
  if (BigInt(order.otherAmountThreshold) > BigInt(order.outAmount)) throw new Error("minimum output exceeds quote output");
  const slippage = finite(order.slippageBps, "slippageBps");
  if (slippage < 0 || slippage > cfg.slippageBps) throw new Error(`slippage ${slippage} bps exceeds cap ${cfg.slippageBps}`);
  const impact = priceImpactPercent(order);
  if (impact > cfg.maxPriceImpactPct) throw new Error(`price impact ${impact}% exceeds cap ${cfg.maxPriceImpactPct}%`);
  const feeBps = finite(order.feeBps ?? 0, "feeBps");
  if (feeBps < 0 || feeBps > cfg.maxFeeBps) throw new Error(`Jupiter fee ${feeBps} bps exceeds cap ${cfg.maxFeeBps}`);
  const platformFeeBps = finite(order.platformFee?.feeBps ?? 0, "platformFee.feeBps");
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > feeBps || platformFeeBps > cfg.maxFeeBps)
    throw new Error(`Jupiter platform fee ${platformFeeBps} bps is invalid or exceeds the fee cap`);
  if (order.feeMint != null && ![expected.inputMint, expected.outputMint].includes(order.feeMint))
    throw new Error("Jupiter fee mint is outside the swap pair");
  if (order.platformFee?.feeMint != null && ![expected.inputMint, expected.outputMint].includes(order.platformFee.feeMint))
    throw new Error("Jupiter platform-fee mint is outside the swap pair");
  if (order.gasless === true) throw new Error("gasless orders are disabled for the local-custody canary");
  for (const field of ["signatureFeePayer", "prioritizationFeePayer", "rentFeePayer"]) {
    if (order[field] != null && order[field] !== expected.wallet)
      throw new Error(`${field} is not the local wallet`);
  }
  const signatureFee = finite(order.signatureFeeLamports ?? 0, "signature fee");
  const priorityFee = finite(order.prioritizationFeeLamports ?? 0, "priority fee");
  const rentFee = finite(order.rentFeeLamports ?? 0, "rent fee");
  if ([signatureFee, priorityFee, rentFee].some((value) => value < 0))
    throw new Error("Jupiter returned a negative fee estimate");
  const networkFees = signatureFee + priorityFee;
  if (networkFees > cfg.maxNetworkFeeLamports)
    throw new Error(`non-rent network fees ${networkFees} lamports exceed cap ${cfg.maxNetworkFeeLamports}`);
  const feeBasis = BigInt(String(expected.feeBasisLamports ?? expected.amountRaw));
  const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
  if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      BigInt(Math.ceil(networkFees)) * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`estimated network fees exceed ${maxNetworkFeePct}% of the trade basis`);
  if (rentFee > (cfg.maxRentLamports ?? 3_000_000))
    throw new Error(`rent ${rentFee} lamports exceeds cap ${cfg.maxRentLamports ?? 3_000_000}`);
  return order;
}

export function priceImpactCapForIntent(kind, cfg) {
  return kind === "entry" ? Number(cfg.maxPriceImpactPct) : Number(cfg.maxExitPriceImpactPct);
}

async function lookupTables(connection, message) {
  const tables = [];
  for (const lookup of message.addressTableLookups || []) {
    const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!response?.value) throw new Error(`address lookup table unavailable: ${lookup.accountKey.toBase58()}`);
    tables.push(response.value);
  }
  return tables;
}

function u32(data, offset = 1) {
  if (data.length < offset + 4) throw new Error("truncated compute-budget instruction");
  return Buffer.from(data).readUInt32LE(offset);
}

function u64(data, offset = 1) {
  if (data.length < offset + 8) throw new Error("truncated u64 instruction");
  return Buffer.from(data).readBigUInt64LE(offset);
}

function exactKey(meta, expected, label, { signer = false, writable = false } = {}) {
  if (!sameKey(meta?.pubkey, expected)) throw new Error(`${label} is not ${expected}`);
  if (signer && !meta?.isSigner) throw new Error(`${label} is not a signer`);
  if (writable && !meta?.isWritable) throw new Error(`${label} is not writable`);
}

export function associatedTokenAddress(wallet, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync([
    new PublicKey(wallet).toBuffer(),
    new PublicKey(tokenProgram).toBuffer(),
    new PublicKey(mint).toBuffer(),
  ], new PublicKey(ATA_PROGRAM))[0].toBase58();
}

async function mintTokenProgram(connection, mint) {
  if (mint === WSOL) return TOKEN_PROGRAM;
  const account = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
  if (!account) throw new Error(`mint account is unavailable: ${mint}`);
  const owner = account.owner?.toBase58?.();
  if (owner === TOKEN_2022_PROGRAM)
    throw new Error(`mint ${mint} uses Token-2022; the first live canary accepts classic SPL Token only`);
  if (owner !== TOKEN_PROGRAM)
    throw new Error(`mint ${mint} is not owned by classic SPL Token`);
  return TOKEN_PROGRAM;
}

const accountOwner = (account) => account?.owner?.toBase58?.() || String(account?.owner || "");
const accountData = (account) => {
  if (!account) return null;
  if (Buffer.isBuffer(account.data) || account.data instanceof Uint8Array) return Buffer.from(account.data);
  if (Array.isArray(account.data) && account.data[1] === "base64") return Buffer.from(account.data[0], "base64");
  throw new Error("RPC returned an unsupported account encoding");
};

function tokenAccountDetails(account) {
  const program = accountOwner(account);
  const data = accountData(account);
  if (!data) return null;
  const classic = program === TOKEN_PROGRAM && data.length === 165;
  const token2022 = program === TOKEN_2022_PROGRAM && data.length >= 166 && data[165] === 2;
  if (!classic && !token2022) return null;
  const optionKey = (offset, label) => {
    const tag = data.readUInt32LE(offset);
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`token account has an invalid ${label} option`);
    return new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58();
  };
  return {
    program,
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    delegate: optionKey(72, "delegate"),
    state: data[108],
    delegatedAmount: data.readBigUInt64LE(121),
    closeAuthority: optionKey(129, "close authority"),
  };
}

function assertSafeTokenAccount(details, label) {
  if (details.state !== 1) throw new Error(`${label} is not initialized and unfrozen`);
  if (details.delegate || details.delegatedAmount !== 0n)
    throw new Error(`${label} has delegated spending authority`);
  if (details.closeAuthority) throw new Error(`${label} has a close authority`);
}

function checkedTokenAmount(account, { program, mint, wallet, label, allowMissing = false }) {
  if (!account && allowMissing) return 0n;
  const details = tokenAccountDetails(account);
  if (!details) throw new Error(`${label} is not a supported token account`);
  if (details.program !== program || details.mint !== mint || details.owner !== wallet)
    throw new Error(`${label} is not the wallet's expected token account`);
  assertSafeTokenAccount(details, label);
  return details.amount;
}

export function classicWalletTokenAmount(account, { mint, wallet, allowMissing = false,
  label = "classic wallet token account" } = {}) {
  return checkedTokenAmount(account, {
    program: TOKEN_PROGRAM, mint, wallet, label, allowMissing,
  });
}

export function validateSimulationEffects(before, after, expected, cfg) {
  if (!before?.wallet || !after?.wallet) throw new Error("simulation omitted the local wallet account");
  for (const [label, account] of [["pre-simulation wallet", before.wallet], ["post-simulation wallet", after.wallet]]) {
    if (accountOwner(account) !== SYSTEM_PROGRAM) throw new Error(`${label} is no longer System Program owned`);
    if (account.executable !== false) throw new Error(`${label} executable flag is invalid`);
    const data = accountData(account);
    if (!data || data.length !== 0) throw new Error(`${label} contains unexpected account data`);
  }
  const walletBefore = BigInt(before.wallet.lamports);
  const walletAfter = BigInt(after.wallet.lamports);
  // A wrapped-SOL ATA may legitimately be absent before creation or after
  // CloseAccount. Whenever it does exist, it must still be canonical custody
  // with no delegate or close authority left behind by an inner CPI.
  if (expected.inputMint === WSOL) {
    checkedTokenAmount(before.input, {
      program: expected.inputProgram, mint: WSOL, wallet: expected.wallet,
      label: "pre-simulation wrapped-SOL source account", allowMissing: true,
    });
    checkedTokenAmount(after.input, {
      program: expected.inputProgram, mint: WSOL, wallet: expected.wallet,
      label: "post-simulation wrapped-SOL source account", allowMissing: true,
    });
  }
  if (expected.outputMint === WSOL) {
    checkedTokenAmount(before.output, {
      program: expected.outputProgram, mint: WSOL, wallet: expected.wallet,
      label: "pre-simulation wrapped-SOL destination account", allowMissing: true,
    });
    checkedTokenAmount(after.output, {
      program: expected.outputProgram, mint: WSOL, wallet: expected.wallet,
      label: "post-simulation wrapped-SOL destination account", allowMissing: true,
    });
  }
  const custodyLamports = (snapshot, label) => {
    let total = BigInt(snapshot.wallet.lamports);
    for (const account of [snapshot.input, snapshot.output]) {
      if (!account) continue;
      if (!Number.isSafeInteger(account.lamports) || account.lamports < 0)
        throw new Error(`${label} token account has an invalid lamport balance`);
      total += BigInt(account.lamports);
    }
    return total;
  };
  const custodyBefore = custodyLamports(before, "pre-simulation");
  const custodyAfter = custodyLamports(after, "post-simulation");
  const minOutput = BigInt(expected.minOutputRaw);
  if (expected.inputMint !== WSOL) {
    const pre = checkedTokenAmount(before.input, {
      program: expected.inputProgram, mint: expected.inputMint, wallet: expected.wallet,
      label: "pre-simulation source token account",
    });
    const post = checkedTokenAmount(after.input, {
      program: expected.inputProgram, mint: expected.inputMint, wallet: expected.wallet,
      label: "post-simulation source token account",
    });
    if (pre < post || pre - post !== BigInt(expected.amountRaw))
      throw new Error("simulation source-token delta does not equal the exact input");
  } else {
    // ATA rent moves lamports from the wallet into another wallet-owned account;
    // aggregate the observed custody set so only swap input + network fee leaves it.
    const spent = custodyBefore - custodyAfter;
    if (spent < BigInt(expected.amountRaw) ||
        spent > BigInt(expected.amountRaw) + BigInt(cfg.maxNetworkFeeLamports))
      throw new Error("simulation SOL spend is outside the exact input plus capped fees");
  }

  /* THE QUOTE MUST AGREE WITH THE CHAIN, NOT ONLY WITH ITSELF.
   * Until now every price-sanity number — impact, minOut, the round-trip preflight —
   * was authored by the same API response it was checking, so a low-balled quote
   * (outAmount at a fraction of fair value, minOut 3% under that) sailed through:
   * the instruction was self-consistent and the simulation check below only asked
   * `actual >= minOut`, which a garbage floor trivially passes. The wallet then signs
   * a transaction whose on-chain floor is far below fair value, and whoever sees it
   * in flight collects the difference.
   *
   * The simulation's ACTUAL output is the one number in this file the counterparty
   * cannot author — it comes from replaying the transaction against the real chain.
   * If the chain delivers materially MORE than the quote promised, the quote did not
   * describe the market; it described a floor somebody wanted signed. Refuse. */
  const quotedOutput = BigInt(positiveRaw(expected.quotedOutputRaw, "quoted output for simulation cross-check"));
  const shortfallCapPct = BigInt(Math.round(cfg.maxQuoteShortfallPct ?? 15));

  if (expected.outputMint !== WSOL) {
    const pre = checkedTokenAmount(before.output, {
      program: expected.outputProgram, mint: expected.outputMint, wallet: expected.wallet,
      label: "pre-simulation destination token account", allowMissing: true,
    });
    const post = checkedTokenAmount(after.output, {
      program: expected.outputProgram, mint: expected.outputMint, wallet: expected.wallet,
      label: "post-simulation destination token account",
    });
    if (post < pre || post - pre < minOutput)
      throw new Error("simulation destination-token delta is below the signed minimum output");
    if ((post - pre) * 100n > quotedOutput * (100n + shortfallCapPct))
      throw new Error(`the chain delivers ${post - pre} against a quote of ${quotedOutput} — the quote is more than ` +
        `${cfg.maxQuoteShortfallPct ?? 15}% below reality, so the signed minimum-output floor protects nothing; refusing`);
  } else {
    const receivedNet = custodyAfter - custodyBefore;
    if (receivedNet + BigInt(cfg.maxNetworkFeeLamports) < minOutput)
      throw new Error("simulation SOL proceeds are below the signed minimum after capped fees");
    if (receivedNet * 100n > quotedOutput * (100n + shortfallCapPct))
      throw new Error(`the chain delivers ${receivedNet} lamports against a quote of ${quotedOutput} — the quote is ` +
        `more than ${cfg.maxQuoteShortfallPct ?? 15}% below reality, so the signed minimum-output floor protects nothing; refusing`);
  }
  return true;
}

/** Decode and bind the fixed safety-critical fields of a Jupiter exact-in ix. */
export function decodeJupiterExactIn(data, expected) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 8) throw new Error("truncated Jupiter instruction discriminator");
  const variant = JUPITER_EXACT_IN.get(bytes.subarray(0, 8).toString("hex"));
  if (!variant) throw new Error("unsupported Jupiter instruction (exact-in route required)");

  const amountOffset = variant.shared ? 9 : 8;
  const routeCountOffset = variant.shared ? 31 : 30;
  if (bytes.length <= routeCountOffset + 4) throw new Error(`truncated Jupiter ${variant.name} instruction`);
  const amount = bytes.readBigUInt64LE(amountOffset);
  const quotedOut = bytes.readBigUInt64LE(amountOffset + 8);
  const slippageBps = bytes.readUInt16LE(amountOffset + 16);
  const platformFeeBps = bytes.readUInt16LE(amountOffset + 18);
  const positiveSlippageBps = bytes.readUInt16LE(amountOffset + 20);
  const routeSteps = bytes.readUInt32LE(routeCountOffset);

  if (!Number.isInteger(routeSteps) || routeSteps < 1 || routeSteps > 16)
    throw new Error(`Jupiter route-plan length ${routeSteps} is outside the canary limit`);
  if (amount !== BigInt(expected.amountRaw)) throw new Error("Jupiter instruction input amount does not match the intent");
  if (quotedOut !== BigInt(expected.quotedOutputRaw)) throw new Error("Jupiter instruction quote does not match the order");
  if (slippageBps !== Number(expected.slippageBps) || slippageBps > Number(expected.maxSlippageBps))
    throw new Error("Jupiter instruction slippage does not match the capped order");
  if (platformFeeBps !== Number(expected.platformFeeBps))
    throw new Error("Jupiter instruction platform fee does not match the capped order");
  if (positiveSlippageBps !== 0) throw new Error("Jupiter instruction contains an unrequested positive-slippage fee");
  const signedMinimum = quotedOut * BigInt(10_000 - slippageBps) / 10_000n;
  if (BigInt(expected.minOutputRaw) !== signedMinimum)
    throw new Error("Jupiter order minimum output does not match the signed instruction");
  return { ...variant, amount, quotedOut, slippageBps, platformFeeBps, positiveSlippageBps, routeSteps };
}

function validateRouteAccounts(ix, route, expected, tokenPrograms, atas) {
  const keys = ix.keys;
  const { input: inputProgram, output: outputProgram } = tokenPrograms;
  const { input: inputAta, output: outputAta } = atas;
  const sentinelOrDestination = (meta, label) => {
    const value = meta?.pubkey?.toBase58?.();
    if (value !== JUPITER_V6 && value !== outputAta) throw new Error(`${label} redirects output away from the local wallet`);
  };

  if (route.name === "route_v2") {
    if (keys.length < 10) throw new Error("Jupiter route_v2 account list is truncated");
    exactKey(keys[0], expected.wallet, "route_v2 transfer authority", { signer: true });
    exactKey(keys[1], inputAta, "route_v2 source token account", { writable: true });
    exactKey(keys[2], outputAta, "route_v2 destination token account", { writable: true });
    exactKey(keys[3], expected.inputMint, "route_v2 source mint");
    exactKey(keys[4], expected.outputMint, "route_v2 destination mint");
    exactKey(keys[5], inputProgram, "route_v2 source token program");
    exactKey(keys[6], outputProgram, "route_v2 destination token program");
    sentinelOrDestination(keys[7], "route_v2 optional destination");
    exactKey(keys[8], JUPITER_EVENT_AUTHORITY, "route_v2 event authority");
    exactKey(keys[9], JUPITER_V6, "route_v2 program account");
    return;
  }
  if (route.name === "shared_accounts_route_v2") {
    if (keys.length < 12) throw new Error("Jupiter shared route_v2 account list is truncated");
    exactKey(keys[1], expected.wallet, "shared route_v2 transfer authority", { signer: true });
    exactKey(keys[2], inputAta, "shared route_v2 source token account", { writable: true });
    exactKey(keys[5], outputAta, "shared route_v2 destination token account", { writable: true });
    exactKey(keys[6], expected.inputMint, "shared route_v2 source mint");
    exactKey(keys[7], expected.outputMint, "shared route_v2 destination mint");
    exactKey(keys[8], inputProgram, "shared route_v2 source token program");
    exactKey(keys[9], outputProgram, "shared route_v2 destination token program");
    exactKey(keys[10], JUPITER_EVENT_AUTHORITY, "shared route_v2 event authority");
    exactKey(keys[11], JUPITER_V6, "shared route_v2 program account");
  }
}

/** Resolve every v0 lookup and reject top-level capabilities the swap does not need. */
export async function validateTransaction(transaction, expected, cfg, connection) {
  const tx = transaction;
  const wallet = String(expected.wallet);
  const required = tx.message.header.numRequiredSignatures;
  const signers = tx.message.staticAccountKeys.slice(0, required).map((key) => key.toBase58());
  if (required !== 1 || signers[0] !== wallet)
    throw new Error(`transaction signer set is not exactly the local wallet (${signers.join(",")})`);
  if (tx.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("local wallet is not fee payer");

  const tables = await lookupTables(connection, tx.message);
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  if (message.payerKey.toBase58() !== wallet) throw new Error("decompiled payer is not the local wallet");
  if (message.instructions.some((ix) => ix.programId.toBase58() === TOKEN_2022_PROGRAM ||
      ix.keys.some((key) => key.pubkey.toBase58() === TOKEN_2022_PROGRAM)))
    throw new Error("Token-2022 routes are disabled for the first live canary");
  const [inputProgram, outputProgram] = await Promise.all([
    mintTokenProgram(connection, expected.inputMint),
    mintTokenProgram(connection, expected.outputMint),
  ]);
  const inputAta = associatedTokenAddress(wallet, expected.inputMint, inputProgram);
  const outputAta = associatedTokenAddress(wallet, expected.outputMint, outputProgram);
  const ata = new Map([[inputAta, expected.inputMint], [outputAta, expected.outputMint]]);
  const writableAddresses = [...new Set(message.instructions.flatMap((ix) =>
    ix.keys.filter((key) => key.isWritable).map((key) => key.pubkey.toBase58())))];
  if (writableAddresses.length > 64) throw new Error("transaction has too many writable accounts for safe inspection");
  const writableInfos = writableAddresses.length ? await connection.getMultipleAccountsInfo(
    writableAddresses.map((key) => new PublicKey(key)), "confirmed") : [];
  if (!Array.isArray(writableInfos) || writableInfos.length !== writableAddresses.length)
    throw new Error("RPC omitted writable-account capability data");
  for (let i = 0; i < writableAddresses.length; i++) {
    const details = tokenAccountDetails(writableInfos[i]);
    if (details?.owner === wallet && !ata.has(writableAddresses[i]))
      throw new Error(`unexpected wallet-owned token account is writable: ${writableAddresses[i]}`);
  }
  let jupiterRoutes = 0;
  let systemTransferLamports = 0n;
  let computeLimit = 1_400_000;
  let computePrice = 0n;

  // First collect only wallet-owned ATAs for the two expected mints.
  for (const ix of message.instructions) {
    if (ix.programId.toBase58() !== ATA_PROGRAM) continue;
    const opcode = ix.data.length ? ix.data[0] : 0;
    if (![0, 1].includes(opcode) || ix.keys.length < 6) throw new Error("unsupported ATA instruction");
    if (!sameKey(ix.keys[0].pubkey, wallet) || !sameKey(ix.keys[2].pubkey, wallet))
      throw new Error("ATA payer/owner is not the local wallet");
    const mint = ix.keys[3].pubkey.toBase58();
    if (![expected.inputMint, expected.outputMint].includes(mint)) throw new Error(`unexpected ATA mint ${mint}`);
    const tokenProgram = mint === expected.inputMint ? inputProgram : outputProgram;
    const expectedAta = mint === expected.inputMint ? inputAta : outputAta;
    exactKey(ix.keys[1], expectedAta, "associated token account", { writable: true });
    exactKey(ix.keys[5], tokenProgram, "associated-account token program");
  }

  for (const ix of message.instructions) {
    const program = ix.programId.toBase58();
    if (program === COMPUTE_PROGRAM) {
      const opcode = ix.data[0];
      if (opcode === 2) {
        computeLimit = u32(ix.data);
        if (computeLimit <= 0 || computeLimit > cfg.maxComputeUnits)
          throw new Error(`compute-unit limit ${computeLimit} exceeds cap`);
      } else if (opcode === 3) {
        computePrice = u64(ix.data);
      } else {
        throw new Error(`unsupported compute-budget opcode ${opcode}`);
      }
      continue;
    }
    if (program === ATA_PROGRAM) continue;
    if (program === SYSTEM_PROGRAM) {
      let kind;
      try { kind = SystemInstruction.decodeInstructionType(ix); }
      catch { throw new Error("unrecognized System Program instruction"); }
      if (kind !== "Transfer") throw new Error(`System Program ${kind} is not allowed`);
      const transfer = SystemInstruction.decodeTransfer(ix);
      const destination = transfer.toPubkey.toBase58();
      if (transfer.fromPubkey.toBase58() !== wallet || ata.get(destination) !== WSOL || expected.inputMint !== WSOL)
        throw new Error("arbitrary System Program transfer rejected");
      systemTransferLamports += BigInt(transfer.lamports);
      if (systemTransferLamports > BigInt(expected.amountRaw))
        throw new Error("wrapped-SOL transfers exceed the intended input");
      continue;
    }
    if (program === TOKEN_PROGRAM) {
      const opcode = ix.data[0];
      const account = ix.keys[0]?.pubkey?.toBase58();
      if (opcode === 17) { // SyncNative
        if (ata.get(account) !== WSOL) throw new Error("SyncNative targets an unexpected account");
      } else if (opcode === 9) { // CloseAccount
        if (ata.get(account) !== WSOL || !sameKey(ix.keys[1]?.pubkey, wallet) || !sameKey(ix.keys[2]?.pubkey, wallet))
          throw new Error("token cleanup does not return wrapped SOL to the local wallet");
      } else {
        // In particular: no Approve, SetAuthority, MintTo or Burn capability.
        throw new Error(`top-level token opcode ${opcode} is not allowed`);
      }
      continue;
    }
    if (program === JUPITER_V6) {
      jupiterRoutes++;
      const route = decodeJupiterExactIn(ix.data, {
        amountRaw: expected.amountRaw,
        quotedOutputRaw: expected.quotedOutputRaw,
        minOutputRaw: expected.minOutputRaw,
        slippageBps: expected.slippageBps,
        maxSlippageBps: cfg.slippageBps,
        platformFeeBps: expected.platformFeeBps,
      });
      validateRouteAccounts(ix, route, expected,
        { input: inputProgram, output: outputProgram }, { input: inputAta, output: outputAta });
      continue;
    }
    throw new Error(`unexpected top-level program ${program}`);
  }
  if (jupiterRoutes !== 1) throw new Error(`expected one Jupiter route, found ${jupiterRoutes}`);
  if (expected.inputMint === WSOL && systemTransferLamports !== BigInt(expected.amountRaw))
    throw new Error("wrapped-SOL transfer does not equal the exact input amount");
  const priority = (computePrice * BigInt(computeLimit) + 999_999n) / 1_000_000n;
  if (priority > BigInt(cfg.maxNetworkFeeLamports))
    throw new Error(`compute price implies ${priority} lamports, over the network-fee cap`);
  const feeBasis = BigInt(String(expected.feeBasisLamports ?? expected.amountRaw));
  const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
  if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      priority * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`compute priority fee exceeds ${maxNetworkFeePct}% of the trade basis`);
  return {
    message, tables, computeLimit, computePrice, jupiterRoutes,
    inputProgram, outputProgram, inputAta, outputAta,
  };
}

function ownerTokenAmount(balances, owner, mint) {
  let total = 0n;
  for (const row of balances || []) {
    if (row.owner === owner && row.mint === mint) total += BigInt(row.uiTokenAmount?.amount || "0");
  }
  return total;
}

function finalizedNetworkFee(meta, intent, config) {
  const feeNumber = Number(meta?.fee);
  if (!Number.isSafeInteger(feeNumber) || feeNumber < 0)
    throw new Error("finalized transaction has an invalid network fee");
  const feeLamports = BigInt(feeNumber);
  const maxNetworkFeeLamports = Number(config.maxNetworkFeeLamports ?? 500_000);
  if (!Number.isSafeInteger(maxNetworkFeeLamports) || maxNetworkFeeLamports < 0 || feeNumber > maxNetworkFeeLamports)
    throw new Error(`finalized network fee ${feeNumber} lamports exceeds cap ${maxNetworkFeeLamports}`);
  const relativeBasis = intent.inputMint === WSOL
    ? BigInt(intent.amountRaw)
    : BigInt(String(intent.context?.position?.costBasisLamports || "0"));
  const maxNetworkFeePct = Number(config.maxNetworkFeePct ?? 10);
  if (relativeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      feeLamports * 10_000n > relativeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`finalized network fee exceeds ${maxNetworkFeePct}% of the trade basis`);
  return { feeNumber, feeLamports };
}

function finalizedSignature(transaction) {
  const value = transaction?.transaction?.signatures?.[0];
  return typeof value === "string" ? value : null;
}

function finalizedAtMs(transaction) {
  const value = Number(transaction?.blockTime) > 0 ? Number(transaction.blockTime) * 1000 : null;
  return Number.isSafeInteger(value) ? value : null;
}

export function verifyFinalizedFailure(transaction, intent, signature, config = {}) {
  if (!transaction?.meta || transaction.meta.err == null)
    throw new Error("transaction is not a finalized on-chain failure");
  if (finalizedSignature(transaction) !== signature)
    throw new Error("finalized failed transaction signature mismatch");
  const { feeNumber } = finalizedNetworkFee(transaction.meta, intent, config);
  return { networkFeeLamports: String(feeNumber), finalizedAtMs: finalizedAtMs(transaction) };
}

export function verifyFinalizedFill(transaction, intent, fill, config = {}) {
  if (!transaction?.meta || transaction.meta.err != null) throw new Error("transaction is not a successful finalized swap");
  const signature = transaction.transaction?.signatures?.[0];
  if (typeof signature !== "string" || signature !== fill.signature)
    throw new Error("finalized transaction signature mismatch");
  const claimedInput = fill.totalInputAmount == null ? null : positiveRaw(fill.totalInputAmount, "actual input");
  const claimedOutput = fill.totalOutputAmount == null ? null : positiveRaw(fill.totalOutputAmount, "actual output");
  const meta = transaction.meta;
  const owner = intent.context?.wallet;
  if (!owner) throw new Error("intent is missing its wallet binding");
  const message = transaction.transaction?.message;
  const payer = message?.staticAccountKeys?.[0]?.toBase58?.() || message?.accountKeys?.[0]?.toBase58?.() ||
    String(message?.accountKeys?.[0] || "");
  if (payer !== owner) throw new Error("finalized transaction payer is not the intent wallet");
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
      !Number.isSafeInteger(meta.preBalances[0]) || !Number.isSafeInteger(meta.postBalances[0]))
    throw new Error("finalized transaction omitted wallet lamport balances");
  // Track the payer together with every touched wallet token account for this
  // pair. ATA creation/closure and pre-existing wrapped-SOL rent then cancel out,
  // leaving the actual SOL leg plus the transaction fee as an exact invariant.
  const walletIndices = new Set([0]);
  for (const row of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) {
    if (row.owner !== owner || ![intent.inputMint, intent.outputMint].includes(row.mint)) continue;
    const index = Number(row.accountIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= meta.preBalances.length || index >= meta.postBalances.length)
      throw new Error("finalized token balance has an invalid account index");
    walletIndices.add(index);
  }
  let beforeLamports = 0n;
  let afterLamports = 0n;
  for (const index of walletIndices) {
    if (!Number.isSafeInteger(meta.preBalances[index]) || !Number.isSafeInteger(meta.postBalances[index]))
      throw new Error("finalized transaction has an unsafe lamport balance");
    beforeLamports += BigInt(meta.preBalances[index]);
    afterLamports += BigInt(meta.postBalances[index]);
  }
  const { feeNumber, feeLamports } = finalizedNetworkFee(meta, intent, config);
  let actualInput;
  if (intent.inputMint !== WSOL) {
    const before = ownerTokenAmount(meta.preTokenBalances, owner, intent.inputMint);
    const after = ownerTokenAmount(meta.postTokenBalances, owner, intent.inputMint);
    actualInput = before - after;
    if (actualInput <= 0n) throw new Error("on-chain input-token delta is not positive");
    if (claimedInput != null && actualInput !== BigInt(claimedInput))
      throw new Error("on-chain input-token delta does not match Jupiter totals");
  } else {
    actualInput = beforeLamports - afterLamports - feeLamports;
    if (actualInput <= 0n) throw new Error("on-chain SOL spend is not positive");
    if (claimedInput != null && actualInput !== BigInt(claimedInput))
      throw new Error("on-chain SOL spend does not match Jupiter's actual input total");
  }
  if (actualInput !== BigInt(intent.amountRaw)) throw new Error("actual input does not match the exact-in intent");

  let actualOutput;
  if (intent.outputMint !== WSOL) {
    const before = ownerTokenAmount(meta.preTokenBalances, owner, intent.outputMint);
    const after = ownerTokenAmount(meta.postTokenBalances, owner, intent.outputMint);
    actualOutput = after - before;
    if (actualOutput <= 0n) throw new Error("on-chain output-token delta is not positive");
    if (claimedOutput != null && actualOutput !== BigInt(claimedOutput))
      throw new Error("on-chain output-token delta does not match Jupiter totals");
  } else {
    actualOutput = afterLamports - beforeLamports + feeLamports;
    if (actualOutput <= 0n) throw new Error("on-chain SOL proceeds are not positive");
    if (claimedOutput != null && actualOutput !== BigInt(claimedOutput))
      throw new Error("on-chain SOL proceeds do not match Jupiter's actual output total");
  }
  return { totalInputAmount: String(actualInput), totalOutputAmount: String(actualOutput),
    networkFeeLamports: String(feeNumber), finalizedAtMs: finalizedAtMs(transaction),
    signature: fill.signature };
}

export class JupiterV2Executor {
  constructor({ connection, secondaryConnection = null, keypair, journal, apiKey, baseUrl = "https://api.jup.ag/swap/v2",
    fetchFn = fetch, log = () => {}, now = () => Date.now(), sleep = sleepDefault,
    hardStop = () => false, submissionGate = () => {}, config = {} }) {
    if (!connection || !keypair || !journal) throw new Error("connection, keypair and journal are required");
    if (!apiKey) throw new Error("JUPITER_API_KEY is required for live execution");
    if (!String(baseUrl).startsWith("https://")) throw new Error("Jupiter API must use HTTPS");
    this.connection = connection;
    this.secondaryConnection = secondaryConnection;
    this.keypair = keypair;
    this.journal = journal;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.fetch = fetchFn;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.hardStop = hardStop;
    this.submissionGate = submissionGate;
    this.cfg = {
      slippageBps: 300,
      maxPriceImpactPct: 5,
      maxExitPriceImpactPct: 50,
      maxFeeBps: 100,
      maxNetworkFeeLamports: 500_000,
      maxNetworkFeePct: 10,
      maxRentLamports: 3_000_000,
      maxEntryRoundTripLossPct: 12,
      maxComputeUnits: 1_400_000,
      maxAttempts: 3,
      finalityTimeoutMs: 30_000,
      ...config,
    };
  }

  get wallet() { return this.keypair.publicKey.toBase58(); }
  headers(extra = {}) { return { "x-api-key": this.apiKey, ...extra }; }

  async order({ inputMint, outputMint, amountRaw, taker = true }) {
    positiveRaw(amountRaw, "order amount");
    const params = new URLSearchParams({
      inputMint, outputMint, amount: String(amountRaw), swapMode: "ExactIn",
      slippageBps: String(this.cfg.slippageBps),
      excludeRouters: "jupiterz,dflow,okx",
    });
    if (taker) params.set("taker", this.wallet);
    const response = await this.fetch(`${this.baseUrl}/order?${params}`, {
      headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    return jsonResponse(response, "Jupiter /order");
  }

  async quote(inputMint, outputMint, amountRaw) {
    const order = await this.order({ inputMint, outputMint, amountRaw, taker: false });
    if (order.inputMint !== inputMint || order.outputMint !== outputMint || String(order.inAmount) !== String(amountRaw))
      throw new Error("Jupiter quote did not echo the requested pair and amount");
    positiveRaw(order.outAmount, "quoted output");
    // Mark quotes must remain visible during a liquidity collapse so stop/age/desk-exit
    // policy can fire. The signed transaction applies the distinct entry/exit caps.
    priceImpactPercent(order);
    return order;
  }

  async preflightEntry(inputMint, outputMint, amountRaw) {
    const [forward, solUsd] = await Promise.all([
      this.quote(inputMint, outputMint, amountRaw),
      this.solUsdPrice(),
    ]);
    const reverse = await this.quote(outputMint, inputMint, String(forward.outAmount));
    const input = BigInt(positiveRaw(amountRaw, "preflight input"));
    const returned = BigInt(positiveRaw(reverse.outAmount, "preflight returned amount"));
    const lossPct = Number(input > returned ? (input - returned) * 1_000_000n / input : 0n) / 10_000;
    const cap = Number(this.cfg.maxEntryRoundTripLossPct);
    if (!Number.isFinite(cap) || cap < 0 || cap > 100) throw new Error("invalid entry round-trip-loss cap");
    if (lossPct > cap) throw new Error(`entry round-trip loss ${lossPct}% exceeds cap ${cap}%`);
    return { forward, reverse, lossPct, solUsd };
  }

  async solUsdPrice() {
    const quote = await this.quote(WSOL, USDC, "1000000000");
    const price = Number(BigInt(positiveRaw(quote.outAmount, "SOL/USDC quote output"))) / 1_000_000;
    if (!Number.isFinite(price) || price <= 0) throw new Error("SOL/USD quote is invalid");
    return price;
  }

  async _buildSigned(intent) {
    if (this.hardStop()) throw new Error("HARD STOP is present — no transaction will be built");
    const order = await this.order({
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, taker: true,
    });
    const impactCap = priceImpactCapForIntent(intent.kind, this.cfg);
    if (!Number.isFinite(impactCap) || impactCap < 0 || impactCap > 100)
      throw new Error(`invalid ${intent.kind === "entry" ? "entry" : "exit"} price-impact cap`);
    const feeBasisLamports = intent.inputMint === WSOL
      ? String(intent.amountRaw)
      : (() => {
          const beforeRaw = BigInt(String(intent.context?.position?.qtyRaw || "0"));
          const basisRaw = BigInt(String(intent.context?.position?.costBasisLamports || "0"));
          const sellRaw = BigInt(String(intent.amountRaw));
          if (beforeRaw <= 0n || basisRaw <= 0n || sellRaw <= 0n || sellRaw > beforeRaw)
            throw new Error("exit intent has no valid proportional fee basis");
          return String(sellRaw === beforeRaw ? basisRaw : basisRaw * sellRaw / beforeRaw);
        })();
    validateOrderEnvelope(order, {
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, wallet: this.wallet, feeBasisLamports,
    }, { ...this.cfg, maxPriceImpactPct: impactCap });
    let tx;
    try { tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64")); }
    catch { throw new Error("Jupiter returned an invalid versioned transaction"); }
    const validation = await validateTransaction(tx, {
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, wallet: this.wallet,
      quotedOutputRaw: String(order.outAmount),
      minOutputRaw: String(order.otherAmountThreshold),
      slippageBps: Number(order.slippageBps),
      platformFeeBps: Number(order.platformFee?.feeBps ?? 0),
      feeBasisLamports,
    }, this.cfg, this.connection);
    const observedAddresses = [this.wallet, validation.inputAta, validation.outputAta];
    const preAccounts = await this.connection.getMultipleAccountsInfo(
      observedAddresses.map((address) => new PublicKey(address)), "processed");
    if (!Array.isArray(preAccounts) || preAccounts.length !== observedAddresses.length || !preAccounts[0])
      throw new Error("RPC omitted pre-simulation wallet/account state");

    /* BOUND THE EXPIRY AGAINST THE CHAIN, NOT AGAINST THE ORDER'S OWN CLAIM.
     * validateOrderEnvelope only checks lastValidBlockHeight is a positive integer —
     * one order carrying 9e15 produced an attempt whose "wait for expiry" branch could
     * never fire: the journal held it as unresolved forever, and because an unresolved
     * intent blocks every new submission, EXITS included, all stops were disarmed
     * until a human intervened. The chain's real height is the one number the
     * counterparty does not author; a blockhash is only valid ~150 blocks, so an
     * expiry more than blockHeightWindow ahead is a lie whatever the intent. */
    const chainHeight = await this.connection.getBlockHeight("confirmed");
    const claimedExpiry = Number(order.lastValidBlockHeight);
    if (!Number.isSafeInteger(chainHeight) || chainHeight <= 0)
      throw new Error("could not read the chain block height to bound the order expiry");
    if (claimedExpiry <= chainHeight)
      throw new Error(`order expiry ${claimedExpiry} is already behind the chain height ${chainHeight}`);
    if (claimedExpiry > chainHeight + (this.cfg.blockHeightWindow ?? 600))
      throw new Error(`order expiry ${claimedExpiry} is ${claimedExpiry - chainHeight} blocks ahead of the chain ` +
        `(cap ${this.cfg.blockHeightWindow ?? 600}) — an unbounded expiry wedges the journal and disarms every exit`);

    tx.sign([this.keypair]);
    const signed = Buffer.from(tx.serialize());
    if (signed.length > 1232) throw new Error(`serialized transaction is ${signed.length} bytes (Solana max 1232)`);
    const signature = bs58.encode(Buffer.from(tx.signatures[0]));

    /* NOTHING EXTERNAL HAS SEEN THESE BYTES YET — and that is now the contract.
     * The simulation used to run right here, which sent the fully signed, broadcastable
     * transaction to the primary RPC BEFORE the journal had any record of it. An RPC
     * that broadcast what it was only asked to simulate (or a crash inside that call)
     * produced an on-chain buy the journal never knew existed: unmanaged, unstopped,
     * and invisible to the daily-cap accounting. The absence-proof machinery cannot
     * protect an attempt it never heard of. So _buildSigned now STOPS at the signed
     * bytes; executeIntent journals them first and only then runs _simulateSigned. */
    return {
      record: {
        requestId: order.requestId,
        signedTx: signed,
        signature,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: Number(order.lastValidBlockHeight),
        quotedOutputRaw: String(order.outAmount),
        minOutputRaw: String(order.otherAmountThreshold),
        order,
      },
      sim: { tx, observedAddresses, preAccounts, validation, order, intent },
    };
  }

  /** The pre-submission simulation, run only AFTER the signed bytes are journaled —
   * this call is itself a disclosure of broadcastable bytes to the primary RPC. */
  async _simulateSigned({ tx, observedAddresses, preAccounts, validation, order, intent }) {
    const simulation = await this.connection.simulateTransaction(tx, {
      commitment: "processed", sigVerify: true, replaceRecentBlockhash: false,
      accounts: { encoding: "base64", addresses: observedAddresses },
      innerInstructions: true,
    });
    if (simulation?.value?.err) throw new Error(`signed transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const postAccounts = simulation?.value?.accounts;
    if (!Array.isArray(postAccounts) || postAccounts.length !== observedAddresses.length)
      throw new Error("simulation omitted requested wallet/token account state");
    validateSimulationEffects({ wallet: preAccounts[0], input: preAccounts[1], output: preAccounts[2] },
      { wallet: postAccounts[0], input: postAccounts[1], output: postAccounts[2] }, {
        wallet: this.wallet,
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amountRaw: intent.amountRaw,
        minOutputRaw: String(order.otherAmountThreshold),
        quotedOutputRaw: String(order.outAmount),
        inputProgram: validation.inputProgram,
        outputProgram: validation.outputProgram,
      }, this.cfg);
    return true;
  }

  async _status(signature, connection = this.connection) {
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return result?.value?.[0] || null;
  }

  async _finalizedTransaction(signature, connection = this.connection) {
    if (typeof connection?.getTransaction !== "function") return null;
    return connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  }

  async _waitFinalized(signature) {
    const deadline = this.now() + this.cfg.finalityTimeoutMs;
    let observedStatus = false;
    let observedFinalized = false;
    do {
      const status = await this._status(signature);
      if (status) observedStatus = true;
      const isFinalized = status?.confirmationStatus === "finalized" || (status && status.confirmations === null);
      if (isFinalized) {
        observedFinalized = true;
        if (status.err) {
          const transaction = await this._finalizedTransaction(signature);
          return { outcome: "failed", error: status.err, transaction, observedStatus, observedFinalized };
        }
        const transaction = await this._finalizedTransaction(signature);
        if (transaction) return { outcome: "finalized", transaction, observedStatus, observedFinalized };
      }
      if (this.now() >= deadline) break;
      await this.sleep(1_000);
    } while (true);
    return { outcome: "pending", observedStatus, observedFinalized };
  }

  async _confirmFinalizedFailure(signature, { primaryError = null, secondaryError = null } = {}) {
    if (!this.secondaryConnection)
      return { confirmed: false, reason: "no independent secondary RPC is configured" };
    let primaryStatus, secondaryStatus;
    try {
      [primaryStatus, secondaryStatus] = await Promise.all([
        primaryError == null ? this._status(signature, this.connection) : null,
        secondaryError == null ? this._status(signature, this.secondaryConnection) : null,
      ]);
    } catch (error) {
      return { confirmed: false, reason: `independent failure check failed: ${error.message}` };
    }
    const primary = primaryError ?? ((primaryStatus?.confirmationStatus === "finalized" ||
      (primaryStatus && primaryStatus.confirmations === null)) ? primaryStatus.err : null);
    const secondary = secondaryError ?? ((secondaryStatus?.confirmationStatus === "finalized" ||
      (secondaryStatus && secondaryStatus.confirmations === null)) ? secondaryStatus.err : null);
    if (primary == null || secondary == null)
      return { confirmed: false, reason: "both RPCs did not report a finalized error" };
    if (!sameRpcError(primary, secondary))
      return { confirmed: false, reason: "RPCs reported different finalized errors" };
    return { confirmed: true, error: primary };
  }

  _acceptFinalized(intent, attempt, executeResult, transaction) {
    const durableJupiterSuccess = executeResult?.status === "Success" && Number(executeResult.code) === 0;
    if (durableJupiterSuccess && executeResult.signature !== attempt.signature) {
      const error = "Jupiter execute signature differs from the journaled signature";
      this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
      throw new Error(error);
    }
    let fill;
    try {
      // Finalized chain deltas are sufficient after a crash/transport timeout;
      // Jupiter totals, when durably available, remain an additional exact check.
      fill = verifyFinalizedFill(transaction, intent, durableJupiterSuccess
        ? executeResult : { signature: attempt.signature }, this.cfg);
    }
    catch (error) {
      this.journal.markAmbiguous(intent.id, attempt.attempt, error.message, executeResult);
      throw error;
    }
    if (BigInt(fill.totalOutputAmount) < BigInt(attempt.minOutputRaw)) {
      const error = "actual output is below the signed order's minimum";
      this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
      throw new Error(error);
    }
    const evidence = executeResult ?? {
      status: "RecoveredFromFinalizedChain", signature: attempt.signature,
    };
    this.journal.markConfirmed(intent.id, attempt.attempt, fill, evidence);
    return this.journal.getIntent(intent.id);
  }

  async _reconcile(intent, attempt, executeResult = attempt.execute) {
    const durableJupiterSuccess = executeResult?.status === "Success" && Number(executeResult.code) === 0;
    const finality = await this._waitFinalized(attempt.signature);
    if (finality.outcome === "failed") {
      const error = `transaction finalized with error: ${JSON.stringify(finality.error)}`;
      if (durableJupiterSuccess) {
        const conflict = `${error}; conflicts with Jupiter's confirmed-success response — manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
        throw new Error(conflict);
      }
      const consensus = await this._confirmFinalizedFailure(attempt.signature,
        { primaryError: finality.error });
      if (!consensus.confirmed) {
        const conflict = `${error}; independent RPC consensus unavailable (${consensus.reason}) — manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
        throw new Error(conflict);
      }
      if (!finality.transaction) {
        const conflict = `${error}; finalized failure metadata/fee is unavailable — manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
        throw new Error(conflict);
      }
      let feeEvidence;
      try { feeEvidence = verifyFinalizedFailure(finality.transaction, intent, attempt.signature, this.cfg); }
      catch (feeError) {
        const conflict = `${error}; failed-transaction fee verification failed: ${feeError.message}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
        throw new Error(conflict);
      }
      this.journal.markFinalizedFailure(intent.id, attempt.attempt, error, feeEvidence, executeResult);
      throw new Error(error);
    }
    if (finality.outcome === "finalized") {
      return this._acceptFinalized(intent, attempt, executeResult, finality.transaction);
    }
    const height = await this.connection.getBlockHeight("confirmed");
    if (height > attempt.lastValidBlockHeight) {
      // One RPC returning null is not proof that a transaction never landed. Cross-
      // check an independent history before permitting a replacement signature.
      if (!this.secondaryConnection) {
        const error = "primary RPC reports expiry but no secondary RPC can prove absence; manual reconciliation required";
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }
      let secondaryStatus, secondaryHeight;
      try {
        [secondaryStatus, secondaryHeight] = await Promise.all([
          this._status(attempt.signature, this.secondaryConnection),
          this.secondaryConnection.getBlockHeight("confirmed"),
        ]);
      } catch (error) {
        const reason = `secondary RPC could not prove expired signature absence: ${error.message}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, reason, executeResult);
        throw new Error(reason);
      }
      const secondaryFinalized = secondaryStatus?.confirmationStatus === "finalized" ||
        (secondaryStatus && secondaryStatus.confirmations === null);
      if (secondaryFinalized && secondaryStatus.err) {
        const error = `transaction finalized with error on secondary RPC: ${JSON.stringify(secondaryStatus.err)}`;
        if (durableJupiterSuccess || finality.observedFinalized) {
          const conflict = `${error}; conflicts with prior success evidence — manual reconciliation required`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        const consensus = await this._confirmFinalizedFailure(attempt.signature,
          { secondaryError: secondaryStatus.err });
        if (!consensus.confirmed) {
          const conflict = `${error}; independent RPC consensus unavailable (${consensus.reason}) — manual reconciliation required`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        const failedTransaction = await this._finalizedTransaction(attempt.signature, this.secondaryConnection);
        if (!failedTransaction) {
          const conflict = `${error}; finalized failure metadata/fee is unavailable — manual reconciliation required`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        let feeEvidence;
        try { feeEvidence = verifyFinalizedFailure(failedTransaction, intent, attempt.signature, this.cfg); }
        catch (feeError) {
          const conflict = `${error}; failed-transaction fee verification failed: ${feeError.message}`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        this.journal.markFinalizedFailure(intent.id, attempt.attempt, error, feeEvidence, executeResult);
        throw new Error(error);
      }
      if (secondaryFinalized) {
        const transaction = await this._finalizedTransaction(attempt.signature, this.secondaryConnection);
        if (!transaction) {
          const error = "secondary RPC sees finality but cannot return transaction metadata";
          this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
          throw new Error(error);
        }
        return this._acceptFinalized(intent, attempt, executeResult, transaction);
      }
      if (secondaryStatus || secondaryHeight <= attempt.lastValidBlockHeight)
        throw new Error(`transaction ${attempt.signature} is still unresolved on the secondary RPC`);

      // Jupiter code 0 is documented as confirmed, and any RPC observation means
      // the signature may have landed on a fork. Neither may ever be converted into
      // permission for a replacement signature merely because history is missing.
      if (durableJupiterSuccess || finality.observedStatus) {
        const evidence = durableJupiterSuccess ? "Jupiter reported confirmed success" :
          (finality.observedFinalized ? "primary RPC observed finality" : "primary RPC observed the signature");
        const error = `${evidence}, but finalized transaction metadata is unavailable; manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }

      let primaryBlockhash, secondaryBlockhash;
      try {
        [primaryBlockhash, secondaryBlockhash] = await Promise.all([
          this.connection.isBlockhashValid(attempt.blockhash, { commitment: "confirmed" }),
          this.secondaryConnection.isBlockhashValid(attempt.blockhash, { commitment: "confirmed" }),
        ]);
      } catch (error) {
        const reason = `two RPCs could not prove the signed blockhash expired: ${error.message}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, reason, executeResult);
        throw new Error(reason);
      }
      if (primaryBlockhash?.value !== false || secondaryBlockhash?.value !== false)
        throw new Error(`signed blockhash for ${attempt.signature} is still valid or unresolved; replacement refused`);
      // History absence is not non-execution proof on a pruned/non-archival RPC. Once
      // bytes reached /execute, never turn two null history reads into authority for a
      // replacement signature. Only an attempt still durably `signed` (never marked
      // submitted) may expire automatically.
      if (attempt.state === "submitted") {
        const error = "submitted signature is absent from two RPC histories after blockhash expiry; manual reconciliation required";
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }
      this.journal.markExpired(intent.id, attempt.attempt,
        "never-submitted signature absent and blockhash invalid on two independent RPCs after block-height expiry");
      throw new Error("never-submitted signed transaction expired on two RPCs; the intent may be rebuilt next tick");
    }
    throw new Error(`transaction ${attempt.signature} is unresolved; identical bytes will be retried`);
  }

  async _resume(intent, attempt) {
    // A received execute response is durable too; after a restart, query chain first
    // and never depend on building a replacement transaction.
    if (attempt.execute?.status === "Success" && Number(attempt.execute.code) === 0)
      return this._reconcile(intent, attempt, attempt.execute);
    if (this.hardStop()) return this._reconcile(intent, attempt, attempt.execute);
    if (intent.kind === "entry") {
      try { this.submissionGate(intent); }
      catch (error) {
        // A gate may close after bytes have already left this process. Never let a
        // new pause/staleness result deadlock recovery. Submitted bytes may have
        // landed; never-submitted signed bytes may expire only after the two-RPC
        // proof in _reconcile. Neither path sends /execute while the gate is closed.
        return this._reconcile(intent, attempt, attempt.execute);
      }
    }

    this.journal.markSubmitted(intent.id, attempt.attempt);
    let result;
    try {
      const response = await this.fetch(`${this.baseUrl}/execute`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          signedTransaction: attempt.signedTx.toString("base64"),
          requestId: attempt.requestId,
          lastValidBlockHeight: attempt.lastValidBlockHeight,
        }),
      });
      result = await jsonResponse(response, "Jupiter /execute");
      this.journal.recordExecuteResponse(intent.id, attempt.attempt, result);
    } catch (error) {
      this.log(`execute transport: ${error.message}; reconciling ${attempt.signature}`);
      return this._reconcile(intent, this.journal.latestAttempt(intent.id));
    }
    if (result.status === "Success" && Number(result.code) === 0)
      return this._reconcile(intent, this.journal.latestAttempt(intent.id), result);

    // A Failed HTTP response is not proof that a submitted Solana transaction did
    // not land. The signature and expiry decide that, never the transport message.
    return this._reconcile(intent, this.journal.latestAttempt(intent.id), result);
  }

  async executeIntent(spec) {
    let intent = this.journal.ensureIntent({
      ...spec,
      context: { ...(spec.context || {}), wallet: this.wallet },
    });
    if (intent.state === "accounted" || intent.state === "confirmed") return intent;
    if (intent.state === "ambiguous") throw new Error(`intent ${intent.id} is AMBIGUOUS; WALL-ST-E is disarmed`);
    const blocking = this.journal.hasBlockingIntent(intent.id);
    if (blocking) throw new Error(`unresolved intent ${blocking} blocks new submissions`);

    let attempt = this.journal.latestAttempt(intent.id);
    if (attempt && ["signed", "submitted"].includes(attempt.state)) return this._resume(intent, attempt);
    const count = this.journal.attempts(intent.id).length;

    /* EXITS ARE NOT EXHAUSTIBLE THE WAY ENTRIES ARE.
     * A flat cap of 3 was correct for entries — money not spent is money kept — and
     * catastrophic for exits: three SlippageToleranceExceeded failures during the
     * exact dump that fired the stop (the normal condition, not the rare one) left the
     * intent permanently dead, the position riding to zero, and new entries frozen
     * behind the latch. An exit may retry past maxAttempts ONLY while every prior
     * attempt is terminally resolved (anything live already returned via _resume
     * above, and hasBlockingIntent holds cross-intent), with a cooldown so a fast
     * dump cannot burn fees every tick, and never past maxExitAttempts — each
     * on-chain failure costs a real, accounted fee. */
    const isExit = intent.kind !== "entry";
    if (count >= this.cfg.maxAttempts) {
      if (!isExit) throw new Error(`intent ${intent.id} exhausted ${this.cfg.maxAttempts} attempts`);
      const exitCap = this.cfg.maxExitAttempts ?? 12;
      if (count >= exitCap) throw new Error(`exit intent ${intent.id} exhausted ${exitCap} attempts — manual intervention required`);
      const last = attempt?.updatedAt ?? attempt?.createdAt ?? 0;
      const coolMs = this.cfg.exitRetryCooldownMs ?? 60_000;
      if (this.now() - Number(last) < coolMs)
        throw new Error(`exit intent ${intent.id} is cooling down after attempt ${count} (${coolMs}ms between retries)`);
      this.log(`exit ${intent.id}: retrying past the entry cap — attempt ${count + 1} of ${exitCap}, all prior attempts terminally resolved`);
    }
    if (this.hardStop()) throw new Error("HARD STOP is present — no new submission");
    if (intent.kind === "entry") this.submissionGate(intent);

    /* Journal BEFORE the simulation discloses the bytes; see _buildSigned. A failed
     * simulation is marked SUBMITTED, not failed — the primary RPC has already seen
     * broadcastable bytes, so the attempt must ride the absence-proof reconciliation
     * (two RPCs agreeing the signature never landed, past its now-bounded expiry)
     * before any replacement may be signed. Marking it failed would let recordSigned
     * attach a fresh signature while the first could still land: the double-buy. */
    const built = await this._buildSigned(intent);
    attempt = this.journal.recordSigned(intent.id, { ...built.record, attempt: count + 1 });
    try {
      await this._simulateSigned(built.sim);
    } catch (error) {
      this.journal.markSubmitted(intent.id, attempt.attempt);
      throw new Error(`refused after signing: ${error.message} — the signed bytes were disclosed to the RPC, ` +
        `so the attempt is held for absence-proof reconciliation instead of being retried blind`);
    }
    intent = this.journal.getIntent(intent.id);
    return this._resume(intent, attempt);
  }

  async recoverPending() {
    const recovered = [];
    for (const intent of this.journal.pendingIntents()) {
      if (intent.state === "confirmed" || intent.state === "ambiguous") continue;
      const attempt = this.journal.latestAttempt(intent.id);
      if (!attempt) continue;
      try { recovered.push(await this._resume(intent, attempt)); }
      catch (error) { this.log(`recovery ${intent.id}: ${error.message}`); }
    }
    return recovered;
  }
}
