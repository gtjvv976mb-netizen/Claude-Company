/**
 * THE BOT OWNS THE SIZE — the desk half.
 *
 * THE OWNER'S RULE (2026-09-07), architectural rather than a risk preference: the
 * trading team must never determine how much is bought — not the amount, not the
 * ceiling, not the minimum. The desk decides WHAT to buy and WHEN to sell; the bot
 * decides HOW MUCH, from its own configuration and its own caps.
 *
 * The desk's five fingerprints on size were: strategy.mjs's min() on call.size_sol,
 * poller.mjs's min() on ev.fixed_sol (both removed — see executor/test-bot-owns-size.mjs
 * for that half), copy.js's authoritative size_sol on every delivery, risk-rails'
 * position_size_usd ceiling, and compliance's size_exceeds_exit_probe veto.
 *
 * BUT THE DESK CANNOT STOP KNOWING A SIZE, and that is what this file is really about.
 * The exit probe measures a round trip AT SOME NOTIONAL and the stop-floor veto is
 * derived from that measurement — the veto that caught four consecutive unexecutable
 * live calls on 2026-09-03. Delete the notional and the veto has nothing to stand on.
 *
 * So the notional stopped being a CHOICE and became a MEASUREMENT: the desk probes at
 * the largest per-trade cap a live WALL-ST-E declares on its own heartbeat. Which means
 * the interesting cases are all the ones where there is nothing to measure — no bot, a
 * stale bot, an older bot with no caps in its shape, a cap too small to quote against.
 * Every one of them must land on the documented fallback. None of them may land on
 * "unknown", zero, or Infinity: an unbounded notional silently removes both the size
 * ceiling and the stop-floor veto, which is the failure this whole mechanism exists to
 * prevent, arrived at quietly.
 *
 * WHERE THE STOP-FLOOR VETO LIVES NOW. It was compliance.js's `stop_inside_costs`, and
 * a concurrent change on this same date moved it (with `edge_below_cost` and
 * `size_exceeds_exit_probe`) into the executor, on the same reasoning that produced this
 * one: a cost judged at a size the desk invented is a wrong judgement wearing caution's
 * clothes. This file does not put them back — it asserts the property they existed for
 * at its new address, because a safety property that survives a move is fine and one
 * that quietly evaporates during a move is exactly what a test is for.
 */
if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const db = (await import("./src/lib/store.js")).default;
const copy = await import("./src/copy.js");                 // runs the copy_settings migrations
const probe = await import("./src/probe-size.js");
const FALLBACK = probe.ROUTE_PROBE_FALLBACK_USD;   // the stated amount used when no bot can be read
const { enforceRiskRails } = await import("./src/agents/risk-rails.js");
const { complianceCheck } = await import("./src/agents/compliance.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 21, OTHER = 22, BOTLESS = 23;
for (const n of [FLOOR, OTHER, BOTLESS]) copy.settingsFor(n);   // materialise the rows

/* Write a heartbeat the way office.js's /executor/heartbeat route stores one: the
   sanitised health object under `health`, with `seenAt` stamped by the server. Writing
   the ROW rather than calling the route keeps this test about the sizing read, and the
   shape is pinned by test-executor-heartbeat.mjs on the other side. */
const beat = (floorNo, { maxSolPerTrade = 0.05, ageMs = 30_000, caps = undefined } = {}) => {
  const health = {
    state: "healthy",
    caps: caps === null ? undefined
      : caps ?? { maxSolPerTrade, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4 },
  };
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?").run(
    JSON.stringify({ mode: "live", wallet: "Burner1111", open: 0, held: [], health,
      ts: Date.now() - ageMs, seenAt: Date.now() - ageMs }), floorNo);
};
const silence = (floorNo) =>
  db.prepare("UPDATE copy_settings SET executor_heartbeat=NULL WHERE floor_no=?").run(floorNo);
const clearAll = () => { for (const n of [FLOOR, OTHER, BOTLESS]) silence(n); };

/* The SOL price the conversion uses. With no executor_fills row in a fresh sandbox this
   is DESK_SOL_USD_FALLBACK, which is exactly the provenance the resolution reports. */
const MIN_MEANINGFUL_USD = probe.MIN_PROBE_USD;
const SOL = probe.sizingSolUsd().solUsd;
console.log(`\nSOL price for every conversion below: $${SOL} (${probe.sizingSolUsd().source})`);

console.log("\nTHE PROBE NOTIONAL IS A READING OFF THE BOT");
clearAll();
beat(FLOOR, { maxSolPerTrade: 0.05 });
const atFull = probe.botProbeNotional();
ok("the notional is the bot's declared per-trade cap in dollars",
  atFull.fromBot === true && atFull.sizeUsd === Number((0.05 * SOL).toFixed(2)),
  `${atFull.sizeUsd} USD — ${atFull.source}`);
ok("...and it names the bot's heartbeat as the source, not a config key",
  /heartbeat/i.test(atFull.source) && !/DESK_TARGET_SIZE_USD/.test(atFull.source), atFull.source);

/* THE PROPERTY THAT MAKES THIS A MEASUREMENT AND NOT A COPY OF A CONSTANT: change what
   the bot declares and the number the desk probes at moves with it. */
beat(FLOOR, { maxSolPerTrade: 0.02 });
const atSmall = probe.botProbeNotional();
ok("the probe notional TRACKS a changed heartbeat cap",
  atSmall.fromBot === true && atSmall.sizeUsd === Number((0.02 * SOL).toFixed(2)) &&
  atSmall.sizeUsd < atFull.sizeUsd,
  `0.05 SOL -> $${atFull.sizeUsd}, then 0.02 SOL -> $${atSmall.sizeUsd}`);
ok("...and it is nothing like the stated default it replaced",
  atSmall.sizeUsd !== FALLBACK, `$${atSmall.sizeUsd} vs the $${FALLBACK} fallback`);

/* Desk-wide, the probe must cover the BIGGEST order that could be placed against the
   call — the same call goes to every floor, and a probe sized to the smallest bot would
   clear a stop the largest one cannot exit through. */
beat(OTHER, { maxSolPerTrade: 0.04 });
const across = probe.botProbeNotional();
ok("with two live bots the desk probes at the LARGER cap",
  across.botSol === 0.04 && across.sizeUsd === Number((0.04 * SOL).toFixed(2)),
  `floors ${FLOOR}@0.02 + ${OTHER}@0.04 -> $${across.sizeUsd} (${across.why})`);
ok("...and a single floor's own question still answers about that floor's own bot",
  probe.botProbeNotional({ floorNo: FLOOR }).botSol === 0.02,
  `floor ${FLOOR} -> ${probe.botProbeNotional({ floorNo: FLOOR }).botSol} SOL`);

console.log("\nEVERY DEGENERATE CASE LANDS ON THE DOCUMENTED FALLBACK, NOT ON UNBOUNDED");
const degenerate = [];
const record = (label, resolution) => {
  degenerate.push({ label, resolution });
  ok(label, resolution.fromBot === false && resolution.sizeUsd === FALLBACK,
    `$${resolution.sizeUsd} — ${resolution.why}`);
};

clearAll();
record("no bot has EVER reported to this desk", probe.botProbeNotional());

clearAll();
beat(FLOOR);
record("a floor with no bot of its own", probe.botProbeNotional({ floorNo: BOTLESS }));

clearAll();
beat(FLOOR, { ageMs: 25 * 3_600e3 });
record("a STALE heartbeat (25h; a live bot pulses every minute)", probe.botProbeNotional());

clearAll();
beat(FLOOR, { caps: null });
record("an OLDER bot whose health carries no caps at all", probe.botProbeNotional());

clearAll();
beat(FLOOR, { caps: { dailySolCap: 0.5 } });
record("a bot reporting caps but no maxSolPerTrade", probe.botProbeNotional());

clearAll();
beat(FLOOR, { maxSolPerTrade: 0.000001 });
record("a cap so small the probe would quote dust ($0.00 at any sane SOL price)",
  probe.botProbeNotional());

clearAll();
beat(FLOOR, { maxSolPerTrade: 5 });
record("a cap ABOVE the executor's own 0.05 SOL hard ceiling (not a measurement)",
  probe.botProbeNotional());

clearAll();
db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
  .run("{not json at all", FLOOR);
record("a corrupt heartbeat row", probe.botProbeNotional());

clearAll();
db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
  .run(JSON.stringify({ health: { caps: { maxSolPerTrade: 0.05 } } }), FLOOR);
record("a heartbeat with caps but NO timestamp to age it by", probe.botProbeNotional());

/* THE ONE OUTCOME THAT IS NEVER ACCEPTABLE. Falling back to a stated default is fine;
   going quietly unbounded is not, because a zero or Infinity notional removes the
   risk-rails size ceiling and the compliance veto in the same stroke and says nothing. */
const unbounded = degenerate.filter(({ resolution }) =>
  !Number.isFinite(resolution.sizeUsd) || !(resolution.sizeUsd > 0));
ok(`none of the ${degenerate.length} degenerate cases resolves to zero, NaN or Infinity`,
  unbounded.length === 0, unbounded.map((u) => u.label).join("; ") || "all finite and positive");
ok("...and every one of them SAYS why it fell back",
  degenerate.every(({ resolution }) => typeof resolution.why === "string" && resolution.why.length > 10),
  degenerate.map(({ resolution }) => resolution.why).slice(0, 2).join(" | "));

/* And a floor under the fallback itself. It was an env dial (DESK_TARGET_SIZE_USD) when
   this was written and is now a stated module constant — the safer of the two, because a
   typo in an env file can no longer become the amount the desk quotes at. Either way the
   property is the same: the fallback is finite, positive and known. */
ok("the fallback itself is a stated, finite, positive amount",
  Number.isFinite(FALLBACK) && FALLBACK >= MIN_MEANINGFUL_USD, `$${FALLBACK}`);
ok("a bot-less desk probes at exactly that stated amount",
  (clearAll(), probe.botProbeNotional().sizeUsd === FALLBACK), `$${FALLBACK}`);

console.log("\nNO DESK SEAT SIZES OFF A NUMBER THE DESK INVENTED");
/* This section was written to assert that risk-rails and compliance both read the
   PROBED notional through one helper, so `size_exceeds_exit_probe` would keep meaning
   "bigger than we proved we can exit". While it was being written, a concurrent change
   on this same date took the owner's rule further and deleted both judgements outright:
   compliance's three cost vetoes and risk-rails' exit-probe size ceiling are gone, on
   the ground that the executor already runs the identical arithmetic at the size it is
   about to sign for. That is the same rule, one step further, so nothing is restored
   here — what is asserted is the property those seats existed to protect, at the
   addresses that now hold it. */
const PROBED = 5.15;                            // a 0.05 SOL bot at SOL $103
const evAt = (sizeUsd) => ({
  pair: { priceUsd: 1 },
  exitProbe: { targetSizeUsd: sizeUsd, roundTripLossPct: 2 },
  mintAccount: { mintAuthority: null, freezeAuthority: null, flags: [] },
});
/* The amount a coin was quoted at still travels ON the evidence, with its provenance,
   because a round-trip figure means nothing without the amount behind it — and, now that
   the amount is a reading off a bot rather than a constant, nothing without whether a bot
   was there to read. That stamp is written in src/data/evidence.js. */
const evidenceSrc = fs.readFileSync(path.join(ROOT, "src/data/evidence.js"), "utf8");
ok("evidence stamps the probed amount and its source onto every exitProbe",
  /targetSizeUsd: probeSize\.sizeUsd/.test(evidenceSrc) &&
  /sizeSource: probeSize\.source/.test(evidenceSrc) &&
  /botProbeNotional\(\)/.test(evidenceSrc),
  "evidence.js exitProbe stamp");

const railed = enforceRiskRails({
  risk: { risk_tier: "full", stop_price: 0.6, confidence: 1, position_size_usd: 10_000 },
  ev: evAt(PROBED), redteam: { verdict: "survives" }, openRiskUsd: 0,
  config: { equityUsd: 10_000, maxRiskPct: 1, maxBookRiskPct: 4,
    targetSizeUsd: 10_000, maxRoundTripSlippagePct: 8 },
});
ok("risk-rails no longer clamps a position to a probe notional",
  railed.position_size_usd > PROBED &&
  !(railed.rail_notes || []).some((n) => /exit-probe notional/.test(n)),
  `$${railed.position_size_usd}; notes: ${(railed.rail_notes || []).join("; ")}`);
ok("...and what it DOES still bound is the desk's own book arithmetic, not the bot",
  enforceRiskRails({
    risk: { risk_tier: "full", stop_price: 0.6, confidence: 1, position_size_usd: 10_000 },
    ev: evAt(PROBED), redteam: { verdict: "survives" }, openRiskUsd: 0,
    config: { equityUsd: 50, maxRiskPct: 100, maxBookRiskPct: 400,
      targetSizeUsd: 10_000, maxRoundTripSlippagePct: 8 },
  }).position_size_usd <= 50, "a paper position never exceeds the paper book");

const sizeCodes = complianceCheck({
  pm: { decision: "PROPOSE", how_red_team_was_answered: "answered" },
  redteam: { verdict: "survives" },
  risk: { position_size_usd: 10_000, max_loss_usd: 42, stop_price: 0.6 },
  ticket: null, ev: evAt(PROBED),
}).violations.map((x) => x.code);
ok("compliance no longer vetoes a size against a desk-chosen probe notional",
  !sizeCodes.includes("size_exceeds_exit_probe"), sizeCodes.join(",") || "no violations");
const complianceSrc = fs.readFileSync(path.join(ROOT, "src/agents/compliance.js"), "utf8");
const railsSrc = fs.readFileSync(path.join(ROOT, "src/agents/risk-rails.js"), "utf8");
ok("...and both seats name the executor lines that now own the judgement",
  /executor\/strategy\.mjs/.test(complianceSrc) && /executor\/strategy\.mjs/.test(railsSrc),
  "a move, documented at both ends, rather than a deletion");

console.log("\nTHE SAFETY IT ALL EXISTS FOR STILL REFUSES A STOP INSIDE ITS COSTS");
/* THE PROPERTY, ASSERTED AT ITS NEW ADDRESS. A stop the round trip would trigger on its
   own must still be refused by SOMETHING: that guard exists because four consecutive
   live calls died at the wallet on 2026-09-03 (HeeHaw, TOAD, USWS), and a desk that
   publishes such a stop publishes a trade nobody can take.

   It is the bot's refusal now, run at the size the bot is about to sign for — strategy's
   R_net gate ("costs eat the target") and poller's preflight round-trip check. Exercised
   rather than described, because "we moved it" is a claim and a skip verdict is
   evidence. */
const { planEntry, DEFAULTS } = await import("./executor/strategy.mjs");
const botState = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: 5, spendableSol: 5, wins: 0, losses: 0 };
const botCfg = { ...DEFAULTS, fixedSol: 0 };
const botPlan = (stop, target) => planEntry({
  call: { mint: "m", symbol: "T", entry_ref: 1, stop, target },
  cfg: botCfg, state: botState });
// -2.8% stop / +3.5% target: gross R of 1.25, which costs eat outright.
const insideCosts = botPlan(0.972, 1.035);
ok("the bot refuses a bracket whose costs eat the target",
  insideCosts.action === "skip", `${insideCosts.action}: ${insideCosts.reason}`);
ok("...naming the cost, so it cannot be mistaken for a taste",
  /cost/i.test(insideCosts.reason || ""), insideCosts.reason);
const outsideCosts = botPlan(0.70, 2.0);        // -30% / +100%, real room either side
ok("...while a bracket with real room still trades",
  outsideCosts.action === "buy", `${outsideCosts.action} ${outsideCosts.sol} SOL`);

const pollerSrc = fs.readFileSync(path.join(ROOT, "executor/poller.mjs"), "utf8");
/* RE-ANCHORED, NOT RELAXED (route sizing, 2026-09-09). The refusal moved into
   executor/entry-sizing.mjs, where the halving ladder applies it at every candidate
   amount instead of once at the desk's clip. It is still the BOT's refusal at the BOT's
   own size: the stop comes from the bot's entryReference, the starting amount is the
   bot's own plan.sol, and the ladder's source is asserted to read no desk field at all. */
const sizingSrc = fs.readFileSync(path.join(ROOT, "executor/entry-sizing.mjs"), "utf8");
ok("and the preflight refusal is still there, on the lamports about to be spent",
  /cost\.conservativeReturnRatio <= stopRatio/.test(sizingSrc) &&
  /stopRatio: entryReference\.stopRatio/.test(pollerSrc) &&
  /preliminaryAmountRaw/.test(pollerSrc),
  "executor/entry-sizing.mjs, driven from poller.mjs entry preflight");
ok("...and the size the ladder starts from is the bot's own plan, not a feed field",
  /sol: plan\.sol, lamportsPerSol: LAMPORTS/.test(pollerSrc) &&
  !/\b(size_sol|fixed_sol|conviction)\b/.test(sizingSrc),
  "sol: plan.sol; entry-sizing.mjs names no desk field");

console.log("\nTHE DESK'S DELIVERY NO LONGER ASSERTS AN AUTHORITATIVE SIZE");
/* Two honest options were on the table: drop size_sol from the delivery, or keep it and
   label it non-binding. Both were implemented within the hour — this file's author
   labelled it, the concurrent change then removed the number entirely and KEPT the
   label. The union is what ships and it is the stronger of the two: there is no number
   for a client to mistake for an instruction, AND a hard-coded `size_binding: false`
   still stands guard if some future caller reintroduces one. Both halves are asserted,
   because either alone would be a regression. */
const call = {
  id: 1, mint: "M", symbol: "OWNS", category: "memecoin", launchpad: "pump.fun",
  conviction: 80, entry_ref: 0.001, stop: 0.00088, target: 0.0014,
  liq_at_call: 200_000, mcap_at_call: 900_000,
  desk_size_usd: 15, desk_equity_usd: 100,
};
copy.saveSettings(FLOOR, { appetite: "aggressive", bankrollSol: 5, fixedSol: 0.05 });
const delivery = copy.decide(FLOOR, call);
ok("a delivery is machine-readably non-binding",
  delivery.verdict === "offered" && delivery.sizeBinding === false,
  `sizeBinding=${delivery.sizeBinding}`);
ok("...and carries no size for anything to honour",
  delivery.sizeSol === null, `sizeSol=${JSON.stringify(delivery.sizeSol)}`);
ok("...and says whose job it is, in the words the tenant reads",
  /your bot sizes this trade from its own caps/i.test(delivery.reason) &&
  /the desk does not size it/i.test(delivery.reason), delivery.reason);
/* The tenant's own fixed_sol must not sneak back in as an authority either: the same
   floor with a very different setting produces the same non-answer. */
copy.saveSettings(FLOOR, { fixedSol: 0.4 });
const bigger = copy.decide(FLOOR, call);
ok("...and a floor's stored fixed size changes nothing about the delivery",
  bigger.sizeSol === null && bigger.sizeBinding === false,
  `fixed 0.05 -> ${delivery.sizeSol}, fixed 0.4 -> ${bigger.sizeSol}`);

/* The wire says it too. A future client, a second bot, or the next person reading the
   payload must not have to go two repositories away to learn that the field is inert. */
const officeSrc = fs.readFileSync(path.join(ROOT, "src/office.js"), "utf8");
ok("every feed EVENT is labelled non-binding on the wire",
  /size_binding:\s*false,\s*\n\s*size_sol:/.test(officeSrc),
  (officeSrc.match(/.*size_binding: false.*/g) || []).length + " occurrences");
ok("...and so is the floor's stored fixed_sol in the feed's rules block",
  /fixed_sol: floorSettings\.fixed_sol[\s\S]{0,400}?size_binding: false/.test(officeSrc),
  "rules.size_binding");

console.log("\nTHE OWNER CAN SEE THIS ON THE FLOOR PAGE");
clearAll();
beat(FLOOR, { maxSolPerTrade: 0.05 });
const shown = copy.probeSizingForFloor(FLOOR);
ok("the floor payload says the size authority is the bot",
  shown.sizeAuthority === "bot" && /your bot decides how much it buys/i.test(shown.note),
  shown.note);
ok("...and shows the value the desk is probing at, with the bot as its source",
  shown.probeFromBot === true && shown.probeSizeUsd === Number((0.05 * SOL).toFixed(2)) &&
  shown.botMaxSolPerTrade === 0.05,
  `$${shown.probeSizeUsd} from ${shown.botMaxSolPerTrade} SOL/trade`);
clearAll();
const shownFallback = copy.probeSizingForFloor(FLOOR);
ok("...and with no bot it shows the fallback AND why it fell back",
  shownFallback.probeFromBot === false && shownFallback.probeSizeUsd === FALLBACK &&
  /no bot/i.test(shownFallback.probeWhy || ""),
  `$${shownFallback.probeSizeUsd} — ${shownFallback.probeWhy}`);
ok("the floor route hands that payload to the page",
  /probeSizing: copy\.probeSizingForFloor\(floorNo\)/.test(officeSrc), "office.js /feed");

const viewerSrc = fs.readFileSync(path.join(ROOT, "viewer/office3d.html"), "utf8");
ok("and the page renders it beside the tenant's own size box",
  /window\.__probeSizing = body\.probeSizing/.test(viewerSrc) &&
  /Your bot decides how much it buys/.test(viewerSrc) &&
  /probeFromBot/.test(viewerSrc) && /probeWhy/.test(viewerSrc),
  "office3d.html buildControls");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
