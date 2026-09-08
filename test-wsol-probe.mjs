/**
 * THE ROUTE PROBE MEASURES THE ROUTE THE BOT ACTUALLY TAKES.
 *
 * WHAT WAS WRONG. gather() quoted the exit probe USDC -> mint -> USDC, and the bot never
 * swaps that pair: WALL-ST-E goes WSOL -> mint on the way in and mint -> WSOL on the way
 * out, and it refuses outright a route that would open a third wallet ATA (its rent cap
 * is 4,200,000 lamports against 4,078,560 for two accounts). Measured on the on-curve
 * GoatPro: ONE hop via Pump.fun quoted in WSOL, TWO hops quoted in USDC. So the desk was
 * measuring a route the bot cannot take, and would have reported its hop count as the
 * bot's.
 *
 * AND THE AMOUNT WAS STRANDED TOO. probe-size.js reads the largest per-trade cap a live
 * bot declares, and office.js's readiness sanitiser still zeroed any rehearsal above
 * 50,000,000 lamports (0.05 SOL) while the executor's declared ceiling is 0.4 —  so a
 * correctly-armed bot was persisted `degraded` for ever and the probe fell back to the
 * stated $15 constant instead of quoting the bot's real cap.
 *
 * WHAT THIS FILE PROVES, on the wire rather than on a fixture: the URL Jupiter is
 * actually asked for names MINTS.SOL and 400,000,000 lamports when a heartbeat declares
 * 0.4 SOL; the USDC fallback survives when no bot is reporting; both legs' hops and amms
 * reach ev.exitProbe; `multi_hop_route` is a JUDGMENT note that never enters `fails`;
 * and `unverified_exit` still refuses a probe whose buy OR sell leg failed.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-wsol-probe.mjs
 */
import os from "node:os";
import path from "node:path";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-wsol-probe-" + process.pid + ".db");

const copy = await import("./src/copy.js");
const db = (await import("./src/lib/store.js")).default;
const { cfg, MINTS } = await import("./src/config.js");
const { botProbeNotional, routeProbeLeg, ROUTE_PROBE_FALLBACK_USD, BOT_CAP_SOL_MAX } =
  await import("./src/probe-size.js");
const { EXECUTOR_OPERATOR_MAXIMA } = await import("./src/executor-dashboard.js");
const { sanitizeExecutorHealth } = await import("./src/office.js");
const { gather, screen } = await import("./src/data/evidence.js");
const { GATE_CLASS, gateClass, SAFETY_GATES, JUDGMENT_GATES, gateFailures, openCall } =
  await import("./src/calls.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const LAMPORTS = 1_000_000_000;
const FLOOR = 21;
const heartbeat = (maxSolPerTrade, ageMs = 0) => {
  copy.settingsFor(FLOOR);
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?").run(
    JSON.stringify({ seenAt: Date.now() - ageMs, health: { caps: { maxSolPerTrade } } }), FLOOR);
};
const clearHeartbeats = () => db.prepare("UPDATE copy_settings SET executor_heartbeat=NULL").run();

/* ── 1. THE LEG THE PROBE QUOTES ─────────────────────────────────────────────────── */
console.log("\n1. THE LEG: WSOL at the bot's own lamports, USDC only when no bot is reporting");
{
  /* The declared ceiling itself, not a number this test picked: an executor cannot
     configure past OPERATOR_MAX.maxSolPerTrade, and the desk's own band mirrors it. */
  const ARMED_SOL = EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade;
  ok(`the executor's declared per-trade ceiling is ${ARMED_SOL} SOL, and the desk's band matches it`,
    ARMED_SOL === 0.4 && BOT_CAP_SOL_MAX === ARMED_SOL,
    `EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade=${ARMED_SOL}, BOT_CAP_SOL_MAX=${BOT_CAP_SOL_MAX}`);

  heartbeat(ARMED_SOL);
  const armed = botProbeNotional();
  const armedLeg = routeProbeLeg(armed);
  console.log(`  probe size: fromBot=${armed.fromBot} botSol=${armed.botSol} ` +
    `sizeUsd=$${armed.sizeUsd} (SOL $${armed.solUsd}, ${armed.solUsdSource})`);
  console.log(`  leg: ${armedLeg.quoteAsset} ${armedLeg.quoteMint} amount=${armedLeg.quoteAmountRaw} ` +
    `(${armedLeg.quoteAmountUi})`);
  ok("a heartbeat declaring 0.4 SOL is read as a measurement, not rejected",
    armed.fromBot === true && armed.botSol === ARMED_SOL, `fromBot=${armed.fromBot} botSol=${armed.botSol}`);
  ok("...and the probe quotes MINTS.SOL", armedLeg.quoteMint === MINTS.SOL && armedLeg.quoteAsset === "WSOL",
    `${armedLeg.quoteAsset} ${armedLeg.quoteMint}`);
  ok("...at the bot's declared cap in lamports",
    armedLeg.quoteAmountRaw === String(Math.round(ARMED_SOL * LAMPORTS)),
    `${armedLeg.quoteAmountRaw} lamports (want ${Math.round(ARMED_SOL * LAMPORTS)})`);

  clearHeartbeats();
  const bare = botProbeNotional();
  const bareLeg = routeProbeLeg(bare);
  console.log(`  no bot: fromBot=${bare.fromBot} sizeUsd=$${bare.sizeUsd} — ${bare.why}`);
  console.log(`  leg: ${bareLeg.quoteAsset} ${bareLeg.quoteMint} amount=${bareLeg.quoteAmountRaw}`);
  ok("with no bot reporting the probe falls back to USDC",
    bareLeg.quoteMint === MINTS.USDC && bareLeg.quoteAsset === "USDC", `${bareLeg.quoteAsset}`);
  ok(`...at ROUTE_PROBE_FALLBACK_USD ($${ROUTE_PROBE_FALLBACK_USD}) in USDC's six decimals`,
    bare.sizeUsd === ROUTE_PROBE_FALLBACK_USD &&
    bareLeg.quoteAmountRaw === String(ROUTE_PROBE_FALLBACK_USD * 1e6),
    `${bareLeg.quoteAmountRaw} (want ${ROUTE_PROBE_FALLBACK_USD * 1e6})`);
  /* A STALE PULSE IS NOT A BOT. Same fallback, and it must not quote a dead bot's cap. */
  heartbeat(ARMED_SOL, 48 * 3_600e3);
  const stale = routeProbeLeg(botProbeNotional());
  ok("a 48h-old heartbeat is not a live bot, so the leg is USDC again",
    stale.quoteMint === MINTS.USDC, `${stale.quoteAsset} ${stale.quoteAmountRaw}`);
  clearHeartbeats();
}

/* ── 2. OFFICE ACCEPTS THE ARMED BOT ─────────────────────────────────────────────── */
console.log("\n2. office.js accepts a bot armed at the real ceiling — caps valid, state not degraded");
{
  const M = EXECUTOR_OPERATOR_MAXIMA;
  const CEILING_LAMPORTS = Math.floor(M.maxSolPerTrade * LAMPORTS);
  const now = Date.now();
  const armedPulse = (over = {}) => ({
    state: "healthy", feedRollback: false,
    executionReadiness: { ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
      route: "wsol-usdc", providers: 2, amountLamports: CEILING_LAMPORTS },
    caps: { maxSolPerTrade: M.maxSolPerTrade, dailySolCap: M.rolling24hDeploySol,
      dailyLossLimitSol: M.rolling24hRealizedLossBrakeSol, maxOpenPositions: M.maxOpenPositions },
    ...over,
  });
  const h = sanitizeExecutorHealth(armedPulse());
  console.log(`  armed pulse: state=${h.state} caps=${JSON.stringify(h.caps)} ` +
    `readiness.amountLamports=${h.executionReadiness.amountLamports} ready=${h.executionReadiness.ready}`);
  ok(`a rehearsal at ${CEILING_LAMPORTS} lamports survives the sanitiser`,
    h.executionReadiness.amountLamports === CEILING_LAMPORTS && h.executionReadiness.ready === true,
    `${h.executionReadiness.amountLamports}, ready=${h.executionReadiness.ready}`);
  ok("...the caps are valid, not thrown away", h.caps != null && h.caps.maxSolPerTrade === M.maxSolPerTrade,
    JSON.stringify(h.caps));
  ok("...and the state is NOT degraded", h.state === "healthy", `state=${h.state}`);

  /* THE GUARD STILL BITES. Derived from the maxima is not the same as removed. */
  const over = sanitizeExecutorHealth(armedPulse({
    executionReadiness: { ready: true, lastSuccessAt: now, observedAt: now, route: "wsol-usdc",
      providers: 2, amountLamports: CEILING_LAMPORTS + 1 } }));
  ok("one lamport past the ceiling is still zeroed, and that still degrades",
    over.executionReadiness.amountLamports === 0 && over.state === "degraded",
    `amountLamports=${over.executionReadiness.amountLamports} state=${over.state}`);
  const overCaps = sanitizeExecutorHealth(armedPulse({
    caps: { maxSolPerTrade: M.maxSolPerTrade + 0.1, dailySolCap: M.rolling24hDeploySol,
      dailyLossLimitSol: M.rolling24hRealizedLossBrakeSol, maxOpenPositions: M.maxOpenPositions } }));
  ok("a cap claiming more than the executor can configure is still refused",
    overCaps.caps === null && overCaps.state === "degraded",
    `caps=${JSON.stringify(overCaps.caps)} state=${overCaps.state}`);
}

/* ── 3. THE WIRE ─────────────────────────────────────────────────────────────────── */
console.log("\n3. THE WIRE: the URL Jupiter is actually asked for, and the hops that come back");

const MINT = "Wso1Probe1111111111111111111111111111111111";
const PRICE = 0.00042;
const quotes = [];                         // every /swap/v1/quote the desk asked for
let sellLegFails = false, buyLegFails = false;

/* ONE STUB FOR EVERY OUTBOUND READ. src/lib/http.js is the only transport gather() uses
   and it calls the global fetch, so replacing that global drives the REAL dexscreener,
   jupiter and evidence code rather than a hand-shaped bundle — which is the only way an
   assertion about "which mint the probe quotes" can mean anything. */
const dsPair = {
  chainId: "solana", dexId: "pumpswap", pairAddress: "Pair11", url: "https://x",
  baseToken: { symbol: "WSOLP", name: "Wsol Probe" }, quoteToken: { symbol: "SOL" },
  priceUsd: String(PRICE), liquidity: { usd: 90_000 }, fdv: 400_000, marketCap: 400_000,
  pairCreatedAt: Date.now() - 9 * 3600e3, volume: { h24: 120_000 },
  txns: { h24: { buys: 400, sells: 320 } }, priceChange: { m5: 1 },
};
const json = (data) => new Response(JSON.stringify(data), { status: 200,
  headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/swap/v1/quote")) {
    const q = new URL(u).searchParams;
    const rec = { inputMint: q.get("inputMint"), outputMint: q.get("outputMint"), amount: q.get("amount") };
    quotes.push(rec);
    const isBuy = rec.outputMint === MINT;
    if (isBuy && buyLegFails) return new Response("no route", { status: 404 });
    if (!isBuy && sellLegFails) return new Response("no route", { status: 404 });
    /* The measured GoatPro shape: the buy is one hop through the curve, the sell has to
       come back out through two. Distinct per leg so the test can tell them apart. */
    const plan = isBuy
      ? [{ swapInfo: { label: "Pump.fun" } }]
      : [{ swapInfo: { label: "Pump.fun" } }, { swapInfo: { label: "Meteora DLMM" } }];
    return json({ inAmount: rec.amount, outAmount: isBuy ? "123456789" : rec.amount,
      priceImpactPct: "0.004", routePlan: plan });
  }
  if (u.includes("/price/v3"))
    return json({ [MINT]: { usdPrice: PRICE }, [MINTS.SOL]: { usdPrice: cfg.solUsdFallback } });
  if (u.includes("/latest/dex/tokens/")) return json({ pairs: [dsPair] });
  if (u.includes("/orders/v1/solana/")) return json([]);
  // Everything else — coingecko's regime read, pump.fun, the RPC — is unreachable in a
  // test, and every one of those callers treats a failure as "unmeasured".
  return new Response("blocked", { status: 503 });
};

try {
  heartbeat(EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade);
  quotes.length = 0;
  const armedEv = await gather(MINT);
  const [buyQ, sellQ] = quotes;
  console.log(`  buy  leg asked: in=${buyQ?.inputMint} out=${buyQ?.outputMint} amount=${buyQ?.amount}`);
  console.log(`  sell leg asked: in=${sellQ?.inputMint} out=${sellQ?.outputMint} amount=${sellQ?.amount}`);
  console.log(`  exitProbe: quotedIn=${armedEv.exitProbe.quoteAsset} raw=${armedEv.exitProbe.quoteAmountRaw} ` +
    `targetSizeUsd=$${armedEv.exitProbe.targetSizeUsd} buyHops=${armedEv.exitProbe.buyHops} ` +
    `sellHops=${armedEv.exitProbe.sellHops} routeHops=${armedEv.exitProbe.routeHops} ` +
    `multiHop=${armedEv.exitProbe.multiHopRoute} buyAmms=${JSON.stringify(armedEv.exitProbe.buyAmms)} ` +
    `sellAmms=${JSON.stringify(armedEv.exitProbe.sellAmms)}`);
  ok("gather() asked Jupiter for WSOL -> mint",
    buyQ?.inputMint === MINTS.SOL && buyQ?.outputMint === MINT, `${buyQ?.inputMint} -> ${buyQ?.outputMint}`);
  ok("...at 400,000,000 lamports, the bot's declared cap",
    buyQ?.amount === "400000000", `amount=${buyQ?.amount}`);
  ok("...and sold back into WSOL, not USDC",
    sellQ?.inputMint === MINT && sellQ?.outputMint === MINTS.SOL, `${sellQ?.inputMint} -> ${sellQ?.outputMint}`);
  ok("neither leg touched USDC", !quotes.some((q) => q.inputMint === MINTS.USDC || q.outputMint === MINTS.USDC),
    `${quotes.length} quote(s), mints: ${[...new Set(quotes.flatMap((q) => [q.inputMint, q.outputMint]))].length} distinct`);
  ok("the probe records what it was quoted in",
    armedEv.exitProbe.quoteAsset === "WSOL" && armedEv.exitProbe.quoteMint === MINTS.SOL &&
    armedEv.exitProbe.quoteAmountRaw === "400000000",
    `${armedEv.exitProbe.quoteAsset} ${armedEv.exitProbe.quoteAmountRaw}`);
  ok("...and still states the amount in dollars for the report",
    armedEv.exitProbe.targetSizeUsd === Number((0.4 * cfg.solUsdFallback).toFixed(2)) &&
    armedEv.exitProbe.sizeFromBot === true,
    `$${armedEv.exitProbe.targetSizeUsd} at SOL $${cfg.solUsdFallback}`);
  ok("hops are recorded per leg", armedEv.exitProbe.buyHops === 1 && armedEv.exitProbe.sellHops === 2,
    `buy=${armedEv.exitProbe.buyHops} sell=${armedEv.exitProbe.sellHops}`);
  ok("...amms are recorded per leg, in route order",
    JSON.stringify(armedEv.exitProbe.buyAmms) === JSON.stringify(["Pump.fun"]) &&
    JSON.stringify(armedEv.exitProbe.sellAmms) === JSON.stringify(["Pump.fun", "Meteora DLMM"]),
    `${JSON.stringify(armedEv.exitProbe.buyAmms)} / ${JSON.stringify(armedEv.exitProbe.sellAmms)}`);
  ok("...routeHops is the WORSE of the two legs, and multiHopRoute follows it",
    armedEv.exitProbe.routeHops === 2 && armedEv.exitProbe.multiHopRoute === true,
    `routeHops=${armedEv.exitProbe.routeHops} multiHop=${armedEv.exitProbe.multiHopRoute}`);

  /* THE SCREEN SEES THE NOTE AND DOES NOT KILL ON IT. This bundle's mint account and
     holders are unreadable (no RPC in a test), so it fails on those — the assertion is
     that multi_hop_route is not among the failures and IS among the notes. */
  const sc = screen(armedEv);
  console.log(`  screen: pass=${sc.pass} fails=[${sc.fails.map((f) => f.code).join(", ")}] ` +
    `notes=[${sc.notes.map((n) => n.code).join(", ")}]`);
  ok("multi_hop_route is a NOTE, never a failure",
    sc.notes.some((n) => n.code === "multi_hop_route") &&
    !sc.fails.some((f) => f.code === "multi_hop_route"),
    sc.notes.find((n) => n.code === "multi_hop_route")?.detail ?? "no note");

  /* THE FALLBACK ON THE WIRE. No bot, so USDC at the stated constant. */
  clearHeartbeats();
  quotes.length = 0;
  const bareEv = await gather(MINT);
  console.log(`  no-bot buy leg: in=${quotes[0]?.inputMint} amount=${quotes[0]?.amount} ` +
    `quotedIn=${bareEv.exitProbe.quoteAsset}`);
  ok("with no bot the wire carries USDC at the stated constant",
    quotes[0]?.inputMint === MINTS.USDC &&
    quotes[0]?.amount === String(ROUTE_PROBE_FALLBACK_USD * 1e6) &&
    bareEv.exitProbe.quoteAsset === "USDC",
    `${bareEv.exitProbe.quoteAsset} ${quotes[0]?.amount}`);

  /* ── unverified_exit, unchanged, on either leg ────────────────────────────────── */
  console.log("\n5. unverified_exit still fires when EITHER leg fails");
  heartbeat(EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade);
  sellLegFails = true;
  const noSell = await gather(MINT);
  const noSellCodes = screen(noSell).fails.map((f) => f.code);
  console.log(`  sell leg 404: error=${JSON.stringify(noSell.exitProbe.error)} ` +
    `roundTripLossPct=${noSell.exitProbe.roundTripLossPct} buyHops=${noSell.exitProbe.buyHops} ` +
    `sellHops=${noSell.exitProbe.sellHops} routeHops=${noSell.exitProbe.routeHops}`);
  ok("a failed SELL leg leaves roundTripLossPct null and fires unverified_exit",
    noSell.exitProbe.roundTripLossPct == null && noSellCodes.includes("unverified_exit"),
    `[${noSellCodes.join(", ")}]`);
  ok("...and the buy leg's hops are still recorded, because they were measured",
    noSell.exitProbe.buyHops === 1 && noSell.exitProbe.sellHops === null,
    `buy=${noSell.exitProbe.buyHops} sell=${noSell.exitProbe.sellHops}`);
  sellLegFails = false; buyLegFails = true;
  const noBuy = await gather(MINT);
  const noBuyCodes = screen(noBuy).fails.map((f) => f.code);
  console.log(`  buy leg 404: error=${JSON.stringify(noBuy.exitProbe.error)} ` +
    `routeHops=${noBuy.exitProbe.routeHops} multiHop=${noBuy.exitProbe.multiHopRoute}`);
  ok("a failed BUY leg fires unverified_exit too",
    noBuy.exitProbe.roundTripLossPct == null && noBuyCodes.includes("unverified_exit"),
    `[${noBuyCodes.join(", ")}]`);
  ok("...and an unmeasured route reads null, never 'one hop'",
    noBuy.exitProbe.routeHops === null && noBuy.exitProbe.multiHopRoute === null,
    `routeHops=${noBuy.exitProbe.routeHops} multiHop=${noBuy.exitProbe.multiHopRoute}`);
  buyLegFails = false;
} finally {
  globalThis.fetch = realFetch;
  clearHeartbeats();
}

/* ── 4. THE FLAG IS JUDGMENT AND NEVER KILLS ─────────────────────────────────────── */
console.log("\n4. multi_hop_route is registered JUDGMENT by name, and kills nothing");
{
  ok("it is in GATE_CLASS by name — never left to the SAFETY default",
    Object.hasOwn(GATE_CLASS, "multi_hop_route") && gateClass("multi_hop_route") === "JUDGMENT" &&
    Object.isFrozen(GATE_CLASS), `GATE_CLASS.multi_hop_route=${GATE_CLASS.multi_hop_route}`);
  ok("...JUDGMENT_GATES has it and SAFETY_GATES does not",
    JUDGMENT_GATES.includes("multi_hop_route") && !SAFETY_GATES.includes("multi_hop_route"),
    `SAFETY(${SAFETY_GATES.length}) JUDGMENT(${JUDGMENT_GATES.length}): ${JUDGMENT_GATES.join(", ")}`);
  ok("...and an unregistered route code would still default-deny, which is why it is registered",
    gateClass("some_route_code_nobody_registered") === "SAFETY");

  /* A CLEAN COIN WITH A TWO-HOP EXIT STILL PASSES THE SCREEN. Everything else about
     this bundle reads healthy, so `pass` is the whole assertion. */
  const clean = (probe) => ({
    ok: true, mint: "Hop111111111111111111111111111111111111111", symbol: "HOP",
    pair: { priceUsd: 1, liquidityUsd: 60_000, ageHours: 9, marketCap: 400_000,
      volume: { h24: 90_000 }, txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1 } },
    pairs: { count: 2, totalLiquidityUsd: 60_000 },
    derived: { totalLiquidityUsd: 60_000, volToLiqRatio: 1.5, fdvToLiqRatio: 7, txns24h: 700 },
    mintAccount: { ok: true, flags: [] }, holders: { ok: true, top1Pct: 8 },
    crosscheck: { verdicts: [] }, exitProbe: probe,
  });
  const oneHop = screen(clean({ targetSizeUsd: 41.2, quoteAsset: "WSOL", roundTripLossPct: 2,
    buyHops: 1, sellHops: 1, buyAmms: ["Pump.fun"], sellAmms: ["Pump.fun"], routeHops: 1,
    multiHopRoute: false }));
  const twoHop = screen(clean({ targetSizeUsd: 41.2, quoteAsset: "WSOL", roundTripLossPct: 2,
    buyHops: 1, sellHops: 2, buyAmms: ["Pump.fun"], sellAmms: ["Pump.fun", "Meteora DLMM"],
    routeHops: 2, multiHopRoute: true }));
  console.log(`  one hop: pass=${oneHop.pass} notes=[${oneHop.notes.map((n) => n.code).join(", ")}]`);
  console.log(`  two hop: pass=${twoHop.pass} notes=[${twoHop.notes.map((n) => n.code).join(", ")}]`);
  ok("a clean coin with a one-hop exit passes, and gets no note",
    oneHop.pass === true && oneHop.notes.length === 0, `pass=${oneHop.pass}`);
  ok("a clean coin with a TWO-hop exit still PASSES — the note is not a gate",
    twoHop.pass === true && twoHop.fails.length === 0, `pass=${twoHop.pass} fails=${twoHop.fails.length}`);
  ok("...and the note names both legs and their venues",
    twoHop.notes.length === 1 && twoHop.notes[0].code === "multi_hop_route" &&
    /Meteora DLMM/.test(twoHop.notes[0].detail) && /WSOL/.test(twoHop.notes[0].detail),
    twoHop.notes[0]?.detail);
  ok("an unmeasured hop count raises no note either — null is unmeasured, not clean",
    screen(clean({ targetSizeUsd: 15, roundTripLossPct: 2, routeHops: null, multiHopRoute: null }))
      .notes.length === 0);

  /* AND IT REACHES NO GATE. gateFailures() is what the publish veto and the escalation
     ladder read; a note that never enters `fails` cannot appear there. */
  const rec = { mint: "Hop111111111111111111111111111111111111111", outcome: "screened_out",
    fails: twoHop.fails, ev: clean({ routeHops: 2, multiHopRoute: true }) };
  const codes = gateFailures(rec).map((g) => g.code);
  ok("gateFailures() never sees it at all", !codes.includes("multi_hop_route"),
    `gates: [${codes.join(", ") || "none"}]`);
}

/* ── 6. THE CALL RECORDS THE HOP COUNT ───────────────────────────────────────────── */
console.log("\n6. route_hops_at_call, stored beside rt_loss_at_call as another observation");
{
  const call = openCall({ mint: "HopCall1111111111111111111111111111111111", symbol: "HOPC",
    category: "memecoin", conviction: 60, entryRef: 1, stop: 0.9, target: 1.4,
    thesis: "t", invalidation: "i", flags: [], liqUsd: 60_000, rtLossPct: 2.2,
    routeHops: 2, mcapUsd: 400_000 });
  console.log(`  call ${call.id}: route_hops_at_call=${call.route_hops_at_call} ` +
    `rt_loss_at_call=${call.rt_loss_at_call} liq_at_call=${call.liq_at_call} mcap_at_call=${call.mcap_at_call}`);
  ok("the hop count is written, and the neighbouring columns did not shift",
    call.route_hops_at_call === 2 && call.rt_loss_at_call === 2.2 &&
    call.liq_at_call === 60_000 && call.mcap_at_call === 400_000,
    `hops=${call.route_hops_at_call} rt=${call.rt_loss_at_call} mcap=${call.mcap_at_call}`);
  const unmeasured = openCall({ mint: "HopCall2222222222222222222222222222222222", symbol: "HOPD",
    category: "memecoin", conviction: 60, entryRef: 1, stop: 0.9, target: 1.4,
    thesis: "t", invalidation: "i", flags: [], liqUsd: 60_000, rtLossPct: null,
    routeHops: null, mcapUsd: 400_000 });
  ok("an unmeasured route stores NULL, not 0", unmeasured.route_hops_at_call === null,
    `route_hops_at_call=${unmeasured.route_hops_at_call}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
