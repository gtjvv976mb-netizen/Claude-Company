import { sweep, classify, CATEGORY_RISK, launchpad } from "./market.js";
import { gather, screen } from "./data/evidence.js";
import { workup } from "./desk.js";
import { openCall, liveCalls, liveCallFor, evaluateExit, closeCall, noteEvent } from "./calls.js";
import { broadcast } from "./copy.js";
import { announceExit } from "./alerts.js";
import { listFloors } from "./tower.js";
import { emit, runFor } from "./lib/bus.js";
import db from "./lib/store.js";
import { spend, OutOfCredit, spendSince } from "./lib/llm.js";
import * as jup from "./data/jupiter.js";
import { callouts, whaleScore } from "./whales.js";
import { recordWhaleCallout } from "./identity.js";
import { regime } from "./data/regime.js";
import { cfg } from "./config.js";
import * as store from "./lib/store.js";
import { eligibility, contenderScore, pickOne, bookState, SEQUENTIAL, MAX_LIVE_CALLS } from "./mandate.js";

/**
 * THE PENTHOUSE CYCLE — the house team's working day.
 *
 *   sweep (free) → classify (free) → screen (free) → rank (free) → work up the best few
 *   → open calls on what the CEO approves → broadcast to every leased floor (free)
 *
 * Only the workup costs money, which is why everything above it is arithmetic. A cycle
 * looks at ~190 coins and pays for ~3.
 */

export const WORKUPS_PER_CYCLE = Number(process.env.PENTHOUSE_WORKUPS || 3);
/** Hard ceiling per cycle. Without it one bad night empties the account. */
export const CYCLE_BUDGET_USD = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 10);
export const TOP_N = Number(process.env.PENTHOUSE_TOP_N || 5);

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

  // A coin still on its bonding curve has no AMM depth for the exit probe to measure, so
  // it fails `cannot_exit` at the screen anyway. Ranking it highly only burns a slot the
  // desk was always going to refuse.
  if (c.onCurve) { s -= 30; why.push("still on a bonding curve — no measurable exit"); }

  const liq = p.liquidityUsd ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const h1 = p.priceChange?.h1 ?? 0;
  const h6 = p.priceChange?.h6 ?? 0;
  const h24 = p.priceChange?.h24 ?? 0;
  const age = p.ageHours ?? 0;

  // Depth: enough to exit, not so much that nothing moves it.
  if (liq > 75_000) { s += 15; why.push("liquid enough to exit"); }
  if (liq > 400_000) { s += 10; why.push("deep book"); }
  // Was -8 above $5m, which demoted every real asset on the chain. A $5m book is not
  // "too big to move" — it is the smallest size at which an exit is dependable. Only
  // genuinely enormous caps get the penalty now.
  if (liq > 25_000_000) { s -= 5; why.push("very large — less room to run"); }

  // Turnover relative to depth: real interest, but wash above a point.
  const volToLiq = liq > 0 ? vol24 / liq : 0;
  if (volToLiq > 1 && volToLiq < 15) { s += 15; why.push("healthy turnover"); }
  if (volToLiq >= 15) { s -= 10; why.push("turnover implausible for the depth"); }

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
  } else if (age < 1.5) { s -= 20; why.push("too new even for the sniper path"); }

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
  if (age > 24 * 90 && liq > 750_000) { s += 14; why.push("survived long enough to have a base rate"); }
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
export function selectShortlist(scored, workups) {
  const substantive = scored.filter((c) => SUBSTANTIVE.has(c.category));
  const speculative = scored.filter((c) => !SUBSTANTIVE.has(c.category));
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

export async function runPenthouseCycle({ workups = WORKUPS_PER_CYCLE, topN = TOP_N } = {}) {
  const cycle = new Date().toISOString().replace(/[:.]/g, "-");

  /* ONE TRADE AT A TIME. The mandate is "one cycle, one trade, run to completion" —
   * so while a call is live the desk does not go shopping. This sits above every
   * paid stage deliberately: the sequencing rule and the money brake are the same
   * lever here, and a cycle that cannot publish must not be allowed to spend. */
  const book = bookState();
  if (book.full) {
    emit("cycle:holding", { cycle, live: book.live,
      symbol: book.holding?.symbol, mint: book.holding?.mint,
      heldHours: book.holding ? Number(((Date.now() - book.holding.opened_at) / 3.6e6).toFixed(1)) : null,
      note: "a call is still working — the next cycle starts when it closes" });
    return { cycle, skipped: "position_open", live: book.live, opened: 0, workedUp: 0,
      holding: book.holding ? { id: book.holding.id, symbol: book.holding.symbol, mint: book.holding.mint,
        openedAt: book.holding.opened_at } : null, costUsd: 0 };
  }

  const startSpend = spend.usd;
  emit("cycle:start", { cycle, desk: "penthouse" });

  // MURDOCK reads the weather once per cycle. Risk-off (SOL and BTC both
  // negative over ~25d) grounds the ESTABLISHED sleeve — the one whose returns
  // ride the majors — per the TSMOM veto. Unknown weather never grounds anyone.
  const wx = await regime();
  emit("seat:verdict", { seat: "Regime", detail: `${wx.regime} · SOL ${wx.solRet25d}% / BTC ${wx.btcRet25d}% (25d)` });

  // 1-3. Everything free: sweep, classify, screen.
  const universe = await sweep();
  const scored = [];
  for (const c of universe) {
    if (liveCallFor(c.mint)) continue;                 // already holding a call on this one
    const cat = classify(c);
    const r = rank(c);
    if (r.score <= 0) continue;
    scored.push({ ...c, category: cat.category, categoryWhy: cat.why, score: r.score, rankWhy: r.why });
  }
  scored.sort((a, b) => b.score - a.score);

  // Whale flow is checked only on the coins already in contention. It costs ~25 RPC
  // reads per coin, so running it over all 345 would be wasteful; running it over the
  // top handful is what changes a decision.
  for (const c of scored.slice(0, Math.max(8, workups * 3))) {
    try {
      const w = await callouts(c.mint, { scan: 24 });
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
  scored.sort((a, b) => b.score - a.score);

  const shortlist = selectShortlist(scored, workups);
  emit("scout:shortlist", { count: shortlist.length, considered: universe.length,
    mix: shortlist.map((c) => c.category) });

  // 4. Only now does anything cost money.
  const picks = [];
  let workedUp = 0;
  let stopped = null;
  for (const c of shortlist) {
    const usedSoFar = spend.usd - startSpend;
    if (usedSoFar >= CYCLE_BUDGET_USD) {
      stopped = `budget: $${usedSoFar.toFixed(2)} of $${CYCLE_BUDGET_USD}`;
      emit("cycle:budget", { usedUsd: Number(usedSoFar.toFixed(4)), capUsd: CYCLE_BUDGET_USD });
      break;
    }
    const hook = `house scan · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`;
    let rec;
    try {
      rec = await runFor(null, () => workup(cycle, c.mint, hook, { alwaysTicket: SEQUENTIAL }));
    } catch (e) {
      // Out of credit is terminal: the remaining candidates cannot be worked up either,
      // and the cycle should end with what it has rather than crash the process.
      if (e instanceof OutOfCredit) {
        stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached" : "out of credit";
        emit("cycle:halted", { reason: e.constructor.name === "BudgetExhausted" ? "daily_budget" : "out_of_credit" });
        break;
      }
      emit("cycle:error", { mint: c.mint, error: String(e.message) });
      continue;
    }
    if (!rec || rec.outcome === "no_data") continue;
    workedUp++;                       // paid for, whatever the verdict turned out to be
    // THE COHORT. Every workup that got a verdict is a candidate, not only the ones
    // the CEO waved through — the mandate ranks the cohort and publishes its best.
    // Which of them are actually eligible is `eligibility()`'s job, and it refuses
    // every safety failure before conviction is even consulted.
    picks.push({ rec, category: c.category, launchpad: c.launchpad,
      conviction: rec.pm?.conviction ?? rec.conviction ?? null });
  }

  /* 5. THE COHORT PICK — of everything studied, publish the single best one.
   *
   * This replaced an absolute bar that produced 144 kills and zero calls across 177
   * workups. The bar is not lowered on SAFETY: eligibility() refuses every screened,
   * killed, vetoed, unexitable, stopless or refuted candidate first, and refuses the
   * team's own PASS on top of that. What changed is that a lack of CONVICTION — the
   * CEO holding, the PM wanting one more trigger — now ranks rather than blocks. */
  const opened = [];
  const { winner, judged } = pickOne(picks);
  for (const j of judged) {
    if (j.eligibility.eligible) continue;
    emit("cohort:declined", { mint: j.rec?.mint, symbol: j.rec?.symbol,
      safety: j.eligibility.safety, reason: j.eligibility.reason });
  }
  emit("cohort:ranked", { studied: judged.length,
    eligible: judged.filter((j) => j.eligibility.eligible).length,
    winner: winner ? { symbol: winner.rec?.symbol, tier: winner.eligibility.tier,
      why: winner.eligibility.reason } : null });

  if (winner) {
    const pub = publishCall(winner.rec, { category: winner.category, launchpad: winner.launchpad, wx });
    if (pub.callId) opened.push({ id: pub.callId, symbol: winner.rec?.symbol });
  }

  /* THE MANDATE — every cycle ends in a call. Not by lowering the bar: by
   * refusing to stop interviewing. If the shortlist pass opened nothing, the
   * desk keeps working straight down the ranked list — same gauntlet per coin,
   * more coins — until a call is published, the ranked market is exhausted, or
   * the daily money brake calls time. Those are the only three exits: the
   * mandate can spend the whole day's budget hunting, but it cannot force a
   * seat to lie, because a forced call is just a loss with paperwork. */
  if (!opened.length && process.env.PENTHOUSE_MUST_CALL !== "0") {
    const alreadyTried = new Set(shortlist.map((c) => c.mint));
    let hunted = 0;
    for (const c of scored) {
      if (opened.length) break;
      if (alreadyTried.has(c.mint) || liveCallFor(c.mint) || store.recentlyJudged(c.mint)) continue;
      if (wx.regime === "risk_off" && c.category === "established") continue;
      hunted++;
      emit("cycle:hunting", { symbol: c.pair?.baseSymbol, score: c.score, hunted });
      let rec;
      try {
        rec = await runFor(null, () => workup(cycle,
          c.mint, `the mandate · hunting for this cycle's call · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`,
          { alwaysTicket: SEQUENTIAL }));
      } catch (e) {
        if (e instanceof OutOfCredit) {
          stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached mid-hunt" : "out of credit mid-hunt";
          emit("cycle:halted", { reason: "hunt_budget" });
          break;
        }
        emit("cycle:error", { mint: c.mint, error: String(e.message) });
        continue;
      }
      if (!rec || rec.outcome === "no_data") continue;
      workedUp++;
      const pub = publishCall(rec, { category: c.category, launchpad: c.launchpad, wx });
      if (pub.callId) opened.push({ id: pub.callId, symbol: rec.symbol });
    }
    if (!opened.length && !stopped)
      emit("cycle:hunt_dry", { hunted, note: "the ranked market offered no coin that cleared the SAFETY gauntlet — " +
        "the mandate ranks conviction, it never overrides a measured fact, so a market of honeypots ends in no call" });
  }

  const cost = spend.usd - startSpend;
  emit("cycle:end", { cycle, count: opened.length, spendUsd: Number(cost.toFixed(4)), stopped });
  return { cycle, considered: universe.length, ranked: scored.length,
    workedUp, approved: picks.length, opened: opened.length,
    costUsd: Number(cost.toFixed(4)), costPerWorkup: workedUp ? Number((cost / workedUp).toFixed(2)) : null,
    stopped };
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
function publishCall(rec, { category = null, launchpad: pad = null, wx = null } = {}) {
  const e = eligibility(rec);
  if (!e.eligible) {
    emit("call:withheld", { mint: rec?.mint, symbol: rec?.symbol,
      safety: e.safety, reason: e.reason });
    return { outcome: e.safety ? "unsafe" : "declined", reason: e.reason };
  }

  // MURDOCK's weather veto. Not in eligibility() because it is a fact about the
  // MARKET rather than about the token, and only the cycle knows the weather.
  if (wx?.regime === "risk_off" && category === "established") {
    emit("call:withheld", { mint: rec.mint,
      reason: `MURDOCK: not flying weather — SOL ${wx.solRet25d}% / BTC ${wx.btcRet25d}% over 25d` });
    return { outcome: "withheld", reason: "risk_off" };
  }

  const book = bookState();
  if (book.full) {
    emit("call:withheld", { mint: rec.mint, symbol: rec.symbol,
      reason: `already holding ${book.holding?.symbol ?? "a position"} — one call at a time` });
    return { outcome: "book_full", reason: "position_open" };
  }

  const ev = rec.ev ?? {};
  const call = openCall({
    mint: rec.mint, symbol: rec.symbol ?? ev.symbol, category, launchpad: pad,
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
    reportFile: rec.reportFile ?? null,
  });
  if (call) {
    // The record shows HOW FAR DOWN the desk reached for this one. A tier-4 call is
    // an approval; a tier-1 call is the mandate taking the cohort's best available
    // when nothing was approved. Both are legitimate, and they are not the same
    // thing, so the difference goes on the call rather than into a footnote.
    noteEvent(call.id, "mandate", `${e.reason} (tier ${e.tier})`, call.entry_ref);
    const floors = listFloors().filter((f) => f.state === "owned").map((f) => f.n);
    if (floors.length) broadcast(call.id, floors);
    emit("call:published", { callId: call.id, symbol: call.symbol, tier: e.tier, why: e.reason });
    return { outcome: "published", callId: call.id, tier: e.tier };
  }
  return { outcome: "open_failed" };
}

/**
 * THE PROMOTION PASS — the criteria, acted on. Free until a watch's rules hold;
 * then ONE promoted token per pass goes back through the entire paid gauntlet
 * with the watch context in its hook. Promotion buys a re-examination, never a
 * shortcut: the analysts, red team, risk, PM, compliance and CEO all sit again.
 */
let promoteBusy = false;
export async function promoteWatches() {
  if (promoteBusy) return { skipped: "busy" };
  // One trade at a time: a promotion cannot open a second position, so it must not
  // pay for a workup it could never publish either.
  const book0 = bookState();
  if (book0.full) return { skipped: "position_open", holding: book0.holding?.symbol ?? null };
  promoteBusy = true;
  try {
    const { checkWatchlist } = await import("./watchlist.js");
    const { checked, promoted } = await checkWatchlist();
    if (!promoted.length) return { checked, promoted: 0 };
    const w = promoted.find((x) => !liveCallFor(x.mint));
    if (!w) return { checked, promoted: promoted.length, outcome: "already live" };

    const hook = `watch promoted \u00b7 ${w.symbol ?? w.mint.slice(0, 6)} \u00b7 rules held: ` +
      Object.entries(w.rules).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(", ");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), w.mint, hook,
      { alwaysTicket: SEQUENTIAL }));

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
export async function freshScan({ minScore = 45 } = {}) {
  if (freshBusy) return { skipped: "busy" };
  // Same rule as every other lane: while a call is working, the fresh lane does not
  // buy a workup it has no seat to publish into.
  const book0 = bookState();
  if (book0.full) return { skipped: "position_open", holding: book0.holding?.symbol ?? null };
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
      // Pre-screen from pair data already in hand: the lane's one workup slot
      // must not be spent on a coin the free screen will kill on arrival —
      // its first champion scored 52 on ignition and died of thin_liquidity.
      const liq = c.pair?.liquidityUsd ?? 0;
      const vol = c.pair?.volume?.h24 ?? 0;
      const tx = (c.pair?.txns?.h24?.buys ?? 0) + (c.pair?.txns?.h24?.sells ?? 0);
      if (liq < (cfg.screen?.minLiquidityUsd ?? 25000) || vol < (cfg.screen?.minVolume24hUsd ?? 10000)
          || tx < (cfg.screen?.minTxns24h ?? 50)) continue;
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

    const hook = `fresh scan \u00b7 ignition \u00b7 ${top.category}${top.launchpad ? ` \u00b7 ${top.launchpad}` : ""}` +
      (top.race ? ` \u00b7 WINNING A NAMING RACE: ${top.race.size} fresh launches share "${top.race.theme}" \u2014 ` +
        `establish which X event fired this race and whether THIS is the canonical token for it; ` +
        `the race pays one winner and the rest go to zero` : "");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), top.mint, hook,
      { alwaysTicket: SEQUENTIAL }));
    const pub = publishCall(rec, { category: top.category, launchpad: top.launchpad });
    return { young: young.length, workedUp: 1, outcome: pub.outcome ?? rec?.outcome ?? rec?.finalDecision };
  } catch (e) {
    if (e instanceof OutOfCredit) return { halted: e.message };
    return { error: String(e.message || e) };
  } finally { freshBusy = false; }
}

let monitorBusy = false;
export async function monitorCalls() {
  // Reentrancy: a slow pass (rate-limited RPC, many open calls) must not overlap
  // the next tick and double-fire the same exit.
  if (monitorBusy) return { skipped: "busy" };
  monitorBusy = true;
  try {
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
          closeCall(call.id, exit.code, now.mark);
          // COLONEL DEBRIEF grades the landing — fire and forget; exits never wait.
          const landing = { ...call, closed_at: Date.now(), close_mark: now.mark, close_reason: exit.code };
          import("./agents/review.js").then((r) => r.runDebrief(landing)).catch(() => {});
          emit("call:exit", { callId: call.id, symbol: call.symbol, code: exit.code,
            urgency: exit.urgency, detail: exit.detail, mark: now.mark });
          // Durable, per-floor, regardless of arrears — and never awaited: thirty
          // tenants with hung webhooks must not delay the NEXT call's exit check.
          announceExit(call, exit).catch((e) => noteEvent(call.id, "announce_failed", String(e.message || e)));
          closed++;
        } else {
          noteEvent(call.id, "ok", null, now.mark);
        }
      } catch (e) {
        try { noteEvent(call.id, "check_failed", String(e.message || e)); } catch {}
      }
    }
    return { checked: open.length, closed };
  } finally { monitorBusy = false; }
}
