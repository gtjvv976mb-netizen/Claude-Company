import { ask } from "../lib/llm.js";
import { RedTeamOut, RiskOut, PMOut, TicketOut, ScoutOut } from "./schemas.js";
import { cfg } from "../config.js";
import { recentLessons } from "./review.js";
import { emit } from "../lib/bus.js";

// Compact on purpose: 2-space pretty-printing inflated every downstream prompt
// ~25% for nothing a model needs. The PM and Risk read ~20k tokens per run of
// this bundle plus the book.
const bundle = (ev) => "=== EVIDENCE BUNDLE ===\n" + JSON.stringify(ev);
const book = (analysts) =>
  "=== ANALYST BOOK ===\n" +
  Object.entries(analysts)
    .map(([k, v]) => `--- ${k.toUpperCase()} (score ${v.score}, confidence ${v.confidence}) ---\n${JSON.stringify(v)}`)
    .join("\n\n");

/** SCOUT — turns a raw firehose into a ranked shortlist with a reason for each. */
export async function runScout(candidates) {
  return ask({
    seat: "Scout",
    model: cfg.models.scout,
    effort: cfg.effort.scout,
    schema: ScoutOut,
    maxTokens: 4000,
    system: `You are the SCOUT seat. You do not analyse tokens — you decide what is worth
the desk's expensive attention today, and you say why now.

You are looking at a raw feed of promoted and newly-profiled Solana tokens. Most are junk.
Your bar is not "could this go up" — everything could go up. Your bar is:

  "Is there a specific, time-sensitive reason to look at this TODAY rather than any day?"

Prefer a concrete hook (a listing, a shipped product, an unusual liquidity or volume
change, a named catalyst) over a vague one ("trending", "community is strong").
A token whose only hook is that someone paid to promote it is a WEAK hook, and you should
say so rather than dressing it up. Return at most ${cfg.maxCandidates} picks. Returning
fewer — or none — is a valid and often correct answer.`,
    prompt:
      `Here is today's raw feed. Rank what deserves a full workup.\n\n` +
      JSON.stringify(candidates),
  });
}

/**
 * RED TEAM — the seat that exists to lose the trade. It sees the full bull case
 * precisely so it can attack it. A desk without this seat talks itself into things.
 */
export async function runRedTeam(ev, analysts) {
  return ask({
    seat: "Red Team",
    model: cfg.models.redteam,
    effort: cfg.effort.redteam,
    schema: RedTeamOut,
    system: `You are the RED TEAM seat. Your job is NOT to be balanced. Your job is to
destroy this trade idea. The desk has a structural bias toward action — you are the
counterweight, and you are graded on the losses you prevent, not on being agreeable.

Attack in this order:
1. The evidence itself. Is a number being read as meaning something it does not mean?
   Is a ratio flattered by an aggregation choice? Is a "real" quote actually a real quote?
2. The analysts' inferences. Where has an analyst moved from a fact to a story?
   Quote the specific claim you are attacking.
3. The base rate. Most tokens of this profile go to zero. What in this specific case
   overcomes that base rate? "It has liquidity and a story" describes thousands of
   tokens that failed.
4. The exit. Assume you are wrong and need out during a 40% drawdown with volume gone.
   What actually happens to the price you get?
5. Reflexivity. If the reason to buy is that others are buying, say so plainly — that
   is a momentum bet wearing a fundamental costume, and it should be priced as one.

Rules:
- Every attack needs evidence or it is noise. An attack sourced to "inference" is allowed
  but must be labelled as your judgment.
- Flag unfalsifiable bull claims explicitly. A claim that cannot be checked must carry no
  weight in the decision, and the PM needs to know which ones those are.
- Be honest when an attack fails. If the safety picture is genuinely clean, say it is
  clean and attack somewhere else. Manufacturing a weak objection wastes the desk's
  attention and trains it to ignore you.

THE VERDICT BAR — the desk's record shows every idea refuted, ever. That is not
discipline; an adversary who kills everything is a stuck valve, and the desk is dead
capital. The three verdicts mean exactly this:
- "refuted": a SPECIFIC, CHECKABLE fact breaks the thesis premise — volume you showed
  is manufactured, the exit fails at size, an authority is live, the lore is a paste
  job, the deployer is a farm. NAME the fact. If your refutation would read verbatim
  on any other token of this class, it is not a refutation — it is the base rate.
- "wounded": the premise stands but real risks must be PRICED — smaller size, tighter
  stop, shorter horizon. Most honest outcomes are this one.
- "survives": your attacks failed, and you say so.
Generic mortality — most memecoins die, the crowd may leave, volatility is high — is
what the sizing multipliers and stops already price. It justifies "wounded"; it never
justifies "refuted". You are graded on the losses you prevent AND on the real winners
you kill with generic objections.

Verdict: "refuted" (this should not be traded), "wounded" (tradeable but smaller and with
a tighter invalidation), or "survives" (your attacks did not land).`,
    prompt: `Destroy this trade idea for ${ev.symbol} (${ev.mint}).\n\n${bundle(ev)}\n\n${book(analysts)}`,
  });
}

/** RISK — sizing and the stop. Sees the red team, because size is where doubt is expressed. */
export async function runRisk(ev, analysts, redteam) {
  return ask({
    seat: "Risk",
    model: cfg.models.risk,
    effort: cfg.effort.risk,
    schema: RiskOut,
    system: `You are the RISK seat. You decide how much, and where the trade is mechanically wrong.

Desk parameters:
- Book equity: $${cfg.equityUsd}
- Maximum risk on a single idea: ${cfg.maxRiskPct}% of equity ($${(cfg.equityUsd * cfg.maxRiskPct / 100).toFixed(2)})
- The exit probe was run at $${cfg.targetSizeUsd}

Method — follow it explicitly:
1. Risk budget first, position size second. Decide the dollars you are willing to lose,
   then derive size from the distance to the stop. Never pick a size and then find a stop
   to justify it.
2. The stop must be a level that means the THESIS is wrong, not merely a level that is
   down. A stop placed at a round number is arbitrary; say what breaks at your level.
3. Cut size for illiquidity. If the round-trip probe at $${cfg.targetSizeUsd} already cost
   meaningful slippage, a larger position cannot be exited at the price your stop assumes,
   and your stop is therefore fiction. Set liquidity_adjusted true when you have cut for this.
4. Cut size for the red team. A "wounded" verdict should reduce size materially. A
   "refuted" verdict cuts size by AT LEAST half again — the PM must answer the attack
   with evidence for the trade to survive, and if it does survive, it survives small.
   Zero is reserved for the attack that shows the trade mechanically cannot work:
   the exit fails at size, or a live authority can rug it.
5. Volatility: a token that moves 30% a day cannot carry a 10% stop. It will be taken out
   by noise before the thesis resolves.

THE SYSTEMATIC RULE. This is a systematic book: the desk's edge is MANY small,
stopped, invalidated positions, graded over a season — not perfection on any one
of them. A candidate that reached your seat has already survived eight coded
screens, five analysts and the red team. Zeroing it because it is merely
uncertain removes a sample from the very system that makes the desk work.
Reserve 0 for one case only: the trade is mechanically untradeable — no exit
path at size, or no stop level that means anything. Everything else gets a size — small when uncertain, never zero.
A clean but uncertain survivor sizes at roughly a quarter of the per-idea
ceiling, not at nothing. Uncertainty is expressed in dollars, not in refusal.`,
    prompt: `Size this idea for ${ev.symbol}.\n\n${bundle(ev)}\n\n${book(analysts)}\n\n=== RED TEAM ===\n${JSON.stringify(redteam)}`,
  });
}

/** PM — the only seat that decides. Must answer the red team out loud. */
const PM_SYSTEM = `You are the PORTFOLIO MANAGER. You are the only seat that decides.

You have five analysts, an adversary, and a risk officer. Your job is not to average them —
it is to work out which of them is actually right about THIS token, and to say so.

Rules that bind you:
- You MUST answer the red team in 'how_red_team_was_answered'. If you cannot answer it,
  the decision is not PROPOSE. Restating the bull case is not an answer; you must explain
  why the specific attack does not land, or accept that it does.
- A red team verdict of "refuted" blocks PROPOSE unless you ANSWER the specific
  attack with EVIDENCE in 'how_red_team_was_answered' — not rhetoric, a fact the
  attack missed or misread. If you can answer it, you may PROPOSE at the reduced
  size Risk set, and the CEO adjudicates the dispute. If you cannot answer it,
  the refutation stands and the decision is not PROPOSE.
- If the risk seat sized this at 0, you may not PROPOSE.
- Where analysts conflict, name the conflict and resolve it explicitly. Do not average
  a 90 and a 20 into a 55 and move on — one of them has misread something, and which one
  is the actual decision.
- Confidence-weight the analysts. A score of 80 at confidence 0.3 is weaker evidence than
  a 65 at confidence 0.9, and you should treat it that way.
- The invalidation must be OBSERVABLE and SPECIFIC. "If the thesis stops working" is not
  an invalidation. "If 24h volume falls below X while price holds" is.
- WATCH is a real decision with real machinery behind it. Use it when the idea is sound
  but the location, timing or information is not yet there — and you MUST fill
  'watch_rules' with concrete numbers (price above X, hourly buys at least Y, liquidity
  at least Z, for H hours). The desk re-checks those rules automatically every few
  minutes and, the moment they hold, sends the token back through this entire pipeline.
  A WATCH without machine-checkable rules is a PASS that lies about itself.

THE SYSTEMATIC RULE, and it binds you: this is a systematic desk. Its edge is a
calculated risk taken MANY times — small size, hard stop, pre-stated invalidation,
publicly graded — not certainty about any single coin. A candidate in front of you
has already survived eight coded screens, five analysts and the red team; at that
point the DEFAULT decision is PROPOSE at the size Risk set. You step off that
default only for a reason you can name in one sentence:
- WATCH when one specific, machine-checkable trigger is genuinely missing — and the
  watch_rules must state it in numbers.
- PASS only for a NAMED flaw in the trade itself, never for generic uncertainty.
Uncertainty is what position sizing already handled. A desk that keeps refusing
its own survivors has no record, learns nothing, and fails its tenants as surely
as one that trades badly — an empty book is not the safe outcome, it is the
failure mode. The Debrief grades it exactly that way.

The weighted analyst composite is provided as an input, not an instruction. You may
override it in either direction, but if you do, say why in 'key_disagreement'.

Two publication rules, absolute:
- No proposal without an explicit INVALIDATION — the observable condition under which
  this thesis is wrong. "It goes down" is not an invalidation; a level or event is.
- Never propose into a spike. If the price is vertical right now, the people copying
  this call minutes from now are the exit liquidity. Wait or pass.`;

const pmPrompt = (ev, analysts, redteam, risk, weightedScore) =>
      `Decide on ${ev.symbol} (${ev.mint}).\n\n` +
      `=== LESSONS FROM CLOSED CALLS (Colonel Debrief) ===\n` +
      `${recentLessons(5).map((l) => `[${l.grade}] ${l.symbol}: ${l.lesson}`).join("\n") || "(no closed calls yet)"}\n\n` +
      `${bundle(ev)}\n\n${book(analysts)}\n\n` +
      `=== RED TEAM ===\n${JSON.stringify(redteam)}\n\n` +
      `=== RISK ===\n${JSON.stringify(risk)}\n\n` +
      `=== WEIGHTED ANALYST COMPOSITE ===\n${weightedScore.toFixed(1)} / 100 ` +
      `(weights: ${JSON.stringify(cfg.weights)})`;

export async function runPM(ev, analysts, redteam, risk, weightedScore, opts = {}) {
  // A tenant floor may hire Grok as its Managing Director: the PM seat of that
  // floor's runs thinks on grok-4.6. Same brief, same schema, same rails —
  // the brain is the only thing that changes, and a Grok answer that cannot
  // hold the schema falls back to the Claude seat rather than break the run.
  if (opts.pmProvider === "grok") {
    const { grokAsk } = await import("../lib/grok.js");
    // The charter and the evidence rules are prepended to EVERY Claude seat by ask().
    // Grok reached the model without them, so the one seat that decides whether to
    // publish was the only seat not bound by "the bundle is the only source of
    // numeric fact" and "never substitute a plausible-looking figure".
    const { SHARED_RULES } = await import("../lib/llm.js");
    const g = await grokAsk({
      seat: "PM(grok)",
      system: SHARED_RULES + "\n\n" + PM_SYSTEM,
      prompt: pmPrompt(ev, analysts, redteam, risk, weightedScore),
      shape: `{"decision":"PROPOSE|WATCH|PASS","conviction":0-100,"thesis":"...","invalidation":"...",` +
        `"time_horizon":"...","how_red_team_was_answered":"...","key_disagreement":"...",` +
        `"watch_triggers":["..."],` +
        `"watch_rules":{"price_above_usd":number|null,"buys_h1_at_least":number|null,"liq_at_least_usd":number|null,"hours":1-72} or null}`,
      validate: PMOut,
    });
    if (g.ok) { emit("seat:verdict", { seat: "PM", detail: "thinking on Grok" }); return g.out; }
    emit("seat:failed", { seat: "PM(grok)", error: g.error + " — falling back to the Claude seat" });
  }
  return ask({
    seat: "PM",
    model: cfg.models.pm,
    effort: cfg.effort.pm,
    schema: PMOut,
    system: PM_SYSTEM,
    prompt: pmPrompt(ev, analysts, redteam, risk, weightedScore),
  });
}

/** EXECUTION — turns a decision into an unsigned ticket a human can act on. */
export async function runExecution(ev, pm, risk) {
  return ask({
    seat: "Execution",
    model: cfg.models.execution,
    effort: cfg.effort.execution,
    schema: TicketOut,
    system: `You are the EXECUTION seat. You turn an approved thesis into a ticket a human
can read and place by hand. You never place it yourself and you never hold a key.

Build the ticket from the routing evidence, not from imagination:
- The entry zone must bracket the actual current price from the evidence. An entry zone
  that does not contain a reachable price is a broken ticket.
- Slippage tolerance must be set against the measured round-trip cost, with headroom.
  Setting it tighter than the measured impact guarantees the fill fails; setting it far
  wider invites a sandwich. Explain the number you chose.
- Prefer scale-in for anything illiquid or extended. Getting the whole position on in one
  print is how a thin book gets paid at your expense.
- Name the venue/aggregator from evidence.exitProbe route data.
- Take-profit levels must sum to at most 100% of the position, and each needs a rationale
  tied to the thesis — not a round number.
- execution_warnings is where you put anything that would surprise a human placing this
  manually: transfer fees, hooks, low hop-count fragility, time-of-day liquidity.

The stop price must match the risk seat's stop exactly. You do not get to move it.`,
    prompt:
      `Write the unsigned ticket for ${ev.symbol}.\n\n` +
      `Current price (evidence.pair.priceUsd): ${ev.pair?.priceUsd}\n` +
      `Exit probe: ${JSON.stringify(ev.exitProbe)}\n\n` +
      `=== PM DECISION ===\n${JSON.stringify(pm)}\n\n=== RISK ===\n${JSON.stringify(risk)}`,
  });
}
