/**
 * The trend lane (snipe-trend.mjs): parents, related launches, lottery exits, shadow only.
 * Every clock is virtual and every event is built by hand, so each exit is exact.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TREND_DEFAULTS, PUMPFUN_OPEN_PRICE, trendKeys, parentsFromListing, matchLaunch, priceOfTrade,
  netReturn, createTrendShadow, createTrendDetector,
} from "./snipe-trend.mjs";
import { SNIPE_ENV, snipeLaneConfig, SnipeLaneError, LIVE_FILTER_ENV } from "./snipe-lane.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const H = 3_600_000;
const NOW = 1_790_600_000_000;
const row = (over) => ({ mint: `M${Math.random().toString(36).slice(2)}`, name: "x", symbol: "X",
  created_timestamp: NOW - 5 * H, ath_market_cap: 2_000_000, ath_market_cap_timestamp: NOW - 2 * H, ...over });

section("1. PARENTS: $1M+ reached within 12 hours of launch, and still fresh");
{
  const ps = parentsFromListing([
    row({ mint: "A", symbol: "CALI", name: "CALI", description: "The dog of Maye Musk." }),
    row({ mint: "B", symbol: "SLOW", created_timestamp: NOW - 30 * H, ath_market_cap_timestamp: NOW - 2 * H }),
    row({ mint: "C", symbol: "SMALL", ath_market_cap: 900_000 }),
    row({ mint: "D", symbol: "OLD", created_timestamp: NOW - 40 * H, ath_market_cap_timestamp: NOW - 30 * H }),
    row({ mint: "A", symbol: "CALI", name: "dupe" }),
  ], { nowMs: NOW });
  ok("a coin at $2M three hours after launch is a parent", ps.some((p) => p.mint === "A"));
  ok("one that took 28 hours to get there is not", !ps.some((p) => p.mint === "B"));
  ok("one under $1M is not", !ps.some((p) => p.mint === "C"));
  ok("one whose high is more than a day old is not", !ps.some((p) => p.mint === "D"));
  ok("a mint listed twice is one parent", ps.filter((p) => p.mint === "A").length === 1);
  ok("the parent says how fast it got there", ps.find((p) => p.mint === "A").hoursToReach === 3);
}

section("2. KEYS: ticker, distinctive words, description names — never generic words");
{
  const k = trendKeys({ name: "cat wif sword", symbol: "swordcat", description: "Launched on discord" });
  ok("the ticker is a strong key", k.get("swordcat") === "strong");
  ok("a distinctive name word is a key", k.get("sword") === "word");
  ok("'cat' and 'wif' are not keys", !k.has("cat") && !k.has("wif"));
  const m = trendKeys({ name: "MrBeast Coin", symbol: "MrBeast" });
  ok("a camel-case ticker splits: MrBeast -> beast", m.has("beast") && m.has("mrbeast"));
  const g = trendKeys({ name: "GTA VI", symbol: "GTA6" });
  ok("a ticker with digits keeps its letters: GTA6 -> gta", g.has("gta") && g.has("gta6"));
  const c = trendKeys({ name: "CALI", symbol: "CALI", description: "The dog of Maye Musk. All fees go" });
  ok("capitalised description words are subtopic keys", c.get("maye") === "desc" && c.get("musk") === "desc");
}

section("3. RELATED, NOT COPIES: variants and subtopics match, clones are skipped");
{
  const parents = parentsFromListing([
    row({ mint: "SW", symbol: "swordcat", name: "cat wif sword" }),
    row({ mint: "CA", symbol: "CALI", name: "CALI", description: "The dog of Maye Musk." }),
    row({ mint: "PH", symbol: "PHI", name: "PHI" }),
  ], { nowMs: NOW });
  const m = (name, symbol, extra = {}) => matchLaunch({ mint: "L", name, symbol }, parents, { createdAtMs: NOW, ...extra });
  const kitten = m("Kitten Wif Sword", "KWS");
  ok("'Kitten Wif Sword' is a subtopic of swordcat, pattern wif", kitten?.kind === "subtopic" && kitten.parent.mint === "SW" && kitten.pattern === "wif");
  const baby = m("Baby Cali", "BABYCALI");
  ok("'Baby Cali' is a variant of CALI, pattern family", baby?.kind === "variant" && baby.parent.mint === "CA" && baby.pattern === "family");
  const maye = m("Maye Musk", "MAYE");
  ok("'Maye Musk' is a subtopic of CALI through its description", maye?.kind === "subtopic" && maye.parent.mint === "CA");
  ok("an exact clone (same ticker) is flagged, not matched", m("anything", "CALI")?.clone === true);
  ok("an exact clone (same name) is flagged, not matched", m("cat wif sword", "CWS2")?.clone === true);
  ok("a three-letter ticker is not found inside another word: PHI is not in 'Philly Cheese'", m("Philly Cheese", "PCC") === null);
  ok("...but it counts as a whole word", m("PHI 2.0", "PHI2")?.parent?.mint === "PH");
  ok("an unrelated launch matches nothing", m("Moon Rabbit", "RABBIT") === null);
  ok("a launch older than the parent cannot be its spin-off",
    matchLaunch({ mint: "L", name: "Baby Cali", symbol: "BC" }, parents, { createdAtMs: NOW - 10 * H }) === null);
  ok("a generic-flagged key is ignored", m("Baby Cali", "BC", { isGeneric: (k) => k === "cali" }) === null);
}

section("4. PRICES AND COSTS");
{
  ok("price is virtual quote over virtual base", priceOfTrade({ vQuoteRaw: 30_000_000_000n, vBaseRaw: 1_073_000_000_000_000n }) === PUMPFUN_OPEN_PRICE);
  ok("an unreadable (non-SOL) trade has no price", priceOfTrade({ vQuoteRaw: 1n, vBaseRaw: 1n, quoteUsable: false }) === null);
  const flat = netReturn(1);
  ok("a flat round trip loses both fees and both network legs", Math.abs(flat - ((1 - 0.0125) ** 2 - 1 - 0.004)) < 1e-12, flat.toFixed(5));
}

section("5. THE SHADOW LANE: lottery exits, on paper");
{
  const parents = parentsFromListing([row({ mint: "SW", symbol: "swordcat", name: "cat wif sword" })], { nowMs: NOW });
  let t = NOW;
  const closed = [];
  const lane = () => createTrendShadow({ parents: () => parents, clock: () => t, onClose: (r) => closed.push(r) });
  const trade = (mint, x) => ({ kind: "trade", mint, vQuoteRaw: BigInt(Math.round(30e9 * x)), vBaseRaw: 1_073_000_000_000_000n });
  const run = (script) => {
    closed.length = 0; t = NOW;
    const s = lane();
    s.onCreate({ mint: "K1", name: "Kitten Wif Sword", symbol: "KWS" }, t);
    for (const [dt, x] of script) { t += dt; if (x !== null) s.onTrade(trade("K1", x), t); s.tick(t); }
    return { s, row: closed[0] };
  };
  /* Entry is 2s after the create event, at the curve's price then. */
  let { s, row: r } = run([[1_000, 1.0], [1_500, null], [1_000, 0.74]]);
  ok("a 26% drop from entry is stopped", r?.reason.startsWith("stop") && r.exitX < 0.75, r?.reason);
  ok("the stop row is a loss after costs", r?.pnlSol < 0 && r.netPct < -25, `${r?.netPct}%`);
  ({ row: r } = run([[2_500, 1.0], [60_000, 1.05], [125_000, 1.04]]));
  ok("a coin that never reaches +10% in 3 minutes is cut as a loser", r?.reason.startsWith("loser"), r?.reason);
  ({ row: r } = run([[2_500, 1.0], [30_000, 1.5], [30_000, 3.0], [30_000, 2.2]]));
  ok("a winner is not sold at +30%: it rides to 3x and leaves 25% off that peak",
    r?.reason.startsWith("trail") && r.peakX === 3 && r.exitX === 2.2, `${r?.reason}, net ${r?.netPct}%`);
  ok("...and the ride is a real profit after costs", r?.pnlSol > 0.05, `${r?.pnlSol} SOL on 0.05`);
  ({ row: r } = run([[2_500, 1.0], [30_000, 1.4], [3_600_000, 1.35]]));
  ok("anything still open at the maximum hold is closed", r?.reason.startsWith("max hold"), r?.reason);
  ({ s } = run([]));
  t += 2_500; s.tick(t);
  ok("with no trade yet, entry is at pump.fun's opening price", s.open()[0]?.x === 1);
  const st = s.stats();
  ok("stats count the match and the entry", st.matched === 1 && st.entered === 1 && st.open === 1);

  /* Clones are counted and never followed; unrelated launches are not counted as matches. */
  const c = lane();
  c.onCreate({ mint: "C1", name: "cat wif sword", symbol: "SWC" }, NOW);
  c.onCreate({ mint: "U1", name: "Moon Rabbit", symbol: "RABBIT" }, NOW);
  const cs = c.stats();
  ok("a clone is counted and skipped", cs.clones === 1 && cs.matched === 0 && cs.launches === 2);

  /* A key that suddenly matches a flood of launches is generic, and stops matching. */
  const g = createTrendShadow({ parents: () => parents, clock: () => NOW, cfg: { genericPerHour: 3 } });
  for (let i = 0; i < 6; i++) g.onCreate({ mint: `G${i}`, name: `Sword thing ${i}`, symbol: `ST${i}` }, NOW);
  const gs = g.stats();
  ok("a key matching too many launches in an hour is withdrawn", gs.matched === 2 && gs.generic >= 1, JSON.stringify({ m: gs.matched, g: gs.generic }));

  /* A sink that throws cannot stop the lane. */
  const bad = createTrendShadow({ parents: () => parents, clock: () => t, onClose: () => { throw new Error("disk full"); } });
  t = NOW; bad.onCreate({ mint: "B1", name: "Kitten Wif Sword", symbol: "KWS" }, t);
  t += 2_500; bad.tick(t); t += 1_000; bad.onTrade(trade("B1", 0.5), t);
  ok("a throwing sink does not throw out of the lane", bad.stats().closed === 1);
}

section("5b. THE STRATEGY against its comparison, and the scorecard across restarts");
{
  const parents = parentsFromListing([
    row({ mint: "SW", symbol: "swordcat", name: "cat wif sword" }),
    row({ mint: "CA", symbol: "CALI", name: "CALI", description: "The dog of Maye Musk." }),
  ], { nowMs: NOW });
  const closed = [];
  let t = NOW;
  const s = createTrendShadow({ parents: () => parents, clock: () => t, cfg: { kinds: ["variant"] }, onClose: (r) => closed.push(r) });
  const trade = (mint, x) => ({ kind: "trade", mint, vQuoteRaw: BigInt(Math.round(30e9 * x)), vBaseRaw: 1_073_000_000_000_000n });
  s.onCreate({ mint: "V1", name: "Baby Cali", symbol: "BABYCALI" }, t);
  s.onCreate({ mint: "S1", name: "Kitten Wif Sword", symbol: "KWS" }, t);
  t += 2_500; s.tick(t);
  t += 1_000; s.onTrade(trade("V1", 0.5), t); s.onTrade(trade("S1", 0.5), t); s.tick(t);
  ok("both kinds are still followed on paper", closed.length === 2);
  ok("the variant row is the strategy, the subtopic row is not",
    closed.find((r) => r.kind === "variant")?.strategy === true && closed.find((r) => r.kind === "subtopic")?.strategy === false);
  const st = s.stats();
  ok("stats split the strategy from its comparison", st.kinds.join() === "variant" && st.strategy.n === 1 && st.comparison.n === 1,
    JSON.stringify({ s: st.strategy, c: st.comparison }));
  ok("the default strategy is both kinds, with nothing left to compare", (() => {
    const d = createTrendShadow({ parents: () => parents, clock: () => t }).stats();
    return d.kinds.length === 2 && d.comparison.n === 0;
  })());

  /* A restart: the rows written to the JSONL file come back and are judged by the CURRENT kinds. */
  const fresh = createTrendShadow({ parents: () => parents, clock: () => t, cfg: { kinds: ["subtopic"] } });
  const back = fresh.seed([...closed, { junk: true }, null, { ...closed[0], kind: "clone" }]);
  ok("seed restores the valid rows and drops the rest", back === 2 && fresh.history().length === 2);
  ok("restored rows are re-judged against today's kinds",
    fresh.history().find((r) => r.kind === "subtopic").strategy === true && fresh.history().find((r) => r.kind === "variant").strategy === false);
  ok("the scorecard says since when", fresh.stats().sinceMs === Math.min(...closed.map((r) => r.exitAtMs)));
  const capped = createTrendShadow({ parents: () => parents, clock: () => t, cfg: { historyCap: 3 } });
  capped.seed(Array.from({ length: 5 }, (_, i) => ({ ...closed[0], exitAtMs: NOW + i })));
  ok("seed keeps only the newest rows up to the cap", capped.history().length === 3 && capped.history()[0].exitAtMs === NOW + 2);
}

section("6. THE DETECTOR keeps the last good parents when a refresh fails");
{
  let calls = 0, failNext = false;
  const d = createTrendDetector({
    clock: () => NOW,
    fetchRows: async (page) => {
      calls++;
      if (failNext) throw new Error("HTTP 429");
      return page === 0 ? [row({ mint: "P1", symbol: "NIKE", name: "Just Do It" })] : [];
    },
  });
  await d.refresh();
  ok("a refresh finds the parent", d.parents().length === 1 && d.parents()[0].symbol === "NIKE");
  failNext = true;
  await d.refresh();
  ok("a failed refresh keeps it and records the error", d.parents().length === 1 && d.stats().failures === 1 && /429/.test(d.stats().lastError));
}

section("7. WIRING: shadow only, one switch, registered everywhere a setting must be");
{
  ok("SNIPE_TREND is a lane setting", SNIPE_ENV.SNIPE_TREND?.key === "trendMode");
  ok("it defaults to off", snipeLaneConfig({}).trendMode === "off");
  ok("shadow is accepted", snipeLaneConfig({ SNIPE_TREND: "shadow" }).trendMode === "shadow");
  ok("'live' is accepted: the real-money lane is snipe-trend-live.mjs (test-snipe-trend-live.mjs)",
    snipeLaneConfig({ SNIPE_TREND: "live" }).trendMode === "live");
  let e = null; try { snipeLaneConfig({ SNIPE_TREND: "yolo" }); } catch (x) { e = x; }
  ok("an unknown trend mode is refused", e instanceof SnipeLaneError, e?.message);
  ok("it is not a filter the desk can flip", !LIVE_FILTER_ENV.includes("SNIPE_TREND"));
  ok("SNIPE_TREND_KINDS picks the strategy's kinds, default all", SNIPE_ENV.SNIPE_TREND_KINDS?.key === "trendKinds" && snipeLaneConfig({}).trendKinds === "all");
  ok("variant is accepted", snipeLaneConfig({ SNIPE_TREND_KINDS: "Variant" }).trendKinds === "variant");
  let ek = null; try { snipeLaneConfig({ SNIPE_TREND_KINDS: "clone" }); } catch (x) { ek = x; }
  ok("an unknown kind is refused", ek instanceof SnipeLaneError, ek?.message);
  const runner = fs.readFileSync(path.join(HERE, "launchd-runner.mjs"), "utf8");
  const install = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");
  ok("the runner allows it and ships the module", /"SNIPE_TREND"/.test(runner) && /"snipe-trend\.mjs"/.test(runner));
  ok("the installer carries it and ships the module", /SNIPE_TREND/.test(install) && (install.match(/snipe-trend\.mjs/g) || []).length >= 2);
  ok("the runner allows SNIPE_TREND_KINDS and the installer carries it", /"SNIPE_TREND_KINDS"/.test(runner) && /SNIPE_TREND_KINDS/.test(install));
  const poller = fs.readFileSync(path.join(HERE, "poller.mjs"), "utf8");
  ok("the poller builds it in shadow or live mode", /laneCfg\.trendMode === "shadow" \|\| laneCfg\.trendMode === "live"/.test(poller));
  ok("...and feeds it from the gRPC stream's create and trade events",
    /trendShadow\.onTrade\(ev, atMs\)/.test(poller) && /trendShadow\.onCreate\(ev, atMs\)/.test(poller));
  const trend = fs.readFileSync(path.join(HERE, "snipe-trend.mjs"), "utf8");
  ok("the trend module holds no signing code", !/Keypair|sendRawTransaction|signTransaction|secretKey/.test(trend));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-trend  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
