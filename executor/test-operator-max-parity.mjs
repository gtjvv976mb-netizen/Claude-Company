/* FOUR COPIES OF THE SAME MONEY CEILING, AND THEY DRIFTED.
 *
 * ae6fd1c raised the per-trade operator maximum from 0.05 to 0.1 in poller.mjs and in
 * the dashboard mirror, and missed launchd-runner.mjs and install.sh. The result was a
 * raise that could not be armed: the running process logged "hard maxima 0.1/0.5/0.15"
 * while `arm-caps` — the ONLY supported way to change a cap — parsed the request
 * against 0.05 and refused 0.1 as out of range. Nothing was unsafe; the ceiling simply
 * could not be reached, and the discrepancy was invisible from either side alone.
 *
 * This asserts the four copies agree, by reading the source rather than importing it:
 * poller.mjs and launchd-runner.mjs both fatal() on a bad environment at import time,
 * and install.sh is shell. Source-level is also the right level — the bug was four
 * literals disagreeing, not four behaviours. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");

let pass = 0;
const ok = (name, fn) => { fn(); console.log("  ok  ", name); pass++; };

const num = (src, re, label) => {
  const m = src.match(re);
  assert.ok(m, `could not find ${label} — the parity test must fail loudly, not silently pass`);
  return Number(String(m[1]).replaceAll("_", ""));
};

const poller = read("poller.mjs");
const runner = read("launchd-runner.mjs");
const install = read("install.sh");
const dashboard = fs.readFileSync(path.join(here, "..", "src", "executor-dashboard.js"), "utf8");

const CAPS = [
  {
    label: "per-trade",
    poller: /OPERATOR_MAX = Object\.freeze\(\{\s*maxSolPerTrade:\s*([\d.]+)/,
    runner: /OPERATOR_MONEY_MAX = Object\.freeze\(\{[\s\S]*?MAX_SOL_PER_TRADE:\s*([\d.]+)/,
    install: /^LIVE_OPERATOR_MAX_SOL="([\d.]+)"/m,
    dashboard: /EXECUTOR_OPERATOR_MAXIMA = Object\.freeze\(\{\s*maxSolPerTrade:\s*([\d.]+)/,
  },
  {
    label: "daily deploy",
    poller: /OPERATOR_MAX = Object\.freeze\(\{[^}]*dailySolCap:\s*([\d.]+)/,
    runner: /OPERATOR_MONEY_MAX = Object\.freeze\(\{[\s\S]*?DAILY_SOL_CAP:\s*([\d.]+)/,
    install: /^LIVE_OPERATOR_MAX_DAILY_CAP="([\d.]+)"/m,
    dashboard: /EXECUTOR_OPERATOR_MAXIMA = Object\.freeze\(\{[\s\S]*?rolling24hDeploySol:\s*([\d.]+)/,
  },
  {
    label: "realized-loss brake",
    poller: /OPERATOR_MAX = Object\.freeze\(\{[^}]*dailyLossLimitSol:\s*([\d.]+)/,
    runner: /OPERATOR_MONEY_MAX = Object\.freeze\(\{[\s\S]*?DAILY_LOSS_LIMIT_SOL:\s*([\d.]+)/,
    install: /^LIVE_OPERATOR_MAX_DAILY_LOSS_CAP="([\d.]+)"/m,
    dashboard: /EXECUTOR_OPERATOR_MAXIMA = Object\.freeze\(\{[\s\S]*?rolling24hRealizedLossBrakeSol:\s*([\d.]+)/,
  },
];

for (const c of CAPS) {
  ok(`the ${c.label} operator maximum is the same number in all four places`, () => {
    const values = {
      "poller.mjs OPERATOR_MAX": num(poller, c.poller, `poller ${c.label}`),
      "launchd-runner.mjs OPERATOR_MONEY_MAX": num(runner, c.runner, `runner ${c.label}`),
      "install.sh LIVE_OPERATOR_MAX_*": num(install, c.install, `install ${c.label}`),
      "executor-dashboard.js EXECUTOR_OPERATOR_MAXIMA": num(dashboard, c.dashboard, `dashboard ${c.label}`),
    };
    const distinct = [...new Set(Object.values(values))];
    assert.equal(distinct.length, 1,
      `the ${c.label} ceiling disagrees across copies — a raise armed in one place is ` +
      `refused by another:\n    ` +
      Object.entries(values).map(([k, v]) => `${k} = ${v}`).join("\n    "));
    console.log(`       ${c.label}: ${distinct[0]} SOL in all four`);
  });
}

ok("the readiness rehearsal can be run AT the per-trade ceiling — the sixth copy", () => {
  /* jupiter.mjs EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS bounds the no-sign rehearsal, and
     poller runs that rehearsal at the ACTIVE cap. If this sits below the operator maximum,
     an executor armed at the ceiling refuses its own probe and reports degraded forever —
     measured live on 2026-09-07 the minute the owner armed 0.4 SOL. */
  const jupiter = read("jupiter.mjs");
  const readinessMax = num(jupiter, /EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS\s*=\s*([\d_]+)/, "jupiter readiness max");
  const perTrade = num(poller, CAPS[0].poller, "poller per-trade");
  assert.equal(readinessMax, Math.floor(perTrade * 1_000_000_000),
    `readiness rehearsal ceiling ${readinessMax} lamports != poller per-trade ceiling ${perTrade} SOL — ` +
    "a bot armed at the ceiling would refuse its own readiness probe");
  console.log(`       readiness max: ${readinessMax} lamports = ${perTrade} SOL`);
});

ok("office.js and probe-size.js accept caps by the DECLARED maxima, not by a literal — the seventh copy", () => {
  const office = fs.readFileSync(path.join(here, "..", "src", "office.js"), "utf8");
  const probe = fs.readFileSync(path.join(here, "..", "src", "probe-size.js"), "utf8");
  assert.match(office, /maxSolPerTrade <= M\.maxSolPerTrade/, "office.js must bound the per-trade cap by EXECUTOR_OPERATOR_MAXIMA");
  assert.doesNotMatch(office, /maxSolPerTrade <= 0\.\d+ &&/, "no literal per-trade bound may survive in office.js");
  assert.match(probe, /BOT_CAP_SOL_MAX = EXECUTOR_OPERATOR_MAXIMA\.maxSolPerTrade/);
  const strategy = read("strategy.mjs");
  const sentinel = num(strategy, /maxOpenPositions:\s*(\d+)/, "strategy maxOpenPositions");
  const declared = num(dashboard, /EXECUTOR_OPERATOR_MAXIMA = Object\.freeze\(\{[\s\S]*?maxOpenPositions:\s*(\d+)/, "dashboard maxOpenPositions");
  assert.equal(declared, sentinel, `the desk accepts up to ${declared} open positions but the bot reports ${sentinel}`);
  console.log(`       open-position sentinel: ${sentinel} in both`);
});

ok("arm-caps can actually arm the poller's ceiling — the bug that motivated this test", () => {
  const armable = num(runner, CAPS[0].runner, "runner per-trade");
  const enforced = num(poller, CAPS[0].poller, "poller per-trade");
  assert.ok(armable >= enforced,
    `arm-caps parses against ${armable} but the poller permits ${enforced} — ` +
    "the operator cannot reach the ceiling the executor would honour");
});

console.log(`\n${pass} passed — one money ceiling, four copies, no drift\n`);
