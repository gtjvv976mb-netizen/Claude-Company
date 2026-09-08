import { ask } from "../lib/llm.js";
import { RedTeamOut, RiskOut, PMOut, TicketOut, ScoutOut, BestPickOut } from "./schemas.js";
import { cfg } from "../config.js";
import { recentLessons } from "./review.js";
import { emit, runContext } from "../lib/bus.js";
/* THE SAME BYTES THE ANALYSTS SENT. The bundle is the cached block of every seat's turn
   (ask({ shared }) — seatTurn() in lib/llm.js), and a cache hit is a byte match, so the
   decision seats import the one definition rather than keep a copy that could drift.
   Compact on purpose: 2-space pretty-printing inflated every downstream prompt ~25% for
   nothing a model needs. The PM and Risk read ~20k tokens per run of it plus the book. */
import { bundle } from "./analysts.js";

const book = (analysts) =>
  "=== ANALYST BOOK ===\n" +
  Object.entries(analysts)
    .map(([k, v]) => `--- ${k.toUpperCase()} (score ${v.score}, confidence ${v.confidence}) ---\n${JSON.stringify(v)}`)
    .join("\n\n");

/** SCOUT — turns a raw firehose into a ranked shortlist with a reason for each. */
/* SCOUT_SYSTEM — hoisted out of the call so the brief is a VALUE the desk can hand to a test.
   test-desk-says-what-and-when.mjs sweeps every prompt this desk ships for a
   cost-conditioned imperative; a brief that is only a literal inside a function call
   cannot be swept, and seven of them were not. */
export const SCOUT_SYSTEM = `You are the SCOUT seat. You do not analyse tokens — you decide what is worth
the desk's expensive attention today, and you say why now.

You are looking at a raw feed of promoted and newly-profiled Solana tokens. Most are junk.
Your bar is not "could this go up" — everything could go up. Your bar is:

  "Is there a specific, time-sensitive reason to look at this TODAY rather than any day?"

Prefer a concrete hook (a listing, a shipped product, an unusual liquidity or volume
change, a named catalyst) over a vague one ("trending", "community is strong").
A token whose only hook is that someone paid to promote it is a WEAK hook, and you should
say so rather than dressing it up. Return at most ${cfg.maxCandidates} picks. Returning
fewer — or none — is a valid and often correct answer.`;

export async function runScout(candidates) {
  return ask({
    seat: "Scout",
    model: cfg.models.scout,
    effort: cfg.effort.scout,
    schema: ScoutOut,
    maxTokens: 4000,
    system: SCOUT_SYSTEM,
    prompt:
      `Here is today's raw feed. Rank what deserves a full workup.\n\n` +
      JSON.stringify(candidates),
  });
}

/* REDTEAM_SYSTEM — hoisted out of the call so the brief is a VALUE the desk can hand to a test.
   test-desk-says-what-and-when.mjs sweeps every prompt this desk ships for a
   cost-conditioned imperative; a brief that is only a literal inside a function call
   cannot be swept, and seven of them were not. */
export const REDTEAM_SYSTEM = `You are the RED TEAM seat. Your job is NOT to be balanced. Your job is to
destroy this trade idea. The desk has a structural bias toward action — you are the
counterweight, and you are graded on the losses you prevent, not on being agreeable.

Attack in this order:
1. The evidence itself. Is a number being read as meaning something it does not mean?
   Is a ratio flattered by an aggregation choice? Is a "real" quote actually a real quote?
2. The analysts' inferences. Where has an analyst moved from a fact to a story?
   Quote the specific claim you are attacking.
3. The story's TRUTH, not its existence. This desk trades memecoins, where attention
   IS the asset — there is no revenue to discount and no moat to erode, and there
   never will be. So "it is only hype" is not an attack, it is a description of the
   asset class. The attack is whether the hype is REAL: is the lore traceable to an
   origin, or one phrasing pasted everywhere? Are the accounts pre-existing people in
   their own words, or fresh eggs and a script? Is an endorsement genuine, or an
   impersonation or a paid post dressed as enthusiasm? Manufactured attention is a
   kill. Real attention is the thesis.
4. The exit. Assume you are wrong and need out during a 40% drawdown with volume gone.
   What actually happens to the price you get?
5. The MONEY behind the move. If buying is what makes it go up, that is how this asset
   class works and saying so is not an insight. The question is WHOSE money: distinct
   wallets arriving, or a handful round-tripping to draw a chart? Is the deployer
   selling into it? That is checkable, and it is the difference between a crowd and a
   machine.

Rules:
- Every attack needs evidence or it is noise. An attack sourced to "inference" is allowed
  but must be labelled as your judgment.
- Every attack must classify its fact_code and retain evidence_path, observed_value,
  threshold_or_comparison, source_url and verification_status. A fatal refutation is
  accepted by code only when verification_status is "verified" and the referenced
  evidence path exists in the bundle. Social-authenticity and identity claims instead
  require a retained HTTPS source_url. Unsupported attacks remain useful as "wounded"
  findings but cannot become a hard refutation.
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

THIS IS A MEMECOIN DESK. Know what that means before you attack.

NONE of these is a refutation. Every one is true of every coin this desk will ever
look at, so writing one is describing the asset class, not finding a flaw:
  · no utility, no product, no revenue, no cash flow, no moat
  · the valuation is not supported by fundamentals — there are none, by construction
  · the team is anonymous
  · it is driven by social media attention and could fade
  · holders are speculators, not users
  · it is extremely volatile and could go to zero
If your headline is one of these, you have not done the job. Write "wounded" and spend
your attack on something specific.

These ARE refutations, because each is a fact somebody could check and find you wrong:
  · the volume is wash traded — name the wallets or the pattern
  · the deployer has rugged before, or is selling into this move
  · a mint or freeze authority is live
  · the "endorsement" is an impersonation, a paid post, or the account never posted it
  · the attention is a bought network — one phrasing across accounts with no shared
    community
  · one wallet holds the float
  · the lore has no traceable origin and reads as a paste job
  · the position cannot be exited at size

WHAT ACTUALLY DRIVES THIS ASSET is lore, trend, timing and real endorsement. When those
are genuine they are the thesis, not a weakness in it — a real person with real reach
posting a coin in their own words is EVIDENCE, and dismissing it requires you to show
it is fake, bought, or impersonated. Say so when you cannot.

And the clock matters. A coin worth looking at appears every half hour or so, so
refusing THIS one loses the desk very little — but a refusal that would apply equally
to the next one loses it everything, because it never trades at all. That is the
asymmetry you are being graded on.

Verdict: "refuted" (this should not be traded), "wounded" (tradeable but smaller and with
a tighter invalidation), or "survives" (your attacks did not land).`;

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
    system: REDTEAM_SYSTEM,
    shared: bundle(ev),
    prompt: `Destroy this trade idea for ${ev.symbol} (${ev.mint}).\n\n${book(analysts)}`,
  });
}

/* RISK_SYSTEM — hoisted out of the call so the brief is a VALUE the desk can hand to a test.
   test-desk-says-what-and-when.mjs sweeps every prompt this desk ships for a
   cost-conditioned imperative; a brief that is only a literal inside a function call
   cannot be swept, and seven of them were not. */
export const RISK_SYSTEM = `You are the RISK seat. You choose the thesis stop and a bounded risk tier.

Desk parameters (the desk's own paper book — NOT the size anyone trades):
- Book equity: $${cfg.equityUsd}
- Maximum risk on a single idea: ${cfg.maxRiskPct}% of equity ($${(cfg.equityUsd * cfg.maxRiskPct / 100).toFixed(2)})

HOW MUCH IS BOUGHT IS NOT YOUR QUESTION AND NOT THIS DESK'S. Every call is executed by
the reader's own bot, from their own wallet, at a size they set on their own machine —
this desk never learns it and never sets it. So do not reason about dollars, fees,
slippage, what a round trip costs, or whether a position is worth the costs. Reason
about the COIN and the LEVEL: is the thesis sound, and where is it wrong?

Your output contains no dollar arithmetic. Deterministic code converts the tier into the
desk's recorded paper size and applies the red-team and confidence multipliers.

Choose exactly one tier:
- minimal — discovery risk; evidence is weak or the red team refuted the case.
- quarter — clean enough to sample, but uncertainty remains material.
- half — strong evidence with one meaningful weakness.
- full — unusually complete evidence and a red-team case that did not land.

The stop must be an observable level that makes the THESIS wrong, not a round number
chosen to manufacture a convenient size. It must be below the current evidence price.

A STOP MUST SURVIVE THIS COIN'S OWN NOISE. On the nano and micro bands a name routinely
moves 20% in a few minutes, so a 5% stop is not tight risk management — it is a coin
flip on noise, and it fires on a chart that has not said anything yet. Choose the level
where the THESIS is wrong. If that level is so close to the current price that ordinary
minute-to-minute movement reaches it, the honest answer is that you have not found the
invalidation yet: say so and take the minimal tier rather than moving the level to fit.

This used to carry a computed dollar floor — a minimum stop distance derived from what a
round trip costs. It was removed on 2026-09-07 because it was derived from a $75 trade
size the desk invented while the bot trades about $2, so the floor it demanded was wrong
by a multiple, and it was withholding sound calls. The bot performs that check itself,
correctly, on the order it is about to sign (executor/poller.mjs:1234-1253). Author the
honest level; the wallet's owner decides whether it is affordable.
Missing or contradictory data lowers the tier and confidence; never fill a gap with a
plausible number.`;

/** RISK — chooses a thesis stop and a bounded tier; code performs every dollar calculation. */
export async function runRisk(ev, analysts, redteam) {
  return ask({
    seat: "Risk",
    model: cfg.models.risk,
    effort: cfg.effort.risk,
    schema: RiskOut,
    system: RISK_SYSTEM,
    shared: bundle(ev),
    prompt: `Choose the stop and risk tier for ${ev.symbol}.\n\n${book(analysts)}\n\n=== RED TEAM ===\n${JSON.stringify(redteam)}`,
  });
}

/** PM — the only seat that decides. Must answer the red team out loud. */
export const PM_SYSTEM = `You are the PORTFOLIO MANAGER. You are the only seat that decides.

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

HOW MUCH IS BOUGHT IS NOT YOUR QUESTION AND NOT THIS DESK'S. Every call is executed by
the reader's own bot, from their own wallet, at a size they set on their own machine —
this desk never learns it and never sets it. So do not reason about dollars, fees,
slippage, what a round trip costs, or whether a position is worth the costs. Reason about
the COIN and the LEVEL: is the thesis sound, and where is it wrong? Risk's tier and the
paper size beside it are the desk's own record, not an order anyone fills.

The weighted analyst composite is provided as an input, not an instruction. You may
override it in either direction, but if you do, say why in 'key_disagreement'.

Two publication rules, absolute:
- No proposal without an explicit INVALIDATION — the observable condition under which
  this thesis is wrong. "It goes down" is not an invalidation; a level or event is.
- Never propose into a spike ON A COIN THAT NEEDS HOURS TO WORK. If the price is
  vertical and the desk intends to hold for hours, the people copying this call are the
  exit liquidity. Wait or pass.
  ON NANO AND MICRO, THE MOVE IS THE ENTRY. Those bands are bought precisely because
  something is happening now and are sold inside thirty to sixty minutes, so "it is
  moving" cannot also be the reason to refuse — that rule would veto every call the
  ignition lane exists to find. What still disqualifies there is a move that is already
  OVER: the tape well off its own high, volume falling away rather than accelerating, or
  a rise on almost no money. Judge the state of the move, not the fact of it.`;

/* The Claude seat receives the bundle as the cached first block of its turn
   (ask({ shared })); Grok has no prefix cache, so its prompt keeps the bundle inline,
   exactly where it has always been. */
const pmPrompt = (ev, analysts, redteam, risk, weightedScore, { inlineBundle = false } = {}) => {
  const floorNo = runContext.getStore()?.floor ?? null;
  const lessonScope = floorNo == null || Number(floorNo) === 50 ? "house" : "tenant";
  const lessons = recentLessons(5, { evidenceScope: lessonScope, floorNo });
  return `Decide on ${ev.symbol} (${ev.mint}).\n\n` +
      `=== LESSONS FROM CLOSED CALLS (Colonel Debrief) ===\n` +
      `${lessons.map((l) => `[${l.grade}] ${l.symbol}: ${l.lesson}`).join("\n") || "(no closed calls yet)"}\n\n` +
      (inlineBundle ? `${bundle(ev)}\n\n` : "") +
      `${book(analysts)}\n\n` +
      `=== RED TEAM ===\n${JSON.stringify(redteam)}\n\n` +
      `=== RISK ===\n${JSON.stringify(risk)}\n\n` +
      `=== WEIGHTED ANALYST COMPOSITE ===\n${weightedScore.toFixed(1)} / 100 ` +
      `(weights: ${JSON.stringify(cfg.weights)})`;
};

/* `stopFloorForCoin()` WAS HERE. It reproduced the executor's pre-signing cost guard so
 * the PM prompt could quote the number compliance would check it against, and both the
 * prompt and the check are gone (owner, 2026-09-07 — the desk says WHAT and WHEN, never
 * how much or what it costs).
 *
 * It was a faithful reimplementation of the right formula fed the wrong size. Its inputs
 * were cfg.executorSlippageBps, cfg.executorMaxFeeShareOfStop and a round trip quoted at
 * whatever notional the desk had probed at — $75 on the day this was written, against a
 * real clip of about $2. Fees are a much larger share of $2 and slippage a much smaller
 * one, so the floor it produced was not conservative, it was simply a different number
 * from the truth, in an unpredictable direction.
 *
 * The guard itself is alive and binding in executor/poller.mjs:1234-1253, computed from
 * `preflight.lossPct` on the exact lamports about to be spent. Nothing needs a copy of
 * it here. */

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
      prompt: pmPrompt(ev, analysts, redteam, risk, weightedScore, { inlineBundle: true }),
      shape: `{"decision":"PROPOSE|WATCH|PASS","conviction":0-100,"thesis":"...","invalidation":"...",` +
        `"time_horizon":"...","how_red_team_was_answered":"...","key_disagreement":"...",` +
        `"watch_triggers":["..."],` +
        `"watch_rules":{"price_above_usd":number|null,"buys_h1_at_least":number|null,"liq_at_least_usd":number|null,"hours":1-72} or null}`,
      validate: PMOut,
    });
    if (g.ok) {
      emit("seat:verdict", { seat: "PM", detail: "thinking on Grok" });
      return { ...g.out, _provider: "grok" };
    }
    emit("seat:failed", { seat: "PM(grok)", error: g.error + " — falling back to the Claude seat" });
  }
  const out = await ask({
    seat: "PM",
    model: cfg.models.pm,
    effort: cfg.effort.pm,
    schema: PMOut,
    system: PM_SYSTEM,
    shared: bundle(ev),
    prompt: pmPrompt(ev, analysts, redteam, risk, weightedScore),
  });
  return { ...out, _provider: opts.pmProvider === "grok" ? "grok->claude" : "claude" };
}

/* THE 5x-COST TARGET FLOOR WAS IN THIS BRIEF and it is deleted (owner, 2026-09-07).
 *
 * It read "THE FIRST TARGET MUST BE AT LEAST 5x THE MEASURED ROUND-TRIP COST", cited
 * compliance rejecting eight tickets on it, and told the seat to do the arithmetic before
 * writing a price. A second line ordered slippage "set against the measured round-trip
 * cost", and a third told the seat not to write a ticket that "cannot clear its own
 * costs". Three cost-conditioned imperatives, all of them shaping the PUBLISHED target
 * price, all of them anchored to a round trip quoted at a notional the desk invented —
 * roughly forty times the clip the bot trades — so the floor they produced demanded a
 * target several times too far away and the desk passed on coins that were fine.
 *
 * IT IS DELETED FROM THE PROMPT RATHER THAN SOFTENED IN IT, and the history stays in this
 * comment rather than moving into the brief. A model reads its brief and complies: a
 * paragraph explaining that the desk used to require 5x the round trip is a paragraph
 * that can be followed. The rule that replaces it was already sitting beside it — size
 * the target to the THESIS — and that is what the seat is told now, with nothing else.
 *
 * The judgment itself survives where the numbers are real: executor/strategy.mjs:161-164
 * computes R_net = (targetFrac - cost) / (stopFrac + cost) on the round trip measured
 * against the bot's own lamports and skips the trade with "costs eat the target", and
 * strategy.mjs:174-180 refuses on the break-even hit rate the bracket implies.
 *
 * EXECUTION_SYSTEM — hoisted out of the call so the brief is a VALUE the desk can hand to a test.
   test-desk-says-what-and-when.mjs sweeps every prompt this desk ships for a
   cost-conditioned imperative; a brief that is only a literal inside a function call
   cannot be swept, and seven of them were not. */
export const EXECUTION_SYSTEM = `You are the EXECUTION seat. You turn an approved thesis into a ticket a human
can read and place by hand. You never place it yourself and you never hold a key.

Build the ticket from the routing evidence, not from imagination:
- The entry zone must bracket the actual current price from the evidence. An entry zone
  that does not contain a reachable price is a broken ticket.
- max_slippage_bps is a RECORD of what this book's own volatility suggests, not a limit
  anyone trades on: the bot sets its own tolerance from a live quote at its own size,
  immediately before it signs. Write the number the tape implies and move on.
- Prefer scale-in for anything illiquid or extended. Getting the whole position on in one
  print is how a thin book gets paid at your expense.
- Name the venue/aggregator from evidence.exitProbe route data.
- Take-profit levels must sum to at most 100% of the position, and each needs a rationale
  tied to the thesis — not a round number.
- SIZE THE FIRST TARGET TO THE THESIS. This desk trades micro-cap memecoins on a claim
  that the coin RE-RATES; on a coin under a few million, the move being argued for is a
  multiple, not a few percent. If the honest target is only a little above spot then the
  thesis is not a re-rate, and the right answer is to say so in execution_warnings rather
  than write a ticket around a move nobody actually argued for.
  Your target answers to the THESIS. Whether the move is worth having once the wallet has
  paid to get in and out is arithmetic the bot does, on its own numbers, before it signs.
- execution_warnings is where you put anything that would surprise a human placing this
  manually: transfer fees, hooks, low hop-count fragility, time-of-day liquidity.

The stop price must match the risk seat's stop exactly. You do not get to move it.`;

/** EXECUTION — turns a decision into an unsigned ticket a human can act on.
 *  On Haiku 4.5 since 2026-09-08: compliance.js `stop_mismatch` forces the ticket's stop
 *  equal to the Risk seat's, so what this seat authors is the entry zone and the targets.
 *  Live 24h it was 11 Sonnet calls, $0.48 (7d $6.26), for two numbers and a route name. */
export async function runExecution(ev, pm, risk) {
  return ask({
    seat: "Execution",
    model: cfg.models.execution,
    effort: cfg.effort.execution,
    schema: TicketOut,
    system: EXECUTION_SYSTEM,
    prompt:
      `Write the unsigned ticket for ${ev.symbol}.\n\n` +
      `Current price (evidence.pair.priceUsd): ${ev.pair?.priceUsd}\n` +
      `Exit probe: ${JSON.stringify(ev.exitProbe)}\n\n` +
      `=== PM DECISION ===\n${JSON.stringify(pm)}\n\n=== RISK ===\n${JSON.stringify(risk)}`,
  });
}

/**
 * THE BEST PICK — the seat that finally chooses.
 *
 * Until now the cycle's winner was arithmetic: tier x 100000 + conviction x 100 +
 * composite. That is defensible and it is also blind. It cannot see that one coin's
 * story is a trend three hours old while another's is a week stale, or that a real
 * account with reach posted one of them and a bought network posted the other. Those
 * are the things that decide a memecoin, and a weighted average of five scores cannot
 * represent them.
 *
 * What makes this seat safe to trust with a forced decision is WHERE it sits. Every
 * candidate in front of it has already cleared the free safety screen, all five
 * analysts, the red team and compliance. It cannot admit a honeypot, an unexitable
 * position or a launch farm, because none of those reach it. So it is not asked "is
 * this safe" — that is settled. It is asked the only question left: of these, which
 * one makes money.
 *
 * That is why "every cycle produces a trade" is a reasonable instruction here and
 * would have been a reckless one three stages earlier.
 */
/* BESTPICK_SYSTEM — hoisted out of the call so the brief is a VALUE the desk can hand to a test.
   test-desk-says-what-and-when.mjs sweeps every prompt this desk ships for a
   cost-conditioned imperative; a brief that is only a literal inside a function call
   cannot be swept, and seven of them were not. */
export const BESTPICK_SYSTEM = `You are the seat that CHOOSES. One coin, from a field that has already been
vetted, and the desk trades whatever you name.

WHAT IS ALREADY SETTLED, so do not spend your answer on it:
every candidate here has cleared the deterministic safety screen (no live mint or
freeze authority, no permanent delegate, no transfer hook, an exit that measurably
closes, no launch-farm deployer, holder concentration under the ceiling), all five
analysts, the red team, and compliance. None of them is a honeypot and all of them can
be sold. Telling the desk a memecoin is risky is not information.

THE ONLY QUESTION IS WHICH ONE MOVES.

This is a memecoin desk, so rank on what actually moves these:
- IS THE STORY TRUE AND IS IT NOW? A traceable lore riding a live trend beats a better
  story that peaked yesterday. Late to a real thing still loses money.
- WHOSE ATTENTION IS IT? Distinct pre-existing accounts in their own words beat a
  bigger number carried by one pasted script. A genuine endorsement from a real person
  with reach is the strongest single signal on this desk.
- IS THE DEV PRESENT? Someone who posted the contract themselves and is still replying
  is running a coin. Someone who posted once and vanished has already left.
- DID THE CREATOR STAY IN? dev.pctOfSupply is the creator wallet's own share of supply
  read from the chain and dev.soldAll whether their account was emptied; launch.volShare
  is the first traded minute's volume against the curve's opening SOL, and above one
  reads as a sniped or bundled open. Every pump.fun call carries "thesis void if the
  deployer wallet sells", so a creator who already sold is that invalidation already
  true. Null is unmeasured, not clean.
- WHERE ON THE CURVE, AND HOW FAST. curve.progressSol is the share of the bonding
  curve's graduation total already filled, read off the curve's own reserves, and
  curve.velocitySolPerMin is SOL entering the curve per minute from the desk's last
  two readings — minutesToGraduate is what is still owed divided by that. athRatio is
  the cap against the coin's own high and athAgeMin how long ago that high was set: a
  coin well under a high set twenty minutes ago is a late look, whatever its story.
  Null is unmeasured, not clean.
- WHO IS BUYING? Distinct wallets arriving beats a few round-tripping.
- ROOM TO RE-RATE. A $200k coin doubling needs a fraction of what a $15m coin needs.
  Prefer the smaller cap when the story is equally real.

COMPARE, DO NOT DESCRIBE. Your "why" must say why THIS one and not the one next to it.
"Strong narrative and good liquidity" describes half the field and chooses nothing.

Name a runner-up honestly, and if the field is genuinely one-deep say so with null.
expected_move is your read, not your hope — most memecoins do not 2x, and saying
"modest" when it is modest is what makes the number worth anything.

You must pick one. Refusing is not available to this seat: the safety questions were
answered upstairs, and a desk that never chooses never learns whether it can.`;

export async function runBestPick(candidates, { filter = null } = {}) {
  const brief = candidates.map((c) => {
    const ev = c.rec?.ev ?? {};
    const x = ev.xRead ?? {};
    return {
      mint: c.rec?.mint,
      symbol: c.rec?.symbol ?? ev.symbol,
      band: c.band ?? null,
      type: c.coinType ?? c.category ?? null,
      marketCapUsd: ev.pair?.marketCap ?? ev.pair?.fdv ?? null,
      liquidityUsd: ev.pairs?.totalLiquidityUsd ?? null,
      ageHours: ev.pair?.ageHours ?? null,
      priceChange: ev.pair?.priceChange ?? {},
      roundTripCostPct: ev.exitProbe?.roundTripLossPct ?? null,
      pmDecision: c.rec?.pm?.decision, conviction: c.rec?.pm?.conviction,
      thesis: c.rec?.pm?.thesis, invalidation: c.rec?.pm?.invalidation,
      redTeam: c.rec?.redteam?.verdict, redTeamHeadline: c.rec?.redteam?.headline,
      compositeScore: c.rec?.weighted,
      // The X read, which is the heaviest evidence on this desk.
      attention: { level: x.mentions_level, velocity: x.velocity, verdict: x.verdict,
        distinctVoices: x.distinct_voices, loreOrigin: x.lore_origin,
        paidSigns: x.paid_or_botted_signs, summary: x.summary },
      dev: { handle: x.dev_handle, looksReal: x.dev_looks_real, postedCA: x.dev_posted_ca,
        engagingNow: x.dev_engaging_now, priorTokens: x.dev_prior_tokens,
        redFlags: x.dev_red_flags, deskRecord: x.desk_record,
        // Read from the chain, not from X (data/solana.js) — null is unmeasured.
        pctOfSupply: ev.holders?.devPctOfSupply ?? null,
        accountPresent: ev.holders?.devAccountPresent ?? null,
        soldAll: ev.holders?.devSoldAll ?? null },
      // The launch minute against the curve's opening SOL (data/pumpfun-live.js).
      launch: { volShare: ev.momentum?.launchVolShare ?? null,
        firstCandleVolUsd: ev.momentum?.firstCandle?.volUsd ?? null,
        msAfterCreate: ev.momentum?.firstCandle?.msAfterCreate ?? null },
      holders: { top1Pct: ev.holders?.top1Pct, bundleSuspect: ev.holders?.bundleSuspect,
        clustered: ev.holders?.clusteredHolders, midToHead: ev.holders?.midToHead },
      /* THE CURVE AND THE HIGH, off the listing row the sweep shaped (data/pumpfun-live.js
         curveOf, carried on the pick as `live`) and the funnel's last two curve readings
         (funnel.js curveVelocity, on the pick as `curveVelocity`). The evidence bundle
         has neither: gather() reads the deployer row and the birth tape, not the curve's
         progress or the ATH. A keyword-sweep pick carries no `live` and reads null
         throughout — unmeasured, never clean. */
      curve: { onCurve: c.onCurve ?? null,
        progressSol: c.live?.progressSol ?? null, solToGraduate: c.live?.solToGraduate ?? null,
        gradSolTotal: c.live?.gradSolTotal ?? null, curveClass: c.live?.curveClass ?? null,
        velocitySolPerMin: c.curveVelocity ?? null,
        minutesToGraduate: c.curveVelocity > 0 && c.live?.solToGraduate > 0
          ? Number((c.live.solToGraduate / c.curveVelocity).toFixed(1)) : null },
      athRatio: c.live?.athRatio ?? null,
      athAgeMin: c.live?.athAt != null ? Math.round((Date.now() - c.live.athAt) / 60_000) : null,
    };
  });

  return ask({
    seat: "Best Pick",
    model: cfg.models.pm,
    effort: cfg.effort.pm,
    schema: BestPickOut,
    system: BESTPICK_SYSTEM,
    prompt:
      (filter ? `THE FLOOR'S FILTER: ${filter}. Prefer candidates matching it, but if none do, pick the best available and say so.\n\n` : "") +
      `CANDIDATES (${brief.length}), all pre-vetted:\n\n${JSON.stringify(brief, null, 2)}\n\n` +
      `Choose the one most likely to make money. Compare them against each other.`,
  });
}
