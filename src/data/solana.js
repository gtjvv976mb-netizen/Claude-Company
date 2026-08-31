import { readRpc } from "../lib/http.js";
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
export async function topHolders(mint, supplyRaw) {
  const r = await readRpc(cfg.rpc, "getTokenLargestAccounts", [mint]);
  if (!r.ok) return { ok: false, error: r.error };
  // The Raydium authority's token account is the POOL — counting it as a holder
  // both masks and manufactures concentration. Exclude it before any math.
  const RAYDIUM_AUTH = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const accounts = (r.data?.value || []).filter((a) => a.address !== RAYDIUM_AUTH);
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
    note: "Largest token accounts include LP pool vaults and exchange wallets; not all are insiders.",
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
