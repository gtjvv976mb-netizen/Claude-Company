import { enforceCeoRails, enforceRiskRails } from "./src/agents/risk-rails.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};
const near = (actual, expected, epsilon = 0.011) => Math.abs(actual - expected) <= epsilon;

const config = {
  equityUsd: 10_000,
  maxRiskPct: 1,
  /* `maxBookRiskPct` was here and the setting no longer exists (2026-09-07). It was the
     ceiling on the desk's PAPER book, and rails clamped a new idea to what was left under
     it — so four live calls refused a clean coin outright. A stale key in a caller's
     config must now do nothing at all, which the section below drives. */
  targetSizeUsd: 10_000,
  maxRoundTripSlippagePct: 8,
};
const ev = {
  pair: { priceUsd: 1 },
  exitProbe: { roundTripLossPct: 2 },
  mintAccount: { mintAuthority: null, freezeAuthority: null, flags: [] },
};
const model = {
  risk_tier: "full",
  stop_price: 0.60,
  stop_rationale: "the launch breaks",
  size_rationale: "complete evidence",
  liquidity_adjusted: false,
  portfolio_notes: "",
  confidence: 1,
  // Deliberate lies: production must overwrite all three.
  position_size_usd: 10_000,
  max_loss_usd: 1,
  pct_of_equity_at_risk: 0.01,
};
const run = (redteam = "survives", over = {}) => enforceRiskRails({
  risk: { ...model, ...(over.risk || {}) },
  ev: { ...ev, ...(over.ev || {}) },
  redteam: { verdict: redteam },
  /* `openRiskUsd` was passed here. The parameter is gone: what is already at risk is a
     balance question, and the desk holds no balance. Anything extra in this object is
     ignored by the destructuring, which is exactly what the stale-key checks below want. */
  ...(over.extra || {}),
  config: { ...config, ...(over.config || {}) },
});

console.log("\nLOSS-AT-STOP IS RECOMPUTED, NOT TRUSTED");
const full = run();
/* 40% stop distance; $100 / 40% = $250. It was $238.10 while the measured 2% round trip
   was added to the loss fraction — a friction quoted at a notional the desk invented,
   folded into a paper number that reaches no wallet. Priced off the STOP alone now, which
   is the level the desk actually authored. */
ok("position derives from the $100 budget and the 40% stop distance",
  near(full.position_size_usd, 250), `size=$${full.position_size_usd}`);
ok("max loss is recomputed to the configured ceiling", near(full.max_loss_usd, 100),
  `loss=$${full.max_loss_usd}`);
ok("risk percentage is recomputed", near(full.pct_of_equity_at_risk, 1, 0.0001),
  `${full.pct_of_equity_at_risk}%`);

console.log("\nTHE RED TEAM CAN ONLY REDUCE RISK — AND BOOK HEAT NO LONGER SPEAKS AT ALL");
const wounded = run("wounded");
const refuted = run("refuted");
ok("wounded is smaller than survives", wounded.max_loss_usd < full.max_loss_usd,
  `${wounded.max_loss_usd} < ${full.max_loss_usd}`);
ok("refuted is smaller than wounded", refuted.max_loss_usd < wounded.max_loss_usd,
  `${refuted.max_loss_usd} < ${wounded.max_loss_usd}`);
/* THE BOOK-HEAT CLAMP IS GONE (owner, 2026-09-07). It used to read
   `min(budget, maxBookRisk - openRiskUsd)`, so $390 of open paper risk cut the loss
   budget to $10 and $400 zeroed the size outright — at which point mandate.eligibility()
   declined the coin with safety:true at `zero_authorized_size`, a gate no escalation
   level can reach past. The desk was refusing to NAME a coin because of money it does not
   hold. What is at risk is the bot's question, answered against the wallet that signs
   (executor/strategy.mjs:308-311). Both old inputs must now be inert. */
const almostFull = run("survives", { extra: { openRiskUsd: 390 } });
ok("a caller still passing openRiskUsd changes nothing",
  near(almostFull.position_size_usd, full.position_size_usd),
  `$${almostFull.position_size_usd} vs $${full.position_size_usd}`);
const fullBook = run("survives", { extra: { openRiskUsd: 400 },
  config: { maxBookRiskPct: 4 } });
ok("an 'exhausted' book still authorizes the same size", fullBook.position_size_usd > 0
  && near(fullBook.position_size_usd, full.position_size_usd),
  `$${fullBook.position_size_usd} — ${fullBook.rail_notes.join("; ")}`);
ok("...and no rail note talks about book heat or open risk",
  !fullBook.rail_notes.some((n) => /book heat|already at risk/i.test(n)),
  fullBook.rail_notes.join("; "));

console.log("\nTHE EXIT-PROBED NOTIONAL IS NO LONGER A CEILING — THE BOT OWNS THAT");
/* This section asserted the opposite: `size cannot exceed the measured $75 notional`,
   with cfg.targetSizeUsd as an absolute cap on position_size_usd. Removed 2026-09-07 on
   the owner's rule — the desk says WHAT and WHEN and never how much. Two things were
   wrong with the ceiling at once: the notional was a size the DESK chose (and on the day
   it was $75 while the bot's real clip was about $2), and the figure being capped is the
   desk's paper record, which reaches no wallet. The real ceilings run on the real order:
   executor/strategy.mjs:305 (maxSolPerTrade), :307-311 (per-name risk, book heat, the
   daily deploy cap, spendable balance) and executor/jupiter.mjs:148-149 (the built
   order's measured price impact against the pool). */
const probed = run("survives", { config: { targetSizeUsd: 75 } });
ok("a stale targetSizeUsd in a caller's config does nothing", probed.position_size_usd > 75,
  `size=$${probed.position_size_usd}`);
ok("...and no rail note claims an exit-probe cap",
  !probed.rail_notes.some((n) => /exit-probe|exit probe/.test(n)), probed.rail_notes.join("; "));
/* THE DESK'S OWN BOOK IS STILL A BOUND, because a paper position larger than the paper
   book is a record that does not add up. That is bookkeeping, not a money veto. */
const oversized = run("survives", { config: { equityUsd: 40, maxRiskPct: 100 } });
ok("position_size_usd is still bounded by the desk's own equity",
  oversized.position_size_usd <= 40 && oversized.rail_notes.some((n) => /book equity/.test(n)),
  `$${oversized.position_size_usd} — ${oversized.rail_notes.join("; ")}`);

console.log("\nCEO MAY CUT, NEVER ENLARGE OR REVIVE");
const authorized = { position_size_usd: 75 };
const enlarged = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 500, size_change_reason: "" }, risk: authorized,
});
ok("oversized CEO order is capped to Risk", enlarged.order_size_usd === 75,
  `$${enlarged.order_size_usd}`);
const cut = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 20, size_change_reason: "" }, risk: authorized,
});
ok("a genuine CEO cut is preserved", cut.order_size_usd === 20);
const empty = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 0, size_change_reason: "" }, risk: authorized,
});
ok("zero-sized APPROVE becomes HOLD", empty.ruling === "HOLD" && empty.order_size_usd === 0,
  `${empty.ruling} $${empty.order_size_usd}`);
const decline = enforceCeoRails({
  ceo: { ruling: "DECLINE", order_size_usd: 50, size_change_reason: "" }, risk: authorized,
});
ok("DECLINE is always zero", decline.order_size_usd === 0);
const malformed = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: Infinity, size_change_reason: "" }, risk: authorized,
});
ok("non-finite approval fails to HOLD at zero",
  malformed.ruling === "HOLD" && malformed.order_size_usd === 0,
  `${malformed.ruling} $${malformed.order_size_usd}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
