/**
 * THE CREATOR-FEE CLAIM, AS A TICKET THE OWNER SIGNS — and nothing here can sign it.
 *
 * pump.fun pays a coin's creator fee to the creator, so the claim must be signed by the wallet
 * that created the coin. For $CLAUDECO that is 3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3 — a
 * wallet the owner holds, and emphatically NOT the bot's burner.
 *
 * bagworkagent.fun's server signs on its agents' behalf: it holds the keys. That is the obvious
 * design and it is the wrong one here, because the alternative to "the server holds the key" is
 * not "the bot holds the key" — the bot's whole security story is that the only key on that disk
 * is a burner generated there and funded deliberately. Putting a real creator wallet next to it
 * would widen the blast radius of every other thing on that machine for the sake of a claim that
 * happens a few times a month.
 *
 * So the split is:
 *
 *   the bot     READS the vaults on a timer and reports what is claimable (fee-lane.mjs, dry)
 *   the desk    BUILDS the unsigned instructions, from the layout proved against mainnet
 *   the owner   SIGNS in their own wallet, once, and the wallet submits it
 *
 * Nothing in this file holds a key, constructs a signature, or produces a transaction anybody but
 * the creator could send. The instruction descriptors it returns are not a secret and are not
 * treated as one: anyone can derive them from a public address, and the only thing that makes the
 * transaction go through is a signature only the creator can make. An endpoint that gated them
 * would be implying a secrecy that does not exist.
 *
 * THE LAYOUT IS NOT RE-IMPLEMENTED HERE. `buildFeeClaim` in executor/pumpfun-fees.mjs is the one
 * copy, checked against three transactions that landed on mainnet, including the seed trap where
 * the bonding curve spells it `creator-vault` and pump-amm spells it `creator_vault`. Re-deriving
 * those addresses in a web page — where nothing tests them — is how the wrong vault gets claimed
 * and nobody finds out, so this file reaches for the proven module and serialises what it
 * produces.
 */

import { isAddress } from "./lib/base58.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** The rent-exempt minimum for a data-less system account, measured on mainnet 2026-09-26
 *  (`getMinimumBalanceForRentExemption(0)` -> 650240). The curve's creator vault is such an
 *  account, so this much of its balance can never move and is not revenue. Kept in step with
 *  executor/fee-lane.mjs's SYSTEM_RENT_EXEMPT_LAMPORTS, which the test asserts. */
export const RENT_RESERVE_LAMPORTS = 650_240;

export class FeeClaimError extends Error {
  constructor(clause, message) {
    super(message);
    this.name = "FeeClaimError";
    this.clause = clause;
  }
}

/**
 * The proven claim builder, loaded from the executor package.
 *
 * DYNAMIC, AND CAUGHT. `@solana/web3.js` is a dependency of executor/, not of the desk — the
 * desk's Render build installs both (`npm ci && npm ci --prefix executor`), and Node resolves the
 * library from the importing file's own directory, so this works there exactly as
 * ../executor/hawk-status.mjs already does. A checkout with only the root deps installed is a
 * real situation though, and it must produce a named refusal rather than a stack trace on a
 * route: the desk's other fifty endpoints have nothing to do with this one.
 */
async function claimModule() {
  try {
    return await import("../executor/pumpfun-fees.mjs");
  } catch (error) {
    throw new FeeClaimError("module_unavailable",
      "the claim builder could not be loaded — it lives in the executor package, whose dependencies "
      + `are installed separately (npm ci --prefix executor). Underlying error: ${String(error?.message ?? error)}`);
  }
}

const requireCreator = (creator) => {
  const addr = String(creator ?? "").trim();
  if (!isAddress(addr))
    throw new FeeClaimError("creator_invalid", `${JSON.stringify(creator)} is not a base58 Solana address`);
  return addr;
};

/**
 * Where a creator's two fee vaults are. Pure derivation, no network.
 *
 * TWO PROGRAMS, TWO VAULTS, and a claim that reads one leaves the other's money sitting there:
 * the bonding curve holds its fee in a system account, and once a coin bonds, trading moves to
 * pump-amm which accrues into a wrapped-SOL token account instead. $CLAUDECO has bonded, so its
 * live accrual is on the second.
 */
export async function vaultsFor(creator) {
  const owner = requireCreator(creator);
  const fees = await claimModule();
  return Object.freeze({
    creator: owner,
    curveVault: fees.curveCreatorVault(owner),
    ammVaultAuthority: fees.ammCreatorVaultAuthority(owner),
    ammVaultAta: fees.ammCreatorVaultAta(owner),
  });
}

/**
 * What is actually claimable, read from the chain.
 *
 * `rpcGet` is INJECTED — `(method, params) => ({ok, data})`, the shape src/lib/http.js's readRpc
 * already returns — so a test drives an empty vault, a missing account and a dead node with no
 * network at all.
 *
 * A MISSING ACCOUNT IS A DEFINITE ZERO; AN UNREADABLE ONE IS NOT. `getBalance` answers 0 for an
 * address that has never existed, which is the truth for a creator whose coin has never traded.
 * A failed call is `null`. Those are opposite facts — one means there is nothing to claim, the
 * other means nobody knows — and a caller that folded them together would report "nothing there"
 * every time an RPC hiccuped. This is the third place in this codebase that distinction has had
 * to be made explicit, after `Number(null)` produced a confident zero twice.
 */
export async function readClaimable({ creator, rpcGet }) {
  if (typeof rpcGet !== "function")
    throw new FeeClaimError("reader_missing", "readClaimable needs rpcGet(method, params): no HTTP client is built here");
  const v = await vaultsFor(creator);

  const lamportsAt = async (address) => {
    const r = await rpcGet("getBalance", [address, { commitment: "confirmed" }]);
    if (!r?.ok) return null;
    const n = Number(r.data?.value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const tokensAt = async (address) => {
    const r = await rpcGet("getTokenAccountBalance", [address, { commitment: "confirmed" }]);
    /* An absent token account is not an error the caller should retry: the ATA only exists once
       something has accrued into it. The RPC reports that as a failure, so it is read as a
       definite zero — but ONLY when the node answered at all. */
    if (!r?.ok) return /could not find account|not found|Invalid param/i.test(String(r?.error ?? "")) ? 0 : null;
    const amount = r.data?.value?.amount;
    return /^\d+$/.test(String(amount ?? "")) ? Number(amount) : null;
  };

  const [curveLamports, ammLamports] = await Promise.all([lamportsAt(v.curveVault), tokensAt(v.ammVaultAta)]);

  /* THE RENT THAT CANNOT MOVE, off the curve side only. The pump-amm side is a token account the
     claim closes, so its rent returns in the same transaction. */
  const curveClaimable = curveLamports === null ? null : Math.max(0, curveLamports - RENT_RESERVE_LAMPORTS);
  const readable = curveLamports !== null || ammLamports !== null;
  /* HALF A READING IS NOT A TOTAL. `readable` says either node answered; the claimable figure
     needs BOTH, because `?? 0` on the side that failed booked an unknown as a measured zero and
     showed the other half as everything there was. `partial` names the case so a page can say
     "try again" rather than "this is all of it". */
  const partial = readable && (curveLamports === null || ammLamports === null);
  const claimable = readable && !partial ? curveClaimable + ammLamports : null;

  return Object.freeze({
    ...v,
    curveLamports, ammLamports, curveClaimableLamports: curveClaimable,
    rentReserveLamports: RENT_RESERVE_LAMPORTS,
    claimableLamports: claimable,
    claimableSol: claimable === null ? null : claimable / LAMPORTS_PER_SOL,
    readable, partial,
    /* WHICH HALVES ARE WORTH INCLUDING. A side holding nothing would add instructions and cost to
       move zero, and on the pump-amm side it would create and close a token account for no
       reason. Null stays null: a side nobody could read is not a side known to be empty. */
    includeCurve: curveClaimable === null ? null : curveClaimable > 0,
    includeAmm: ammLamports === null ? null : ammLamports > 0,
  });
}

/**
 * The unsigned claim, as instruction descriptors a wallet-standard page can assemble.
 *
 * Shaped exactly like what `new W3.TransactionInstruction({...})` takes — viewer/tower.html
 * already builds a transfer this way — because the page must be able to construct it without
 * knowing anything about pump.fun. The bytes and the account order come from the proven module,
 * not from the page.
 *
 * NO BLOCKHASH AND NO FEE PAYER ARE SET HERE. Both belong to the moment of signing: a blockhash
 * baked in server-side is stale by the time a human has read the screen and tapped approve, and
 * the fee payer is the creator, which the page knows because that is the wallet that connected.
 */
export async function claimTicket({ creator, includeCurve = true, includeAmm = true }) {
  const owner = requireCreator(creator);
  const fees = await claimModule();
  if (!includeCurve && !includeAmm)
    throw new FeeClaimError("nothing_to_claim", "a claim ticket needs at least one side to claim");

  const built = fees.buildFeeClaim({ creator: owner, includeCurve, includeAmm });
  return Object.freeze({
    creator: owner,
    accounts: built.accounts,
    /* The claim is four instructions when both sides are taken: collect from the curve, create the
       wrapped-SOL account idempotently, collect from pump-amm into it, then close it so the
       lamports arrive spendable. The close is the leg that is easy to forget, and without it every
       claim leaves rent behind. */
    instructions: Object.freeze(built.instructions.map((ix) => Object.freeze({
      programId: String(ix.programId),
      keys: Object.freeze((ix.keys ?? []).map((k) => Object.freeze({
        pubkey: String(k.pubkey), isSigner: k.isSigner === true, isWritable: k.isWritable === true,
      }))),
      data: Buffer.from(ix.data ?? []).toString("base64"),
    }))),
    signer: owner,
    note: "unsigned. Only the creator's own signature can send this, which is why it is not a secret "
      + "and why nothing on this server holds a key",
  });
}

/** The claim's own arithmetic, for a page that has to say whether signing is worth it. Kept here
 *  rather than in the page so the number on screen and the number the bot logs come from one
 *  place. */
export function worthClaiming({ claimableLamports, feeLamports = 5_000, minNetLamports = 2_000_000 }) {
  if (claimableLamports === null || claimableLamports === undefined) {
    return Object.freeze({ worth: null, netLamports: null,
      reason: "the vaults could not be read, so this cannot be judged — unknown is not zero" });
  }
  const net = Number(claimableLamports) - Number(feeLamports);
  return Object.freeze({
    worth: net >= Number(minNetLamports),
    netLamports: net,
    netSol: net / LAMPORTS_PER_SOL,
    reason: net >= Number(minNetLamports)
      ? `${(net / LAMPORTS_PER_SOL).toFixed(6)} SOL net of fees`
      : `${(net / LAMPORTS_PER_SOL).toFixed(6)} SOL net of fees is under the `
        + `${(Number(minNetLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL floor — fees keep accruing, so `
        + "waiting costs nothing",
  });
}
