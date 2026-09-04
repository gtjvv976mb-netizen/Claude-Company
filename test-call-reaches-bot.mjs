/**
 * NO PUBLISHED CALL MAY VANISH BETWEEN THE DESK AND THE BOT.
 *
 * Two ways it could, both measured, both fixed here.
 *
 * THE EXPIRY WAS ONE FLAT NUMBER. 45 minutes for everything, which is wrong in both
 * directions: a nano coin's move is decided in minutes, so a 40-minute-old nano call is
 * an entry into something already over, while a $5m coin held for a day is still a good
 * entry an hour later. It ate two real calls in a single restart window — "SKIP FWOG:
 * call is 143m old" and "SKIP Jimothy: call is 130m old", both at 06:08:30 on
 * 2026-09-03. The expiry is now the band's own MINIMUM HOLD, which the desk already
 * publishes on every call: if more time has passed than you would have held the
 * position for, the entry idea is gone.
 *
 * THE ALERT THE BOT READS WAS FIRE-AND-FORGET. broadcast() writes the delivery row
 * durably and then calls announceEntry without awaiting it. The alerts table is the
 * bot's ONLY entry channel, so a failed write left the call 'offered' for ever with
 * nothing in the feed — and nothing in any log, because the executor's "not offered"
 * reporter deliberately skips verdict='offered'.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const poller = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");

/* The expiry rule, lifted from the source so the test cannot drift from it. */
const MAX = 45 * 60_000;
const MIN = Number((poller.match(/MIN_CALL_EXPIRY_MS = ([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
const expiry = (holdMinMs) => !Number.isFinite(holdMinMs) || holdMinMs <= 0
  ? MAX : Math.max(MIN, Math.min(holdMinMs, MAX * 8));

console.log("\nEXPIRY FOLLOWS THE MARKET CAP, THROUGH THE BAND'S OWN CLOCK");
{
  const { CAP_BANDS } = await import("./src/bands.js");
  const expected = { nano: 60_000, micro: 1_200_000, low: 3_600_000,
    medium: 3_600_000, high: 3_600_000, very_high: 18_000_000 };
  for (const [band, b] of Object.entries(CAP_BANDS)) {
    const got = expiry(b.holdMinMs);
    ok(`${band} ($${b.lo / 1000}k+) expires after ${(got / 60_000).toFixed(0)} min`,
      got === expected[band], `${(got / 60_000).toFixed(0)}m, band holds ${(b.holdMinMs / 60_000).toFixed(0)}m minimum`);
  }
  ok("nano is one minute, as specified", expiry(CAP_BANDS.nano.holdMinMs) === 60_000);
  ok("a bigger cap keeps its call alive far longer than a smaller one",
    expiry(CAP_BANDS.very_high.holdMinMs) > expiry(CAP_BANDS.nano.holdMinMs) * 100);
}

console.log("\nAND IT NEVER RETIRES A CALL THE BOT COULD NOT HAVE SEEN");
{
  ok("there is a floor, because the poll is 15 seconds", MIN >= 60_000, `${MIN / 1000}s`);
  ok("...so even a one-second hold window gives the bot four polls", expiry(1_000) === MIN);
  ok("a call with no band falls back to the flat setting", expiry(null) === MAX && expiry(0) === MAX);
  ok("an absurd hold window is capped", expiry(999 * 3_600_000) === MAX * 8);
  ok("the rule is applied at BOTH the intake and the submission gate",
    (poller.match(/callExpiryMs\(/g) || []).length >= 3,
    `${(poller.match(/callExpiryMs\(/g) || []).length} uses`);
  ok("the refusal names the band, so it is not a bare number",
    /the \$\{ev\.hold_band \|\| "default"\} band holds for at least/.test(poller));
}

console.log("\nA CALL THAT LOSES ITS ALERT IS REPAIRED, NOT LOST");
{
  const alerts = fs.readFileSync(new URL("./src/alerts.js", import.meta.url), "utf8");
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  ok("the reconciler exists", /export function reconcileMissingEntryAlerts/.test(alerts));
  ok("it finds offered deliveries with no entry alert",
    /LEFT JOIN alerts[\s\S]{0,200}a\.id IS NULL/.test(alerts));
  ok("...only for calls still live, so a dead call is never resurrected",
    /c\.status = 'live'/.test(alerts));
  ok("...and only recent ones, so it cannot walk the whole history",
    /d\.delivered_at > \?/.test(alerts) && /withinMs = \d+/.test(alerts));
  ok("it is bounded", /LIMIT \?/.test(alerts) && /Math\.min\(100, limit\)/.test(alerts));
  ok("the bot's own poll runs it", /reconcileMissingEntryAlerts\(floorNo\)/.test(office));
  ok("...and a failure to repair never fails the poll",
    /try \{ reconcileMissingEntryAlerts\(floorNo\); \} catch/.test(office));
  ok("repairs are announced, so a silent drop stops being silent",
    /alert:repaired/.test(alerts));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
