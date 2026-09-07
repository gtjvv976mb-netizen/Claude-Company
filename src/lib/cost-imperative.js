/**
 * THE COST-CONDITIONED IMPERATIVE DETECTOR — ONE COPY, TWO CALLERS.
 *
 * THE DESK SAYS ONLY WHAT AND WHEN (commit 9eee450, the owner's rule). The proof of it
 * lived entirely inside test-desk-says-what-and-when.mjs: a detector defined in the test
 * file and swept across the fifteen prompt strings the desk ships. That was enough while
 * the only way a prompt could change was a human editing a source file.
 *
 * It stopped being enough the day CODEX BANKS started REWRITING the seats' standing
 * orders at run time. A coach-appended paragraph is a prompt the desk ships, arriving
 * hours after the test last ran, and no test can sweep a string that does not exist yet.
 * A RULE THAT LIVES IN A TEST PROTECTS NOTHING AT RUN TIME.
 *
 * So the detector moved here, unchanged in behaviour, and is now imported by both:
 *   - test-desk-says-what-and-when.mjs sweeps the shipped briefs with it, as before;
 *   - desk-policy.js runs every candidate technique through it before it can be stored.
 * One copy means the two can never drift apart, which is the whole reason the regexes
 * are not duplicated into the fence.
 *
 * Nothing here imports anything. It is regex and string work only, so the test can hold
 * it without a database and the policy fence can hold it without a cycle.
 */

/* THE DETECTOR. A cost-conditioned imperative is a veto/target instruction sitting in
   the same breath as money: "KILL … at an acceptable cost", "the target MUST BE 5x the
   ROUND TRIP", "slippage MUST be set against the measured cost". Two halves, one
   window, and the window is a sentence or a bullet — a KILL three paragraphs from the
   word "fee" is not an instruction about fees.

   The NEGATION arm is what lets the desk still say the rule out loud. "You never kill
   on cost" and "KILL only when there is no market — never on what leaving costs" are
   the correction itself; a detector that flagged them would force the prompts to go
   silent about the very thing they must be explicit about. So a window is exonerated
   when a negation governs the money term inside it. */
/* Case-INSENSITIVE, and that is not a detail: the execution seat shouted its rule in
   capitals ("THE FIRST TARGET MUST BE AT LEAST 5x THE MEASURED ROUND-TRIP COST"), so a
   lower-case `must` in this pattern matched nothing and the loudest instruction on the
   desk swept clean. Verified in the test by driving the detector with that exact line. */
export const IMPERATIVE = /\b(kill|kills|killing|reject|rejects|rejected|refuse|refuses|refused|refusing|refusal|decline|declines|declined|disqualif\w*|veto|vetoes|vetoed|must)\b/i;
export const MONEY = /(round[\s-]?trips?|\bcosts?\b|\bcostly\b|\bfees?\b|slippage|\$\s?\d)/i;
export const NEGATION = /\b(never|not|nor|regardless|ignore|none)\b/i;

/** Sentences and bullets. A prompt is prose, so the unit of instruction is a sentence;
    list items are their own unit even when they do not end in a full stop. */
export const windows = (text) => String(text ?? "")
  .split(/(?<=[.!?])\s+|\n(?=\s*(?:[-·*]|\d+\.))|\n{2,}/)
  .map((w) => w.trim()).filter(Boolean);

/** One window, judged. Exported so a caller can judge a window it has already isolated. */
export function isCostImperative(window) {
  const w = String(window ?? "");
  if (!IMPERATIVE.test(w) || !MONEY.test(w)) return false;
  // Exonerate when a negation governs the money term: everything before the FIRST
  // money mention in this window is scanned for it, which is where "never on what
  // leaving costs" and "do not reason about fees" live.
  const before = w.slice(0, w.search(MONEY));
  return !NEGATION.test(before);
}

/** The offending windows in one prompt, or [] when it is clean. */
export const costImperatives = (text) => windows(text).filter((w) => isCostImperative(w));

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE DESK'S OWN VOCABULARY.
 *
 * The detector above is aimed at prompts a human wrote. The coach writes about his
 * SCORECARD, and three things he says there look like money to a regex and are not:
 *
 *   1. THE GRADING ENUMS. `costly_kill` and `good_kill` are column values in
 *      seat_grades. "Six costly kills" is the coach quoting his own evidence, not an
 *      instruction about what trading costs — and quoting the number that motivates a
 *      change is something his brief explicitly requires of him.
 *   2. A DOLLAR FIGURE ATTACHED TO A MARKET FACT. Pool liquidity, market cap, 24h
 *      volume and depth are facts ABOUT THE COIN. "$20k of liquidity" is the desk's
 *      business; "$2 of fees" is the bot's. Only the second is money in this sense.
 *   3. THE SIZE OF SOMETHING THAT IS NOT OURS. Sample size, pool size, the size of a
 *      holder's stake, the size of the move a thesis argues for — all research nouns.
 *      The size of what WE buy is the only size the desk may not hold.
 *
 * Neutralising these before the fence runs is what keeps the fence from being dead
 * weight. It is deliberately narrow: nothing here exonerates a fee, a cost or a
 * slippage that is not already anchored to a market fact, and the shipped-prompt sweep
 * does not use it at all — the fifteen briefs are judged exactly as they were before.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
const NEUTRALISE = [
  // The verdict enums, in the two forms a model writes them.
  [/\b(costly|good)[_ ]kills?\b/gi, "GRADEVERDICT"],
  [/\bkills?\b([^.;:]{0,30})\b(?:were|are|was|is|have been|had been)\s+costly\b/gi, "GRADEVERDICT"],
  // A dollar figure that describes the market, in either order.
  [/\b(?:liquidity|liq|market ?cap|mcap|fdv|volume|depth|tvl|pool|float)\b[^.;:]{0,28}?\$\s?[\d.,]+\s*[kmbKMB]?/gi, "MARKETFACT"],
  [/\$\s?[\d.,]+\s*[kmbKMB]?[^.;:]{0,28}?\b(?:liquidity|market ?cap|mcap|fdv|volume|depth|tvl|pool|float)\b/gi, "MARKETFACT"],
  // A size that belongs to the market, the sample, or the move — never to us.
  [/\b(?:pool|liquidity|market|sample|supply|holder|holding|wallet|cluster|candle|move|cohort|window|float|trade count)\s+siz(?:e|es)\b/gi, "MARKETFACT"],
  [/\bsiz(?:e|es)\s+of\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+|its\s+|any\s+)?(?:[a-z'’]+\s+){0,2}?(?:pool|liquidity|market|sample|supply|float|holding|holdings|holder|wallet|cluster|move|candle|cohort|window|deployer|stake|position)\b(?!\s+(?:we|you|the desk|the bot))/gi, "MARKETFACT"],
  // "SIZE THE FIRST TARGET TO THE THESIS" is the execution brief's own wording, and the
  // thing being sized there is the MOVE the thesis argues for, not the position.
  [/\bsiz(?:e|es|ing)\s+(?:the\s+)?(?:first\s+)?targets?\b/gi, "MARKETFACT"],
  // "the execution seat" is the name of a seat on this desk; the coach may address it.
  [/\bexecution seat\b/gi, "SEATNAME"],
  // A transfer/creator fee is a property of the MINT — a screen fact the forensics seat
  // is supposed to weigh, not a cost of trading.
  [/\b(?:transfer|creator|royalty|mint|burn|tax)\s+fees?\b/gi, "MINTFLAG"],
];

/** One window with the desk's own vocabulary removed, for the policy fence only. */
export function deskVocabulary(window) {
  let w = String(window ?? "");
  for (const [re, token] of NEUTRALISE) w = w.replace(re, token);
  return w;
}

/** The sweep as the COACH is judged by it: same detector, desk vocabulary neutralised.
 *  Returns the ORIGINAL windows, so an operator reads what the coach actually wrote. */
export const coachCostImperatives = (text) =>
  windows(text).filter((w) => isCostImperative(deskVocabulary(w)));
