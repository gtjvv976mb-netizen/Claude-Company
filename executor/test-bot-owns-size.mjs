/**
 * THE BOT OWNS THE SIZE — the executor half.
 *
 * THE OWNER'S RULE (2026-09-07), and it is architectural rather than a risk preference:
 * the trading team must never determine how much is bought — not the amount, not the
 * ceiling, not the minimum. The desk decides WHAT to buy and WHEN to sell; this process
 * decides HOW MUCH, from its own configuration and its own caps.
 *
 * Two lines used to break it, and both looked prudent, which is why they survived:
 *
 *   strategy.mjs  if (call.size_sol != null) want = Math.min(want, Number(call.size_sol));
 *   poller.mjs    const fixed = Number(ev.fixed_sol) > 0
 *                   ? Math.min(Number(ev.fixed_sol), CFG.maxSolPerTrade) : CFG.fixedSol;
 *
 * A min() can only shrink the order, so neither could ever inflate a trade — but
 * shrinking IS deciding. A remote party who can set the size to 0.0001 silences this
 * bot as surely as one who can set it to 10, and this wallet is the operator's.
 *
 * So this file asserts the property in both directions (a desk size of 10 SOL must not
 * raise it; 0.001 must not lower it) and then asserts the far more important other
 * half: every limit this process owns still binds EXACTLY as it did before. Removing
 * the desk's influence must not have removed anything else.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, planEntry, freshState } from "./strategy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, got = "") => {
  cond ? (pass++, console.log(`PASS  ${name}${got ? `  -> ${got}` : ""}`))
       : (fail++, console.log(`FAIL  ${name}  -> ${typeof got === "string" ? got : JSON.stringify(got)}`));
};

// A bracket wide enough to survive costs, so sizing (not the R_net gate) is what is
// under test: -40% stop, +100% target, on a 5 SOL burner.
const wide = { mint: "m", symbol: "T", entry_ref: 1, stop: 0.60, target: 2.0 };
const st = (o = {}) => ({ ...freshState(0), equitySol: 5, ...o });
const CFG = { ...DEFAULTS, fixedSol: 0 };          // Kelly path; the fixed fund is tested separately
const sizeOf = (call, cfg = CFG, state = st()) => planEntry({ call, cfg, state });

console.log("\nA DESK SIZE MOVES NOTHING, IN EITHER DIRECTION");
const base = sizeOf(wide);
t("the baseline entry is a buy", base.action === "buy", `${base.sol} SOL — ${base.reason}`);

const huge = sizeOf({ ...wide, size_sol: 10 });
t("a desk size of 10 SOL does not RAISE the bot's size",
  huge.action === "buy" && huge.sol === base.sol,
  `desk 10 SOL -> ${huge.sol} SOL (baseline ${base.sol})`);

const tiny = sizeOf({ ...wide, size_sol: 0.001 });
t("a desk size of 0.001 SOL does not LOWER the bot's size",
  tiny.action === "buy" && tiny.sol === base.sol,
  `desk 0.001 SOL -> ${tiny.sol} SOL (baseline ${base.sol})`);

// Zero is the interesting adversarial case: under the old min() it was falsy-safe by
// accident (`!= null` let 0 through, so Math.min(want, 0) was 0) and would have sized
// every trade to nothing. It must now be as inert as any other desk number.
const zero = sizeOf({ ...wide, size_sol: 0 });
t("a desk size of ZERO cannot silence the bot",
  zero.action === "buy" && zero.sol === base.sol,
  `desk 0 SOL -> ${zero.sol} SOL`);

const negative = sizeOf({ ...wide, size_sol: -5 });
t("a negative desk size cannot invert the order",
  negative.action === "buy" && negative.sol === base.sol, `${negative.sol} SOL`);

const garbage = sizeOf({ ...wide, size_sol: "0.0001" });
t("a desk size arriving as a STRING is inert too (JSON off the wire)",
  garbage.action === "buy" && garbage.sol === base.sol, `${garbage.sol} SOL`);

console.log("\nCONVICTION WAS THE LAST SIZE DIAL, AND IT IS GONE");
/* THE CHANNEL 9eee450 MISSED. size_sol and fixed_sol were taken out of the sizing path,
 * and the sweep above proves it. `call.conviction` was NOT, and it survived precisely
 * because it did not look like a size instruction:
 *
 *     const convictionScale = Number.isFinite(conviction) && conviction > 0
 *       ? Math.max(c.convictionFloor, Math.min(1, conviction / 100)) : 1;   // floor 0.35
 *     ...
 *     want = want * convictionScale;
 *
 * Live conviction runs 20 to 51 out of 100, so the desk moved this wallet's stake over a
 * 2.9x range through a number the desk writes about ITSELF. Anything that could raise a
 * seat's conviction — a coach rewriting that seat's standing orders included — raised
 * the amount without ever writing the word size. That is laundering, not risk
 * management, and the multiplier is deleted (2026-09-07). */
const convicted = (conviction) => sizeOf({ ...wide, conviction });
const noConviction = sizeOf(wide);
t("the desk's lowest conviction buys what its highest buys",
  convicted(1).sol === convicted(100).sol && convicted(1).action === "buy",
  `1/100 -> ${convicted(1).sol} SOL, 100/100 -> ${convicted(100).sol} SOL`);
t("...and both buy what a call stating no conviction buys",
  convicted(50).sol === noConviction.sol, `${convicted(50).sol} vs ${noConviction.sol} SOL`);
t("...across the whole live range and past both ends of it",
  new Set([1, 20, 30, 51, 80, 100, 999, -10, 0, "45"].map((v) => convicted(v).sol)).size === 1,
  [...new Set([1, 20, 30, 51, 80, 100, 999, -10, 0, "45"].map((v) => convicted(v).sol))].join(","));
t("the plan no longer reports a conviction scale, because there is none",
  !("convictionScale" in convicted(30)), Object.keys(convicted(30)).join(","));
t("...and DEFAULTS ships no convictionFloor for one to be built from",
  DEFAULTS.convictionFloor === undefined, String(DEFAULTS.convictionFloor));

/* WHAT CONVICTION MAY STILL DO. The operator, on their own box, may refuse calls the
 * desk is lukewarm about. It is a gate, not a dial: identical size on the taking side,
 * no trade on the other, and OFF unless a human here set it. */
t("the operator's conviction floor is off by default", DEFAULTS.minConviction === 0,
  String(DEFAULTS.minConviction));
const gate = { ...CFG, minConviction: 60 };
t("...and when the operator sets one it refuses, at nobody's chosen size",
  sizeOf({ ...wide, conviction: 30 }, gate).action === "skip",
  sizeOf({ ...wide, conviction: 30 }, gate).reason);
t("...while a call above it is taken at the same amount as an ungated one",
  sizeOf({ ...wide, conviction: 90 }, gate).sol === noConviction.sol,
  `${sizeOf({ ...wide, conviction: 90 }, gate).sol} vs ${noConviction.sol} SOL`);

console.log("\nEVERY FIELD THE DESK AUTHORS, SWEPT — ONLY THE BRACKET MOVES THE AMOUNT");
/* THE PROOF THAT MATTERS, and it is a sweep rather than an argument. The poller spreads
 * the WHOLE feed event into the call it plans on (`normalizedCall = { ...ev, ... }`), so
 * every column the desk writes genuinely reaches planEntry. This drives each of them
 * with hostile values and asserts the SOL amount does not move by one lamport.
 *
 * Three fields are excluded and named, because they DO move it and must: entry_ref, stop
 * and target are the bracket, and risk-at-stop sizing is a function of the stop by
 * construction. They are bounded on both sides by this process's own numbers — see the
 * assertions under them — which is what makes them a level the bot sizes AGAINST rather
 * than a size the desk hands over. */
const DESK_FIELDS = {
  conviction: [1, 51, 100, 999, -5, "80", null],
  size_sol: [0, 0.0001, 10, -1, "0.003", null],
  fixed_sol: [0, 0.0001, 10, "0.5", null],
  desk_size_usd: [1, 15, 100_000, null],
  desk_risk_usd: [0.5, 50, 9_999, null],
  desk_equity_usd: [10, 10_000, 1e9, null],
  liq_at_call: [500, 200_000, null],
  rt_loss_at_call: [0.1, 8.08, 90, null],
  mcap_at_call: [5_000, 9_000_000, null],
  entry_lo: [0.1, 0.99, 5, null],
  entry_hi: [1.01, 3, null],
  hold_band: ["nano", "very high", null],
  hold_min_ms: [1, 86_400_000, null],
  hold_max_ms: [1, 86_400_000, null],
  take_profit_x: [0, 1.5, 50, null],
  policy_version: ["p-genesis", "p-2026-09-07-abcdef", null],
  escalation_level: [0, 4, null],
  cycle_id: [1, 9_999, null],
  category: ["memecoin", "bluechip", null],
  launchpad: ["pump.fun", "other", null],
  symbol: ["T", "ZZZ"],
  thesis: ["a long thesis about the coin", null],
  invalidation: ["the deployer sells", null],
  flags_at_call: ["[]", '["mint_authority"]', null],
  image_url: ["https://example.invalid/a.png", null],
  source_floor: [1, 48, null],
  status: ["live", "closed"],
  risk_tier: ["full", "half", "probe", null],
  ts: [1, Date.now(), null],
  opened_at: [1, Date.now(), null],
  call_id: [1, 77],
  event_id: ["e1", "e2"],
};
const BRACKET = ["entry_ref", "stop", "target"];
const movers = [];
let swept = 0;
for (const [field, values] of Object.entries(DESK_FIELDS)) {
  for (const value of values) {
    swept++;
    const r = sizeOf({ ...wide, [field]: value });
    if (r.action !== "buy" || r.sol !== base.sol)
      movers.push(`${field}=${JSON.stringify(value)} -> ${r.action} ${r.sol ?? r.reason}`);
  }
}
t(`${swept} hostile values across ${Object.keys(DESK_FIELDS).length} desk-authored fields move the amount by nothing`,
  movers.length === 0, movers.slice(0, 4).join(" | ") || `every one still ${base.sol} SOL`);
t("...and the sweep covers every column the desk writes onto a call except the bracket",
  BRACKET.every((f) => !(f in DESK_FIELDS)) && Object.keys(DESK_FIELDS).length >= 30,
  `bracket held out: ${BRACKET.join(", ")}`);

/* THE THREE THAT DO MOVE IT, STATED HONESTLY RATHER THAN SWEPT UNDER. A wider stop is
 * more risk per SOL, so risk-at-stop buys less of it — that is the bot's own rule
 * applied to the desk's level, not the desk naming an amount. What bounds it is that
 * the bot owns BOTH ends: no stop however tight can lift the trade past the operator's
 * ceiling, and no stop however wide can push it under the bot's own minimum without
 * being refused outright. */
// A 0.5 SOL burner with the ceiling lifted clear, so the RISK path is what answers and
// the stop's effect is visible rather than hidden behind maxSolPerTrade.
const byStop = (stop, cfg = { ...CFG, maxSolPerTrade: 0.5 }) =>
  sizeOf({ ...wide, stop }, cfg, st({ equitySol: 0.5, spendableSol: 0.5 }));
t("a tighter stop does buy more — the bracket is the one desk input that moves size",
  byStop(0.9).sol > byStop(0.5).sol, `${byStop(0.9).sol} at a 10% stop vs ${byStop(0.5).sol} at 50%`);
t("...and it is risk-at-stop doing it: the RISK taken is the same at both widths",
  Math.abs(byStop(0.9).f - byStop(0.5).f) < 1e-9,
  `${(byStop(0.9).f * 100).toFixed(2)}% vs ${(byStop(0.5).f * 100).toFixed(2)}% of equity at stop`);
const ceilinged = (stop) => byStop(stop, { ...CFG, maxSolPerTrade: 0.04 });
t("...but no stop, however tight, lifts the trade past the bot's own ceiling",
  [0.999, 0.99, 0.95, 0.9].every((stop) => ceilinged(stop).action !== "buy" || ceilinged(stop).sol <= 0.04 + 1e-9),
  [0.999, 0.99, 0.95, 0.9].map((x) => `${x}:${ceilinged(x).sol ?? "skip"}`).join(" "));
t("...and a stop wide enough to size under the bot's own minimum is refused, not shrunk",
  [0.2, 0.1, 0.02].every((stop) => {
    const r = sizeOf({ ...wide, stop }, { ...CFG, networkFeeReserveSol: 0.0005 },
      st({ equitySol: 0.05, spendableSol: 0.05 }));
    return r.action === "skip" || r.sol >= DEFAULTS.minSolPerTrade;
  }), "no dust position at any stop width");

console.log("\nTHE BOT'S OWN LIMITS STILL BIND, EXACTLY AS BEFORE");
// The operator's per-trade ceiling.
const capped = sizeOf(wide, { ...CFG, maxSolPerTrade: 0.01 });
t("maxSolPerTrade still binds", capped.sol === 0.01, `${capped.sol} SOL`);
t("...and a desk size of 10 cannot lift it",
  sizeOf({ ...wide, size_sol: 10 }, { ...CFG, maxSolPerTrade: 0.01 }).sol === 0.01,
  `${sizeOf({ ...wide, size_sol: 10 }, { ...CFG, maxSolPerTrade: 0.01 }).sol} SOL`);

// The operator's fixed fund: "what the OPERATOR permits on one trade".
const fixed = sizeOf(wide, { ...CFG, fixedSol: 0.03 });
t("the operator's fixed fund is still taken in full when nothing else binds",
  fixed.sol === 0.03 && /operator ceiling/.test(fixed.reason), `${fixed.sol} SOL — ${fixed.reason}`);
t("...and a desk size of 0.001 does not shrink the operator's fixed fund",
  sizeOf({ ...wide, size_sol: 0.001 }, { ...CFG, fixedSol: 0.03 }).sol === 0.03,
  `${sizeOf({ ...wide, size_sol: 0.001 }, { ...CFG, fixedSol: 0.03 }).sol} SOL`);

// The per-name risk rail, on a burner small enough for it to bite: the operator asks
// for 0.03 SOL and 2.5% of a 0.3 SOL bankroll at a 40% stop only funds 0.01875.
const railCfg = { ...CFG, fixedSol: 0.03 };
const railed = sizeOf({ ...wide, size_sol: 10 }, railCfg, st({ equitySol: 0.3 }));
t("the per-name risk cap still sizes the trade down",
  railed.action === "buy" && /per-name risk cap/.test(railed.boundBy || ""),
  `${railed.sol} SOL bound by ${railed.boundBy}`);

// Book heat.
const hot = sizeOf(wide, CFG, st({ bookHeat: CFG.bookHeatMax - 0.001 }));
t("book heat still binds", /book heat/.test(hot.boundBy || "") || hot.action === "skip",
  `${hot.action} ${hot.sol ?? ""} bound by ${hot.boundBy} — ${hot.reason}`);

// The rolling deploy cap.
const spent = sizeOf(wide, CFG, st({ deployedTodaySol: CFG.dailySolCap - 0.004 }));
t("the rolling 24h deploy cap still binds",
  /deploy cap/.test(spent.boundBy || "") || spent.action === "skip",
  `${spent.action} ${spent.sol ?? ""} bound by ${spent.boundBy}`);

// The loss brake and the open-position sentinel are refusals, not sizings; a desk size
// must not be able to talk past either.
const braked = sizeOf({ ...wide, size_sol: 0.02 }, CFG, st({ realizedTodaySol: -999 }));
t("the realized-loss brake still refuses, desk size or not", braked.action === "skip",
  `${braked.action}: ${braked.reason}`);
const full = sizeOf({ ...wide, size_sol: 0.02 }, { ...CFG, maxOpenPositions: 1 }, st({ openCount: 1 }));
t("the open-position sentinel still refuses", full.action === "skip", `${full.action}: ${full.reason}`);

// The fee floor: a wallet too small to fund a viable position is refused, and a desk
// number is not a way around that either.
const dust = sizeOf({ ...wide, size_sol: 10 }, CFG, st({ equitySol: 0.02, spendableSol: 0.004 }));
t("a wallet too small for a viable position is still refused", dust.action === "skip",
  `${dust.action}: ${dust.reason}`);

console.log("\nTHE SOURCE ITSELF NO LONGER READS THE DESK'S NUMBERS");
/* A behavioural test proves today's build ignores them. This proves nobody QUIETLY put
 * the min() back: the two lines are named in the comments that replaced them, so a
 * restored assignment would read `= Math.min(want, Number(call.size_sol))` again and
 * this catches it in the diff rather than in a live trade. Comments are excluded so the
 * explanations that quote the old code do not fail their own test. */
const codeOf = (file) => fs.readFileSync(path.join(HERE, file), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")           // block comments
  .replace(/^[ \t]*\/\/.*$/gm, "");           // line comments

const strategy = codeOf("strategy.mjs");
t("strategy.mjs contains no live read of call.size_sol",
  !/call\.size_sol/.test(strategy),
  (strategy.match(/.*call\.size_sol.*/) || ["none"])[0].trim());

const poller = codeOf("poller.mjs");
t("poller.mjs contains no live read of ev.fixed_sol",
  !/ev\.fixed_sol/.test(poller), (poller.match(/.*ev\.fixed_sol.*/) || ["none"])[0].trim());
t("poller.mjs sizes the per-call cfg from its OWN fixedSol",
  /fixedSol:\s*CFG\.fixedSol/.test(poller),
  (poller.match(/.*fixedSol:.*/) || ["none"])[0].trim());
/* poller.mjs still spreads the whole event into the call it plans on
 * (`normalizedCall = { ...ev, ... }`), so size_sol genuinely REACHES strategy.mjs and
 * is genuinely ignored there. That is the shape the behavioural tests above exercise,
 * and it is worth pinning: a future "tidy-up" that strips size_sol at the poller would
 * make those tests pass for the wrong reason. */
t("the event is still spread whole into the planned call, so the ignoring is real",
  /normalizedCall\s*=\s*\{\s*\.\.\.ev/.test(poller), "normalizedCall = { ...ev");

const legacy = codeOf("executor.mjs");
t("the retired webhook adapter does not size from c.size_sol either",
  !/Math\.min\(Number\(c\.size_sol/.test(legacy),
  (legacy.match(/.*c\.size_sol.*/) || ["none"])[0].trim());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
