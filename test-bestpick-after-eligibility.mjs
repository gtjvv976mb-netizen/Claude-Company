/**
 * BEST PICK IS PAID AFTER THE QUOTA BAR, NOT BEFORE IT.
 *
 * The choosing seat is an Opus call — $0.087-0.10 a time, and the live 24h bought one
 * at $0.10 — and until this step it was handed the whole mandate-eligible field, while
 * the quota bar inside publishCall then refused part of that same field on arrival:
 * call:withheld conviction_below_bar 7 and tier_below_bar 5 in the window. The seat was
 * ranking coins it could not publish, and it was also asked to rank fields it could not
 * change: with `want` or fewer publishable, the fallback walk publishes every one of
 * them whichever the seat preferred.
 *
 * THIS FILE DRIVES THE REAL STEP — publishCohort with the real cohortEligibility, the
 * real publishCall and a real open cycle — replacing only the seat with a spy that
 * records exactly the field it was handed. It proves three things and prints each:
 *
 *   1. a field that fits the quota never reaches the seat, and every publishable
 *      candidate in it is published anyway;
 *   2. a field that exceeds the quota reaches the seat ONCE, as exactly the publishable
 *      subset, in order — never the two the bar would refuse;
 *   3. the mirror property that keeps the two gates from drifting: with no cohort,
 *      publishCall applies no bar, so the seat's field is not narrowed either.
 *
 *   node test-bestpick-after-eligibility.mjs
 */

/* A DIRECT RUN MUST NOT OPEN THE REAL DATABASE — the same guard test-cohort-cycles.mjs
   carries, for the same reason: the resets below DELETE FROM calls and cycles. The
   runner's value still wins; this only covers the unguarded direct run. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-bestpick-after-eligibility-" + process.pid + ".db");
process.env.EXECUTE = "0";
// The seat is always a spy below; an empty key makes any escape to the real seat fail
// loudly rather than spend.
process.env.ANTHROPIC_API_KEY = "";

const db = (await import("./src/lib/store.js")).default;
const { publishCohort, cohortEligibility } = await import("./src/penthouse.js");
const { eligibility } = await import("./src/mandate.js");
const { liveCalls, closeCall, beginCyclePass, settleCycles } = await import("./src/calls.js");
const { escalationPlan } = await import("./src/config.js");
const { bus } = await import("./src/lib/bus.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const reset = () => {
  for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
  // call_events references calls, so it goes first or the FK refuses the delete.
  db.exec("DELETE FROM call_events; DELETE FROM executor_fills; DELETE FROM deliveries; DELETE FROM calls; DELETE FROM cycles");
};
const events = [];
bus.on("event", (ev) => events.push(ev));
const kinds = (type) => events.filter((e) => e.type === type);

/* DERIVED FROM THE LADDER, NEVER FROZEN AT A LITERAL — the lesson test-quota-escalation
   learned when the owner cut the L0 bar from 55 to 20 and a fixture at 40 flipped sides.
   One conviction comfortably clear of the L0 bar, one just under it. */
const L0 = escalationPlan(0);
const CLEAN_CONVICTION = Math.max(68, L0.minConviction + 5);
const BELOW_BAR = Math.max(0, L0.minConviction - 1);
if (!(L0.minTier >= 1))
  throw new Error(`the L0 tier bar is ${L0.minTier}; a tier-0 fixture cannot fall below it`);

let seq = 0;
/** A clean, publishable workup: the CEO approved it and nothing is wrong with it. */
const clean = (over = {}) => {
  const n = String(++seq).padStart(2, "0");
  return {
    mint: `Bpk${n}11111111111111111111111111111111111111`.slice(0, 43), symbol: `BPK${n}`,
    outcome: "decided", finalDecision: "APPROVED", weighted: 71,
    pm: { decision: "PROPOSE", conviction: CLEAN_CONVICTION, thesis: "real ignition", invalidation: "deployer sells" },
    redteam: { verdict: "wounded", headline: "thin on holders" },
    compliance: { pass: true, violations: [] },
    risk: { position_size_usd: 12, stop_price: 0.00062, max_loss_usd: 4.56 },
    ceo: { ruling: "APPROVE", order_size_usd: 50 },
    order: { size: 50 },
    ticket: { stop_price: 0.00062, take_profit: [{ price: 0.0019 }] },
    ev: { symbol: `BPK${n}`, pair: { priceUsd: 0.001, marketCap: 300_000,
          priceChange: { m5: 2 }, liquidityUsd: 90_000 },
          pairs: { totalLiquidityUsd: 90_000 }, exitProbe: { roundTripLossPct: 3.1 },
          mintAccount: { flags: [] } },
    ...over,
  };
};
/** Mandate-ELIGIBLE (the CEO held it, the PM wanted a trigger) but under the L0 conviction bar. */
const belowConviction = () => clean({ finalDecision: "HELD", ceo: { ruling: "HOLD", order_size_usd: 50 },
  pm: { decision: "WATCH", conviction: BELOW_BAR, thesis: "t", invalidation: "i" } });
/** Mandate-ELIGIBLE at tier 0 — no approval, no hold, no proposal, no watch — under the L0 tier bar. */
const belowTier = () => clean({ finalDecision: "PENDING", ceo: { ruling: "DEFER", order_size_usd: 50 },
  pm: { decision: "HOLD", conviction: CLEAN_CONVICTION, thesis: "t", invalidation: "i" } });
const pick = (rec) => ({ rec, category: "memecoin", launchpad: "pump.fun", conviction: rec.pm?.conviction ?? null });
const mints = (arr) => arr.map((j) => j.rec?.mint ?? j.mint);
const short = (m) => String(m).slice(0, 5);

/** The seat, as a spy: records every field it is handed and names the given index. */
const spySeat = (chooseIndex = 0) => {
  const fields = [];
  const fn = async (field) => {
    fields.push(mints(field));
    const c = field[Math.min(chooseIndex, field.length - 1)];
    return { pick_mint: c.rec.mint, pick_symbol: c.rec.symbol, why: "spy: named by index",
      edge: "none", expected_move: "n/a", worst_case: "n/a", confidence: 0.5,
      runner_up_mint: field[0].rec.mint };
  };
  return { fn, fields };
};
/** A real open cohort at L0, short by the full quota. */
const openCohort = (quota = 3) => {
  settleCycles();
  const c = beginCyclePass({ quota });
  if (c.waiting) throw new Error("a cohort is still holding the gate — reset did not clear it");
  return c;
};

console.log("\nVALIDATE THE FIXTURES BEFORE TRUSTING THEM — the ruler first");
{
  const bc = belowConviction(), bt = belowTier(), cl = clean();
  const e = (r) => eligibility(r), co = (r) => cohortEligibility(r, 0);
  ok("the clean record is mandate-eligible AND clears the L0 bar",
    e(cl).eligible === true && co(cl).publishable === true,
    `tier=${e(cl).tier} conviction=${cl.pm.conviction} (L0 bar tier>=${L0.minTier} conviction>=${L0.minConviction})`);
  ok("the below-conviction record is mandate-eligible but refused by the L0 bar on conviction",
    e(bc).eligible === true && co(bc).publishable === false && co(bc).gate === "conviction_below_bar",
    `eligible=${e(bc).eligible} tier=${e(bc).tier} gate=${co(bc).gate} :: ${co(bc).reason}`);
  ok("the below-tier record is mandate-eligible but refused by the L0 bar on tier",
    e(bt).eligible === true && co(bt).publishable === false && co(bt).gate === "tier_below_bar",
    `eligible=${e(bt).eligible} tier=${e(bt).tier} gate=${co(bt).gate} :: ${co(bt).reason}`);
}

console.log("\n1. THE FIELD FITS THE QUOTA — the seat is not consulted, and both are published anyway");
{
  reset(); events.length = 0;
  const cohort = openCohort(3);
  const want = cohort.quota - cohort.published;
  const P1 = clean(), X1 = belowConviction(), P2 = clean(), X2 = belowTier();
  const picks = [P1, X1, P2, X2].map(pick);          // interleaved: order matters below
  const seat = spySeat(0);
  const r = await publishCohort({ picks, want, level: cohort.level, cohort, wx: null, bestPickFn: seat.fn });
  console.log(`     want=${want} level=L${cohort.level} eligible=${mints(r.eligible).map(short)} publishable=${mints(r.publishable).map(short)}`);
  ok("all four are mandate-eligible", r.eligible.length === 4, `eligible=${r.eligible.length}`);
  ok("exactly the two that clear the bar are publishable, in field order",
    JSON.stringify(mints(r.publishable)) === JSON.stringify([P1.mint, P2.mint]),
    `publishable=[${mints(r.publishable).map(short).join(", ")}]`);
  ok("runBestPick was NOT called", seat.fields.length === 0, `seat calls=${seat.fields.length}`);
  ok("...and the skip is on the record, with the counts",
    kinds("bestpick:skipped").length === 1 && kinds("bestpick:skipped")[0].publishable === 2
      && kinds("bestpick:skipped")[0].want === want,
    JSON.stringify(kinds("bestpick:skipped")[0] ? { eligible: kinds("bestpick:skipped")[0].eligible,
      publishable: kinds("bestpick:skipped")[0].publishable, want: kinds("bestpick:skipped")[0].want } : null));
  const live = liveCalls().map((c) => c.mint).sort();
  ok("both publishable candidates were published", r.opened.length === 2
    && JSON.stringify(live) === JSON.stringify([P1.mint, P2.mint].sort()),
    `opened=${r.opened.length} live=[${live.map(short).join(", ")}]`);
  ok("neither refused candidate reached the book",
    !live.includes(X1.mint) && !live.includes(X2.mint), `X1=${short(X1.mint)} X2=${short(X2.mint)} absent`);
  const withheld = kinds("call:withheld").map((e) => e.gate);
  ok("...and the bar in publishCall refused them, so the shadow book still hears it",
    withheld.includes("conviction_below_bar") && withheld.includes("tier_below_bar"),
    `call:withheld gates=[${withheld.join(", ")}]`);
}

console.log("\n2. THE FIELD EXCEEDS THE QUOTA — the seat is consulted once, with exactly the publishable subset");
{
  reset(); events.length = 0;
  const cohort = openCohort(3);
  const want = cohort.quota - cohort.published;
  const P = [clean(), clean(), clean(), clean(), clean()];
  const X1 = belowConviction(), X2 = belowTier();
  const picks = [P[0], X1, P[1], P[2], X2, P[3], P[4]].map(pick);   // 7 eligible, 5 publishable
  const seat = spySeat(2);                                            // names the third it is shown
  const r = await publishCohort({ picks, want, level: cohort.level, cohort, wx: null, bestPickFn: seat.fn });
  console.log(`     want=${want} eligible=${r.eligible.length} publishable=${r.publishable.length}`);
  console.log(`     field passed to the seat: [${(seat.fields[0] ?? []).map(short).join(", ")}]`);
  ok("runBestPick was called exactly once", seat.fields.length === 1, `seat calls=${seat.fields.length}`);
  ok("...with exactly the publishable subset, in field order",
    JSON.stringify(seat.fields[0]) === JSON.stringify(P.map((p) => p.mint)),
    `passed=[${(seat.fields[0] ?? []).map(short).join(", ")}] expected=[${P.map((p) => short(p.mint)).join(", ")}]`);
  ok("...and never either of the two the bar refuses",
    !(seat.fields[0] ?? []).includes(X1.mint) && !(seat.fields[0] ?? []).includes(X2.mint),
    `${short(X1.mint)} (conviction_below_bar) and ${short(X2.mint)} (tier_below_bar) absent`);
  ok("the seat's choice is the winner", r.winner?.rec?.mint === P[2].mint,
    `winner=${short(r.winner?.rec?.mint)} chose=${short(P[2].mint)} bestpick:chose=${kinds("bestpick:chose").length}`);
  const live = liveCalls().map((c) => c.mint);
  ok(`the quota was met from the publishable field — ${want} published`, r.opened.length === want && live.length === want,
    `opened=${r.opened.length} live=[${live.map(short).join(", ")}]`);
  ok("...the seat's pick among them, and no refused candidate",
    live.includes(P[2].mint) && !live.includes(X1.mint) && !live.includes(X2.mint),
    `pick ${short(P[2].mint)} live; X1/X2 absent`);
}

console.log("\n3. THE MIRROR — no cohort, no bar in publishCall, so no narrowing before the seat either");
{
  reset(); events.length = 0;
  const P1 = clean(), X1 = belowConviction();
  const picks = [P1, X1].map(pick);
  const seat = spySeat(0);
  const r = await publishCohort({ picks, want: 1, level: 0, cohort: null, wx: null, bestPickFn: seat.fn });
  console.log(`     field passed to the seat: [${(seat.fields[0] ?? []).map(short).join(", ")}]`);
  ok("without a cohort the whole eligible field is publishable",
    r.publishable.length === 2 && r.eligible.length === 2, `publishable=${r.publishable.length} eligible=${r.eligible.length}`);
  ok("...so the seat is consulted with both — the old `> 1` exactly",
    seat.fields.length === 1 && JSON.stringify(seat.fields[0]) === JSON.stringify([P1.mint, X1.mint]),
    `seat calls=${seat.fields.length} field=[${(seat.fields[0] ?? []).map(short).join(", ")}]`);
  ok("one call published, as before the cohort existed", r.opened.length === 1 && liveCalls().length === 1,
    `opened=${r.opened.length} live=${liveCalls().length}`);
}

console.log("\n4. A FIELD OF ONE IS NEVER A CHOICE — and the cycle really is wired to this step");
{
  reset(); events.length = 0;
  const cohort = openCohort(3);
  const P1 = clean(), X1 = belowConviction(), X2 = belowTier();
  const seat = spySeat(0);
  const r = await publishCohort({ picks: [X1, P1, X2].map(pick), want: 3, level: cohort.level, cohort, bestPickFn: seat.fn });
  ok("three eligible, one publishable: the seat is not asked to compare one coin with itself",
    r.publishable.length === 1 && seat.fields.length === 0 && r.opened.length === 1,
    `publishable=${r.publishable.length} seat calls=${seat.fields.length} opened=${r.opened.length}`);
  const src = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("runPenthouseCycle publishes its cohort through publishCohort",
    /const \{ opened \} = await publishCohort\(\{ picks, want, level, cohort, wx \}\);/.test(codeOnly),
    "src/penthouse.js: the cycle body calls the same step this file drives");
  ok("the seat is handed `publishable`, never the raw eligible field",
    /bestPickFn\(publishable\)/.test(codeOnly) && !/bestPickFn\(eligible\)|runBestPick\(eligible\)/.test(codeOnly),
    "no live call passes `eligible` to the seat");
  ok("...and only when the field exceeds the quota",
    /publishable\.length > Math\.max\(1, want\)/.test(codeOnly), "guard reads publishable.length > Math.max(1, want)");
}

reset();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
