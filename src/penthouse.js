import { sweep, classify, CATEGORY_RISK, launchpad } from "./market.js";
import { gather, screen } from "./data/evidence.js";
import { workup } from "./desk.js";
import { openCall, liveCalls, liveCallFor, evaluateExit, closeCall, noteEvent } from "./calls.js";
import { broadcast } from "./copy.js";
import { listFloors } from "./tower.js";
import { emit, runFor } from "./lib/bus.js";
import { spend, OutOfCredit, spendSince } from "./lib/llm.js";
import * as jup from "./data/jupiter.js";

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
  if (liq > 5_000_000) { s -= 8; why.push("very large — less room to run"); }

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

  const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  if (txns > 500) { s += 8; why.push("actively traded"); }

  return { score: Math.round(s), why };
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
  emit("scout:shortlist", { count: Math.min(workups, scored.length), considered: universe.length });

  // 4. Only now does anything cost money.
  const picks = [];
  let stopped = null;
  for (const c of scored.slice(0, workups)) {
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
    workedUp: picks.length, opened: opened.length, costUsd: Number(cost.toFixed(4)), stopped };
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
      closed++;
    } else {
      noteEvent(call.id, "ok", null, now.mark);
    }
  }
  return { checked: open.length, closed };
}
