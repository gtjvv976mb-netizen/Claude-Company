/**
 * THE CALL IS ANCHORED ON A PRICE FROM THIS SECOND, NOT FROM THE TOP OF THE WORKUP.
 *
 * THE DEFECT, MEASURED. `entry_lo` and `entry_hi` were NULL on every call the desk has
 * ever written — nothing authored them — so the bot fell back to trade-policy.mjs's
 * +/-10% band around `entry_ref`, and `entry_ref` was gather()'s price, read at the top
 * of a workup that takes ~8.6 minutes. office.js then served that same stale number as
 * `current_mark` (its COALESCE) under a freshly stamped `opened_at`. The 8.20% and
 * 26.04% drift refusals the bot logged were judged against that anchor: the price had
 * not moved 26%, the anchor had aged 26% out of date.
 *
 * WHAT THIS FILE DRIVES, AND WHAT IS STUBBED. The REAL publishCohort, the REAL
 * publishCall with the real mandate and cohort gates, the REAL ds.pairsFor +
 * ds.consensus, the REAL executor/entry-contract.mjs, the real openCall / call_events /
 * shadow book, and the real office.js floor feed. The ONLY stub is `globalThis.fetch`,
 * which serves one DexScreener token read per mint from a fixture market — so the mark
 * really is produced by the desk's own pricing code, not handed to it.
 *
 *   node test-publish-remarks.mjs        (needs a fresh CLAUDE_CO_DB)
 */
import os from "node:os";
import path from "node:path";

/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE: the resets below DELETE FROM calls. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-publish-remarks-" + process.pid + ".db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "";     // no seat is consulted; an escape must fail loudly

/* ═══ THE STUBBED DEXSCREENER READ ════════════════════════════════════════════════
   Keyed on the mint, so a fixture can move the market between gather and publish.
   Everything above it — pairsFor's chain filter and depth sort, consensus's
   liquidity-weighted median — is the desk's own code, unmodified. */
const MARKET = new Map();                 // mint -> priceUsd served by the "live" read
const seen = { tokenReads: [], unrouted: [] };
const dsPair = (mint, priceUsd, liqUsd) => ({
  chainId: "solana", dexId: "pumpswap", pairAddress: `pair-${mint.slice(0, 6)}`,
  baseToken: { address: mint, symbol: "FIX" }, quoteToken: { symbol: "SOL" },
  priceUsd: String(priceUsd), liquidity: { usd: liqUsd }, fdv: 12_000, marketCap: 12_000,
  volume: { h24: 90_000 }, txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1 },
  pairCreatedAt: Date.now() - 9 * 3.6e6,
});
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/\/latest\/dex\/tokens\/([^/?#]+)/);
  if (m) {
    seen.tokenReads.push(m[1]);
    const px = MARKET.get(m[1]);
    const pairs = px == null ? null : [dsPair(m[1], px, 90_000)];
    return { ok: true, status: 200, json: async () => ({ schemaVersion: "1.0.0", pairs }) };
  }
  seen.unrouted.push(u.slice(0, 100));
  return { ok: false, status: 503, json: async () => ({}) };
};

const db = (await import("./src/lib/store.js")).default;
const ph = await import("./src/penthouse.js");
const { publishCohort, freshMark, entryZonePct } = ph;
const { eligibility } = await import("./src/mandate.js");
const { liveCalls, closeCall, beginCyclePass, settleCycles, getCall,
  GATE_CLASS, gateClass } = await import("./src/calls.js");
const { escalationPlan } = await import("./src/config.js");
const { bandForMarketCap } = await import("./src/bands.js");
const { executorFeedPayload } = await import("./src/office.js");
const { HQ_FLOOR } = await import("./src/tower.js");
const { bus } = await import("./src/lib/bus.js");
/* THE BINDER THE BOT SIGNS AGAINST, imported directly rather than described: the row
   this desk serves has to be one THIS function accepts, or the call is undeliverable. */
const { validateEntryReference } = await import("./executor/trade-policy.mjs");
const { ENTRY_GATES } = await import("./executor/entry-contract.mjs");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const events = [];
bus.on("event", (ev) => events.push(ev));
const kinds = (type) => events.filter((e) => e.type === type);

const reset = () => {
  for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
  db.exec("DELETE FROM call_events; DELETE FROM executor_fills; DELETE FROM deliveries; " +
          "DELETE FROM alerts; DELETE FROM calls; DELETE FROM cycles; DELETE FROM shadow; " +
          "DELETE FROM publishability");
  events.length = 0; seen.tokenReads.length = 0;
};

/* ═══ THE FIXTURES ════════════════════════════════════════════════════════════════ */

/* Derived from the ladder, never frozen at a literal — the lesson test-quota-escalation
   learned when the L0 bar moved from 55 to 20 and a fixture at 40 flipped sides. */
const L0 = escalationPlan(0);
const CONVICTION = Math.max(68, L0.minConviction + 5);

const GATHER = 0.001;                     // what gather() saw at the top of the workup
/* A NANO COIN ON PURPOSE. The binder's fallback band is a flat +/-10%, which is also
   the width this desk gives every band above micro — so on a `medium` coin the authored
   zone and the fallback are numerically the same interval and the test could not tell
   them apart. At the bottom of the ladder they differ (nano +/-20%), which is where the
   width is doing work, and it is also where the desk's calls actually are. */
const MCAP = 12_000;
const BAND = bandForMarketCap(MCAP);
const ZONE_PCT = entryZonePct(BAND);      // read from the source, not pinned here
const FALLBACK_PCT = 10;                  // trade-policy.mjs validateEntryReference's default

let seq = 0;
/** A clean, publishable workup. `stop` and `target` are the levers each claim moves. */
const clean = ({ stop = 0.0007, target = 0.0019, mcap = MCAP, ticketZone = null } = {}) => {
  const n = String(++seq).padStart(2, "0");
  const mint = `Rmk${n}${"1".repeat(40)}`.slice(0, 43);
  return {
    mint, symbol: `RMK${n}`,
    outcome: "decided", finalDecision: "APPROVED", weighted: 71,
    pm: { decision: "PROPOSE", conviction: CONVICTION, thesis: "real ignition",
          invalidation: "deployer sells" },
    redteam: { verdict: "wounded", headline: "thin on holders" },
    compliance: { pass: true, violations: [] },
    risk: { position_size_usd: 12, stop_price: stop, max_loss_usd: 4.56 },
    ceo: { ruling: "APPROVE", order_size_usd: 50 },
    order: { size: 50 },
    ticket: { stop_price: stop, take_profit: [{ price: target }],
      entry_zone_low: ticketZone?.[0] ?? GATHER * 0.98,
      entry_zone_high: ticketZone?.[1] ?? GATHER * 1.02 },
    ev: { symbol: `RMK${n}`, pair: { priceUsd: GATHER, marketCap: mcap,
            priceChange: { m5: 2 }, liquidityUsd: 90_000 },
          pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
          mintAccount: { flags: [] } },
  };
};
const pick = (rec) => ({ rec, category: "memecoin", launchpad: "pump.fun",
  conviction: rec.pm?.conviction ?? null });
/** The choosing seat must never be reached: one pick can never be a choice. */
const noSeat = async () => { throw new Error("Best Pick was paid on a field of one"); };

const openCohort = (quota = 3) => {
  settleCycles();
  const c = beginCyclePass({ quota });
  if (c.waiting) throw new Error("a cohort is still holding the gate — reset did not clear it");
  return c;
};
const drive = async (recs) => {
  const cohort = openCohort(3);
  return publishCohort({ picks: recs.map(pick), want: cohort.quota - cohort.published,
    level: cohort.level, cohort, wx: null, bestPickFn: noSeat });
};
const markRows = (callId) => db.prepare(
  "SELECT ts, mark FROM call_events WHERE call_id=? AND mark IS NOT NULL ORDER BY id").all(callId);

console.log("\nVALIDATE THE RULER FIRST — is the stubbed read really what the desk prices off?");
{
  reset();
  const rec = clean();
  const MOVED = GATHER * 0.88;                       // a 12% fall between gather and publish
  MARKET.set(rec.mint, MOVED);
  const m = await freshMark(rec.mint);
  console.log(`     gather=${GATHER}  stubbed live read=${MOVED}  freshMark=${JSON.stringify(m)}`);
  ok("freshMark returns the stubbed consensus price, through the real pairsFor+consensus",
    m?.priceUsd === MOVED, `priceUsd=${m?.priceUsd} vs stub ${MOVED}`);
  ok("...timestamped now", near(m?.at, Date.now(), 2000), `at=${m?.at} now=${Date.now()}`);
  ok("...and it is 12% below gather's price",
    near((m.priceUsd - GATHER) / GATHER * 100, -12, 1e-9),
    `${((m.priceUsd - GATHER) / GATHER * 100).toFixed(2)}%`);
  ok("exactly one DexScreener token read was taken", seen.tokenReads.length === 1,
    `${seen.tokenReads.length} reads, unrouted=${seen.unrouted.length}`);
  ok("the fixture is mandate-eligible and clears the L0 bar",
    eligibility(rec).eligible === true && ph.cohortEligibility(rec, 0).publishable === true,
    `tier=${eligibility(rec).tier} conviction=${CONVICTION} (bar tier>=${L0.minTier} conv>=${L0.minConviction})`);
  ok(`the band under test is ${BAND} at $${MCAP.toLocaleString()}, zone width +/-${ZONE_PCT}%` +
    ` — wider than the binder's flat +/-${FALLBACK_PCT}%, so the two are distinguishable`,
    BAND != null && ZONE_PCT > FALLBACK_PCT, `${BAND} / ${ZONE_PCT}% vs ${FALLBACK_PCT}%`);
}

console.log("\n1. A 12% MOVE BETWEEN GATHER AND PUBLISH — the call is anchored on the fresh mark");
let served = null;
{
  reset();
  const rec = clean();
  const MOVED = GATHER * 0.88;
  MARKET.set(rec.mint, MOVED);
  const r = await drive([rec]);
  const call = getCall(r.opened[0]?.id);
  console.log(`     published call #${call?.id} ${call?.symbol}` +
    `  entry_ref=${call?.entry_ref}  entry_lo=${call?.entry_lo}  entry_hi=${call?.entry_hi}` +
    `  stop=${call?.stop}  target=${call?.target}  band=${call?.hold_band}`);

  ok("the call was published", !!call, `opened=${r.opened.length}`);
  ok("entry_ref is the FRESH mark, not gather's price",
    call.entry_ref === MOVED && call.entry_ref !== GATHER,
    `entry_ref=${call.entry_ref}  mark=${MOVED}  gather=${GATHER}`);
  ok("entry_lo and entry_hi are non-null — the NULLs the bot fell back from are gone",
    call.entry_lo != null && call.entry_hi != null,
    `lo=${call.entry_lo} hi=${call.entry_hi}`);
  ok("...and they bracket the fresh mark",
    call.entry_lo < MOVED && MOVED < call.entry_hi,
    `${call.entry_lo} < ${MOVED} < ${call.entry_hi}`);
  ok(`...at the ${BAND} band's own width, +/-${ZONE_PCT}% (derived from entryZonePct, not pinned)`,
    near(call.entry_lo, MOVED * (1 - ZONE_PCT / 100), 1e-12) &&
    near(call.entry_hi, MOVED * (1 + ZONE_PCT / 100), 1e-12),
    `lo=${call.entry_lo} vs ${MOVED * (1 - ZONE_PCT / 100)}  hi=${call.entry_hi} vs ${MOVED * (1 + ZONE_PCT / 100)}`);

  const marks = markRows(call.id);
  console.log(`     call_events marks: ${JSON.stringify(marks)}`);
  ok("a mark row was written at open", marks.length === 1 && marks[0].mark === MOVED,
    `${marks.length} row(s), mark=${marks[0]?.mark}`);
  ok("...timestamped now, not at gather time", near(marks[0]?.ts, Date.now(), 2000),
    `ts=${marks[0]?.ts} now=${Date.now()}`);

  /* THE FLOOR FEED — office.js's COALESCE is what actually reaches the bot. */
  const feed = executorFeedPayload(HQ_FLOOR, 0);
  served = (feed.events || []).find((e) => e.call_id === call.id && e.kind === "entry")
        ?? (feed.events || [])[0];
  console.log(`     served row: ${JSON.stringify({
    call_id: served?.call_id, kind: served?.kind, symbol: served?.symbol,
    entry_ref: served?.entry_ref, entry_lo: served?.entry_lo, entry_hi: served?.entry_hi,
    stop: served?.stop, target: served?.target, hold_band: served?.hold_band,
    current_mark: served?.current_mark, current_mark_at: served?.current_mark_at,
    opened_at: served?.opened_at, markAgeMs: Date.now() - Number(served?.current_mark_at),
  })}`);
  ok("the floor feed serves an entry row for this call", !!served && served.call_id === call.id,
    `${(feed.events || []).length} feed row(s)`);
  ok("current_mark is the fresh read, not the COALESCE fallback to entry_ref",
    served.current_mark === MOVED, `current_mark=${served.current_mark} mark=${MOVED}`);
  ok("current_mark_at is within 1s of now — a real observation timestamp",
    Math.abs(Date.now() - Number(served.current_mark_at)) <= 1000,
    `${Date.now() - Number(served.current_mark_at)}ms old`);
  ok("...and it comes from the mark row, not from opened_at",
    Number(served.current_mark_at) === marks[0].ts,
    `current_mark_at=${served.current_mark_at} markTs=${marks[0].ts} opened_at=${served.opened_at}`);

  /* THE ROW THE BOT SIGNS AGAINST. */
  let ref = null, refErr = null;
  try { ref = validateEntryReference(served, { nowMs: Date.now() }); }
  catch (e) { refErr = e; }
  console.log(`     validateEntryReference => ${refErr ? `REFUSED: ${refErr.message}` : JSON.stringify(ref)}`);
  ok("executor/trade-policy.mjs validateEntryReference ACCEPTS the served row",
    !refErr && ref?.marketMark === MOVED, refErr ? refErr.message : `mark=${ref?.marketMark}`);
  ok(`...binding to the AUTHORED zone rather than to its flat +/-${FALLBACK_PCT}% fallback`,
    near(ref?.entryLow, call.entry_lo, 1e-12) && near(ref?.entryHigh, call.entry_hi, 1e-12) &&
    !near(ref?.entryLow, call.entry_ref * (1 - FALLBACK_PCT / 100), 1e-12),
    `low=${ref?.entryLow} high=${ref?.entryHigh}; the fallback would have been ` +
    `${call.entry_ref * (1 - FALLBACK_PCT / 100)}-${call.entry_ref * (1 + FALLBACK_PCT / 100)}`);

  /* THE DEFECT ITSELF, REPRODUCED AND THEN FIXED, ON THE SAME BINDER.
     Before this step the row carried entry_ref = gather's price with no zone, so the
     binder built its fallback around a number ~8.6 minutes old — and the SAME fresh
     mark this call was published on falls outside it. That is the 8.20%/26.04% "drift"
     refusal: the price had not moved that far, the anchor had aged. */
  const asItWasBefore = { ...served, entry_ref: GATHER, entry_lo: null, entry_hi: null };
  let beforeErr = null;
  try { validateEntryReference(asItWasBefore, { nowMs: Date.now() }); }
  catch (e) { beforeErr = e; }
  console.log(`     the pre-step row (entry_ref=${GATHER}, no zone) => ` +
    `${beforeErr ? `REFUSED: ${beforeErr.message}` : "accepted"}`);
  ok("the row as it was written BEFORE this step is refused by the same binder, on the " +
    "same mark — the stale anchor was the drift refusal",
    !!beforeErr && /outside authored entry zone/.test(beforeErr.message),
    beforeErr ? beforeErr.message : "accepted, so the anchor was not the problem");
}

console.log("\n1b. THE EXECUTION SEAT'S OWN SKEW SURVIVES THE RE-BASING");
{
  reset();
  /* The seat wrote a lopsided zone: 6% below the price it was shown, 2% above. That is
     a decision ("buy the dip, do not chase"), and re-basing must carry it across. */
  const rec = clean({ ticketZone: [GATHER * 0.94, GATHER * 1.02] });
  const MOVED = GATHER * 0.88;
  MARKET.set(rec.mint, MOVED);
  const r = await drive([rec]);
  const call = getCall(r.opened[0]?.id);
  const downPct = (1 - call.entry_lo / MOVED) * 100, upPct = (call.entry_hi / MOVED - 1) * 100;
  const zone = ph.entryZoneAround(MOVED, BAND, rec.ticket, GATHER);
  console.log(`     ticket zone ${rec.ticket.entry_zone_low}-${rec.ticket.entry_zone_high} ` +
    `around gather ${GATHER} (-6%/+2%)  ->  published ${call.entry_lo}-${call.entry_hi} ` +
    `around mark ${MOVED} (-${downPct.toFixed(2)}%/+${upPct.toFixed(2)}%)`);
  ok("the zone still brackets the mark", call.entry_lo < MOVED && MOVED < call.entry_hi,
    `${call.entry_lo} < ${MOVED} < ${call.entry_hi}`);
  ok(`the wider half is exactly the ${BAND} band width (${ZONE_PCT}%)`,
    near(downPct, ZONE_PCT, 1e-9), `${downPct.toFixed(4)}% vs ${ZONE_PCT}%`);
  ok("...and the narrow half keeps the seat's own 3:1 ratio, not the band's",
    near(downPct / upPct, 3, 1e-9) && upPct < ZONE_PCT,
    `${downPct.toFixed(4)}% / ${upPct.toFixed(4)}% = ${(downPct / upPct).toFixed(4)}`);
  ok("the row matches entryZoneAround's own output — no second copy of the arithmetic",
    near(call.entry_lo, zone.lo, 1e-15) && near(call.entry_hi, zone.hi, 1e-15),
    `row ${call.entry_lo}/${call.entry_hi} vs fn ${zone.lo}/${zone.hi}`);
  /* A ruler check on the branch itself: measured against the zone's OWN midpoint every
     ticket is symmetric, which is why the skew is measured against the authored price. */
  const mid = (rec.ticket.entry_zone_low + rec.ticket.entry_zone_high) / 2;
  ok("a midpoint-relative ruler would have called this lopsided ticket symmetric",
    near((mid - rec.ticket.entry_zone_low) / mid, (rec.ticket.entry_zone_high - mid) / mid, 1e-15),
    `down=${((mid - rec.ticket.entry_zone_low) / mid).toFixed(6)} up=${((rec.ticket.entry_zone_high - mid) / mid).toFixed(6)}`);
  ok("...and a symmetric ticket still produces a symmetric zone",
    (() => { const z = ph.entryZoneAround(MOVED, BAND, { entry_zone_low: GATHER * 0.98,
      entry_zone_high: GATHER * 1.02 }, GATHER);
      return near(z.loPct, ZONE_PCT, 1e-9) && near(z.hiPct, ZONE_PCT, 1e-9); })(),
    `${JSON.stringify(ph.entryZoneAround(MOVED, BAND, { entry_zone_low: GATHER * 0.98, entry_zone_high: GATHER * 1.02 }, GATHER))}`);
}

console.log("\n2. THE MARK IS ALREADY AT THE TARGET — withheld, on the shadow book, not published");
{
  reset();
  const rec = clean({ stop: 0.0007, target: 0.0019 });
  const ABOVE = 0.0021;                     // past the authored first take-profit
  MARKET.set(rec.mint, ABOVE);
  const r = await drive([rec]);
  const withheld = kinds("call:withheld").at(-1);
  const shadowRow = db.prepare("SELECT * FROM shadow WHERE mint=?").get(rec.mint);
  const ledgerRow = db.prepare("SELECT * FROM publishability WHERE mint=?").get(rec.mint);
  console.log(`     mark=${ABOVE} target=${rec.ticket.take_profit[0].price}` +
    `  opened=${r.opened.length}  gate=${withheld?.gate}  reason=${withheld?.reason}`);
  console.log(`     shadow row: ${JSON.stringify(shadowRow && { stage: shadowRow.stage,
    safety: shadowRow.safety, price_at: shadowRow.price_at, reason: shadowRow.reason })}`);
  ok("nothing was published", r.opened.length === 0 && liveCalls().length === 0,
    `opened=${r.opened.length} live=${liveCalls().length}`);
  ok("the refusal carries a real entry-contract gate code",
    ENTRY_GATES.includes(withheld?.gate), `gate=${withheld?.gate}`);
  ok("...and it is mark_at_target — the move already happened", withheld?.gate === "mark_at_target",
    `${withheld?.gate}`);
  ok("it is on the shadow book at the price it was refused at",
    !!shadowRow && shadowRow.stage === "entry_contract" && shadowRow.price_at === ABOVE,
    `stage=${shadowRow?.stage} price_at=${shadowRow?.price_at}`);
  ok("...and NOT as a safety refusal — the coin is unchanged, the entry is gone",
    shadowRow?.safety === 0, `safety=${shadowRow?.safety}`);
  ok("the publishability ledger recorded it under the same gate",
    ledgerRow?.gate === "mark_at_target" && ledgerRow?.outcome === "withheld",
    `gate=${ledgerRow?.gate} outcome=${ledgerRow?.outcome}`);
}

console.log("\n3. THE MARK HAS FALLEN THROUGH THE STOP — withheld, on the shadow book, not published");
{
  reset();
  const rec = clean({ stop: 0.00092, target: 0.0019 });
  const BELOW = 0.00088;                    // under the authored stop, above nothing
  MARKET.set(rec.mint, BELOW);
  const r = await drive([rec]);
  const withheld = kinds("call:withheld").at(-1);
  const shadowRow = db.prepare("SELECT * FROM shadow WHERE mint=?").get(rec.mint);
  console.log(`     mark=${BELOW} stop=${rec.ticket.stop_price} gather=${GATHER}` +
    `  opened=${r.opened.length}  gate=${withheld?.gate}  reason=${withheld?.reason}`);
  ok("nothing was published", r.opened.length === 0 && liveCalls().length === 0,
    `opened=${r.opened.length} live=${liveCalls().length}`);
  ok("the refusal carries a real entry-contract gate code",
    ENTRY_GATES.includes(withheld?.gate), `gate=${withheld?.gate}`);
  ok("...and it names the LIVE fact, mark_breached_stop, not the authored-bracket code",
    withheld?.gate === "mark_breached_stop", `${withheld?.gate}`);
  ok("it is on the shadow book", !!shadowRow && shadowRow.stage === "entry_contract",
    `stage=${shadowRow?.stage} price_at=${shadowRow?.price_at}`);
  ok("the same bracket published fine against gather's price a moment ago — so the DESK " +
    "did not author a broken stop; the price moved",
    rec.ticket.stop_price < GATHER, `stop ${rec.ticket.stop_price} < gather ${GATHER}`);
}

console.log("\n4. NO MARK AVAILABLE — the lane falls back to exactly today's behaviour");
{
  reset();
  const rec = clean();
  MARKET.delete(rec.mint);                  // DexScreener answers with no pairs
  const r = await drive([rec]);
  const call = getCall(r.opened[0]?.id);
  console.log(`     entry_ref=${call?.entry_ref} (gather=${GATHER})  entry_lo=${call?.entry_lo}` +
    `  entry_hi=${call?.entry_hi}  marks=${markRows(call?.id ?? -1).length}`);
  ok("the call is still published — an unreadable price is not a refusal",
    !!call, `opened=${r.opened.length}`);
  ok("entry_ref falls back to gather's price", call.entry_ref === GATHER, `${call.entry_ref}`);
  ok("entry_lo/entry_hi stay null, as they were before this step",
    call.entry_lo == null && call.entry_hi == null, `lo=${call.entry_lo} hi=${call.entry_hi}`);
  ok("and no mark row is invented", markRows(call.id).length === 0,
    `${markRows(call.id).length} mark rows`);
}

console.log("\n5. THE DEFAULT-DENY TRAP — every contract gate the desk can emit is classified BY NAME");
{
  /* src/calls.js gateClass() answers SAFETY for anything it has not heard of. The desk
     now withholds under these codes, so an unregistered one would become an un-waivable
     rug check for a price that merely drifted. */
  const SHARED = ["no_stop", "stop_at_or_above_entry"];   // the desk's own, SAFETY, unchanged
  const fresh = ENTRY_GATES.filter((g) => !SHARED.includes(g));
  const unregistered = fresh.filter((g) => !Object.hasOwn(GATE_CLASS, g));
  const asSafety = fresh.filter((g) => gateClass(g) === "SAFETY");
  console.log(`     fresh contract gates (${fresh.length}): ${fresh.join(", ")}`);
  ok("every fresh contract gate is registered explicitly", unregistered.length === 0,
    unregistered.join(", ") || `all ${fresh.length} present`);
  ok("...and every one of them is JUDGMENT, not a rug check", asSafety.length === 0,
    asSafety.join(", ") || `${fresh.length} JUDGMENT`);
  for (const g of SHARED)
    ok(`${g} keeps the desk's own SAFETY classification`, gateClass(g) === "SAFETY", gateClass(g));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
