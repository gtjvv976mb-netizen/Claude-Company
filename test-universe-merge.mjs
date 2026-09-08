/**
 * THE UNIVERSE MERGE — does the COHORT pass see what pump.fun is trading right now?
 *
 * The free warm pass has merged the launch feed into its universe for a while. The paid
 * cohort pass did not: it called `sweep()` alone, so the ~108 DexScreener keyword hits
 * (median age ~25 days) were the only coins a workup could ever be spent on, and the
 * up-to-420-row live listing the desk was already fetching reached nothing that could
 * publish a call. This file proves the merge end to end, proves the SOL mark is passed
 * so an on-curve coin's depth is a number rather than a blank, and proves the free
 * SAFETY screen did not move an inch to buy any of it.
 *
 * WHAT IS REAL AND WHAT IS STUBBED. Everything under src/ is real: cohortUniverse,
 * ignitionSweep, asCandidate, curveOf, momentumFrom, rank, wouldSurviveScreen, the
 * funnel, snapshots, and the whole of runPenthouseCycle. The ONLY stub is
 * `globalThis.fetch` — the network — so the fixtures are DexScreener / pump.fun /
 * Jupiter BYTES, not desk objects, and every shaper and ruler between the wire and the
 * assertion is the shipped one. No model is called: `/latest/dex/tokens/` answers 503,
 * so every workup ends `no_data` inside gather() (desk.js workup calls gather() first)
 * before a cent is spent — asserted, not assumed, against llm.js's own accumulator.
 *
 *   node test-universe-merge.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "universe-merge-"));
const DB_FILE = path.join(TMP, "universe-merge.db");
process.env.CLAUDE_CO_DB = DB_FILE;
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "";
process.env.XAI_API_KEY = "";
process.env.DESK_PREPARE_TX = "0";
// The hunt lane walks the same merged list; it is not what this file measures, and
// letting it run only adds free no_data workups to the tape.
process.env.PENTHOUSE_MUST_CALL = "0";
process.env.PENTHOUSE_WHALE_BUDGET_MS = "1";     // whale flow is a ranking nudge

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

// Loaded first, and used to SIZE the fixture rather than to check it: the tape below is
// cut to land between the screen's single and double volume bars, so if those floors
// ever move the fixture moves with them and the property under test survives.
const { BAND_FLOORS } = await import("./src/config.js");

/* ═══ THE FIXTURES — wire shapes, built fresh on every request ════════════════════ */

const MIN = 60_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_USD = 180;                 // the mark the Jupiter route below reports
const mintOf = (tag) => (tag + "1".repeat(44)).slice(0, 44);

// Two coins only the keyword sweep knows, one both feeds see, two only pump.fun has.
const SWP1 = mintOf("SWPa"), SWP2 = mintOf("SWPb");
const OVERLAP = mintOf("OVLP");
const IGN1 = mintOf("IGNa"), IGN2 = mintOf("IGNb");

/* THE CURVE, in the units the feed actually sends. A standard pump.fun curve opens at
   30 virtual SOL against 1.073b virtual tokens and sells 793.1m of them; with 30 real
   SOL in, k/vSol leaves 536.5m virtual tokens. curveOf() recovers 85.006 SOL to
   graduate from exactly these four numbers — the measured standard total — so the
   fixture states the ROW and the assertions read the derived answer back out. */
const SOL = 1e9, TOK = 1e6;
const CURVE_REAL_SOL = 30;
const curveRow = () => ({
  virtual_sol_reserves: 60 * SOL,
  virtual_token_reserves: 536_500_000 * TOK,
  real_sol_reserves: CURVE_REAL_SOL * SOL,           // $5,400 at $180 -> $10,800 both sides
  real_token_reserves: (536_500_000 - 279_900_000) * TOK,
  total_supply: 1_000_000_000 * TOK,
});

/* Built against the wall clock on every request, not frozen at module load: the tape's
   staleness and the coin's age are both read against Date.now() downstream, and a
   fixture that ages while the suite runs would make this file's result depend on how
   busy the machine was. */
const pumpRow = (mint, symbol, { mcap = 30_000, ageMin = 30 } = {}) => {
  const now = Date.now();
  return {
    mint, symbol, name: `${symbol} coin`,
    ...curveRow(),
    usd_market_cap: mcap,                             // micro band: floors liq 4k / vol 3k / 20 txns
    created_timestamp: now - ageMin * MIN,
    last_trade_timestamp: now - 1 * MIN,              // traded inside the 10m liveness test
    ath_market_cap: mcap / 0.94,                      // 94% of its own high: not a late look
    ath_market_cap_timestamp: now - 8 * MIN,
    reply_count: 12,
    bonding_curve: `${mint.slice(0, 20)}curve`,
    complete: false,
    is_banned: false, verified: false,
    creator: mintOf("CRTR"),
  };
};

/* THE TAPE, CUT BETWEEN THE TWO BARS ON PURPOSE.
 *
 * wouldSurviveScreen lets a live minute tape stand in for the 24-hour aggregates a
 * four-minute-old coin cannot have — at ONE bar when the pool is readable, and at DOUBLE
 * when it is not, which is the branch passing solUsd moves. Both bars are derived from
 * the micro band's own floors here rather than typed in, so the fixture follows the
 * config if the floors are ever re-tuned. */
const FL = BAND_FLOORS.micro;                         // the fixture's $30k cap sits in micro
const SINGLE_BAR = Math.max(300, FL.vol / 5);
const DOUBLE_BAR = Math.max(600, (FL.vol * 2) / 5);
const TAPE_VOL_5M = (SINGLE_BAR + DOUBLE_BAR) / 2;    // clears one bar, not the other
/** A rising ten-minute tape: 5 candles inside the 5m window, 5 in the prior ten. */
const tape = () => {
  const end = Date.now() - 30_000;                    // last print 30s ago: a live window
  return Array.from({ length: 10 }, (_, i) => {
    const px = 1.02 ** i;
    return { timestamp: end - (9 - i) * MIN, open: px, high: px, low: px, close: px,
      volume: TAPE_VOL_5M / 5 };
  });
};

/** A DexScreener pair, in the raw shape market.js shapes. */
const dsPair = (mint, symbol, { liq = 60_000, mcap = 400_000, ageH = 400 } = {}) => ({
  chainId: "solana", dexId: "raydium",
  pairAddress: `${mint.slice(0, 20)}pair`,
  url: `https://dexscreener.com/solana/${mint}`,
  baseToken: { address: mint, symbol, name: `${symbol} token` },
  quoteToken: { symbol: "SOL" },
  priceUsd: "0.0004",
  liquidity: { usd: liq },
  fdv: mcap, marketCap: mcap,
  pairCreatedAt: Date.now() - ageH * 3.6e6,
  volume: { h24: 120_000 },
  txns: { h24: { buys: 900, sells: 700 }, h1: { buys: 40 }, h6: { buys: 120 } },
  priceChange: { h1: 1, h6: 8, h24: 12 },
  info: { socials: [{ type: "twitter", url: "https://x.com/x" }] },
});

/* ═══ THE ONLY STUB: THE NETWORK ══════════════════════════════════════════════════ */

const seen = { unrouted: [], solPrice: 0, candles: 0, listing: 0, search: 0, tokens: 0 };
let solPriceAnswers = true;                    // flipped to prove the stated fallback

const json = (data) => ({ ok: true, status: 200, json: async () => data });
const dead = (status = 503) => ({ ok: false, status, json: async () => ({}) });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.dexscreener.com/latest/dex/search")) {
    seen.search++;
    return json({ pairs: [dsPair(SWP1, "SWPA"), dsPair(SWP2, "SWPB"), dsPair(OVERLAP, "OVLP")] });
  }
  // Every workup dies here, free, before a model is reached: gather() bails on pairsFor.
  if (u.includes("/latest/dex/tokens/")) { seen.tokens++; return dead(); }
  if (u.includes("/orders/v1/solana/")) return json({ orders: [] });
  if (u.includes("token-boosts") || u.includes("token-profiles")) return json([]);
  // 31 gently rising daily closes: a KNOWN, risk_on weather, so nothing is grounded for
  // a reason that has nothing to do with the universe.
  if (u.includes("coingecko")) return json({ prices: Array.from({ length: 31 }, (_, i) => [i, 100 + i]) });
  if (u.includes("/price/v3")) {
    seen.solPrice++;
    return solPriceAnswers ? json({ [SOL_MINT]: { usdPrice: SOL_USD } }) : dead(429);
  }
  if (u.includes("frontend-api-v3.pump.fun/coins?")) {
    seen.listing++;
    if (!/offset=0&/.test(u)) return json([]);   // only page 0 carries rows; listing() dedupes
    return json([pumpRow(IGN1, "IGNA"), pumpRow(IGN2, "IGNB"), pumpRow(OVERLAP, "OVLP")]);
  }
  if (u.includes("swap-api.pump.fun")) { seen.candles++; return json(tape()); }
  seen.unrouted.push(u.slice(0, 90));
  return dead();
};

/* ═══ THE TESTS ═══════════════════════════════════════════════════════════════════ */

const ph = await import("./src/penthouse.js");
const funnel = await import("./src/funnel.js");
const snapshots = await import("./src/data/snapshots.js");
const { screen } = await import("./src/data/evidence.js");
const { cfg } = await import("./src/config.js");
const { spend } = await import("./src/lib/llm.js");
const { bus } = await import("./src/lib/bus.js");

console.log("\n1. THE MERGE — the launch feed reaches the cohort's universe");
const t0 = Date.now();
const built = await ph.cohortUniverse();
const bySource = built.universe.reduce((a, c) => {
  const k = c.source === "pumpfun-live" ? "ignition" : "sweep";
  a[k] = (a[k] || 0) + 1; return a;
}, {});
console.log(`     merged universe = ${built.universe.length}   sweep ${built.swept.length}` +
  ` + ignition ${built.igniting.length} - ${built.swept.length + built.igniting.length - built.universe.length} deduped` +
  `   by source in the merged map: ${JSON.stringify(bySource)}`);
console.log(`     solUsd = ${built.solUsd} from ${built.solUsdSource}   (${Date.now() - t0}ms)`);

const mints = new Set(built.universe.map((c) => c.mint));
ok("ignition-only mints are in the merged universe",
  mints.has(IGN1) && mints.has(IGN2),
  `IGN1=${mints.has(IGN1)} IGN2=${mints.has(IGN2)} of ${built.universe.length} merged`);
ok("the keyword sweep's own coins are still there", mints.has(SWP1) && mints.has(SWP2),
  `sweep contributed ${built.swept.length}, ${bySource.sweep} survived the dedupe`);
ok("a coin both feeds return appears once, and the ignition row is the one that survived",
  built.universe.filter((c) => c.mint === OVERLAP).length === 1 &&
  built.universe.find((c) => c.mint === OVERLAP)?.source === "pumpfun-live",
  `source=${built.universe.find((c) => c.mint === OVERLAP)?.source} — the row carrying the minute tape`);

console.log("\n2. solUsd IS PASSED — so an on-curve coin's depth is a number, not a blank");
const ign = built.universe.find((c) => c.mint === IGN1);
const expectedCurveUsd = CURVE_REAL_SOL * SOL_USD;
ok("the SOL mark came from Jupiter, not the stated fallback",
  built.solUsd === SOL_USD && built.solUsdSource === "jupiter" && seen.solPrice >= 1,
  `solUsd=${built.solUsd} source=${built.solUsdSource} price requests=${seen.solPrice}`);
ok("curveLiquidityUsd is non-null for the on-curve fixture",
  ign?.live?.curveLiquidityUsd === expectedCurveUsd,
  `curveLiquidityUsd=$${ign?.live?.curveLiquidityUsd} (${CURVE_REAL_SOL} real SOL x $${SOL_USD})`);
ok("...and it reaches pair.liquidityUsd as both sides of the curve",
  ign?.pair?.liquidityUsd === expectedCurveUsd * 2,
  `pair.liquidityUsd=$${ign?.pair?.liquidityUsd}`);
ok("the curve derived its own graduation total from the fixture's reserves",
  Math.abs(ign.live.gradSolTotal - 85.006) < 0.01 && ign.live.curveClass === "standard",
  `gradSolTotal=${ign.live.gradSolTotal.toFixed(3)} SOL · progressSol=${ign.live.progressSol.toFixed(3)}` +
  ` · class=${ign.live.curveClass}`);
/* WHAT THE MARK ACTUALLY BUYS, stated as the branch it moves: with no readable pool a
   coin takes the DOUBLE-bar path in wouldSurviveScreen (2x volume AND 2x participation
   on the minute tape). Re-derived here from the SAME row with the depth blanked, so the
   assertion is about the screen's own arithmetic rather than a number this file typed. */
const blind = { ...ign, pair: { ...ign.pair, liquidityUsd: null } };
ok("the same coin without the mark is judged as unreadable depth and dies",
  ph.wouldSurviveScreen(ign) === null && ph.wouldSurviveScreen(blind) === "thin_liquidity",
  `with mark=${ph.wouldSurviveScreen(ign)} · without=${ph.wouldSurviveScreen(blind)}` +
  `  (tape $${ign.momentum?.vol5mUsd} in 5m vs bars $${SINGLE_BAR}/$${DOUBLE_BAR},` +
  ` coverage ${ign.momentum?.coverageMins}m, staleness ${ign.momentum?.stalenessMins}m)`);

console.log("\n3. THE FALLBACK — an unreachable price does not cost the desk the lane");
solPriceAnswers = false;
const degraded = await ph.cohortUniverse();
ok("a dead price route falls back to the stated constant, universe intact",
  degraded.solUsd === Number(cfg.solUsdFallback) &&
  degraded.solUsdSource === "DESK_SOL_USD_FALLBACK" &&
  degraded.universe.length === built.universe.length,
  `solUsd=${degraded.solUsd} (cfg.solUsdFallback=${cfg.solUsdFallback}) merged=${degraded.universe.length}` +
  ` · on-curve depth still read: $${degraded.universe.find((c) => c.mint === IGN1)?.pair?.liquidityUsd}`);
solPriceAnswers = true;

console.log("\n4. SNAPSHOTS — the ledger the dead-zone gate reads now has ignition rows");
const snapIgn = snapshots.firstSince(IGN1, Date.now() - 60 * MIN);
const snapSwp = snapshots.firstSince(SWP1, Date.now() - 60 * MIN);
ok("snapshots.firstSince returns a row for an ignition-only mint",
  snapIgn != null && snapIgn.price > 0,
  `IGN1 first sighting price=${snapIgn?.price} at ts=${snapIgn?.ts}` +
  " — post_migration_dump and liquidity_did_not_hold can fire on it now");
ok("...and the sweep's own rows are still recorded as before", snapSwp != null,
  `SWP1 first sighting price=${snapSwp?.price}`);

console.log("\n5. THE CYCLE — scored, bySweep and dueForStudy all resolve an ignition mint");
funnel._reset();
const events = [];
const onEvent = (e) => events.push(e);
bus.on("event", onEvent);
const beforeSpend = { calls: spend.calls, usd: spend.usd };
const r = await ph.runPenthouseCycle({ workups: 12 });
bus.off("event", onEvent);

const merged = events.filter((e) => e.type === "universe:merged").at(-1);
const shortlisted = events.filter((e) => e.type === "scout:shortlist").at(-1);
const started = events.filter((e) => e.type === "token:start").map((e) => e.mint);
// `scored` is the cycle's private list, and funnel.observe(scored) is what writes it
// down — so a funnel row for an ignition-only mint IS that mint having been in `scored`.
const fdb = new DatabaseSync(DB_FILE);
const funnelRow = (m) => fdb.prepare("SELECT mint,stage,score,launchpad,band,liq FROM funnel WHERE mint=?").get(m) ?? null;
const ignRow = funnelRow(IGN1);
const stillOffered = funnel.dueForStudy(50).map((x) => x.mint);

console.log(`     cycle considered=${r.considered} (sweep ${r.sweptCount} + ignition ${r.ignitingCount})` +
  ` ranked=${r.ranked} shortlist=${shortlisted?.count} from "${shortlisted?.source}"` +
  ` · workups started on ${started.length} coins · costUsd=$${r.costUsd}`);
console.log(`     universe:merged event = ${JSON.stringify(merged && { merged: merged.merged,
  swept: merged.swept, igniting: merged.igniting, ignitionOnly: merged.ignitionOnly,
  solUsd: merged.solUsd, solUsdSource: merged.solUsdSource })}`);
console.log(`     IGN1 funnel row = ${JSON.stringify(ignRow)}`);

ok("the cycle's universe is the merged one, not the sweep alone",
  r.considered === built.universe.length && r.ignitingCount === built.igniting.length &&
  r.considered > r.sweptCount && merged?.merged === r.considered,
  `considered=${r.considered} swept=${r.sweptCount} igniting=${r.ignitingCount}`);
ok("an ignition-only mint reached `scored` — the funnel observed it with its curve depth",
  ignRow != null && ignRow.score > 0 && ignRow.launchpad === "pump.fun" &&
  ignRow.liq === expectedCurveUsd * 2,
  `stage=${ignRow?.stage} score=${ignRow?.score} band=${ignRow?.band} liq=$${ignRow?.liq}`);
ok("funnel.dueForStudy returns it",
  stillOffered.includes(IGN1) && shortlisted?.source === "funnel",
  `dueForStudy(50) offers [${stillOffered.map((m) => m.slice(0, 4)).join(",")}]` +
  ` · the cycle's shortlist source was "${shortlisted?.source}"`);
ok("bySweep resolved it into the shortlist — the mint reached a workup",
  started.includes(IGN1),
  `token:start fired for [${started.map((m) => m.slice(0, 4)).join(",")}]` +
  ` (all ended no_data: ${seen.tokens} DexScreener token reads, all 503)`);
ok("nothing was spent proving any of this",
  spend.calls === beforeSpend.calls && spend.usd === beforeSpend.usd && r.costUsd === 0,
  `model calls=${spend.calls - beforeSpend.calls} usd=$${spend.usd - beforeSpend.usd} r.costUsd=$${r.costUsd}`);
ok("no request escaped the stub", seen.unrouted.length === 0,
  seen.unrouted.length ? seen.unrouted.slice(0, 3).join(" | ")
    : `routed: ${seen.search} search · ${seen.listing} listing · ${seen.candles} candles · ${seen.solPrice} price`);

console.log("\n6. THE FREE SAFETY SCREEN DID NOT MOVE");
/* THE RULER, HASHED. This step buys volume by widening the UNIVERSE; it is allowed to
   change nothing about what any one coin has to clear. screen() (evidence.js) is the
   free SAFETY gauntlet, so its source text is pinned byte for byte and the hash is
   PRINTED — if this goes red the screen changed, which is either the defect this
   assertion exists to catch or a deliberate later change whose author must re-measure
   the value here and say, in this comment, why it moved. Measured 2026-09-08. */
const SCREEN_SHA256 = "88ed3433e37074c7a9f3a5e1384d74be1ff823400c4f9dfd31b5028facd00ab6";
const screenSrc = screen.toString();
const screenHash = crypto.createHash("sha256").update(screenSrc).digest("hex");
console.log(`     sha256(screen.toString()) = ${screenHash}   (${screenSrc.length} bytes of source)`);
ok("the exported screen() source is byte-unchanged", screenHash === SCREEN_SHA256,
  `expected ${SCREEN_SHA256.slice(0, 16)}… got ${screenHash.slice(0, 16)}…`);

fdb.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
