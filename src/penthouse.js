import { sweep, classify, CATEGORY_RISK, launchpad } from "./market.js";
import { gather, screen } from "./data/evidence.js";
import { workup } from "./desk.js";
import { openCall, liveCalls, liveCallFor, evaluateExit, closeCall, noteEvent } from "./calls.js";
import { broadcast } from "./copy.js";
import { announceExit } from "./alerts.js";
import { listFloors } from "./tower.js";
import { emit, runFor } from "./lib/bus.js";
import { spend, OutOfCredit, spendSince } from "./lib/llm.js";
import * as jup from "./data/jupiter.js";
import { callouts, whaleScore } from "./whales.js";

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
export const CYCLE_BUDGET_USD = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 8);
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
  if (age < 12) { s -= 15; why.push("too new to read"); }
  // The ranker could reward youth and nothing else, so a coin that had actually survived
  // scored worse than one that had not been tested. Durability is evidence too.
  if (age > 24 * 90 && liq > 750_000) { s += 14; why.push("survived long enough to have a base rate"); }
  if (age > 24 * 365) { s += 6; why.push("more than a year old"); }

  const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  if (txns > 500) { s += 8; why.push("actively traded"); }

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
  const startSpend = spend.usd;
  emit("cycle:start", { cycle, desk: "penthouse" });

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
      if (ws.why.length) emit("whales", { mint: c.mint, symbol: c.pair?.baseSymbol,
        netUsd: w.netUsd, buyers: w.uniqueBuyers, sellers: w.uniqueSellers, delta: ws.score });
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
      rec = await runFor(null, () => workup(cycle, c.mint, hook));
    } catch (e) {
      // Out of credit is terminal: the remaining candidates cannot be worked up either,
      // and the cycle should end with what it has rather than crash the process.
      if (e instanceof OutOfCredit) { stopped = "out of credit"; emit("cycle:halted", { reason: "out_of_credit" }); break; }
      emit("cycle:error", { mint: c.mint, error: String(e.message) });
      continue;
    }
    if (!rec || rec.outcome === "no_data") continue;
    workedUp++;                       // paid for, whatever the verdict turned out to be
    if (rec.finalDecision === "APPROVED") {
      picks.push({ rec, category: c.category, launchpad: c.launchpad,
        conviction: rec.pm?.conviction ?? rec.conviction ?? null });
    }
  }

  // 5. The CEO's approvals become the sheet, best conviction first.
  picks.sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
  const floors = listFloors().filter((f) => f.state === "owned").map((f) => f.n);
  const opened = [];

  for (const p of picks.slice(0, topN)) {
    const ev = p.rec.ev ?? {};
    const call = openCall({
      mint: p.rec.mint, symbol: p.rec.symbol ?? ev.symbol, category: p.category, launchpad: p.launchpad,
      conviction: p.conviction,
      entryRef: ev.pair?.priceUsd ?? null,
      stop: p.rec.ticket?.stop_price ?? null,
      target: p.rec.ticket?.take_profit?.[0]?.price ?? null,
      thesis: p.rec.pm?.thesis ?? null,
      invalidation: p.rec.pm?.invalidation ?? null,
      flags: (ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f),
      liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
      rtLossPct: ev.route?.roundTripLossPct ?? null,
      reportFile: p.rec.reportFile ?? null,
    });
    if (!call) continue;
    opened.push(call);
    if (floors.length) broadcast(call.id, floors);
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
export async function monitorCalls() {
  const open = liveCalls();
  if (!open.length) return { checked: 0, closed: 0 };
  let closed = 0;

  for (const call of open) {
    const ev = await gather(call.mint, "monitor");
    if (ev.error) { noteEvent(call.id, "check_failed", ev.error); continue; }

    const now = {
      mark: ev.pair?.priceUsd ?? null,
      liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
      rtLossPct: ev.route?.roundTripLossPct ?? null,
      flags: (ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f),
    };
    const exit = evaluateExit(call, now);
    if (exit.fire) {
      closeCall(call.id, exit.code, now.mark);
      emit("call:exit", { callId: call.id, symbol: call.symbol, code: exit.code,
        urgency: exit.urgency, detail: exit.detail, mark: now.mark });
      // Durable, per-floor, and sent regardless of arrears — an exit must reach the
      // tenant whether or not their tab is open and whether or not they owe rent.
      await announceExit(call, exit);
      closed++;
    } else {
      noteEvent(call.id, "ok", null, now.mark);
    }
  }
  return { checked: open.length, closed };
}
