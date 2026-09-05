/**
 * THE BAND'S CLOCK.
 *
 * A call is an instruction to buy and to sell. Until 2026-09-03 only the buy carried a
 * number: every position, a $9k coin and a $5m coin alike, sat under one 12-hour age
 * exit. This desk buys low to sell high inside a session, so each market-cap band now
 * carries the window it deserves and the window travels with the call.
 *
 * WHO ACTS ON IT changed on 2026-09-05 (desk-led-v4). The DESK closes the call at the
 * window (test-fast-exit-lane.mjs) and the bot sells what it hears; the bot's own
 * stepPosition HOLDS at the window while the desk is reachable — Shrek, call 55, is what
 * two clocks on one window cost. When the desk is UNREACHABLE the bot mirrors the desk's
 * clock: evaluateMirror sells at the same window with the desk's code, thesis_expired.
 * Every window below is therefore asserted twice — the bot holds, the mirror sells.
 */
import assert from "node:assert/strict";
import { CAP_BANDS, holdWindowFor } from "./src/categories.js";
import { openPosition, stepPosition, DEFAULTS } from "./executor/strategy.mjs";
import { evaluateMirror } from "./executor/desk-mirror.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

/* The position as the bot holds it: ratios off its own fill AND the desk's absolute
 * levels (entry_ref 1, stop 0.5, target 2, opened_at T0). The desk fields are what the
 * mirror evaluates; stepPosition is what the bot runs while the desk is reachable. */
const build = (call, cfg = {}) => openPosition({ call: { mint: "m", symbol: "T", stop: 0.5, target: 2,
  entry_ref: 1, deskStop: 0.5, deskTarget: 2, opened_at: T0,
  openedAtMs: T0, ...call }, sol: 0.05, fillPrice: 1, cfg: { ...DEFAULTS, ...cfg } });
const held = (call, afterMs, cfg = {}) =>
  stepPosition({ pos: build(call, cfg), mark: 1.0, cfg: { ...DEFAULTS, ...cfg }, nowMs: T0 + afterMs });
const mirrored = (call, afterMs, config = null) =>
  evaluateMirror(build(call), { mark: 1.0, now: T0 + afterMs, config });

console.log("\nTHE WINDOW TRAVELS WITH THE CALL — THE BOT HOLDS, THE MIRROR SELLS");
for (const [band, b] of Object.entries(CAP_BANDS)) {
  const call = { hold_band: band, hold_max_ms: b.holdMaxMs };
  const inside = held(call, b.holdMaxMs - MIN);
  const expired = held(call, b.holdMaxMs);
  const mirrorInside = mirrored(call, b.holdMaxMs - MIN);
  const mirrorExpired = mirrored(call, b.holdMaxMs);
  ok(`${band}: the bot holds at ${Math.round((b.holdMaxMs - MIN) / MIN)}m`, inside.action === "hold", inside.reason);
  ok(`${band}: the bot STILL holds at ${Math.round(b.holdMaxMs / MIN)}m while the desk is reachable`,
    expired.action === "hold", `${expired.action} — ${expired.reason}`);
  ok(`${band}: the mirror holds at ${Math.round((b.holdMaxMs - MIN) / MIN)}m`, mirrorInside.action === "hold", mirrorInside.reason);
  ok(`${band}: the mirror sells at ${Math.round(b.holdMaxMs / MIN)}m with the desk's code`,
    mirrorExpired.action === "sell" && mirrorExpired.code === "thesis_expired" &&
      new RegExp(`the ${band} window closed`).test(mirrorExpired.reason),
    `${mirrorExpired.action}/${mirrorExpired.code} — ${mirrorExpired.reason}`);
}

console.log("\nA NANO CALL DOES NOT SIT FOR TWELVE HOURS (ON THE MIRROR'S CLOCK)");
// The exact regression: before the clock, the only age rule was maxAgeHours = 12, so a
// coin the desk expected to resolve in half an hour was still open at lunchtime.
const nano = { hold_band: "nano", hold_max_ms: CAP_BANDS.nano.holdMaxMs };
ok("a nano position is closed 31 minutes in", mirrored(nano, 31 * MIN).action === "sell",
  mirrored(nano, 31 * MIN).reason);
ok("...where the old 12-hour rule alone would still be holding",
  mirrored({}, 31 * MIN).action === "hold", mirrored({}, 31 * MIN).reason);
ok("...and the bot itself holds at 31m: two clocks on one window is the Shrek defect",
  held(nano, 31 * MIN).action === "hold", held(nano, 31 * MIN).reason);

console.log("\nTHE SHORTER OF THE TWO ALWAYS WINS — ON THE MIRROR, WITH THE DESK'S DEFAULTS");
/* The mirror runs POLICY_DEFAULTS — the desk's numbers, not the operator's — because it
 * exists to reproduce the desk's determination. An operator's MAX_AGE_HOURS therefore
 * no longer shortens a hold; the shorter-wins rule is the desk's own, exercised here
 * through the config seam the way src/calls.js exercises it through DESK_MAX_AGE_HOURS. */
const long = { hold_band: "very_high", hold_max_ms: CAP_BANDS.very_high.holdMaxMs };
const deskOneHour = mirrored(long, 61 * MIN, { maxAgeHours: 1 });
ok("the desk's 1-hour age backstop beats a 24-hour band window", deskOneHour.action === "sell", deskOneHour.reason);
ok("...and reports itself as the age exit, not the band", /age exit/.test(deskOneHour.reason) && deskOneHour.code === "thesis_expired",
  `${deskOneHour.code} — ${deskOneHour.reason}`);
ok("a 30-minute band window beats the desk's 24 hours", mirrored(nano, 31 * MIN).action === "sell");
ok("the operator's MAX_AGE_HOURS does not reach the bot's own stepPosition at all",
  held(long, 61 * MIN, { maxAgeHours: 1 }).action === "hold", held(long, 61 * MIN, { maxAgeHours: 1 }).reason);

console.log("\nA CALL WITHOUT A WINDOW FALLS BACK, NEVER FORWARD");
ok("no window means the desk's age backstop still governs on the mirror",
  mirrored({}, 25 * HOUR).action === "sell" && /age exit/.test(mirrored({}, 25 * HOUR).reason), mirrored({}, 25 * HOUR).reason);
ok("a zero window is not a window", mirrored({ hold_max_ms: 0 }, 25 * HOUR).action === "sell");
ok("a nonsense window is ignored", mirrored({ hold_max_ms: "soon" }, 23 * HOUR).action === "hold");
ok("the backstop is never shorter than the longest band",
  DEFAULTS.maxAgeHours * 3600e3 >= CAP_BANDS.very_high.holdMaxMs,
  `${DEFAULTS.maxAgeHours}h backstop vs a ${CAP_BANDS.very_high.holdMaxMs / HOUR}h band`);
ok("an unreadable market cap publishes no window", holdWindowFor(null) === null);

console.log("\nTHE CLOCK RUNS EVEN WHEN THE PRICE DOES NOT");
/* The age check runs before the mark check and that must not change: a position whose
 * mark cannot be read is exactly the one that must not be held indefinitely. */
const noMark = evaluateMirror(build(nano), { mark: null, now: T0 + 31 * MIN });
ok("an unreadable mark does not stop the mirror's clock", noMark.action === "sell" && noMark.code === "thesis_expired", noMark.reason);
const legacy = openPosition({ call: { mint: "m", symbol: "T", stop: 0.5, target: 2, openedAtMs: T0, ...nano },
  sol: 0.05, fillPrice: 1, cfg: DEFAULTS });
const legacyClock = evaluateMirror(legacy, { mark: 1.0, now: T0 + 31 * MIN });
ok("a pre-v4 position with no desk levels still gets the clock (anchored on its own, later, fill time)",
  legacyClock.action === "sell" && legacyClock.code === "thesis_expired" && legacyClock.priceable === false,
  `${legacyClock.action}/${legacyClock.code}, priceable=${legacyClock.priceable}`);

console.log("\nA STOP STILL OUTRANKS NOTHING — THE CLOCK IS AN ADDITION");
const stopped = evaluateMirror(build({ deskStop: 0.9, stop: 0.9, ...nano }), { mark: 0.5, now: T0 + MIN });
ok("a stop inside the window still sells on the stop — on the mirror, with the desk's code",
  stopped.action === "sell" && stopped.code === "stop_hit" && /stop/.test(stopped.reason), `${stopped.code} — ${stopped.reason}`);
const botStopped = stepPosition({ pos: build({ deskStop: 0.9, stop: 0.9, ...nano }), mark: 0.5, cfg: DEFAULTS, nowMs: T0 + MIN });
ok("...while the bot itself holds at the same mark: the desk fires stop_hit, the bot follows",
  botStopped.action === "hold", botStopped.reason);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
