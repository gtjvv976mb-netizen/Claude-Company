/**
 * The live trend lane (snipe-trend-live.mjs): real buys of the strategy's kinds through the
 * sniper's signing port, the paper lane's exits, its own limits, and a book that survives a
 * restart. The port, the endpoints and the clock are fakes, so every trade here is exact.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUMPFUN_VENUE } from "./snipe-venue-pumpfun.mjs";
import { createTrendLive, trendLiveConfig, TREND_LIVE_DEFAULTS } from "./snipe-trend-live.mjs";
import { createTrendShadow, parentsFromListing, TREND_MODES } from "./snipe-trend.mjs";
import { snipeLaneConfig, SnipeLaneError, SNIPE_ENV, LIVE_FILTER_ENV } from "./snipe-lane.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const NOW = 1_790_600_000_000;
const VBASE = 1_073_000_000_000_000n;
const curveAt = (x, { realSol = 5, complete = false } = {}) => ({
  kind: "bonding-curve", venue: "pumpfun", mint: "M", vBaseRaw: VBASE, vQuoteRaw: BigInt(Math.round(30e9 * x)),
  realBaseRaw: 793_100_000_000_000n, realQuoteRaw: BigInt(Math.round(realSol * 1e9)),
  tokenTotalSupplyRaw: 1_000_000_000_000_000n, complete, creator: null, feeBps: 125, feeBpsKnown: true, baseDecimals: 6,
});
const trade = (mint, x, realSol = null) => ({ kind: "trade", mint, vQuoteRaw: BigInt(Math.round(30e9 * x)), vBaseRaw: VBASE,
  ...(realSol === null ? {} : { realQuoteRaw: BigInt(Math.round(realSol * 1e9)) }) });

/** A world: a fake port, two endpoints reading a curve the test moves, and a clock. */
function world({ loadState = null, holdings = null, sellFails = 0, cfg = {} } = {}) {
  const w = { t: NOW, curves: new Map(), buys: [], sells: [], saved: null, closedRows: [], logs: [], sellFails };
  const reader = (id) => ({ id, async read(mint) {
    const c = w.curves.get(mint) ?? curveAt(1);
    return { slot: 100, accounts: [{ data: Buffer.from(`curve:${mint}:${c.vQuoteRaw}`), curve: c }] };
  } });
  const venue = { ...PUMPFUN_VENUE, accountsFor: () => ["curve", "global", "mint"], curveFromAccount: (a) => a?.curve ?? null };
  const executor = {
    prepareBuy: ({ mint, baseOutRaw, maxQuoteInRaw }) => ({ instruction: { mint }, baseOutRaw: String(baseOutRaw), maxQuoteInRaw: String(maxQuoteInRaw) }),
    async buy({ mint, maxQuoteInRaw, baseOutRaw }) {
      w.buys.push({ mint, maxQuoteInRaw, baseOutRaw });
      return { qtyRaw: String(baseOutRaw), quoteInRaw: String(maxQuoteInRaw), feeLamports: "10000", signature: `buy-${mint}`, confirmedAtMs: w.t };
    },
    async sell({ mint, qtyRaw, reason }) {
      w.sells.push({ mint, qtyRaw, reason });
      if (w.sellFails > 0) { w.sellFails--; throw Object.assign(new Error("simulation failed: 6001"), { clause: "simulation_failed" }); }
      const x = Number(w.curves.get(mint)?.vQuoteRaw ?? 30e9) / 30e9;
      return { quoteOutRaw: String(Math.round(50_000_000 * x * 0.975)), feeLamports: "10000", signature: `sell-${mint}` };
    },
  };
  w.lane = createTrendLive({
    executor, venue, readers: [reader("primary"), reader("secondary")], feeBps: () => 125,
    holdingsReader: holdings, cfg, clock: () => w.t, log: (m) => w.logs.push(m),
    load: () => loadState, save: (s) => { w.saved = JSON.parse(JSON.stringify(s)); }, onClose: (r) => w.closedRows.push(r),
  });
  return w;
}
const sig = (mint, over = {}) => ({ mint, symbol: mint, name: `Baby ${mint}`, kind: "variant", key: "cali", pattern: "family",
  parent: { mint: "P", symbol: "CALI" }, entryAtMs: NOW, entryPrice: 30e9 / Number(VBASE), strategy: true, ...over });

section("1. ENTRY: only the strategy's kinds, only inside the limits");
{
  const w = world();
  ok("a non-strategy (comparison) entry is not bought", w.lane.onSignal(sig("S1", { kind: "subtopic", strategy: false })) === "not_strategy");
  ok("a strategy entry is bought", w.lane.onSignal(sig("V1")) === "buying");
  await flush();
  ok("...through the signing port, at the 0.05 SOL ticket", w.buys.length === 1 && w.buys[0].maxQuoteInRaw === 50_000_000n,
    `${w.buys[0]?.maxQuoteInRaw}`);
  const st = w.lane.stats();
  ok("the position is held and counted", st.entered === 1 && st.open.length === 1 && st.open[0].symbol === "V1");
  ok("...and written to disk at once", w.saved?.positions?.length === 1 && w.saved.positions[0].costBasisLamports === String(50_000_000 + 10_000));
  ok("the same coin is not bought twice", w.lane.onSignal(sig("V1")) === "held");
  w.lane.onSignal(sig("V2")); await flush();
  ok("the limit of two open positions holds", w.lane.onSignal(sig("V3")) === "full" && w.buys.length === 2);
  const late = world();
  late.t = NOW + 20_000;
  ok("a paper entry older than 15s is not chased", late.lane.onSignal(sig("L1")) === "late" && late.buys.length === 0);
  const grad = world();
  grad.curves.set("G1", curveAt(1, { complete: true }));
  grad.lane.onSignal(sig("G1")); await flush();
  ok("a curve that has graduated is not bought", grad.buys.length === 0 && grad.lane.stats().entryFailures === 1);
}

section("2. EXITS: the paper lane's rule, then a real sell");
{
  const w = world();
  w.lane.onSignal(sig("A")); await flush();
  w.t += 1_000; w.curves.set("A", curveAt(0.7)); w.lane.onTrade(trade("A", 0.7), w.t);
  await w.lane.tick(w.t);
  ok("a 30% drop is stopped out", w.sells.length === 1 && /^stop/.test(w.sells[0].reason), w.sells[0]?.reason);
  const row = w.closedRows[0];
  ok("the closed row carries the realized SOL: back less fee less basis",
    row && row.realizedLamports === String(Math.round(50_000_000 * 0.7 * 0.975) - 10_000 - 50_010_000), row?.realizedLamports);
  ok("the book is empty after the sell", w.lane.stats().open.length === 0 && w.saved.positions.length === 0);

  const t = world();
  t.lane.onSignal(sig("B")); await flush();
  for (const x of [1.2, 1.6, 2.0]) { t.t += 10_000; t.curves.set("B", curveAt(x)); t.lane.onTrade(trade("B", x), t.t); await t.lane.tick(t.t); }
  ok("a winner is not sold on the way up", t.sells.length === 0);
  t.t += 10_000; t.curves.set("B", curveAt(1.45)); t.lane.onTrade(trade("B", 1.45), t.t); await t.lane.tick(t.t);
  ok("it leaves 25% off its own peak", t.sells.length === 1 && /^trail/.test(t.sells[0].reason), t.sells[0]?.reason);
  ok("...at a profit", t.closedRows[0]?.realizedSol > 0, `${t.closedRows[0]?.realizedSol}`);

  const g = world();
  g.lane.onSignal(sig("C")); await flush();
  g.t += 5_000; g.lane.onTrade(trade("C", 1.1, 80), g.t); await g.lane.tick(g.t);
  ok("it sells before the curve graduates (80 SOL of 85)", g.sells.length === 1 && /graduation guard/.test(g.sells[0].reason), g.sells[0]?.reason);

  const s = world();
  s.lane.onSignal(sig("D")); await flush();
  s.t += 30_000; s.curves.set("D", curveAt(0.6));
  await s.lane.tick(s.t);
  ok("with no trade heard, the tick reads the curve itself and still stops out", s.sells.length === 1 && /^stop/.test(s.sells[0].reason));

  const l = world();
  l.lane.onSignal(sig("E")); await flush();
  l.t += 181_000; l.curves.set("E", curveAt(1.02)); await l.lane.tick(l.t);
  ok("a coin that never reached +10% in 3 minutes is cut", l.sells.length === 1 && /^loser/.test(l.sells[0].reason), l.sells[0]?.reason);
}

section("3. A SELL THAT FAILS IS KEPT, RETRIED, AND RECONCILED ONLY ON A DEFINITE ZERO");
{
  let held = "1";
  const w = world({ sellFails: 2, holdings: { async read() { return { qtyRaw: held }; } } });
  w.lane.onSignal(sig("F")); await flush();
  w.t += 1_000; w.curves.set("F", curveAt(0.6)); w.lane.onTrade(trade("F", 0.6), w.t);
  await w.lane.tick(w.t);
  ok("a failed sell keeps the position", w.lane.stats().open.length === 1 && w.lane.stats().exitFailures === 1);
  ok("...marked as exiting, with the error", w.lane.stats().open[0].exiting === true && /simulation_failed/.test(w.lane.stats().open[0].exitError));
  w.t += 500; await w.lane.tick(w.t);
  ok("it is not retried on the very next tick: the retry backs off", w.sells.length === 1, `${w.sells.length} sells`);
  w.t += 2_000; w.curves.set("F", curveAt(0.9)); w.lane.onTrade(trade("F", 0.9), w.t);
  held = "0";
  await w.lane.tick(w.t);
  ok("a wallet that holds none of it closes the row as reconciled", w.lane.stats().open.length === 0 && w.closedRows[0]?.reconciled === true
    && w.closedRows[0].realizedSol === null);
}

section("4. THE LOSS STOP: no new buy after the day's limit; exits go on");
{
  const w = world({ cfg: { maxDailyLossSol: 0.02 } });
  w.lane.onSignal(sig("H")); await flush();
  w.t += 1_000; w.curves.set("H", curveAt(0.5)); w.lane.onTrade(trade("H", 0.5), w.t); await w.lane.tick(w.t);
  ok("a loss past the limit is realized", w.lane.stats().realized24hSol <= -0.02, `${w.lane.stats().realized24hSol}`);
  ok("and stops new buys", w.lane.onSignal(sig("I")) === "loss_stop" && w.lane.stats().lossStop === true && w.buys.length === 1);
  w.t += 86_400_001;
  ok("it lifts once the loss is a day old", w.lane.onSignal(sig("J", { entryAtMs: w.t })) === "buying");
}

section("5. A RESTART RESUMES WHAT IS OPEN");
{
  const a = world();
  a.lane.onSignal(sig("K")); await flush();
  const b = world({ loadState: a.saved });
  ok("the saved position comes back", b.lane.stats().open.length === 1 && b.lane.holds("K"));
  b.t += 1_000; b.curves.set("K", curveAt(0.6)); await b.lane.tick(b.t);
  ok("...and is sold on the rule, by the new process", b.sells.length === 1 && b.lane.stats().open.length === 0);
  const junk = world({ loadState: { positions: [{ mint: "Z" }, null, "x"], closed: "nope" } });
  ok("a malformed saved file restores nothing and does not throw", junk.lane.stats().open.length === 0);
}

section("6. THE PAPER LANE SIGNALS, AND KEEPS RUNNING");
{
  const parents = parentsFromListing([{ mint: "CA", symbol: "CALI", name: "CALI", created_timestamp: NOW - 5 * 3_600_000,
    ath_market_cap: 2_000_000, ath_market_cap_timestamp: NOW - 2 * 3_600_000 }], { nowMs: NOW });
  const w = world();
  let t = NOW;
  const paper = createTrendShadow({ parents: () => parents, clock: () => t, cfg: { kinds: ["variant"] },
    onEnter: (s) => { w.t = t; w.lane.onSignal(s); } });
  paper.onCreate({ mint: "V9", name: "Baby Cali", symbol: "BABYCALI" }, t);
  t += 2_500; paper.tick(t); await flush();
  ok("a paper variant entry becomes a real buy", w.buys.length === 1 && w.buys[0].mint === "V9");
  const thrower = createTrendShadow({ parents: () => parents, clock: () => t, onEnter: () => { throw new Error("boom"); } });
  thrower.onCreate({ mint: "V8", name: "Baby Cali", symbol: "BABYC" }, t);
  t += 2_500; thrower.tick(t);
  ok("a listener that throws does not stop the paper lane", thrower.stats().entered === 1);
}

section("7. SETTINGS AND WIRING");
{
  ok("SNIPE_TREND now admits live", TREND_MODES.includes("live") && snipeLaneConfig({ SNIPE_TREND: "live" }).trendMode === "live");
  const c = snipeLaneConfig({});
  ok("the live limits default small: 0.05 SOL, 2 open, 0.15 SOL a day",
    c.trendTicketSol === 0.05 && c.trendMaxOpen === 2 && c.trendMaxDailyLossSol === 0.15);
  for (const [name, value] of [["SNIPE_TREND_TICKET_SOL", "0.6"], ["SNIPE_TREND_MAX_OPEN", "0"], ["SNIPE_TREND_MAX_DAILY_LOSS_SOL", "0"]]) {
    let e = null; try { snipeLaneConfig({ [name]: value }); } catch (x) { e = x; }
    ok(`${name}=${value} is refused`, e instanceof SnipeLaneError, e?.message);
  }
  let e = null; try { trendLiveConfig({ ticketSol: 1 }); } catch (x) { e = x; }
  ok("the module refuses a ticket over its 0.5 SOL hard cap too", e !== null && TREND_LIVE_DEFAULTS.hardMaxTicketSol === 0.5);
  ok("none of them is a filter the desk page can flip", !LIVE_FILTER_ENV.some((n) => n.startsWith("SNIPE_TREND")));
  ok("the three dials are lane settings", ["SNIPE_TREND_TICKET_SOL", "SNIPE_TREND_MAX_OPEN", "SNIPE_TREND_MAX_DAILY_LOSS_SOL"].every((n) => SNIPE_ENV[n]));
  let refused = null;
  try { createTrendLive({ venue: PUMPFUN_VENUE, readers: [{}, {}] }); } catch (x) { refused = x; }
  ok("without the signing port the live lane will not build", /signing port/.test(refused?.message ?? ""));
  const read = (f) => fs.readFileSync(path.join(HERE, f), "utf8");
  const runner = read("launchd-runner.mjs"), install = read("install.sh"), poller = read("poller.mjs");
  ok("the runner allows the dials and ships the module",
    ["SNIPE_TREND_TICKET_SOL", "SNIPE_TREND_MAX_OPEN", "SNIPE_TREND_MAX_DAILY_LOSS_SOL"].every((n) => runner.includes(`"${n}"`))
    && /"snipe-trend-live\.mjs"/.test(runner));
  ok("the installer carries the dials and ships the module (both lists)",
    /SNIPE_TREND_MAX_DAILY_LOSS_SOL/.test(install) && (install.match(/snipe-trend-live\.mjs/g) || []).length >= 2);
  ok("the poller builds the live lane only with the signing port", /laneCfg\.trendMode === "live"/.test(poller)
    && /if \(!snipeExecutor\) log\("\[snipe\] SNIPE_TREND=live needs the launch lane armed/.test(poller));
  ok("...feeds it every trade and ticks it on the lane's clock",
    /if \(trendLive\) trendLive\.onTrade\(ev, atMs\)/.test(poller) && /if \(trendLive\) void trendLive\.tick\(Date\.now\(\)\)/.test(poller));
  ok("...and saves its book with 0600 and an atomic rename", /trend-live\.json/.test(poller) && /renameSync\(tmp, liveFile\)/.test(poller));
  const live = read("snipe-trend-live.mjs");
  ok("the live module holds no key and opens no connection", !/Keypair|secretKey|new Connection|sendRawTransaction/.test(live));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-trend-live  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
