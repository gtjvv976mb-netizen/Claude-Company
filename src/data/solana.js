import { readRpc } from "../lib/http.js";
import { isAddress } from "../lib/base58.js";
import { cfg } from "../config.js";

const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Token-2022 extensions that can be used against a holder. The desk classifies
// these in code so the judgment is auditable, not vibes from a model.
const DANGEROUS_EXTENSIONS = {
  transferHook: "Arbitrary program runs on every transfer — can block your sell entirely.",
  transferFeeConfig: "A tax is skimmed on every transfer; the rate can often be raised later.",
  permanentDelegate: "A delegate can move or burn tokens out of your wallet without consent.",
  defaultAccountState: "New accounts can be frozen by default — buyers may be unable to sell.",
  confidentialTransferMint: "Balances/transfers can be hidden, defeating on-chain flow analysis.",
  mintCloseAuthority: "The mint can be closed by an authority.",
};

export async function mintInfo(mint) {
  const r = await readRpc(cfg.rpc, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!r.ok || !r.data?.value) return { ok: false, error: r.error || "mint account not found" };

  const v = r.data.value;
  const info = v.data?.parsed?.info ?? {};
  const isToken2022 = v.owner === TOKEN2022;
  const extensions = (info.extensions || []).map((e) => e.extension);

  const flags = [];
  if (info.mintAuthority) flags.push({ flag: "mint_authority_live", detail: `Supply can still be inflated by ${info.mintAuthority}.` });
  if (info.freezeAuthority) flags.push({ flag: "freeze_authority_live", detail: `${info.freezeAuthority} can freeze token accounts, preventing sells.` });
  for (const ext of extensions) {
    if (DANGEROUS_EXTENSIONS[ext]) flags.push({ flag: `ext_${ext}`, detail: DANGEROUS_EXTENSIONS[ext] });
  }

  return {
    ok: true,
    program: isToken2022 ? "spl-token-2022" : "spl-token",
    isToken2022,
    decimals: info.decimals ?? null,
    supply: info.supply ?? null,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions,
    extensionDetail: (info.extensions || []),
    flags,
  };
}

/** Holder concentration. Public RPC frequently 429s here — that is reported, not faked. */
/* Authorities that hold a POOL's tokens rather than a person's. The Raydium one was
   already here and was being compared to the wrong thing for its entire life. */
const POOL_AUTHORITIES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",   // Raydium AMM authority
]);
/* Programs whose PDAs hold a pool's or a curve's tokens. An owner account owned by one
   of these is not a holder. This is what catches a pump.fun bonding curve even when the
   caller could not tell us its address. */
const POOL_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",     // pump.fun bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",     // PumpSwap AMM
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",     // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",     // Raydium CLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",      // Meteora DLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",      // Orca Whirlpool
]);

/**
 * Holder concentration. Public RPC frequently 429s here — that is reported, not faked.
 *
 * THE POOL EXCLUSION NEVER FIRED. getTokenLargestAccounts returns TOKEN ACCOUNT
 * addresses; the Raydium constant above is an OWNER authority. The two can never be
 * equal, so for the whole life of this function the pool was counted as a holder.
 * Measured on live coins at the moment this was fixed: a graduated coin read 62.6% and
 * 26.8% for its top two "holders", both of which were pools, and every coin still on
 * its bonding curve read the curve itself as a single holder of 50-99% of supply. The
 * forensics seat was being handed a rug signature for the entire population this desk
 * hunts. Owners are now resolved and matched, which costs one extra RPC call.
 */
export async function topHolders(mint, supplyRaw, { poolAddress = null, bondingCurve = null } = {}) {
  const r = await readRpc(cfg.rpc, "getTokenLargestAccounts", [mint]);
  if (!r.ok) return { ok: false, error: r.error };
  const raw = r.data?.value || [];
  const known = new Set([...POOL_AUTHORITIES, poolAddress, bondingCurve].filter(Boolean));

  /* Resolve each token account's owner, then ask what program owns THAT. A pool's
     authority is often a plain PDA with no data, so the program test alone misses it —
     hence both the address set above and this. */
  let owners = [], excluded = [], ownerUnknown = false;
  try {
    const infos = await readRpc(cfg.rpc, "getMultipleAccounts",
      [raw.map((a) => a.address), { encoding: "jsonParsed" }]);
    const vals = infos.ok ? (infos.data?.value || []) : [];
    if (!infos.ok || vals.length !== raw.length) ownerUnknown = true;
    owners = vals.map((v) => v?.data?.parsed?.info?.owner ?? null);
    const ownerAddrs = [...new Set(owners.filter(Boolean))];
    let ownerPrograms = new Map();
    if (ownerAddrs.length) {
      const oi = await readRpc(cfg.rpc, "getMultipleAccounts", [ownerAddrs, { encoding: "base64" }]);
      if (oi.ok) (oi.data?.value || []).forEach((v, i) => ownerPrograms.set(ownerAddrs[i], v?.owner ?? null));
    }
    owners.forEach((o, i) => {
      if (!o) return;
      if (known.has(o) || POOL_PROGRAMS.has(ownerPrograms.get(o)))
        excluded.push({ account: raw[i].address, owner: o,
          pct: Number(((Number(raw[i].amount) / Number(supplyRaw)) * 100).toFixed(2)) });
    });
  } catch { ownerUnknown = true; }

  const excludedAccounts = new Set(excluded.map((e) => e.account));
  const accounts = raw.filter((a) => !excludedAccounts.has(a.address));
  const supply = Number(supplyRaw);
  if (!supply || !accounts.length) return { ok: false, error: "no supply or no accounts" };

  const amounts = accounts.map((a) => Number(a.amount));
  const pct = (n) => Number(((n / supply) * 100).toFixed(2));
  const top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0);

  /* THE BUNDLE FINGERPRINT.
   *
   * Concentration alone misses the scam that matters most on a launchpad. A bundler
   * buys the supply at launch and SPLITS it across many wallets, so top-1 looks modest,
   * top-10 looks survivable, and the float is nonetheless controlled by one person who
   * will sell into the first real bid.
   *
   * What gives it away is the SHAPE, not the size. Organic holders arrive at different
   * times with different convictions and different money, so their balances decay
   * roughly geometrically — a long tail under a few large ones. A bundle is one buy
   * divided N ways, so its wallets sit in a tight band at nearly the same size. Several
   * top holders within a few percent of each other is not how a crowd forms; it is how
   * a spreadsheet does.
   *
   * This is a SIGNATURE, not proof, and the difference matters: these are the largest
   * token ACCOUNTS, which include LP vaults, CEX omnibus wallets and burn addresses. It
   * is evidence for a seat to weigh, never a screen that kills on its own. */
  const real = accounts.map((a) => Number(a.amount)).filter((n) => n > 0);
  let clustered = 0, biggestCluster = 0;
  for (let i = 0; i < real.length; i++) {
    let run = 1;
    for (let j = i + 1; j < real.length; j++) {
      // within 8% of each other in size — a split, not a distribution
      if (Math.abs(real[j] - real[i]) / real[i] <= 0.08) run++;
      else break;
    }
    biggestCluster = Math.max(biggestCluster, run);
  }
  clustered = biggestCluster;

  /* MEDIUM WALLETS — does anyone between the whales and the dust actually hold?
   * A coin whose top account is small and whose 2nd-10th are all tiny has no real
   * holders at all: it is a pool, a dev, and a crowd of nobody. The ratio of the
   * middle of the book to its head is the cheapest read on whether the coin has
   * genuine mid-sized conviction behind it. */
  const mid = real.slice(2, 8);
  const midShare = mid.length ? pct(mid.reduce((a, b) => a + b, 0)) : 0;
  const headShare = pct((real[0] || 0) + (real[1] || 0));

  return {
    ok: true,
    // NOTE: these are the largest *token accounts*, which include LP vaults, CEX
    // omnibus wallets and burn addresses. High top-10 is a question, not a verdict.
    note: ownerUnknown
      ? "Owners could not be resolved, so pool vaults may still be counted as holders — treat concentration as unverified."
      : "Pool and bonding-curve accounts were excluded by OWNER. What remains may still include exchange wallets and burn addresses; high top-10 is a question, not a verdict.",
    /* WHAT WAS TAKEN OUT, AND WHETHER IT COULD BE. A seat reading concentration needs
       to know the number was cleaned, and needs to distrust it when it could not be. */
    poolsExcluded: excluded.length,
    poolShareOfSupplyPct: Number(excluded.reduce((a, e) => a + (e.pct || 0), 0).toFixed(2)),
    excludedPools: excluded.slice(0, 5),
    ownersResolved: !ownerUnknown,
    top1Pct: pct(amounts[0] || 0),
    top10Pct: pct(top10),
    // Bundle signature: how many of the top accounts sit within 8% of each other.
    // 4+ near-identical balances is a split buy, not a crowd.
    clusteredHolders: clustered,
    bundleSuspect: clustered >= 4,
    // Distribution shape: the middle of the book against its head.
    midHoldersPct: midShare,
    headHoldersPct: headShare,
    midToHead: headShare > 0 ? Number((midShare / headShare).toFixed(2)) : null,
    accounts: accounts.slice(0, 10).map((a) => ({ address: a.address, pctOfSupply: pct(Number(a.amount)) })),
  };
}

export async function health() {
  const r = await readRpc(cfg.rpc, "getSlot", []);
  return r.ok ? { ok: true, slot: r.data } : { ok: false, error: r.error };
}

const walletBalanceCache = new Map();

/** Public SOL balance for one validated wallet. This is used only to show a
 * tenant whether their self-hosted burner is funded; it cannot move funds. A short
 * cache prevents an open dashboard from turning status refreshes into RPC load. */
/**
 * Many wallets' SOL balances in one call.
 *
 * The callouts tab asks the same question of a handful of wallets at a time — what does
 * this verified caller actually hold — and asking it one at a time is a request per
 * wallet against an endpoint that rate-limits. getMultipleAccounts answers a hundred at
 * once. A wallet that cannot be read is ABSENT from the result rather than zero: the
 * caller must be able to tell "holds nothing" from "could not be measured".
 */
export async function walletSolBalances(wallets, { chunk = 100 } = {}) {
  const out = new Map();
  const list = [...new Set((Array.isArray(wallets) ? wallets : []).filter(isAddress))];
  for (let i = 0; i < list.length; i += chunk) {
    const slice = list.slice(i, i + chunk);
    const r = await readRpc(cfg.rpc, "getMultipleAccounts",
      [slice, { commitment: "confirmed", encoding: "base64" }], { attempts: 2, timeoutMs: 8_000 });
    if (!r.ok) continue;
    const values = r.data?.value;
    if (!Array.isArray(values) || values.length !== slice.length) continue;
    values.forEach((v, k) => {
      // A wallet that has never been funded has no account at all, and that IS zero.
      const lamports = v == null ? 0 : Number(v.lamports);
      if (Number.isSafeInteger(lamports) && lamports >= 0)
        out.set(slice[k], { lamports, sol: lamports / 1e9 });
    });
  }
  return out;
}

export async function walletSolBalance(wallet, { maxAgeMs = 30_000 } = {}) {
  if (!isAddress(wallet))
    return { ok: false, error: "invalid wallet" };
  const now = Date.now();
  const cached = walletBalanceCache.get(wallet);
  if (cached && now - cached.observedAt <= Math.max(0, Number(maxAgeMs) || 0))
    return cached;
  const r = await readRpc(cfg.rpc, "getBalance", [wallet, { commitment: "confirmed" }],
    { attempts: 1, timeoutMs: 5_000 });
  const lamports = Number(r?.data?.value);
  if (!r.ok || !Number.isSafeInteger(lamports) || lamports < 0)
    return { ok: false, error: r?.error || "balance unavailable" };
  const result = { ok: true, lamports, sol: lamports / 1e9, observedAt: now };
  walletBalanceCache.set(wallet, result);
  return result;
}
