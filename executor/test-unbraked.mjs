/**
 * TRADING UNTIL THE WALLET IS THE STOP (owner, 2026-09-14: "i want it to trade until it
 * losses the funds").
 *
 * The realized-loss brake is the TIGHTER of two numbers, and before this change an
 * operator could reach neither. The absolute figure was frozen at an 0.4 SOL operator
 * ceiling, and the share-of-bankroll figure was a hard-coded strategy default with no
 * environment dial at all. That combination is self-tightening on a losing wallet: as the
 * balance falls the percentage falls with it, so at 0.55 SOL the brake is 0.11 SOL —
 * one stop-out on a 0.5 SOL position — and nothing in any config file could lift it.
 * Measured on the live desk that morning: nine closes, a -0.5167 SOL rolling window, and
 * eighteen hours of refused entries on a wallet that could still fund them.
 *
 * So this pins BOTH halves being liftable, and — the part that matters more — exactly
 * what is still refusing afterwards. "No loss brake" must not quietly mean "no rails":
 * the spendable balance, the per-trade cap, book heat, the position sentinel and the
 * hard stop are all still in force, and this asserts each one against a bot with the
 * brake fully lifted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, planEntry } from "./strategy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const WALLET = 0.55;                       // the live bankroll the day this was asked for
/* Sized to the fixture's own wallet, not to the operator maximum: a seventh of the
   balance per position, so a book of several can actually be filled and the rails that
   are supposed to bind below have room to. */
const cfg = (over = {}) => ({ ...DEFAULTS, fixedSol: 0.08, maxSolPerTrade: 0.08, dailySolCap: 1000,
  networkFeeReserveSol: 0.0005, measuredRoundTripLossPct: 2, ...over });
const state = (over = {}) => ({ openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
  equitySol: WALLET, spendableSol: WALLET, wins: 0, losses: 0, ...over });
const call = (stop = 0.85, conviction = 50) => ({ mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction });

/* The brake as the stock install computes it on this wallet, derived rather than typed so
   a later change to either default cannot make the assertions below vacuous. */
const STOCK_BRAKE = Math.min(Math.abs(DEFAULTS.dailyLossLimitSol), DEFAULTS.dailyLossPctOfEquity * WALLET);
/* A loss far past every stock brake, and past the whole balance's worth of 20% brakes. */
const DEEP_LOSS = -(STOCK_BRAKE * 5);
const LIFTED = { dailyLossPctOfEquity: 0, dailyLossLimitSol: 1000 };

console.log("\n1. THE TWO HALVES, AND WHY LIFTING ONE IS NOT ENOUGH");
{
  ok("the stock brake on this wallet is the PERCENTAGE, not the absolute cap",
    STOCK_BRAKE === DEFAULTS.dailyLossPctOfEquity * WALLET,
    `${STOCK_BRAKE.toFixed(4)} SOL = ${(DEFAULTS.dailyLossPctOfEquity * 100).toFixed(0)}% of ${WALLET}`);
  const stock = planEntry({ call: call(), cfg: cfg(), state: state({ realizedTodaySol: DEEP_LOSS }) });
  ok("…and a loss past it stops the stock bot", stock.action === "skip", stock.reason.slice(0, 76));

  /* THE TRAP THIS CHANGE EXISTS TO CLOSE. Raising only the absolute figure — the one an
     operator could already see in the caps ceremony — changes nothing at all, because the
     percentage is the tighter of the two and it is what is binding. An owner who lifted
     the cap and watched the bot keep refusing had no way to tell why. */
  const absOnly = planEntry({ call: call(), cfg: cfg({ dailyLossLimitSol: 1000 }),
    state: state({ realizedTodaySol: DEEP_LOSS }) });
  ok("lifting ONLY the absolute cap still refuses — the percentage is what binds",
    absOnly.action === "skip", absOnly.reason.slice(0, 76));
  ok("…and the reason says so, naming the bankroll rather than a bare number",
    /% of a .* SOL bankroll/.test(absOnly.reason));

  /* And the mirror: turning the percentage off while the absolute cap is still the stock
     0.4 leaves the cap binding on a big enough loss. Both, or neither. */
  const pctOnly = planEntry({ call: call(), cfg: cfg({ dailyLossPctOfEquity: 0 }),
    state: state({ realizedTodaySol: -(Math.abs(DEFAULTS.dailyLossLimitSol) + 0.01) }) });
  ok("lifting ONLY the percentage still refuses at the absolute cap",
    pctOnly.action === "skip" && /the operator's absolute cap/.test(pctOnly.reason),
    pctOnly.reason.slice(0, 76));

  const lifted = planEntry({ call: call(), cfg: cfg(LIFTED), state: state({ realizedTodaySol: DEEP_LOSS }) });
  ok("with BOTH lifted the same loss trades on", lifted.action === "buy",
    `${DEEP_LOSS.toFixed(4)} SOL down, ${lifted.sol?.toFixed(4)} SOL taken`);
}

console.log("\n2. WHAT STILL REFUSES — 'no loss brake' is not 'no rails'");
{
  /* Each of these is driven against a bot with the brake fully lifted, because the
     question a reader will have in six months is not "can it be turned off" but "what
     was still holding when it was". */
  const c = cfg(LIFTED);
  const deep = { realizedTodaySol: DEEP_LOSS };

  const broke = planEntry({ call: call(), cfg: c, state: state({ ...deep, spendableSol: 0.0006 }) });
  ok("THE WALLET: an empty spendable balance refuses", broke.action === "skip", broke.reason.slice(0, 76));

  /* The per-trade cap is not a refusal, it is a clamp — which is the point. However deep
     the hole, the next position is still the operator's size and never larger. */
  const sized = planEntry({ call: call(), cfg: cfg({ ...LIFTED, fixedSol: 50 }), state: state(deep) });
  ok("THE PER-TRADE CAP: the position is still clamped to maxSolPerTrade",
    sized.action === "buy" && sized.sol <= c.maxSolPerTrade + 1e-9,
    `asked 50 SOL, took ${sized.sol?.toFixed(4)}`);

  const hot = planEntry({ call: call(), cfg: c, state: state({ ...deep, bookHeat: c.bookHeatMax }) });
  ok("BOOK HEAT: a book already at its heat budget refuses", hot.action === "skip", hot.reason.slice(0, 76));

  const full = planEntry({ call: call(), cfg: c, state: state({ ...deep, openCount: c.maxOpenPositions }) });
  ok("THE POSITION SENTINEL: a full book refuses", full.action === "skip", full.reason.slice(0, 76));

  const nostop = planEntry({ call: { ...call(), stop: null }, cfg: c, state: state(deep) });
  ok("THE STOP: a call with no stop is still refused", nostop.action === "skip", nostop.reason.slice(0, 76));

  /* The hard stop is a file the supervisor checks, not a planEntry clause — assert it is
     still consulted rather than asserting a refusal here. */
  const poller = read("poller.mjs");
  ok("THE HARD STOP: the process still halts on its sentinel file",
    /HARD_STOP_FILE/.test(poller) && /hardStop/i.test(poller));
}

console.log("\n3. THE DIAL, END TO END");
{
  const poller = read("poller.mjs");
  const runner = read("launchd-runner.mjs");
  const install = read("install.sh");
  const readme = read("README.md");

  ok("the poller reads DAILY_LOSS_PCT_OF_EQUITY into the config planEntry uses",
    /dailyLossPctOfEquity: number\("DAILY_LOSS_PCT_OF_EQUITY"/.test(poller));
  ok("…bounded 0 to 1", /DAILY_LOSS_PCT_OF_EQUITY[\s\S]{0,160}\{ min: 0, max: 1 \}/.test(poller));
  /* `??` here would turn an empty value into Number("") === 0, silently disarming the
     brake for an operator who only meant to clear the line. `||` keeps an explicit "0"
     (a truthy string) and falls back on an empty one. */
  ok("…with `||` so an explicit 0 survives but an empty value falls back to the default",
    /process\.env\.DAILY_LOSS_PCT_OF_EQUITY \|\| DEFAULTS\.dailyLossPctOfEquity/.test(poller));
  ok("the runner allows the dial through", /"DAILY_LOSS_PCT_OF_EQUITY",/.test(runner));
  /* THE BLOCK, NOT THE LINE — see test-exclude-dexes.mjs. A pin on the carry list's exact
     line break broke twice for changes it did not care about and froze every deploy for
     six hours, because Render runs this suite as its build step. */
  const carryList = install.slice(install.indexOf("for dial in"), install.indexOf('upgrade_env_read "$dial"'));
  ok("an installer upgrade carries it forward", /\bDAILY_LOSS_PCT_OF_EQUITY\b/.test(carryList));
  ok("the README documents it", /DAILY_LOSS_PCT_OF_EQUITY/.test(readme));

  /* ONE COMMAND, NOT THREE (owner, 2026-09-14: "theres too many info, just make the bot
     trade until its funding is gone"). Hand-editing the protected env file between an
     upgrade and a load is where a three-step list loses a step, so the two settings that
     are NOT money caps ride the install line. The absolute cap still does not: an upgrade
     refuses to raise a cap, by design, and that refusal is asserted below. */
  ok("--no-equity-brake is parsed", /--no-equity-brake\) NO_EQUITY_BRAKE=1; shift;;/.test(install));
  ok("…and is off by default", /^NO_EQUITY_BRAKE=0$/m.test(install));
  ok("…and writes the dial as exactly 0", /write_env_line DAILY_LOSS_PCT_OF_EQUITY "0"/.test(install));
  ok("--allow-battery-entries is parsed", /--allow-battery-entries\) ALLOW_BATTERY_ENTRIES=1; shift;;/.test(install));
  ok("…and is off by default", /^ALLOW_BATTERY_ENTRIES=0$/m.test(install));
  ok("…and writes the dial as exactly 1", /write_env_line WALLSTE_ALLOW_BATTERY_ENTRIES "1"/.test(install));
  ok("both flags are documented in --help",
    /--no-equity-brake\s+Set DAILY_LOSS_PCT_OF_EQUITY=0/.test(install) &&
    /--allow-battery-entries\n\s+Set WALLSTE_ALLOW_BATTERY_ENTRIES=1/.test(install));

  /* THE DOUBLE-WRITE THIS GUARDS. Both flag dials are also in the upgrade carry list, so
     without the skip an upgrade emits the flag's line AND the prior value's line for the
     same key, and which one the runtime honours falls to the env parser rather than to
     what the operator just typed. The flag must win. */
  ok("a flag's value is written before the carry loop, and the loop skips it",
    /SET_BY_FLAG="\$SET_BY_FLAG DAILY_LOSS_PCT_OF_EQUITY"/.test(install) &&
    /SET_BY_FLAG="\$SET_BY_FLAG WALLSTE_ALLOW_BATTERY_ENTRIES"/.test(install) &&
    /case " \$SET_BY_FLAG " in \*" \$dial "\*\) continue;; esac/.test(install));
  ok("…and the skip sits INSIDE the carry loop, before the read",
    install.indexOf('case " $SET_BY_FLAG " in') > install.indexOf("for dial in") &&
    install.indexOf('case " $SET_BY_FLAG " in') < install.indexOf('upgrade_env_read "$dial"'));

  /* The absolute cap is a money cap: an upgrade REFUSES to raise one, and that is the
     gate that keeps a remote hand off an operator's money limits. Not softened here. */
  ok("an upgrade still refuses to RAISE the absolute loss cap",
    /upgrade_cap_refuse_raise DAILY_LOSS_LIMIT_SOL --daily-loss-cap/.test(install) &&
    /would RAISE \$key above the \$have this machine already runs/.test(install));
  ok("…and the closing summary says the absolute cap is then the only brake left",
    /Equity brake OFF \(DAILY_LOSS_PCT_OF_EQUITY=0\)/.test(install) &&
    /Raise it with arm-caps/.test(install));

  /* The startup line is the only place an operator learns which half is binding, so it
     must read the CONFIGURED percentage. It read DEFAULTS until this change — harmless
     only while no dial existed, and actively misleading the moment one did. */
  ok("the startup caps line reports the CONFIGURED percentage, not the default",
    /CFG\.dailyLossPctOfEquity \* 100/.test(poller) &&
    !/DEFAULTS\.dailyLossPctOfEquity \* 100/.test(poller));
  ok("…and says plainly when the equity brake is off",
    /DAILY_LOSS_PCT_OF_EQUITY=0 — no equity brake/.test(poller));
  ok("…and says plainly when BOTH halves are lifted and the wallet is the only stop",
    /the wallet's spendable balance is the/.test(poller));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
