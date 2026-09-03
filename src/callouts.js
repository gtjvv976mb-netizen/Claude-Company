import { decode, isAddress } from "./lib/base58.js";

/** The tape values a confirmed token inflow at the current market mark. It does not
 * reconstruct the wallet's original quote-token consideration, so the public contract
 * names that basis explicitly instead of calling it purchase USD. */
export const DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD = 500;

/* OWNER RULE (2026-09-03): the Callouts tab posts a call when the caller carries
 * pump.fun's own gold verification AND their wallet holds at least $1,000 of SOL.
 *
 * It replaces an earlier rule that also demanded confirmed pool-touching INFLOW worth
 * $2,500 at the current mark, matched to the caller's exact wallet. That bar is a much
 * harder thing to prove — it needs a signature scan per coin that frequently cannot
 * match, so the desk only ever attempted three coins a run and the tab stayed empty for
 * days. Measured 2026-09-03 across 70 pump.fun coins: 22 carried callouts, 146 callouts
 * from 143 distinct callers, 8 of them verified, and 6 of those 7 verified wallets held
 * more than $1,000 of SOL. The new rule is answerable with one balance read.
 *
 * What it claims is exactly what it measures: this caller is verified by pump.fun, and
 * this is what their wallet holds. It is NOT a claim that they bought this coin. */
const configuredCalloutWalletUsd = Number(process.env.CALLOUT_MIN_WALLET_USD || 1000);
export const CALLOUT_MIN_WALLET_USD = Number.isFinite(configuredCalloutWalletUsd) && configuredCalloutWalletUsd > 0
  ? configuredCalloutWalletUsd : 1000;

/* Retained for the whale TAPE, which still values matched inflow and keeps its own bar. */
const configuredCalloutWhaleUsd = Number(process.env.CALLOUT_WHALE_MIN_USD || 2500);
export const CALLOUT_WHALE_MIN_USD = Number.isFinite(configuredCalloutWhaleUsd) && configuredCalloutWhaleUsd > 0
  ? configuredCalloutWhaleUsd : 2500;

/**
 * Keep only pump.fun-verified callers whose own wallet clears the SOL bar.
 *
 * Pure. `walletUsdOf` answers what a wallet holds in dollars, or null when it could not
 * be read — and an unreadable balance is dropped rather than assumed, the same rule the
 * rest of the desk follows for a number it did not measure. Returns what it dropped and
 * why, so the tab can say "nothing cleared the bar" instead of going silently blank.
 */
export function verifiedHolderCallouts(rows, { minUsd = CALLOUT_MIN_WALLET_USD, walletUsdOf } = {}) {
  const bar = Number.isFinite(Number(minUsd)) && Number(minUsd) > 0 ? Number(minUsd) : CALLOUT_MIN_WALLET_USD;
  const read = typeof walletUsdOf === "function" ? walletUsdOf : () => null;
  const kept = [];
  let unverifiedHidden = 0, belowBarHidden = 0, unreadableHidden = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.verified !== true) { unverifiedHidden++; continue; }
    const wallet = typeof row.user === "string" ? row.user : null;
    /* Number(null) is 0, which would file every unreadable balance as "holds nothing"
       and hide a measurement failure inside an ordinary rejection. Read first, then
       decide whether there is a number at all. */
    const raw = wallet && isAddress(wallet) ? read(wallet) : undefined;
    const usd = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(usd)) { unreadableHidden++; continue; }
    if (usd < bar) { belowBarHidden++; continue; }
    kept.push({ ...row, walletSolUsd: Math.round(usd) });
  }
  // Biggest holder first: on a tab that shows five, the wallet with the most at stake
  // is the one worth reading.
  kept.sort((a, b) => (b.walletSolUsd ?? 0) - (a.walletSolUsd ?? 0));
  return { rows: kept, unverifiedHidden, belowBarHidden, unreadableHidden, walletUsd: bar };
}

/** Keep only Pump.fun-verified authors whose matched inflow clears the whale bar.
 *  Pure; returns what it dropped and why, so the tab can say so instead of going blank. */
export function verifiedWhaleCallouts(rows, { minUsd = CALLOUT_WHALE_MIN_USD } = {}) {
  const bar = Number.isFinite(Number(minUsd)) && Number(minUsd) > 0 ? Number(minUsd) : CALLOUT_WHALE_MIN_USD;
  const kept = [];
  let unverifiedHidden = 0, belowWhaleHidden = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = Number(row?.matchedCurrentValueUsd);
    if (row?.verified !== true) { unverifiedHidden++; continue; }
    if (!Number.isFinite(value) || value < bar) { belowWhaleHidden++; continue; }
    kept.push(row);
  }
  return { rows: kept, unverifiedHidden, belowWhaleHidden, whaleUsd: bar };
}

const record = (value) => value && typeof value === "object" && !Array.isArray(value);

const finite = (value) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const count = (value) => {
  const number = finite(value);
  return number != null && number >= 0 ? Math.floor(number) : null;
};

const jsonCopy = (value, fallback = null) => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : JSON.parse(encoded);
  } catch {
    return fallback;
  }
};

const httpsUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const signature = (value) => {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  try {
    return candidate.length >= 80 && candidate.length <= 90 && decode(candidate).length === 64
      ? candidate : null;
  } catch {
    return null;
  }
};

const authorWallet = (callout) => {
  if (!record(callout)) return null;
  const wallet = callout.user ?? callout.wallet ?? callout.authorWallet ?? callout.author?.wallet;
  return isAddress(wallet) ? wallet : null;
};

const tradeWallet = (trade) => record(trade) && isAddress(trade.wallet) ? trade.wallet : null;

const timestamp = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  return typeof value === "string" && value.trim() ? value : null;
};

const receiptFor = (trade) => {
  const sig = signature(trade.signature);
  const suppliedLink = httpsUrl(trade.link ?? trade.url ?? trade.txUrl);
  return {
    currentValueUsd: finite(trade.currentValueUsd ?? trade.usd),
    timestamp: timestamp(trade.at ?? trade.timestamp),
    signature: sig,
    link: suppliedLink ?? (sig ? `https://solscan.io/tx/${sig}` : null),
    basis: "token-inflow-at-current-market-mark",
  };
};

/**
 * Join Pump.fun callout authors to the recent on-chain tape.
 *
 * A profile, username, badge, or impressive multiple is never evidence that the
 * author moved size. A row qualifies only when the author's exact, valid Solana wallet
 * owns at least one confirmed pool-touching token inflow whose value at the current
 * market mark clears `minUsd`. That is evidence of matched wallet activity, not proof
 * of original purchase consideration. The caller owns recency by supplying its recent
 * tape; this pure function does no network or clock reads and makes no identity guesses.
 *
 * The returned coin-level object is ready to serialize into the API. `callouts` is
 * largest matched buyer first and contains no unmatched chatter. Each row retains the
 * Pump.fun fields (including verified/profile/source) and adds the transactions which
 * made it eligible. Scan completeness and valuation basis ride beside the threshold so
 * a partial/current-mark approximation cannot be mistaken for a complete cost record.
 */
export function evidenceBackedPumpfunCallouts({
  mint = null,
  callouts = [],
  trades = [],
  minUsd = DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD,
  partial = false,
  scanned = null,
  unread = null,
  failed = null,
} = {}) {
  const requestedThreshold = finite(minUsd);
  const thresholdUsd = requestedThreshold != null && requestedThreshold > 0
    ? requestedThreshold : DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD;
  const sourceCallouts = Array.isArray(callouts) ? callouts : [];
  const sourceTrades = Array.isArray(trades) ? trades : [];
  const receiptsByWallet = new Map();
  let qualifyingInflowRecords = 0;

  for (const trade of sourceTrades) {
    const wallet = tradeWallet(trade);
    const currentValueUsd = record(trade) ? finite(trade.currentValueUsd ?? trade.usd) : null;
    if (!wallet || trade.side !== "buy" ||
        trade.evidenceKind !== "pool_token_inflow_current_value" ||
        currentValueUsd == null || currentValueUsd < thresholdUsd) continue;
    const receipt = receiptFor(trade);
    receiptsByWallet.set(wallet, [...(receiptsByWallet.get(wallet) ?? []), receipt]);
    qualifyingInflowRecords++;
  }

  for (const receipts of receiptsByWallet.values()) {
    receipts.sort((a, b) => b.currentValueUsd - a.currentValueUsd);
  }

  const matched = [];
  const matchedWallets = new Set();
  for (let index = 0; index < sourceCallouts.length; index++) {
    const callout = sourceCallouts[index];
    const wallet = authorWallet(callout);
    const receipts = wallet ? receiptsByWallet.get(wallet) : null;
    if (!wallet || !receipts?.length) continue;

    const preserved = jsonCopy(callout, {});
    const matchedCurrentValueUsd = Number(
      receipts.reduce((sum, inflow) => sum + inflow.currentValueUsd, 0).toFixed(2),
    );
    matchedWallets.add(wallet);
    matched.push({
      ...preserved,
      // These fields are explicit and conservative even if malformed upstream data
      // attempted to put a different value into the JSON copy.
      user: wallet,
      verified: callout.verified === true,
      profile: jsonCopy(callout.profile, null),
      source: jsonCopy(callout.source, null),
      matchedCurrentValueUsd,
      // Compatibility for the former renderer. The canonical UI uses the explicit
      // current-value field and never labels this as original buy consideration.
      whaleUsd: matchedCurrentValueUsd,
      evidence: {
        kind: "recent_pool_token_inflow_current_value",
        thresholdUsd,
        matchedCurrentValueUsd,
        qualifyingInflowCount: receipts.length,
        inflows: jsonCopy(receipts, []),
        valueBasis: "token-inflow-at-current-market-mark",
        purchaseConsiderationProven: false,
      },
      _inputIndex: index,
    });
  }

  matched.sort((a, b) => b.matchedCurrentValueUsd - a.matchedCurrentValueUsd ||
    a._inputIndex - b._inputIndex);
  for (const callout of matched) delete callout._inputIndex;

  const scannedCount = count(scanned);
  const unreadCount = count(unread);
  const failedCount = count(failed);
  return {
    mint: typeof mint === "string" && mint ? mint : null,
    callouts: matched,
    evidence: {
      kind: "pumpfun_callout_author_token_inflow_match",
      thresholdUsd,
      valueBasis: "token-inflow-at-current-market-mark",
      purchaseConsiderationProven: false,
      partial: partial === true || (unreadCount != null && unreadCount > 0) ||
        (failedCount != null && failedCount > 0),
      scanned: scannedCount,
      unread: unreadCount,
      failed: failedCount,
      tradeRecords: sourceTrades.length,
      qualifyingInflowRecords,
      matchedAuthors: matchedWallets.size,
    },
  };
}
