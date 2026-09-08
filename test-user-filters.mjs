/**
 * WHAT A TENANT OWNS, AND WHAT THE TEAM OWNS.
 *
 * The tenant owns two numbers: the money in their bot, and the SOL that goes into each
 * trade. The trading team owns everything else, including which coins are worth trading
 * at all (owner, 2026-09-03).
 *
 * There used to be a wall of per-floor filters — launchpad, category, liquidity floor,
 * market-cap sleeve, conviction bar — and every one of them was a way to receive
 * nothing. The house floor's own bot sat armed for twelve hours on 2026-09-02 while
 * each call it was sent died on one. A customer assembling a filter policy before their
 * bot works has been handed the desk's job.
 *
 *   bankroll_sol    the money the bot is allowed to trade
 *   fixed_sol       0 = auto (bankroll x category x conviction), else the same size
 *   take_profit_x   0 = auto (the desk's authored target), else a hard multiple
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
/* NOTE ON WHAT "size is auto" MEANS SINCE 2026-09-07. The setting is stored and shown on
   the tenant's board, and their own bot reads its own FIXED_SOL from its own environment.
   The DESK derives nothing from it: decide() publishes no size at all. So this row is a
   preference on a screen, not a dial the desk turns. */
ok("no sleeve filter stands between the team and the bot", decide(F, call({ mcap_at_call: 9_000 })).verdict === "offered");
const autoOffer = decide(F, call());
ok("the call is offered, and the desk sizes none of it",
  autoOffer.verdict === "offered" && autoOffer.sizeSol === null && autoOffer.sizeBinding === false,
  autoOffer.reason);

console.log("\nDIAL 1 — TAKE PROFIT, chosen by the tenant");
saveSettings(F, { takeProfitX: 10 });
ok("10x is stored", Number(settingsFor(F).take_profit_x) === 10);
saveSettings(F, { takeProfitX: 0.5 });
ok("a take profit BELOW entry is clamped, never stored", Number(settingsFor(F).take_profit_x) >= 1.05,
  `${settingsFor(F).take_profit_x}x — 0.5x would be an instruction to sell at a 50% loss`);
saveSettings(F, { takeProfitX: "auto" });
ok("auto is expressible", Number(settingsFor(F).take_profit_x) === 0);

console.log("\n...and it reaches the bot, per position — where, since desk-led-v4, it changes NOTHING");
/* The dial is still stored and still travels on every feed event (a tenant may have set
 * it, the column is read elsewhere), but the bot has no exit of its own for it to
 * govern: the DESK determines every exit and the bot sells what it hears. A tenant
 * multiple that made the bot hold through the desk's determined target — or sell at a
 * level the desk never called — is a bot-own exit rule, the category Shrek (call 55,
 * 2026-09-05) retired. So at 2x, 10x and under either dial the bot HOLDS. */
const c2 = { mint: "m", symbol: "T", entry_ref: 1, stop: 0.6, target: 2, size_sol: 5 };
const st = { ...freshState(0), equitySol: 5 };
for (const [x, mark] of [[2, 2.0], [10, 2.0], [10, 10.0]]) {
  const cfg = { ...DEFAULTS, takeProfitX: x, honorDeskTarget: false, fixedSol: 0, scaleOutPct: 0 };
  const p = openPosition({ call: c2, sol: 0.05, fillPrice: 1, cfg });
  const d = stepPosition({ pos: p, mark, cfg });
  ok(`at ${x}x rule, a ${mark}x mark => hold (the dial no longer sells)`, d.action === "hold", `${d.action} — ${d.reason}`);
}

console.log("\nDIAL 2 — FIXED FUND: THE TENANT'S DIAL, ON THE TENANT'S MACHINE");
/* This asserted that a stored fixedSol of 0.05 came back on every delivery ("every trade
   is the same size", "regardless of conviction"). The setting still does exactly that —
   on the bot, from the bot's own FIXED_SOL (executor/strategy.mjs:106, :245) — but the
   DESK stopped echoing it on 2026-09-07: reading a tenant's own number and re-issuing it
   as a delivered size made the desk look like the author of it, and any party that can
   set the number is choosing how much is bought. So the storage and clamping of the dial
   are asserted here, and the fact that it never appears on a delivery. */
saveSettings(F, { fixedSol: 0.05 });
ok("the dial is stored", Number(settingsFor(F).fixed_sol) === 0.05, `fixed_sol=${settingsFor(F).fixed_sol}`);
const fixedOffer = decide(F, call());
const fixedOffer2 = decide(F, call({ conviction: 42 }));
ok("...and the desk's delivery still carries no size",
  fixedOffer.sizeSol === null && fixedOffer2.sizeSol === null,
  `${fixedOffer.sizeSol} / ${fixedOffer2.sizeSol} — ${fixedOffer.reason}`);
/* THE DIAL STILL WORKS WHERE IT IS SUPPOSED TO. Same number, same call, on the bot. */
const fixedPlan = planEntry({ call: c2, cfg: { ...DEFAULTS, fixedSol: 0.05, maxSolPerTrade: 0.05 },
  state: { ...st, equitySol: 2, spendableSol: 2 } });
ok("...while the BOT sizes to it from its own config",
  fixedPlan.action === "buy" && fixedPlan.sol <= 0.05 && /operator ceiling 0\.05 SOL/.test(fixedPlan.reason),
  `${fixedPlan.sol} SOL — ${fixedPlan.reason}`);
saveSettings(F, { fixedSol: 900 });
ok("a fixed fund larger than the bankroll is clamped", Number(settingsFor(F).fixed_sol) <= Number(settingsFor(F).bankroll_sol),
  `${settingsFor(F).fixed_sol} SOL vs a ${settingsFor(F).bankroll_sol} SOL bankroll`);
saveSettings(F, { fixedSol: "auto" });
ok("auto is expressible", Number(settingsFor(F).fixed_sol) === 0);
/* THE DIAL GOVERNS HOW MUCH, NEVER WHETHER — re-anchored 2026-09-08. This made the claim
   through the W_min hit-rate gate, and that gate is now deliberately scoped to the AUTO
   path: with a fixed fund the engine overwrites `want` with it, so the branch could only
   ever veto a trade, never size one. The claim itself is unchanged and is made against a
   refusal that holds whatever the sample says — a bracket whose costs eat the target —
   plus the hit-rate gate where it still binds, on auto. Both halves, and the scope of the
   change, are proved in executor/test-kelly-fixed-size.mjs. */
const evDead = { ...c2, target: 1 + DEFAULTS.costPct / 2 };
const pf = planEntry({ call: evDead, cfg: { ...DEFAULTS, fixedSol: 0.02 }, state: { ...st, wins: 3, losses: 29 } });
ok("a fixed fund does NOT override a refusal", pf.action === "skip", pf.reason);
const pfAuto = planEntry({ call: c2, cfg: { ...DEFAULTS, fixedSol: 0 }, state: { ...st, wins: 3, losses: 29 } });
ok("...and on auto the hit-rate gate still refuses", pfAuto.action === "skip" && /hit rate/.test(pfAuto.reason),
  pfAuto.reason);

console.log("\nTHE TEAM DECIDES WHAT IS TRADED — no tenant filter can block a call");
/* Each of these was, until 2026-09-03, a per-floor gate that could silently refuse a
 * call the trading team had already researched, sized and published. They are stored
 * settings still (tenants may have set them, and the columns are read elsewhere), but
 * they no longer decide delivery. The assertion is deliberately blunt: with every one
 * of them set to its most exclusive value, the call still arrives. */
saveSettings(F, { mcapTier: "micro", categories: ["established"], launchpads: ["bags.fm"], minLiqUsd: 5_000_000 });
for (const [what, over] of [
  ["a cap far outside the stored sleeve", { mcap_at_call: 900_000 }],
  ["a nano-cap coin",                     { mcap_at_call: 9_000 }],
  ["a category the floor did not list",   { category: "memecoin" }],
  ["a launchpad the floor did not list",  { launchpad: "pump.fun" }],
  ["liquidity under the stored floor",    { liq_at_call: 12_000 }],
  ["conviction under the old bar",        { conviction: 12 }],
  ["an unreadable market cap",            { mcap_at_call: null }],
]) ok(what + " is still delivered", decide(F, call(over)).verdict === "offered", decide(F, call(over)).reason);
saveSettings(F, { mcapTier: "any", categories: null, launchpads: null, minLiqUsd: 0 });
// The brakes that remain are the ones that are not preferences: money, and fees.
ok("a bogus tier name still falls back to a real one",
  (saveSettings(F, { mcapTier: "moon" }), !!MCAP_TIERS[settingsFor(F).mcap_tier]), settingsFor(F).mcap_tier);
saveSettings(F, { mcapTier: "any" });


/* ── THE SLEEVES MUST TILE WHAT THE DESK ACTUALLY PRODUCES ───────────────────
 * They were hardcoded while the desk's ceiling moved to $3m underneath them, which
 * left `mid` covering $3m-$30m — a band no call could ever land in. A tenant who
 * chose it would have waited forever for an arithmetically impossible delivery, with
 * nothing anywhere explaining why. A filter that cannot match anything is worse than
 * a missing filter, because it looks like it is working. */
{
  const { cfg } = await import("./src/config.js");
  const ceiling = cfg.screen.maxMarketCapUsd;
  console.log(`\nSLEEVES vs THE DESK CEILING ($${ceiling.toLocaleString()})`);
  const dead = Object.entries(MCAP_TIERS).filter(([k, v]) => k !== "any" && v.lo >= ceiling);
  ok("no sleeve sits entirely above the ceiling", dead.length === 0,
    dead.length ? dead.map(([k]) => k).join(", ") + " can never receive a call" : "every sleeve is reachable");
  const bands = ["nano", "micro", "low", "medium", "high", "very_high"];
  ok("the sleeves tile the board with no gap",
    bands.slice(0, -1).every((b, i) => MCAP_TIERS[b].hi === MCAP_TIERS[bands[i + 1]].lo),
    bands.join(" -> "));
  /* RE-ANCHORED 2026-09-07, and the shape of the assertion changed with it.
   *
   * This read `MCAP_TIERS.very_high.hi === ceiling`: the sleeve top and the screen
   * ceiling were one number ($10m), and the equality was the proof that they were one
   * taxonomy. The owner's widening moved the SCREEN ceiling to $50m so that far more
   * coins reach a workup at all, and deliberately left the sleeves where they are. The
   * equality is dead — and an equality was the wrong instrument anyway, because it
   * broke the instant either number moved while the property it exists to protect was
   * still intact.
   *
   * THE PROPERTY, restated so the next recalibration does not break it: THE BOARD MUST
   * SIT INSIDE THE SCREEN WINDOW. A sleeve reaching past either end of what the screen
   * admits is a sleeve that can never receive a call — the 2026-09-03 `mid` bug, which
   * covered $3m-$30m under a $3m ceiling and left a tenant waiting forever for an
   * arithmetically impossible delivery. Both ends are checked, both derived from the
   * live config, and the DIRECTION is the whole assertion: the board may be narrower
   * than the screen, never wider. */
  ok("no sleeve reaches above what the screen admits", MCAP_TIERS.very_high.hi <= ceiling,
    `very_high tops out at $${Math.round(MCAP_TIERS.very_high.hi).toLocaleString()} under a $${ceiling.toLocaleString()} ceiling`);
  ok("no sleeve reaches below what the screen admits", MCAP_TIERS.nano.lo >= cfg.screen.minMarketCapUsd,
    `nano starts at $${Math.round(MCAP_TIERS.nano.lo).toLocaleString()} over a $${cfg.screen.minMarketCapUsd.toLocaleString()} floor`);

  /* THE OTHER HALF THE EQUALITY USED TO CARRY, now that the two ends have come apart:
   * nothing outside the board can become a call. That used to be arithmetic — the
   * screen stopped exactly where the sleeves stopped, so the question never arose. The
   * screen is wider than the board at both ends now, so it has to be proven where it
   * actually holds: cellOf() refuses an off-board cap a cell, and buildBoard drops a
   * coin with no cell BEFORE `viable` is consulted (categories.js:98). So a $20m coin
   * clears the $50m ceiling and still cannot be shortlisted, and no published call can
   * land in no sleeve. Probes are derived from the two boundaries, so they follow them. */
  const { cellOf } = await import("./src/categories.js");
  const offBoard = [MCAP_TIERS.very_high.hi, (MCAP_TIERS.very_high.hi + ceiling) / 2,
                    MCAP_TIERS.nano.lo - 1, cfg.screen.minMarketCapUsd]
    .filter((m) => m > 0 && (m >= MCAP_TIERS.very_high.hi || m < MCAP_TIERS.nano.lo));
  ok("a cap the screen admits but no sleeve covers can never be shortlisted",
    offBoard.length >= 2 && offBoard.every((m) => cellOf({ pair: { marketCap: m } }) === null),
    offBoard.map((m) => `$${Math.round(m).toLocaleString()}`).join(", ") + " -> no cell");

  /* A call anywhere on the board must fall in exactly one sleeve — one probe per
   * sleeve, taken from the sleeve's OWN midpoint. The five literals that stood here
   * were each a boundary waiting to rot, and between them they never once landed in
   * `low`; midpoints cover all six and move when the bands do. */
  for (const [band, b] of Object.entries(MCAP_TIERS)) {
    if (band === "any") continue;
    const mcap = Math.round((b.lo + b.hi) / 2);
    const hits = Object.entries(MCAP_TIERS)
      .filter(([k, v]) => k !== "any" && mcap >= v.lo && mcap < v.hi).map(([k]) => k);
    ok(`a $${mcap.toLocaleString()} call lands in exactly one sleeve (${band})`,
      hits.length === 1 && hits[0] === band, hits.join(",") || "NONE");
  }
}


/* THE HOLD WINDOWS. These are the owner's numbers, band by band, and a call carries its
 * band's window to the executor — so a silent edit here would quietly turn a
 * thirty-minute nano trade into an overnight hold. */
{
  const { CAP_BANDS, holdWindowFor } = await import("./src/categories.js");
  const MIN = 60_000, HOUR = 60 * MIN;
  const want = {
    nano:      [1 * MIN,   30 * MIN],
    micro:     [20 * MIN,  1 * HOUR],
    low:       [1 * HOUR,  5 * HOUR],
    medium:    [1 * HOUR,  5 * HOUR],
    high:      [1 * HOUR,  5 * HOUR],
    very_high: [5 * HOUR, 24 * HOUR],
  };
  console.log("\nHOLD WINDOWS");
  for (const [band, [lo, hi]] of Object.entries(want))
    ok(`${band} is held ${lo / MIN}-${hi / MIN} minutes`,
      CAP_BANDS[band].holdMinMs === lo && CAP_BANDS[band].holdMaxMs === hi,
      `${CAP_BANDS[band].holdMinMs / MIN}-${CAP_BANDS[band].holdMaxMs / MIN} min`);
  ok("a $9k cap resolves to the nano window", holdWindowFor(9_000)?.holdMaxMs === 30 * MIN);
  ok("a $5m cap resolves to the very-high window", holdWindowFor(5_000_000)?.holdMaxMs === 24 * HOUR);
  ok("an unreadable cap has no window", holdWindowFor(null) === null && holdWindowFor(0) === null);
  ok("a cap off the board has no window", holdWindowFor(50_000_000) === null);
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
