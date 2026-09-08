import * as ds from "./data/dexscreener.js";
import { gather, screen, enrichWithXRead, creatorHandle } from "./data/evidence.js";
import { reputationFor } from "./devrep.js";
import { recordLaunchShadow } from "./launch-shadow.js";
import { ANALYSTS, runAnalyst, runNarrative } from "./agents/analysts.js";
import { runScout, runRedTeam, runRisk, runPM, runExecution } from "./agents/decision.js";
import { complianceCheck } from "./agents/compliance.js";
import { enforceRiskRails, enforceCeoRails } from "./agents/risk-rails.js";
import { applyRedTeamBar } from "./agents/redteam-policy.js";
import { runCEO } from "./agents/ceo.js";
import { writeOrderSlip } from "./order.js";
import { emit } from "./lib/bus.js";
import { OutOfCredit, spend, assertDailyBudget, creditBreakerState } from "./lib/llm.js";
import { cfg, escalationPlan } from "./config.js";
import * as store from "./lib/store.js";
import { writeReport } from "./report.js";
import { composite } from "./agents/composite.js";
import * as evaluation from "./evaluation.js";

const cycleId = () => new Date().toISOString().replace(/[:.]/g, "-");

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
/**
 * The first seat that refuses, or null.
 *
 * Named and exported because it is now load-bearing in TWO places: the desk has always
 * ended a workup on any analyst's kill, and the same rule now decides whether the
 * reputation read — 44.6% of the desk's entire model bill — is worth buying at all. A
 * coin the cheap seats condemn is a coin no X read can save, so the read is never
 * bought for it. If this ever returns null where a seat did refuse, the desk goes back
 * to paying for research about coins it is about to reject.
 */
export function firstKiller(analysts) {
  return Object.entries(analysts || {}).find(([, a]) => a?.kill) ?? null;
}

/* THE CHEAP BATCH, named so a test derives the seats it expects from the source instead
   of pinning them. Technical was the third seat here until 2026-09-08 — 31 calls, $0.67
   in a live day, 0 kills and no KILL clause to make one; agents/analysts.js has the
   retirement note. Liquidity now sits on Haiku 4.5, so the whole batch is ~$0.045. */
export const CHEAP_SEATS = Object.freeze(["liquidity", "flow"]);

/**
 * Whether the desk should buy the reputation read for this coin.
 * True only while every seat that has reported so far has let the coin live.
 */
export function shouldBuyReputationRead(analysts) {
  return firstKiller(analysts) === null;
}

/**
 * The desk's own ledger entry for this coin's creator, if it condemns them; else null.
 *
 * devrep.js exists so that "the second coin from a known rugger is caught for free",
 * and it was not doing that: the record was read only inside enrichWithXRead, AFTER the
 * ~$0.15 read had been paid for, and the kill in workup() trusted only what the fresh
 * read said. So every relaunch by an account the desk had already written down, with
 * evidence, bought the research again. Live ledger when this was written: 21 serial
 * ruggers against 288 suspects.
 *
 * The handle is creatorHandle(ev) — the SAME resolution the read starts from — so the
 * ledger and Grok are asked about one identity. Only `serial_rugger` condemns, and
 * devrep.js stores that verdict only when the rugging was SOURCED (an unsourced
 * accusation is filed as `suspect`). suspect, clean and unknown all return null here
 * and change nothing about the workup: the read is bought exactly as before.
 */
export function ruggerOnLedger(ev) {
  const handle = creatorHandle(ev);
  const rep = handle ? reputationFor(handle) : null;
  return rep?.verdict === "serial_rugger" ? rep : null;
}

/**
 * The risk rails, with a zero made visible.
 *
 * enforceRiskRails sizes a record to $0 on four mechanical grounds (the exit probe
 * never completed, a live authority, no valid stop, no paper budget) and says so only
 * in a rail note the Risk seat's verdict swallows. Downstream that zero is the
 * `zero_authorized_size` SAFETY gate — one of the four post-PM losses (refuted,
 * conviction, zero size, book) no live counter itemised while today's 13 WATCH verdicts
 * produced 0 cohort calls. Emitting it here, at the one call site, is what lets the
 * publishability ledger and the chronicle both name the rails as the cause.
 */
export function railRisk({ risk, ev, redteam, mint, symbol }) {
  const out = enforceRiskRails({ risk, ev, redteam });
  if (!(out.position_size_usd > 0))
    emit("risk:mechanical_zero", { mint, symbol,
      reason: (out.rail_notes ?? []).find((n) => /^mechanical zero/.test(String(n)))
        ?? "position_size_usd is 0 with no rail note",
      modelSize: Number.isFinite(Number(risk?.position_size_usd)) ? Number(risk.position_size_usd) : null,
      modelTier: risk?.risk_tier ?? null });
  return out;
}

export async function workup(cycle, mint, hook = "", opts = {}) {
  // Evaluation provenance must retain the spending/trigger lane. It is evidence about
  // how a signal was produced, not merely a label for the live scheduler.
  const recordEvaluation = (record) => evaluation.recordDecision(cycle, {
    ...record,
    runKind: opts.lane ?? "cycle",
    pmProvider: record?.pm?._provider ?? "none",
  });
  // Both spenders — the penthouse cycle and a tenant's floor run — pass through here,
  // so this is where the daily cap bites. Before the free stages, deliberately: a
  // workup that cannot afford its model stages should not pretend to start.
  // The lane decides WHOSE money this is. The scanning lanes yield to a reserve so
  // they cannot eat the day before the publishing cycle has run; a tenant's paid
  // floor run is never throttled. See assertDailyBudget.
  assertDailyBudget(cfg.dailyBudgetUsd, { lane: opts.lane ?? "cycle" });
  /* EVERY RELAXATION THE QUOTA BOUGHT, IN THE ORDER IT WAS TAKEN. Carried on the record
     and stamped onto the published call, because the owner asked to be able to read
     "this was published at L3 because the cycle was short" off the call itself. A
     silent lowering is the failure mode this list exists to make impossible. */
  const relaxations = [];
  emit("token:start", { mint, hook });

  const ev = await gather(mint, hook);
  if (!ev.ok) {
    emit("token:end", { mint, outcome: "no_data", detail: ev.error });
    const rec = { mint, outcome: "no_data", error: ev.error, finalDecision: "no_data" };
    recordEvaluation(rec);
    return rec;
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
    recordEvaluation(rec);
    return rec;
  }

  /* DO NOT BUY A READ FOR A COIN NOBODY CAN JUDGE.
   *
   * The X read is bought here because it can end a workup for $0.13 and save $0.63 of
   * later analysis. That trade is only good when the analysis it might save can
   * actually run. While the Anthropic breaker is refusing, it cannot: liquidity, flow
   * and technical fail as a batch, the workup throws OutOfCredit and the cycle halts —
   * AFTER the xAI read has already been paid for. Measured 2026-09-07, with the
   * Anthropic balance empty: 46 reads bought at ~$0.155 while every cycle published
   * nothing, $7.16 of xAI spend for coins no seat ever looked at.
   *
   * The condition is deliberately narrow, because the ONLY thing that closes a credit
   * breaker is a real call through acquireCredit. Bailing whenever the breaker is
   * merely non-closed would remove the probe that recovers it and the desk would never
   * think again. `probeReadyInMs > 0` is exactly the window in which acquireCredit
   * returns a refusal WITHOUT sending a request — open and still cooling down, or
   * half_open with another probe already in flight. The moment a probe is due this
   * check stops firing and the workup proceeds, so recovery is untouched. */
  const analystCredit = creditBreakerState("anthropic");
  if (analystCredit.state !== "closed" && analystCredit.probeReadyInMs > 0) {
    emit("token:end", { mint, symbol: ev.symbol, outcome: "credit_outage",
      detail: `the analyst seats cannot run for another ${Math.ceil(analystCredit.probeReadyInMs / 1000)}s — ` +
        "nothing was bought for this coin" });
    throw new OutOfCredit("the Anthropic balance is empty — the desk cannot think " +
      "(breaker open, no read bought)");
  }

  /* The seat ledger for this workup. Declared here, above the read, because the outage
     probe below may fill its first entry before anything is bought. */
  const analysts = {};
  const seatFailures = [];
  /* Set by collect() when a rejection is the provider refusing on credit. It is checked
     after each settled batch rather than inside collect, so the other seats in that batch
     still record their verdicts before the cycle stops. */
  let creditFailure = null;
  const collect = (k, r) => {
    if (r.status === "fulfilled") {
      analysts[k] = r.value;
      store.recordVerdict(cycle, mint, ev.symbol, k, r.value);
      emit("seat:verdict", { seat: ANALYSTS[k]?.label ?? "Narrative", mint, symbol: ev.symbol,
        score: r.value.score, confidence: r.value.confidence, kill: r.value.kill });
    } else {
      seatFailures.push({ seat: k, error: String(r.reason?.message || r.reason) });
      emit("seat:failed", { seat: k, mint, error: String(r.reason?.message || r.reason) });
      /* A DEAD ACCOUNT IS NOT A SEAT FAILURE. Promise.allSettled turns every rejection
       * into a value, so the OutOfCredit that lib/llm.js throws when the balance is empty
       * was being filed here beside a timeout and a bad JSON body, and the workup went on
       * to return "insufficient_coverage" — a research verdict wearing a billing failure.
       * penthouse.js:773 has been waiting for that throw the whole time. Measured on
       * 2026-09-06 while both accounts were dry: 1,323 refused Anthropic requests an hour,
       * 92% of candidates ending as insufficient_coverage, and 2 cycle:halted in 3.2 hours.
       * Remember it and rethrow once the batch has been collected, so every seat still
       * reports and the cycle still halts. */
      if (r.reason instanceof OutOfCredit) creditFailure = creditFailure ?? r.reason;
    }
  };
  /* A kill from any analyst ends the workup the same way wherever it lands. The stage
     names what the kill SAVED, and the two call sites below say it honestly: one fires
     before the read is bought, the other after. */
  const endOnKill = (killer, stage, detail) => {
    emit("stage", { stage, mint, symbol: ev.symbol, detail });
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: killer[0],
      reason: killer[1].kill_reason, ev, analysts, seatFailures, finalDecision: "killed" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `${killer[0]}: ${killer[1].kill_reason}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  };

  /* THE PROBE MUST NOT BE THE X READ.
   *
   * The guard above lets exactly one outage case through: a probe is due. Whatever the
   * desk buys next is that probe — and until now it was the $0.154 xAI read, bought for
   * every screen survivor the instant the cooldown lapsed, before any Anthropic seat had
   * been asked whether the account pays. Measured live over 24h: XRead 110 calls
   * ($14.69) against Liquidity 31, so ~79 reads (~$10.5, 28% of a $38.26 day) were
   * bought for coins no seat ever judged; over 7 days, at least 967 of 1,437 reads.
   *
   * So while the breaker is not closed the desk asks its CHEAPEST seat first — Liquidity,
   * $0.03 median live today, ~$0.013 once it sits on Haiku — and only that seat's bill
   * buys the read. A credit refusal costs nothing here and halts the cycle exactly as
   * the batch below would have; a success is what closes the breaker (gate.success() at
   * the meter, llm.js), and the workup then proceeds precisely as in the healthy regime
   * minus the one seat already answered. A probe that fails WITHOUT proving the account
   * pays — a timeout, a 404 after a retier — re-arms the breaker for a fresh cooldown,
   * so every seat after the read would be refused and the read would be the same waste:
   * that ends here too, with nothing bought. And a probe that condemns the coin ends it
   * the way any cheap-seat kill does, before a read is paid for.
   *
   * The healthy order is untouched. With the breaker closed the read still goes SECOND,
   * straight after the free screen, as the owner set it on 2026-09-04: in the token:end
   * window it killed 59 of 94 paid survivors (63%) against the trio's 12 of 35 (34%).
   * This is an outage fix and only that. */
  let probedSeat = null;
  if (analystCredit.state !== "closed") {
    emit("stage", { stage: "credit_probe", mint, symbol: ev.symbol,
      detail: "the analyst breaker is open and a probe is due — Liquidity is asked first, and only its bill buys the reputation read" });
    const probe = await Promise.allSettled([runAnalyst("liquidity", ev)]);
    collect("liquidity", probe[0]);
    probedSeat = "liquidity";
    const afterProbe = creditBreakerState("anthropic");
    if (creditFailure || afterProbe.state !== "closed") {
      emit("token:end", { mint, symbol: ev.symbol, outcome: "credit_outage",
        detail: creditFailure
          ? "the probe was refused for credit — nothing was bought for this coin"
          : `the probe failed without proving the account pays (${seatFailures.at(-1)?.error ?? "no detail"}) ` +
            "— nothing was bought for this coin" });
      throw creditFailure ?? new OutOfCredit("the Anthropic balance is empty — the desk cannot think " +
        "(probe failed, no read bought)");
    }
    const probeKiller = firstKiller(analysts);
    if (probeKiller) {
      return endOnKill(probeKiller, "xread_skipped",
        `${probeKiller[0]} killed it as the credit probe — the reputation read was never bought`);
    }
  }

  /* SAFETY CLEARED — only now does the desk buy anything about this coin.
   *
   * The screen above answered the question that disqualifies outright: can this be used
   * against a holder, and can the position be left. Reputation research is expensive
   * and only matters once that answer is yes, so the paid X read happens HERE rather
   * than inside gather(), where it was costing 107 reads against 235 screen kills. */
  /* GROK GOES SECOND, RIGHT BEHIND THE SAFETY SCREEN (owner, 2026-09-04).
   *
   * The reputation read is the desk's only look outside the chain — who launched this,
   * what the story is, whether the account has rugged before. Bought LAST it was a
   * footnote on a decision already made; bought SECOND it is context every later seat
   * reasons with, which is what the owner meant by using it to front-run a narrative
   * rather than to confirm one.
   *
   * I had moved it last, on cost: it was 44.6% of the bill, $84.87 of $190.39 over a
   * day, and buying the most expensive opinion before the cheap ones is backwards on
   * price alone. That reasoning was right about money and wrong about the job. The
   * answer is not to buy it late but to let it DECIDE early: a read that names a serial
   * rugger or a manufactured story ends the workup here, before forensics, flow,
   * technical, narrative, the red team, risk and the PM are ever paid for. On the
   * measured seat prices that is $0.63 of analysis saved per coin it condemns, against
   * $0.13 spent to ask — so putting it second is cheaper than putting it last whenever
   * it kills more than a fifth of what it sees.
   *
   * The free deterministic screen still runs FIRST and is unchanged. Nothing here is
   * bought for a coin that could not be exited, and the kill below is deliberately
   * narrow: only what Grok states as fact about the deployer or the story, never a
   * lukewarm verdict, because an expensive seat killing on a hunch is how a desk stops
   * publishing anything at all. */
  /* THE LEDGER IS ASKED BEFORE THE READ IS BOUGHT, NOT AFTER IT.
   *
   * A rugger rotates wallets and keeps the account, and devrep.js remembers the
   * account — but until now only enrichWithXRead read it, once the read was already
   * paid for, and the kill below acts only on the fresh read's serial_rugger. Asked
   * here, a creator the desk has already condemned WITH EVIDENCE ends the workup for $0
   * and nothing is bought about the coin. This is the paid arm's own SAFETY kill
   * (deployer_has_rugged, calls.js GATE_CLASS — absolute at every level) moved earlier
   * and made free; it adds no gate and waives none. Recorded as an XRead verdict so
   * recentKill keeps the coin out of the universe for the usual 12h, and marked
   * from_ledger so nothing that counts reads mistakes it for a purchase. */
  const rugger = ruggerOnLedger(ev);
  if (rugger) {
    const seen = rugger.tokens.length;
    const ledgerKill = `the deployer's own account (@${rugger.handle}) has rugged before — on the desk's ledger ` +
      `since ${new Date(rugger.first_seen).toISOString().slice(0, 10)}, ${seen} launch${seen === 1 ? "" : "es"} seen: ` +
      `${String(rugger.evidence || "").slice(0, 180) || "sourced by an earlier reputation read"}`;
    emit("stage", { stage: "ledger", mint, symbol: ev.symbol,
      detail: "the desk's own ledger condemns this creator — the reputation read was never bought" });
    emit("seat:verdict", { seat: "XRead", mint, symbol: ev.symbol, kill: true, detail: ledgerKill });
    store.recordVerdict(cycle, mint, ev.symbol, "XRead",
      { verdict: "FAIL", kill: true, kill_reason: ledgerKill, from_ledger: true, handle: rugger.handle });
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: "xread", killArm: "serial_rugger",
      reason: ledgerKill, ev, analysts, seatFailures, finalDecision: "killed", relaxations };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `xread: ${ledgerKill}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  emit("stage", { stage: "reputation", mint, symbol: ev.symbol });
  await enrichWithXRead(ev, hook).catch(() => {});

  /* WHAT THE READ IS ALLOWED TO END A WORKUP FOR. Facts it claims to have sourced —
     a deployer whose prior coins rugged, or a story it can show is fabricated — not a
     tepid opinion. `serial_rugger` is the seat's own word for "this ACCOUNT has done
     this before, more than once", which is the single strongest signal available about
     a coin nobody has traded yet. */
  const read = ev.xRead && !ev.xRead.error ? ev.xRead : null;
  /* THE LAUNCH PROXIES, WRITTEN BESIDE THE VERDICT THEY WILL BE JUDGED AGAINST. The
     creator's share of supply, whether they have sold, and what the launch minute
     carried against the curve (data/solana.js, data/pumpfun-live.js) are new rulers, and
     a ruler is validated before it is trusted: one row per PAID read, so their precision
     against serial_rugger and manufactured can be read off launch-shadow.js before any
     of them is allowed to end a workup. Bookkeeping; it can never fail the workup. */
  if (read) { try { recordLaunchShadow(ev, read); } catch { /* a shadow row must never fail a workup */ } }
  /* THE TWO ARMS ARE NOT THE SAME KIND OF THING, and the cohort quota is what forced
   * the distinction into the code rather than leaving it in the prose above.
   *
   *   serial_rugger      — a FACT the seat claims to have sourced about the DEPLOYER's
   *                        own account. 4 of the last 100 kills. SAFETY: absolute at
   *                        every escalation level, for any quota, forever.
   *   manufactured story — the seat's OPINION about attention. ~21 of 100 kills, the
   *                        single largest judgement gate on the desk, and a wrong
   *                        opinion about who is posting costs an opportunity, not a
   *                        position that cannot be sold. JUDGMENT: L3 of the ladder
   *                        accepts it, and ONLY when every safety gate has passed —
   *                        which is enforced downstream in publishCall, not here.
   *
   * Nothing about this arm is bypassed quietly: the verdict is still recorded, the
   * relaxation is stamped on the record, and it rides onto the published call so a
   * reader sees "published at L3 because the cycle was short" rather than a silence. */
  const killArm = read?.serial_rugger === true ? "serial_rugger"
    : (read?.verdict === "manufactured" && read?.paid_or_botted_signs === true) ? "manufactured"
    : null;
  const armText = killArm === "serial_rugger"
    ? `the deployer's own account has rugged before: ${String(read?.rug_evidence || "").slice(0, 180) || "stated by the reputation read"}`
    : killArm === "manufactured"
      ? "the story is manufactured and the attention behind it is paid or botted"
      : null;
  const plan = escalationPlan(opts.escalationLevel ?? 0);
  const waived = killArm === "manufactured" && plan.acceptManufacturedNarrative;
  const grokKill = waived ? null : armText;
  if (waived) {
    const note = `L${plan.level}: the X read called the story manufactured — accepted because the cycle is short of quota; every safety gate still applies`;
    relaxations.push(note);
    emit("seat:relaxed", { seat: "XRead", mint, symbol: ev.symbol, level: plan.level, detail: note });
    store.recordVerdict(cycle, mint, ev.symbol, "XRead",
      { verdict: "MANUFACTURED", kill: false, kill_reason: null, relaxed_at_level: plan.level, note: armText });
  }
  if (grokKill) {
    emit("seat:verdict", { seat: "XRead", mint, symbol: ev.symbol, kill: true, detail: grokKill });
    store.recordVerdict(cycle, mint, ev.symbol, "XRead", { verdict: "FAIL", kill: true, kill_reason: grokKill });
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: "xread", killArm,
      reason: grokKill, ev, analysts, seatFailures, finalDecision: "killed", relaxations };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `xread: ${grokKill}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  emit("stage", { stage: "analysis", mint, symbol: ev.symbol });
  /* Liquidity is left out here when it already ran as the outage probe above: its
     verdict is on the ledger and a seat is not bought twice for one coin. */
  const cheapKeys = CHEAP_SEATS.filter((k) => k !== probedSeat);
  const cheap = await Promise.allSettled(cheapKeys.map((k) => runAnalyst(k, ev)));
  cheap.forEach((r, i) => collect(cheapKeys[i], r));
  if (creditFailure) throw creditFailure;

  /* A kill here is final, exactly as it is after the full batch — so stop, and keep
     forensics, narrative, the red team, risk, the PM and execution: a fully-worked coin
     is ~$1.30 against the ~$0.30 spent by this line. Recorded so the effect is auditable
     rather than asserted — and recorded HONESTLY. This event was called `xread_skipped`
     while the read had been bought some sixty lines above it; what a kill here actually
     skips is the deep batch and every decision seat after it. */
  const cheapKiller = firstKiller(analysts);
  if (cheapKiller) {
    return endOnKill(cheapKiller, "deep_skipped",
      `${cheapKiller[0]} killed it after the reputation read — forensics, narrative and the decision seats were not bought`);
  }

  /* STARTED, NOT AWAITED, and only for a coin still standing. Forensics reads the
     deployer's public record and narrative reads the story, so both wait on it; nothing
     else does. A failed read must not take the workup down — enrichWithXRead degrades
     to "no read", and the seats say so themselves when ev.xRead is missing. */
  /* The read is already on the bundle, so forensics and narrative no longer wait on it
     — and neither does anything else. Every seat from here reasons with it. */
  const deepKeys = ["forensics", "narrative"];
  const deep = await Promise.allSettled([runAnalyst("forensics", ev), runNarrative(ev)]);
  deep.forEach((r, i) => collect(deepKeys[i], r));
  if (creditFailure) throw creditFailure;

  // A desk missing half its analysts is not a desk. Refuse to decide on a thin book.
  // Four seats since Technical retired, so 3 tolerates ONE failure among Liquidity, Flow,
  // Forensics and Narrative where it tolerated two — kept at 3 on purpose: two of four
  // is half, and the floor was never a seat count in disguise.
  if (Object.keys(analysts).length < 3) {
    emit("token:end", { mint, symbol: ev.symbol, outcome: "insufficient_coverage" });
    const rec = { mint, symbol: ev.symbol, outcome: "insufficient_coverage", seatFailures, ev, analysts,
      finalDecision: "insufficient_coverage" };
    recordEvaluation(rec);
    return rec;
  }

  const killer = firstKiller(analysts);
  if (killer) {
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: killer[0],
      reason: killer[1].kill_reason, ev, analysts, finalDecision: "killed" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `${killer[0]}: ${killer[1].kill_reason}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  // --- Stage 7-9: adversary, risk, decision. ---
  const weighted = composite(analysts);
  emit("stage", { stage: "redteam", mint, symbol: ev.symbol, weighted: Number(weighted.toFixed(1)) });
  const redteamRaw = await runRedTeam(ev, analysts);
  let redteam = redteamRaw;

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
  const barred = applyRedTeamBar(redteam, ev);
  redteam = barred.redteam;
  const fatal = barred.verifiedFatal;
  if (redteam.downgraded_from) emit("seat:downgraded", { seat: "Red Team", mint, symbol: ev.symbol,
    from: "refuted", to: "wounded", reason: redteam.downgrade_reason });

  store.recordVerdict(cycle, mint, ev.symbol, "redteam", { verdict: redteam.verdict, confidence: redteam.confidence, ...redteam });
  emit("seat:verdict", { seat: "Red Team", mint, symbol: ev.symbol, detail: redteam.verdict,
    kill: redteam.verdict === "refuted",
    fatalAttacks: fatal.length,
    ...(redteam.downgraded_from ? { downgradedFrom: redteam.downgraded_from } : {}) });

  /* A REFUTATION THAT SURVIVED THE BAR ENDS THE WORKUP HERE.
   *
   * Past applyRedTeamBar, `refuted` means a fatal attack the seat marked verified AND
   * the evidence bundle confirms (redteam-policy.js confirmedByBundle) — a fact about the
   * coin, not the base rate. The mandate already treats that as a SAFETY refusal unless
   * the PM proposes over it (mandate.js `redteam_refuted_unanswered`, calls.js GATE_CLASS),
   * and the rails hand a refuted coin a quarter multiplier the PM's brief then forbids a
   * PROPOSE against once it reaches zero. Measured all-time: the PM proposed over a
   * refutation 3 times in 260, and 69 of the 281 coins that reached the red team (25%)
   * left it refuted — every one of which then bought Risk ($0.063), the PM ($0.173) and,
   * when a ticket was drafted, Execution ($0.045): ~$0.28 a coin for a record the
   * mandate was always going to decline.
   *
   * So the workup ends with the verdict on the record and nothing else bought. The gate
   * does not move: gateFor still stamps `redteam`, eligibility still declines with
   * safety:true, and no escalation level reaches past it. What closes is the PM's
   * answer-the-refutation path, which the owner may reopen for deployer_misconduct with
   * an external citation. The downgraded case is deliberately NOT here: a refutation the
   * bar could not verify is `wounded`, and a wounded coin still buys all three seats. */
  if (redteam.verdict === "refuted") {
    emit("stage", { stage: "decision_skipped", mint, symbol: ev.symbol,
      detail: `the red team refuted it on ${fatal.length} verified fatal attack${fatal.length === 1 ? "" : "s"} — Risk, the PM and Execution were not bought` });
    const record = { mint, symbol: ev.symbol, outcome: "decided", weighted, ev, analysts,
      redteamRaw, redteam, risk: null, pm: null, ticket: null, compliance: null,
      finalDecision: "REFUTED", escalationLevel: plan.level, relaxations };
    record.reportFile = writeReport(cycle, record);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "REFUTED",
      detail: `red team: ${redteam.headline ?? "refuted"}`, report: record.reportFile });
    record.decisionRunId = recordEvaluation(record);
    return record;
  }

  const modelRisk = await runRisk(ev, analysts, redteam);
  /* NO BOOK-HEAT ARGUMENT. `retainedBookRiskUsd(liveCalls())` used to ride in here as
     `openRiskUsd` and, once the desk's paper book was "full", zeroed the size and killed
     a clean coin at the publication gate. Deleted 2026-09-07: how much is at risk is the
     bot's question, answered against the wallet that signs (executor/strategy.mjs:308-311),
     not the desk's against a book nobody trades. */
  const risk = railRisk({ risk: modelRisk, ev, redteam, mint, symbol: ev.symbol });
  if (risk.rail_notes?.length) emit("seat:adjusted", { seat: "Risk", mint, symbol: ev.symbol,
    detail: risk.rail_notes.join("; "), modelTier: modelRisk.risk_tier,
    finalSize: risk.position_size_usd });
  store.recordVerdict(cycle, mint, ev.symbol, "risk", { score: risk.position_size_usd, confidence: risk.confidence, ...risk });
  emit("seat:verdict", { seat: "Risk", mint, symbol: ev.symbol, detail: `$${risk.position_size_usd}` });

  /* A MECHANICAL ZERO ENDS THE WORKUP HERE, BEFORE THE PM AND EXECUTION.
   *
   * railRisk has already emitted risk:mechanical_zero and named the rail (an exit the
   * probe never proved, a live authority, no stop under the price). What is left to
   * decide is nothing: the PM's brief forbids PROPOSE at zero size (decision.js
   * PM_SYSTEM), a WATCH at zero size dies at `zero_authorized_size` — SAFETY, no level
   * reaches past it (calls.js GATE_CLASS, mandate.js) — and the ticket was already gated
   * on a positive size at stage 10. So the $0.173 Opus call could not change the
   * outcome; it was the largest of the ~$0.28 bought after a verdict the gate had
   * already settled. The record still carries the railed size and the rail note, so the
   * publishability ledger and the chronicle name the rails as the cause. */
  if (!(risk.position_size_usd > 0)) {
    const railNote = (risk.rail_notes ?? []).find((n) => /^mechanical zero/.test(String(n)))
      ?? "the rails sized this at $0";
    emit("stage", { stage: "pm_skipped", mint, symbol: ev.symbol,
      detail: `${railNote} — the PM and Execution were not bought` });
    const record = { mint, symbol: ev.symbol, outcome: "decided", weighted, ev, analysts,
      redteamRaw, redteam, risk, pm: null, ticket: null, compliance: null,
      finalDecision: "ZERO_SIZE", escalationLevel: plan.level, relaxations };
    record.reportFile = writeReport(cycle, record);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "ZERO_SIZE", size: 0,
      detail: railNote, report: record.reportFile });
    record.decisionRunId = recordEvaluation(record);
    return record;
  }

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
    redteamRaw, redteam, risk, pm, ticket, compliance: comp, finalDecision,
    // The escalation this workup was bought at, and what it bought. Both travel to
    // publishCall, which stamps them on the call.
    escalationLevel: plan.level, relaxations };

  // --- Stage 12: the CEO. Only a clean proposal reaches the door. ---
  if (finalDecision === "PROPOSE") {
    emit("stage", { stage: "ceo", mint, symbol: ev.symbol });
    const modelCeo = await runCEO({ ev, pm, risk, redteam, ticket, compliance: comp },
      { ...opts, pmProvider: pm._provider ?? "claude" });
    const ceo = enforceCeoRails({ ceo: modelCeo, risk });
    if (ceo.rail_notes?.length) emit("seat:adjusted", { seat: "CEO", mint, symbol: ev.symbol,
      detail: ceo.rail_notes.join("; "), modelSize: modelCeo.order_size_usd,
      finalSize: ceo.order_size_usd });
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

  // --- Stage 13: scribe. ---
  const file = writeReport(cycle, record);
  record.reportFile = file;
  emit("token:end", { mint, symbol: ev.symbol, outcome: finalDecision, conviction: pm.conviction,
    thesis: pm.thesis, size: record.order?.size ?? risk.position_size_usd, stop: ticket?.stop_price,
    gmgn: record.order?.links?.gmgn, report: file });
  // Publication happens later in the penthouse. Carry only the immutable row id so the
  // call sheet can link the strategy actually selected back to this exact evidence.
  record.decisionRunId = recordEvaluation(record);
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
