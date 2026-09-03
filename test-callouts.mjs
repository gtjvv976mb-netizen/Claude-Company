import assert from "node:assert/strict";
import fs from "node:fs";
import { encode } from "./src/lib/base58.js";
import {
  DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD,
  evidenceBackedPumpfunCallouts,
} from "./src/callouts.js";

const address = (byte) => encode(Buffer.alloc(32, byte));
const sig = (byte) => encode(Buffer.alloc(64, byte));

const alpha = address(1);
const bravo = address(2);
const chatter = address(3);
const malformed = "not-a-solana-wallet";
const alphaSig = sig(11);

const callouts = [
  {
    id: "alpha-call",
    user: alpha,
    username: "alpha",
    verified: true,
    profile: { avatar: "https://images.example/alpha.png", bio: "explicit profile" },
    source: { provider: "pump.fun", url: "https://pump.fun/callouts/coin/alpha-call" },
    text: "I bought this because the tape changed.",
    multiple: 1.4,
  },
  { id: "bravo-call", user: bravo, username: "bravo", verified: false, text: "Taking size." },
  { id: "chatter", user: chatter, username: "loud", verified: true, text: "No receipt." },
  { id: "bad-author", user: malformed, username: "not-a-wallet", text: "Cannot join." },
];

const result = evidenceBackedPumpfunCallouts({
  mint: address(9),
  callouts,
  minUsd: 500,
  partial: true,
  scanned: 16,
  unread: 4,
  failed: 2,
  trades: [
    { wallet: alpha, side: "buy", currentValueUsd: 700,
      evidenceKind: "pool_token_inflow_current_value", at: 1_800_000_000_000, signature: alphaSig },
    { wallet: alpha, side: "buy", currentValueUsd: 650,
      evidenceKind: "pool_token_inflow_current_value", at: 1_800_000_001_000 },
    { wallet: alpha, side: "buy", currentValueUsd: 499.99,
      evidenceKind: "pool_token_inflow_current_value", at: 1_800_000_002_000, signature: sig(13) },
    { wallet: alpha, side: "sell", currentValueUsd: 9_000,
      evidenceKind: "pool_token_outflow_current_value", at: 1_800_000_003_000, signature: sig(14) },
    { wallet: bravo, side: "buy", currentValueUsd: 800,
      evidenceKind: "pool_token_inflow_current_value", timestamp: "2026-09-02T00:00:00.000Z",
      link: "https://explorer.solana.com/tx/bravo-evidence" },
    { wallet: chatter, side: "buy", currentValueUsd: 499,
      evidenceKind: "pool_token_inflow_current_value", signature: sig(15) },
    { wallet: malformed, side: "buy", currentValueUsd: 50_000,
      evidenceKind: "pool_token_inflow_current_value", signature: sig(16) },
  ],
});

assert.deepEqual(result.callouts.map((row) => row.id), ["alpha-call", "bravo-call"],
  "only exact author wallets with threshold-clearing current-value inflows survive, largest total first");
assert.equal(result.callouts.some((row) => row.id === "chatter"), false,
  "verified/profile chatter without a qualifying inflow is excluded");
assert.equal(result.callouts.some((row) => row.id === "bad-author"), false,
  "malformed author wallets cannot join to the tape");

const alphaRow = result.callouts[0];
assert.equal(alphaRow.matchedCurrentValueUsd, 1_350,
  "only independently qualifying inflows enter the matched current value");
assert.equal(alphaRow.whaleUsd, 1_350, "the former renderer receives only a compatibility value");
assert.equal(alphaRow.evidence.thresholdUsd, 500);
assert.equal(alphaRow.evidence.qualifyingInflowCount, 2);
assert.equal(alphaRow.evidence.purchaseConsiderationProven, false);
assert.deepEqual(alphaRow.evidence.inflows[0], {
  currentValueUsd: 700,
  timestamp: 1_800_000_000_000,
  signature: alphaSig,
  link: `https://solscan.io/tx/${alphaSig}`,
  basis: "token-inflow-at-current-market-mark",
}, "the receipt retains its current-value basis, timestamp, signature, and transaction link");
assert.deepEqual(alphaRow.profile, callouts[0].profile, "the supplied profile is preserved, not reconstructed");
assert.deepEqual(alphaRow.source, callouts[0].source, "the supplied source provenance is preserved");
assert.equal(alphaRow.verified, true, "the supplied verification badge is preserved");
assert.equal(alphaRow.username, "alpha", "the supplied username is preserved");

const bravoRow = result.callouts[1];
assert.deepEqual(bravoRow.evidence.inflows[0], {
  currentValueUsd: 800,
  timestamp: "2026-09-02T00:00:00.000Z",
  signature: null,
  link: "https://explorer.solana.com/tx/bravo-evidence",
  basis: "token-inflow-at-current-market-mark",
}, "a supplied HTTPS receipt link is retained without inventing a signature");
assert.equal(bravoRow.verified, false);
assert.equal(bravoRow.profile, null, "a missing profile stays unknown");
assert.equal(bravoRow.source, null, "a missing source stays unknown");
assert.equal("label" in bravoRow, false, "the matcher does not invent a whale name or identity label");

assert.deepEqual(result.evidence, {
  kind: "pumpfun_callout_author_token_inflow_match",
  thresholdUsd: 500,
  valueBasis: "token-inflow-at-current-market-mark",
  purchaseConsiderationProven: false,
  partial: true,
  scanned: 16,
  unread: 4,
  failed: 2,
  tradeRecords: 7,
  qualifyingInflowRecords: 3,
  matchedAuthors: 2,
}, "coin-level evidence states the threshold and incomplete scan coverage");
assert.doesNotThrow(() => JSON.stringify(result), "the complete API shape is JSON-safe");

const defaults = evidenceBackedPumpfunCallouts({
  mint: "test-mint",
  callouts: [{ user: alpha, text: "still explicit" }],
  trades: [{ wallet: alpha, side: "buy",
    currentValueUsd: DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD,
    evidenceKind: "pool_token_inflow_current_value" }],
  minUsd: Number.NaN,
  unread: 1,
});
assert.equal(defaults.evidence.thresholdUsd, DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD,
  "a malformed threshold cannot silently turn chatter into evidence");
assert.equal(defaults.evidence.partial, true, "unread signatures make the evidence explicitly partial");
assert.equal(defaults.evidence.scanned, null, "unknown scan coverage stays unknown");
assert.equal(defaults.callouts.length, 1);
assert.equal(defaults.callouts[0].username, undefined, "a missing username is not inferred from the wallet");
assert.equal(defaults.callouts[0].evidence.inflows[0].signature, null);
assert.equal(defaults.callouts[0].evidence.inflows[0].link, null,
  "no transaction link is fabricated when neither a valid signature nor a source link exists");

const ambiguous = evidenceBackedPumpfunCallouts({
  callouts: [{ user: alpha, text: "a current-value number alone proves nothing" }],
  trades: [{ wallet: alpha, side: "buy", currentValueUsd: 50_000 }],
});
assert.equal(ambiguous.callouts.length, 0,
  "an unlabeled token delta cannot be upgraded into matched caller evidence");

const officeSource = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const routeStart = officeSource.indexOf("const calloutsIndex");
const routeEnd = officeSource.indexOf("// Whale callouts for one mint");
const route = officeSource.slice(routeStart, routeEnd);
assert.ok(routeStart > 0 && routeEnd > routeStart, "the canonical Callouts route exists");
assert.match(route, /url\.pathname === "\/api\/callouts"/,
  "Callouts has a canonical non-Whales route");
/* THE OWNER'S RULE (2026-09-03): pump.fun's own gold verification, and a caller wallet
 * holding at least $1,000 of SOL. It replaced a rule that also demanded a confirmed
 * pool-touching inflow matched to that exact wallet — a far harder thing to prove, which
 * needed a signature scan per coin, so the desk attempted only three coins a run and the
 * tab was empty for days. What the assertions below protect is unchanged in spirit: no
 * unverified chatter, honest coverage, and a claim no larger than the measurement. */
assert.match(route, /verifiedHolderCallouts/,
  "the API gates on the owner's rule rather than displaying raw callout chatter");
assert.match(route, /unmatchedChatterIncluded: false/);
assert.match(route, /minimumWalletSolUsd/);
assert.match(route, /purchaseConsiderationProven: false/);
assert.match(route, /identityClaim: "pumpfun-verified-profile-and-its-wallet-balance"/,
  "the payload claims a verified profile and a balance — never that the caller bought the coin");
assert.match(route, /coverage:/,
  "the API distinguishes verification coverage from an honestly empty result");
assert.match(route, /coinsWithCallouts: withCallouts\.length/,
  "coverage separates coins that had callouts from coins merely scanned");
assert.match(route, /verifiedCallers: wallets\.length/,
  "coverage says how many verified callers were priced");
assert.match(route, /walletSolBalances\(wallets\)/,
  "wallet balances are read in one batched call, not one request per caller");
assert.match(route, /if \(!bal \|\| !\(solUsd > 0\)\) return null/,
  "with no SOL price the bar cannot be applied, so nothing passes rather than everything");
assert.match(route, /unreadableWallet: gate\.unreadableHidden/,
  "a wallet that could not be read is reported, not silently treated as empty");
assert.doesNotMatch(route, /quotes\.filter|chatter\.length/,
  "unmatched Pump.fun posts never enter the default API payload");

const pumpfunSource = fs.readFileSync(new URL("./src/data/pumpfun.js", import.meta.url), "utf8");
const pumpfunCallouts = pumpfunSource.slice(pumpfunSource.indexOf("export async function callouts"));
assert.match(pumpfunCallouts, /!r\.ok \|\| !Array\.isArray\(r\.data\?\.callouts\)/);
assert.doesNotMatch(pumpfunCallouts, /!rows\.length/,
  "a successfully fetched empty Pump.fun thread is verified-empty, not a coverage failure");

/* The whale TAPE still values matched inflow and still keeps its own bar; only the
   Callouts tab moved to the wallet-balance rule. These assertions cover the tape. */
const whaleSource = fs.readFileSync(new URL("./src/whales.js", import.meta.url), "utf8");
assert.match(whaleSource, /unread: skipped \+ failedReads/,
  "failed transaction reads make evidence coverage partial");
assert.match(whaleSource, /if \(includeEvidence\) result\.evidenceTrades = trades/,
  "the matcher can receive every bounded evidence row without widening the legacy response");

console.log("evidence-backed Pump.fun callouts: exact wallet joins, truthful valuation, provenance, and coverage pass");


/* OWNER RULE: only verified Pump.fun whales are posted. */
{
  const { verifiedWhaleCallouts } = await import("./src/callouts.js");
  const rows = [
    { id: "big-verified", verified: true, matchedCurrentValueUsd: 6_000 },
    { id: "big-unverified", verified: false, matchedCurrentValueUsd: 9_000 },
    { id: "small-verified", verified: true, matchedCurrentValueUsd: 800 },
    { id: "no-badge-field", matchedCurrentValueUsd: 50_000 },
  ];
  const gate = verifiedWhaleCallouts(rows, { minUsd: 2_500 });
  assert.deepEqual(gate.rows.map((r) => r.id), ["big-verified"], "only a verified author above the whale bar is posted");
  assert.equal(gate.unverifiedHidden, 2, "unverified authors are hidden however large the buy");
  assert.equal(gate.belowWhaleHidden, 1, "a verified author under the bar is hidden");
  assert.equal(gate.whaleUsd, 2_500);
  console.log("  ok   verified-whale gate keeps only verified authors above the bar and counts what it hid");
}

/* ── THE OWNER'S GATE, EXACTLY ─────────────────────────────────────────────────
 * A caller posts on the tab when pump.fun's own gold check is on their profile AND
 * their wallet holds at least $1,000 of SOL. Measured against the seven verified
 * callers found live on 2026-09-03: six cleared the bar, one held $284 and did not. */
{
  const { verifiedHolderCallouts, CALLOUT_MIN_WALLET_USD } = await import("./src/callouts.js");
  assert.equal(CALLOUT_MIN_WALLET_USD, 1000, "the bar the owner set");
  const W = {
    netvyxe: "HmUt3Jn46j7c7ANdURmEyjSRj8i3Em6MhjQUi37PZ219",
    mitch: "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t",
    edward: "C4Svaa7djC8d3CVxaohrsedccaKqimNoJrWe9iNPdix5",
    dex: "2VKv5Kc2mwWVsANnHdLRuESoxgkSkgCBcrrjenYv6tyw",
  };
  const held = { [W.netvyxe]: 201219, [W.mitch]: 2389, [W.edward]: 284, [W.dex]: 17583 };
  const walletUsdOf = (w) => (w in held ? held[w] : null);
  const rows = [
    { user: W.mitch, verified: true, username: "mitch" },
    { user: W.edward, verified: true, username: "edward" },      // verified, only $284
    { user: W.netvyxe, verified: true, username: "netvyxe" },
    { user: W.dex, verified: false, username: "dex" },           // rich, but no gold check
    { user: "not-a-wallet", verified: true, username: "bogus" },
    { user: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", verified: true, username: "unread" },
  ];
  const gate = verifiedHolderCallouts(rows, { walletUsdOf });
  assert.deepEqual(gate.rows.map((r) => r.username), ["netvyxe", "mitch"],
    "verified and above the bar, biggest holder first");
  assert.equal(gate.unverifiedHidden, 1, "no gold check, no post — however rich");
  assert.equal(gate.belowBarHidden, 1, "verified but holding $284 does not clear $1,000");
  assert.equal(gate.unreadableHidden, 2, "a bad address and an unreadable balance are both dropped");
  assert.equal(gate.rows[0].walletSolUsd, 201219, "what the wallet holds travels with the row");

  /* AN UNMEASURED BALANCE IS NOT A ZERO AND IS NOT A PASS. The desk's standing rule for
     a number it could not read applies here too: the caller is dropped, and counted. */
  const blind = verifiedHolderCallouts(rows, { walletUsdOf: () => null });
  assert.equal(blind.rows.length, 0, "with no balances readable, nothing is posted");
  assert.equal(blind.unreadableHidden, 5, "and every verified caller is accounted for");

  const raised = verifiedHolderCallouts(rows, { minUsd: 100_000, walletUsdOf });
  assert.deepEqual(raised.rows.map((r) => r.username), ["netvyxe"], "the bar is tunable");
  console.log("  ok   the owner's gate: pump.fun gold check plus $1,000 of wallet SOL");
}
