/**
 * THE THREE DIALS A TENANT OWNS.
 *
 * Everything else in copy.js decides WHICH calls reach a floor. These decide what the
 * floor does with one, and each has an explicit AUTO mode where the desk decides
 * instead — because the honest default for someone who has never watched this run is
 * not a number they had to invent, it is "let the team choose and show me what it
 * chose". A tenant who sets nothing must get exactly the desk's own behaviour.
 *
 *   take_profit_x   0 = auto (the desk's authored target), else a hard multiple
 *   fixed_sol       0 = auto (bankroll x category x conviction), else the same size
 *   mcap_tier       micro / low / mid / any
 */
import db from "./src/lib/store.js";
import { settingsFor, saveSettings, decide, MCAP_TIERS } from "./src/copy.js";
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const F = 7;
/* A tenant floor seeds 'balanced', whose own note reads "Everything but pure
 * memecoins" — so on a memecoin desk a new floor refuses the house's entire output
 * until its owner changes appetite. Worth knowing, and worth setting here explicitly:
 * without it every assertion below passes or fails on the CATEGORY gate rather than
 * on the dial under test, which is how a green suite ends up proving nothing. */
saveSettings(F, { appetite: "aggressive" });
const call = (over = {}) => ({ mint: "m", symbol: "T", category: "memecoin", launchpad: "pump.fun",
  conviction: 70, liq_at_call: 60_000, mcap_at_call: 900_000, ...over });

console.log("\nDEFAULTS — a tenant who sets nothing gets AUTO on all three");
settingsFor(F);
let s = settingsFor(F);
ok("take profit is auto", Number(s.take_profit_x) === 0, `take_profit_x=${s.take_profit_x}`);
ok("size is auto", Number(s.fixed_sol) === 0, `fixed_sol=${s.fixed_sol}`);
ok("every sleeve", s.mcap_tier === "any", s.mcap_tier);
const autoOffer = decide(F, call());
ok("auto sizing scales with conviction", autoOffer.verdict === "offered" && !/fixed/.test(autoOffer.reason),
  autoOffer.reason);

console.log("\nDIAL 1 — TAKE PROFIT, chosen by the tenant");
saveSettings(F, { takeProfitX: 10 });
ok("10x is stored", Number(settingsFor(F).take_profit_x) === 10);
saveSettings(F, { takeProfitX: 0.5 });
ok("a take profit BELOW entry is clamped, never stored", Number(settingsFor(F).take_profit_x) >= 1.05,
  `${settingsFor(F).take_profit_x}x — 0.5x would be an instruction to sell at a 50% loss`);
saveSettings(F, { takeProfitX: "auto" });
ok("auto is expressible", Number(settingsFor(F).take_profit_x) === 0);

console.log("\n...and it reaches the bot, per position");
const c2 = { mint: "m", symbol: "T", entry_ref: 1, stop: 0.6, target: 2.0, size_sol: 5 };
const st = { ...freshState(0), equitySol: 5 };
for (const [x, mark, want] of [[2, 2.0, "sell"], [10, 2.0, "hold"], [10, 10.0, "sell"]]) {
  const cfg = { ...DEFAULTS, takeProfitX: x, fixedSol: 0 };
  const p = openPosition({ call: c2, sol: 0.05, fillPrice: 1, cfg });
  const d = stepPosition({ pos: p, mark, cfg });
  ok(`at ${x}x rule, a ${mark}x mark => ${want}`, d.action === want, d.reason);
}

console.log("\nDIAL 2 — FIXED FUND, chosen by the tenant");
saveSettings(F, { fixedSol: 0.05 });
const fixedOffer = decide(F, call());
ok("every trade is the same size", fixedOffer.sizeSol === 0.05, `${fixedOffer.sizeSol} SOL — ${fixedOffer.reason}`);
const fixedOffer2 = decide(F, call({ conviction: 42 }));
ok("...regardless of conviction", fixedOffer2.sizeSol === 0.05, `conviction 42 -> ${fixedOffer2.sizeSol} SOL`);
saveSettings(F, { fixedSol: 900 });
ok("a fixed fund larger than the bankroll is clamped", Number(settingsFor(F).fixed_sol) <= Number(settingsFor(F).bankroll_sol),
  `${settingsFor(F).fixed_sol} SOL vs a ${settingsFor(F).bankroll_sol} SOL bankroll`);
saveSettings(F, { fixedSol: "auto" });
ok("auto is expressible", Number(settingsFor(F).fixed_sol) === 0);
// The dial governs how MUCH, never WHETHER.
const pf = planEntry({ call: c2, cfg: { ...DEFAULTS, fixedSol: 0.02 }, state: { ...st, wins: 3, losses: 29 } });
ok("a fixed fund does NOT override a refusal", pf.action === "skip", pf.reason);

console.log("\nDIAL 3 — THE MARKET-CAP SLEEVE");
saveSettings(F, { mcapTier: "micro" });
ok("a $900k call is outside the micro sleeve",
  decide(F, call({ mcap_at_call: 900_000 })).verdict === "skipped",
  decide(F, call({ mcap_at_call: 900_000 })).reason);
ok("a $200k call is inside it", decide(F, call({ mcap_at_call: 200_000 })).verdict === "offered");
saveSettings(F, { mcapTier: "low" });
ok("the low sleeve takes the $900k call", decide(F, call({ mcap_at_call: 900_000 })).verdict === "offered");
ok("...and refuses a $20m one", decide(F, call({ mcap_at_call: 20_000_000 })).verdict === "skipped");
saveSettings(F, { mcapTier: "any" });
ok("any takes both", decide(F, call({ mcap_at_call: 200_000 })).verdict === "offered"
  && decide(F, call({ mcap_at_call: 20_000_000 })).verdict === "offered");
// The same rule the screen follows: an unreadable number must not become an execution,
// and must not silently qualify either.
saveSettings(F, { mcapTier: "micro" });
ok("an UNKNOWN market cap is not filtered out on a guess",
  decide(F, call({ mcap_at_call: null })).verdict === "offered", "null cap passes the sleeve");
ok("a bogus tier name falls back to a real one", (saveSettings(F, { mcapTier: "moon" }), !!MCAP_TIERS[settingsFor(F).mcap_tier]),
  settingsFor(F).mcap_tier);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
