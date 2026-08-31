import * as ds from "./data/dexscreener.js";
import { gather, screen } from "./data/evidence.js";
import { ANALYSTS, runAnalyst, runNarrative } from "./agents/analysts.js";
import { runScout, runRedTeam, runRisk, runPM, runExecution } from "./agents/decision.js";
import { complianceCheck } from "./agents/compliance.js";
import { runCEO } from "./agents/ceo.js";
import { writeOrderSlip } from "./order.js";
import { emit } from "./lib/bus.js";
import { spend, assertDailyBudget} from "./lib/llm.js";
import { cfg } from "./config.js";
import * as store from "./lib/store.js";
import { writeReport } from "./report.js";

const cycleId = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Confidence-weighted composite of the five analyst seats. */
function composite(analysts) {
  let num = 0, den = 0;
  for (const [k, a] of Object.entries(analysts)) {
    const w = (cfg.weights[k] ?? 0) * (a.confidence ?? 0.5);
    num += (a.score ?? 50) * w;
    den += w;
  }
  return den > 0 ? num / den : 50;
}

/** Stage 0: build the raw universe from public feeds. */
export async function buildUniverse() {
  emit("stage", { stage: "scout", note: "pulling feeds" });
  const [b, p] = await Promise.all([ds.boosted(), ds.profiles()]);
  const seen = new Map();
  for (const t of [...b, ...p]) {
    if (!seen.has(t.mint)) seen.set(t.mint, t);
    else seen.get(t.mint).hook += `, ${t.hook}`;
  }

  const fresh = [];
  for (const t of seen.values()) {
    const killed = store.recentKill(t.mint);
    if (killed) { emit("scout:skip", { mint: t.mint, reason: `killed ${killed.seat}: ${killed.reason}` }); continue; }
    fresh.push(t);
  }
  emit("scout:universe", { total: seen.size, fresh: fresh.length });
  return fresh;
}

/**
 * The full workup for one token. Returns a record regardless of outcome — a kill is
 * a result the desk wants written down, not a silent drop.
 */
export async function workup(cycle, mint, hook = "", opts = {}) {
  // Both spenders — the penthouse cycle and a tenant's floor run — pass through here,
  // so this is where the daily cap bites. Before the free stages, deliberately: a
  // workup that cannot afford its model stages should not pretend to start.
  // The lane decides WHOSE money this is. The scanning lanes yield to a reserve so
  // they cannot eat the day before the publishing cycle has run; a tenant's paid
  // floor run is never throttled. See assertDailyBudget.
  assertDailyBudget(cfg.dailyBudgetUsd, { lane: opts.lane ?? "cycle" });
  emit("token:start", { mint, hook });

  const ev = await gather(mint, hook);
  if (!ev.ok) {
    emit("token:end", { mint, outcome: "no_data", detail: ev.error });
    return { mint, outcome: "no_data", error: ev.error };
  }
  store.touchSeen(mint, ev.symbol);
  emit("token:evidence", { mint, symbol: ev.symbol, liq: ev.pairs.totalLiquidityUsd, price: ev.pair?.priceUsd });

  // --- Stage 1: deterministic screen. No tokens spent. ---
  const sc = screen(ev);
  emit("seat:verdict", { seat: "Screener", mint, symbol: ev.symbol, pass: sc.pass, detail: sc.fails.map((f) => f.code).join(", ") });
  if (!sc.pass) {
    store.recordVerdict(cycle, mint, ev.symbol, "Screener",
      { verdict: "FAIL", kill: true, kill_reason: sc.fails.map((f) => `${f.code}: ${f.detail}`).join("; ") });
    const rec = { mint, symbol: ev.symbol, outcome: "screened_out", fails: sc.fails, ev,
      finalDecision: "screened_out" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "screened_out",
      detail: sc.fails.map((f) => f.code).join(", "), report: rec.reportFile });
    return rec;
  }

  // --- Stages 2-6: five independent analysts, in parallel. ---
  emit("stage", { stage: "analysis", mint, symbol: ev.symbol });
  const keys = ["forensics", "liquidity", "flow", "technical"];
  const settled = await Promise.allSettled([
    ...keys.map((k) => runAnalyst(k, ev)),
    runNarrative(ev),
  ]);
  const allKeys = [...keys, "narrative"];

  const analysts = {};
  const seatFailures = [];
  settled.forEach((r, i) => {
    const k = allKeys[i];
    if (r.status === "fulfilled") {
      analysts[k] = r.value;
      store.recordVerdict(cycle, mint, ev.symbol, k, r.value);
      emit("seat:verdict", { seat: ANALYSTS[k]?.label ?? "Narrative", mint, symbol: ev.symbol,
        score: r.value.score, confidence: r.value.confidence, kill: r.value.kill });
    } else {
      seatFailures.push({ seat: k, error: String(r.reason?.message || r.reason) });
      emit("seat:failed", { seat: k, mint, error: String(r.reason?.message || r.reason) });
    }
  });

  // A desk missing half its analysts is not a desk. Refuse to decide on a thin book.
  if (Object.keys(analysts).length < 3) {
    emit("token:end", { mint, symbol: ev.symbol, outcome: "insufficient_coverage" });
    return { mint, symbol: ev.symbol, outcome: "insufficient_coverage", seatFailures, ev, analysts };
  }

  const killer = Object.entries(analysts).find(([, a]) => a.kill);
  if (killer) {
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: killer[0],
      reason: killer[1].kill_reason, ev, analysts, finalDecision: "killed" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `${killer[0]}: ${killer[1].kill_reason}`, report: rec.reportFile });
    return rec;
  }

  // --- Stage 7-9: adversary, risk, decision. ---
  const weighted = composite(analysts);
  emit("stage", { stage: "redteam", mint, symbol: ev.symbol, weighted: Number(weighted.toFixed(1)) });
  const redteam = await runRedTeam(ev, analysts);

  /* HOLD THE RED TEAM TO ITS OWN CHARTER.
   *
   * Measured over 57 verdicts: refuted 41 (72%), wounded 16, survives ZERO. A seat that
   * has never once let anything through is not discriminating — it is a constant, and a
   * constant carries no information. It also stops the desk dead, because an unanswered
   * refutation is a safety refusal in the mandate.
   *
   * Its own charter already draws the line and is worth quoting: refuted means "a
   * SPECIFIC, CHECKABLE fact breaks the thesis premise... NAME the fact. If your
   * refutation would read verbatim on any other token of this class, it is not a
   * refutation — it is the base rate."
   *
   * Prose could not enforce that, so code does. A refutation must be backed by at least
   * one attack the seat ITSELF marked fatal and evidenced. Where it is, the kill stands
   * untouched and is as decisive as ever. Where it is not, the finding is preserved in
   * full as `wounded` — which the desk already handles as "tradeable but smaller" —
   * and the downgrade is recorded so the seat's calibration stays auditable.
   *
   * This does not soften the red team. It requires it to show its work, which is the
   * standard it was written to. */
  /* THE BAR HAD A HOLE IN IT. "severity: fatal plus 20 characters of text" is
   * something the seat can always produce, so the rule caught nothing: across the last
   * two cycles refuted went 42 -> 44 with ZERO downgrades. It was measuring effort, not
   * evidence.
   *
   * The charter's actual standard is that a refutation names a SPECIFIC, CHECKABLE
   * fact — and the checkable facts on a memecoin are a short, closed list. So a fatal
   * attack now has to be ABOUT one of them. "The volume is 3 wallets round-tripping"
   * qualifies. "This is speculative and could go to zero" does not, however
   * confidently it is written, because nobody could go and find it false.
   *
   * Deliberately generous: any one of these words anywhere in the attack or its
   * evidence passes. The test is whether the seat is pointing at a fact of the right
   * KIND, not whether it phrased it a particular way. */
  const CHECKABLE = /wash|round.?trip|manufactur|bot|rug|mint authorit|freeze|honeypot|impersonat|paid|bought|shill|bundl|cluster|holder|float|concentrat|deployer|creator|sold|dump|exit|slippage|liquidity|unlock|vest|insider|snipe/i;
  const fatal = (redteam.attacks ?? []).filter((a) => {
    if (a?.severity !== "fatal") return false;
    const text = `${a?.attack ?? ""} ${a?.evidence ?? ""}`.trim();
    return text.length > 20 && CHECKABLE.test(text);
  });
  if (redteam.verdict === "refuted" && fatal.length === 0) {
    redteam.downgraded_from = "refuted";
    redteam.downgrade_reason =
      "refuted without a fatal, evidenced attack — the charter requires a specific checkable fact, not the base rate";
    redteam.verdict = "wounded";
    emit("seat:downgraded", { seat: "Red Team", mint, symbol: ev.symbol,
      from: "refuted", to: "wounded", reason: redteam.downgrade_reason });
  }

  store.recordVerdict(cycle, mint, ev.symbol, "redteam", { verdict: redteam.verdict, confidence: redteam.confidence, ...redteam });
  emit("seat:verdict", { seat: "Red Team", mint, symbol: ev.symbol, detail: redteam.verdict,
    kill: redteam.verdict === "refuted",
    fatalAttacks: fatal.length,
    ...(redteam.downgraded_from ? { downgradedFrom: redteam.downgraded_from } : {}) });

  const risk = await runRisk(ev, analysts, redteam);
  store.recordVerdict(cycle, mint, ev.symbol, "risk", { score: risk.position_size_usd, confidence: risk.confidence, ...risk });
  emit("seat:verdict", { seat: "Risk", mint, symbol: ev.symbol, detail: `$${risk.position_size_usd}` });

  const pm = await runPM(ev, analysts, redteam, risk, weighted, opts);
  store.recordVerdict(cycle, mint, ev.symbol, "pm", { verdict: pm.decision, score: pm.conviction, ...pm });
  emit("seat:verdict", { seat: "PM", mint, symbol: ev.symbol, detail: pm.decision, score: pm.conviction });

  // A WATCH becomes a standing order, not a note to self: the rules go on the
  // watchlist and a free checker promotes the token back through this whole
  // pipeline the moment they hold. Before this, WATCH terminated nowhere.
  if (pm.decision === "WATCH" && pm.watch_rules) {
    import("./watchlist.js").then((w) => w.addWatch({
      mint, symbol: ev.symbol, rules: pm.watch_rules,
      note: (pm.watch_triggers || []).join("; "),
    })).catch(() => {});
  }

  // --- Stage 10: the unsigned ticket. ---
  // Normally drafted only for a proposal. Under the mandate (one cycle, one trade)
  // the cycle ranks its contenders and publishes the best, so a WATCH may end up
  // being the call — and a call without a stop authored by the execution seat is
  // unpublishable and unmanageable. `alwaysTicket` buys that stop for anything the
  // PM did not actively pass on; a PASS still gets no ticket, because the mandate
  // never trades a coin the team named a flaw in.
  const wantTicket = pm.decision === "PROPOSE" || (opts.alwaysTicket && pm.decision === "WATCH");
  let ticket = null;
  if (wantTicket && risk.position_size_usd > 0) {
    ticket = await runExecution(ev, pm, risk);
    emit("seat:verdict", { seat: "Execution", mint, symbol: ev.symbol,
      detail: pm.decision === "PROPOSE" ? "ticket drafted" : "contingency ticket drafted (watch)" });
  }

  // --- Stage 11: compliance veto (code, not model). ---
  const comp = complianceCheck({ pm, risk, redteam, ticket, ev });
  emit("seat:verdict", { seat: "Compliance", mint, symbol: ev.symbol, pass: comp.pass,
    detail: comp.violations.map((v) => v.code).join(", ") || "clear" });

  let finalDecision = pm.decision;
  if (!comp.pass) finalDecision = "VETOED";

  const record = { mint, symbol: ev.symbol, outcome: "decided", weighted, ev, analysts,
    redteam, risk, pm, ticket, compliance: comp, finalDecision };

  // --- Stage 12: the CEO. Only a clean proposal reaches the door. ---
  if (finalDecision === "PROPOSE") {
    emit("stage", { stage: "ceo", mint, symbol: ev.symbol });
    const ceo = await runCEO({ ev, pm, risk, redteam, ticket, compliance: comp });
    record.ceo = ceo;
    store.recordVerdict(cycle, mint, ev.symbol, "ceo",
      { verdict: ceo.ruling, score: ceo.order_size_usd, confidence: ceo.confidence, ...ceo });
    emit("seat:verdict", { seat: "CEO", mint, symbol: ev.symbol, detail: ceo.ruling,
      score: ceo.order_size_usd, one_line: ceo.one_line });

    record.order = await writeOrderSlip(cycle, { ev, ceo, pm, risk, ticket });
    finalDecision = ceo.ruling === "APPROVE" ? "APPROVED" : ceo.ruling === "HOLD" ? "HELD" : "DECLINED";
    record.finalDecision = finalDecision;
    record.proposalId = store.recordProposal(cycle, ev, { ...pm, decision: finalDecision }, risk, ticket);
  }

  // --- Stage 12: scribe. ---
  const file = writeReport(cycle, record);
  record.reportFile = file;
  emit("token:end", { mint, symbol: ev.symbol, outcome: finalDecision, conviction: pm.conviction,
    thesis: pm.thesis, size: record.order?.size ?? risk.position_size_usd, stop: ticket?.stop_price,
    gmgn: record.order?.links?.gmgn, report: file });
  return record;
}

/** A full desk cycle: scout the universe, then work up the shortlist. */
export async function runCycle({ limit = cfg.maxCandidates, mints = null } = {}) {
  const cycle = cycleId();
  emit("cycle:start", { cycle });
  const results = [];

  let shortlist;
  if (mints?.length) {
    shortlist = mints.map((m) => ({ mint: m, why_now: "operator-specified", interest: 100 }));
    emit("scout:manual", { count: shortlist.length });
  } else {
    const universe = await buildUniverse();
    if (!universe.length) {
      emit("cycle:end", { cycle, note: "empty universe" });
      return { cycle, results: [] };
    }
    const scouted = await runScout(universe.slice(0, 60));
    shortlist = (scouted.picks || []).slice(0, limit);
    emit("scout:shortlist", { count: shortlist.length, picks: shortlist.map((p) => p.mint) });
  }

  for (const pick of shortlist.slice(0, limit)) {
    try {
      results.push(await workup(cycle, pick.mint, pick.why_now));
    } catch (e) {
      emit("token:end", { mint: pick.mint, outcome: "error", detail: String(e?.message || e) });
      results.push({ mint: pick.mint, outcome: "error", error: String(e?.message || e) });
    }
  }

  emit("cycle:end", { cycle, count: results.length, spendUsd: Number(spend.usd.toFixed(4)) });
  return { cycle, results, spend: { ...spend } };
}
