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
