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

  return {
    ok: true,
    // NOTE: these are the largest *token accounts*, which include LP vaults, CEX
    // omnibus wallets and burn addresses. High top-10 is a question, not a verdict.
    note: "Largest token accounts include LP pool vaults and exchange wallets; not all are insiders.",
    top1Pct: pct(amounts[0] || 0),
    top10Pct: pct(top10),
    accounts: accounts.slice(0, 10).map((a) => ({ address: a.address, pctOfSupply: pct(Number(a.amount)) })),
  };
}

export async function health() {
  const r = await readRpc(cfg.rpc, "getSlot", []);
  return r.ok ? { ok: true, slot: r.data } : { ok: false, error: r.error };
}
