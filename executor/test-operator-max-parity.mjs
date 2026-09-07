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
  return Number(m[1]);
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

ok("arm-caps can actually arm the poller's ceiling — the bug that motivated this test", () => {
  const armable = num(runner, CAPS[0].runner, "runner per-trade");
  const enforced = num(poller, CAPS[0].poller, "poller per-trade");
  assert.ok(armable >= enforced,
    `arm-caps parses against ${armable} but the poller permits ${enforced} — ` +
    "the operator cannot reach the ceiling the executor would honour");
});

console.log(`\n${pass} passed — one money ceiling, four copies, no drift\n`);
