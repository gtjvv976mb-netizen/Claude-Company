import { sweep, classify, CATEGORY_RISK, launchpad } from "./market.js";
import { gather, screen } from "./data/evidence.js";
import { workup } from "./desk.js";
import { openCall, liveCalls, liveCallFor, evaluateExit, closeCall, noteEvent,
  gateFailures, beginCyclePass, abandonCyclePass, recordCyclePublish, cycleStatus,
  settleCycles, recordPublishability } from "./calls.js";
import { broadcast } from "./copy.js";
import { announceExit } from "./alerts.js";
import { listFloors, HQ_FLOOR } from "./tower.js";
import { emit, runFor, runForEvidence, bus } from "./lib/bus.js";
import db from "./lib/store.js";
import { spend, OutOfCredit, spendSince, creditBreakerState } from "./lib/llm.js";
import * as jup from "./data/jupiter.js";
import { callouts, whaleScore } from "./whales.js";
import { recordWhaleCallout } from "./identity.js";
import { regime } from "./data/regime.js";
import { cfg, floorsFor, MINTS, CYCLE, MAX_ESCALATION_LEVEL, escalationPlan, setCycleBandWindow,
  WORKUPS_DEFAULT, CYCLE_BUDGET_DEFAULT_USD, HUNT_BUDGET_DEFAULT_MS } from "./config.js";
import * as store from "./lib/store.js";
import * as shadow from "./shadow.js";
import { buildBoard, selectAcrossBoard, CAP_BANDS, COIN_TYPES, bandForMarketCap } from "./categories.js";
import { recordCandidateBoard } from "./candidate-board.js";
import * as funnel from "./funnel.js";
import * as ds from "./data/dexscreener.js";
import { eligibility, contenderScore, pickOne, bookState, SEQUENTIAL, MAX_LIVE_CALLS } from "./mandate.js";
import { runBestPick } from "./agents/decision.js";
import { linkPublishedCall } from "./evaluation.js";

/**
 * THE PENTHOUSE CYCLE — the house team's working day.
 *
 *   sweep (free) → classify (free) → screen (free) → rank (free) → work up the best few
 *   → open calls on what the CEO approves → broadcast to every leased floor (free)
 *
 * Only the workup costs money, which is why everything above it is arithmetic. A cycle
 * looks at ~190 coins and pays for ~3.
 */

/* AGGRESSION, PART ONE: MORE SHOTS ON GOAL.
 * Three coins a cycle at 32 cycles a day is 96 looks — and on a market where a coin
 * worth trading appears every half hour, that is a narrow net. Eight per cycle on a
 * faster clock roughly quadruples the looks. The daily money cap still governs the
 * total, so this widens the net without removing the brake. */
/* 8 -> 24 (2026-09-08). Eight was still too narrow to be arithmetic: measured over 500
 * workups the positive-verdict rate is 3.8% (4 PASS + 15 WATCH), so a cohort of three
 * needs ~79 paid workups in expectation — ~21 even at the 14.3% PM-positive rate. Eight
 * a pass could not reach three calls however good the market was. Set PENTHOUSE_WORKUPS
 * to 8 to restore the old default; the default itself lives in config.js. */
export const WORKUPS_PER_CYCLE = Number(process.env.PENTHOUSE_WORKUPS || WORKUPS_DEFAULT);
/** Hard ceiling per cycle. Without it one bad night empties the account. */
/* $10 was more than the hourly pace allowed ($40/24 x 3 = $5), so every cycle was cut
 * off mid-hunt and none could complete. Four fits inside the pace with room to spare,
 * and at the measured $0.126 a workup it still buys ~32 of them — a shortlist of three
 * plus a deep mandate hunt. Smaller cycles running often beat large ones that die. */
/* 8 -> 16 (2026-09-08), because a workup is no longer $0.126: a fully-worked coin
 * measures ~$1.30, so an $8 cap ended a FUNDED pass after roughly six of them — the
 * loop stops at `used + reserved >= cap` — while 24 workups plus a hunt were queued
 * behind it. At the live $200 daily cap the hourly pace floor is max($200/24x3,
 * 16x1.25) = $25/h, so 16 still fits inside one hour's allowance. Set
 * PENTHOUSE_CYCLE_BUDGET_USD to 8 to restore the old default (which config.js owns,
 * so llm.js's pace floor reads the same number this cap is enforced at). */
export const CYCLE_BUDGET_USD = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || CYCLE_BUDGET_DEFAULT_USD);
export const TOP_N = Number(process.env.PENTHOUSE_TOP_N || 5);
/* How many candidates the board shortlists per cell — the owner's "at least 5 per
 * category". Shortlisting is free; only what selectAcrossBoard picks gets paid for. */
export const PER_CELL = Number(process.env.PENTHOUSE_PER_CELL || 5);

/**
 * The cheap ranking that decides who gets the expensive seats.
 *
 * The trap here is ranking by recent price change, which just buys the top of every
 * pump. What separates "about to run" from "already ran" is the shape of the move: a
 * coin up 35% in the last hour has already run, and the desk would be the exit
 * liquidity. So a big h1 move is penalised, while sustained h6 strength on rising
 * volume is rewarded.
 */
/* THE DOCTRINE. 99% of memecoins dump inside a day; the desk's whole business
 * is the other 1%, which comes in exactly two shapes:
 *   Job 1 — NEW coins whose ignition is real: true lore, real X attention,
 *           honest holders, unpaid reach, a chart not already vertical.
 *   Job 2 — OLD coins with the strongest revival: re-igniting on an emerging
 *           trend, notable people posting, fresh notable buying on an aged tape.
 * Everything below scores toward one of those two shapes; everything the seats
 * do afterwards is deciding whether the shape is genuine. */
export function rank(c) {
  const p = c.pair;
  if (!p) return { score: 0, why: ["no pair data"] };
  const why = [];
  let s = 0;

  /* THE BONDING-CURVE PENALTY IS GONE, because the fact it rested on is false.
   *
   * It read: "no AMM depth for the exit probe to measure, so it fails cannot_exit at the
   * screen anyway." That is a checkable claim, and checking it is what the desk is
   * supposed to do. Four on-curve coins the screen had killed as unexitable were probed
   * through Jupiter at $75: 4.53%, 5.49%, 5.58%, 3.70% round trip, against an 8%
   * ceiling. Every one exitable. Jupiter routes bonding curves; the ASSUMPTION that it
   * does not was doing the work, and no measurement ever backed it.
   *
   * What -30 actually did: of 58 micro-cap coins on a live sweep, 38 scored zero or
   * below and ALL 38 were on-curve. Since a zero score means the coin is never even
   * observed, the desk was deleting the pre-graduation pump.fun segment — the earliest,
   * smallest, highest-upside coins it was explicitly pointed at — one line above the
   * funnel, invisibly, and it read as prudence. Sixteen coins that had PASSED the safety
   * screen were discarded here anyway.
   *
   * Being early on the curve is the target state for this desk, not a defect. It is left
   * NEUTRAL rather than made a bonus: the route probe still has to measure it, and
   * unverified_exit still refuses it if no route can be quoted at all. (`cannot_exit`
   * was named here too — the 8% cost ceiling — and it was deleted on 2026-09-07 for the
   * same reason this penalty was: it refused coins on a number measured at a size
   * nobody trades. The bot enforces the real one at its real size,
   * executor/jupiter.mjs:1341-1350.) Safety is unchanged; only false premises were
   * removed. */

  const liqKnown = p.liquidityUsd != null || p.liquidity?.usd != null;

  const liq = p.liquidityUsd ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const h1 = p.priceChange?.h1 ?? 0;
  const h6 = p.priceChange?.h6 ?? 0;
  const h24 = p.priceChange?.h24 ?? 0;
  const age = p.ageHours ?? 0;

  /* DEPTH: ENOUGH TO EXIT, AND NO CREDIT FOR MORE.
   *
   * This paid +15 over $75k and another +10 over $400k, so a big book out-scored a
   * small one by 25 points before its story was read — and with the aged-survivor
   * bonus below, up to +39 on size alone. That is how a memecoin desk ends up
   * surfacing coins you would hold rather than trade.
   *
   * Those numbers were calibrated for a desk placing $500 clips out of a $10,000
   * book. The executor sizes at about $3.40, capped near $10, and the exit probe now
   * prices $200. At that size a $50,000 pool and a $500,000 pool are the same pool:
   * both round-trip under a tenth of a percent. Depth past "can I get out" buys
   * nothing and costs the whole thesis, because upside lives in the small caps.
   *
   * So depth is now a THRESHOLD, not a ladder — one modest bonus for clearing the bar
   * the executor actually needs, and a penalty once a coin is too heavy to re-rate. */
  if (liq > 40_000) { s += 12; why.push("deep enough to exit at the size we trade"); }
  const mcap = p.marketCap ?? p.fdv ?? null;
  if (mcap != null) {
    if (mcap < 2_000_000) { s += 10; why.push(`\$${(mcap / 1e6).toFixed(2)}m cap — real room to re-rate`); }
    else if (mcap > 8_000_000) { s -= 12; why.push(`\$${(mcap / 1e6).toFixed(1)}m cap — needs millions of fresh money to move`); }
  }

  /* Turnover relative to depth: real interest, but wash above a point.
   *
   * When depth is UNREADABLE this ratio silently evaluated to 0 and the coin missed the
   * bonus entirely — a second, quieter penalty on the same segment the line above was
   * deleting, and one that looked like a neutral calculation rather than a judgement.
   * A coin whose pool cannot be read is still either being traded or not, so it is
   * scored on the tape it does have: real volume and real participants. */
  const volToLiq = liq > 0 ? vol24 / liq : 0;
  if (liqKnown) {
    if (volToLiq > 1 && volToLiq < 15) { s += 15; why.push("healthy turnover"); }
    if (volToLiq >= 15) { s -= 10; why.push("turnover implausible for the depth"); }
  } else {
    const buys24 = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
    if (vol24 > 25_000 && buys24 > 300) { s += 15; why.push(`real tape without a readable pool — $${Math.round(vol24 / 1000)}k over ${buys24} trades`); }
    else if (vol24 > 8_000 && buys24 > 100) { s += 8; why.push("a working tape, pool unreadable"); }
  }

  // The key discriminator.
  if (h1 > 25) { s -= 25; why.push(`already ran ${h1.toFixed(0)}% this hour`); }
  else if (h1 > 8) { s -= 8; why.push("extended on the hour"); }
  else if (h1 > -3 && h6 > 5) { s += 20; why.push("holding gains rather than spiking"); }
  if (h6 > 10 && h24 > 0 && h1 < 10) { s += 12; why.push("sustained over six hours"); }
  if (h24 < -35) { s -= 15; why.push("falling knife"); }

  // Age: old enough to have a tape, young enough to still move.
  if (age > 24 && age < 24 * 21) { s += 12; why.push("has a tape but is still young"); }

  /* THE SNIPER PATH. The profitable memecoin bots of this cycle are not fast —
   * they are EARLY: first hours of a coin whose attention is real. "Too new to
   * read" was costing us every one of those, so youth stops being a penalty when
   * the coin shows genuine ignition: buyers accelerating hour over hour, socials
   * that exist, and a price that is moving without having already blown off.
   * Youth without ignition keeps the old penalty — new and dead is just new. */
  const buysH1 = c.pair?.txns?.h1?.buys ?? 0;
  const buysH6 = c.pair?.txns?.h6?.buys ?? 0;
  const buyAccel = buysH6 > 0 ? buysH1 / (buysH6 / 6) : 0;
  const hasSocials = (c.pair?.socials?.length ?? 0) > 0;
  if (age >= 1.5 && age < 48) {
    if (buyAccel >= 2 && buysH1 >= 30 && hasSocials && h1 > 0 && h1 <= 25) {
      s += 30; why.push(`ignition: ${buysH1} buys this hour, ${buyAccel.toFixed(1)}x the 6h pace, socials live`);
      if (buyAccel >= 4 && h6 > 15) { s += 10; why.push("attention compounding, not spiking"); }
    } else {
      s -= 15; why.push("young without ignition");
    }
  } else if (age < 1.5 && !c.momentum) {
    /* Only for a coin the desk cannot see the tape of. The ignition lane exists to make
       this judgement from minute candles instead, and penalising its finds for being
       young would discard the entire population it was built to find. */
    s -= 20; why.push("too new even for the sniper path");
  }

  /* THE REVIVAL PATH — the desk's second job. Of the coins that matter, some are
   * new and igniting; the rest are OLD coins coming back: dumped, flatlined, and
   * now re-igniting on a real trend — or never having left their highs at all.
   * The signature is the same ignition read on an aged tape: buyers accelerating
   * hard against their own recent pace, on a coin old enough to have died once. */
  /* Revival now means the SURVIVOR cohort: only ~4.6% of launchpad coins live
   * past 90 days, and a "revival" younger than that is usually an abandoned
   * mint sharing a ticker. The 2-13-week middle ground belongs to no lane —
   * by the doctrine's own math it is where the bodies are. */
  if (age >= 24 * 90) {
    if (buyAccel >= 3 && buysH1 >= 40 && h1 > 0 && h1 <= 25) {
      s += 25; why.push(`revival: ${buysH1} buys this hour on a ${Math.round(age / 24)}d-old coin, ${buyAccel.toFixed(1)}x its pace`);
      if (h6 > 10 && h24 > 0) { s += 8; why.push("the comeback is holding, not spiking"); }
    }
  }
  // The ranker could reward youth and nothing else, so a coin that had actually survived
  // scored worse than one that had not been tested. Durability is evidence too.
  // Durability is evidence, but it was gated on a $750k book — which made this a
  // third size bonus wearing an age label, and only big coins could ever earn it.
  // Survival is the claim being rewarded, so gate it on survival.
  if (age > 24 * 90 && liq > 40_000) { s += 14; why.push("survived long enough to have a base rate"); }
  if (age > 24 * 365) { s += 6; why.push("more than a year old"); }

  const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  if (txns > 500) { s += 8; why.push("actively traded"); }

  /* Who is behind the tape. The 655,770-token pump.fun study's strongest
   * graduation predictor was FEW LARGE HUMAN BUYS — real conviction arrives in
   * size, while a thousand dust swaps is a bot choir. Average trade size is
   * volume the desk already has, read a second way. */
  const avgTrade = txns > 0 ? vol24 / txns : 0;
  if (txns >= 200 && avgTrade >= 150) { s += 8; why.push(`real size behind the tape ($${Math.round(avgTrade)}/trade)`); }
  if (txns >= 2000 && avgTrade < 15) { s -= 10; why.push(`dust swarm ($${Math.round(avgTrade)}/trade over ${txns} trades)`); }

  return { score: Math.round(s), why };
}

/** Categories with a survivable base rate, as opposed to a launchpad lottery ticket. */
const SUBSTANTIVE = new Set(["established", "utility", "infra", "defi", "ai"]);

/**
 * Pick who gets the expensive seats.
 *
 * Ranking on score alone sent three memecoins to the desk every cycle, and the red team
 * refuted all of them — correctly, because "most tokens of this profile go to zero" is
 * true and nothing about an 80-hour-old coin overcomes it. A verdict that is structurally
 * guaranteed carries no information. So at least one slot is reserved for a coin with a
 * real base rate behind it, and the refusal starts meaning something.
 */
/**
 * WOULD THE FREE SCREEN KILL THIS BEFORE A SEAT EVER SAW IT?
 *
 * The cycle gets THREE workup slots and was choosing them purely on rank — while
 * rank() rewards depth and momentum, and the screen kills on thresholds rank knows
 * nothing about. So the desk kept spending its whole allowance on coins that died at
 * the first free gate: eight consecutive cycles studied 1-3 coins each and produced
 * ZERO eligible candidates, every time.
 *
 * That is not a strictness problem, it is a selection problem — the slots were being
 * filled with coins the desk was always going to refuse. The fresh lane has pre-filtered
 * like this since its first champion died of thin_liquidity; the cycle never learned.
 *
 * Only the checks answerable from pair data already in hand. Anything needing an RPC
 * read or a Jupiter probe still belongs inside the workup, where it is measured
 * properly rather than guessed at here.
 */
/* THE TWO OPPORTUNITY READS OFF THE CURVE (2026-09-08). Both are JUDGMENT in calls.js
 * GATE_CLASS, registered there BY NAME so default-deny cannot promote them to SAFETY,
 * and no rung of the ladder references either (config.js escalationPlan waives only
 * the manufactured arm), so no quota can waive them. Neither says the coin is unsafe —
 * a dead curve and a dumped coin both sell — it says the coin is not the trade this
 * desk exists to find, and says so for $0 instead of after a ~$0.40 paid workup. */
const DEAD_CURVE_MAX_PROGRESS = 0.10;   // under a tenth of the way along...
const DEAD_CURVE_MIN_AGE_H = 2;         // ...after more than two hours, with no live tape
const POST_ATH_MAX_RATIO = 0.4;         // under 40% of its own high...
const POST_ATH_MIN_AGE_MS = 20 * 60_000; // ...set more than twenty minutes ago (nano/micro)

export function wouldSurviveScreen(c, { now = Date.now() } = {}) {
  const p = c.pair || {};
  const s = cfg.screen;
  const liq = p.liquidityUsd ?? 0;
  const vol = p.volume?.h24 ?? 0;
  const tx = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  /* A COIN FOUR MINUTES OLD HAS NO 24-HOUR HISTORY, AND WILL NOT HAVE ONE IN TIME.
   *
   * Judging it on daily aggregates refuses it for a fact about the calendar rather than
   * about the coin. When the ignition lane has attached a minute tape, that tape is the
   * evidence of a real market instead — and it is a HARDER test per unit time, not a
   * softer one: five minutes must carry a fifth of what the band asks of a whole day.
   * Only a coin still inside its band's hunt window may be judged this way; an old coin
   * with no daily volume is an old coin nobody is trading. */
  /* A TAPE THAT DESCRIBES THE PAST IS NOT A TAPE. vol5mUsd used to sum the last five
     candles regardless of when they printed, and pump.fun emits a candle only for a
     minute that traded — so five rows spanning forty-four hours of trickle read as a
     busy five minutes and let the coin past the volume floor it was built to fail.
     Both guards are now on the reading itself: the window has to be live, and the tape
     has to cover the window it claims. */
  const rawTape = c.momentum || null;
  const tapeIsLive = rawTape != null &&
    (rawTape.stalenessMins == null || rawTape.stalenessMins <= 5) &&
    (rawTape.coverageMins ?? 0) >= 5;
  const tape = tapeIsLive ? rawTape : null;
  const tapeVol = tape?.vol5mUsd ?? 0;
  const mcap = p.marketCap ?? p.fdv ?? null;
  const age = p.ageHours ?? 0;
  /* Floors scaled to the coin's own size — see BAND_FLOORS. A flat floor was passing 2
   * of 60 micro-caps and made "5 per category" impossible in the band this desk is for.
   * The measured exit probe downstream is unchanged and still absolute. */
  const fl = floorsFor(mcap);

  /* UNKNOWN LIQUIDITY IS NOT THIN LIQUIDITY, and conflating them was excluding an
   * entire class of coin.
   *
   * Measured on a live sweep of 300: 119 coins carry no liquidity figure at all. They
   * were read as $0 and killed as "thin", and they are not thin — samples showed
   * $26k-$239k of 24h volume across 519-6,184 transactions. A coin with that tape has a
   * market; the free feed simply does not report a pool for it, which is what happens
   * with pre-graduation coins whose trading is on a bonding curve rather than an AMM.
   * Since that is most of pump.fun's early market, the desk was systematically refusing
   * the earliest and smallest segment it exists to hunt: the micro band passed 2 of 60.
   *
   * THE PROXY IS NOT THE TEST. Pool depth is a cheap stand-in for the only question that
   * matters — can this position be got out of — and the desk MEASURES that directly with
   * a Jupiter round-trip at probe size. Four of these "thin" coins were probed: 4.53%,
   * 5.49%, 5.58%, 3.70% round-trip against an 8% ceiling. Every one exitable.
   *
   * So an unreadable pool defers to that measurement instead of pre-empting it, and only
   * when the tape independently shows a real market. A pool figure that IS readable and
   * IS below the floor still kills here, exactly as before. Nothing downstream moves:
   * unverified_exit still refuses a coin whose sell route cannot be quoted at all.
   * (`cannot_exit`, the cost ceiling, stood beside it and was removed 2026-09-07: the
   * desk does not judge what leaving costs, because that depends on an order size only
   * the bot knows.) This trades a proxy that is wrong for a whole class of coin against
   * a direct measurement — a strengthening of the safety argument, not a loosening. */
  const liqUnknown = p.liquidityUsd == null && p.liquidity?.usd == null;
  if (!liqUnknown && liq < fl.liq) return "thin_liquidity";
  const tapeCarries = tape != null && tapeVol >= Math.max(300, fl.vol / 5);
  if (vol < fl.vol && !tapeCarries) return "no_volume";
  // The tape is a volume record, not a trade count, so a tape-judged coin has already
  // answered the participation question with the only evidence it owns.
  if (tx < fl.txns && !tapeCarries) return "no_participants";
  /* An unreadable pool has to clear a HIGHER bar of real trading before the desk will
     spend anything measuring it — the tape is the only evidence of a market it has.
     A graduated pump.fun coin arrives here every time: its bonding curve is drained
     into an AMM pool that this feed cannot see, so the minute tape answers, at double
     the bar a readable pool would have had to clear. */
  const tapeCarriesDouble = tape != null && tapeVol >= Math.max(600, (fl.vol * 2) / 5);
  if (liqUnknown && (vol < fl.vol * 2 || tx < fl.txns * 2) && !tapeCarriesDouble)
    return "thin_liquidity";
  if (age < (fl.ageH ?? s.minPairAgeHours)) return "too_new";
  if (s.maxMarketCapUsd > 0 && mcap != null && mcap > s.maxMarketCapUsd) return "too_big";
  if (s.minMarketCapUsd > 0 && mcap != null && mcap < s.minMarketCapUsd) return "too_small";
  if (liq > 0 && vol / liq > s.maxVolToLiqRatio) return "wash_suspect";
  if (liq > 0 && mcap != null && mcap / liq > s.maxFdvToLiqRatio) return "fdv_propped";

  /* OPPORTUNITY, read off the launch feed's own row, and AFTER every safety code above
   * so a record never carries one of these in place of a measured fact.
   *
   *   dead_curve     still on its curve, under a tenth of the way along after more than
   *                  two hours, and no live tape to say otherwise. Progress by SOL is
   *                  derived per row (pumpfun-live.js curveOf); a live tape means the
   *                  coin is trading NOW, which is the one thing a dead curve is not.
   *   post_ath_dump  a nano or micro coin under 40% of its own high, the high set more
   *                  than twenty minutes ago. A late look: the move already happened,
   *                  whatever the current five minutes print — the tape does not rescue
   *                  it, because a bounce off a dump is still a dump.
   *
   * Only a row the launch feed shaped carries `live` (asCandidate); a DexScreener row
   * has none, and neither clause can fire on it. Null fields are unmeasured, not clean,
   * and an unmeasured number never disqualifies — the desk's standing rule. */
  const live = c.live ?? null;
  if (live) {
    if (c.onCurve === true && live.progressSol != null && live.progressSol < DEAD_CURVE_MAX_PROGRESS
        && age > DEAD_CURVE_MIN_AGE_H && tape == null) return "dead_curve";
    const band = live.band ?? bandForMarketCap(mcap);
    if ((band === "nano" || band === "micro") && live.athRatio != null && live.athRatio < POST_ATH_MAX_RATIO
        && live.athAt != null && now - live.athAt > POST_ATH_MIN_AGE_MS) return "post_ath_dump";
  }
  return null;
}

export function selectShortlist(scored, workups) {
  /* Spend the slots on coins that can actually reach a seat. If the filter would empty
   * the list entirely the desk falls back to the ranked order — a cycle that studies a
   * doomed coin still learns something, whereas a cycle that studies nothing cannot. */
  const viable = scored.filter((c) => wouldSurviveScreen(c) === null);
  const pool = viable.length ? viable : scored;
  if (viable.length < scored.length)
    emit("cycle:prefiltered", { considered: scored.length, viable: viable.length,
      note: "coins the free screen would kill were dropped before paying for a workup" });

  const substantive = pool.filter((c) => SUBSTANTIVE.has(c.category));
  const speculative = pool.filter((c) => !SUBSTANTIVE.has(c.category));
  const reserved = Math.min(substantive.length, Math.max(1, Math.floor(workups / 2)));

  const picked = substantive.slice(0, reserved);
  for (const c of speculative) {
    if (picked.length >= workups) break;
    picked.push(c);
  }
  for (const c of substantive.slice(reserved)) {         // backfill if speculation ran dry
    if (picked.length >= workups) break;
    picked.push(c);
  }
  return picked.sort((a, b) => b.score - a.score);
}

/**
 * ADVANCE THE FUNNEL WITHOUT SPENDING A CENT.
 *
 * Sweep, rank, observe, expire, screen — every stage here is arithmetic against data
 * the desk already fetches, and not one model is called. That is what makes it safe to
 * run while a position is open, and while the daily money brake is on: the two states
 * in which the old desk did nothing at all and arrived at the next opportunity cold.
 *
 * It returns the shape of the pipe, because the drop-off between stages is how you tell
 * "the market offered nothing" from "the desk is strangling itself" — two failures that
 * look identical from outside and cost a full day to separate by hand once already.
 */
/**
 * THE IGNITION LANE'S CONTRIBUTION TO THE UNIVERSE.
 *
 * The keyword sweep returns coins a search engine thinks are relevant, whose median age
 * measured twenty-five days. This adds the coins pump.fun is trading RIGHT NOW, with a
 * minute tape attached so the screen can judge a four-minute-old coin on evidence
 * rather than on the absence of a 24-hour history. It is free and it calls no model.
 *
 * It degrades to nothing: if pump.fun is unreachable the desk runs on the sweep alone,
 * exactly as it did before.
 */
export async function ignitionUniverse({ solUsd = null, tapes = 40 } = {}) {
  try {
    const { ignitionSweep } = await import("./ignition.js");
    // The funnel lends the sweep its SOL-per-minute reading (two stored curve readings,
    // funnel.js curveVelocity) so a coin seen twice earns ignitionScore's velocity term.
    const r = await ignitionSweep({ solUsd, tapes, curveVelocityOf: funnel.curveVelocity });
    // Only coins whose tape says something is happening. A negative score is a coin
    // going the wrong way on real volume, and the desk has no reason to look at it.
    return r.ranked.filter((c) => c.ignition.score > 0);
  } catch (e) {
    emit("ignition:unavailable", { note: String(e?.message || e) });
    return [];
  }
}

/**
 * THE SOL MARK THE CURVE IS PRICED IN, read once per pass.
 *
 * A pump.fun row reports its curve in lamports, so without a SOL/USD price
 * asCandidate cannot fill `curveLiquidityUsd` and every on-curve coin arrives with
 * `pair.liquidityUsd = null`. That is not free: an unreadable pool takes the DOUBLE-bar
 * path in wouldSurviveScreen (2x volume and 2x participation on the minute tape) — the
 * strictness reserved for a coin whose depth genuinely cannot be read, applied to a coin
 * whose depth is sitting in the row. One keyless Jupiter request answers it for the
 * whole universe. Unreachable falls back to cfg.solUsdFallback (DESK_SOL_USD_FALLBACK,
 * $103), a stated constant, exactly as probe-size.js does.
 */
async function curveSolUsd() {
  try {
    const p = await jup.price([MINTS.SOL]);
    const px = Number(p?.[MINTS.SOL]?.usdPrice);
    if (px > 0) return { solUsd: px, source: "jupiter" };
  } catch { /* a price that did not answer is not a reason to skip the launch feed */ }
  return { solUsd: Number(cfg.solUsdFallback) || 0, source: "DESK_SOL_USD_FALLBACK" };
}

/**
 * THE UNIVERSE BOTH PASSES WORK OVER — the keyword sweep AND the live launch feed.
 *
 * The cohort pass used to see `sweep()` alone: ~108 DexScreener keyword hits whose
 * median age measured twenty-five days, which one ladder walk exhausts inside the 6h
 * recentlyJudged window (store.js) — that is what `cycle:topped_up` is. Meanwhile the
 * pump.fun listing the free warm pass already reads (up to 420 rows and 40 minute tapes,
 * keyless) reached nothing the cohort could spend a seat on.
 *
 * One builder, used by BOTH passes, on purpose. The funnel remembers by mint and the
 * cycle can only act on a mint its own `bySweep` resolves, so a warm pass that observed
 * ignition rows while the cohort pass could not see them would file coins the cohort
 * must then skip — memory the desk cannot spend. Same universe in, same universe out.
 *
 * It degrades to nothing: if pump.fun is unreachable both passes run on the sweep alone,
 * exactly as they did before.
 */
export async function cohortUniverse({ tapes = 40 } = {}) {
  const { solUsd, source: solUsdSource } = await curveSolUsd();
  const [swept, igniting] = await Promise.all([sweep(), ignitionUniverse({ solUsd, tapes })]);
  /* Ignition first so its richer row — the one carrying the minute tape — wins the
     dedupe against the same coin arriving from the keyword sweep. */
  const merged = new Map();
  for (const c of [...igniting, ...swept]) if (c?.mint && !merged.has(c.mint)) merged.set(c.mint, c);
  /* THE LAUNCH FEED'S ROWS GO IN THE SNAPSHOT LEDGER TOO. sweep() records its own
     (market.js); nothing recorded the ignition rows, so the two gates that read the
     ledger — post_migration_dump ("what price did WE first see") and
     liquidity_did_not_hold — were structurally unfirable for a coin that only ever
     arrived through pump.fun. Best-effort, like the sweep's own write. */
  if (igniting.length) {
    try { (await import("./data/snapshots.js")).record(igniting); }
    catch (e) { emit("snapshots:record_failed", { error: String(e?.message || e) }); }
  }
  // ignitionOnly = merged - swept, which reduces to igniting minus the overlap: the
  // number that says whether the lane is ADDING market or re-finding the sweep's.
  emit("universe:merged", { merged: merged.size, swept: swept.length, igniting: igniting.length,
    ignitionOnly: merged.size - swept.length, solUsd, solUsdSource,
    note: "the keyword sweep plus what pump.fun is trading right now, deduped by mint" });
  return { universe: [...merged.values()], swept, igniting, solUsd, solUsdSource };
}

export async function warmFunnel() {
  const { universe, igniting } = await cohortUniverse();
  const scored = [];
  for (const c of universe) {
    if (liveCallFor(c.mint)) continue;
    const r = rank(c);
    if (r.score <= 0) continue;
    scored.push({ ...c, category: classify(c).category, score: r.score });
  }
  funnel.observe(scored);
  const expired = funnel.decay();

  const bySweep = new Map(scored.map((c) => [c.mint, c]));
  let passed = 0, held = 0;
  for (const row of funnel.dueForScreen(400)) {
    const c = bySweep.get(row.mint);
    if (!c) continue;
    if (funnel.recordScreen(row.mint, wouldSurviveScreen(c)) !== "held") passed++; else held++;
  }

  const shape = funnel.census();
  emit("funnel:warmed", {
    swept: universe.length, igniting: igniting.length, ranked: scored.length,
    screenPassed: passed, screenHeld: held,
    watch: shape.watch, screened: shape.screened, studied: shape.studied, ready: shape.ready,
    expired,
    note: "free — the screen narrows the market whether or not the desk can trade right now",
  });
  return { swept: universe.length, screenPassed: passed, screenHeld: held,
           screened: shape.screened, ready: shape.ready, expired };
}

/** Measured on the live desk: $135.71 of model spend across 323 workups in 24 hours. */
export const TYPICAL_WORKUP_USD = Number(process.env.PENTHOUSE_TYPICAL_WORKUP_USD || 0.42);
/* WHAT A SURVIVOR COSTS, which is not what the average coin costs. $0.42 is the mean
 * over ALL workups, and most of them die free at the paid screen (~93% at $0) or at the
 * reputation read. A coin that reaches the analysts has bought the whole seat stack —
 * Red Team $0.37 + Narrative $0.21 + PM $0.18 + Risk $0.07 + Forensics $0.06 + Flow
 * $0.06 + Execution $0.05 + Liquidity $0.03 on the measured per-seat medians, ~$1.30 all
 * in — so reserving the mean for it under-reserves by ~$0.9 EACH, and three workers
 * carrying survivors overshot the cap by ~$2.3. Reserved at $1.00 from the moment the
 * analysis stage fires, which is the last free moment to notice. */
export const SURVIVOR_WORKUP_USD = Number(process.env.PENTHOUSE_SURVIVOR_WORKUP_USD || 1.0);

/**
 * THE WORKUP POOL — the one scheduler BOTH paid lanes run through.
 *
 * It was two loops. The shortlist pass ran CONCURRENCY workers against the cycle cap;
 * the mandate hunt underneath it was a plain serial `for` that checked neither the cap
 * nor `stopped`, so a pass that had already been cut off at its budget went straight on
 * to buy workups outside it — cycle 19 spent $21.68 against an $8 cap and published
 * nothing. One pool, used twice, is what makes "the budget binds" a property of the
 * cycle rather than of whichever loop happened to be reading it.
 *
 * THE RESERVATION IS STAGE-AWARE. Spend lands only when a workup FINISHES, so workers
 * checking a bare accumulator each start one more against a cap nothing in flight has
 * charged yet — the flat reservation (TYPICAL_WORKUP_USD) is what fixed that. But the
 * flat figure is the mean over mostly-free deaths, so it under-reserves the coins that
 * actually cost money. desk.js emits `stage: "analysis"` for a mint exactly when the
 * cheap gates are behind it and the seat stack is about to be bought, so that event
 * raises this coin's reservation to SURVIVOR_WORKUP_USD. The bound the cycle can claim
 * is the honest one: an overshoot of at most ONE survivor.
 *
 * Injectable throughout (usedUsd, stop/isStopped, events) so the scheduler can be driven
 * against a scripted workup without a market.
 */
export function makeWorkupPool({
  concurrency = 1,
  budgetUsd = CYCLE_BUDGET_USD,
  usedUsd = () => 0,
  typicalUsd = TYPICAL_WORKUP_USD,
  survivorUsd = SURVIVOR_WORKUP_USD,
  isStopped = () => null,
  stop = () => {},
  events = bus,
} = {}) {
  /* One entry per RUNNING workup. Keyed by an opaque slot rather than by mint so two
     lanes (or a queue that repeated a coin) can never release each other's money. */
  let slotSeq = 0;
  const reserved = new Map();                     // slot -> { mint, usd }
  const reservedUsd = () => { let t = 0; for (const r of reserved.values()) t += r.usd; return t; };
  let peak = 0;
  const mark = () => { peak = Math.max(peak, reservedUsd()); };
  const onEvent = (ev) => {
    if (ev?.type !== "stage" || ev.stage !== "analysis" || !ev.mint) return;
    for (const r of reserved.values()) if (r.mint === ev.mint && r.usd < survivorUsd) {
      r.usd = survivorUsd;
      emit("cycle:reserved_up", { mint: ev.mint, fromUsd: typicalUsd, toUsd: survivorUsd,
        reservedUsd: Number(reservedUsd().toFixed(4)),
        note: "this one reached the seats — reserve what a survivor costs, not what the average coin costs" });
    }
    mark();
  };

  async function run({ take, study }) {
    events.on("event", onEvent);
    let started = 0;
    try {
      const worker = async () => {
        while (!isStopped()) {
          // Spend already charged, PLUS a reservation for every workup still running.
          const used = usedUsd();
          const res = reservedUsd();
          if (used + res >= budgetUsd) {
            stop(`budget: $${used.toFixed(2)} of $${budgetUsd}`);
            emit("cycle:budget", { usedUsd: Number(used.toFixed(4)), capUsd: budgetUsd,
              inFlight: reserved.size, reservedUsd: Number(res.toFixed(4)) });
            return;
          }
          /* take() IS CALLED SYNCHRONOUSLY, AND MUST STAY SYNCHRONOUS. An await between
             the cap check and the reservation below would let every worker pass the
             same unreserved cap in the same tick, which is the exact defect the
             reservation exists to prevent. */
          const coin = take();
          if (!coin) return;                      // the lane has nothing more to offer
          const slot = ++slotSeq;
          reserved.set(slot, { mint: coin.mint, usd: typicalUsd });
          mark();
          started++;
          try { await study(coin); } finally { reserved.delete(slot); }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    } finally { events.off("event", onEvent); }
    return { started, peakReservedUsd: peak };
  }

  return { run, reservedUsd, peakReservedUsd: () => peak, concurrency };
}

export async function runPenthouseCycle({
  workups = WORKUPS_PER_CYCLE,
  topN = TOP_N,
  // The full-book branch still refreshes the free funnel. Keeping that boundary
  // injectable lets the regression prove sequencing without making CI depend on
  // DexScreener latency; production callers retain the real warmFunnel default.
  warmFunnelFn = warmFunnel,
} = {}) {
  const cycle = new Date().toISOString().replace(/[:.]/g, "-");

  /* ONE TRADE AT A TIME. The mandate is "one cycle, one trade, run to completion" —
   * so while a call is live the desk does not go shopping. This sits above every
   * paid stage deliberately: the sequencing rule and the money brake are the same
   * lever here, and a cycle that cannot publish must not be allowed to spend. */
  const book = bookState();
  if (book.full) {
    /* HOLDING IS NOT A REASON TO STOP LOOKING.
     *
     * This branch used to return here, which meant that through a twelve-hour hold the
     * desk did no research at all — and then, the instant the position closed, began a
     * cold sweep and needed four minutes to reach a decision. The single most valuable
     * moment in the desk's day was the one it was least prepared for.
     *
     * So the FREE half of the funnel keeps running while a position works: sweep, rank,
     * observe, expire, screen. Not a compromise — it costs nothing, no model is
     * involved, and it is most of the narrowing. When the slot opens there is a
     * standing pool of coins that have already passed a current safety screen, instead
     * of an empty table.
     *
     * The PAID half still does not run. The sequencing rule is a rule about money, and
     * a workup bought now is a verdict that will likely have expired before there is
     * anywhere to put it. */
    const warmed = await warmFunnelFn().catch((e) => ({ error: String(e?.message || e) }));
    emit("cycle:holding", { cycle, live: book.live,
      symbol: book.holding?.symbol, mint: book.holding?.mint,
      heldHours: book.holding ? Number(((Date.now() - book.holding.opened_at) / 3.6e6).toFixed(1)) : null,
      warmed,
      note: "a call is still working — but the free screen keeps narrowing, so the next slot opens onto a warm bench" });
    return { cycle, skipped: "position_open", live: book.live, opened: 0, workedUp: 0, warmed,
      holding: book.holding ? { id: book.holding.id, symbol: book.holding.symbol, mint: book.holding.mint,
        openedAt: book.holding.opened_at } : null, costUsd: 0 };
  }

  /* ═══ THE COHORT GATE ═══════════════════════════════════════════════════════════
   *
   * The owner's instruction: each cycle produces at least three published calls, and a
   * new cycle begins once THOSE calls have closed. That second half is what this gate
   * is: while the open cohort still has calls working, the desk does not open another
   * one. It bounds concurrent exposure to the quota and makes each cohort's P&L
   * attributable to one cycle instead of smeared across an ever-rolling book.
   *
   * The obvious failure mode is a position that never closes taking the whole desk down
   * with it, so beginCyclePass force-closes a cohort past CYCLE_MAX_AGE_MS (6h) and
   * leaves its calls live — they keep being monitored and exited by monitorCalls and
   * the 45-second lane exactly as before, they simply stop holding the gate.
   *
   * Standing down still WARMS THE FREE FUNNEL, for the same reason the full-book branch
   * above does: the single most valuable moment in the desk's day is the one a slot
   * opens, and arriving at it cold costs four minutes in a market measured in minutes. */
  let cohort = null;
  let level = 0;
  let plan = escalationPlan(0);
  if (CYCLE.enabled) {
    cohort = beginCyclePass();
    if (cohort.waiting) {
      const warmed = await warmFunnelFn().catch((e) => ({ error: String(e?.message || e) }));
      const st = cycleStatus();
      emit("cycle:cohort_waiting", { cycle, cycleId: cohort.cycle.id,
        published: cohort.published, quota: cohort.quota, level: cohort.level,
        liveCallIds: cohort.liveCallIds,
        forceCloseInMin: Math.round((st.forceCloseInMs ?? 0) / 60000), warmed,
        note: "the cohort's calls are still working — a new cycle opens the moment the last one closes, " +
          "or when the deadlock guard force-closes this one" });
      /* considered/ranked are zeroed rather than omitted: index.js prints them on every
         cycle line, and an `undefined seen` in the operator's log reads as a fault. */
      return { cycle, skipped: "cohort_open", cycleId: cohort.cycle.id, opened: 0, workedUp: 0,
        considered: 0, ranked: 0, warmed, costUsd: 0, quota: cohort.quota,
        published: cohort.published, level: cohort.level, waitingOn: cohort.liveCallIds };
    }
    level = cohort.level;
    plan = escalationPlan(level);
    /* L4 ONLY: the SEARCH band. Set here and cleared at cycle end. Re-set on every
       cycle start, so an exception that skips the clear self-heals on the next pass
       rather than leaving a widened window behind it. Nothing safety-shaped is in it —
       the per-coin liquidity, volume, participation and age floors come from
       floorsFor(mcap) and are untouched at every level. */
    setCycleBandWindow(plan.mcapMin != null || plan.mcapMax != null ? plan : null);
    if (level > 0)
      emit("cycle:escalation", { cycle, cycleId: cohort.cycle.id, level, label: plan.label,
        published: cohort.published, quota: cohort.quota, relaxations: plan.relaxations,
        note: "the safety floor is unchanged at this and every level" });
  } else {
    setCycleBandWindow(null);
  }
  /* EFFORT (L1+): more coins, more cells, a longer hunt. Cost goes up; no standard
     moves. The daily money brake in llm.js and CYCLE_BUDGET_USD still bind. */
  workups = Math.max(1, Math.round(workups * plan.workupMultiplier));
  const perCell = Math.max(1, Math.round(PER_CELL * plan.perCellMultiplier));
  /** How many calls this pass is still trying to publish. 1 without a cohort — exactly
      the pre-cohort mandate of "every cycle ends in a call". */
  const want = cohort ? Math.max(0, cohort.quota - cohort.published) : 1;

  const startSpend = spend.usd;
  emit("cycle:start", { cycle, desk: "penthouse", cycleId: cohort?.cycle.id ?? null,
    level, want, workups });

  // MURDOCK reads the weather once per cycle. Risk-off (SOL and BTC both
  // negative over ~25d) grounds the ESTABLISHED sleeve — the one whose returns
  // ride the majors — per the TSMOM veto. Unknown weather never grounds anyone.
  const wx = await regime();
  emit("seat:verdict", { seat: "Regime", detail: `${wx.regime} · SOL ${wx.solRet25d}% / BTC ${wx.btcRet25d}% (25d)` });

  // 1-3. Everything free: sweep, the live launch feed, classify, screen.
  /* THE VOLUME LEVER L1-L4 LACKED. The ladder could widen the band, buy more workups and
     hunt longer, and still be walking the same ~108 keyword hits it had walked an hour
     earlier — every rung spending more money on a market that had not changed. This is
     the same universe the free warm pass builds (cohortUniverse above), so a coin the
     funnel screened while a position was open is a coin `bySweep` can now resolve. The
     younger arrivals mostly die FREE at the paid screen's h24 floors (evidence.js,
     SAFETY, untouched) — and a paid-screen kill is bench-replaced, never re-rulered. */
  const { universe, swept, igniting } = await cohortUniverse();
  const scored = [];
  const repeats = [];
  for (const c of universe) {
    if (liveCallFor(c.mint)) continue;                 // already holding a call on this one
    const cat = classify(c);
    const r = rank(c);
    if (r.score <= 0) continue;
    const row = { ...c, category: cat.category, categoryWhy: cat.why, score: r.score, rankWhy: r.why };
    /* DO NOT RE-BUY AN ANSWER THE DESK ALREADY HAS.
     *
     * The hunt lane and the fresh lane have both guarded against this for a while; the
     * main cycle never did, and it is the lane with only three slots to spend. The
     * result is in the record: of the last twenty coins the red team judged, DOGE-1
     * appears FIVE times and four others appear twice — roughly half the desk's most
     * expensive seat spent re-answering questions it had already answered.
     *
     * A high-ranked coin stays high-ranked, so without this the cycle picks the same
     * few names every 45 minutes and never reaches the rest of the market. */
    /* A REPEAT IS ONLY A REPEAT IF NOTHING HAS CHANGED.
     *
     * The guard skips anything judged in the last six hours, which was right when the
     * desk studied three coins every 45 minutes. It now studies eight every twenty —
     * 576 a day against a universe of about 296 — so it exhausts the fresh market in
     * roughly half an hour and then has nothing to look at. That is exactly what
     * studied=0 was: not refusals, an empty pool.
     *
     * But a coin whose price has moved 25% in an hour is not the same question it was.
     * Something happened to it, and the answer the desk wrote down before that is
     * about a different situation. So a material move re-opens the question, while a
     * coin sitting still stays closed — which keeps the fix that stopped DOGE-1 being
     * re-judged five times. */
    const moved = Math.abs(c.pair?.priceChange?.h1 ?? 0) >= 25;
    if (store.recentlyJudged(c.mint) && !moved) { repeats.push(row); continue; }
    if (moved && store.recentlyJudged(c.mint)) row.rankWhy = [...row.rankWhy, "re-opened: moved 25%+ since the desk last looked"];
    scored.push(row);
  }
  // ...unless the whole market is recently judged, in which case a stale look beats no
  // look at all. Ranked order still applies; the repeats simply queue behind fresh work.
  /* TOP UP RATHER THAN IDLE. This only fired when scored was COMPLETELY empty, so a
   * cycle with two fresh coins and eight slots studied two and wasted six. The desk
   * would rather re-examine a coin it has seen than end the cycle with nothing. */
  if (scored.length < workups && repeats.length) {
    const need = workups - scored.length;
    emit("cycle:topped_up", { fresh: scored.length, adding: Math.min(need, repeats.length),
      note: "not enough unseen coins to fill the cycle — re-examining the best already looked at" });
    scored.push(...repeats.slice(0, need));
  } else if (repeats.length) {
    emit("cycle:skipped_repeats", { skipped: repeats.length, fresh: scored.length,
      note: "coins judged in the last 6h were not re-bought" });
  }
  scored.sort((a, b) => b.score - a.score);

  // Whale flow is checked only on the coins already in contention. It costs ~25 RPC
  // reads per coin, so running it over all 345 would be wasteful; running it over the
  // top handful is what changes a decision.
  /* A TIME BUDGET, BECAUSE THIS IS WHERE CYCLES GO TO DIE.
   *
   * Measured, not guessed: 61 cycles started and only 40 finished — 21 began and never
   * came back, with no cycle:end for 1.7 hours while starts kept firing. The event
   * ordering placed the hang exactly here. `cycle:skipped_repeats` (emitted just above)
   * fired seconds ago; `cycle:prefiltered` (emitted just below) had not fired in half
   * an hour. The cycle was alive and stuck between the two.
   *
   * The cause is arithmetic: callouts() costs ~25 RPC reads per coin and this loops
   * over nine of them SEQUENTIALLY. That is ~225 calls against a public endpoint, with
   * no ceiling on how long they may take — and the coins now reaching this loop are
   * obscure micro-caps, which are the slowest of all to read.
   *
   * Whale flow is a RANKING NUDGE. It adjusts a score; it decides nothing. Letting an
   * optional signal hold the entire desk hostage inverts its importance, so it now
   * runs until it is done or until the budget expires, and the cycle continues with
   * whatever it managed to gather. */
  const whaleDeadline = Date.now() + Number(process.env.PENTHOUSE_WHALE_BUDGET_MS || 45_000);
  let whalesRead = 0, whalesSkipped = 0;
  for (const c of scored.slice(0, Math.max(8, workups * 3))) {
    if (Date.now() > whaleDeadline) { whalesSkipped++; continue; }
    try {
      const w = await callouts(c.mint, { scan: 24, deadline: whaleDeadline });
      whalesRead++;
      if (!w.ok) continue;
      const ws = whaleScore(w);
      c.whales = w;
      c.score += ws.score;
      c.rankWhy = [...c.rankWhy, ...ws.why];
      if (ws.why.length) {
        emit("whales", { mint: c.mint, symbol: c.pair?.baseSymbol,
          netUsd: w.netUsd, buyers: w.uniqueBuyers, sellers: w.uniqueSellers, delta: ws.score });
        recordWhaleCallout({ mint: c.mint, symbol: c.pair?.baseSymbol, launchpad: c.launchpad,
          netUsd: w.netUsd, buyers: w.uniqueBuyers, sellers: w.uniqueSellers, delta: ws.score });
      }
    } catch {}
  }
  if (whalesSkipped)
    emit("cycle:whales_timeboxed", { read: whalesRead, skipped: whalesSkipped,
      note: "whale flow is a ranking nudge, not a gate — the cycle moved on rather than stall" });
  scored.sort((a, b) => b.score - a.score);

  /* THE BOARD. Sort the whole market into cap band x coin type, shortlist the best few
   * in each cell, then spend the paid seats ACROSS the grid rather than down whichever
   * drawer the sweep happened to fill.
   *
   * The old shortlist took the top N by score, which meant a cycle could spend every
   * workup inside one band and learn nothing about the rest of the market — and an
   * empty cell would never even be noticed. Here an empty cell is a finding: "nothing
   * legitimate under $100k this hour" is worth knowing and used to be invisible. */
  const board = buildBoard(scored, { perCell, viable: (c) => wouldSurviveScreen(c) === null });
  // Preserve the exact free-screened shortlist before any paid analyst or choosing
  // seat sees it. The UI labels these candidates, never calls.
  try { recordCandidateBoard(cycle, board, { considered: universe.length }); }
  catch (error) { emit("board:record_failed", { error: String(error?.message || error) }); }
  emit("board:built", {
    considered: universe.length, offBoard: board.offBoard,
    cellsFilled: board.filled, cellsPossible: board.possible,
    cells: board.cells.map((c) => ({ cell: c.key, shortlisted: c.coins.length, seen: c.total,
      best: c.coins[0]?.pair?.baseSymbol ?? null })),
  });

  /* THE FUNNEL — where the desk stopped starting from nothing every pass.
   *
   * Until now this cycle was stateless: sweep, rank, screen, pay for eight workups,
   * publish or refuse, throw all of it away, and begin again from zero. On a slow asset
   * that is merely wasteful. On memecoins it is the wrong shape, for one reason that
   * costs money — when a position finally closed, the desk had NOTHING ready. It began
   * a cold sweep and arrived at a decision four minutes later, in a market whose moves
   * are measured in minutes. It was perpetually researching the market it had missed.
   *
   * So coins live in a standing population now and each pass advances them, rather than
   * recreating them. The division of labour between the two halves is deliberate:
   *
   *   the FUNNEL supplies memory   — what has been screened, what has been studied,
   *                                  what is researched and ready to trade right now
   *   the SWEEP supplies freshness — the live price, liquidity and volume
   *
   * Which is why only coins in the CURRENT sweep are eligible below. The funnel is
   * allowed to remember a verdict; it is never allowed to supply the numbers that
   * verdict gets acted on. A remembered price is exactly how a desk buys a pool that
   * was drained ten minutes ago. */
  funnel.observe(scored);
  const decayed = funnel.decay();

  // The free screen, run over the standing watch list rather than only over this
  // sweep's arrivals. Costs nothing and no model is involved.
  const bySweep = new Map(scored.map((c) => [c.mint, c]));
  let screenPassed = 0, screenHeld = 0;
  for (const row of funnel.dueForScreen(400)) {
    const c = bySweep.get(row.mint);
    if (!c) continue;
    const kill = wouldSurviveScreen(c);
    if (funnel.recordScreen(row.mint, kill) !== "held") screenPassed++; else screenHeld++;
  }

  const shape = funnel.census();
  emit("funnel:shape", {
    watch: shape.watch, screened: shape.screened, studied: shape.studied, ready: shape.ready,
    screenPassed, screenHeld,
    expired: { screen: decayed.screenExpired, verdict: decayed.studyExpired,
               moved: decayed.movedOut, lostSight: decayed.dropped },
    note: `${shape.ready} researched and ready before a slot even opens`,
  });

  /* PICK FROM THE STANDING POOL, not from the last ninety seconds of sweeping.
   *
   * A good name screened twenty minutes ago is still a candidate here. Under the old
   * selection it had been forgotten and was re-discovered from scratch, at full price,
   * every single pass. The board is kept as the fallback for a cold funnel — a first
   * boot, or a wiped database — because an empty funnel must not mean an idle desk. */
  const fromFunnel = funnel.dueForStudy(workups)
    .map((r) => bySweep.get(r.mint))
    .filter(Boolean);

  const shortlist = fromFunnel.length ? fromFunnel
    : board.cells.length ? selectAcrossBoard(board, workups)
    : selectShortlist(scored, workups);        // board empty too: fall back rather than idle
  emit("scout:shortlist", { count: shortlist.length, considered: universe.length,
    source: fromFunnel.length ? "funnel" : board.cells.length ? "board (funnel cold)" : "flat ranking",
    padMix: fromFunnel.length ? `${fromFunnel.filter((c) => c.launchpad === "pump.fun").length}/${fromFunnel.length} pump.fun` : null,
    mix: shortlist.map((c) => c.cellKey ?? c.category) });

  /* THE RESERVE BENCH.
   *
   * A slot lost to `no_data` is a slot lost for nothing. gather() fails before any
   * model is called, so an unreadable coin costs no money — but under the old loop it
   * still consumed one of the cycle's three chances, and the cycle ended having studied
   * one coin instead of three.
   *
   * That became common precisely BECAUSE of the two fixes above: skipping
   * recently-judged coins and screen-failures pushes the cycle further down the ranked
   * list into genuinely obscure micro-caps, which are exactly the coins with patchy
   * data. Ten `no_data` refusals in the last few minutes, against zero before.
   *
   * So an unreadable coin is replaced rather than mourned. Only free failures are
   * replaced — a coin that reached a seat and was refused has been PAID for and has
   * legitimately used its slot. */
  /* THE BENCH HOLDS ONLY COINS THE FREE SCREEN WOULD PASS. selectShortlist falls back
     to the raw ranked order when no viable coin is left — right for the shortlist (a
     cycle that studies nothing learns nothing), wrong for the bench: once the shortlist
     has taken every survivor, that fallback made the bench a queue of coins the screen
     would kill, and with paid-screen kills now bench-replaced (below) each pull would
     buy a gather() for a coin whose fate is already known. The simulation caught it:
     30 doomed coins reached seats in 60 cohorts. An empty bench is the honest answer. */
  const bench = selectShortlist(
    scored.filter((c) => !shortlist.some((s) => s.mint === c.mint) && wouldSurviveScreen(c) === null),
    workups * 3);
  const queue = [...shortlist];
  let replaced = 0;
  let replacedScreened = 0;      // of `replaced`, the paid-screen kills (step 14)

  /* 4. Only now does anything cost money — and now more than one coin at a time.
   *
   * COINS ARE INDEPENDENT OF EACH OTHER. A workup is eleven to thirteen model calls
   * with a genuinely sequential tail (red team, then risk, then the PM), so a single
   * coin cannot be made much faster — but nothing links one coin's workup to the next,
   * and the desk had never run two. Measured on the live server: a median of 8.6
   * minutes between full verdicts, which is a scheduling ceiling rather than a
   * thinking one.
   *
   * THE BUDGET STILL BINDS, and the work already running is RESERVED against it.
   * Re-reading the accumulator alone is not enough: a workup's cost lands only when it
   * finishes, so three workers checking a cap that nothing in flight has yet charged
   * would each start one more. Measured on a stub, three workers against a $3 cap at
   * $0.42 a workup overshot by $1.20 — half again the bound I had claimed. With every
   * running workup reserving its typical cost, the overshoot comes back to one workup,
   * which is the same bound the strictly-serial loop always had and the best any
   * check-then-spend scheme can offer. The daily budget and hourly pace brakes in
   * llm.js are untouched and absolute. Set PENTHOUSE_WORKUP_CONCURRENCY to 1 to
   * restore the old behaviour exactly.
   *
   * The scheduler itself is makeWorkupPool() above, because the mandate hunt below now
   * runs through the SAME pool — a lane that spends outside the cap is not bounded by
   * it. The reservation is stage-aware there too. */
  const picks = [];
  let workedUp = 0;
  let stopped = null;
  /* PARALLELISM IS WORTHLESS WHILE A PROVIDER IS DOWN, AND IT COSTS REAL MONEY.
   *
   * Every worker checks the credit guard in workup() and then buys the xAI reputation
   * read, which takes ~70s to come back. Three workers starting in the same instant all
   * pass that check honestly — the breaker really was closed — and all three have paid
   * before the first one's seats discover the balance is empty and reopen it. Measured
   * 2026-09-07 at 06:21:26: world, DRIP and FOMO bought three reads together, $0.47,
   * and not one of them reached an analyst.
   *
   * So the width of the batch is narrowed to one while the analyst provider is not
   * healthy. One worker can still lose a single read to that race, which is the floor
   * for any check-then-spend scheme, but the batch can no longer lose three. Nothing
   * about the breaker, the budget or the seats changes, and a healthy desk runs at the
   * configured width exactly as before — this only ever narrows, and only during an
   * outage the desk is already failing through. */
  const configuredConcurrency = Math.max(1, Math.min(6,
    Number(process.env.PENTHOUSE_WORKUP_CONCURRENCY || 3)));
  const analystHealthy = creditBreakerState("anthropic").state === "closed";
  const CONCURRENCY = analystHealthy ? configuredConcurrency : 1;
  if (!analystHealthy && configuredConcurrency > 1)
    emit("cycle:narrowed", { from: configuredConcurrency, to: 1,
      note: "the analyst provider is not healthy — a wide batch would only buy reads nobody can judge" });
  let cursor = 0;
  const studyOne = async (c) => {
    const hook = `house scan · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`;
    let rec;
    try {
      rec = await runFor(null, () => workup(cycle, c.mint, hook,
        { alwaysTicket: SEQUENTIAL, escalationLevel: level }));
    } catch (e) {
      // Out of credit is terminal: the remaining candidates cannot be worked up either,
      // and the cycle should end with what it has rather than crash the process.
      if (e instanceof OutOfCredit) {
        stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached" : "out of credit";
        emit("cycle:halted", { reason: e.constructor.name === "BudgetExhausted" ? "daily_budget" : "out_of_credit" });
        return "halt";
      }
      emit("cycle:error", { mint: c.mint, error: String(e.message) });
      return "error";
    }
    if (!rec || rec.outcome === "no_data" || rec.outcome === "screened_out") {
      // Free failure: nothing was asked of a model, so the slot is still unspent.
      // Pull the next coin off the bench rather than ending the cycle a candidate short.
      //
      // screened_out joined no_data here on 2026-09-08. The paid screen runs inside
      // workup() before any seat is bought (desk.js, stage 2) and costs $0 in models —
      // yet 89 of 500 workups (18%) ended screened_out and every one of them burned a
      // slot, so a fifth of each pass was spent on coins no analyst ever saw. Bench-
      // replacing them turns every slot into a PAID workup at $0 marginal cost; the
      // queue cap below still bounds a pass at workups*3 coins however barren the market.
      const reason = rec?.outcome === "screened_out" ? "screened_out" : "no_data";
      const next = bench.shift();
      if (next && queue.length < workups * 3) {
        replaced++;
        if (reason === "screened_out") replacedScreened++;
        queue.push(next);
        emit("cycle:replaced", { dropped: c.pair?.baseSymbol ?? c.mint?.slice(0, 6),
          reason, replacedWith: next.pair?.baseSymbol ?? next.mint?.slice(0, 6),
          note: reason === "screened_out"
            ? "a coin the paid screen kills before any seat costs nothing, so it must not cost a slot either"
            : "an unreadable coin costs nothing, so it must not cost a slot either" });
      }
      return reason;
    }
    workedUp++;                       // paid for, whatever the verdict turned out to be
    // THE COHORT. Every workup that got a verdict is a candidate, not only the ones
    // the CEO waved through — the mandate ranks the cohort and publishes its best.
    // Which of them are actually eligible is `eligibility()`'s job, and it refuses
    // every safety failure before conviction is even consulted.
    /* THE CURVE AND THE HIGH TRAVEL WITH THE PICK. The Best Pick brief reads them off
       the candidate the sweep shaped (`live`, pumpfun-live.js asCandidate) — the
       evidence bundle carries the deployer row and the birth tape but neither the
       curve's progress nor the ATH — and the funnel's SOL-per-minute reading is taken
       here, after this pass's observe(), so the seat sees the latest two readings. A
       keyword-sweep row has no `live` and reads null throughout: unmeasured, not clean. */
    let curveVelocity = null;
    try { curveVelocity = funnel.curveVelocity(c.mint); } catch { curveVelocity = null; }
    picks.push({ rec, category: c.category, launchpad: c.launchpad,
      conviction: rec.pm?.conviction ?? rec.conviction ?? null,
      live: c.live ?? null, onCurve: c.onCurve ?? null, curveVelocity });
    return "studied";
  };

  /* ONE POOL FOR THE WHOLE PASS — the shortlist walk here, the mandate hunt below.
     `stopped` stays owned by the cycle: the pool sets it on the cap, studyOne sets it on
     a credit halt, and every worker in both lanes reads the same flag. */
  const pool = makeWorkupPool({
    concurrency: CONCURRENCY,
    budgetUsd: CYCLE_BUDGET_USD,
    usedUsd: () => spend.usd - startSpend,
    isStopped: () => stopped,
    stop: (reason) => { stopped = reason; },
  });
  // The queue grows while it is being walked: a free failure pushes a replacement from
  // the bench, and the cursor must see it.
  await pool.run({
    take: () => (cursor < queue.length ? queue[cursor++] : null),
    study: studyOne,
  });
  if (CONCURRENCY > 1)
    emit("cycle:concurrency", { workers: CONCURRENCY, studied: workedUp,
      peakReservedUsd: Number(pool.peakReservedUsd().toFixed(4)),
      note: "coins are independent of one another; the budget cap is re-read per coin" });

  /* 5. THE COHORT PICK — choose, then publish up to `want`. The whole step is
   * publishCohort() below; `opened` is the live array the mandate hunt appends to. */
  const { opened } = await publishCohort({ picks, want, level, cohort, wx });

  /* THE MANDATE — every cycle ends in a call. Not by lowering the bar: by
   * refusing to stop interviewing. If the shortlist pass opened nothing, the
   * desk keeps working straight down the ranked list — same gauntlet per coin,
   * more coins — until a call is published, the ranked market is exhausted, or
   * the daily money brake calls time. Those are the only three exits: the
   * mandate can spend the whole day's budget hunting, but it cannot force a
   * seat to lie, because a forced call is just a loss with paperwork. */
  if (opened.length < want && process.env.PENTHOUSE_MUST_CALL !== "0") {
    const alreadyTried = new Set(shortlist.map((c) => c.mint));
    let hunted = 0;
    /* THE HUNT NEEDS A CLOCK TOO.
     *
     * It walks the ENTIRE ranked list — some eighty coins — and its only exits were a
     * published call, an exhausted market, or the money brake. But a coin that dies at
     * the free screen costs NOTHING, so the money brake never trips on the common
     * case: the hunt just keeps going, paying a `gather()` round trip per coin, for as
     * long as the market is large.
     *
     * That is the second half of why cycles were not finishing. The first was the
     * whale loop before the cohort pick; this is the same disease after it —
     * `cohort:ranked` fired ten minutes ago while `cycle:end` was still hours old.
     * An unbounded loop of cheap operations is still unbounded.
     *
     * A cycle that ends without a call is a fine outcome and the record already says
     * so. A cycle that never ends says nothing at all. */
    /* 240s -> 900s (PENTHOUSE_HUNT_BUDGET_MS, old default 240_000). At the measured
       8.6-minute median per workup the old timebox expired after ONE to THREE of them,
       so the lane that carries the mandate was cut off first and almost always. 900s is
       three full workups at the median, and the hunt now runs CONCURRENCY of them at a
       time, so the clock buys several more looks than it did serially. */
    const huntDeadline = Date.now() +
      Number(process.env.PENTHOUSE_HUNT_BUDGET_MS || HUNT_BUDGET_DEFAULT_MS) * plan.huntMultiplier;
    const huntMax = Math.round(Number(process.env.PENTHOUSE_HUNT_MAX || 12) * plan.huntMultiplier);
    /* THE HUNT RUNS THROUGH THE SAME POOL AS THE SHORTLIST WALK.
     *
     * It was a serial `for` that read neither `stopped` nor the cycle cap, so a pass
     * already cut off at its budget carried straight on spending — $21.68 against an $8
     * cap on cycle 19, for zero calls. Everything that made this loop cheap is still
     * here and still free (the already-tried set, the live-call check, recentlyJudged,
     * the risk-off veto and the free screen); it has simply moved into `take`, which the
     * pool calls one worker at a time before it reserves anything. */
    let ended = null;                       // hunt_capped / hunt_timeboxed, emitted once
    let huntCursor = 0;
    const takeHuntCoin = () => {
      while (huntCursor < scored.length) {
        if (opened.length >= want) return null;
        if (hunted >= huntMax) {
          if (!ended) { ended = "capped";
            emit("cycle:hunt_capped", { hunted, note: `stopped after ${huntMax} candidates — the cycle must end` }); }
          return null;
        }
        if (Date.now() > huntDeadline) {
          if (!ended) { ended = "timeboxed";
            emit("cycle:hunt_timeboxed", { hunted, note: "out of time — a cycle that never ends reports nothing" }); }
          return null;
        }
        const c = scored[huntCursor++];
        if (alreadyTried.has(c.mint) || liveCallFor(c.mint) || store.recentlyJudged(c.mint)) continue;
        if (wx.regime === "risk_off" && c.category === "established") continue;
        // The screen is free and already knows the answer for most of these. Paying a
        // gather() round trip to rediscover it is the loop's whole cost.
        const doomed = wouldSurviveScreen(c);
        if (doomed) continue;
        hunted++;
        emit("cycle:hunting", { symbol: c.pair?.baseSymbol, score: c.score, hunted });
        return c;
      }
      return null;
    };
    const huntOne = async (c) => {
      let rec;
      try {
        rec = await runFor(null, () => workup(cycle,
          c.mint, `the mandate · hunting for this cycle's call · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`,
          { alwaysTicket: SEQUENTIAL, escalationLevel: level }));
      } catch (e) {
        if (e instanceof OutOfCredit) {
          stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached mid-hunt" : "out of credit mid-hunt";
          emit("cycle:halted", { reason: "hunt_budget" });
          return;
        }
        emit("cycle:error", { mint: c.mint, error: String(e.message) });
        return;
      }
      // The hunt counts paid workups too: a paid-screen kill reached no seat (see the
      // worker above), so it neither counts nor goes to publishCall to be refused.
      if (!rec || rec.outcome === "no_data" || rec.outcome === "screened_out") return;
      workedUp++;
      /* THE QUOTA IS CHECKED AGAIN HERE, not only in `take`. Several hunt workups are in
         flight at once now, so two could finish behind a `want` that the first of them
         filled. publishCall is synchronous, so this check and the publish cannot be
         interleaved: the pass publishes exactly `want` and no more. */
      if (opened.length >= want) return;
      const pub = publishCall(rec, { category: c.category, launchpad: c.launchpad, wx,
        escalation: cohort ? level : null, cycleId: cohort?.cycle.id ?? null });
      if (pub.callId) opened.push({ id: pub.callId, symbol: rec.symbol });
    };
    await pool.run({ take: takeHuntCoin, study: huntOne });
    if (!opened.length && !stopped)
      emit("cycle:hunt_dry", { hunted, note: "the ranked market offered no coin that cleared the SAFETY gauntlet — " +
        "the mandate ranks conviction, it never overrides a measured fact, so a market of honeypots ends in no call" });
  }

  /* The widened band belongs to the pass that widened it. Cleared here; re-set at the
     top of every cycle, so even a throw cannot leave it widened for more than one. */
  setCycleBandWindow(null);

  const cost = spend.usd - startSpend;
  /* THE SHORTFALL, RECORDED RATHER THAN PAPERED OVER. A cycle that reached L4 and still
     could not find three publishes what it found and says so — "a cycle that publishes
     1 honestly is worth more than 3 with two unsellable". settleCycles() writes the
     shortfall flag when the cohort closes; this is the same fact on the tape, at the
     moment the pass that could not fill it ends. */
  let cohortEnd = null;
  if (cohort) {
    /* A PASS THAT COULD NOT THINK DOES NOT SPEND A RUNG.
     *
     * `stopped` here is a credit or budget halt. If it arrived before ONE SEAT WAS EVER
     * ASKED — no model spend at all — and nothing was published, this pass never got the
     * desk's judgement onto the market, so the rung it took at the top is handed back
     * and the next pass runs at the same level. Narrow on purpose: a halt that lands
     * after real research keeps its rung, because that research is what the level buys.
     *
     * The test is MONEY, not `workedUp`. Measured while building this: with the account
     * empty, `workedUp` still counted 2-4 per pass, because a coin the FREE screen kills
     * returns a verdict without asking anybody. Counting those as research left four
     * passes out of five still burning a rung during a total outage. Spend is the only
     * measure that cannot be fooled by a free refusal: no dollars, no seat, no rung. */
    const outage = stopped && /credit|budget/i.test(String(stopped)) ? String(stopped) : null;
    const researchless = Boolean(outage) && opened.length === 0 &&
      spend.usd - startSpend === 0;
    if (researchless) {
      const restored = abandonCyclePass(cohort.cycle.id, cohort.before, outage);
      if (restored) level = restored.escalation_level_reached;
    }
    const st = cycleStatus();
    cohortEnd = { cycleId: cohort.cycle.id, quota: cohort.quota,
      published: st.open ? st.published : cohort.published + opened.length,
      level, exhausted: level >= MAX_ESCALATION_LEVEL && !researchless };
    const short = Math.max(0, cohortEnd.quota - cohortEnd.published);
    if (short > 0)
      emit("cycle:short", { ...cohortEnd, short, stopped: stopped ?? null,
        /* SAY WHICH ONE IT WAS. A shortfall recorded while the account was empty read
           exactly like a shortfall recorded against a barren market — the same "the
           ladder is exhausted at L4" sentence — and the two call for opposite actions
           from the owner: fund the account, or accept the hour. */
        note: outage
          ? `THE OUTAGE, NOT THE MARKET: the pass could not research — ${outage}` +
            (researchless
              ? " — no seat was reached, so the rung was handed back and this level will be retried"
              : " — the research it had already paid for stands, and so does the rung") +
            ". The market this pass could not look at is unjudged."
          : level >= MAX_ESCALATION_LEVEL
            ? "the ladder is exhausted at L4 — the cohort publishes what it found and records the shortfall. " +
              "There is no level that publishes a safety-failed coin."
            : `still short by ${short}; the next pass runs at L${Math.min(MAX_ESCALATION_LEVEL, level + 1)}` });
  }
  emit("cycle:end", { cycle, count: opened.length, spendUsd: Number(cost.toFixed(4)), stopped,
    cohort: cohortEnd });
  /* Settle again: this pass may have met the quota, and a cohort whose calls all closed
     inside the pass (a fast nano band closes in minutes) must release the gate now
     rather than at the next tick. */
  if (cohort) { try { settleCycles(); } catch {} }
  return { cycle, considered: universe.length, ranked: scored.length,
    // The split, because "considered 108" and "considered 108 of which 40 the sweep
    // never sees" are different reports and only one of them says the lane is alive.
    sweptCount: swept.length, ignitingCount: igniting.length,
    workedUp, approved: picks.length, opened: opened.length, replacedUnreadable: replaced, replacedScreened,
    costUsd: Number(cost.toFixed(4)), costPerWorkup: workedUp ? Number((cost / workedUp).toFixed(2)) : null,
    stopped, cycleId: cohort?.cycle.id ?? null, level, quota: cohort?.quota ?? null,
    published: cohortEnd?.published ?? null, want };
}

/**
 * 5. THE COHORT PICK — of everything studied, choose the best and publish up to `want`.
 *
 * This replaced an absolute bar that produced 144 kills and zero calls across 177
 * workups. The bar is not lowered on SAFETY: eligibility() refuses every screened,
 * killed, vetoed, unexitable, stopless or refuted candidate first, and refuses the
 * team's own PASS on top of that. What changed is that a lack of CONVICTION — the
 * CEO holding, the PM wanting one more trigger — now ranks rather than blocks.
 *
 * It is a function rather than a stretch of the cycle body so the field the choosing
 * seat is handed can be driven directly (test-bestpick-after-eligibility.mjs): `picks`
 * is the studied cohort exactly as the workers built it, and `bestPickFn` / `publish`
 * default to the real seat and the one road — only a test ever replaces them. `opened`
 * comes back as the live array, because the mandate hunt after this keeps appending
 * to the same list.
 */
export async function publishCohort({ picks = [], want = 1, level = 0, cohort = null, wx = null,
  bestPickFn = runBestPick, publish = publishCall } = {}) {
  const opened = [];
  const { winner: arithmeticWinner, judged } = pickOne(picks);
  const eligible = judged.filter((j) => j.eligibility.eligible);
  /* The stamp every publish below carries. A null escalation means no quota is
     pursuing this and publishCall applies no bar — computed once, here, so the seat's
     field and the road's gate can never be read at two different levels. */
  const escalation = cohort ? level : null;
  const cycleId = cohort?.cycle.id ?? null;

  /* THE QUOTA BAR RUNS BEFORE THE SEAT, NOT ONLY AFTER IT.
   *
   * Best Pick is an Opus call at $0.087-0.10 (the live 24h bought one, $0.10), and it
   * was paid on the whole eligible field — while the bar inside publishCall then
   * refused part of that same field on arrival: call:withheld conviction_below_bar 7
   * and tier_below_bar 5 in the window. A seat asked to choose among coins the bar
   * will not let it publish is choosing for nobody. So the same cohortEligibility, at
   * the same level publishCall will run it at, narrows the field first. It refuses
   * nothing the road would not have refused a moment later; it only stops paying an
   * Opus seat to rank it. */
  const publishable = escalation == null ? eligible
    : eligible.filter((j) => cohortEligibility(j.rec, escalation).publishable);

  /* THE SEAT THAT CHOOSES.
   *
   * pickOne ranks by arithmetic — tier x 100000 + conviction x 100 + composite — which
   * is defensible and blind. It cannot see that one coin's story is a trend three hours
   * old while another's peaked yesterday, or that a real account with reach posted one
   * and a bought network posted the other. Those decide a memecoin, and a weighted
   * average of five scores cannot represent them.
   *
   * So an agent picks, from the eligible field only. Everything in front of it has
   * already cleared the safety screen, the analysts, the red team and compliance — it
   * cannot admit a honeypot because none reaches it. The arithmetic winner stays as the
   * fallback for when the seat errors or names something that is not on the list. */
  let winner = arithmeticWinner;
  /* ...AND ONLY WHEN CHOOSING CAN CHANGE WHAT IS PUBLISHED. With `want` or fewer
     publishable, the walk below publishes every one of them whichever the seat
     preferred, so the $0.10 would buy an ordering nobody acts on. `want` is 1 without
     a cohort — the original `> 1` exactly — and a field of one is never a choice. */
  if (publishable.length > Math.max(1, want)) {
    try {
      const bp = await runFor(null, () => bestPickFn(publishable));
      const chosen = publishable.find((j) => j.rec?.mint === bp?.pick_mint);
      if (chosen) {
        winner = chosen;
        winner.bestPick = bp;
        emit("bestpick:chose", { symbol: bp.pick_symbol, mint: bp.pick_mint,
          why: bp.why, edge: bp.edge, expected: bp.expected_move,
          confidence: bp.confidence, runnerUp: bp.runner_up_mint,
          overrodeArithmetic: arithmeticWinner?.rec?.mint !== bp.pick_mint });
      } else {
        emit("bestpick:unusable", { named: bp?.pick_mint ?? null, candidates: publishable.length,
          note: "the seat named something not on the list — falling back to the ranking" });
      }
    } catch (e) {
      emit("bestpick:failed", { error: String(e?.message || e),
        note: "falling back to the arithmetic ranking rather than skipping the cycle" });
    }
  } else if (eligible.length > 1) {
    emit("bestpick:skipped", { eligible: eligible.length, publishable: publishable.length, want,
      note: publishable.length > 1
        ? "the field fits the quota — every publishable candidate is published, so the seat could not change what"
        : "at most one candidate clears the quota bar — there is nothing to choose between" });
  }
  /* Write every paid verdict back, so the next pass INHERITS it instead of re-buying
   * it. This is the half of the funnel that actually saves money — the screen is free,
   * the workup is not, and until now the desk paid for the same answer about the same
   * coin every time it came round again. */
  for (const j of judged) {
    try {
      funnel.recordStudy(j.rec?.mint, {
        eligible: !!j.eligibility.eligible,
        verdict: j.rec?.pm?.decision ?? null,
        conviction: j.rec?.pm?.conviction ?? j.eligibility.score ?? null,
        thesis: j.rec?.pm?.thesis ?? null,
      });
    } catch { /* bookkeeping must never be able to fail a cycle */ }
    if (j.eligibility.eligible) continue;
    emit("cohort:declined", { mint: j.rec?.mint, symbol: j.rec?.symbol,
      safety: j.eligibility.safety, reason: j.eligibility.reason });
  }
  emit("cohort:ranked", { studied: judged.length,
    eligible: eligible.length, publishable: publishable.length, want,
    winner: winner ? { symbol: winner.rec?.symbol, tier: winner.eligibility.tier,
      why: winner.eligibility.reason } : null });

  if (winner) {
    const pub = publish(winner.rec, { category: winner.category, launchpad: winner.launchpad, wx,
      bestPick: winner.bestPick ?? null,
      escalation, cycleId });
    if (pub.callId) opened.push({ id: pub.callId, symbol: winner.rec?.symbol });
    // Out of the ready pool: the desk is holding this one, not still shopping for it.
    try { funnel.retire(winner.rec?.mint, "published as a call"); } catch {}
  }

  /* EVERY CYCLE ENDS IN A TRADE — and this is where that instruction is safe to obey.
   *
   * The eligible field has already cleared the free safety screen, all five analysts,
   * the red team and compliance. Nothing in it is a honeypot, nothing in it is
   * unsellable, nothing in it was launched by a farm. So if the first choice could not
   * be published for a reason that is NOT about the coin — the book filled, a weather
   * veto, a race with another lane — the desk takes the next eligible candidate rather
   * than ending the cycle empty.
   *
   * It walks the field in order and stops at the first one that lands. What it will
   * never do is reach past eligibility: a cycle where every candidate failed a measured
   * safety fact ends with no call, and says so. That is not the desk refusing to
   * decide, it is the market not having offered anything holdable. */
  /* AND THEN THE REST OF THE COHORT'S QUOTA. Without a cohort `want` is 1 and this is
     the pre-existing fallback verbatim: take the next eligible rather than end empty.
     With one, the same walk keeps going until the quota is met — from the SAME eligible
     field, which has already cleared the safety screen, all five analysts, the red team
     and compliance. It never reaches past eligibility to find a third. */
  if (opened.length < want && eligible.length > 1) {
    for (const cand of eligible) {
      if (opened.length >= want) break;
      if (cand === winner) continue;
      const pub = publish(cand.rec, { category: cand.category, launchpad: cand.launchpad, wx,
        escalation, cycleId });
      if (pub.callId) {
        opened.push({ id: pub.callId, symbol: cand.rec?.symbol });
        emit("mandate:fellback", { symbol: cand.rec?.symbol,
          from: winner?.rec?.symbol ?? null, want, opened: opened.length,
          note: "the first choice could not be published — took the next eligible rather than ending empty" });
      }
    }
  }
  return { opened, judged, eligible, publishable, winner };
}

/**
 * Watch the open calls. Deliberately cheap: prices and chain flags only, no model calls,
 * so it can run often without the monitoring costing more than the research.
 */
/* THE FRESH LANE. A six-hour cycle is never early. This runs cheap and often:
 * sweep, keep only coins under 48h old, rank them, and only when the best one
 * shows real ignition does it earn a full workup — one per scan, the budget
 * brake underneath as always. Early is a schedule, not a speed. */
/**
 * THE ONE ROAD from a workup to a live, broadcast call. Every lane — the cohort pick,
 * the mandate hunt, fresh ignition, watch promotion — publishes through here, so the
 * gates can never drift apart between them.
 *
 * Two things are enforced here and nowhere else, because here is the only place they
 * cannot be bypassed:
 *
 *   THE BOOK GATE. One live call at a time. Four lanes run on four different timers;
 *   without a check at the single choke point, two of them firing a minute apart would
 *   quietly put the desk two positions deep and break the mandate the owner asked for.
 *
 *   ELIGIBILITY. Which is where safety lives — screened, killed, vetoed, unexitable,
 *   stopless, refuted and PASSed candidates are refused by mandate.js before conviction
 *   is consulted at all. The mandate lowered the CONVICTION bar; it did not touch this.
 */
/**
 * MAY THIS BECOME ONE OF THE CYCLE'S CALLS, AT THIS ESCALATION LEVEL?
 *
 * THE ORDER OF THESE THREE CHECKS IS THE WHOLE SAFETY ARGUMENT, and it is written so
 * that no future edit can reorder it without the test in test-quota-escalation.mjs
 * failing loudly:
 *
 *   1. SAFETY FIRST, and it does not take `level` as an argument at all. A quota cannot
 *      reach past a measured fact, so the code that applies the floor is not even given
 *      the number it would have to consult in order to bend. 32 codes, classified in
 *      exactly one place (calls.js GATE_CLASS), with UNKNOWN defaulting to SAFETY.
 *   2. THE EXISTING GATE, unchanged. mandate.eligibility() still runs and still refuses
 *      everything it refused before. The ladder can only ever be STRICTER than the old
 *      behaviour, never looser — it adds a bar, it removes none.
 *   3. THE LEVEL'S JUDGEMENT BAR. Only here does `level` do anything, and all it can
 *      touch is conviction and tier.
 *
 * Measured reason this shape exists: most of the last 100 kills are safety mechanics —
 * honeypot controls, the launch farm, the graduate dead zone, a bundled float. Three
 * calls filled from that pool are three bags, not three trades, so filling the quota
 * that way defeats the quota's own purpose.
 *
 * The count used to read "~60, 18 of them cannot_exit". Re-measured 2026-09-07: 12 of
 * those 100 died on `cannot_exit` ALONE and that gate is deleted — it was a cost
 * ceiling quoted at $75 for a bot that trades about $2, which is not a safety fact at
 * all. The safety pool this ladder must never reach past is genuinely smaller now.
 */
export function cohortEligibility(rec, level = 0) {
  const plan = escalationPlan(level);
  const gates = gateFailures(rec);
  const safety = gates.filter((g) => g.cls === "SAFETY");
  if (safety.length)
    return { publishable: false, safety: true, level: plan.level, gate: safety[0].code,
      gates: safety.map((g) => g.code),
      reason: `SAFETY FLOOR (L${plan.level}): ${safety.map((g) => g.code).join(", ")} — ` +
        `${safety[0].detail ?? "a measured fact"}. No escalation level and no quota reaches past this.` };

  const e = eligibility(rec);
  if (!e.eligible) {
    const judgment = gates.find((g) => g.cls === "JUDGMENT");
    return { publishable: false, safety: !!e.safety, level: plan.level,
      gate: judgment?.code ?? (e.safety ? "unclassified_refusal" : "team_no"), reason: e.reason };
  }

  const conviction = Number(rec?.pm?.conviction ?? 0);
  if (e.tier < plan.minTier)
    return { publishable: false, safety: false, level: plan.level, gate: "tier_below_bar",
      reason: `tier ${e.tier} (${e.reason}) is below the L${plan.level} bar of ${plan.minTier}` };
  if (conviction < plan.minConviction)
    return { publishable: false, safety: false, level: plan.level, gate: "conviction_below_bar",
      reason: `conviction ${conviction} is below the L${plan.level} bar of ${plan.minConviction}` };

  return { publishable: true, safety: false, level: plan.level, tier: e.tier, conviction,
    reason: e.reason, relaxations: [...plan.relaxations, ...(rec?.relaxations ?? [])] };
}

export function publishCall(rec, { category = null, launchpad: pad = null, wx = null,
  toFloors = null, bestPick = null, sourceFloor = null,
  /* THE COHORT STAMP. Both default to null, and a null `escalation` means "no quota is
     pursuing this" — the lane publishes exactly as it did before the cohort existed.
     Only the cycle passes them, so a tenant's own floor run, a watch promotion and a
     trend handoff are untouched by any of this. */
  escalation = null, cycleId = null } = {}) {
  const e = eligibility(rec);

  /* THE PUBLISHABILITY LEDGER, written on EVERY way out of this function for a record
     the PM liked. "P(>=3 per cohort)" has only ever been estimated from the PM-positive
     rate (14.3% per paid read) times an assumed publishable fraction, and that fraction
     was never measured under the recalibrated bar: today 13 WATCH → 0 cohort calls
     with nothing naming the gate. The row is bookkeeping and must never fail a publish;
     `refusedBy` is the raw gate, and calls.publishabilityGate decides the column. */
  const ledger = (refusedBy, outcome, callId = null) => {
    try { recordPublishability(rec, { refusedBy, outcome, escalation, cycleId, callId }); } catch {}
  };
  /* The lanes never run cohortEligibility, so their refusal is charged the way it
     would have been: the first SAFETY code, else the first JUDGMENT code, else the
     team's own no. */
  const mandateGate = () => {
    const gates = gateFailures(rec);
    return gates.find((g) => g.cls === "SAFETY")?.code ?? gates.find((g) => g.cls === "JUDGMENT")?.code
      ?? (e.safety ? "unclassified_refusal" : "team_no");
  };

  /* RECORD THE VERDICT HERE, because this is the one place EVERY lane converges.
   *
   * The funnel was being written only by the main cohort loop, so the hunt lane and the
   * fresh lane paid for workups the funnel never heard about. The instrument then read
   * studied=0 while the desk was visibly producing PM decisions — a number that was
   * wrong in the direction of "nothing is happening", which is the worst direction for
   * a number to be wrong in and cost an hour today already.
   *
   * The UPDATE is keyed on the mint and is a no-op for a coin the funnel has not seen,
   * so recording twice for the main cohort is harmless. */
  try {
    funnel.recordStudy(rec?.mint, {
      eligible: !!e.eligible,
      verdict: rec?.pm?.decision ?? null,
      conviction: rec?.pm?.conviction ?? null,
      thesis: rec?.pm?.thesis ?? null,
    });
  } catch { /* bookkeeping must never be able to fail a publish */ }

  /* THE QUOTA BAR, when a quota is pursuing this call. Placed here — after the funnel
     write above and sharing the refusal bookkeeping below — because a refusal the
     SHADOW BOOK never hears about is a refusal nobody can grade later, and "we are
     being appropriately careful" and "we are missing everything" then look identical
     from outside. It can only ever refuse MORE than the old gate, never less:
     cohortEligibility runs the safety floor first and mandate.eligibility() second, so
     anything it admits still has to clear `e` below. */
  const co = escalation != null ? cohortEligibility(rec, escalation) : null;
  if (co && !co.publishable) {
    emit("call:withheld", { mint: rec?.mint, symbol: rec?.symbol, safety: co.safety,
      level: co.level, gate: co.gate, reason: co.reason });
    try {
      const ev = rec?.ev ?? {};
      shadow.recordRefusal({ mint: rec?.mint, symbol: rec?.symbol ?? ev.symbol,
        stage: co.safety ? "cohort_safety" : "cohort_quota_bar",
        reason: `L${co.level} ${co.gate}: ${co.reason}`, safety: co.safety,
        priceUsd: ev.pair?.priceUsd, mcapUsd: ev.pair?.marketCap ?? ev.pair?.fdv });
    } catch {}
    ledger(co.gate, co.safety ? "unsafe" : "declined");
    return { outcome: co.safety ? "unsafe" : "declined", reason: co.reason,
      gate: co.gate, level: co.level };
  }

  if (!e.eligible) {
    emit("call:withheld", { mint: rec?.mint, symbol: rec?.symbol,
      safety: e.safety, reason: e.reason });
    /* THE SHADOW BOOK. Every refusal is written down with the price it was refused at,
     * so the desk can later be graded on what it turned DOWN. Without this, "we are
     * being appropriately careful" and "we are missing everything" are the same
     * observation — which is exactly the argument ZCAT started. */
    try {
      const ev = rec?.ev ?? {};
      shadow.recordRefusal({
        mint: rec?.mint, symbol: rec?.symbol ?? ev.symbol,
        stage: rec?.outcome === "screened_out" ? "screen"
             : rec?.outcome === "killed" ? "seat"
             : rec?.compliance?.pass === false ? "compliance" : "mandate",
        reason: e.reason, safety: e.safety,
        priceUsd: ev.pair?.priceUsd, mcapUsd: ev.pair?.marketCap ?? ev.pair?.fdv,
      });
    } catch {}
    ledger(mandateGate(), e.safety ? "unsafe" : "declined");
    return { outcome: e.safety ? "unsafe" : "declined", reason: e.reason };
  }

  // MURDOCK's weather veto. Not in eligibility() because it is a fact about the
  // MARKET rather than about the token, and only the cycle knows the weather.
  if (wx?.regime === "risk_off" && category === "established") {
    emit("call:withheld", { mint: rec.mint,
      reason: `MURDOCK: not flying weather — SOL ${wx.solRet25d}% / BTC ${wx.btcRet25d}% over 25d` });
    ledger("risk_off", "withheld");
    return { outcome: "withheld", reason: "risk_off" };
  }

  const book = bookState();
  if (book.full) {
    emit("call:withheld", { mint: rec.mint, symbol: rec.symbol,
      reason: `already holding ${book.holding?.symbol ?? "a position"} — one call at a time` });
    ledger("book_full", "book_full");
    return { outcome: "book_full", reason: "position_open" };
  }

  const ev = rec.ev ?? {};
  const call = openCall({
    mint: rec.mint, symbol: rec.symbol ?? ev.symbol, category, launchpad: pad,
    sourceFloor,
    sourceScope: sourceFloor == null || Number(sourceFloor) === 50 ? "house" : "tenant",
    sourceAttributed: true,
    conviction: rec.pm?.conviction ?? null,
    imageUrl: ev.pair?.imageUrl ?? null,
    entryRef: ev.pair?.priceUsd ?? null,
    stop: Number(rec.ticket?.stop_price),
    target: rec.ticket?.take_profit?.[0]?.price ?? null,
    thesis: rec.pm?.thesis ?? null,
    invalidation: rec.pm?.invalidation ?? null,
    flags: ev.mintAccount?.error ? null : (ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f),
    liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
    rtLossPct: ev.exitProbe?.roundTripLossPct ?? null,
    // Preserve the team's actual authorization. Floors may be more conservative,
    // but they may never silently throw this away and size larger on their own.
    deskSizeUsd: rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd ?? null,
    deskRiskUsd: rec.risk?.max_loss_usd ?? null,
    deskEquityUsd: cfg.equityUsd,
    // Stored so a tenant's micro / low / mid sleeve filter has a number to test.
    mcapUsd: ev.pair?.marketCap ?? ev.pair?.fdv ?? null,
    reportFile: rec.reportFile ?? null,
    cycleId, escalationLevel: escalation,
  });
  if (call) {
    const evidenceLinked = linkPublishedCall(rec.decisionRunId, call.id, { floorNo: sourceFloor });
    if (evidenceLinked) {
      /* Provenance rows carry NO mark. They used to pass call.entry_ref, so one
       * observation wrote two-to-three identical marked rows and the two-witness pair
       * rule saw a single read "confirm" itself — silently voiding the invariant for
       * any event kind that writes a mark. The entry price already lives on
       * calls.entry_ref; these rows are narrative, not observations. */
      noteEvent(call.id, "evidence", "linked to immutable decision evidence");
    } else {
      // Direct/manual callers may not carry a decision row. Keep the call operational,
      // but exclude it from policy-learning evidence and make the gap visible.
      noteEvent(call.id, "evidence_unlinked",
        "not eligible for strategy scorecards: no matching attributed decision");
      emit("call:evidence-unlinked", { callId: call.id, sourceFloor });
    }
    // The record shows HOW FAR DOWN the desk reached for this one. A tier-4 call is
    // an approval; a tier-1 call is the mandate taking the cohort's best available
    // when nothing was approved. Both are legitimate, and they are not the same
    // thing, so the difference goes on the call rather than into a footnote.
    noteEvent(call.id, "mandate", `${e.reason} (tier ${e.tier})`);
    /* HOW HARD THE DESK HAD TO REACH, ON THE CALL ITSELF. The owner must be able to
       read "this was published at L3 because the cycle was short" off the record; a
       relaxation that lives only in a log is a silent lowering. L0 is recorded too —
       "nothing relaxed" is the fact a reader most needs when the level is zero. */
    if (escalation != null) {
      const relaxed = [...escalationPlan(escalation).relaxations, ...(rec.relaxations ?? [])];
      noteEvent(call.id, "escalation",
        `published at L${escalation}${cycleId != null ? ` in cycle ${cycleId}` : ""}: ` +
        (relaxed.length ? relaxed.join(" | ") : "nothing relaxed — this is an ordinary call"));
      recordCyclePublish(cycleId, call.id, escalation);
    }
    // Why the choosing seat picked THIS one, on the call itself — so the record shows
    // the reasoning next to the outcome rather than only the outcome.
    if (bestPick?.why)
      noteEvent(call.id, "bestpick",
        `${bestPick.why} | edge: ${bestPick.edge} | expects ${bestPick.expected_move} | worst case: ${bestPick.worst_case}`);
    /* THE HOUSE TRADES ITS OWN CALLS TOO.
     *
     * `owned` alone meant floor 50 — the HQ, whose state is 'hq' because it is never
     * for sale — was the one floor that never received the calls it had just written.
     * The desk published for everybody except itself, so the house could not put a
     * cent behind its own research and had no skin in the game its tenants took on.
     *
     * The HQ is fed through exactly the same road as a tenant: a delivery row, its own
     * copy settings, its own executor secret, and a poller the owner runs on their own
     * machine with their own wallet. The server gains no key and no custody by this —
     * it still only publishes rows. What changes is that the house eats its own
     * cooking, and its results land in the same graded record as everyone else's. */
    /* `toFloors` narrows the audience to one desk. A tenant's OWN paid research run
     * publishes through here, and the coin it approved is theirs — one floor spending
     * 250,000 $CLAUDECO must not put every other floor into a position. Only the house
     * lanes broadcast to the whole building. */
    const floors = toFloors ?? listFloors()
      .filter((f) => f.state === "owned" || f.n === HQ_FLOOR)
      .map((f) => f.n);
    if (floors.length) broadcast(call.id, floors);
    emit("call:published", { callId: call.id, symbol: call.symbol, tier: e.tier, why: e.reason,
      cycleId, level: escalation });
    ledger("published", "published", call.id);
    return { outcome: "published", callId: call.id, tier: e.tier, level: escalation, cycleId };
  }
  ledger("open_failed", "open_failed");
  return { outcome: "open_failed" };
}

/**
 * THE PROMOTION PASS — the criteria, acted on. Free until a watch's rules hold;
 * then ONE promoted token per pass goes back through the entire paid gauntlet
 * with the watch context in its hook. Promotion buys a re-examination, never a
 * shortcut: the analysts, red team, risk, PM, compliance and CEO all sit again.
 */
/**
 * THE TWO FREE FACTS AN OPPORTUNISTIC LANE READS BEFORE IT PAYS.
 *
 * Fresh, promote and the trend handoff each asked whether the book had a seat, and
 * none asked whether the analysts could sit in it — so through an outage they went on
 * buying workups whose seats were refused on arrival, the research half of the 32
 * scans / $3.47 the trend lane paid in the live 24h with both breakers open and every
 * pass abandoned as researchless. Both facts cost nothing, so they are read first and
 * the same way in all three lanes. Strictly `closed`, as the cycle reads it at
 * analystHealthy: the 12-minute cycle is the probe that reopens the analysts, and
 * these lanes are not — a due probe is no reason for a 5-minute lane to spend.
 *
 * Returns the skip to hand back, or null when the lane may go on. The breaker skip
 * carries `halted` because the callers already print that field for a credit halt;
 * the book skip stays quiet, as it always has.
 */
function laneGate() {
  const book = bookState();
  if (book.full)
    return { skipped: "position_open", holding: book.holding?.symbol ?? null, live: book.live };
  const credit = creditBreakerState("anthropic");
  if (credit.state !== "closed")
    return { skipped: "credit_breaker_open", breaker: credit.state,
      halted: `analyst breaker ${credit.state} — a workup nobody can judge is not bought` };
  return null;
}

let promoteBusy = false;
export async function promoteWatches() {
  if (promoteBusy) return { skipped: "busy" };
  // One trade at a time, and one provider that can judge: a promotion cannot open a
  // second position, so it must not pay for a workup it could never publish either.
  const gate = laneGate();
  if (gate) return gate;
  promoteBusy = true;
  try {
    const { checkWatchlist } = await import("./watchlist.js");
    const { checked, promoted } = await checkWatchlist();
    if (!promoted.length) return { checked, promoted: 0 };
    /* THE THIRD LANE THAT NEVER LEARNED THE SCREEN.
     *
     * `too_big` kept firing after both the cycle and the fresh lane were fixed, because
     * this one still worked up whatever the watchlist promoted. Watches were added
     * before the market-cap ceiling existed, so the list is full of coins the desk
     * would now refuse on sight — and promoting one buys a workup to rediscover that.
     *
     * A promotion means "the rules I set have held". It does not mean the coin is still
     * something this desk trades. */
    const w = promoted.find((x) => {
      if (liveCallFor(x.mint)) return false;
      const doomed = x.pair ? wouldSurviveScreen(x) : null;
      if (doomed) {
        emit("watch:stale", { mint: x.mint, symbol: x.symbol, reason: doomed,
          note: "watched before the screen moved — it would be refused on arrival" });
        return false;
      }
      return true;
    });
    if (!w) return { checked, promoted: promoted.length, outcome: "none still tradeable" };

    const hook = `watch promoted \u00b7 ${w.symbol ?? w.mint.slice(0, 6)} \u00b7 rules held: ` +
      Object.entries(w.rules).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(", ");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), w.mint, hook,
      { alwaysTicket: SEQUENTIAL, lane: "promote" }));

    let category = null, pad = null;
    try {
      const c = { mint: w.mint, pair: rec?.ev?.pair };
      category = classify(c).category; pad = launchpad(c);
    } catch {}
    const pub = publishCall(rec, { category, launchpad: pad });
    return { checked, promoted: promoted.length, workedUp: 1, outcome: pub.outcome };
  } catch (e) {
    if (e instanceof OutOfCredit) return { halted: e.message };
    return { error: String(e.message || e) };
  } finally { promoteBusy = false; }
}

/**
 * THE NAMING RACE — the Grok-trade mechanism, read off the chain instead of X.
 *
 * The documented $42k-in-15-minutes Grok trade worked like this: a high-reach
 * X event with a NAMEABLE gap fires, dozens of tokens launch racing to claim
 * the name, one wins the race and runs 11x while the rest die. We do not need
 * an X feed to see the race: when several very young launches share a name
 * inside the same few hours, that cluster IS the on-chain shadow of a trending
 * event. The tradeable fact is the race itself — back only the coin WINNING it
 * (deepest book + our normal ignition read), and mark the losers untouchable,
 * because a naming race pays exactly one winner.
 */
export function namingRaces(universe) {
  const stop = new Set(["coin", "token", "the", "official", "meme", "solana", "sol", "pump", "fun", "inu", "ai"]);
  const clusters = new Map();
  for (const c of universe) {
    const age = c.pair?.ageHours ?? 0;
    if (age <= 0 || age > 12) continue;                       // the race is hours old, not days
    const words = `${c.pair?.baseSymbol ?? ""} ${c.pair?.baseName ?? ""}`
      .toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
    for (const w of new Set(words)) {
      if (!clusters.has(w)) clusters.set(w, []);
      clusters.get(w).push(c);
    }
  }
  const races = new Map();   // mint -> {theme, size, leader}
  for (const [theme, coins] of clusters) {
    const distinct = [...new Map(coins.map((c) => [c.mint, c])).values()];
    if (distinct.length < 4) continue;                        // four rivals in 12h = an event, not a coincidence
    distinct.sort((a, b) => (b.pair?.liquidityUsd ?? 0) - (a.pair?.liquidityUsd ?? 0));
    const leader = distinct[0].mint;
    for (const c of distinct) {
      const prev = races.get(c.mint);
      if (!prev || distinct.length > prev.size)
        races.set(c.mint, { theme, size: distinct.length, leader: c.mint === leader });
    }
  }
  return races;
}

let freshBusy = false;
/**
 * THE LORE LANE'S ONE HANDOFF.
 *
 * scanTrends pays Grok to read what X is accelerating on and then finds the coin
 * wearing that story. Until now the caller logged the winner's name and dropped it, so
 * the desk was buying a front-run signal every twelve minutes and throwing the answer
 * away — the one thing the lane exists to produce. This takes the top candidate through
 * exactly the same gauntlet as every other coin: same screen, same seats, same red team,
 * same publish. Being early is a reason to LOOK, never a reason to skip a check.
 */
export async function trendHandoff(candidates = []) {
  const top = candidates[0];
  if (!top?.mint) return { workedUp: 0, note: "no candidate" };
  if (liveCallFor(top.mint)) return { workedUp: 0, note: "already live" };
  // scanTrends read the same two facts before it paid for the scan; the seconds between
  // the two are enough for a call to open or a breaker to trip, so the workup asks again.
  const gate = laneGate();
  if (gate) return { workedUp: 0, ...gate, halted: gate.halted ?? `book full at ${gate.live}` };
  const hook = `trend front-run \u00b7 "${top.theme}" (${top.stage ?? "?"}) \u00b7 ` +
    `${top.whyNow ?? ""} \u00b7 establish whether THIS is the canonical token for that story; ` +
    "a naming race pays one winner and the rest are exit liquidity";
  const rec = await runFor(null, () => workup(
    new Date().toISOString().replace(/[:.]/g, "-"), top.mint, hook,
    { alwaysTicket: SEQUENTIAL, lane: "trend" }));
  const pub = publishCall(rec, { category: rec?.ev?.category ?? "memecoin", launchpad: "pump.fun" });
  return { workedUp: 1, symbol: top.symbol, theme: top.theme,
    outcome: pub.outcome ?? rec?.outcome ?? rec?.finalDecision };
}

export async function freshScan({ minScore = 45 } = {}) {
  if (freshBusy) return { skipped: "busy" };
  // Same rule as every other lane: while a call is working, or while no analyst can
  // sit, the fresh lane does not buy a workup it has no seat to publish into.
  const gate = laneGate();
  if (gate) return gate;
  freshBusy = true;
  try {
    const universe = await sweep();
    const races = namingRaces(universe);
    const young = [];
    for (const c of universe) {
      if (liveCallFor(c.mint)) continue;
      // Already judged this coin in the last 6h — a 5-minute lane must not pay
      // to re-ask the same question until circumstances change (that is what
      // the watchlist is for).
      if (store.recentlyJudged(c.mint)) continue;
      const age = c.pair?.ageHours ?? 0;
      if (age <= 0 || age >= 48) continue;
      /* Pre-screen from pair data already in hand: the lane's one workup slot must not
       * be spent on a coin the free screen will kill on arrival — its first champion
       * scored 52 on ignition and died of thin_liquidity.
       *
       * This used to be hand-rolled here, checking liquidity, volume and transactions
       * with its own inline defaults — and when the market-cap ceiling was added to the
       * screen, this copy never learned about it. So the 5-minute lane kept buying
       * workups on coins over the ceiling, and `too_big` became the desk's single most
       * common refusal at 21 occurrences. Two lanes with two copies of one rule is a
       * bug waiting for the next threshold to move; both now call the same function. */
      const wouldDie = wouldSurviveScreen(c);
      if (wouldDie) continue;
      const cat = classify(c);
      const r = rank(c);
      // The race adjustment: the winner of a live naming race gets the seat;
      // the losers are untouchable at any score — the race pays one coin.
      const race = races.get(c.mint);
      if (race) {
        if (race.leader) { r.score += 18; r.why.push(`winning a naming race: ${race.size} launches chasing "${race.theme}"`); }
        else { r.score -= 40; r.why.push(`losing a naming race for "${race.theme}" — the winner takes it all`); }
      }
      if (r.score <= 0) continue;
      young.push({ ...c, category: cat.category, score: r.score, rankWhy: r.why,
        race: race?.leader ? race : null });
    }
    young.sort((a, b) => b.score - a.score);
    const top = young[0];
    emit("fresh:scan", { considered: universe.length, young: young.length,
      top: top ? { symbol: top.pair?.baseSymbol, score: top.score } : null });
    if (!top || top.score < minScore) return { young: young.length, workedUp: 0 };

    /* THE FRESH LANE MUST NOT PAY TO RE-ASK. store.recentlyJudged's own docstring says
       this lane "runs every few minutes; without this it would pay to re-ask the SAME
       question about the same coin each pass" — and this lane never called it. Measured
       2026-09-07: 151 mints started, 52 of them three or more times, 319 re-starts in a
       day; FgJReZ…pump alone was worked up 25 times by this lane and the house scan and
       never published. Every re-start that clears the free screen buys a fresh ~$0.15 X
       read. The cohort, the hunt, promote and trends all gate on this; now so does fresh.
       A WATCH promotion still bypasses it by design — its rules holding IS the change. */
    const prior = store.recentlyJudged(top.mint);
    if (prior) {
      emit("fresh:skipped_repeat", { mint: top.mint, symbol: top.pair?.baseSymbol ?? null,
        seat: prior.seat, verdict: prior.verdict, agoMin: Math.round((Date.now() - prior.ts) / 60000),
        note: "judged within 6h — the fresh lane does not pay to re-ask" });
      return { young: young.length, workedUp: 0, skipped: "recently_judged" };
    }

    const hook = `fresh scan \u00b7 ignition \u00b7 ${top.category}${top.launchpad ? ` \u00b7 ${top.launchpad}` : ""}` +
      (top.race ? ` \u00b7 WINNING A NAMING RACE: ${top.race.size} fresh launches share "${top.race.theme}" \u2014 ` +
        `establish which X event fired this race and whether THIS is the canonical token for it; ` +
        `the race pays one winner and the rest go to zero` : "");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), top.mint, hook,
      { alwaysTicket: SEQUENTIAL, lane: "fresh" }));
    const pub = publishCall(rec, { category: top.category, launchpad: top.launchpad });
    return { young: young.length, workedUp: 1, outcome: pub.outcome ?? rec?.outcome ?? rec?.finalDecision };
  } catch (e) {
    if (e instanceof OutOfCredit) return { halted: e.message };
    return { error: String(e.message || e) };
  } finally { freshBusy = false; }
}

let monitorBusy = false;
/**
 * SUB-TICK MARKS — cheap price witnesses between full monitor passes.
 *
 * The two-witness high (snipe-v3) assumed witnesses ~15s apart; the server's monitor
 * writes ONE mark per pass, default ten minutes — a 40x gap that made any pump peaking
 * inside a single pass one-witness forever. This loop writes a consensus price for
 * every LIVE call — one free DexScreener read per call, no models — so the pair rule
 * has honest neighbours to confirm against.
 *
 * The fourth review rebuilt three parts of the first version:
 *
 * SINGLE-FLIGHT, MINIMUM SPACING. Office mode arms two start paths, and two identical
 * intervals firing back-to-back wrote near-duplicate marks that satisfied the
 * two-witness rule by racing it — one anomalous DexScreener cache interval became its
 * own second witness. startSubTickMarks arms once per process, the loop refuses to
 * overlap itself, and a mark is only written if the newest existing mark is at least
 * half the cadence old — witnesses must be SEPARATED OBSERVATIONS, whoever writes them.
 *
 * CLOSE PRINTS ANCHOR TO THE MARK BEFORE THEM, NOT THE PRICE AFTER. The first version
 * compared the close print to a read up to ten minutes LATER, direction-blind — so an
 * honest stop close during a continuing dump was "restated" to the post-crash price,
 * corrupting the very stats it was guarding. What distinguishes an anomalous print is
 * that it disagrees with its neighbours on BOTH sides: the print is restated only when
 * it is >30% from the last pre-close mark AND the post-close read agrees with that
 * pre-close mark (the print is the odd one out). An honest close in a moving market
 * agrees with its pre-close neighbour and is confirmed untouched. No pre-close mark
 * within ten minutes -> confirm as-is; one witness cannot convict another.
 *
 * CONFIRMED MEANS FINISHED. Both UPDATEs carry close_confirmed IS NULL, so a settled
 * print can never be re-opened by a later pass or an overlapping loop.
 *
 * Documented residual: the Colonel debrief fires once at close with the provisional
 * print and is not re-run on a restatement — the ~45s window makes a divergence rare,
 * and a wrong debrief narrative is recoverable where a wrong stat is not.
 */
let _subTickArmed = false;
let _subTickBusy = false;
let _subTickSecs = 45;

/* ONE WINDOW for post-close witnessing AND adjudication. The seventh review found
 * them split — witnesses were WRITTEN for 15 minutes after a close while the confirm
 * loop only READ 10 minutes and declared "no second witness will ever come" at the
 * same 10 — so a witness recorded at minute 11, seconds earlier in the very same
 * pass, was permanently ignored and the fake print it would have convicted was
 * confirmed. Two numbers describing one contract will drift; one number cannot. */
const WITNESS_WINDOW_MS = 15 * 60e3;

/**
 * THE ONE DOOR A WITNESS MARK ENTERS BY. The spacing rule ("witnesses must be
 * separated observations") was enforced only inside subTickMarks, while monitorCalls
 * wrote its own mark unconditionally — so a monitor pass overlapping a sub-tick pass
 * could write the same anomalous DexScreener cache interval twice, seconds apart, and
 * the pair rule confirmed the anomaly off its own echo. Every mark writer goes
 * through here now; a mark younger than half the sub-tick cadence is the same
 * observation, whoever fetched it.
 */
export function writeWitnessMark(callId, mark) {
  if (!(mark > 0)) return false;
  const minSpacingMs = (_subTickSecs / 2) * 1000;
  const last = db.prepare(`SELECT MAX(ts) t FROM call_events
    WHERE call_id=? AND mark IS NOT NULL`).get(callId)?.t ?? 0;
  if (Date.now() - last < minSpacingMs) return false;
  noteEvent(callId, "mark", null, mark);
  return true;
}
/* A CALL WHOSE WHOLE LIFE IS SHORTER THAN A FEW MONITOR PASSES.
 *
 * The exit check runs on one flat ten-minute timer for every band, and the bands do not
 * have one flat life. A nano call is held between one and thirty MINUTES, so it was
 * looked at perhaps three times before it closed, and a coin that doubled and gave it
 * all back inside a single gap was recorded — and published — as whatever it happened
 * to be worth when the timer next fired. You cannot sell high at ten-minute resolution
 * on a thirty-minute position.
 *
 * The price is already in hand: the sub-tick fetches it for every live call every 45
 * seconds to write witness marks. Only the DECISION was waiting for the slow timer.
 *
 * The rule WAS a ratio: a call rode the fast lane when its own hold window gave it
 * fewer than twelve chances on the slow timer — nano (30m) and micro (1h) — and low,
 * medium and high waited for the ten-minute pass. That was fine while the bot ran its
 * own stop. It is not fine now that the DESK determines every exit and the bot sells
 * exactly what the desk determined, when it hears it (owner, 2026-09-05): on Shrek
 * call 55 the bot sold at 03:01:42Z on its own normalised stop at -13.5% and the
 * desk's stop_hit came at 03:10:24Z — nine minutes of slow-timer resolution on a
 * low-band call. With the bot's own bracket gone, that gap is the whole exit latency,
 * so every band now rides the 45-second price lane by default. The ten-minute full
 * pass still runs for every call — the chain-fact exits live there and nowhere else.
 *
 * PENTHOUSE_FAST_ALL_BANDS: '1' (default) — every live call with a finite hold window
 * is fast-laned; '0' restores the ratio rule above. Read at call time so a running
 * process — and a test — can flip it without a restart. A call with no clock at all
 * is never fast-laned under either rule, rather than defaulting into one.
 */
export const FAST_LANE_MIN_PASSES = 12;
export function needsFastExitLane(call, { monitorMs = null, fastAllBands = null } = {}) {
  const holdMax = Number(call?.hold_max_ms);
  if (!Number.isFinite(holdMax) || holdMax <= 0) return false;      // no clock, no fast lane
  const allBands = String(fastAllBands ?? process.env.PENTHOUSE_FAST_ALL_BANDS ?? "1") !== "0";
  if (allBands) return true;
  const slow = Number(monitorMs) > 0 ? Number(monitorMs)
    : Math.max(1, Number(process.env.PENTHOUSE_MONITOR_MINS || 10)) * 60_000;
  return holdMax / slow < FAST_LANE_MIN_PASSES;
}

/* THE ONE PLACE A CALL IS CLOSED BY AN EXIT. Both the slow pass and the fast tick land
   here, so the debrief, the event and the tenant announcement cannot drift apart —
   and closeCall refuses a call that is not live, so the two clocks racing on the same
   coin is a no-op rather than a double exit. */
function fireExit(call, exit, mark, { lane = "monitor" } = {}) {
  const closedRow = closeCall(call.id, exit.code, mark);
  if (!closedRow) return false;                 // another pass got there first
  const landing = { ...call, closed_at: Date.now(), close_mark: mark, close_reason: exit.code };
  import("./agents/review.js").then((r) => runForEvidence({
    floor: call.source_floor ?? null,
    evidenceScope: call.source_attributed ? call.source_scope : "unattributed",
  }, () => r.runDebrief(landing))).catch(() => {});
  emit("call:exit", { callId: call.id, symbol: call.symbol, code: exit.code,
    urgency: exit.urgency, detail: exit.detail, mark, lane });
  announceExit(call, exit).catch((e) => noteEvent(call.id, "announce_failed", String(e.message || e)));
  return true;
}

export function startSubTickMarks(secs = 45) {
  if (_subTickArmed) return false;
  _subTickArmed = true;
  _subTickSecs = Math.max(15, Number(secs) || 45);
  setInterval(() => { subTickMarks().catch(() => {}); }, _subTickSecs * 1000);
  return true;
}

export async function subTickMarks() {
  if (_subTickBusy) return { marked: 0, confirmed: 0, skipped: "busy" };
  _subTickBusy = true;
  try {
    let marked = 0, confirmed = 0, fastClosed = 0;
    const minSpacingMs = (_subTickSecs / 2) * 1000;
    /* Witness marks flow for LIVE calls AND for closes still awaiting adjudication.
     * Both writers used to gate on status='live', and closeCall flips status first —
     * so no production path ever recorded a post-close mark, the confirm loop's
     * post-close witness was structurally NULL, and the entire restatement mechanism
     * was dead code that only its own test fixtures (which inserted marks by hand)
     * ever saw work. The sixth review proved it with the production path: a
     * manufactured 6x print confirmed unrestated. The lesson is the green-suite one
     * again: a fixture that hand-builds a world production cannot produce tests the
     * logic and not the system. */
    const live = db.prepare(`SELECT id, mint FROM calls WHERE status='live'
      UNION SELECT id, mint FROM calls
      WHERE status='closed' AND close_confirmed IS NULL AND closed_at > ?`)
      .all(Date.now() - WITNESS_WINDOW_MS);
    for (const call of live) {
      try {
        /* A short-clock call is read on every tick even when the witness door would
           refuse the mark, because here the price is not only a witness — it is the
           only chance this call gets to be sold at a sensible number. */
        const row = db.prepare("SELECT * FROM calls WHERE id=?").get(call.id);
        const fast = row?.status === "live" && needsFastExitLane(row);
        const last = db.prepare(`SELECT MAX(ts) t FROM call_events
          WHERE call_id=? AND mark IS NOT NULL`).get(call.id)?.t ?? 0;
        if (!fast && Date.now() - last < minSpacingMs) continue;   // a witness must be a separate observation
        const px = await ds.pairsFor(call.mint);
        if (!px?.ok) continue;
        const cons = ds.consensus(px.pairs);
        if (cons.ok && writeWitnessMark(call.id, cons.priceUsd)) marked++;

        /* THE FAST LANE. Price only — no flags, no round-trip probe, no liquidity read,
           because this tick does not gather them. evaluateExit skips every one of those
           triggers when its input is null, so the only thing that can fire here is the
           price policy: the stop, the target, the trailing take-profit and the band's
           own clock. The chain-failure exits stay on the full pass that can actually
           observe them, which is where they belong: they are facts about the token, and
           they need the bundle. flagsReadable is stated false so a call opened with
           known flags is never closed for "an authority appeared" on a read that never
           looked. */
        if (fast && cons.ok && cons.priceUsd > 0) {
          const exit = evaluateExit(row, { mark: cons.priceUsd, flagsReadable: false });
          if (exit.fire) {
            fastClosed++;
            fireExit(row, exit, cons.priceUsd, { lane: "subtick" });
          }
        }
      } catch { /* a failed read is a missing witness, never an error */ }
    }
    /* CLOSE-PRINT CONFIRMATION, adjudicated from HISTORY, bounded by CONSERVATISM.
     *
     * Fifth-review rebuild, two defects closed:
     *
     * NO STRANDING. The 10-minute eligibility window assumed a next pass would still
     * see the row — a DexScreener outage or a deploy restart (the very events that
     * produce bad prints) aged the row out unexamined, permanently provisional. Rows
     * stay eligible until confirmed (24h scan bound), and the post-close witness is
     * the first recorded MARK after the close — history, not a live read — so a late
     * pass adjudicates exactly what an on-time pass would have.
     *
     * A RESTATEMENT MAY NEVER FLATTER THE OUTCOME. The both-neighbours rule was
     * direction-blind: a real dump-wick stop close — where the exit alert went out at
     * the wick and follower bots actually sold there — V-bounced, agreed with both
     * neighbours as "anomalous", and was restated to breakeven while followers
     * realized -40%. The book must never diverge from follower reality in its own
     * favour: a restatement is applied only when it makes the recorded outcome WORSE
     * (shrinks a win), never better (never shrinks a loss, never grows a win). The
     * manufactured-6x-win case restates; the honest wick stands. */
    const recent = db.prepare(`SELECT id, mint, close_mark, closed_at, entry_ref FROM calls
      WHERE status='closed' AND close_confirmed IS NULL AND closed_at > ?`).all(Date.now() - 24 * 3600e3);
    for (const call of recent) {
      try {
        /* Witness KINDS only ('mark'/'ok'): closeCall's own 'closed' row carries the
         * print as a mark, and a 1ms clock skew put it AFTER closed_at — the print
         * became its own "first post-close witness" and, being earliest, preempted
         * every genuine one. A print must never adjudicate itself.
         *
         * And the pre-close lookback is an hour, not ten minutes: the realistic
         * producer of a bad print is a data outage, which is exactly what starves a
         * short window — the last honest mark sat 30 seconds outside the old cutoff
         * while the fake print confirmed unopposed. The 30% drift test does the real
         * discriminating; the window only has to contain a witness. */
        const preMark = db.prepare(`SELECT mark FROM call_events
          WHERE call_id=? AND mark IS NOT NULL AND kind IN ('mark','ok') AND ts < ? AND ts > ?
          ORDER BY ts DESC LIMIT 1`).get(call.id, call.closed_at, call.closed_at - 60 * 60e3)?.mark ?? null;
        const postMark = db.prepare(`SELECT mark FROM call_events
          WHERE call_id=? AND mark IS NOT NULL AND kind IN ('mark','ok') AND ts > ? AND ts < ?
          ORDER BY ts ASC LIMIT 1`).get(call.id, call.closed_at, call.closed_at + WITNESS_WINDOW_MS)?.mark ?? null;
        const windowOver = Date.now() > call.closed_at + WITNESS_WINDOW_MS;
        const settle = (restateTo = null, why = null) => {
          if (restateTo != null) {
            const r = db.prepare("UPDATE calls SET close_mark=?, close_confirmed=1 WHERE id=? AND close_confirmed IS NULL")
              .run(restateTo, call.id);
            if (r.changes) noteEvent(call.id, "close_restated", why);
          } else {
            db.prepare("UPDATE calls SET close_confirmed=1 WHERE id=? AND close_confirmed IS NULL").run(call.id);
          }
          confirmed++;
        };
        if (!(preMark > 0) || !(call.close_mark > 0)) { settle(); continue; }   // one witness cannot convict another
        const printDrift = Math.abs(call.close_mark - preMark) / preMark;
        if (printDrift <= 0.30) { settle(); continue; }                        // the print agrees with its neighbour
        if (!(postMark > 0)) {
          if (windowOver) settle();                                            // no second witness will ever come
          continue;                                                            // else wait for the next mark
        }
        const postAgreesWithPre = Math.abs(postMark - preMark) / preMark <= 0.30;
        if (!postAgreesWithPre) { settle(); continue; }                        // the market truly moved through the close
        /* Both neighbours agree the print is the outlier. Restate ONLY if doing so
         * makes the recorded outcome worse. The first version wrote that as
         * pnl(preMark) > pnl(print) with entry_ref in both terms — and entry CANCELS:
         * (preMark - e) > (print - e) is just preMark > print. Worse than redundant,
         * the null-entry guard forced `flatters` false for any call published during
         * a pair-read flake, INVERTING the rule: the one case it existed to prevent —
         * a wick loss restated up to breakeven — happened precisely there. The
         * algebra was the review's finding; the simpler form has no null case. */
        const flatters = preMark > call.close_mark;
        if (flatters) {
          settle(null);                                                        // an honest wick the desk really sold into
        } else {
          settle(preMark,
            `close print ${call.close_mark} was ${Math.round(printDrift * 100)}% from the pre-close mark ${preMark}, ` +
            `corroborated by the post-close mark ${postMark} — restated to ${preMark} (never in the book's favour)`);
        }
      } catch { /* unconfirmed stays unconfirmed; the next loop tries again */ }
    }
    return { marked, confirmed, fastClosed };
  } finally { _subTickBusy = false; }
}

export async function monitorCalls() {
  // Reentrancy: a slow pass (rate-limited RPC, many open calls) must not overlap
  // the next tick and double-fire the same exit.
  if (monitorBusy) return { skipped: "busy" };
  monitorBusy = true;
  try {
    /* Price the SHADOW BOOK on the same tick. These are coins the desk refused; they
     * cost nothing to follow (one free pair read each) and they are the only way to
     * find out whether the bar is calibrated or merely expensive. Done before the open
     * calls so an empty book does not skip it. */
    try {
      const shadows = shadow.openShadows(48, 12);
      for (const sh of shadows) {
        const px = await ds.pairsFor(sh.mint).catch(() => null);
        if (!px?.ok) continue;
        const cons = ds.consensus(px.pairs);
        const now = cons.ok ? cons.priceUsd : Number(px.pairs?.[0]?.priceUsd);
        if (now > 0) shadow.markChecked(sh.id, now);
      }
      if (shadows.length) {
        const card = shadow.scorecard({ sinceH: 168 });
        if (card.graded >= 5)
          emit("shadow:scorecard", { graded: card.graded, wouldHaveHit2x: card.wouldHaveHit2x,
            died: card.died, medianPeakPct: card.medianPeakPct, verdict: card.verdict });
      }
    } catch {}

    const open = liveCalls();
    if (!open.length) return { checked: 0, closed: 0 };
    let closed = 0;

    for (const call of open) {
      // Per-call containment: liveCalls() is newest-first, so one corrupted row
      // would otherwise block exit evaluation for every OLDER live call, forever.
      try {
        const ev = await gather(call.mint, "monitor");
        if (ev.error) {
          // The most dangerous case in the whole monitor: a token that has rugged or
          // been delisted stops returning data, so `continue` would leave the call
          // open forever — precisely when the holder most needs to be told to leave.
          // Persistent unreadability IS the signal.
          noteEvent(call.id, "check_failed", ev.error);
          const misses = (db.prepare(
            "SELECT COUNT(*) n FROM call_events WHERE call_id=? AND kind='check_failed' AND ts > ?")
            .get(call.id, Date.now() - 6 * 3600e3)?.n) ?? 0;
          if (misses >= 4) {
            closeCall(call.id, "went_dark", null);
            emit("call:exit", { callId: call.id, symbol: call.symbol, code: "went_dark", mark: null });
            announceExit(call, { code: "went_dark", urgency: "urgent",
              detail: "the token stopped returning market data — treat as gone and exit" }).catch(() => {});
          }
          continue;
        }

        const now = {
          mark: ev.pair?.priceUsd ?? null,
          liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
          rtLossPct: ev.exitProbe?.roundTripLossPct ?? null,
          flags: (ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f),
          flagsReadable: !ev.mintAccount?.error,
        };
        /* ── SEA OTTER'S DECAY ────────────────────────────────────────────
           A thesis is not true forever just because price has not hit the stop.
           Every pass re-runs the deterministic screen: if the coin STILL clears
           the floor it was admitted on, the thesis is re-verified and its clock
           resets. If it stops clearing — liquidity gone, exit gone roachy, a new
           flag — the confidence decays from the last verification, and once it
           has halved the position leaves as STALE. That is an exit no stop would
           ever have produced, on a coin quietly rotting under a flat price. */
        try {
          const sc = screen(ev);
          if (sc.pass) {
            db.prepare("UPDATE calls SET last_verified_at=? WHERE id=?").run(Date.now(), call.id);
          } else {
            const since = call.last_verified_at ?? call.opened_at ?? Date.now();
            const hours = (Date.now() - since) / 3600e3;
            const halfLife = Number(process.env.THESIS_HALFLIFE_HOURS || 12);
            const confidence = Math.pow(0.5, hours / halfLife);      // 1 -> 0.5 -> 0.25
            noteEvent(call.id, "thesis_decay",
              `unverified ${hours.toFixed(1)}h · confidence ${(confidence * 100).toFixed(0)}% · ${sc.fails.map((f) => f.code).join(",")}`);
            if (confidence < 0.5) {
              closeCall(call.id, "thesis_stale", now.mark);
              emit("call:exit", { callId: call.id, symbol: call.symbol, code: "thesis_stale", mark: now.mark });
              announceExit(call, { code: "thesis_stale", urgency: "normal",
                detail: `the thesis has not re-verified for ${hours.toFixed(0)}h — it no longer clears the screen it was admitted on (${sc.fails.map((f) => f.code).join(", ")})` }).catch(() => {});
              continue;
            }
          }
        } catch { /* an unreadable screen never ages a thesis */ }

        const exit = evaluateExit(call, now);
        if (exit.fire) {
          /* COLONEL DEBRIEF grades the landing, the event goes out, and the tenant
             announcement is never awaited — thirty tenants with hung webhooks must not
             delay the NEXT call's exit check. All of it lives in fireExit now, shared
             with the fast lane so the two clocks cannot disagree about what an exit is. */
          if (fireExit(call, exit, now.mark)) closed++;
        } else {
          /* The 'ok' mark rides the shared spacing door: an overlapping sub-tick pass
           * must not let one DexScreener cache interval witness itself twice. When the
           * door refuses (a mark landed seconds ago), the heartbeat row is still
           * written — kind 'ok' with no mark — so pass accounting stays intact. */
          if (!writeWitnessMark(call.id, now.mark)) noteEvent(call.id, "ok", null, null);
        }
      } catch (e) {
        try { noteEvent(call.id, "check_failed", String(e.message || e)); } catch {}
      }
    }
    return { checked: open.length, closed };
  } finally { monitorBusy = false; }
}
