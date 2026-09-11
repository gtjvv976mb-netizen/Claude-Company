/* THE OWNER'S TWO DIALS: SIZE PER TRADE, AND A TAKE-PROFIT MULTIPLE.
 *
 * The take is the first exit on this lane that fires on GOOD news, and that makes it the
 * first one whose failure mode is a number that reads like profit and is not. This file
 * exists because that exact bug has already shipped here once: a "breakeven" stop armed
 * at 1.0x entry, which realized -18.18% on every position it claimed to protect, because
 * both legs of network fee sit OUTSIDE the mark.
 *
 * So the property under test is never "the branch fired". It is:
 *
 *   A TAKE THAT FIRES IS A TAKE THAT PAYS. At every size, every dial and every mark in
 *   the sweep, a decision whose reason begins "take:" must carry a strictly positive
 *   realized fraction — markX / frictionX - 1 > 0 — and a dial that cannot clear that bar
 *   must refuse at config time and decline (never throw) at tick time.
 *
 * The distinction between refusing and declining is not pedantry. A throw inside the
 * determiner latches laneFaulted in poller.mjs, which disables the lane permanently and
 * would strand an open position with nothing left running to sell it.
 */
import assert from "node:assert/strict";
import {
  SNIPE_DEFAULTS, SNIPE_CANARY_SIZE_SOL, snipePolicy, freshSnipe, frictionX,
  takeRealizedFrac, assertTakeFundable, assertStopFundable, tightestFundableStopFrac,
} from "./snipe-policy.mjs";
import { DEFAULTS as DESK_DEFAULTS } from "./strategy.mjs";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
const FEE = 0.0005;
const pos = (sizeSol, entry = 1) => freshSnipe({ entry, openedAt: 0, sizeSol, feeSolPerLeg: FEE });

console.log("\nTHE DIAL CANNOT BE THE DESK'S DIAL");
ok("the sniper's take is not spelled takeProfitX, which strategy.mjs already owns", () => {
  assert.ok(Object.hasOwn(DESK_DEFAULTS, "takeProfitX"),
    "strategy.mjs no longer owns takeProfitX — re-check whether this guard still means anything");
  assert.ok(!Object.hasOwn(SNIPE_DEFAULTS, "takeProfitX"),
    "the sniper adopted the desk's key name — one dial would move both lanes");
  assert.ok(Object.hasOwn(SNIPE_DEFAULTS, "takeAtEntryX"));
  /* A near-miss is worse than a collision: a collision fails separation clause 6 loudly,
     a near-miss passes it and reads identically to a human scanning two files. */
  const shared = Object.keys(SNIPE_DEFAULTS).filter((k) => Object.hasOwn(DESK_DEFAULTS, k));
  assert.deepEqual(shared, [], `shared keys ${JSON.stringify(shared)}`);
  for (const k of Object.keys(SNIPE_DEFAULTS))
    assert.ok(!/^takeProfit/i.test(k), `${k} is a near-miss spelling of the desk's takeProfitX`);
  console.log(`        sniper "takeAtEntryX" vs desk "takeProfitX" — 0 shared, 0 near-misses`);
});

console.log("\nWHAT THE DIAL IS WORTH CHANGES WITH SIZE, AND THE NUMBER IS PRINTED");
ok("a 2x take pays 99.50% / 96.04% / 63.64% at 0.4 / 0.05 / 0.005 SOL", () => {
  const seen = [];
  for (const sizeSol of [0.4, 0.05, 0.005]) {
    const fx = frictionX({ sizeSol, feeSolPerLeg: FEE });
    const realized = takeRealizedFrac({ takeAtEntryX: 2, frictionX: fx });
    seen.push(`${sizeSol} SOL fx ${fx.toFixed(4)} -> ${(realized * 100).toFixed(2)}%`);
  }
  assert.deepEqual(seen, [
    "0.4 SOL fx 1.0025 -> 99.50%",
    "0.05 SOL fx 1.0202 -> 96.04%",
    "0.005 SOL fx 1.2222 -> 63.64%",
  ]);
  console.log("        " + seen.join(" · "));
});

console.log("\nA TAKE THAT FIRES IS A TAKE THAT PAYS — SWEPT");
ok("across size x dial x mark x clock, every take carries a positive realized return", () => {
  let checked = 0, takes = 0, worst = Infinity;
  for (const sizeSol of [0.005, 0.01, 0.05, 0.1, 0.4]) {
    const fx = frictionX({ sizeSol, feeSolPerLeg: FEE });
    for (const takeAtEntryX of [1.05, 1.25, 1.5, 2, 3, 10]) {
      for (const entry of [0.0001, 1, 12345]) {
        for (const m of [0, 0.5, 0.99, 1, 1.0025, 1.2222, 1.4999, 1.5, 2, 2.0001, 9.99, 10, 1e6]) {
          for (const dt of [0, 1_000, 9 * 60_000]) {
            const d = snipePolicy({
              position: pos(sizeSol, entry), mark: entry * m, nowMs: dt,
              config: { takeAtEntryX },
            });
            checked++;
            if (!d.reason.startsWith("take:")) continue;
            takes++;
            /* The two claims the branch makes, checked against the inputs it was given. */
            assert.ok(m >= takeAtEntryX - 1e-12,
              `take fired at ${m}x on a ${takeAtEntryX}x dial`);
            const realized = takeRealizedFrac({ takeAtEntryX, frictionX: fx });
            assert.ok(realized > 0,
              `take at ${takeAtEntryX}x on a ${sizeSol} SOL fill realizes ${(realized * 100).toFixed(2)}%`);
            worst = Math.min(worst, realized);
            assert.equal(d.action, "sell");
            assert.equal(d.fraction, 1);
          }
        }
      }
    }
  }
  assert.ok(takes > 0, "the sweep produced no takes at all — it is testing nothing");
  console.log(`        ${checked} points swept, ${takes} takes, worst realized ${(worst * 100).toFixed(2)}%`);
});

ok("a take BELOW friction never fires, at any mark, and never throws", () => {
  /* 1.1x against the canary's 1.2222x round trip: an instruction to sell at -10%. */
  let decided = 0;
  for (const m of [1, 1.1, 1.15, 1.2222, 2, 100, 1e9]) {
    const d = snipePolicy({ position: pos(0.005), mark: m, nowMs: 0, config: { takeAtEntryX: 1.1 } });
    decided++;
    assert.ok(!d.reason.startsWith("take:"), `an unfundable take fired at ${m}x`);
  }
  assert.equal(decided, 7);
});

ok("...and the hold SAYS it is disabled, rather than looking like 'not there yet'", () => {
  const d = snipePolicy({ position: pos(0.005), mark: 1.0, nowMs: 0, config: { takeAtEntryX: 1.1 } });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /TAKE DISABLED: 1\.1x is inside this fill's 1\.2222x round trip/);
  console.log(`        ${d.reason}`);
});

ok("a fundable take names itself in the hold reason, so the dial is visible while waiting", () => {
  const d = snipePolicy({ position: pos(0.4), mark: 1.0, nowMs: 0, config: { takeAtEntryX: 2 } });
  assert.equal(d.action, "hold");
  assert.match(d.reason, / — take at 2x$/);
});

console.log("\nTHE TAKE FIRES BEFORE THE TRAIL, BECAUSE THAT IS WHEN IT HAPPENS");
ok("a position passing 2x on the way up takes, rather than waiting to trail down through it", () => {
  /* Walk a position up through the take. The first decision at or above 2x must be the
     take — a trail that followed a higher high down through 2.0 would mean the take was
     never consulted on the way up, which is the ordering bug this pins. */
  let p = pos(0.4), fired = null;
  for (const m of [1.0, 1.2, 1.4, 1.6, 1.8, 1.95, 2.0]) {
    const d = snipePolicy({ position: p, mark: m, nowMs: 1000, config: { takeAtEntryX: 2 } });
    if (d.action === "sell") { fired = { m, reason: d.reason }; break; }
    p = d.position;
  }
  assert.ok(fired, "the position never exited");
  assert.equal(fired.m, 2.0);
  assert.match(fired.reason, /^take: 2x entry reached/);
  console.log(`        exited at ${fired.m}x — ${fired.reason}`);
});

ok("a hostile chain fact still outranks the take — the fact is the reason, not the price", () => {
  const d = snipePolicy({ position: pos(0.4), mark: 5, nowMs: 0, config: { takeAtEntryX: 2 }, rugFlag: true });
  assert.equal(d.action, "sell");
  assert.match(d.reason, /chain fact turned hostile/);
});

console.log("\nTHE CONFIG-TIME REFUSALS");
ok("a take at or below 1x is refused outright", () => {
  for (const t of [0, 0.5, 1, -3, NaN, null, "2x"])
    assert.throws(() => assertTakeFundable({ takeAtEntryX: t, sizeSol: 0.4, feeSolPerLeg: FEE }),
      /finite multiple above 1/, `accepted ${JSON.stringify(t)}`);
});

ok("a take inside friction is refused, and the refusal QUOTES what it would have realized", () => {
  assert.throws(
    () => assertTakeFundable({ takeAtEntryX: 1.1, sizeSol: 0.005, feeSolPerLeg: FEE }),
    (err) => /INSIDE this fill's round-trip cost of 1\.2222x/.test(err.message)
      && /realize -10\.00%/.test(err.message)
      && /sell at a loss on the way up/.test(err.message),
    "the refusal must name the loss, not just say no");
});

ok("the same 1.1x take is ACCEPTED at a size where it is genuinely fundable", () => {
  /* The dial is not wrong in the abstract — it is wrong against a fill. At 0.4 SOL the
     round trip is 1.0025x, so 1.1x pays 9.73%. Refusing it at every size would be a rule
     about the number rather than about the economics. */
  const e = assertTakeFundable({ takeAtEntryX: 1.1, sizeSol: 0.4, feeSolPerLeg: FEE });
  assert.ok(e.realizedFrac > 0);
  console.log(`        1.1x at 0.4 SOL realizes ${(e.realizedFrac * 100).toFixed(2)}%`);
});

console.log("\nTHE STOP MUST MOVE WHEN THE SIZE MOVES");
ok("the LIVE configuration passes its own fundability check", () => {
  /* The regression this pins, found by running it: tightestFundableStopFrac at the canary
     computes 1 - 0.8 = 0.19999999999999996 in binary floating point, so a bare `>` refused
     SNIPE_DEFAULTS.stopFrac 0.20 at the very size it was derived for. */
  const e = assertStopFundable({ stopFrac: SNIPE_DEFAULTS.stopFrac, sizeSol: SNIPE_CANARY_SIZE_SOL });
  assert.equal(e.stopFrac, 0.20);
  console.log(`        stop 0.20 at ${SNIPE_CANARY_SIZE_SOL} SOL · tightest fundable ${e.tightestFundableStopFrac}`);
});

ok("a stop tighter than the fee rail can fund is still refused", () => {
  assert.throws(() => assertStopFundable({ stopFrac: 0.21, sizeSol: 0.005 }), /TIGHTER than/);
  assert.throws(() => assertStopFundable({ stopFrac: 0.995, sizeSol: 0.4, explicit: true }), /TIGHTER than/);
});

ok("carrying the frozen 0.20 stop to a RAISED size is refused until it is stated explicitly", () => {
  /* 0.20 is not a risk appetite, it is the tightest stop a 0.005 ticket can carry. At
     0.4 SOL the tightest fundable is 0.99, so 0.20 there is an 80% drawdown on a position
     eighty times larger — a default outliving the arithmetic that produced it. */
  assert.throws(
    () => assertStopFundable({ stopFrac: 0.20, sizeSol: 0.4 }),
    (err) => /derived for a 0\.005 SOL ticket/.test(err.message)
      && /80% drawdown before it speaks/.test(err.message)
      && /tightest fundable here is 0\.9900x/.test(err.message));
  /* Stated explicitly, the owner's number stands — the guard makes them look, not choose. */
  const e = assertStopFundable({ stopFrac: 0.20, sizeSol: 0.4, explicit: true });
  assert.equal(e.stopFrac, 0.20);
});

ok("every size at or below the canary keeps the default silently", () => {
  for (const sizeSol of [0.0001, 0.001, 0.005]) {
    const tightest = tightestFundableStopFrac({ sizeSol });
    if (SNIPE_DEFAULTS.stopFrac > tightest + 1e-9) continue;   // unfundable at that size, refused elsewhere
    assert.doesNotThrow(() => assertStopFundable({ stopFrac: SNIPE_DEFAULTS.stopFrac, sizeSol }));
  }
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
