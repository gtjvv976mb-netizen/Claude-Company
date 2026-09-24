/**
 * THE BROWSER LANE'S DIALS, AND THE CHECKLIST THAT ARMS THEM.
 *
 * Every number the entry contract and the exit determiner read is the executor's own —
 * SNIPE_LANE_DEFAULTS from executor/snipe-lane.mjs, imported, never retyped. What this
 * file adds is the handful of dials a browser lane has that a Node process does not: an
 * RPC the user pastes, how long a Phantom approval window may sit open, and how often to
 * ask again for a sell the user has not yet approved.
 *
 * ARMING IS A SENTENCE, AS IT IS ON WALL-ST-E. `snipeArmSentence(wallet, size, cap)` is
 * imported from the lane and compared byte for byte against what the user typed, for the
 * wallet Phantom actually connected. The numbers were typed by a person beside the wallet
 * they bind; a config that was pasted from somewhere cannot arm itself.
 *
 * STOCK QUOTES. pump.fun "Custom Pairs" let a launch be quoted in a token instead of SOL;
 * the ones this lane can be told to pay in are tokenised stocks (xStocks such as GLDx,
 * TSLAx, SPYx). `quoteMints` is the user's list of them, each with its own ticket, day
 * cap and minimum in THAT token's units. Empty — the default — means SOL only, exactly as
 * before. A listed mint is what the lane hands the executor as `quoteMintAllowlist`, and
 * the arm sentence names every listed mint and number, so a sentence typed for SOL alone
 * can never arm a stock trade.
 *
 * WHO SIGNS. `signerMode` is "phantom" (the default: one Phantom approval window per
 * trade, and the extension holds no key) or "autopilot" (the autopilot wallet — the
 * session wallet, the one module the background host imports for it — signs each buy and sell without a
 * window). The arming checklist and the arm sentence follow the mode: an autopilot lane
 * arms only for the autopilot wallet's own address, only while it is unlocked, only while
 * its balance covers a ticket, and only with a sentence that says, in words, that nothing
 * will ask before it signs. A sentence typed for Phantom cannot arm autopilot.
 *
 * THE SECOND VENUE: NEW xSTOCK POOLS, THROUGH JUPITER. `xstockVenue` (off by default)
 * turns on a discovery poll over public new-pool feeds for pools anywhere on Solana that
 * pair a token with an xStock, and a lane that trades them through Jupiter
 * (src/lib/xstock-lane.mjs). It pays in the pool's own stock, from the stock already in
 * the wallet, at that stock's listed ticket, canary and day cap — the same numbers the
 * pump.fun stock lane uses, charged to the same ledger. With no stock listed it watches the
 * built-in list and can only observe. Turning it on appends a clause to the arm sentence,
 * so a lane armed before the venue existed does not start trading it on an old sentence.
 */
import { PublicKey } from "@solana/web3.js";
import {
  SNIPE_LANE_DEFAULTS, SNIPE_OPERATOR_MAX, SNIPE_LANE_MODES,
  snipeArmSentence, effectiveLaneConfig, armabilityReport,
} from "../../vendor/executor/snipe-lane.mjs";
import { SNIPE_DEFAULTS as POLICY_DEFAULTS } from "../../vendor/executor/snipe-policy.mjs";
import { PUMPFUN_VENUE } from "../../vendor/executor/snipe-venue-pumpfun.mjs";
import { WSOL, unitsToRaw, RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS } from "./tx.mjs";

export const HAWK_BROWSER_VERSION = "coinmarketcat-v1";
export const LANE_MODES = SNIPE_LANE_MODES;
export { SNIPE_OPERATOR_MAX, snipeArmSentence };

/** Who signs a trade. Phantom is the default and holds no key here. */
export const SIGNER_MODES = Object.freeze(["phantom", "autopilot"]);
/** How long an unlock of the autopilot wallet lasts, in minutes: the default, and the fence. */
export const AUTOPILOT_UNLOCK_MINUTES = Object.freeze({ default: 480, min: 5, max: 1440 });

/** The canary: the size the lane's defaults were derived for. A ticket above it must
 *  carry a stop the operator chose (armabilityReport's stopExplicit). */
export const CANARY_SOL = 0.005;

/**
 * THE NEW-POOL FEEDS THE xSTOCK VENUE MAY POLL, AND WHAT IS KNOWN ABOUT EACH (read
 * 2026-09-24; the request shapes and limits are in src/lib/xstock-discovery.mjs):
 *   · geckoterminal — GET /networks/solana/new_pools: the 20 newest Solana pools of any
 *     pair, 30–60 s CDN-cached, free tier answers 429 quickly (observed on a first call).
 *   · dexscreener — GET /token-pairs/v1/solana/{stock}: up to 30 pools of one stock, either
 *     side, liquidity-ordered, 300 requests a minute (its API reference).
 *   · jupiter-gems — POST datapi.jup.ag/v1/pools/gems: the 30 newest launchpad pools with
 *     their quote mint. UNDOCUMENTED; it may change or stop without notice. Off by default.
 */
export const XSTOCK_SOURCES = Object.freeze(["geckoterminal", "dexscreener", "jupiter-gems"]);
export const XSTOCK_SOURCE_DEFAULTS = Object.freeze(["geckoterminal", "dexscreener"]);

/**
 * THE BUILT-IN xSTOCK LIST: the focus list when the user has listed no stock. Every
 * address is the Solana address the official product page (https://xstocks.com/us/products,
 * its embedded __NEXT_DATA__ products list, 1,008 products) gave for that symbol on
 * 2026-09-24. With no stock listed the venue can only OBSERVE pools in these: a stock with
 * no ticket is refused at `stock_not_listed`. Before paying in any stock the lane reads its
 * mint account and refuses a mint whose own symbol is not the listed one.
 */
export const XSTOCK_BUILTIN = Object.freeze([
  ["GLDx", "Gold xStock", "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re"],
  ["TSLAx", "Tesla xStock", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"],
  ["SPYx", "SP500 xStock", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"],
  ["AAPLx", "Apple xStock", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"],
  ["NVDAx", "NVIDIA xStock", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"],
  ["QQQx", "Nasdaq xStock", "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ"],
  ["MSTRx", "MicroStrategy xStock", "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ"],
  ["COINx", "Coinbase xStock", "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu"],
  ["HOODx", "Robinhood xStock", "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg"],
  ["CRCLx", "Circle xStock", "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1"],
  ["MSFTx", "Microsoft xStock", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"],
  ["GOOGLx", "Alphabet xStock", "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"],
  ["METAx", "Meta xStock", "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"],
  ["AMZNx", "Amazon xStock", "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"],
  ["SPCXx", "SpaceX xStock", "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"],
].map(([symbol, name, mint]) => Object.freeze({ symbol, name, mint, source: "xstocks.com/us/products, read 2026-09-24" })));

/**
 * WHAT IS NOT MEASURED ABOUT THE xSTOCK VENUE, IN WORDS THE UI PRINTS. Every figure in
 * RECORD is from pump.fun launches paid in SOL; none of it is about these pools.
 */
export const XSTOCK_UNMEASURED = "Nothing about new pools paired with an xStock has been measured by this lane: no win rate, " +
  "no follow-through rate, no fill. HAWK-AI's record is pump.fun launches paid in SOL. The feeds are cached for 30–60 s, " +
  "so a pool is typically first seen a minute or more after it was created; the 10 s wait and the follow-through rule run " +
  "from first sight, not from creation. Jupiter answers keyless requests at about 0.5 a second, so marks are seconds apart. " +
  "On the one pool read while this was built (GAYMF / GLDx, Raydium CPMM, 0.01 GLDx), a round trip through Jupiter returned " +
  "899,767 of 1,000,000 raw GLDx: about 10% before network fees, which the follow-through rule then has to clear.";

/**
 * The user-facing config. Keys that exist in SNIPE_LANE_DEFAULTS carry the lane's own
 * default; the rest are browser-only. `null` on a policy dial means "snipe-policy's own
 * default", exactly as it does in the lane.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  /* ── the connection ─────────────────────────────────────────────────────────────── */
  rpcUrl: "",                 // https://… — Helius, Triton, QuickNode; the public RPC 403s browsers
  rpcWsUrl: "",               // wss://… — derived from rpcUrl when blank
  secondaryRpcUrl: "",        // optional second reader; when set, both must agree on the curve
  consoleUrl: "https://gtjvv976mb-netizen.github.io/coinmarketcat/console/",   // the page Phantom lives on; a manifest match, not free text
  /* ── the lane ───────────────────────────────────────────────────────────────────── */
  lane: "off",                // off | observe | execute
  maxSolPerTrade: SNIPE_LANE_DEFAULTS.maxSolPerTrade,
  dailySolCap: SNIPE_LANE_DEFAULTS.dailySolCap,
  maxOpenPositions: 1,        // one Phantom window at a time is the whole point
  /* ── stock quotes (pump.fun Custom Pairs) ──────────────────────────────────────────
     [{ mint, symbol, maxPerTrade, dailyCap, minPerTrade }] in the STOCK's units. Empty =
     SOL only. Decimals are read from the mint account on chain, never typed here. The
     first live buy in each listed stock is sized at its minPerTrade (a canary) until one
     buy in that stock has been read back off the chain — see STOCK_CANARY_RULE. */
  quoteMints: Object.freeze([]),
  requireSocials: SNIPE_LANE_DEFAULTS.requireSocials,
  socialsTimeoutMs: SNIPE_LANE_DEFAULTS.socialsTimeoutMs,
  noticeMaxMs: SNIPE_LANE_DEFAULTS.noticeMaxMs,
  maxPriceImpactPct: SNIPE_LANE_DEFAULTS.maxPriceImpactPct,
  maxEntryRoundTripLossPct: SNIPE_LANE_DEFAULTS.maxEntryRoundTripLossPct,
  holdMaxMs: SNIPE_LANE_DEFAULTS.holdMaxMs,
  creatorExitFrac: SNIPE_LANE_DEFAULTS.creatorExitFrac,
  /* ── what the record changed ────────────────────────────────────────────────────────
     Three dials below carry a value the executor's 58- and 64-trade record justifies,
     and this file is where that is said. See README.md, "What HAWK-AI's trades taught
     it", for the tables; RECORD below carries the numbers. */
  entryWaitMs: 10_000,        // do not buy a launch younger than this: entries under 3s won 0 of 9
  entryFollowThroughX: 1.0,   // and only if the would-have-fill still marks at least this after the wait
  /* ── the exits (null = snipe-policy's own default) ──────────────────────────────── */
  stopFrac: null,
  takeAtEntryX: 1.5,          // the policy's own default is 2x; 44% of the 64 reached 1.5x, 25% reached 2x
  timeStopMs: null,
  stallMs: null,
  stallAtX: null,
  /* ── the two rulers, undefined until the shadow book grades them ────────────────── */
  maxCreatorSharePct: null,   // creator_profile: kills above this % of supply held by the deployer
  maxLaunchSharePct: null,    // launch_share: kills above this % of the opening quote already bought
  /* ── the shadow book ────────────────────────────────────────────────────────────── */
  forwardSamples: SNIPE_LANE_DEFAULTS.forwardSamples,
  forwardIntervalMs: SNIPE_LANE_DEFAULTS.forwardIntervalMs,
  shadowMaxOpen: 12,          // would-have positions sampled at once; beyond it rows are recorded unsampled
  shadowCapacity: 3_000,      // rows kept for the scorecard and the export
  /* ── the transaction ────────────────────────────────────────────────────────────── */
  computeUnitLimit: 260_000,
  priorityFeeLamports: SNIPE_LANE_DEFAULTS.priorityFeeLamports,
  sellToleranceFrac: 0.10,    // the sell floor sits this far under the curve's own quote
  /* ── the human in the loop ──────────────────────────────────────────────────────── */
  approvalTimeoutMs: 25_000,  // a buy whose Phantom window sits longer than this is abandoned
  sellReaskMs: 8_000,         // a declined or unanswered sell is asked again after this
  tickMs: 1_000,
  liveAck: "",                // the arm sentence, typed
  /* ── who signs ──────────────────────────────────────────────────────────────────────
     "phantom": one Phantom approval window per trade; the extension holds no key.
     "autopilot": the autopilot wallet signs without a window. It must exist, be unlocked
     and be funded, and the arm sentence says so in words. */
  signerMode: "phantom",
  autopilotUnlockMinutes: AUTOPILOT_UNLOCK_MINUTES.default,
  /* ── the first-run setup ────────────────────────────────────────────────────────────── */
  stylePreset: "",            // "" until the setup page is saved: cautious | balanced | bold | custom
  setupCompletedAt: 0,        // when the setup page was saved (ms), 0 = never
  /* ── the second venue: new pools pairing a token with an xStock, through Jupiter ─────
     OFF by default. On, it follows the lane: Off does nothing, Observe discovers and keeps
     would-have positions, Execute (armed) buys and sells. See src/lib/xstock-lane.mjs. */
  xstockVenue: false,
  xstockSources: XSTOCK_SOURCE_DEFAULTS,   // which new-pool feeds to poll (XSTOCK_SOURCES)
  xstockPollMs: 30_000,       // how often the feeds are polled; their own caches are 30–60 s
  xstockMaxPoolAgeMs: 300_000,// a pool first seen older than this is refused at notice_stale — unmeasured, see XSTOCK_UNMEASURED
  xstockSlippageBps: 300,     // the slippage cap written into the Jupiter instruction; the executor's LIVE_LIMITS figure
  xstockMaxOpen: 2,           // would-have rows this venue marks at once: every mark is one Jupiter call at 0.5 per second
});

const NUMBER_KEYS = new Set([
  "maxSolPerTrade", "dailySolCap", "maxOpenPositions", "socialsTimeoutMs", "noticeMaxMs",
  "maxPriceImpactPct", "maxEntryRoundTripLossPct", "holdMaxMs", "creatorExitFrac",
  "entryWaitMs", "entryFollowThroughX",
  "stopFrac", "takeAtEntryX", "timeStopMs", "stallMs", "stallAtX",
  "maxCreatorSharePct", "maxLaunchSharePct",
  "forwardSamples", "forwardIntervalMs", "shadowMaxOpen", "shadowCapacity",
  "computeUnitLimit", "priorityFeeLamports", "sellToleranceFrac",
  "approvalTimeoutMs", "sellReaskMs", "tickMs",
  "autopilotUnlockMinutes", "setupCompletedAt",
  "xstockPollMs", "xstockMaxPoolAgeMs", "xstockSlippageBps", "xstockMaxOpen",
]);
const NULLABLE = new Set(["stopFrac", "takeAtEntryX", "timeStopMs", "stallMs", "stallAtX", "maxCreatorSharePct", "maxLaunchSharePct"]);

/**
 * THE RECORD, AS NUMBERS THE UI CAN SHOW. Every figure is copied from Claude-Company's
 * executor/README.md ("What 58 real trades changed", "The first six trades after those
 * changes", "What the coins actually did"), read back off mainnet by the owner on
 * 2026-09-17, nothing sampled. It is here so the arming screen can put the expected
 * value in front of the person about to type the sentence, in the record's own words.
 */
export const RECORD = Object.freeze({
  readAt: "2026-09-17",
  first58: Object.freeze({ trades: 58, won: 10, lost: 48, netSol: -1.5793, avgWinnerPct: 75, avgLoserPct: -22 }),
  after: Object.freeze({ trades: 6, won: 1, lost: 5, netSol: -0.0693, perTradeSol: -0.0116 }),
  all64: Object.freeze({ trades: 64, netSol: -0.361, bestModelledLadderSol: -0.122 }),
  tenMinuteClock: Object.freeze({ ran: 18, won: 0 }),
  bySecondsLate: Object.freeze([
    Object.freeze({ bucket: "under 3s", n: 9, wonPct: 0, meanPct: -18.5 }),
    Object.freeze({ bucket: "3–6s", n: 25, wonPct: 20, meanPct: -2.6 }),
    Object.freeze({ bucket: "6–10s", n: 20, wonPct: 10, meanPct: -23.4 }),
    Object.freeze({ bucket: "10s+", n: 10, wonPct: 40, meanPct: 34.0 }),
  ]),
  bySize: Object.freeze([
    Object.freeze({ bucket: "0.05–0.15 SOL", n: 1, wonPct: 100, netSol: 0.22 }),
    Object.freeze({ bucket: "0.15–0.25 SOL", n: 8, wonPct: 25, netSol: 0.12 }),
    Object.freeze({ bucket: "0.25–0.35 SOL", n: 19, wonPct: 21, netSol: -0.33 }),
    Object.freeze({ bucket: "0.35 SOL+", n: 30, wonPct: 10, netSol: -1.58 }),
  ]),
  reached: Object.freeze([
    Object.freeze({ x: 1.05, of64: 48 }), Object.freeze({ x: 1.2, of64: 35 }), Object.freeze({ x: 1.5, of64: 28 }),
    Object.freeze({ x: 2, of64: 16 }), Object.freeze({ x: 3, of64: 4 }),
  ]),
  takeAt15xWorthSol: 0.24,      // modelled, at a 0.1 SOL ticket, over the 64
  socialsFilterMovedWinRate: false,
  entrySignalsOrderOutcome: false,   // Spearman |ρ| < 0.13 on every signal measured at entry
  sizeBucketWarnAboveSol: 0.15,
});
const BOOL_KEYS = new Set(["requireSocials", "xstockVenue"]);

/** The feed list, from an array or the comma-separated text a form sends. */
export function normalizeXstockSources(value) {
  if (value === null || value === undefined || value === "") return Object.freeze([]);
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (!XSTOCK_SOURCES.includes(id)) throw new ConfigError("xstockSources", `xstockSources: ${JSON.stringify(id)} is not a feed this venue knows (${XSTOCK_SOURCES.join(", ")})`);
    if (!out.includes(id)) out.push(id);
  }
  return Object.freeze(out);
}

/** The stocks the xStock venue watches: the listed ones (each with a ticket), or — when
 *  none is listed — the built-in list, which can only be observed. */
export function xstockFocusList(config) {
  const listed = (config?.quoteMints ?? []).map((q) => Object.freeze({ mint: q.mint, symbol: q.symbol, listed: true }));
  if (listed.length) return Object.freeze(listed);
  return Object.freeze(XSTOCK_BUILTIN.map((b) => Object.freeze({ mint: b.mint, symbol: b.symbol, listed: false })));
}
const STRING_KEYS = new Set(["rpcUrl", "rpcWsUrl", "secondaryRpcUrl", "consoleUrl", "lane", "liveAck", "signerMode", "stylePreset"]);

/**
 * THE THREE STYLES THE FIRST-RUN SETUP OFFERS. Each fills the limits a new user is asked
 * about — the ticket, the day's budget, the take, the stall and the time stop — and leaves
 * the entry rule alone: every style waits 10 s and buys only a launch that still marks at
 * or above its would-have fill.
 *
 *   · BALANCED is the lane's own defaults: the record's exits (1.5x take, 90 s stall, 180 s
 *     time stop, from snipe-policy and the record) at the executor's 0.005 SOL canary and
 *     its 0.01 SOL day.
 *   · CAUTIOUS is no looser than Balanced on any dial and tighter on three: one canary a
 *     day, and a flat launch is left at 60 s and any launch at 120 s. Those tighter exits
 *     are a choice, not a measurement: nothing in the record says they do better.
 *   · BOLD is LOOSER, and says so: a ticket ten times the canary, a 2x take, a 120 s stall
 *     and a five-minute clock. On the record, 16 of 64 coins ever reached 2x (28 reached
 *     1.5x), and positions held 120–300 s won 0 of 3. It proposes a 0.5x stop, which the
 *     user must keep or change: a ticket above the canary cannot arm without a stop chosen.
 *
 * test-hawk-autopilot.mjs holds Cautious and Balanced to "no looser than the defaults" dial
 * by dial, and Bold to "labelled looser".
 */
export const STYLE_PRESETS = Object.freeze({
  cautious: Object.freeze({
    id: "cautious", label: "Cautious", looser: false,
    summary: "Tighter than the lane's defaults: one 0.005 SOL canary a day, a flat launch left at 60 s, any launch left at 120 s. The tighter exits are a choice, not a measured improvement.",
    values: Object.freeze({ maxSolPerTrade: 0.005, dailySolCap: 0.005, takeAtEntryX: 1.5, stallMs: 60_000, timeStopMs: 120_000, stopFrac: null, entryWaitMs: 10_000, entryFollowThroughX: 1.0 }),
  }),
  balanced: Object.freeze({
    id: "balanced", label: "Balanced", looser: false,
    summary: "The lane's own defaults: the record's exits (1.5× take, 90 s stall, 180 s time stop) at the executor's 0.005 SOL canary, up to two tickets a day.",
    values: Object.freeze({ maxSolPerTrade: SNIPE_LANE_DEFAULTS.maxSolPerTrade, dailySolCap: SNIPE_LANE_DEFAULTS.dailySolCap, takeAtEntryX: 1.5,
      stallMs: POLICY_DEFAULTS.stallMs, timeStopMs: POLICY_DEFAULTS.timeStopMs, stopFrac: null, entryWaitMs: 10_000, entryFollowThroughX: 1.0 }),
  }),
  bold: Object.freeze({
    id: "bold", label: "Bold — looser than the record supports", looser: true,
    summary: "LOOSER than the record supports: a 0.05 SOL ticket (ten canaries), a 2× take (16 of the record's 64 coins ever reached 2×), a 120 s stall and a five-minute clock (positions held 120–300 s won 0 of 3). It proposes a 0.5× stop; keep it or choose your own. Every modelled variant of the record still loses.",
    values: Object.freeze({ maxSolPerTrade: 0.05, dailySolCap: 0.25, takeAtEntryX: 2, stallMs: 120_000, timeStopMs: 300_000, stopFrac: 0.5, entryWaitMs: 10_000, entryFollowThroughX: 1.0 }),
  }),
});
export const STYLE_PRESET_IDS = Object.freeze(["", ...Object.keys(STYLE_PRESETS), "custom"]);

/** How many stocks one lane may list. A list is typed by a person; eight is plenty. */
export const MAX_QUOTE_MINTS = 8;

/**
 * THE CANARY RULE FOR STOCK QUOTES, IN WORDS THE UI PRINTS VERBATIM.
 * When this lane was built, no buy on a stock-quoted pump.fun curve had been observed on
 * chain — only one sell. The buy's account order rests on the venue's IDL and on the SOL
 * buys it was proved against. So the first live buy in each listed stock is sized at
 * that stock's minPerTrade, and the full ticket is used only after one buy in that stock
 * has landed and its fill has been read back from the chain's own balances.
 */
export const STOCK_CANARY_RULE = "the first live buy in each listed stock is sized at its minPerTrade (a canary); " +
  "the full ticket is used only after one buy in that stock has landed and its fill was read back off the chain. " +
  "No buy on a stock-quoted pump.fun curve had been observed on chain when this lane was built. " +
  "A buy that lands but cannot be read back or booked blocks that stock until you clear it in the popup.";

/**
 * Tokenised stocks whose mint accounts were read off mainnet (the vendored fixture
 * vendor/executor/fixtures/pumpfun-xstock-quote.json, slot 449,986,225): the address and
 * the symbol in each mint's own TokenMetadata. Offered as a shortcut in the options page;
 * nothing is listed until the user adds it and types its numbers.
 */
export const KNOWN_STOCK_QUOTES = Object.freeze([
  Object.freeze({ mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", symbol: "GLDx", name: "Gold xStock" }),
  Object.freeze({ mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", symbol: "TSLAx", name: "Tesla xStock" }),
  Object.freeze({ mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", name: "SP500 xStock" }),
]);

/**
 * THE STOCKS A NEW USER MAY CHOOSE TO FOCUS ON, WITH WHERE EACH ADDRESS CAME FROM.
 * The three above are read from their mint accounts in the vendored fixture, and a test
 * reads those bytes. AAPLx and NVDAx were read from their mint accounts over RPC on
 * 2026-09-24 (getAccountInfo, jsonParsed: Token-2022, 8 decimals, the symbol in the
 * mint's own TokenMetadata) and are on pump.fun's quote-mint whitelist, but they are
 * NOT in the vendored fixture, so no test here reads their bytes: the lane checks each
 * mint's own symbol against the list on every read, and refuses a mismatch by name. Both
 * carry a display multiplier (Phantom shows them scaled; this lane counts raw units).
 */
export const STOCK_FOCUS_CHOICES = Object.freeze([
  ...KNOWN_STOCK_QUOTES.map((k) => Object.freeze({ ...k, source: "fixture", sourceNote: "read from its mint account in the vendored fixture (slot 449,986,225); a test reads those bytes" })),
  Object.freeze({ mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", symbol: "AAPLx", name: "Apple xStock", source: "rpc-2026-09-24",
    sourceNote: "read from its mint account over RPC on 2026-09-24; not in the vendored fixture, so no test here reads its bytes" }),
  Object.freeze({ mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", symbol: "NVDAx", name: "NVIDIA xStock", source: "rpc-2026-09-24",
    sourceNote: "read from its mint account over RPC on 2026-09-24; not in the vendored fixture, so no test here reads its bytes" }),
]);

/** One entry of `quoteMints`, validated; a malformed one is refused under the key "quoteMints". */
function normalizeQuoteMint(entry, index) {
  const where = `quoteMints[${index}]`;
  const bad = (message) => { throw new ConfigError("quoteMints", `${where}: ${message}`); };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) bad("must be an object { mint, symbol, maxPerTrade, dailyCap, minPerTrade }");
  const mint = typeof entry.mint === "string" ? entry.mint.trim() : "";
  let decoded = null;
  try { decoded = new PublicKey(mint); } catch { decoded = null; }
  if (!decoded || decoded.toBase58() !== mint) bad(`mint ${JSON.stringify(entry.mint)} is not a base58 32-byte address`);
  if (mint === WSOL) bad("wrapped SOL is not a stock quote — SOL is always on, sized by maxSolPerTrade");
  const symbol = typeof entry.symbol === "string" ? entry.symbol.trim() : "";
  if (!(symbol.length >= 1 && symbol.length <= 12) || /[\s<>"'&]/.test(symbol)) bad("symbol must be 1 to 12 characters with no spaces");
  const num = (key, { required = true } = {}) => {
    const v = entry[key];
    if (v === undefined || v === null || v === "") { if (required) bad(`${key} is required`); return null; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) bad(`${key} must be a positive number of ${symbol}, got ${JSON.stringify(v)}`);
    return n;
  };
  const maxPerTrade = num("maxPerTrade");
  const dailyCap = num("dailyCap");
  const minPerTrade = num("minPerTrade", { required: false }) ?? maxPerTrade;
  if (dailyCap < maxPerTrade) bad(`dailyCap ${dailyCap} ${symbol} is under maxPerTrade ${maxPerTrade} — not one launch could be taken`);
  if (minPerTrade > maxPerTrade) bad(`minPerTrade ${minPerTrade} ${symbol} is above maxPerTrade ${maxPerTrade}`);
  /* Eighteen decimals is the most any mint can carry; a number finer than that is no
     amount at all. The mint's real decimals are checked again when it is read. */
  for (const [key, v] of [["maxPerTrade", maxPerTrade], ["dailyCap", dailyCap], ["minPerTrade", minPerTrade]]) {
    try { unitsToRaw(v, 18, key); } catch (error) { bad(error.message); }
  }
  return Object.freeze({ mint, symbol, maxPerTrade, dailyCap, minPerTrade });
}

/** The whole list, from an array or from the JSON text the options page sends. */
export function normalizeQuoteMints(value) {
  let list = value;
  if (list === null || list === undefined || list === "") return Object.freeze([]);
  if (typeof list === "string") {
    try { list = JSON.parse(list); }
    catch (error) { throw new ConfigError("quoteMints", `quoteMints is not valid JSON: ${error.message}`); }
  }
  if (!Array.isArray(list)) throw new ConfigError("quoteMints", "quoteMints must be a list of { mint, symbol, maxPerTrade, dailyCap, minPerTrade }");
  if (list.length > MAX_QUOTE_MINTS) throw new ConfigError("quoteMints", `at most ${MAX_QUOTE_MINTS} stock quotes may be listed, got ${list.length}`);
  const out = list.map(normalizeQuoteMint);
  const seen = new Set();
  for (const q of out) {
    if (seen.has(q.mint)) throw new ConfigError("quoteMints", `quoteMints lists ${q.mint} twice`);
    seen.add(q.mint);
  }
  return Object.freeze(out);
}

/** The console pages the manifest's content script matches; the bridge exists nowhere else. */
export const CONSOLE_URLS = Object.freeze([
  "https://gtjvv976mb-netizen.github.io/coinmarketcat/console/",
  "https://claudedotcompany.com/hawk",
  "https://www.claudedotcompany.com/hawk",
  "http://localhost:4949/console/",  // the site served locally: python3 -m http.server 4949 --directory site
  "http://127.0.0.1:4949/console/",
]);

export class ConfigError extends Error {
  constructor(key, message) { super(message); this.name = "ConfigError"; this.key = key; }
}

/** Coerce whatever storage or a form handed back into a config, refusing the malformed by
 *  name. Unknown keys are dropped, not carried: a dial nobody reads is a dial nobody sees. */
export function normalizeConfig(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...CONFIG_DEFAULTS };
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (!(key in src) || src[key] === undefined) continue;
    const v = src[key];
    if (key === "quoteMints") { out.quoteMints = normalizeQuoteMints(v); continue; }
    if (key === "xstockSources") { out.xstockSources = normalizeXstockSources(v); continue; }
    if (STRING_KEYS.has(key)) { out[key] = v === null ? "" : String(v).trim(); continue; }
    if (BOOL_KEYS.has(key)) { out[key] = v === true || v === "true" || v === 1 || v === "1"; continue; }
    if (NUMBER_KEYS.has(key)) {
      if (v === null || v === "") { out[key] = NULLABLE.has(key) ? null : CONFIG_DEFAULTS[key]; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ConfigError(key, `${key} must be a number, got ${JSON.stringify(v)}`);
      out[key] = n;
    }
  }
  if (!LANE_MODES.includes(out.lane)) throw new ConfigError("lane", `lane must be one of ${LANE_MODES.join(", ")}, got ${JSON.stringify(out.lane)}`);
  if (out.rpcUrl && !/^https:\/\/\S+$/i.test(out.rpcUrl)) throw new ConfigError("rpcUrl", "rpcUrl must be an https:// URL");
  if (out.secondaryRpcUrl && !/^https:\/\/\S+$/i.test(out.secondaryRpcUrl)) throw new ConfigError("secondaryRpcUrl", "secondaryRpcUrl must be an https:// URL");
  if (out.rpcWsUrl && !/^wss:\/\/\S+$/i.test(out.rpcWsUrl)) throw new ConfigError("rpcWsUrl", "rpcWsUrl must be a wss:// URL");
  if (!CONSOLE_URLS.some((u) => out.consoleUrl === u || out.consoleUrl.startsWith(`${u}?`) || out.consoleUrl.startsWith(`${u}#`)))
    throw new ConfigError("consoleUrl", `consoleUrl must be one of the pages the extension is built for: ${CONSOLE_URLS.join(", ")}`);
  if (!(out.maxSolPerTrade > 0)) throw new ConfigError("maxSolPerTrade", "maxSolPerTrade must be positive");
  if (out.maxSolPerTrade > SNIPE_OPERATOR_MAX.maxSolPerTrade)
    throw new ConfigError("maxSolPerTrade", `maxSolPerTrade may not exceed the operator maximum of ${SNIPE_OPERATOR_MAX.maxSolPerTrade} SOL`);
  if (!(out.dailySolCap > 0)) throw new ConfigError("dailySolCap", "dailySolCap must be positive");
  if (out.dailySolCap > SNIPE_OPERATOR_MAX.dailySolCap)
    throw new ConfigError("dailySolCap", `dailySolCap may not exceed the operator maximum of ${SNIPE_OPERATOR_MAX.dailySolCap} SOL`);
  if (out.dailySolCap < out.maxSolPerTrade)
    throw new ConfigError("dailySolCap", "dailySolCap is under maxSolPerTrade — not one launch could be taken");
  if (!(Number.isInteger(out.maxOpenPositions) && out.maxOpenPositions >= 1 && out.maxOpenPositions <= 5))
    throw new ConfigError("maxOpenPositions", "maxOpenPositions must be a whole number from 1 to 5");
  if (!(out.sellToleranceFrac >= 0 && out.sellToleranceFrac < 0.5))
    throw new ConfigError("sellToleranceFrac", "sellToleranceFrac must be between 0 and 0.5");
  if (out.stopFrac !== null && !(out.stopFrac > 0 && out.stopFrac < 1))
    throw new ConfigError("stopFrac", "stopFrac is the fraction of entry at which the whole position leaves: between 0 and 1");
  if (out.takeAtEntryX !== null && !(out.takeAtEntryX > 1))
    throw new ConfigError("takeAtEntryX", "takeAtEntryX must be above 1");
  if (!(out.entryWaitMs >= 0 && out.entryWaitMs <= 120_000)) throw new ConfigError("entryWaitMs", "entryWaitMs must be 0..120000");
  if (!(out.entryFollowThroughX >= 0 && out.entryFollowThroughX <= 3)) throw new ConfigError("entryFollowThroughX", "entryFollowThroughX must be 0..3 (0 turns the check off)");
  if (out.maxCreatorSharePct !== null && !(out.maxCreatorSharePct > 0 && out.maxCreatorSharePct <= 100)) throw new ConfigError("maxCreatorSharePct", "maxCreatorSharePct must be a percentage, or blank to measure only");
  if (out.maxLaunchSharePct !== null && !(out.maxLaunchSharePct > 0)) throw new ConfigError("maxLaunchSharePct", "maxLaunchSharePct must be positive, or blank to measure only");
  if (!(Number.isInteger(out.forwardSamples) && out.forwardSamples >= 1 && out.forwardSamples <= 120)) throw new ConfigError("forwardSamples", "forwardSamples must be 1..120");
  if (!(out.forwardIntervalMs >= 1_000 && out.forwardIntervalMs <= 60_000)) throw new ConfigError("forwardIntervalMs", "forwardIntervalMs must be 1000..60000");
  if (!(Number.isInteger(out.shadowMaxOpen) && out.shadowMaxOpen >= 0 && out.shadowMaxOpen <= 50)) throw new ConfigError("shadowMaxOpen", "shadowMaxOpen must be 0..50");
  if (!(Number.isInteger(out.shadowCapacity) && out.shadowCapacity >= 100 && out.shadowCapacity <= 20_000)) throw new ConfigError("shadowCapacity", "shadowCapacity must be 100..20000");
  if (!(out.tickMs >= 500 && out.tickMs <= 10_000)) throw new ConfigError("tickMs", "tickMs must be 500..10000");
  if (!(out.approvalTimeoutMs >= 5_000)) throw new ConfigError("approvalTimeoutMs", "approvalTimeoutMs must be at least 5000");
  if (!(out.computeUnitLimit >= 50_000 && out.computeUnitLimit <= 1_400_000))
    throw new ConfigError("computeUnitLimit", "computeUnitLimit must be 50000..1400000");
  if (!(out.priorityFeeLamports >= 0)) throw new ConfigError("priorityFeeLamports", "priorityFeeLamports must be >= 0");
  if (!SIGNER_MODES.includes(out.signerMode))
    throw new ConfigError("signerMode", `signerMode must be one of ${SIGNER_MODES.join(", ")}, got ${JSON.stringify(out.signerMode)}`);
  if (!(Number.isInteger(out.autopilotUnlockMinutes) && out.autopilotUnlockMinutes >= AUTOPILOT_UNLOCK_MINUTES.min && out.autopilotUnlockMinutes <= AUTOPILOT_UNLOCK_MINUTES.max))
    throw new ConfigError("autopilotUnlockMinutes", `autopilotUnlockMinutes must be a whole number from ${AUTOPILOT_UNLOCK_MINUTES.min} to ${AUTOPILOT_UNLOCK_MINUTES.max}`);
  if (!STYLE_PRESET_IDS.includes(out.stylePreset))
    throw new ConfigError("stylePreset", `stylePreset must be one of ${STYLE_PRESET_IDS.filter(Boolean).join(", ")} or blank`);
  if (!(Number.isFinite(out.setupCompletedAt) && out.setupCompletedAt >= 0)) throw new ConfigError("setupCompletedAt", "setupCompletedAt must be a time in ms, or 0");
  if (out.stallMs !== null && !(out.stallMs >= 0)) throw new ConfigError("stallMs", "stallMs must be >= 0 (0 turns the stall exit off), or blank for the policy's 90000");
  if (out.timeStopMs !== null && !(out.timeStopMs > 0)) throw new ConfigError("timeStopMs", "timeStopMs must be above 0, or blank for the policy's 180000");
  if (!(out.xstockPollMs >= 15_000 && out.xstockPollMs <= 600_000)) throw new ConfigError("xstockPollMs", "xstockPollMs must be 15000..600000: the feeds are cached for 30–60 s and rate-limited");
  if (!(out.xstockMaxPoolAgeMs >= 30_000 && out.xstockMaxPoolAgeMs <= 3_600_000)) throw new ConfigError("xstockMaxPoolAgeMs", "xstockMaxPoolAgeMs must be 30000..3600000");
  if (!(Number.isInteger(out.xstockSlippageBps) && out.xstockSlippageBps >= 1 && out.xstockSlippageBps <= 1_000))
    throw new ConfigError("xstockSlippageBps", "xstockSlippageBps must be a whole number of basis points from 1 to 1000");
  if (!(Number.isInteger(out.xstockMaxOpen) && out.xstockMaxOpen >= 0 && out.xstockMaxOpen <= 5)) throw new ConfigError("xstockMaxOpen", "xstockMaxOpen must be a whole number from 0 to 5");
  if (out.xstockVenue && out.xstockSources.length === 0) throw new ConfigError("xstockSources", "the xStock venue is on but no feed is chosen — choose at least one, or turn the venue off");
  return Object.freeze(out);
}

/**
 * WHAT ONE AUTOPILOT BUY NEEDS IN THE WALLET, IN LAMPORTS. The ticket (SOL-quoted; a
 * stock-quoted buy pays its ticket in the stock), the buy's modelled network fee and rent,
 * one sell's fee — so the position can always be sold — and the rent-exempt floor the
 * wallet must keep. The autopilot balance check refuses a buy the wallet cannot cover, and
 * the arming checklist is red while it could not cover even one.
 */
export function autopilotBuyNeedLamports(config, { ticketLamports = null, quoteAtaCreate = false } = {}) {
  const fees = feeModelFor(config, { quoteAtaCreate });
  const ticket = ticketLamports === null ? BigInt(Math.round(Number(config.maxSolPerTrade) * 1e9)) : BigInt(ticketLamports);
  const buyFees = BigInt(fees.signatureFeeLamports) + BigInt(fees.prioritizationFeeLamports) + BigInt(fees.rentFeeLamports);
  const sellFee = BigInt(fees.signatureFeeLamports) + BigInt(fees.prioritizationFeeLamports);
  const reserve = BigInt(RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS);
  return Object.freeze({ ticket, buyFees, sellFee, reserve, total: ticket + buyFees + sellFee + reserve });
}
const lamportsToSol = (v) => Number(BigInt(v)) / 1e9;

/** The websocket the feed dials: the pasted one, else the https URL with its scheme turned. */
export function websocketUrlFor(config) {
  if (config.rpcWsUrl) return config.rpcWsUrl;
  if (!config.rpcUrl) return "";
  return config.rpcUrl.replace(/^https:/i, "wss:");
}

/**
 * The config the entry contract reads: the lane's own defaults under the user's dials.
 * `lane` here is what the contract's `lane_off` gate sees, so a browser lane that is
 * armed for execute presents "execute", and one merely watching presents "observe".
 */
export function laneConfigFor(config, { lane = config.lane } = {}) {
  const cfg = {
    ...SNIPE_LANE_DEFAULTS,
    lane,
    maxSolPerTrade: config.maxSolPerTrade,
    dailySolCap: config.dailySolCap,
    requireSocials: config.requireSocials === true,
    socialsTimeoutMs: config.socialsTimeoutMs,
    noticeMaxMs: config.noticeMaxMs,
    maxPriceImpactPct: config.maxPriceImpactPct,
    maxEntryRoundTripLossPct: config.maxEntryRoundTripLossPct,
    holdMaxMs: config.holdMaxMs,
    creatorExitFrac: config.creatorExitFrac,
    priorityFeeLamports: config.priorityFeeLamports,
    forwardSamples: config.forwardSamples,
    forwardIntervalMs: config.forwardIntervalMs,
    shadowCapacity: config.shadowCapacity,
    maxCreatorSharePct: config.maxCreatorSharePct === null ? undefined : config.maxCreatorSharePct,
    maxLaunchSharePct: config.maxLaunchSharePct === null ? undefined : config.maxLaunchSharePct,
    stopFrac: config.stopFrac,
    takeAtEntryX: config.takeAtEntryX,
    timeStopMs: config.timeStopMs,
    stallMs: config.stallMs,
    stallAtX: config.stallAtX,
    liveAck: config.liveAck || null,
    /* The mints the contract's quote_not_sol gate may admit; each still needs its facts
       (describeMint of the mint account) handed in beside it, or it is refused by name. */
    quoteMintAllowlist: Object.freeze((config.quoteMints ?? []).map((q) => q.mint)),
  };
  return effectiveLaneConfig(cfg);
}

/** The listed stock for a mint, or null. */
export function quoteEntryFor(config, mint) {
  return (config.quoteMints ?? []).find((q) => q.mint === mint) ?? null;
}

/** What snipePolicy() reads: its own defaults under the folded policy dials. */
export function policyConfigFor(config) {
  const eff = laneConfigFor(config);
  return Object.freeze({ ...POLICY_DEFAULTS, ...(eff.policy ?? {}) });
}

/** The fee model the contract's fee gates judge, mirroring snipe-lane's feeModel(). A
 *  stock-quoted buy may create TWO token accounts (the launch token's and the stock's),
 *  so its rent is modelled at two creates: 4,078,560 lamports, under the 4,200,000 rent
 *  cap. The measured rent of the two is 1,513,840 + 1,559,560 = 3,073,400. */
export function feeModelFor(config, { quoteAtaCreate = false } = {}) {
  const rent = Number(SNIPE_LANE_DEFAULTS.rentFeeLamports) || 0;
  return Object.freeze({
    signatureFeeLamports: Number(SNIPE_LANE_DEFAULTS.signatureFeeLamports) || 0,
    prioritizationFeeLamports: Number(config.priorityFeeLamports) || 0,
    rentFeeLamports: quoteAtaCreate ? rent * 2 : rent,
  });
}

/**
 * THE ARM SENTENCE FOR THIS BROWSER LANE. With no stock listed it is the executor's own
 * `snipeArmSentence`, byte for byte. With stocks listed, every one is appended with its
 * ticket, its canary, its day cap and its MINT ADDRESS, so the typed acknowledgement binds
 * the exact mint the way the executor's binds the wallet: a SOL sentence cannot arm a
 * GLDx trade, and a sentence typed before a list changed does not arm after it.
 */
export function browserArmSentence(wallet, maxSolPerTrade, dailySolCap, quoteMints = [], { autopilot = false, xstockVenue = false } = {}) {
  const base = snipeArmSentence(wallet, maxSolPerTrade, dailySolCap);
  const stocks = !Array.isArray(quoteMints) || quoteMints.length === 0 ? "" : ` — and in stock quotes: ${quoteMints.map((q) =>
    `${q.maxPerTrade} ${q.symbol} per launch (the first at ${q.minPerTrade} ${q.symbol}), ${q.dailyCap} ${q.symbol} per day (${q.mint})`).join("; ")}`;
  /* THE SECOND VENUE SAYS SO IN THE SENTENCE. With it off the sentence is exactly what it
     was; with it on, a sentence typed before it was switched on no longer matches. */
  const venue = xstockVenue ? XSTOCK_ARM_CLAUSE : "";
  /* AUTOPILOT SAYS SO IN THE SENTENCE. The wallet above is then the autopilot wallet's own
     address, and the words below are what the person is agreeing to: no window, no click. */
  return `${base}${stocks}${venue}${autopilot ? AUTOPILOT_ARM_CLAUSE : ""}`;
}
/** The words an autopilot arm sentence ends with. */
export const AUTOPILOT_ARM_CLAUSE = " — signed without asking me, by the autopilot key this browser holds";
/** The words the xStock venue adds to the arm sentence. */
export const XSTOCK_ARM_CLAUSE = " — and new pools pairing a token with those stocks, bought and sold through Jupiter at those stocks' limits";

/**
 * THE ARMING CHECKLIST FOR A BROWSER LANE. The lane's own armabilityReport (size within
 * the operator max, the daily cap charged, the take and stop fundable, exit signals
 * wired, the venue proved) plus the facts only this host can know: an RPC, the signer —
 * a connected Phantom on an open console tab, or on autopilot an autopilot wallet that
 * exists, is unlocked and holds enough for one buy — the typed sentence for THAT wallet,
 * and a stop the operator chose once the ticket is above the canary.
 *
 * `autopilot` is { publicKey, unlocked, expiresAt, balanceLamports } — what the engine
 * last read of the autopilot wallet; it is read only when config.signerMode is autopilot.
 */
export function browserArmability({ config, wallet = null, hasBridge = false, autopilot = null }) {
  const items = [];
  const add = (name, ok, detail) => items.push({ name, ok: ok === true, detail });
  const onAutopilot = config.signerMode === "autopilot";
  add("rpc_configured", Boolean(config.rpcUrl), config.rpcUrl ? `reads and sends through ${new URL(config.rpcUrl).host}` : "no RPC URL is set — the public RPC refuses browsers");
  let need = null, balance = null;
  if (!onAutopilot) {
    add("console_page_open", hasBridge, hasBridge ? "the console tab is open and the bridge answers" : "open the console page in a tab (the popup's Console button opens it); Phantom lives there");
    add("phantom_connected", typeof wallet === "string" && wallet.length > 30, wallet ? `Phantom connected as ${wallet}` : "Phantom is not connected on the console page");
  } else {
    /* THE AUTOPILOT WALLET IN PLACE OF PHANTOM: it exists, it is unlocked, and it holds
       enough for one ticket, its fees, one sell's fee and the rent floor. The console tab
       is not needed to trade in this mode; it is needed only to fund from Phantom. */
    const exists = typeof autopilot?.publicKey === "string" && autopilot.publicKey.length > 30;
    add("autopilot_wallet_created", exists, exists ? `the autopilot wallet is ${autopilot.publicKey}` : "create the autopilot wallet in the popup (a passphrase of 12 characters or more)");
    const unlocked = exists && autopilot.unlocked === true;
    const until = Number.isFinite(Number(autopilot?.expiresAt)) && Number(autopilot.expiresAt) > 0
      ? ` until ${new Date(Number(autopilot.expiresAt)).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    add("autopilot_unlocked", unlocked, unlocked
      ? `unlocked${until}; locking clears the unlocked key and stops the lane buying`
      : "locked — unlock it in the popup with your passphrase; a locked wallet signs nothing");
    need = autopilotBuyNeedLamports(config);
    balance = autopilot?.balanceLamports === null || autopilot?.balanceLamports === undefined ? null : BigInt(autopilot.balanceLamports);
    add("autopilot_funded", balance !== null && balance >= need.total, balance === null
      ? "the autopilot wallet's balance has not been read yet"
      : `it holds ${lamportsToSol(balance)} SOL; one buy needs up to ${lamportsToSol(need.total)} SOL (the ${config.maxSolPerTrade} SOL ticket, ~${lamportsToSol(need.buyFees)} SOL of fee and rent, one sell's fee, and the ${lamportsToSol(need.reserve)} SOL rent floor)${balance >= need.total ? "" : " — fund it from Phantom in the popup"}`);
  }
  const stopExplicit = config.stopFrac !== null;
  add("stop_chosen_above_canary", config.maxSolPerTrade <= CANARY_SOL || stopExplicit,
    config.maxSolPerTrade <= CANARY_SOL
      ? `the ${config.maxSolPerTrade} SOL ticket is at or under the ${CANARY_SOL} SOL canary; the lane's own 0.20x stop applies`
      : stopExplicit ? `stop ${config.stopFrac}x of entry, chosen for a ${config.maxSolPerTrade} SOL ticket`
        : `a ${config.maxSolPerTrade} SOL ticket is above the ${CANARY_SOL} SOL canary and the 0.20x default stop was derived for the canary — choose a stop`);
  const stocks = config.quoteMints ?? [];
  if (stocks.length)
    add("stop_chosen_for_stock_quotes", stopExplicit,
      stopExplicit ? `stop ${config.stopFrac}x of entry applies to stock-quoted positions too`
        : "a stock-quoted ticket has no derived stop floor (its network fee is paid in SOL, its size in the stock) — choose a stop");
  const expected = wallet ? browserArmSentence(wallet, config.maxSolPerTrade, config.dailySolCap, stocks, { autopilot: onAutopilot, xstockVenue: config.xstockVenue === true }) : null;
  add("live_ack_typed", Boolean(expected) && config.liveAck === expected,
    !expected ? "no wallet to write the sentence for"
      : config.liveAck === expected ? `the arm sentence matches, byte for byte, for the ${onAutopilot ? "autopilot" : "connected"} wallet${stocks.length ? ` and the ${stocks.length} listed stock${stocks.length === 1 ? "" : "s"}` : ""}`
        : `type exactly: ${expected}`);
  const lane = armabilityReport({ cfg: laneConfigFor(config, { lane: "execute" }), venue: PUMPFUN_VENUE, stopExplicit });
  for (const item of lane.items) items.push(item);
  const blocking = items.filter((i) => !i.ok).map((i) => i.name);
  /* Warnings never block: they are the record, said out loud beside the switch. */
  const warnings = [];
  if (config.maxSolPerTrade > RECORD.sizeBucketWarnAboveSol)
    warnings.push({ name: "size_above_the_record", detail: `every SOL of the record's net loss sat in tickets of 0.35 SOL and up; ${config.maxSolPerTrade} SOL is above the ${RECORD.sizeBucketWarnAboveSol} SOL bucket that was net positive (and that bucket was seven trades)` });
  if (config.entryWaitMs < 3_000)
    warnings.push({ name: "entry_wait_under_3s", detail: "entries under three seconds won 0 of 9 on the record; the wait is what keeps this lane out of that bucket" });
  if (config.takeAtEntryX === null || config.takeAtEntryX > 1.5)
    warnings.push({ name: "take_above_1_5x", detail: `44% of the record's coins reached 1.5x and 25% reached 2x; a 1.5x take was worth about +${RECORD.takeAt15xWorthSol} SOL over the 64 at a 0.1 SOL ticket` });
  if (stocks.length) {
    warnings.push({ name: "stock_canary", detail: `Canary rule: ${STOCK_CANARY_RULE} Listed: ${stocks.map((q) => `${q.symbol} first buy ${q.minPerTrade} ${q.symbol}, then ${q.maxPerTrade} ${q.symbol}`).join("; ")}.` });
    const fullCanary = stocks.filter((q) => q.minPerTrade >= q.maxPerTrade);
    if (fullCanary.length)
      warnings.push({ name: "stock_canary_is_full_ticket", detail: `${fullCanary.map((q) => q.symbol).join(", ")}: minPerTrade equals maxPerTrade, so the canary buy is the full ticket. Set a smaller minPerTrade in Options to make the first buy small.` });
    warnings.push({ name: "stock_quote_unmeasured", detail: "HAWK-AI's record is SOL-quoted launches only. Nothing has been measured about stock-quoted launches: no win rate, no follow-through, no fee on a buy. The shadow book grades them on a separate card per stock." });
    warnings.push({ name: "stock_quote_friction_unpriced", detail: "a stock row's frictionX is 1.0: the network fee and rent are paid in SOL beside it and cannot be netted against a size in the stock, so the stop and the take judge the stock amount only." });
    warnings.push({ name: "stock_quote_issuer_controls", detail: "every xStock mint read carries a live freeze authority, a pause switch and a permanent delegate held by its issuer. The lane detects a pause on every read and will not buy or sell through one; it cannot defend against a freeze or a clawback of a held position." });
  }
  if (config.xstockVenue === true) {
    warnings.push({ name: "xstock_venue_unmeasured", detail: `New xStock pools through Jupiter: ${XSTOCK_UNMEASURED}` });
    warnings.push({ name: "xstock_venue_pays_in_stock", detail: stocks.length
      ? `This venue pays in the pool's own stock at that stock's ticket (${stocks.map((q) => `${q.symbol} first ${q.minPerTrade}, then ${q.maxPerTrade}`).join("; ")}), charged to the same day caps; the network fee and rent are SOL and count against the SOL day. Its first live buy in each stock is its own canary.`
      : "No stock is listed, so this venue watches the built-in list and can only observe: every pool it finds is refused at stock_not_listed. List a stock in Options to give it a ticket." });
    warnings.push({ name: "xstock_venue_jupiter_builds", detail: "Jupiter builds each transaction. Before anything is signed the lane decodes it and refuses it unless it spends only from this wallet, pays exactly the ticket, delivers the new token, and simulates inside the ceiling and above the floor; a pool Jupiter cannot price or exit is refused by name. Jupiter's own programs and the pool's program still run: a bug or a hostile pool there is outside what this check can see." });
  }
  if (onAutopilot) {
    warnings.push({ name: "autopilot_no_window", detail: "Autopilot: every buy and every sell is signed by the autopilot wallet without asking you. The ticket, the day cap and the wallet's own balance are the limits; nothing waits for a click, and nothing asks before it spends." });
    warnings.push({ name: "autopilot_key_in_browser", detail: "The autopilot wallet's key lives in this browser: encrypted under your passphrase at rest, and in memory-only session storage while unlocked. That is a bigger attack surface than Phantom — malware on this machine or a hostile extension could read it while it is unlocked. What is at risk is what you fund it with: fund it with what you are willing to lose, lock it when you step away (locking clears the unlocked key), and sweep it back to Phantom when you are done." });
    if (balance !== null && lamportsToSol(balance) > Number(config.dailySolCap) + lamportsToSol(RENT_EXEMPT_EMPTY_ACCOUNT_LAMPORTS) + 0.01)
      warnings.push({ name: "autopilot_balance_above_day_cap", detail: `the autopilot wallet holds ${lamportsToSol(balance)} SOL, more than the ${config.dailySolCap} SOL day cap: the day cap still binds every trade, but today the balance is not the tighter of the two limits.` });
  }
  warnings.push({ name: "the_record_loses", detail: `the record is ${RECORD.first58.won} up, ${RECORD.first58.lost} down, ${RECORD.first58.netSol} SOL over ${RECORD.first58.trades} trades, and every modelled exit ladder still loses. Nothing here is evidence of an edge. Observe first.` });
  return Object.freeze({ armable: blocking.length === 0, items: Object.freeze(items), blocking: Object.freeze(blocking), warnings: Object.freeze(warnings), expectedAck: expected });
}
