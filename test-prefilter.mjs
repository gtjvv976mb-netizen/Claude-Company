/**
 * THE CYCLE WAS SPENDING ITS SLOTS ON COINS IT WAS ALWAYS GOING TO REFUSE.
 *
 * Eight consecutive cycles, read straight off production:
 *
 *   studied=2 eligible=0   studied=3 eligible=0   studied=1 eligible=0   ...
 *
 * Not one eligible candidate, ever. The cohort step was running fine — it had nothing
 * to choose from, because the three workup slots had been filled by rank() alone, and
 * rank() rewards depth and momentum while the screen kills on thresholds rank knows
 * nothing about. Every slot went to a coin that died at the first free gate.
 *
 * The fresh lane has pre-filtered like this since its first champion died of
 * thin_liquidity. The cycle never learned. This is that lesson, applied.
 */
import { wouldSurviveScreen, selectShortlist } from "./src/penthouse.js";
import { cfg, floorsFor } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const s = cfg.screen;

/* The floors are band-relative now, so the test coin's own band decides its bar. The
 * fixture used to build an $800k coin and assert it against the FLAT config numbers,
 * which quietly became a different claim the moment floors started scaling: $14,999 of
 * volume is under the old flat $15,000 and comfortably over the $12,000 the medium band
 * actually asks for. The test was right to fail — it was asserting a floor that no
 * longer applies to the coin it built. */
const F = floorsFor(800_000);

/* JUST OVER THE CAP CEILING, DERIVED — never written as a literal again.
 * The screen's ceiling moved $10m -> $50m on 2026-09-07 when the owner opened the
 * screens up, and two fixtures below had been written as literals against the old
 * number ($40m for BIGCAP, $50m for the contradiction coin). Both then sailed through
 * the screen, so both tests were asserting nothing at all — the same failure mode the
 * band-floor note above records. Derived from the live ceiling, they keep proving
 * "the screen refuses a coin too big to re-rate" wherever that ceiling next lands.
 * NOTE this is the ceiling only: no safety gate moved, and none is relaxed here. */
const OVER_CAP = (s.maxMarketCapUsd || 3e6) + 1;

const coin = (over = {}) => ({
  mint: "m" + Math.round(Math.abs(over.score ?? 1) * 1e6), category: "memecoin",
  score: over.score ?? 50,
  pair: {
    baseSymbol: over.sym ?? "T",
    liquidityUsd: over.liq ?? F.liq * 3,
    volume: { h24: over.vol ?? F.vol * 3 },
    txns: { h24: { buys: over.tx ?? F.txns * 2, sells: 0 } },
    marketCap: over.mcap ?? 800_000,
    ageHours: over.age ?? 48,
  },
  // The launch feed's shape (pumpfun-live.js asCandidate): the curve and the high ride
  // on `live`, graduation on `onCurve`, the minute tape on `momentum`. Absent by default,
  // exactly as a DexScreener row arrives.
  ...(over.onCurve !== undefined ? { onCurve: over.onCurve } : {}),
  ...(over.live ? { live: over.live } : {}),
  ...(over.momentum ? { momentum: over.momentum } : {}),
});

console.log(`\nTHE FREE SCREEN, APPLIED BEFORE PAYING (band floors for an $800k coin: liq $${F.liq.toLocaleString()}, vol $${F.vol.toLocaleString()}, txns ${F.txns}, cap $${(s.maxMarketCapUsd||0).toLocaleString()})`);
ok("a healthy micro-cap survives", wouldSurviveScreen(coin()) === null);
for (const [label, over, code] of [
  ["a pool too thin to exit",      { liq: F.liq - 1 },   "thin_liquidity"],
  ["a coin nobody is trading",     { vol: F.vol - 1 },   "no_volume"],
  ["almost no participants",       { tx: F.txns - 1 },   "no_participants"],
  ["too big to re-rate",           { mcap: OVER_CAP },             "too_big"],
  ["minutes old",                  { age: F.ageH / 2 },            "too_new"],
  ["turnover implausible for depth", { vol: F.liq * 3 * (s.maxVolToLiqRatio + 5) }, "wash_suspect"],
]) ok(`${label} is dropped BEFORE a workup is paid for`, wouldSurviveScreen(coin(over)) === code,
      wouldSurviveScreen(coin(over)) ?? "survived");

console.log("\nTHE SLOTS NOW GO TO COINS THAT CAN REACH A SEAT");
// The production shape: a handful of high-ranked coins that the screen kills, and one
// quiet survivor ranked below them. The old code spent all three slots on the corpses.
const market = [
  coin({ sym: "BIGCAP", score: 95, mcap: OVER_CAP }),   // was a $40m literal, under today's ceiling
  coin({ sym: "DEAD",   score: 90, vol: 10 }),
  coin({ sym: "THIN",   score: 88, liq: 500 }),
  coin({ sym: "QUIET",  score: 40 }),
];
const picked = selectShortlist(market, 3);
const syms = picked.map((c) => c.pair.baseSymbol);
ok("the three top-ranked corpses are not bought", !syms.includes("BIGCAP") && !syms.includes("DEAD") && !syms.includes("THIN"),
  `shortlist = ${syms.join(", ")}`);
ok("the survivor gets the slot despite ranking last", syms.includes("QUIET"),
  "rank 40 beats rank 95 when 95 cannot pass the screen");
ok("no slot is wasted", picked.every((c) => wouldSurviveScreen(c) === null), `${picked.length} picked, all viable`);

console.log("\nA CYCLE THAT STUDIES NOTHING LEARNS NOTHING");
// If the filter would empty the list, fall back rather than idle: a doomed workup still
// produces a verdict and a lesson, whereas an empty cycle produces neither.
const allDoomed = [coin({ sym: "A", score: 80, liq: 1 }), coin({ sym: "B", score: 70, vol: 1 })];
const fallback = selectShortlist(allDoomed, 3);
ok("the desk still works up SOMETHING when nothing is viable", fallback.length > 0,
  `${fallback.length} picked from a market of ${allDoomed.length} doomed coins`);

console.log("\nRANK AND SCREEN NO LONGER DISAGREE ABOUT THE SAME COIN");
const contradiction = coin({ sym: "X", score: 99, mcap: OVER_CAP, liq: 900_000 });
ok("a coin rank loves but the screen kills is caught here",
  wouldSurviveScreen(contradiction) === "too_big",
  "the exact contradiction that produced eight barren cycles");


/* ── ONE RULE, BOTH LANES ─────────────────────────────────────────────────────
 * The fresh lane had its own hand-rolled copy of this filter, with its own inline
 * defaults. When the market-cap ceiling was added to the screen, that copy never
 * learned about it — so the 5-minute lane kept buying workups on coins over the
 * ceiling and `too_big` became the desk's most common refusal at 21 occurrences.
 * Two lanes with two copies of one rule is a bug waiting for the next threshold to
 * move. */
console.log("\nTHE FRESH LANE USES THE SAME FILTER, NOT A COPY");
{
  const src = await (await import("node:fs/promises")).readFile("./src/penthouse.js", "utf8");
  const fresh = src.slice(src.indexOf("export async function freshScan"));
  ok("the fresh lane calls wouldSurviveScreen", fresh.includes("wouldSurviveScreen("));
  ok("and no longer hand-rolls its own thresholds",
    !/minLiquidityUsd \?\? 25000|minVolume24hUsd \?\? 10000|minTxns24h \?\? 50/.test(fresh),
    "no inline default thresholds left in the lane");
  // The specific coin shape that produced 21 refusals.
  const big = coin({ sym: "BIG", mcap: (s.maxMarketCapUsd || 3e6) * 20, liq: 900_000, vol: 2_000_000, tx: 5000 });
  ok("a coin over the ceiling is rejected by the shared filter",
    wouldSurviveScreen(big) === "too_big",
    "the fresh lane now drops it instead of paying for a workup");
}

/* ── THE CURVE'S TWO OPPORTUNITY CODES (step 13, 2026-09-08) ─────────────────────
 * dead_curve and post_ath_dump are read off the launch feed's own row for $0 and are
 * OPPORTUNITY, not safety: a dead curve and a dumped coin both sell. Every clause of
 * each is driven here, the tape's role in each is pinned, and a safety code is shown
 * to come first. Then the gate sets themselves: the frozen 31 SAFETY codes with nothing
 * removed and nothing added beyond what steps 20-21 of the plan name, and the two new
 * codes in JUDGMENT_GATES by name — never left to the SAFETY default. */
console.log("\nTHE CURVE'S TWO OPPORTUNITY CODES — fired only on the stated conditions");
{
  const NOW = 1_788_400_000_000;
  const MINUTE = 60_000;
  const FM = floorsFor(30_000);
  /* A tape wouldSurviveScreen calls LIVE: last print inside five minutes and covering
     at least five. What it carries is irrelevant to these two codes; only its liveness. */
  const liveTape = { stalenessMins: 1, coverageMins: 12, vol5mUsd: Math.max(600, FM.vol) };
  /** A micro-cap row as the launch feed shapes it, comfortably over every band floor. */
  const micro = (over = {}, live = {}) => coin({ mcap: 30_000, liq: FM.liq * 3, vol: FM.vol * 3,
    tx: FM.txns * 2, age: 3, ...over, live: { band: "micro", ...live } });
  const at = (c) => wouldSurviveScreen(c, { now: NOW }) ?? "survived";
  console.log(`  (micro floors: liq $${FM.liq}, vol $${FM.vol}, txns ${FM.txns}, age ${FM.ageH}h)`);

  ok("the micro row survives on its own — the fixture proves nothing else fires", at(micro()) === "survived", at(micro()));
  const dead = micro({ onCurve: true }, { progressSol: 0.05 });
  ok("on the curve, 5% along, three hours old, no tape: dead_curve", at(dead) === "dead_curve", at(dead));
  ok("...15% along is not dead", at(micro({ onCurve: true }, { progressSol: 0.15 })) === "survived",
    at(micro({ onCurve: true }, { progressSol: 0.15 })));
  ok("...ninety minutes old is not yet dead", at(micro({ onCurve: true, age: 1.5 }, { progressSol: 0.05 })) === "survived",
    at(micro({ onCurve: true, age: 1.5 }, { progressSol: 0.05 })));
  ok("...the boundary itself (10%, 2h) does not fire", at(micro({ onCurve: true, age: 2 }, { progressSol: 0.10 })) === "survived",
    at(micro({ onCurve: true, age: 2 }, { progressSol: 0.10 })));
  ok("...a LIVE tape is the one thing a dead curve is not: it never fires with one",
    at(micro({ onCurve: true, momentum: liveTape }, { progressSol: 0.05 })) === "survived",
    at(micro({ onCurve: true, momentum: liveTape }, { progressSol: 0.05 })));
  ok("...a tape whose last print is 30 minutes old is not live, and does not rescue it",
    at(micro({ onCurve: true, momentum: { ...liveTape, stalenessMins: 30 } }, { progressSol: 0.05 })) === "dead_curve",
    at(micro({ onCurve: true, momentum: { ...liveTape, stalenessMins: 30 } }, { progressSol: 0.05 })));
  ok("...graduated (off the curve) never fires", at(micro({ onCurve: false }, { progressSol: 0.05 })) === "survived",
    at(micro({ onCurve: false }, { progressSol: 0.05 })));
  ok("...an unmeasured progress never fires", at(micro({ onCurve: true }, { progressSol: null })) === "survived",
    at(micro({ onCurve: true }, { progressSol: null })));
  ok("a SAFETY code still comes first: thin liquidity on a dead curve reads thin_liquidity",
    at(micro({ onCurve: true, liq: FM.liq - 1 }, { progressSol: 0.05 })) === "thin_liquidity",
    at(micro({ onCurve: true, liq: FM.liq - 1 }, { progressSol: 0.05 })));

  const dumped = micro({}, { athRatio: 0.3, athAt: NOW - 25 * MINUTE });
  ok("a micro coin at 30% of a high set 25 minutes ago: post_ath_dump", at(dumped) === "post_ath_dump", at(dumped));
  ok("...a high set 10 minutes ago is a dip, not a dump",
    at(micro({}, { athRatio: 0.3, athAt: NOW - 10 * MINUTE })) === "survived",
    at(micro({}, { athRatio: 0.3, athAt: NOW - 10 * MINUTE })));
  ok("...exactly twenty minutes does not fire",
    at(micro({}, { athRatio: 0.3, athAt: NOW - 20 * MINUTE })) === "survived",
    at(micro({}, { athRatio: 0.3, athAt: NOW - 20 * MINUTE })));
  ok("...50% of the high is not a dump", at(micro({}, { athRatio: 0.5, athAt: NOW - 25 * MINUTE })) === "survived",
    at(micro({}, { athRatio: 0.5, athAt: NOW - 25 * MINUTE })));
  ok("...39% is", at(micro({}, { athRatio: 0.39, athAt: NOW - 25 * MINUTE })) === "post_ath_dump",
    at(micro({}, { athRatio: 0.39, athAt: NOW - 25 * MINUTE })));
  ok("...a nano coin fires too", at(micro({ mcap: 12_000 }, { band: "nano", athRatio: 0.3, athAt: NOW - 25 * MINUTE })) === "post_ath_dump",
    at(micro({ mcap: 12_000 }, { band: "nano", athRatio: 0.3, athAt: NOW - 25 * MINUTE })));
  ok("...the band comes from the cap when the row carries none",
    at(micro({}, { band: undefined, athRatio: 0.3, athAt: NOW - 25 * MINUTE })) === "post_ath_dump",
    at(micro({}, { band: undefined, athRatio: 0.3, athAt: NOW - 25 * MINUTE })));
  ok("...an $800k coin (band high) is out of scope, however far off its high",
    at(coin({ live: { band: "high", athRatio: 0.3, athAt: NOW - 25 * MINUTE } })) === "survived",
    at(coin({ live: { band: "high", athRatio: 0.3, athAt: NOW - 25 * MINUTE } })));
  /* The plan states post_ath_dump's conditions as ratio, age of the high and band — the
     tape is NOT one of them, and it is left out on purpose: every launch-feed row reaches
     the universe through the ignition lane with a tape attached, so a tape veto would
     make this code fire on nothing. A bounce off a dump is still a dump. */
  ok("...a live tape does not rescue it — the tape is not one of its conditions",
    at(micro({ momentum: liveTape }, { athRatio: 0.3, athAt: NOW - 25 * MINUTE })) === "post_ath_dump",
    at(micro({ momentum: liveTape }, { athRatio: 0.3, athAt: NOW - 25 * MINUTE })));
  ok("...an unmeasured high never fires", at(micro({}, { athRatio: null, athAt: null })) === "survived",
    at(micro({}, { athRatio: null, athAt: null })));
  ok("...a ratio with no timestamp never fires", at(micro({}, { athRatio: 0.3, athAt: null })) === "survived",
    at(micro({}, { athRatio: 0.3, athAt: null })));
  ok("a DexScreener row (no `live` at all) can fire neither",
    at(coin({ mcap: 30_000, liq: FM.liq * 3, vol: FM.vol * 3, tx: FM.txns * 2, onCurve: true, age: 3 })) === "survived",
    at(coin({ mcap: 30_000, liq: FM.liq * 3, vol: FM.vol * 3, tx: FM.txns * 2, onCurve: true, age: 3 })));
  ok("the default clock is the wall clock: a 25-minute-old high fires without `now` too",
    wouldSurviveScreen(micro({}, { athRatio: 0.3, athAt: Date.now() - 25 * MINUTE })) === "post_ath_dump");
}

console.log("\nTHE GATE SETS: the frozen 31 SAFETY codes untouched, the two new codes JUDGMENT by name");
{
  const { GATE_CLASS, SAFETY_GATES, JUDGMENT_GATES, gateClass } = await import("./src/calls.js");
  /* THE 31, as they stood when step 13 was written. Nothing may leave this list; the
     only codes allowed to join SAFETY beyond it are the ones steps 20 and 21 of the same
     plan add (two target-geometry codes and the Token-2022 allowlist inversion). Any
     other addition — or any removal — fails here and has to be argued for out loud. */
  const FROZEN_31 = [
    "unverified_exit", "unverified_mint", "unverified_holders", "mintable", "freezable", "seizable",
    "transfer_hook", "frozen_by_default", "holder_concentration", "serial_deployer", "post_migration_dump",
    "wash_suspect", "thin_liquidity", "liquidity_did_not_hold", "too_new", "no_volume", "no_participants",
    "fdv_propped", "deployer_has_rugged", "no_data", "workup_error", "insufficient_coverage", "analyst_kill",
    "compliance_veto", "redteam_refuted_unanswered", "no_invalidation", "no_stop", "no_entry_price",
    "stop_at_or_above_entry", "zero_authorized_size", "spike_entry",
  ];
  const LATER_STEPS = ["target_inside_zone", "target_inside_cost", "bot_mint_refusal"];   // plan steps 20-21
  const removed = FROZEN_31.filter((g) => !SAFETY_GATES.includes(g));
  const extra = SAFETY_GATES.filter((g) => !FROZEN_31.includes(g) && !LATER_STEPS.includes(g));
  ok("the frozen list is 31 codes long", FROZEN_31.length === 31 && new Set(FROZEN_31).size === 31, `${FROZEN_31.length}`);
  ok("SAFETY_GATES holds every one of the frozen 31 — nothing removed, nothing reclassified",
    removed.length === 0, removed.length ? `MISSING: ${removed.join(", ")}` : `all 31 present (SAFETY_GATES has ${SAFETY_GATES.length})`);
  ok("...and nothing joined SAFETY beyond what steps 20-21 name", extra.length === 0,
    extra.length ? `UNEXPECTED: ${extra.join(", ")}` : `${SAFETY_GATES.length - 31} later-step code(s) present: ${SAFETY_GATES.filter((g) => LATER_STEPS.includes(g)).join(", ") || "none yet"}`);
  for (const code of ["dead_curve", "post_ath_dump"])
    ok(`${code} is a JUDGMENT_GATES member BY NAME, and not a SAFETY one`,
      Object.hasOwn(GATE_CLASS, code) && gateClass(code) === "JUDGMENT"
        && JUDGMENT_GATES.includes(code) && !SAFETY_GATES.includes(code),
      `GATE_CLASS.${code}=${GATE_CLASS[code]}`);
  ok("an unregistered code would still have defaulted to SAFETY — which is why they are registered",
    gateClass("some_curve_code_nobody_registered") === "SAFETY");
  console.log(`  SAFETY (${SAFETY_GATES.length}): ${SAFETY_GATES.join(", ")}`);
  console.log(`  JUDGMENT (${JUDGMENT_GATES.length}): ${JUDGMENT_GATES.join(", ")}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
