/**
 * ONE DETERMINATION, TWO EVALUATORS — AND ONE BOT THAT HOLDS.
 *
 * Until desk-led-v4 this file certified two INDEPENDENT engines that agreed on levels:
 * the desk's evaluateExit and the executor's stepPosition. They agreed on levels and
 * disagreed on moments — different rulers (DexScreener consensus vs a chain-simulated
 * Jupiter quote), different anchors (entry_ref vs the fill), different clocks — and that
 * is the Shrek defect (call 55, 2026-09-05: bot out at 03:01:42Z on its own normalised
 * stop, the desk's stop_hit at 03:10:24Z).
 *
 * Now the parity that matters is between the desk's evaluateExit and the bot's MIRROR
 * (evaluateMirror), which runs the same shared pricePolicy on the desk's own absolute
 * levels: identical inputs must yield the identical close code, at every mark. And at
 * every one of those marks the bot's own stepPosition must HOLD, because without a desk
 * exit the bot has no exit.
 */
import db from "./src/lib/store.js";
import { evaluateExit, getCall, openCall } from "./src/calls.js";
import {
  DEFAULTS,
  POLICY_VERSION as EXECUTOR_POLICY_VERSION,
  openPosition,
  stepPosition,
} from "./executor/strategy.mjs";
import { POLICY_VERSION, pricePolicy } from "./executor/trade-policy.mjs";
import { deskCodeForReason, evaluateMirror } from "./executor/desk-mirror.mjs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

const call = openCall({
  mint: "Parity1111111111111111111111111111111111111",
  symbol: "PARITY",
  category: "memecoin",
  entryRef: 1,
  stop: 0.62,
  target: 1.9,
  thesis: "one policy",
  invalidation: "structure fails",
  liqUsd: 100_000,
  rtLossPct: 2,
});
const market = (mark) => ({
  mark,
  liqUsd: 100_000,
  rtLossPct: 2,
  flags: [],
  flagsReadable: true,
});
/* The bot's position for a given desk call: the desk's absolute levels ride on it
 * (deskEntryRef/deskStop/deskTarget/deskOpenedAt) exactly as applyConfirmedEntry stores
 * them from the feed's entry event, beside the bot's own ratios. Both evaluators below
 * read the same object: stepPosition (must hold) and evaluateMirror (must match the desk). */
const positionFor = (c, over = {}) => openPosition({
  call: { mint: c.mint, symbol: c.symbol, stop: c.stop, target: c.target,
    entry_ref: c.entry_ref, deskStop: c.stop, deskTarget: c.target,
    deskOpenedAt: c.opened_at, hold_band: c.hold_band, hold_max_ms: c.hold_max_ms,
    openedAtMs: over.openedAtMs ?? c.opened_at ?? Date.now() },
  sol: 0.02, fillPrice: 1, cfg: DEFAULTS,
});
const executorAt = (c, mark, nowMs = Date.now()) =>
  stepPosition({ pos: positionFor(c), mark, cfg: DEFAULTS, nowMs });
const mirrorAt = (c, mark, nowMs = Date.now()) =>
  evaluateMirror(positionFor(c), { mark, now: nowMs });

/* evaluateMirror carries a two-witness high (mirrorHigh) like the desk's highWaterMark;
 * a fresh position at each mark below matches a fresh call with no mark history. */
const agree = (name, c, mark, wantCode, nowMs = Date.now()) => {
  const server = evaluateExit(c, { ...market(mark), nowMs });
  const mirror = mirrorAt(c, mark, nowMs);
  const bot = executorAt(c, mark, nowMs);
  ok(`${name}: desk evaluateExit and the bot's mirror yield the same code`,
    server.fire === true && server.code === wantCode && mirror.action === "sell" && mirror.code === wantCode,
    `desk ${server.code ?? "hold"} / mirror ${mirror.action}:${mirror.code ?? "-"} (${mirror.reason})`);
  ok(`${name}: the bot's own stepPosition HOLDS at that mark`, bot.action === "hold",
    `${bot.action} — ${bot.reason}`);
};

console.log("\nDESK AND MIRROR IDENTIFY THE SAME PRICE EXITS; THE BOT HOLDS AT EVERY ONE");
agree("stop", call, 0.61, "stop_hit");
agree("authored target", call, 1.9, "target_hit");
agree("2x", call, 2, "take_profit");
{
  const server = evaluateExit(call, market(1.1));
  const mirror = mirrorAt(call, 1.1);
  const bot = executorAt(call, 1.1);
  ok("in-trade: desk holds, mirror holds, bot holds", !server.fire && mirror.action === "hold" && bot.action === "hold",
    `desk fire=${server.fire} / mirror ${mirror.action} / bot ${bot.action}`);
}

console.log("\nTIME EXPIRY USES ONE POLICY ON BOTH SIDES");
const pastBackstop = Date.now() - 25 * 3600e3;
db.prepare("UPDATE calls SET opened_at=? WHERE id=?").run(pastBackstop, call.id);
const agedCall = getCall(call.id);
agree("the age backstop", agedCall, 1.1, "thesis_expired");
{
  const mirror = mirrorAt(agedCall, 1.1);
  ok("...and the mirror names the age exit, as the desk does", /age exit/.test(mirror.reason), mirror.reason);
}

/* THE BAND'S CLOCK MUST ALSO AGREE. A nano call is held for half an hour, and the paper
 * record has to close at the same moment the mirror would — otherwise the desk's
 * published performance describes a trade nobody could have had. */
const nanoOpened = Date.now() - 31 * 60_000;
db.prepare("UPDATE calls SET opened_at=?, hold_band='nano', hold_max_ms=? WHERE id=?")
  .run(nanoOpened, 30 * 60_000, call.id);
const nanoCall = getCall(call.id);
agree("a closed nano window", nanoCall, 1.1, "thesis_expired");
{
  const mirror = mirrorAt(nanoCall, 1.1);
  ok("...and the mirror names the band window, as the desk does", /nano window closed/.test(mirror.reason), mirror.reason);
}

console.log("\nTHE REASON→CODE MAPPING IS THE DESK'S, VERBATIM");
for (const [reason, code] of [
  ["take profit: 2.10x at or above the 2x rule", "take_profit"],
  ["age exit — 25h with no resolution", "thesis_expired"],
  ["the nano window closed after 31m — this desk sells on the clock", "thesis_expired"],
  ["desk target hit", "target_hit"],
  ["stop loss", "stop_hit"],
  ["ratcheted stop", "stop_hit"],
]) ok(`"${reason.slice(0, 32)}" → ${code}`, deskCodeForReason(reason) === code, deskCodeForReason(reason));

console.log("\nTHE POLICY IS VERSIONED ON EVERY SURFACE");
ok("the shared policy is desk-led-v4", POLICY_VERSION === "desk-led-v4", POLICY_VERSION);
ok("strategy re-exports the shared version", EXECUTOR_POLICY_VERSION === POLICY_VERSION,
  `${EXECUTOR_POLICY_VERSION} / ${POLICY_VERSION}`);
ok("new calls retain the policy version", call.policy_version === POLICY_VERSION, call.policy_version);
const pure = pricePolicy({
  position: { entry: 1, stop: 0.62, target: 1.9, high: 1, openedAtMs: Date.now() },
  mark: 2,
});
ok("pure decisions identify their policy version", pure.policyVersion === POLICY_VERSION,
  pure.policyVersion);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
