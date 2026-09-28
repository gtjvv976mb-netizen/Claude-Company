/**
 * THE VOLUME SPIKE, PINNED — and the thing being pinned hardest is a bug this file was
 * written before, not after.
 *
 * A spike is `flow now / flow before`. A ninety-second-old coin has no before, so the naive
 * version of this gate divides by zero, reports Infinity, and fires on EVERY fresh launch
 * while calling itself a volume signal. On this desk's own record that is the losing book:
 * over 64 real trades, entries under three seconds won 0% for -18.5% while entries at ten
 * seconds and later won 40% for +34.0%. A "buy everything young" gate wearing a spike
 * costume would have pushed the sniper further into exactly those trades, and it would have
 * looked like a new edge the whole way down.
 *
 * So the first four cases below assert that an absent baseline produces `spike: null` and
 * `baselineEmpty: true`, that the number is never Infinity and never a large stand-in, and
 * that the gate above it treats unknown as NOT a spike. If a future edit "fixes" the null
 * by defaulting the denominator, these fail.
 *
 * The rest holds the honesty rules the module's header claims: a falling reserve reads
 * negative rather than clamped to zero, a clock that went backwards is reported rather than
 * smoothed, an undecodable reserve is skipped rather than recorded as a zero, the tape is
 * bounded twice and counts what it evicted, and the tap that fills it can never throw into
 * the launch feed.
 *
 *   node test-snipe-volume.mjs
 */
import fs from "node:fs";
import {
  SNIPE_VOLUME_VERSION, DEFAULT_WINDOW_MS, DEFAULT_BASELINE_MS, DEFAULT_CAPACITY, DEFAULT_BUCKET_MS,
  measureSpike, measureActivity, DEFAULT_ACTIVITY_MS, createFlowTape, observeTradeEvents, createTradeTap,
  TRADE_FEED_STALE_MS, tradeFeedStatus,
} from "./snipe-volume.mjs";
import { SNIPE_GATES, SNIPE_PROXY_GATES, SNIPE_GATE_COST } from "./snipe-entry.mjs";
import { SNIPE_PROXIES } from "./snipe-shadow.mjs";
import { SNIPE_LANE_DEFAULTS, snipeLaneConfig } from "./snipe-lane.mjs";
import { createSnipeFeed, grpcSubscribeSource, createSourceWatchdog, GRPC_WATCHDOG } from "./snipe-feed.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/** A tape of `{atMs, quoteRaw}` at a fixed cadence, with a chosen lamports-per-step in the
 *  baseline stretch and another in the recent one. Everything below is built from this, so
 *  no case depends on a hand-typed reserve sequence being internally consistent. */
function tapeOf({ startMs = 0, stepMs = 1_000, baselineSteps = 0, baselinePerStep = 0n,
  recentSteps = 0, recentPerStep = 0n, from = 1_000_000_000n } = {}) {
  const out = [];
  let q = from, t = startMs;
  out.push({ atMs: t, quoteRaw: q.toString() });
  for (let i = 0; i < baselineSteps; i++) { t += stepMs; q += baselinePerStep; out.push({ atMs: t, quoteRaw: q.toString() }); }
  for (let i = 0; i < recentSteps; i++) { t += stepMs; q += recentPerStep; out.push({ atMs: t, quoteRaw: q.toString() }); }
  return { samples: out, endMs: t };
}

console.log("\nthe trap: a curve with no baseline");
{
  /* Ninety seconds old at a 1s tick: plenty of samples, plenty of inflow, and NO history
     before the recent window. This is the fresh launch, and it is the case that decides
     whether this module is a signal or a disguise. */
  const { samples, endMs } = tapeOf({ recentSteps: 25, recentPerStep: 4_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a curve with no baseline reports spike null", m.spike === null, JSON.stringify(m.reason));
  ok("and says WHY: baselineEmpty", m.baselineEmpty === true);
  ok("and the reason is no_baseline", m.reason === "no_baseline");
  ok("the spike is never Infinity", m.spike !== Infinity && !(typeof m.spike === "number" && !Number.isFinite(m.spike)));
  ok("the recent rate is still reported, so the row is not blank", m.recentLamportsPerSec > 0);
  ok("the baseline rate is null, not zero", m.baselineLamportsPerSec === null);
}
{
  /* The other shape of the same trap: a coin that genuinely sat still and then moved. The
     denominator is a real zero rather than a missing window, and it is refused identically —
     "nothing was happening, now something is" is not measurable as a RATIO, whatever the
     numerator says. */
  const { samples, endMs } = tapeOf({ baselineSteps: 400, baselinePerStep: 0n, recentSteps: 25, recentPerStep: 4_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a flat baseline is refused too, not divided by", m.spike === null && m.baselineEmpty === true);
  ok("a flat baseline reports a zero rate, which is a measurement", m.baselineLamportsPerSec === 0);
}
{
  /* A coin younger than the recent window has a rate but no ratio: the numerator is measured
     over the life it has, the denominator is NOT faked from the same samples. */
  const { samples, endMs } = tapeOf({ recentSteps: 12, recentPerStep: 5_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a 12-second-old coin still reports a per-second recent rate",
    Math.abs(m.recentLamportsPerSec - 5_000_000) < 100_000, String(m.recentLamportsPerSec));
  ok("but no ratio, because the baseline is NOT taken from the same samples", m.spike === null);
  ok("and the span it actually saw is reported", m.spanMs === 12_000);
}
{
  const m = measureSpike([{ atMs: 0, quoteRaw: "1" }], { nowMs: 1_000 });
  ok("one sample cannot be a ratio", m.spike === null && m.reason === "not_enough_samples");
  const n = measureSpike([], { nowMs: 1_000 });
  ok("no samples cannot be a ratio", n.spike === null && n.reason === "not_enough_samples");
  const c = measureSpike([{ atMs: 0, quoteRaw: "1" }, { atMs: 1, quoteRaw: "2" }], {});
  ok("no clock is refused rather than defaulted to Date.now()", c.spike === null && c.reason === "no_clock");
}

console.log("\nthe measurement itself");
{
  /* Ten minutes of 1_000_000 lamports a second, then thirty seconds of 4x that. The answer
     has to be 4. */
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a clean 4x spike measures 4x", m.spike !== null && Math.abs(m.spike - 4) < 0.05, String(m.spike));
  ok("the two rates are reported so the ratio is auditable",
    Math.abs(m.recentLamportsPerSec - 4_000_000) < 50_000 && Math.abs(m.baselineLamportsPerSec - 1_000_000) < 50_000);
  ok("net inflow over the recent window is reported in lamports",
    Math.abs(m.netInflowLamports - 30 * 4_000_000) <= 4_000_000, String(m.netInflowLamports));
  ok("a replay of the same tape gives the identical number",
    measureSpike(samples, { nowMs: endMs }).spike === m.spike);
}
{
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 2_000_000n, recentSteps: 30, recentPerStep: 2_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a coin trading at its own pace measures ~1x, not a spike", Math.abs(m.spike - 1) < 0.05, String(m.spike));
}
{
  /* THE FALLING RESERVE. Everyone is selling. Clamping this to zero would make it
     indistinguishable from a coin nobody is trading, which is the difference a holder cares
     about most. */
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: -3_000_000n });
  const m = measureSpike(samples, { nowMs: endMs });
  ok("a coin being sold reports a NEGATIVE spike", m.spike !== null && m.spike < 0, String(m.spike));
  ok("negative net inflow is not clamped to zero", m.netInflowLamports < 0);
  ok("a negative measurement is below any positive floor, so the gate refuses it", m.spike < 2);
}
{
  const { samples } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  const out = [...samples];
  out.splice(400, 0, { atMs: -5_000, quoteRaw: "1" });     // a sample from before the start
  const m = measureSpike(out, { nowMs: samples[samples.length - 1].atMs });
  ok("a clock that went backwards is REPORTED, not smoothed", m.clockRegression === true);
  ok("and the measurement is still produced rather than thrown away", m.spike !== null);
}
{
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  const junk = [...samples, { atMs: "later", quoteRaw: "5" }, { atMs: 1, quoteRaw: "-7" },
    { atMs: 2, quoteRaw: "1.5" }, null, "nope", { atMs: 3 }];
  const m = measureSpike(junk, { nowMs: endMs });
  ok("unusable samples are skipped, not coerced", m.samples === samples.length, `${m.samples} of ${junk.length}`);
  ok("and the surviving measurement is unchanged", Math.abs(m.spike - 4) < 0.05);
}
{
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  const bigints = samples.map((s) => ({ atMs: s.atMs, quoteRaw: BigInt(s.quoteRaw) }));
  ok("a BigInt reserve reads the same as its decimal string",
    measureSpike(bigints, { nowMs: endMs }).spike === measureSpike(samples, { nowMs: endMs }).spike);
}
{
  /* Windows are honoured as spans, not as sample counts: a wide window over the same tape
     must dilute a short burst. */
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  const tight = measureSpike(samples, { nowMs: endMs, windowMs: 10_000 });
  const wide = measureSpike(samples, { nowMs: endMs, windowMs: 120_000 });
  ok("a wider recent window dilutes a 30s burst", tight.spike > wide.spike, `${tight.spike} > ${wide.spike}`);
}

console.log("\nan uneven tape: rates are per WINDOW, not per gap between samples");
{
  /* THE BUG THIS PINS. Every case above is a steady 1s tick, where the gap between two
     boundary samples IS the window, so dividing by either gives the same number. A coin the
     momentum source delivers trades in bursts, and there the two diverge badly. Points are
     [seconds before now, SOL level]; the last one is the lane's own read at `now`. */
  const NOW = 10_000_000;
  const tape = (pts) => pts.map(([ago, sol]) => ({ atMs: NOW - ago * 1000, quoteRaw: String(Math.round(sol * 1e9)) }));

  /* A: a 5 SOL buy at t-310s after an hour of silence, then a trickle. The level at t-330 is
     5, at t-30 is 10.1, at t is 10.5 — baseline 5.1 SOL over 300s, recent 0.4 SOL over 30s.
     The flow is SLOWING (0.78x). Dividing by sample gaps instead spread the baseline's 5 SOL
     across the hour of nothing before it and called this a 2.7x spike. */
  const a = measureSpike(tape([[3600, 5], [310, 10], [100, 10.1], [5, 10.5], [0, 10.5]]), { nowMs: NOW });
  ok("a burst followed by a trickle reads as slowing, not as a spike",
    a.spike !== null && Math.abs(a.spike - (0.4 / 30) / (5.1 / 300)) < 0.01, String(a.spike));
  ok("the recent rate is the window's inflow over the window",
    Math.abs(a.recentLamportsPerSec - 0.4e9 / 30) < 1, String(a.recentLamportsPerSec));
  ok("the baseline rate is the baseline's inflow over the baseline",
    Math.abs(a.baselineLamportsPerSec - 5.1e9 / 300) < 1, String(a.baselineLamportsPerSec));
  ok("net inflow and the recent rate now agree with each other",
    Math.abs(a.recentLamportsPerSec * 30 - a.netInflowLamports) < 10, `${a.recentLamportsPerSec * 30} vs ${a.netInflowLamports}`);

  /* B: a quiet coin (0.5 SOL at t-320s) takes 4.5 SOL in the last ten seconds. That IS the
     wave: 4.5/30 against 0.5/300 is 90x. Divided by sample gaps it was 7.9x, and a floor of 10
     would have refused exactly what the owner asked this gate to catch. */
  const b = measureSpike(tape([[600, 10], [320, 10.5], [10, 15], [0, 15]]), { nowMs: NOW });
  ok("a sudden wave on a quiet coin reads at its full size",
    b.spike !== null && Math.abs(b.spike - 90) < 0.01, String(b.spike));
  ok("and clears a floor of 10 that the gap-divided number refused", b.spike >= 10);

  /* C: nothing traded in the last 30s. Under the level model that is a measured zero for the
     recent window, not an unknown — the edge sample says where the reserve stood. */
  const c = measureSpike(tape([[900, 10], [320, 11], [200, 12], [0, 12]]), { nowMs: NOW });
  ok("a coin that went quiet measures a zero recent rate, not null", c.recentLamportsPerSec === 0 && c.spike === 0, String(c.spike));
}

console.log("\nthe tape holds a baseline even for the coins that trade hardest");
{
  /* THE BUG THIS PINS. The tape is fed by trade events, so a hot coin produces samples far
     faster than a quiet one. One sample per trade meant 240 samples of a coin doing five
     trades a second was 48 seconds of history — under the 330 a spike needs — so the coin
     evicted its own baseline and the gate refused, with a threshold armed, exactly the coins
     that were spiking hardest. A volume gate blind in proportion to volume. */
  const hot = createFlowTape();
  let q = 1_000_000_000n, t = 0;
  for (let i = 0; i < 3_000; i++) { t += 200; q += 2_000_000n; hot.observe("HOT", { atMs: t, quoteRaw: q.toString() }); }
  /* Exactly the 30s recent window at 4x, so the baseline window behind it is undisturbed. */
  for (let i = 0; i < 150; i++) { t += 200; q += 8_000_000n; hot.observe("HOT", { atMs: t, quoteRaw: q.toString() }); }
  const m = hot.measure("HOT", { nowMs: t });
  ok("a coin trading five times a second still HAS a baseline", m.baselineEmpty === false, JSON.stringify(m.reason));
  ok("and its spike is measured, not refused", m.spike !== null && Math.abs(m.spike - 4) < 0.2, String(m.spike));
  ok("the tape stayed bounded while doing it", hot.stats().mints === 1 && hot.stats().coalesced > 2_800,
    `${hot.stats().coalesced} coalesced, ${hot.stats().droppedSamples} dropped`);
  ok("intra-bucket readings COALESCE rather than being counted as dropped",
    hot.stats().coalesced + hot.stats().droppedSamples + DEFAULT_CAPACITY >= 3_150);
  /* Geometry that cannot hold a baseline is refused at construction rather than discovered
     as a stream of `no_baseline` rows in the shadow book weeks later. */
  ok("a tape too short to hold a baseline is refused at construction",
    threw(() => createFlowTape({ capacity: 10, bucketMs: 1_000 })) !== null);
  ok("a fractional bucket is refused", threw(() => createFlowTape({ bucketMs: 0 })) !== null);
  ok("the bucket size is reported", createFlowTape().stats().bucketMs === 2_000);
}

console.log("\nthe tape: bounded twice, and it counts what it lost");
{
  const tape = createFlowTape({ capacity: 4, maxMints: 2, bucketMs: 1, windowMs: 2, baselineMs: 2 });
  for (let i = 0; i < 10; i++) tape.observe("A", { atMs: i * 1_000, quoteRaw: String(1_000 + i) });
  ok("samples past capacity are dropped and COUNTED", tape.stats().droppedSamples === 6, String(tape.stats().droppedSamples));
  tape.observe("B", { atMs: 1, quoteRaw: "1" });
  tape.observe("C", { atMs: 1, quoteRaw: "1" });
  ok("mints past maxMints are evicted and COUNTED", tape.stats().evictedMints === 1 && tape.size() === 2);
  ok("the least recently touched mint is the one evicted", tape.measure("A", { nowMs: 2 }).samples === 0);
  ok("an unusable sample is rejected and counted, never recorded as a zero",
    tape.observe("D", { atMs: 1, quoteRaw: null }) === null && tape.stats().rejected === 1);
  ok("a sample with no mint is rejected", tape.observe("", { atMs: 1, quoteRaw: "1" }) === null);
  ok("a sample with no clock is rejected", tape.observe("E", { atMs: NaN, quoteRaw: "1" }) === null);
  ok("an unknown mint measures as not_enough_samples, never as a spike",
    tape.measure("ZZZ", { nowMs: 1 }).spike === null);
  ok("forget() drops one mint", tape.forget("B") === true && tape.size() === 1);
  ok("a capacity under two is refused at construction", threw(() => createFlowTape({ capacity: 1 })) !== null);
  ok("a fractional maxMints is refused at construction", threw(() => createFlowTape({ maxMints: 1.5 })) !== null);
  ok("the tape carries its own version", createFlowTape().version === SNIPE_VOLUME_VERSION);
  ok("the defaults are a 30s window against a 5 minute baseline",
    DEFAULT_WINDOW_MS === 30_000 && DEFAULT_BASELINE_MS === 300_000 && DEFAULT_CAPACITY === 240);
}
{
  /* The tape and the pure function must agree: same samples in, same number out. */
  const { samples, endMs } = tapeOf({ baselineSteps: 600, baselinePerStep: 1_000_000n, recentSteps: 30, recentPerStep: 4_000_000n });
  /* bucketMs equal to the fixture's own step, so every sample is its own bucket and the tape
     holds exactly the series the pure function is given. */
  const tape = createFlowTape({ capacity: 2_000, bucketMs: 1_000 });
  for (const s of samples) tape.observe("M", { atMs: s.atMs, quoteRaw: s.quoteRaw });
  ok("the tape measures what measureSpike measures",
    tape.measure("M", { nowMs: endMs }).spike === measureSpike(samples, { nowMs: endMs }).spike);
}

console.log("\nthe tap: fed by trade events, and it cannot hurt the feed");
{
  const tape = createFlowTape();
  const took = observeTradeEvents(tape, [
    { mint: "A", realQuoteRaw: 100n, quoteUsable: true },
    { mint: "A", realQuoteRaw: 200n },                       // no flag at all is fine
    { mint: "B", realQuoteRaw: 300n, quoteUsable: false },   // proved not SOL-quoted
    { mint: "C", realQuoteRaw: null },
    null,
  ], { atMs: 1_000 });
  ok("usable trade events are recorded", took === 2, String(took));
  ok("a curve proved NOT to be SOL-quoted is skipped, not recorded", tape.measure("B", { nowMs: 1 }).samples === 0);
  ok("an undecodable reserve is skipped, not recorded as zero", tape.measure("C", { nowMs: 1 }).samples === 0);
  ok("observeTradeEvents refuses something that is not a tape", threw(() => observeTradeEvents(null, [])) !== null);
}
{
  const tape = createFlowTape();
  let clock = 5_000;
  const tap = createTradeTap({
    tape, clock: () => clock,
    tradesFrom: (n) => (n?.boom ? (() => { throw new Error("decoder blew up"); })() : (n?.trades ?? [])),
  });
  tap.observe({ trades: [{ mint: "A", realQuoteRaw: 1n }, { mint: "A", realQuoteRaw: 2n }] });
  clock = 6_000;
  tap.observe({ trades: [] });                                 // a create, or anything else
  const before = tap.stats();
  ok("the tap records the trades it was given", before.recorded === 2 && before.trades === 2);
  ok("every notification is counted, trades or not", before.notifications === 2);

  const error = threw(() => tap.observe({ boom: true }));
  ok("a throwing decoder does NOT throw into the launch feed", error === null);
  ok("it is counted instead", tap.stats().errors === 1);
  ok("and the message is kept so a silent tap is diagnosable", /decoder blew up/.test(String(tap.stats().lastError)));
  ok("the tap reports the tape's own counters alongside its own", tap.stats().tape.mints === 1);
  ok("a tap with no decoder is refused at construction", threw(() => createTradeTap({ tape })) !== null);
  ok("a tap with no tape is refused at construction", threw(() => createTradeTap({ tradesFrom: () => [] })) !== null);
  ok("the tap uses the clock it was handed, not Date.now()",
    tape.measure("A", { nowMs: 6_000 }).spanMs === 0, "both samples were stamped at 5_000");
}

console.log("\nthe gate above it");
{
  ok("volume_spike is a gate", SNIPE_GATES.includes("volume_spike"));
  ok("it is registered as a PROXY, so grade-entry-gates.mjs scores it", SNIPE_PROXY_GATES.includes("volume_spike"));
  ok("the shadow book knows how to read it", Object.keys(SNIPE_PROXIES).includes("volume_spike"));
  ok("every proxy gate has a scorer and every scorer has a gate",
    SNIPE_PROXY_GATES.every((g) => g in SNIPE_PROXIES) && Object.keys(SNIPE_PROXIES).every((g) => SNIPE_PROXY_GATES.includes(g)));
  ok("it costs nothing to evaluate: the measurement is already in hand", SNIPE_GATE_COST.volume_spike === 3);
  /* THE SHIPPED DEFAULT. Undefined, not a number: the gate measures on every launch and
     kills nothing until the owner has seen a scorecard. The same discipline the other two
     proxies ship under. */
  ok("the threshold ships UNSET, so nothing is refused on a signal nobody has graded",
    SNIPE_LANE_DEFAULTS.minVolumeSpike === undefined);
  ok("SNIPE_MIN_VOLUME_SPIKE is the dial that arms it",
    snipeLaneConfig({ SNIPE_MIN_VOLUME_SPIKE: "2.5" }).minVolumeSpike === 2.5);
  ok("an absent dial stays absent rather than becoming zero",
    snipeLaneConfig({}).minVolumeSpike === undefined);
}
{
  /* The gate's own behaviour — measured/armed/unmeasurable — is asserted in
     test-snipe-entry.mjs, which owns the fixture that can reach gate 22 of 25: its hostile
     table refuses a coin whose inflow is a fifth of its baseline at `volume_spike`, and its
     proxy case pins that an unmeasurable spike refuses a configured floor while an unset
     floor only measures. What is asserted HERE is that the gate exists to be reached and
     that the module feeding it is registered everywhere the scorecard looks. */
  const entry = fs.readFileSync(new URL("./snipe-entry.mjs", import.meta.url), "utf8");
  ok("the gate is a FLOOR and says so, because every other proxy is a ceiling",
    /A FLOOR, not a ceiling, which is why it cannot use proxyGate/.test(entry));
  ok("an unmeasurable spike refuses rather than passes when a floor is set",
    /unverified is not safe/.test(entry.slice(entry.indexOf("volume_spike: (c)"), entry.indexOf("volume_spike: (c)") + 1_200)));
  const shadow = fs.readFileSync(new URL("./snipe-shadow.mjs", import.meta.url), "utf8");
  ok("the scorecard's ruler for it is INVERTED, because its positive class is a launch nobody followed",
    /volume_spike: Object\.freeze\(\{[\s\S]{0,400}?measured\.volume_spike\) < 1/.test(shadow));
}

console.log("\nwiring");
{
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  ok("the lane measures the tape and hands the result to the gate stack",
    /flow\.measure\(mint, \{ nowMs: gateAtMs \}\)/.test(lane) && /flow: flowNow,/.test(lane));
  ok("the lane feeds the tape from curve reads it has already paid for",
    (lane.match(/flow\.observe\(mint, \{/g) ?? []).length >= 2);
  /* The gate-time read of a launch notice tops up a KNOWN mint only; the held position's read
     still inserts, because a coin we hold must stay measurable whether or not the tap heard it. */
  ok("the gate-time read of a notice is recorded only for a mint the trade feed already put there",
    /flow\.observe\(mint, \{ atMs: gateAtMs, quoteRaw: curve\?\.realQuoteRaw \?\? null, onlyIfKnown: true \}\)/.test(lane));
  ok("...and the held position's read is left inserting, as before",
    /flow\.observe\(mint, \{ atMs: now, quoteRaw: curve\?\.realQuoteRaw \?\? null \}\)/.test(lane)
      && (lane.match(/onlyIfKnown: true/g) ?? []).length === 1);
  ok("the gate and the rest of the stack are judged at the SAME instant",
    /const gateAtMs = clock\(\);/.test(lane) && /nowMs: gateAtMs,/.test(lane));
  ok("the tape rides on the lane's stats, so an empty one is visible", /flow: flow\.stats\(\),/.test(lane));
  ok("the lane exposes the tape it measures, so the tap can be proved to fill THAT one",
    /^    flow,$/m.test(lane));

  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller builds ONE tape and gives it to both the tap and the lane",
    /const flowTape = volumeMod\.createFlowTape\(\)/.test(poller)
    && /tape: flowTape,/.test(poller) && /^      flowTape,$/m.test(poller));
  ok("the tap is mounted on the gRPC source, where every trade already arrives",
    /observe: \(notification\) => \{\s*flowTap\.observe\(notification\);/.test(poller));
  ok("it decodes trades with the venue's own verified decoder, not a copy",
    /eventsFromLogs\(notification\?\.logs, \{ kind: "trade" \}\)/.test(poller));
  /* snipe-volume.mjs must stay a LANE module: imported dynamically inside the
     SNIPE_LANE !== "off" branch, so `off` costs nothing. test-snipe-wiring.mjs holds the
     same line for every other snipe- module. */
  ok("snipe-volume is imported dynamically, so SNIPE_LANE=off still costs nothing",
    !/^import .*snipe-volume/m.test(poller) && /import\("\.\/snipe-volume\.mjs"\)/.test(poller));

  const feed = fs.readFileSync(new URL("./snipe-feed.mjs", import.meta.url), "utf8");
  ok("the feed's observer cannot fail the source", /try \{ observe\(notification, context\); \} catch/.test(feed));
  ok("a non-function observer is refused at construction", /observe must be a function or null/.test(feed));

  const src = fs.readFileSync(new URL("./snipe-volume.mjs", import.meta.url), "utf8");
  ok("the module opens no connection and holds no endpoint",
    !/new Connection\(/.test(src) && !/https?:\/\//.test(src.replace(/^\s*\*.*$/gm, "")));
  ok("nothing in it clamps a negative flow to zero", !/Math\.max\(0/.test(src));
  /* THE ONE DIVISION IN THE FILE, AND ITS GUARD — spelled out so that "fixing" the null by
     defaulting the denominator cannot pass this suite. */
  ok("the only division is guarded by baselineEmpty",
    /const spike = baselineEmpty \|\| recentRate === null \? null : recentRate \/ baselineRate;/.test(src));
  ok("and baselineEmpty covers both an absent baseline and a zero one",
    /const baselineEmpty = baselineRate === null \|\| baselineRate <= 0;/.test(src));
}
{
  const feedMod = await import("./snipe-feed.mjs");
  /* The observer is handed every notification, including the ones that are not launches —
     which is the entire point, since those are the trades. */
  const seen = [];
  const src = feedMod.grpcSubscribeSource({
    id: "t", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    transport: { subscribe: ({ onNotice }) => { queue.push(onNotice); return { unsubscribe() {} }; } },
    extractMint: (n) => (n.mint ? { mint: n.mint } : null),
    observe: (n) => { seen.push(n.tag); if (n.tag === "throws") throw new Error("nope"); },
  });
  const queue = [];
  const emitted = [];
  const handle = src.start({ emit: (r) => emitted.push(r), fail: (e) => emitted.push({ failed: String(e.message) }) });
  const onNotice = queue[0];
  onNotice({ tag: "trade" }, {});
  onNotice({ tag: "create", mint: "So11111111111111111111111111111111111111112" }, {});
  onNotice({ tag: "throws" }, {});
  ok("the observer sees trades AND creates", seen.join(",") === "trade,create,throws", seen.join(","));
  ok("a throwing observer does not fail the source and does not lose the notification",
    !emitted.some((r) => r.failed), JSON.stringify(emitted.map((r) => r.mint ?? "unparsed")));
  ok("the source declares whether it is observing", src.observes === true
    && feedMod.grpcSubscribeSource({ id: "u", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      transport: { subscribe: () => ({ unsubscribe() {} }) }, extractMint: () => null }).observes === false);
  handle.stop();
}
{
  /* END TO END, with the venue's real decoder and no network: a synthetic log line carrying
     a TradeEvent goes through eventsFromLogs into the tap into the tape. This is the path
     the running bot uses, and if the venue's log prefix or the event layout ever moves, this
     is what notices. */
  const venue = await import("./snipe-venue-pumpfun.mjs");
  const tape = createFlowTape();
  const tap = createTradeTap({ tape, tradesFrom: (n) => venue.eventsFromLogs(n?.logs, { kind: "trade" }), clock: () => 1 });
  tap.observe({ logs: ["Program log: Instruction: Buy", "not ours", "Program data: bm90IGJhc2U2NA=="] });
  ok("a log batch with no decodable TradeEvent records nothing and throws nothing",
    tap.stats().recorded === 0 && tap.stats().errors === 0);
  ok("eventsFromLogs is the venue's own export, not a local reimplementation",
    typeof venue.eventsFromLogs === "function" && typeof venue.decodeTradeEvent === "function");
}

console.log("\nACTIVITY: IS ANYBODY TRADING IT NOW (2026-09-27)");
{
  const now = 1_000_000;
  const at = (s, q) => ({ atMs: now - s * 1000, quoteRaw: String(q) });
  ok("the default window is five minutes", DEFAULT_ACTIVITY_MS === 300_000);
  const busy = measureActivity([at(200, 10), at(150, 12), at(100, 11), at(50, 15), at(10, 15)], { nowMs: now });
  ok("each change of the reserve is a trade; a repeat of the same reserve is not", busy.trades === 3, JSON.stringify(busy));
  const flat = measureActivity([at(200, 10), at(100, 10), at(5, 10)], { nowMs: now });
  ok("a coin read three times at the same reserve has had no trades", flat.trades === 0, JSON.stringify(flat));
  const old = measureActivity([at(900, 10), at(800, 20), at(700, 30), at(10, 30)], { nowMs: now });
  ok("trades older than the window do not count", old.trades === 0, JSON.stringify(old));
  const edge = measureActivity([at(400, 10), at(100, 20)], { nowMs: now });
  ok("a change inside the window counts against the sample before it, even one outside", edge.trades === 1);
  ok("no samples is zero trades", measureActivity([], { nowMs: now }).trades === 0);
  ok("no clock is unknown, not zero", measureActivity([at(1, 1)], {}).trades === null);

  const tape = createFlowTape();
  tape.observe("M", { atMs: now - 100_000, quoteRaw: "100" });
  tape.observe("M", { atMs: now - 60_000, quoteRaw: "140" });
  tape.observe("M", { atMs: now - 30_000, quoteRaw: "120" });
  ok("the tape counts a mint's recent trades", tape.activity("M", { nowMs: now }).trades === 2, JSON.stringify(tape.activity("M", { nowMs: now })));
  ok("a mint the tape never saw has had no trades reach this process", tape.activity("NEVER", { nowMs: now }).trades === 0);
}

console.log("\nTHE BOT'S OWN READS MUST NOT EVICT TRADE HISTORY (2026-09-27)");
{
  /* On the owner's Mac the tape sat at its 2,000-mint cap with 6,511 evictions: the lane
     inserted every launch notice it glanced at, and each insert pushed out the least recently
     touched mint — which was real trade history. `onlyIfKnown` and `has()` are the fix. */
  const tape = createFlowTape({ capacity: 4, maxMints: 3, bucketMs: 1, windowMs: 2, baselineMs: 2 });
  ok("has() is false for a mint the tape never saw", tape.has("A") === false);
  for (const m of ["A", "B", "C"]) tape.observe(m, { atMs: 10, quoteRaw: "100" });
  ok("...and true once the trade feed has put it there", tape.has("A") && tape.has("B") && tape.has("C"));
  for (let i = 0; i < 100; i++) {
    const took = tape.observe(`OWN${i}`, { atMs: 20 + i, quoteRaw: "5", onlyIfKnown: true });
    if (took !== null) { ok("an own read of an unknown mint is NOT recorded", false, `OWN${i} -> ${took}`); break; }
  }
  const s = tape.stats();
  ok("a hundred own reads of unknown mints evict nothing", s.evictedMints === 0 && tape.size() === 3,
    `evicted ${s.evictedMints}, size ${tape.size()}`);
  ok("...every trade-fed mint is still held", tape.has("A") && tape.has("B") && tape.has("C"));
  ok("...and every skipped read is COUNTED, not dropped silently", s.skippedUnknown === 100, String(s.skippedUnknown));
  ok("...and none of them is miscounted as a rejected sample", s.rejected === 0, String(s.rejected));
  ok("an own read of a KNOWN mint is recorded — the tape still gets its freshest point",
    tape.observe("A", { atMs: 30, quoteRaw: "120", onlyIfKnown: true }) === 2 && tape.stats().skippedUnknown === 100);
  ok("a junk read is rejected whichever way it was asked",
    tape.observe("ZZ", { atMs: 30, quoteRaw: null, onlyIfKnown: true }) === null && tape.stats().rejected === 1
      && tape.stats().skippedUnknown === 100);
  /* has() is a read, not a touch: asking about B must not save it from the next eviction. */
  const lru = createFlowTape({ capacity: 4, maxMints: 2, bucketMs: 1, windowMs: 2, baselineMs: 2 });
  lru.observe("X", { atMs: 1, quoteRaw: "1" });
  lru.observe("Y", { atMs: 2, quoteRaw: "1" });
  lru.has("X");
  lru.observe("Z", { atMs: 3, quoteRaw: "1" });
  ok("has() does not refresh a mint's place in the LRU order", lru.has("X") === false && lru.has("Y") && lru.has("Z"));
  ok("without the option, observe still inserts as it always has (the trade tap's path)",
    createFlowTape().observe("NEW", { atMs: 1, quoteRaw: "1" }) === 1);
}

console.log("\nTHE TAP KNOWS WHEN IT LAST HEARD ANYTHING (2026-09-27)");
{
  /* The counters froze at 4,748 for nine hours and nothing could tell "the market went quiet"
     from "the stream died". A stamp can. */
  const tape = createFlowTape();
  let clock = 1_000_000;
  const tap = createTradeTap({ tape, clock: () => clock,
    tradesFrom: (n) => (n?.boom ? (() => { throw new Error("bad bytes"); })() : (n?.trades ?? [])) });
  ok("a tap that has heard nothing says so with null, not a zero instant",
    tap.stats().lastNotificationAtMs === null && tap.stats().liveSinceMs === null);
  tap.observe({ trades: [] });
  ok("a notification with no trades still stamps lastNotificationAtMs", tap.stats().lastNotificationAtMs === 1_000_000);
  clock = 1_030_000;
  tap.observe({ boom: true });
  ok("so does one whose bytes do not decode — the wire is up even when the decoder is not",
    tap.stats().lastNotificationAtMs === 1_030_000 && tap.stats().errors === 1);
  ok("the run that began at the first notification is unbroken by a 30s gap", tap.stats().liveSinceMs === 1_000_000);
  clock = 1_030_000 + TRADE_FEED_STALE_MS + 1;
  tap.observe({ trades: [] });
  ok("a silence longer than the gap starts a NEW run — the tape's coverage restarts with it",
    tap.stats().liveSinceMs === clock && tap.stats().lastNotificationAtMs === clock, JSON.stringify({ since: tap.stats().liveSinceMs }));
  ok("the gap is sixty seconds, stated once", TRADE_FEED_STALE_MS === 60_000 && tap.stats().gapMs === 60_000);
  ok("a non-positive gap is refused at construction",
    threw(() => createTradeTap({ tape, tradesFrom: () => [], gapMs: 0 })) !== null);
}
{
  const NOW = 50_000_000;
  /* The feed's WHOLE verdict on the gRPC source, shaped as classifySource shapes it:
     subscribed ten minutes ago, first frame a second later, last frame a second ago. */
  const src = (over = {}) => ({ state: "live", startedAtMs: NOW - 600_000, firstNoticeAtMs: NOW - 599_000,
    lastNoticeAtMs: NOW - 1_000, ...over });
  const base = { source: src(), lastNotificationAtMs: NOW - 1_000, liveSinceMs: NOW - 400_000, nowMs: NOW };
  const live = tradeFeedStatus(base);
  ok("a live source with a fresh stamp is live, since the start of its run",
    live.live === true && live.sinceMs === NOW - 400_000 && live.reason === null, JSON.stringify(live));
  ok("a DEAD source is down even with a fresh stamp — the feed's verdict is half the answer",
    tradeFeedStatus({ ...base, source: src({ state: "dead" }) }).live === false
      && tradeFeedStatus({ ...base, source: src({ state: "dead" }) }).reason === "source_dead");
  ok("so is a DEGRADED one — an errored stream, before any watchdog has acted",
    tradeFeedStatus({ ...base, source: src({ state: "degraded" }) }).reason === "source_degraded");
  ok("the state word alone is not an answer: a caller passing only sourceState gets down, by name",
    tradeFeedStatus({ sourceState: "live", lastNotificationAtMs: NOW - 1_000, nowMs: NOW }).reason === "source_missing");
  ok("a tap that has never heard anything is down",
    tradeFeedStatus({ ...base, lastNotificationAtMs: null }).reason === "no_notification");

  /* THE RESTART, which the state word lies about. Resubscribed ten seconds ago, nothing on
     the new subscription yet — and the tap's last stamp is from the stream that died
     twenty-five seconds ago, well inside the minute. */
  const fresh = src({ startedAtMs: NOW - 10_000, firstNoticeAtMs: null, lastNoticeAtMs: null });
  const empty = tradeFeedStatus({ ...base, source: fresh, lastNotificationAtMs: NOW - 25_000 });
  ok("a restarted subscription that has delivered nothing is DOWN, though the feed says live and the tap heard something 25s ago",
    empty.live === false && empty.reason === "no_notification_since_subscribe" && empty.subscribedAtMs === NOW - 10_000,
    JSON.stringify(empty));
  ok("...and a late frame from the RETIRED subscription (a tap stamp after the restart, no firstNoticeAtMs) does not change that",
    tradeFeedStatus({ ...base, source: fresh, lastNotificationAtMs: NOW - 2_000 }).reason === "no_notification_since_subscribe");
  ok("a verdict with no start stamp cannot say which subscription it describes: down",
    tradeFeedStatus({ ...base, source: src({ startedAtMs: null }) }).reason === "no_notification_since_subscribe");
  /* Once the new subscription delivers, coverage starts THERE — not at the tap's run start,
     which a 25-second hole never broke. */
  const back = tradeFeedStatus({ ...base, source: src({ startedAtMs: NOW - 10_000, firstNoticeAtMs: NOW - 5_000 }),
    liveSinceMs: NOW - 900_000 });
  ok("...once it delivers it is live, covered from ITS first notice, not from the run before the hole",
    back.live === true && back.sinceMs === NOW - 5_000, JSON.stringify(back));

  ok("exactly sixty seconds of silence is still live…",
    tradeFeedStatus({ ...base, lastNotificationAtMs: NOW - 60_000 }).live === true);
  const stale = tradeFeedStatus({ ...base, lastNotificationAtMs: NOW - 60_001 });
  ok("…and one millisecond more is down, with the silence said", stale.live === false && stale.reason === "silent" && stale.silentMs === 60_001);
  ok("silence is judged on the OLDER of the two stamps: a feed that stopped hearing is down whatever the tap says",
    tradeFeedStatus({ ...base, source: src({ lastNoticeAtMs: NOW - 61_000 }) }).reason === "silent");
  ok("no source at all is down, by name", tradeFeedStatus({ ...base, source: null }).reason === "source_missing");
  ok("no clock is down, never assumed live", tradeFeedStatus({ ...base, nowMs: undefined }).live === false);
  ok("down never carries a since", stale.sinceMs === null && empty.sinceMs === null);
}

console.log("\nA REAL FEED, TAP AND WATCHDOG THROUGH A RESTART (2026-09-27)");
{
  /* The reproduction the rule above exists for, with the real modules over a fake transport:
     ten notifications, the stream ends with an error, the watchdog resubscribes 15s later —
     and then NOTHING arrives on the new subscription. Before the fix this read
     `tradeFeedLive true` at +30s and +40s (the feed said live, the tap's stamp was the dead
     stream's) and only went down at +61s. */
  let T = 60_000_000;
  const clock = () => T;
  const t = { handlers: [], subscribes: 0,
    subscribe({ onNotice, onError }) {
      t.subscribes++;
      const h = { onNotice, onError };
      t.handlers.push(h);
      return { unsubscribe() { t.handlers = t.handlers.filter((x) => x !== h); } };
    },
    push(n) { for (const h of [...t.handlers]) h.onNotice(n, { slot: 1 }); },
    breakIt(m) { for (const h of [...t.handlers]) h.onError(new Error(m)); },
  };
  const tape = createFlowTape();
  const tap = createTradeTap({ tape, clock, tradesFrom: (n) => n?.trades ?? [] });
  const feed = createSnipeFeed({
    sources: [grpcSubscribeSource({ id: "grpc:pumpfun", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      transport: t, extractMint: () => null, observe: (n) => tap.observe(n) })],
    clock, schedule: () => 0, cancel: () => {},
  });
  const wd = createSourceWatchdog({ feed, sourceId: "grpc:pumpfun", setIntervalFn: () => ({}), clearIntervalFn: () => {},
    ...GRPC_WATCHDOG });
  const status = () => {
    const s = tap.stats();
    return tradeFeedStatus({ source: feed.health(T).sources[0], lastNotificationAtMs: s.lastNotificationAtMs,
      liveSinceMs: s.liveSinceMs, nowMs: T });
  };
  await feed.start();
  const t0 = T;
  for (let i = 0; i < 10; i++) { T = t0 + 1_000 + i * 1_000; t.push({ trades: [] }); }
  const runStart = tap.stats().liveSinceMs;
  ok("a delivering stream is live, covered from its first notification", status().live === true && status().sinceMs === t0 + 1_000,
    JSON.stringify(status()));
  const retired = t.handlers[0];
  T = t0 + 10_000; t.breakIt("gRPC stream ended");
  ok("the stream ends with an error: down at once (the feed calls it degraded)", status().reason === "source_degraded");
  T = t0 + 25_000;
  const tick = await wd.tick();
  ok("the watchdog resubscribes it 15s later", tick.restarts === 1 && tick.lastRestartOk === true && t.subscribes === 2,
    `restarts ${tick.restarts}, subscribes ${t.subscribes}`);
  ok("...and the feed now reads the source live — the word the old check trusted",
    feed.health(T).sources[0].state === "live");
  const results = [];
  for (const at of [26_000, 40_000, 50_000, 60_000]) {
    T = t0 + at;
    if (at === 40_000) retired.onNotice({ trades: [] }, { slot: 2 });   // one late frame from the dead socket
    results.push(`${at / 1000}s:${status().live ? "LIVE" : status().reason}`);
  }
  ok("with nothing on the new subscription it stays DOWN at +26s, +40s, +50s, +60s — even after a stale frame stamps the tap",
    results.every((r) => /no_notification_since_subscribe$/.test(r)), results.join(" "));
  T = t0 + 62_000; t.push({ trades: [] });
  T = t0 + 70_000;
  const up = status();
  ok("the new subscription's first frame makes it live — covered from THAT frame, not from the run before the 52s hole",
    up.live === true && up.sinceMs === t0 + 62_000 && tap.stats().liveSinceMs === runStart, JSON.stringify(up));
  await feed.stop();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-volume  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
