/**
 * THE DESK'S TECHNIQUE, AS DATA.
 *
 * Every seat's instructions used to be a constant in a source file, which meant the
 * desk could measure itself precisely and change nothing about itself without a human
 * writing a patch. The evidence existed — decision_runs, forward_marks, scorecards —
 * and nothing read it back into the way the seats actually work.
 *
 * This is that missing half. A seat's standing guidance lives here, in the database,
 * and is appended to its system prompt on the next workup. Codex writes it. No deploy,
 * no merge, no permission (the owner's explicit instruction, 2026-09-03): the coach is
 * allowed to change the technique of the team he is coaching.
 *
 * AUTONOMY IS NOT ABSENCE OF LIMITS. Three things keep an autonomous coach honest, and
 * none of them is an approval queue:
 *
 *   1. INVARIANTS he cannot cross at all. They are about custody, money and the
 *      deterministic safety gates — never about opinion. A coach may rewrite how the
 *      Forensics seat reasons; he may not raise a size cap or retire the Red Team.
 *      TWO GATES ENFORCE THEM, and the split is deliberate: a regex DENYLIST catches the
 *      obvious deterministically and auditably, and a SEMANTIC JUDGE (lib/policy-judge.js)
 *      reads what the denylist cannot — because a denylist of nouns and verbs cannot
 *      judge English, and saying otherwise would be the worse failure. Both are below.
 *   2. VERSIONING. Every change records the evidence that motivated it, so a change is
 *      always answerable to the numbers that produced it.
 *   3. AUTO-ROLLBACK. A version whose cohort underperforms its predecessor on settled
 *      evidence reverts itself. The desk cannot drift somewhere bad and stay there
 *      because nobody happened to look.
 *
 * Guidance is TEXT THE MODEL READS, so it is written from structured outcomes only —
 * scores, verdicts, marks, timings. Market and social prose never reaches this file.
 * A coin whose bio contained "ignore your risk seat" would otherwise be one hop from
 * the prompt of the seat that reads it.
 */
import db, { ensureColumn } from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { sha256, canonicalJson } from "./canonical.js";
/* The desk's own cost-imperative detector, shared with the prompt sweep in
   test-desk-says-what-and-when.mjs. Imported, never re-written: two copies of a rule
   are two rules, and the one nobody is looking at is the one that rots. */
import { windows, deskVocabulary, coachCostImperatives } from "./lib/cost-imperative.js";
/* The judge SEAT NAME only. lib/policy-judge.js itself is imported lazily inside
   applyPolicy: it reaches lib/llm.js, which imports withPolicy from this file, so a
   static import here would be a cycle for the sake of one string. */
export const JUDGE_SEAT = "LaneJudge";

db.exec(`
CREATE TABLE IF NOT EXISTS desk_policy (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  seat         TEXT NOT NULL,
  guidance     TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  author       TEXT NOT NULL DEFAULT 'codex',
  version      TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  retired_at   INTEGER,
  retired_why  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_policy_seat ON desk_policy(seat, active, id DESC);

CREATE TABLE IF NOT EXISTS policy_versions (
  version      TEXT PRIMARY KEY,
  parent       TEXT,
  created_at   INTEGER NOT NULL,
  note         TEXT,
  reverted_at  INTEGER,
  reverted_why TEXT
);
`);
ensureColumn("desk_policy", "retired_why", "TEXT");

/* WHAT A COACH MAY NEVER DO.
 *
 * Every one of these is either somebody's money or a deterministic safety gate.
 * They are matched against the guidance text itself, so a change that argues for
 * crossing one is refused before it can be read by a seat. This is deliberately
 * blunt: a coach with a good argument for raising a size cap should still lose,
 * because the argument is exactly what an injected string would supply.
 *
 * THE COACH'S LANE (the owner, 2026-09-07, verbatim): "Codex may only manage the
 * BEHAVIOUR of the agents — making the trading team more effective at PUBLISHING CALLS.
 * It must never change anything about the size of trades, or anything about what the bot
 * does. Only the trading team."
 *
 * The first five invariants were written before the coach existed as a way of REWRITING
 * PROMPTS, and they miss that rule entirely. Commit 9eee450 took every money judgment out
 * of the desk's code and out of its fifteen shipped briefs; a coach who could append "when
 * the round trip is above 5%, refuse" to a seat's standing orders would put it straight
 * back, by prompt, hours after the test that proved it gone last ran. SIZE, MONEY and BOT
 * close that hole, and the cost-imperative sweep below closes the rest of it.
 *
 * THEY ARE WRITTEN FOR PHRASINGS, NOT FOR NOUNS. A model told not to say "position size"
 * says "commit more of the book", "go bigger on conviction", "a lighter touch on thin
 * pools". So each of these is a small family of patterns rather than a word list, and
 * each is matched against a SENTENCE with the desk's own vocabulary neutralised first
 * (see lib/cost-imperative.js) — otherwise "six costly kills" and "$40k of liquidity",
 * which are the coach quoting his evidence, would read as money and the lane would be
 * dead weight. A fence that refuses ordinary coaching fails exactly as badly as one that
 * lets a size instruction through.
 *
 * AND THEY ARE STILL NOT ENOUGH, WHICH IS STATED HERE RATHER THAN DISCOVERED LATER.
 * An adversarial pass on 2026-09-07 ran 38 realistic coach outputs through the real
 * applyPolicy() and 32 INSTALLED. Two measured pairs, each pair meaning one thing:
 *
 *   "Prefer larger positions on high conviction."        refused
 *   "Be bolder when conviction is high and hold back
 *    when it is not."                                    INSTALLED
 *   "When the round trip is above 5%, refuse."           refused
 *   "When the there-and-back toll is above 5%, refuse."  INSTALLED
 *
 * These patterns are therefore a CHEAP FIRST PASS over the obvious, deterministic and
 * readable in a diff, and nothing more than that. The judgement of natural language
 * belongs to the SEMANTIC JUDGE that runs after them in applyPolicy, which fails closed.
 * Neither gate can overturn the other: the patterns run first and return on a hit, so a
 * candidate refused here stays refused whatever the judge would have said.
 */
export const POLICY_INVARIANTS = [
  { id: "custody", test: /\b(private key|seed phrase|keypair|signer|sign the transaction|custody)\b/i,
    why: "the desk never holds a key; nothing in a seat's technique may reference custody" },
  { id: "caps", test: /\b(raise|increase|lift|remove|ignore|bypass)\b[^.]{0,40}\b(cap|limit|ceiling|max ?sol|daily loss)\b/i,
    why: "position, daily and loss caps belong to the operator, not to the coach" },
  { id: "screen", test: /\b(skip|ignore|bypass|disable|relax)\b[^.]{0,40}\b(screen|mint authority|freeze authority|honeypot|rug check)\b/i,
    why: "the free screen's kill gates are facts, not opinions" },
  { id: "redteam", test: /\b(ignore|overrule|disable|retire|skip)\b[^.]{0,30}\b(red ?team|refutation|compliance)\b/i,
    why: "the adversary and the compliance check are structural, not tunable" },
  { id: "gate", test: /\b(lower|reduce|ignore|waive)\b[^.]{0,30}\b(sample gate|minimum sample|evidence bar|significance)\b/i,
    why: "a coach may not lower the bar that judges the coach" },

  /* HOW MUCH IS BOUGHT IS NOT THE DESK'S QUESTION — the sentence the Risk, PM, CEO and
     Liquidity seats all carry since 9eee450. A standing order is a prompt like any
     other, so the same sentence has to be true of anything the coach appends to one. */
  { id: "size", perSentence: true, test: [
      // a quantity verb reaching something we would buy, in the same breath
      /\b(siz\w+|scal\w+|add|adds|adding|increase\w*|reduce\w*|cut|cuts|trim\w*|double|doubles|halve|halves|commit|commits|committing|allocat\w+|deploy|deploys|stake|stakes|risk|risks|risking|spend\w*|put|puts|putting)\b[^.;:]{0,45}\b(positions?|siz(?:e|es|ing)|notional|clips?|amounts?|bankroll|stakes?|allocations?|exposure|capital|book|bags?|dollars?|funds?|sol|units?)\b/i,
      // the comparative that never says the verb: "prefer larger positions on conviction"
      /\b(bigger|larger|smaller|heavier|lighter|full|half|quarter|double|maximum|max|minimum|min|more|less|extra)\b[^.;:]{0,25}\b(positions?|siz(?:e|es|ing)|clips?|notional|allocations?|exposure|stakes?|bags?|orders?|bets?|bites?|nibbles?|chunks?|tranches?|slugs?|helpings?|portions?)\b/i,
      // and the phrasings that never say the noun at all
      /\bhow much (?:is |to |you |we |the desk |the bot |it )?(?:buy|bought|buys|buying|commit|committed|risk|risked|spend|spent|trade|traded|allocate|put|deploy)\b/i,
      /\bhow much of (?:the |our |your )?(?:book|bankroll|balance|portfolio|capital|money|budget)\b/i,
      /\b(go|goes|going|lean|leans|leaning|press|presses|pressing|push|pushes|pushing|come|comes|coming)\b[^.;:]{0,20}\b(bigger|larger|smaller)\b/i,
      /\b(heavier|lighter)\b[^.;:]{0,25}\b(touch|hand|on the way in|into the entry|on entry)\b/i,
      /\bscal\w+\s+(?:in|out|into|out of)\b/i,
      /\b\d{1,3}\s?%\s+of\s+(?:the\s+|our\s+|your\s+)?(?:book|bankroll|balance|portfolio|capital|position|bag|account)\b/i,
      /\b(?:the|our|your|its|a|each|any|this|no|full|correct|right|proper|whole)\s+siz(?:e|es|ing)\b/i,
      /\bsiz(?:e|es|ing)\s+(?:up|down|the|our|your|a|each|every)\b/i,
      /\bper[- ](?:trade|call|position|name)\s+(?:size|amount|notional|budget|allocation)\b/i,
      // "more of what the desk has", "a bigger share of the book" — the quantity with
      // the noun deleted, which is how a model writes it once it has been told not to.
      /\b(?:more|less|most|all|half|twice)\s+of\s+(?:what\s+)?(?:the\s+|our\s+|your\s+)?(?:book|bankroll|balance|portfolio|capital|treasury|account|money|desk|firm|house)\b/i,
      /\bshare\s+of\s+(?:the\s+|our\s+|your\s+)?(?:book|bankroll|balance|portfolio|capital|treasury|account)\b/i,
      /\bweight\b[^.;:]{0,14}\b(?:in dollars|in sol|in usd|of the book|of capital)\b/i,
      /\b(?:heavier|lighter|bigger|smaller|larger)\s+(?:commitment|conviction bet|involvement)\b/i,
      /\b(?:starter|opening|initial|first|follow[- ]?up|second)\s+(?:position|clip|tranche|slug)\b/i,
      /\b(?:enter|entering|enters|buy|buying|build|building|get in|accumulate)\b[^.;:]{0,25}\b(?:in (?:thirds|halves|two|three|four|several|multiple|stages|tranches|legs|goes|parts|batches|clips)|all at once|in one (?:go|print|shot|clip|order))\b/i,
      /\bin one (?:go|print|shot|clip)\b|\bin (?:thirds|halves|tranches|stages|legs|clips)\b/i,
      /\bhow (?:much|many)\s+(?:sol|usd|dollars?|money|capital|units)\b/i,
    ],
    why: "how much is bought is not the desk's question and not this coach's — the bot sizes every trade at its own numbers" },

  /* THE DESK SAYS WHAT AND WHEN. It does not know what a round trip costs, what a fee
     is, or what is left in the wallet — the bot measures all three at its own real size
     against a live quote, immediately before it signs. A standing order conditioned on
     any of them re-creates the $75-notional ceiling that killed twelve good coins. */
  { id: "money", perSentence: true, test: [
      /\bround[\s-]?trips?\b/i,
      /\bslippage\b/i,
      /\b(price|market) impact\b/i,
      /\b(gas|network fee|priority fee|swap fee|trading fees?|exchange fee|taker fee|maker fee)\b/i,
      /\bfees?\b/i,
      /\bcosts?\b|\bcostly\b|\bfriction\b/i,
      /\b(expensive|cheap\w*)\b[^.;:]{0,25}\b(to (?:enter|exit|trade|get in|get out|leave)|entry|exit|round trip)\b/i,
      /\bcross(?:ing)? the spread\b|\bbid[- ]?ask\b|\b(?:tight|wide)(?:er)?\s+spreads?\b|\bspreads?\s+(?:is|are|of|above|below|over|under|wider|tighter)\b/i,
      /\bpay\w*\s+(?:to\s+)?(?:enter|exit|get in|get out|leave|trade|play)\b/i,
      /\b(?:our|your|the desk'?s|the bot'?s|the account'?s|the wallet'?s|remaining|available|current|left in the)\s+(balance|funds|cash|capital|sol)\b/i,
      /\b(dry powder|buying power|funds available|capital available|how much sol|out of (?:sol|funds|money|cash))\b/i,
      /\b(?:enough|insufficient|short of|run out of)\s+(?:sol|funds|cash|money|capital|balance|powder)\b/i,
      /\b(?:sol|funds|cash|money|capital)\b[^.;:]{0,15}\bleft\b|\bleft\s+in\s+the\s+(?:wallet|account|book|treasury)\b/i,
      /\beats?\b[^.;:]{0,25}\bedge\b/i,
      /\b(?:two[- ]way|there[- ]and[- ]back)\s+trip\b|\bgetting\s+in\s+and\s+out\b|\bin\s+and\s+out\s+of\s+the\s+(?:position|trade|name)\b/i,
      /\bcross(?:ing)?\s+the\s+(?:spread|book)\b|\bgives?\s+up\b[^.;:]{0,20}\b(?:spread|book|edge|crossing)\b/i,
      /\b(?:the\s+)?(?:treasury|book|bankroll|balance|account|purse|war chest|wallet)\s+(?:is|are|gets?|runs?|looks?|feels?)\s+(?:thin|low|empty|small|light|drained|short|tight)\b/i,
    ],
    why: "fees, costs, the round trip, slippage, the spread and the balance are the bot's arithmetic; a seat conditioned on them is guessing at numbers it cannot see" },

  /* THE COACH COACHES THE SEATS, NOT THE PROGRAM THAT HOLDS THE MONEY. Everything below
     happens after a ticket is published, in a process with its own tests, its own caps
     and its own key. The desk's lane ends at the call. Note what is deliberately NOT
     here: a stop, a target, a hold band or a catalyst window is the desk's "WHEN", and
     the coach may sharpen how a seat judges those all day. */
  { id: "bot", perSentence: true, test: [
      /\b(the bot|the executor|the trading bot|wall[- ]?st[- ]?e|the (?:program|machine|system|software|agent) that (?:holds|trades|buys|sells|executes|signs|places))\b/i,
      /\bplaces? the (?:trade|order|buy|entry)\b/i,
      /\b(execut(?:e|es|ed|ing|ion)|signing|broadcast\w*|unwind\w*)\b/i,
      /\bsign(?:s|ing)?\s+(?:the\s+)?(?:transaction|tx|trade|order|swap)\b/i,
      /\b(rout(?:e|es|ed|ing)|jupiter|aggregator|order (?:placement|type|book|flow)|limit order|market order|stop order|trailing stop|slippage tolerance|priority fee|compute unit|rpc|fill price|our fill)\b/i,
      /\b(?:our|your|the desk'?s|the bot'?s|the trading|the hot)\s+wallet\b/i,
      /\b(exit|exits|exiting|sell|sells|selling|close|closes|closing|dump|dumps)\b[^.;:]{0,20}\b(?:the|our|your|a|half|part|some of)\s+(?:position|trade|bag|call|coin|holding)\b/i,
      /\b(tell|instruct|have|make|let)\b[^.;:]{0,20}\b(?:the bot|the executor|it)\b[^.;:]{0,20}\b(?:buy|sell|exit|enter|hold|wait|size|trade)\b/i,
    ],
    why: "the executor, the wallet, routing, order placement and how a position is unwound belong to the bot; the coach coaches the research seats" },
];

/* THE SHIPPED PROMPTS' OWN SWEEP, RUN AT RUN TIME.
 *
 * test-desk-says-what-and-when.mjs sweeps the fifteen briefs the desk ships for a
 * cost-conditioned imperative — a veto or a target sitting in the same sentence as
 * money. Coach-appended standing orders ARE briefs the desk ships; they simply arrive
 * after the test has run. Same detector, imported rather than copied, so the fence and
 * the proof can never disagree about what the rule is.
 */
const SWEEP = {
  id: "cost-imperative",
  why: "a veto or a target in the same breath as money — the instruction 9eee450 removed from every brief the desk ships",
};

/**
 * Null when the guidance is safe to install; otherwise the invariant it broke, with the
 * SENTENCE that broke it. The sentence is the point: an operator reading a refusal has
 * to see what the coach actually tried to write, or the refusal teaches nobody.
 */
export function checkInvariants(guidance) {
  const text = String(guidance || "");
  const sentences = windows(text);
  const found = (inv, sentence, matched) =>
    ({ ...inv, sentence: String(sentence).replace(/\s+/g, " ").slice(0, 200), matched: String(matched) });
  for (const inv of POLICY_INVARIANTS) {
    const patterns = Array.isArray(inv.test) ? inv.test : [inv.test];
    for (const re of patterns) {
      /* The first five judge the whole text, exactly as they always have. The three
         written for the coach's lane judge a SENTENCE at a time, over the desk's own
         vocabulary neutralised — precision in both directions. */
      if (inv.perSentence) {
        const hit = sentences.find((s) => re.test(deskVocabulary(s)));
        if (hit) return found(inv, hit, re);
      } else if (re.test(text)) {
        return found(inv, sentences.find((s) => re.test(s)) ?? text, re);
      }
    }
  }
  const swept = coachCostImperatives(text);
  if (swept.length) return found(SWEEP, swept[0], "the shipped-prompt sweep");
  return null;
}

const nowVersion = () => `p-${new Date().toISOString().slice(0, 10)}-${sha256(String(Date.now())).slice(0, 6)}`;

/** The guidance a seat is working under right now, oldest first. */
export function policyFor(seat) {
  return db.prepare(`SELECT guidance FROM desk_policy
                     WHERE active=1 AND (seat=? OR seat='*') ORDER BY id`).all(seat)
    .map((r) => r.guidance);
}

/** The seat's system prompt, with its standing guidance appended. */
export function withPolicy(seat, system) {
  const notes = policyFor(seat);
  if (!notes.length) return system;
  /* Framed as the desk's own standing orders, and explicitly ranked BELOW the seat's
     charter: guidance sharpens how a seat reasons, it never redefines what it is for. */
  return `${system}\n\n=== STANDING ORDERS (from the desk's own results; they refine your judgement, they do not replace your charter) ===\n` +
    notes.map((n, i) => `${i + 1}. ${n}`).join("\n");
}

/** The generation currently in force. */
export function currentVersion() {
  const row = db.prepare(`SELECT version FROM policy_versions
                          WHERE reverted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get();
  return row?.version ?? "p-genesis";
}

/* THE SEATS NO STANDING ORDER MAY BE ADDRESSED TO.
 *
 * "Codex" because a note to the coach lands in the prompt of the seat that writes notes,
 * a loop that amplifies its own drift with nothing outside it to check the drift. "*"
 * because policyFor() injects it into every seat, which is the same problem wholesale.
 * And the LANE JUDGE, because a judge the coach can coach is not a second gate — it is
 * the first gate wearing a hat. All three are matched case-insensitively. */
const UNCOACHABLE = new Set(["codex", "*", JUDGE_SEAT.toLowerCase()]);

/** The judge, reached lazily so desk-policy stays importable without the model layer
 *  (llm.js imports withPolicy from this file; a static import would be a cycle). */
async function defaultJudge(text) {
  const { judgeTechnique } = await import("./lib/policy-judge.js");
  return judgeTechnique(text);
}

/**
 * BOTH GATES, IN ORDER — the single definition of what "inside the lane" means.
 *
 * Null when the guidance may be installed; otherwise the refusal, carrying which gate
 * caught it (`gate`), the invariant or "judge" (`invariant`), the reason in the fence's
 * own words (`why`), and the sentence the coach actually wrote (`sentence`).
 *
 * applyPolicy calls it, and so does the tutor's DRY RUN — one definition, so a rehearsal
 * can never be judged by fewer gates than the live pass. Extracting it is the whole
 * reason the dry run cannot drift.
 */
export async function checkLane(guidance, { judge = defaultJudge } = {}) {
  const g = String(guidance || "").trim();
  /* GATE ONE: the patterns. Deterministic and first, so a candidate the denylist refuses
     stays refused — the judge is not even asked about it and cannot overturn it. */
  const broke = checkInvariants(g);
  if (broke) {
    return { error: `refused by the pattern fence — ${broke.why} — "${broke.sentence}"`,
      invariant: broke.id, gate: "patterns", why: broke.why, sentence: broke.sentence,
      pattern: String(broke.matched) };
  }
  /* GATE TWO: the judge. Everything the patterns are not equipped to see, which after
     the 2026-09-07 adversarial pass is most of it. */
  let placed;
  try {
    placed = await judge(g);
  } catch (e) {
    const why = `the lane judge could not be reached (${String(e?.message || e).slice(0, 160)}) — ` +
      "a coaching pass that cannot be checked is not installed";
    return { error: `refused by the semantic judge — ${why}`,
      invariant: "judge", gate: "judge-unreachable", why, sentence: g.slice(0, 200) };
  }
  if (placed?.verdict !== "in") {
    const register = placed?.register && placed.register !== "none" ? placed.register : "unplaceable";
    const why = `the lane judge placed this outside the coach's lane (${register})` +
      `${placed?.why ? ` — ${String(placed.why).slice(0, 160)}` : ""}`;
    return { error: `refused by the semantic judge — ${why} — "${g.slice(0, 200)}"`,
      invariant: "judge", gate: "judge", register, why, sentence: g.slice(0, 200) };
  }
  return null;
}

/**
 * Install a change. Autonomous by design — there is no approval argument — but every
 * change is versioned, attributed and reversible, and a change that crosses an
 * invariant is refused with the reason recorded rather than silently dropped.
 *
 * TWO GATES, IN THIS ORDER, AND THE ORDER IS THE ARCHITECTURE.
 *
 *   1. THE PATTERNS (checkInvariants). Deterministic, free, auditable in a diff, and
 *      honest about its reach: it catches the obvious phrasings and no more. A hit here
 *      returns immediately, so the judge is never even asked and can never overturn it.
 *   2. THE SEMANTIC JUDGE (lib/policy-judge.js). One small model call that reads the
 *      paragraph and answers whether it instructs anything about how much is bought,
 *      about money, or about the bot. This is the gate that catches "be bolder when
 *      conviction is high", which no denylist of nouns is going to catch.
 *
 * IT FAILS CLOSED. No key, no credit, a timeout, an off-contract answer — every one is a
 * refusal, recorded as `gate: "judge-unreachable"`. Coaching runs every few hours and a
 * pass that cannot be checked simply waits for the next one; an open fence on the day
 * the provider is down is not a trade this desk makes.
 *
 * Async because of that call. `judge` is the test seam and the operator's escape hatch
 * for a different judge — the production caller (codex-tutor's techniqueReview) passes
 * nothing, and test-coach-lane.mjs asserts that it passes nothing.
 */
export async function applyPolicy({ seat, guidance, rationale, evidence = {}, author = "codex",
  replaces = null, version = null, judge = defaultJudge } = {}) {
  const s = String(seat || "").trim();
  const g = String(guidance || "").trim();
  if (!s || !g) return { ok: false, error: "a policy change needs a seat and guidance" };
  if (g.length > 600) return { ok: false, error: "guidance must be one paragraph a seat can hold in mind" };
  if (UNCOACHABLE.has(s.toLowerCase())) {
    const why = s.toLowerCase() === JUDGE_SEAT.toLowerCase()
      ? "the lane judge may not be given standing orders by the coach it judges"
      : "the coach may not write his own standing orders";
    emit("policy:refused", { seat: s, invariant: "self", gate: "self", why, sentence: g.slice(0, 200) });
    return { ok: false, error: `refused — ${why}`, invariant: "self", gate: "self", why,
      sentence: g.slice(0, 200) };
  }
  /* A REFUSAL IS VISIBLE OR IT TEACHES NOBODY. The chronicle carries the invariant, the
     reason in the fence's own words, WHICH OF THE TWO GATES CAUGHT IT, and THE SENTENCE
     THE COACH ACTUALLY WROTE — so an operator reading the Codex tab sees that the coach
     reached for a size instruction and was stopped, rather than seeing a change that
     quietly never appeared. The same fields come back to the caller, and techniqueReview
     records them per seat. */
  const refusal = await checkLane(g, { judge });
  if (refusal) {
    emit("policy:refused", { seat: s, author, ...refusal });
    return { ok: false, ...refusal };
  }
  const v = version || nowVersion();
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO policy_versions (version, parent, created_at, note)
                VALUES (?,?,?,?)`).run(v, currentVersion(), now, rationale ?? null);
    // A seat's guidance is a short standing list, not an archive: replacing is how a
    // coach corrects himself, and an unbounded list would eventually be the prompt.
    if (replaces) {
      db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=? AND active=1")
        .run(now, "replaced by a newer reading of the same evidence", replaces);
    }
    const info = db.prepare(`INSERT INTO desk_policy
      (seat, guidance, rationale, evidence, author, version, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(s, g, String(rationale || "").slice(0, 800), canonicalJson(evidence), author, v, now);
    trimSeat(s);
    db.exec("COMMIT");
    emit("policy:changed", { seat: s, version: v, guidance: g, rationale, author });
    return { ok: true, id: Number(info.lastInsertRowid), version: v };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

/** At most six standing notes per seat: the oldest retires when a seventh arrives. */
const MAX_NOTES_PER_SEAT = 6;
function trimSeat(seat) {
  const rows = db.prepare("SELECT id FROM desk_policy WHERE seat=? AND active=1 ORDER BY id DESC").all(seat);
  for (const r of rows.slice(MAX_NOTES_PER_SEAT)) {
    db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=?")
      .run(Date.now(), "aged out — a seat carries at most six standing orders", r.id);
  }
}

/** Retire one note (a coach correcting himself, or a rollback). */
export function retirePolicy(id, why = "retired") {
  const r = db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=? AND active=1")
    .run(Date.now(), String(why).slice(0, 300), id);
  return { ok: r.changes > 0 };
}

/**
 * REVERT A GENERATION. The safety net that makes autonomy survivable: if the cohort
 * decided under a version is measurably worse than its parent's, every note that
 * version installed goes inactive and the desk returns to the technique that was
 * working. Called by the tutor's own health check, and callable by hand.
 */
export function revertVersion(version, why = "cohort underperformed its parent") {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = db.prepare(`UPDATE desk_policy SET active=0, retired_at=?, retired_why=?
                          WHERE version=? AND active=1`).run(now, String(why).slice(0, 300), version);
    db.prepare("UPDATE policy_versions SET reverted_at=?, reverted_why=? WHERE version=?")
      .run(now, String(why).slice(0, 300), version);
    db.exec("COMMIT");
    emit("policy:reverted", { version, notes: n.changes, why });
    return { ok: true, retired: n.changes };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

/** Everything in force, for the floor's Codex tab and for the tutor's own context. */
export function activePolicy() {
  return db.prepare(`SELECT id, seat, guidance, rationale, author, version, created_at
                     FROM desk_policy WHERE active=1 ORDER BY seat, id`).all();
}

/** The record of what the coach has done, including what was retired and why. */
export function policyHistory(limit = 50) {
  return db.prepare(`SELECT id, seat, guidance, rationale, author, version, active,
                            created_at, retired_at, retired_why
                     FROM desk_policy ORDER BY id DESC LIMIT ?`).all(Math.min(200, limit));
}
