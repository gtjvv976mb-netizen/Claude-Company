/**
 * THE IGNITION LANE — the ruler before the measurement.
 *
 * Every number this lane produces decides which coins the expensive desk looks at
 * first, so each one is checked here against a tape whose answer is already known by
 * hand. The lane itself makes no model call and no trade; its failure mode is not a
 * loss, it is looking at the wrong coins all day while believing otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { CAP_BANDS } from "./src/categories.js";
import { asCandidate, bandOf, momentumFrom } from "./src/data/pumpfun-live.js";
import { ignitionScore, shortlist, attentionOf, huntWindowMs } from "./src/ignition.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const NOW = 1_788_400_000_000;
const MIN = 60_000;

/** A tape with known answers: 20 flat minutes at $1, then a clean climb to $2. */
const tape = (closes, volumes = null) => closes.map((close, i) => ({
  ts: NOW - (closes.length - 1 - i) * MIN, open: close, high: close, low: close, close,
  volume: volumes ? volumes[i] : 100,
}));

console.log("\nTHE MOMENTUM RULER SAYS WHAT A PERSON WOULD SAY");
{
  // 31 minutes: 1.00 held for 25, then +10% a minute for five, ending at 1.61.
  const closes = [...Array(26).fill(1), 1.1, 1.21, 1.331, 1.4641, 1.61051];
  const m = momentumFrom(tape(closes));
  ok("a 61% five-minute climb reads as 61%", Math.abs(m.pct5m - 61.051) < 0.01, `${m.pct5m.toFixed(3)}%`);
  ok("...and the same over fifteen, because nothing moved before it",
    Math.abs(m.pct15m - 61.051) < 0.01, `${m.pct15m.toFixed(3)}%`);
  ok("a flat tape reads as zero, not as noise", momentumFrom(tape(Array(30).fill(1))).pct5m === 0);
  ok("the tape length is reported honestly", m.candles === 31 && m.coverageMins === 30,
    `${m.candles} candles over ${m.coverageMins} minutes`);
  ok("the drawdown from the high is zero at the high", Math.abs(m.drawdownFromHighPct) < 1e-9);
  const off = momentumFrom(tape([1, 1, 1, 2, 2, 2, 1.5]));
  ok("a coin 25% off its high says so", Math.abs(off.drawdownFromHighPct + 25) < 0.01,
    `${off.drawdownFromHighPct.toFixed(1)}%`);
}

console.log("\nVOLUME ACCELERATION COMPARES LIKE WITH LIKE");
{
  /* The prior window is TEN minutes and the recent one is FIVE. Summing both and
   * dividing would report every steady tape as accelerating 2x — a ruler that says
   * "rising" about a market doing nothing at all. It is halved for that reason. */
  const steady = momentumFrom(tape(Array(20).fill(1), Array(20).fill(100)));
  ok("a steady tape accelerates exactly 1.00x", Math.abs(steady.volAccel - 1) < 1e-9,
    `${steady.volAccel.toFixed(4)}x`);
  const doubled = momentumFrom(tape(Array(20).fill(1),
    [...Array(15).fill(100), ...Array(5).fill(200)]));
  ok("a genuine doubling reads as 2.00x", Math.abs(doubled.volAccel - 2) < 1e-9,
    `${doubled.volAccel.toFixed(4)}x`);
  const fromNothing = momentumFrom(tape(Array(20).fill(1),
    [...Array(15).fill(0), ...Array(5).fill(500)]));
  ok("a standing start has no ratio, and does not claim one", fromNothing.volAccel === null);
  ok("...but its volume is still counted", fromNothing.vol5mUsd === 2500);
  ok("too short a tape says nothing at all", momentumFrom(tape([1, 2])) === null);
  ok("an empty tape says nothing at all", momentumFrom([]) === null && momentumFrom(null) === null);
}

console.log("\nA \u201c1m\u201d CANDLE IS NOT A MINUTE");
{
  /* THE CASE EVERY TEST ABOVE MISSED. Each tape above has one candle per minute, which
   * is the one shape pump.fun never returns: it emits a row only for a minute that
   * traded. Measured on eight live coins, the span of the last five candles ran from 4
   * minutes to 2,665 — so the old ruler, which summed the last five ROWS and called it
   * five minutes, reported forty-four hours of trickle as a busy five minutes. The
   * sparser the tape, the bigger the number: it rewarded exactly the inactivity it
   * existed to detect. Every assertion here is on a gapped tape. */
  const at = (minsAgo, close, volume) => ({ ts: NOW - minsAgo * MIN, open: close, high: close,
    low: close, close, volume });
  // Six rows spanning three hours. Only the last two are inside a five-minute window.
  const sparse = [
    at(180, 1, 900), at(120, 1, 900), at(60, 1, 900),
    at(30, 1, 900), at(4, 1, 40), at(0, 1.2, 60),
  ];
  const m = momentumFrom(sparse);
  ok("only the volume inside the five minutes is counted", m.vol5mUsd === 100,
    `$${m.vol5mUsd} (row count would have said $${900 + 900 + 900 + 40 + 60})`);
  ok("the tape reports the span it truly covers", m.coverageMins === 180, `${m.coverageMins} min`);
  ok("six rows are six rows, not six minutes", m.candles === 6);
  ok("the five-minute change is measured from five minutes ago", Math.abs(m.pct5m - 20) < 1e-9,
    `${m.pct5m}%`);
  // Nothing printed between 30 and 15 minutes ago, so the prior window is genuinely empty.
  ok("an empty prior window claims no ratio", m.volAccel === null);

  /* A tape that stops an hour before you read it has no five-minute reading, and the
     old code would have handed one over from whatever its last five rows happened to
     be. Staleness is only knowable against a clock, so it is null until one is given. */
  const stale = momentumFrom(sparse, { now: NOW + 90 * MIN });
  ok("a tape read 90 minutes later says so", stale.stalenessMins === 90, `${stale.stalenessMins} min`);
  ok("...and reports no volume in the last five minutes", stale.vol5mUsd === 0);
  ok("without a clock, staleness is unknown rather than zero", m.stalenessMins === null);

  // A dense tape must still give exactly the answers it always gave.
  const dense = momentumFrom(tape([...Array(15).fill(1), ...Array(5).fill(2)],
    [...Array(15).fill(100), ...Array(5).fill(200)]));
  ok("a one-per-minute tape is unchanged: 2.00x acceleration", Math.abs(dense.volAccel - 2) < 1e-9,
    `${dense.volAccel.toFixed(4)}x`);
  ok("...and a 100% five-minute move", Math.abs(dense.pct5m - 100) < 1e-9, `${dense.pct5m}%`);
}

console.log("\nBANDS COME FROM THE MARKET CAP, NEVER FROM A GUESS");
for (const [band, b] of Object.entries(CAP_BANDS)) {
  ok(`${band} claims its own floor`, bandOf(b.lo) === band, `$${b.lo.toLocaleString()}`);
  ok(`${band} does not claim its ceiling`, bandOf(b.hi) !== band);
}
/* DERIVED FROM CAP_BANDS. These were 4_999 and 10_000_001, chosen when the board ran
   $5k-$10m. The owner's 2026-09-07 widening moved it to $1k-$50m and both literals fell
   INSIDE the board, so each assertion silently stopped testing an edge. */
const BOARD_LO = Math.min(...Object.values(CAP_BANDS).map((b) => b.lo));
const BOARD_HI = Math.max(...Object.values(CAP_BANDS).map((b) => b.hi));
ok("below the board is not a band", bandOf(BOARD_LO - 1) === null, `$${(BOARD_LO - 1).toLocaleString()}`);
ok("above the board is not a band", bandOf(BOARD_HI + 1) === null, `$${(BOARD_HI + 1).toLocaleString()}`);
ok("an unreadable cap is not a band", bandOf(null) === null && bandOf(0) === null && bandOf("soon") === null);

console.log("\nONE COIN, READ THE WAY THE REST OF THE DESK READS COINS");
{
  const coin = (over = {}) => ({
    mint: "M1", symbol: "TEST", name: "Test Coin", creator: "C1",
    created_timestamp: NOW - 6 * MIN, last_trade_timestamp: NOW - MIN,
    usd_market_cap: 30_000, total_supply: 1_000_000_000_000_000,
    real_sol_reserves: 30 * 1e9, complete: false, reply_count: 12,
    ath_market_cap: 45_000, image_uri: "http://i", ...over,
  });
  const c = asCandidate(coin(), { solUsd: 100, now: NOW });
  ok("the launchpad is not inferred, it is known", c.launchpad === "pump.fun");
  ok("the band is the micro sleeve", c.live.band === "micro", `${c.live.band} at $30,000`);
  ok("the curve's SOL is priced as both sides of the book", c.pair.liquidityUsd === 6_000,
    `$${c.pair.liquidityUsd.toLocaleString()} from 30 SOL`);
  ok("age is in hours, from the creation stamp", Math.abs(c.pair.ageHours - 0.1) < 0.01, `${c.pair.ageHours}h`);
  // $30,000 of cap over a billion circulating tokens is three hundredths of a cent.
  ok("price comes from cap over supply", Math.abs(c.pair.priceUsd - 0.00003) < 1e-12, `$${c.pair.priceUsd}`);

  /* A GRADUATED COIN HAS AN EMPTY CURVE, NOT AN EMPTY BOOK. Reporting the drained
     reserve as $0 would describe every graduated coin as unsellable, which is the one
     condition the screen treats as fatal. */
  const grad = asCandidate(coin({ complete: true, real_sol_reserves: 0 }), { solUsd: 100, now: NOW });
  ok("a graduated coin reports unknown liquidity, never zero", grad.pair.liquidityUsd === null);
  ok("...and is marked graduated", grad.live.graduated === true && grad.onCurve === false);

  // A seconds epoch read as milliseconds makes a coin born today look 1.6 years old.
  const secs = asCandidate(coin({ created_timestamp: Math.floor((NOW - 6 * MIN) / 1000) }), { solUsd: 100, now: NOW });
  ok("a seconds timestamp is not read as 1970", Math.abs(secs.pair.ageHours - 0.1) < 0.01, `${secs.pair.ageHours}h`);
  ok("no market cap means no band, and no invented one",
    asCandidate(coin({ usd_market_cap: null }), { solUsd: 100, now: NOW }).live.band === null);
  ok("no SOL price means unknown liquidity, not zero",
    asCandidate(coin(), { now: NOW }).pair.liquidityUsd === null);
}

console.log("\nTHE SHORTLIST SPENDS ATTENTION, AND ONLY ATTENTION");
{
  const make = (over = {}) => asCandidate({
    mint: over.mint || "M" + Math.random(), symbol: over.symbol || "S", name: "n", creator: "c",
    created_timestamp: NOW - (over.ageMin ?? 5) * MIN,
    last_trade_timestamp: NOW - (over.lastTradeMin ?? 1) * MIN,
    usd_market_cap: over.mcap ?? 30_000, total_supply: 1e15,
    real_sol_reserves: 30 * 1e9, complete: false, reply_count: over.replies ?? 0,
    ath_market_cap: over.ath ?? 30_000, is_banned: over.banned ?? false,
  }, { solUsd: 100, now: NOW });

  const live = make({ mint: "LIVE" });
  const picked = shortlist([
    live,
    make({ mint: "BANNED", banned: true }),
    make({ mint: "OFFBOARD", mcap: BOARD_LO - 1 }),   // derived: $2,000 is ON the board since the $1k widening
    make({ mint: "STALE", lastTradeMin: 45 }),
    make({ mint: "ANCIENT", mcap: 8_000, ageMin: 60 * 24 * 30 }),
  ], { now: NOW, limit: 10 });
  const mints = picked.map((p) => p.mint);
  ok("a live in-band coin is shortlisted", mints.includes("LIVE"));
  ok("a banned coin is not", !mints.includes("BANNED"));
  ok("a coin off the board is not", !mints.includes("OFFBOARD"));
  ok("a coin nobody has traded in 45 minutes is not", !mints.includes("STALE"));
  ok("a month-old nano coin is not — that move is long over", !mints.includes("ANCIENT"));

  // Youth is the whole point of the lane, so it must actually win the ordering.
  const order = shortlist([make({ mint: "OLD", ageMin: 300 }), make({ mint: "YOUNG", ageMin: 2 })],
    { now: NOW, limit: 10 }).map((p) => p.mint);
  ok("the younger coin is looked at first", order[0] === "YOUNG", order.join(" > "));
  ok("the shortlist honours its limit", shortlist(Array.from({ length: 50 }, (_, i) =>
    make({ mint: "X" + i })), { now: NOW, limit: 7 }).length === 7);
}

console.log("\nTHE SCORE PREFERS A REAL MOVE TO A CHART ARTEFACT");
{
  const real = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(1), 1.1, 1.2, 1.3, 1.4, 1.5],
    [...Array(15).fill(200), ...Array(11).fill(400), ...Array(5).fill(9_000)])), { band: "micro" });
  const artefact = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(1), 2, 4, 6, 8, 10], Array(31).fill(3))), { band: "nano" });
  ok("a 50% move on real volume outscores a 900% move on nothing",
    real.score > artefact.score, `${real.score} vs ${artefact.score}`);
  ok("the artefact is told it traded nothing",
    artefact.reasons.some((r) => /traded in five minutes/.test(r)), artefact.reasons.join(" · "));
  ok("the real move is told its volume accelerated",
    real.reasons.some((r) => /volume .*x its prior/.test(r)), real.reasons.join(" · "));

  const dumping = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(2), 1.9, 1.8, 1.7, 1.6, 1.5], Array(31).fill(5_000))), { band: "micro" });
  ok("a coin falling on volume scores below zero", dumping.score < 0, `${dumping.score}`);
  ok("a coin with no tape has no score", ignitionScore(null) === null);
  ok("the band travels with the score", real.band === "micro");
}

console.log("\nTHE CURVE IS THE ONE FREE EARLY SIGNAL — attention reads it (step 13)");
{
  /* Fixtures in the feed's own units, solved from pump.fun's constant product exactly as
     test-pumpfun-curve.mjs works them by hand: a standard curve opens at vSol 30 / vTok
     1073M with 279.9M held back, so k = 30e9 * 1073e12 and the graduation total is
     30*1073/279.9 - 30 = 85.005 SOL however much is already in. With `realSol` SOL in,
     vSol = 30 + realSol, vTok = k / vSol, realTok = vTok - held; progressSol is then
     realSol / 85.005. The ruler is checked against that hand figure before it is used. */
  const SOLL = 1e9, M = 1e12, HELD = 279.9 * M;
  const curveAt = (realSol, { vSol0 = 30, vTok0 = 1073 } = {}) => {
    const k = vSol0 * SOLL * vTok0 * M;
    const vSol = (vSol0 + realSol) * SOLL;
    const vTok = k / vSol;
    return { virtual_sol_reserves: vSol, virtual_token_reserves: vTok,
      real_sol_reserves: realSol * SOLL, real_token_reserves: vTok - HELD };
  };
  const STANDARD_TOTAL = 30 * 1073 / 279.9 - 30;          // 85.005 SOL
  const MINI = { vSol0: 3.75, vTok0: 1097.1 };             // the mini row test-pumpfun-curve.mjs measures
  const MINI_TOTAL = 3.75 * 1097.1 / 279.9 - 3.75;         // 10.948 SOL
  // Nano by cap ($12k) so the hunt window is the shortest on the board: 30 min x 12 = 6h.
  const make = (over = {}) => asCandidate({
    mint: over.mint ?? "M" + Math.random(), symbol: over.mint ?? "S", name: "n", creator: "c",
    created_timestamp: NOW - (over.ageMin ?? 9) * MIN,
    last_trade_timestamp: NOW - MIN,
    usd_market_cap: over.mcap ?? 12_000, total_supply: 1e15, complete: false,
    reply_count: over.replies ?? 0,
    ath_market_cap: over.ath ?? (over.mcap ?? 12_000),
    ath_market_cap_timestamp: over.athMin != null ? NOW - over.athMin * MIN : null,
    ...(over.realSol != null ? curveAt(over.realSol, over.curve) : {}),
  }, { solUsd: 100, now: NOW });
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const att = (c) => attentionOf(c, { now: NOW });
  const order = (cs) => shortlist(cs, { now: NOW, limit: 10 }).map((c) => c.mint);

  const nine = make({ mint: "NINE", ageMin: 9, realSol: 0.55 * STANDARD_TOTAL });
  ok("the ruler: 46.75 SOL in on a standard curve reads 55.00% of 85.005",
    Math.abs(nine.live.progressSol - 0.55) < 1e-9 && Math.abs(nine.live.gradSolTotal - STANDARD_TOTAL) < 1e-6,
    `${pct(nine.live.progressSol)} of ${nine.live.gradSolTotal.toFixed(3)} SOL`);

  /* THE PLAN'S CASE, AS STATED: a 9-minute coin at 55% against a 141-hour coin at 3%,
     equal replies. Note what actually decides it — the 141-hour nano coin is outside the
     six-hour hunt window (ignition.js huntWindowMs) and never reaches attention at all.
     It ranks below by absence; the attention numbers are printed anyway. */
  const old = make({ mint: "OLD141", ageMin: 141 * 60, realSol: 0.03 * STANDARD_TOTAL });
  const o1 = order([old, nine]);
  ok("a 9-minute coin at 55% of its curve ranks above a 141-hour coin at 3%, equal replies",
    o1[0] === "NINE" && o1.indexOf("OLD141") !== 0 && att(nine).attention > att(old).attention,
    `order ${o1.join(" > ") || "(none)"} · NINE ${att(nine).attention.toFixed(3)} vs OLD141 ${att(old).attention.toFixed(3)}` +
    ` · OLD141 is ${(141 * 60 * MIN / huntWindowMs("nano")).toFixed(1)}x the nano hunt window, so it is not shortlisted at all`);

  // THE DISCRIMINATING CASE: same age, same replies, same high — only the curve differs.
  const half = make({ mint: "HALF55", realSol: 0.55 * STANDARD_TOTAL });
  const thin = make({ mint: "THREE", realSol: 0.03 * STANDARD_TOTAL });
  const o2 = order([thin, half]);
  ok("at EQUAL age the coin further along its curve is looked at first", o2[0] === "HALF55",
    `${o2.join(" > ")} · ${att(half).attention.toFixed(3)} vs ${att(thin).attention.toFixed(3)}`);
  ok("half the curve earns the whole point; three percent earns six hundredths",
    att(half).curve === 1 && Math.abs(att(thin).curve - 0.06) < 1e-9,
    `curve terms ${att(half).curve} and ${att(thin).curve.toFixed(4)}`);
  const quarter = make({ mint: "Q", realSol: 0.25 * STANDARD_TOTAL });
  ok("a quarter of the curve earns half a point", Math.abs(att(quarter).curve - 0.5) < 1e-9, `${att(quarter).curve}`);
  ok("past half the point is capped, not compounded",
    att(make({ mint: "N", realSol: 0.9 * STANDARD_TOTAL })).curve === 1);
  const bare = make({ mint: "NOCURVE" });
  ok("no readable curve is no bonus, never a penalty", bare.live.progressSol === null && att(bare).curve === 0,
    `progressSol=${bare.live.progressSol} curve term=${att(bare).curve}`);

  // THE LATE LOOK: under half the high, and the high is more than twenty minutes old.
  const staleDip = make({ mint: "STALEDIP", ath: 12_000 / 0.45, athMin: 25 });
  const freshDip = make({ mint: "FRESHDIP", ath: 12_000 / 0.45, athMin: 5 });
  ok("the ruler: both dips sit at 45% of their high", Math.abs(staleDip.live.athRatio - 0.45) < 1e-9
    && Math.abs(freshDip.live.athRatio - 0.45) < 1e-9, `athRatio ${staleDip.live.athRatio.toFixed(3)}`);
  ok("45% of a high set 25 minutes ago is a late look: half a point off",
    att(staleDip).lateLook === 0.5 && Math.abs(att(freshDip).attention - att(staleDip).attention - 0.5) < 1e-9,
    `stale ${att(staleDip).attention.toFixed(3)} vs fresh ${att(freshDip).attention.toFixed(3)} (nearHigh ${att(staleDip).nearHigh.toFixed(2)} on both)`);
  ok("the same drawdown off a 5-minute-old high is a dip, not a late look", att(freshDip).lateLook === 0);
  ok("55% of a stale high is not a late look either",
    att(make({ mint: "MILD", ath: 12_000 / 0.55, athMin: 25 })).lateLook === 0);
  ok("a stale high with no timestamp cannot be called late", att(make({ mint: "NOSTAMP", ath: 12_000 / 0.45 })).lateLook === 0);
  ok("the fresh dip is looked at before the stale one", order([staleDip, freshDip])[0] === "FRESHDIP",
    order([staleDip, freshDip]).join(" > "));

  // MINI CURVES: a lottery ticket that fills in one buy, unless it is already most of the way.
  const miniHalf = make({ mint: "MINI50", realSol: 0.5 * MINI_TOTAL, curve: MINI });
  const miniLate = make({ mint: "MINI85", realSol: 0.85 * MINI_TOTAL, curve: MINI });
  ok("the ruler: the mini fixture is classed mini and owes ~10.95 SOL in total",
    miniHalf.live.curveClass === "mini" && Math.abs(miniHalf.live.gradSolTotal - MINI_TOTAL) < 1e-6
    && Math.abs(miniLate.live.progressSol - 0.85) < 1e-9,
    `${miniHalf.live.curveClass}, ${miniHalf.live.gradSolTotal.toFixed(3)} SOL, MINI85 at ${pct(miniLate.live.progressSol)}`);
  const o3 = order([miniHalf, miniLate, half]);
  ok("a mini curve half filled is not shortlisted", !o3.includes("MINI50"), o3.join(", "));
  ok("...one 85% along is", o3.includes("MINI85"));
  ok("...and a standard curve at 55% is untouched by the rule", o3.includes("HALF55"));
}

console.log("\nSOL ENTERING THE CURVE LIFTS THE SCORE — bounded, and only with a prior reading");
{
  const mo = momentumFrom(tape(
    [...Array(26).fill(1), 1.1, 1.2, 1.3, 1.4, 1.5],
    [...Array(15).fill(200), ...Array(11).fill(400), ...Array(5).fill(9_000)]));
  const base = ignitionScore(mo, { band: "micro" }).score;
  // Whole numbers on purpose: 4.25 of 85 is exactly 5.00% a minute, 17 of 85 exactly 20.
  const at = (curveVelocity, gradSolTotal = 85) =>
    ignitionScore(mo, { band: "micro", curveVelocity, gradSolTotal });
  ok("4.25 SOL a minute on an 85-SOL curve is 5.00% a minute: +5", at(4.25).score - base === 5,
    `${base} -> ${at(4.25).score}`);
  ok("...and it says so in words", at(4.25).reasons.some((r) => /curve filling 5\.00% a minute/.test(r)),
    at(4.25).reasons.at(-1));
  ok("17 SOL a minute is the cap: +20", at(17).score - base === 20, `${base} -> ${at(17).score}`);
  ok("25 SOL a minute is still +20 — the term lifts, it never carries", at(25).score - base === 20,
    `${base} -> ${at(25).score}`);
  ok("SOL leaving the curve is clamped to 0, not penalised twice", at(-3).score === base && !at(-3).reasons.some((r) => /curve/.test(r)),
    `${base} -> ${at(-3).score}`);
  ok("a first sighting (no prior reading) scores exactly as before", at(null).score === base
    && ignitionScore(mo, { band: "micro" }).score === base, `${at(null).score}`);
  ok("a velocity without a curve total adds nothing", at(4.25, null).score === base, `${at(4.25, null).score}`);
  ok("a boosted 300-SOL curve needs proportionally more: 4.25 SOL a minute is +1",
    at(4.25, 300).score - base === Math.round(4.25 / 300 * 100), `${base} -> ${at(4.25, 300).score}`);

  /* The reading comes from the funnel and the funnel is a database; this lane must not
     grow one (evidence.js imports it for huntWindowMs). So the cycle LENDS the lookup. */
  const penthouse = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  const ignition = fs.readFileSync(new URL("./src/ignition.js", import.meta.url), "utf8");
  ok("the cycle lends the sweep the funnel's velocity", /ignitionSweep\(\{[^}]*curveVelocityOf: funnel\.curveVelocity/.test(penthouse),
    (penthouse.match(/ignitionSweep\(\{[^}]*\}\)/) || ["not found"])[0]);
  // Import STATEMENTS only: the comments above are allowed to name funnel.js, the code is not.
  const dbImports = ignition.split("\n").filter((l) => /^import\b/.test(l) && /funnel\.js|node:sqlite|lib\/store/.test(l));
  ok("...and ignition.js itself still imports no database", dbImports.length === 0,
    dbImports.length ? dbImports.join(" | ") : `${ignition.split("\n").filter((l) => /^import\b/.test(l)).length} imports, none of them the funnel, sqlite or the store`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
