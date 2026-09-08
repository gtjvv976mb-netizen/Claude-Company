/**
 * ONE DEFINITION OF "TRADEABLE", PROVED TWICE OVER.
 *
 * "Published" and "tradeable" were two definitions in two processes: the desk decided
 * what to publish, and the bot decided what it could sign from three separate tests —
 * validateEntryReference (trade-policy.mjs), planEntry's bracket geometry
 * (strategy.mjs), and an inline call-age check that lived nowhere but inside
 * poller.mjs's onEntry. The bot's refusals on these facts are DETERMINISTIC and never
 * retried, so a threshold that moves on one side kills calls silently on the other.
 *
 * entry-contract.mjs is the one module both sides call. This file proves two things
 * about it:
 *
 *   1. STRUCTURE — the bot reaches it by import (not by copy), the desk-side files are
 *      free of a second copy of the geometry, no decision site sits more than
 *      CONTRACT_MAX_HOPS from it, and it is on every list that has to carry it: the
 *      decision manifest, install.sh's RUNTIME_FILES and the published site's
 *      EXECUTOR_FILES. (A file on disk is not a file on the web — an unpublished
 *      runtime import 404s every remote install.)
 *
 *   2. PARITY — 500 fixtures swept through entryContract and through the reference
 *      implementations it composes, asserting the SAME verdict and the SAME named fact.
 *      The reference side runs the real functions:
 *        · validateEntryReference on the event, as poller.mjs called it;
 *        · planEntry on the AUTHORED call for no_stop / stop_at_or_above_entry, which
 *          are tests of the bracket the desk wrote;
 *        · planEntry on the MARK-NORMALISED call (entry_ref 1, stop and target as
 *          ratios of the live mark) for R_net, which is exactly how poller.mjs:1232
 *          feeds it today — the money is paid at the mark, not at an 8-minute-old
 *          authored reference;
 *        · the call-age arithmetic poller.mjs used inline.
 *      Every refusal message those functions produce is mapped back to a gate code, and
 *      the contract must name the EARLIEST violated gate in ENTRY_GATES order.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAP_BANDS } from "./src/bands.js";
import { DECISION_MANIFEST_FILES } from "./src/manifest.js";
import { DEFAULTS, planEntry } from "./executor/strategy.mjs";
import { validateEntryReference } from "./executor/trade-policy.mjs";
import {
  CONTRACT_MAX_HOPS, ENTRY_GATES, ENTRY_WINDOW_FLOOR_MS, entryContract, entryWindowMs,
} from "./executor/entry-contract.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

/* ────────────────────────────────────────────────────────────────────────────────
   1. STRUCTURE — the module is reached, not copied
   ──────────────────────────────────────────────────────────────────────────────── */
console.log("\nTHE BOT REACHES THE CONTRACT BY IMPORT, AND ONLY THROUGH IT");
const poller = read("executor/poller.mjs");
{
  ok("poller.mjs imports entryContract from the shared module",
    /import \{[^}]*\bentryContract\b[^}]*\} from "\.\/entry-contract\.mjs"/.test(poller));
  ok("onEntry calls it", /const contract = entryContract\(entryContractInput\(ev, Date\.now\(\)\)\)/.test(poller),
    "one call, this machine's own thresholds");
  ok("...and the inline call-age test it replaced is gone",
    !/const age = Date\.now\(\) - Number\(ev\.ts\);\s*\n\s*if \(age > callExpiryMs\(ev\)\)/.test(poller));
  /* The binder is still called once, at the submission gate, on a fresh clock right
     before anything is signed. What must be gone is onEntry's SECOND, independent
     binding — the one that made the intake and the contract two answers to one question. */
  ok("...and onEntry no longer binds the mark a second time of its own",
    (poller.match(/validateEntryReference\(/g) || []).length === 1
      && /function entryEventSubmissionGate[\s\S]{0,700}validateEntryReference\(event, \{/.test(poller),
    `${(poller.match(/validateEntryReference\(/g) || []).length} call site: the submission gate`);
  ok("the entry window is the contract's, not a second copy of the arithmetic",
    /const callExpiryMs = \(ev\) => entryWindowMs\(\{/.test(poller));

  /* RE-ANCHORED, NOT RELAXED (step 23). This read poller.mjs's literal 60_000 out of the
     source and asserted it EQUALLED the contract's constant — a mirror that could drift
     by a digit between two edits. The poller now binds the constant itself, so the
     property is checked as an identity, which is strictly stronger: there is no second
     number left to disagree. The floor's own value is measured in
     executor/test-entry-window.mjs. */
  ok("poller.mjs takes MIN_CALL_EXPIRY_MS from the contract, not from a second literal",
    /import \{[^}]*\bENTRY_WINDOW_FLOOR_MS\b[^}]*\} from "\.\/entry-contract\.mjs"/s.test(poller) &&
    /const MIN_CALL_EXPIRY_MS = ENTRY_WINDOW_FLOOR_MS;/.test(poller) &&
    !/const MIN_CALL_EXPIRY_MS = \d/.test(poller),
    `one constant, ${ENTRY_WINDOW_FLOOR_MS}ms`);
}

console.log("\nONE MODULE INSTANCE ACROSS THE src/ ↔ executor/ BOUNDARY");
{
  /* src/calls.js already imports ../executor/trade-policy.mjs, so this direction is
     established. What matters is that the desk's path and the bot's path land on the
     SAME module object — two copies under two specifiers would be the very drift this
     module exists to prevent. */
  const viaExecutor = await import(new URL("./executor/entry-contract.mjs", import.meta.url));
  const viaSrc = await import(new URL("./src/../executor/entry-contract.mjs", import.meta.url));
  ok("the desk's specifier and the bot's resolve to one module",
    viaSrc.entryContract === viaExecutor.entryContract && viaExecutor.entryContract === entryContract);
  ok("...and it needs no @solana/web3.js, which the root node_modules lacks",
    typeof viaSrc.entryContract === "function" && typeof viaSrc.entryWindowMs === "function");
}

console.log("\nNO DECISION SITE IS MORE THAN CONTRACT_MAX_HOPS FROM IT");
{
  /* hops = intermediate modules. A direct import is 0; a single re-export shim is 1. */
  const specifierFor = (source) => {
    const m = source.match(/import \{[^}]*\bentryContract\b[^}]*\} from "([^"]+)"/);
    return m ? m[1] : null;
  };
  const hopsFrom = (relFile) => {
    let file = relFile, hops = -1;
    for (let i = 0; i < 6; i++) {
      const spec = specifierFor(read(file));
      if (!spec) return null;
      hops++;
      const next = path.relative(root, path.resolve(path.dirname(path.join(root, file)), spec));
      if (next === path.join("executor", "entry-contract.mjs")) return hops;
      file = next;
    }
    return null;
  };
  const hops = hopsFrom("executor/poller.mjs");
  ok("executor/poller.mjs is a direct caller", hops === 0, `${hops} intermediate modules`);
  ok("...which is inside the ceiling", hops <= CONTRACT_MAX_HOPS, `CONTRACT_MAX_HOPS ${CONTRACT_MAX_HOPS}`);

  /* THE DESK SIDE. Its call sites are wired in the two steps that follow this one, so
     what is enforceable today is the property that survives either way: a desk file
     either reaches the contract within the hop ceiling, or it holds NO second copy of
     the geometry. This goes red the moment a gate is re-implemented in src/ — which is
     the failure this module exists to make impossible — rather than passing vacuously.
     The second copy is looked for as the verbatim refusal wording of every gate plus a
     direct import of the binder itself. */
  const COPY_MARKERS = [
    /is outside authored entry zone/, /has already breached stop/,
    /has already reached authored target/, /costs eat the target/,
    /stop is at or above entry/, /entry market mark is stale/,
    /no current monitored market mark/, /authored entry zone is invalid/,
    /\bvalidateEntryReference\b/,
  ];
  let deskWired = false;
  for (const file of ["src/penthouse.js", "src/alerts.js"]) {
    const source = read(file);
    const hop = specifierFor(source) ? hopsFrom(file) : null;
    const copies = COPY_MARKERS.filter((re) => re.test(source)).map((re) => re.source);
    if (hop != null) {
      deskWired = true;
      ok(`${file} reaches the contract in ${hop} hop(s)`, hop <= CONTRACT_MAX_HOPS);
    } else {
      ok(`${file} holds no second copy of the geometry (not yet wired)`, copies.length === 0,
        copies.length ? `found ${copies.join(", ")}` : "no gate wording, no direct binder import");
    }
  }

  /* DEFAULT-DENY IS THE TRAP ON THE DESK'S SIDE. src/calls.js's gateClass() answers
     SAFETY for any code it has never heard of, so the day a desk file withholds a call
     under a contract gate code, an unregistered code becomes a SAFETY gate no escalation
     rung may waive — a geometry refusal wearing a rug-check's clothes, and permanently
     un-waivable for the wrong reason. While the desk is unwired there is nothing to
     register; the moment it is wired, every gate must be classified EXPLICITLY. */
  const gateBlock = read("src/calls.js").match(/export const GATE_CLASS = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0];
  const classOf = (gate) => gateBlock.match(new RegExp(`\\b${gate}:\\s*"(SAFETY|JUDGMENT)"`))?.[1] ?? null;
  /* THE TWO VOCABULARIES ALREADY OVERLAP, AND EXACTLY. src/calls.js has classified
     `no_stop` and `stop_at_or_above_entry` as SAFETY since long before this module
     existed, and gateFailures() computes the same two facts off the record (stop > 0,
     stop >= entry price) that the contract computes off the call. Same name, same fact,
     same class. Pinned here so a later wiring cannot downgrade a desk SAFETY gate by
     re-using its name for the contract's copy of it. */
  const SHARED_WITH_DESK = ["no_stop", "stop_at_or_above_entry"];
  for (const gate of SHARED_WITH_DESK)
    ok(`${gate} keeps the desk's own classification`, classOf(gate) === "SAFETY", `${classOf(gate)}`);

  const fresh = ENTRY_GATES.filter((g) => !SHARED_WITH_DESK.includes(g));
  const asSafety = fresh.filter((g) => classOf(g) === "SAFETY");
  ok("no NEW contract gate is SAFETY — a live-mark refusal is a judgment, not a rug check",
    asSafety.length === 0, asSafety.length ? asSafety.join(", ") : `${fresh.length} fresh codes, none SAFETY`);
  const registered = fresh.filter((g) => classOf(g) != null);
  if (deskWired)
    ok("the desk is wired, so every fresh contract gate is registered explicitly",
      registered.length === fresh.length,
      `${registered.length}/${fresh.length}: missing ${fresh.filter((g) => classOf(g) == null).join(", ")}`);
  else
    ok("the desk is not wired yet, so no fresh contract gate has reached GATE_CLASS",
      registered.length === 0, `${registered.length} of ${fresh.length} — nothing emits these codes into gateFailures() yet`);
}

console.log("\nA RUNTIME IMPORT THAT IS NOT PUBLISHED IS A 404 ON EVERY INSTALL");
{
  const installer = read("executor/install.sh");
  const runtime = (installer.match(/RUNTIME_FILES=\(([^)]*)\)/)?.[1] || "").split(/\s+/).filter(Boolean);
  ok("install.sh stages entry-contract.mjs", runtime.includes("entry-contract.mjs"),
    `${runtime.length} runtime files`);
  ok("...and the live-mode source-integrity loop checks it too",
    /for source_file in [^;]*\bentry-contract\.mjs\b/.test(installer));
  const built = read("scripts/build-viewer.mjs");
  ok("the site publishes it", /"entry-contract\.mjs"/.test(built.match(/const EXECUTOR_FILES = \[[\s\S]*?\];/)[0]));
  ok("the installer smoke test requires it", /"entry-contract\.mjs"/.test(read("executor/test-install.mjs")));
  ok("it is a decision file in the manifest",
    DECISION_MANIFEST_FILES.includes("executor/entry-contract.mjs"),
    `${DECISION_MANIFEST_FILES.length} manifest files`);
}

/* ────────────────────────────────────────────────────────────────────────────────
   2. PARITY — 500 fixtures, contract vs the functions it composes
   ──────────────────────────────────────────────────────────────────────────────── */

/* poller.mjs's own call-age arithmetic, re-derived here rather than imported, so the
   contract is checked against the rule as it was WRITTEN and not against itself. The
   ARITHMETIC is what is re-derived; the floor is the shared constant, because poller.mjs
   binds that same constant now (step 23) and a copied 60_000 here would be a mirror of
   a number that moved. */
const MAX_CALL_AGE_MS = 45 * 60_000;
const MIN_CALL_EXPIRY_MS = ENTRY_WINDOW_FLOOR_MS;
const referenceExpiryMs = (holdMinMs) => {
  const hold = Number(holdMinMs);
  if (!Number.isFinite(hold) || hold <= 0) return MAX_CALL_AGE_MS;
  return Math.max(MIN_CALL_EXPIRY_MS, Math.min(hold, MAX_CALL_AGE_MS * 8));
};

/* planEntry sizing must never be what refuses a fixture: a bankroll with no history and
   no open risk leaves ONLY the three geometry tests able to skip. */
const PLAN_STATE = Object.freeze({
  openCount: 0, realizedTodaySol: 0, equitySol: 10, wins: 0, losses: 0, bookHeat: 0,
  spendableSol: 10, deployedTodaySol: 0,
});

/** Every refusal the reference implementations produce, as gate codes. */
function referenceGates(ev, now) {
  const gates = new Set();

  // (a) the bracket the desk authored — planEntry on the authored call
  const authored = planEntry({
    call: { entry_ref: ev.entry_ref, stop: ev.stop, target: ev.target },
    cfg: DEFAULTS, state: { ...PLAN_STATE },
  });
  if (authored.action === "skip") {
    if (authored.reason.startsWith("call has no stop")) gates.add("no_stop");
    if (authored.reason === "stop is at or above entry") gates.add("stop_at_or_above_entry");
  }
  /* planEntry falls back to entry_ref = 1 when the reference is missing, so it cannot
     see an invalid one; validateEntryReference refuses it under a message it shares with
     a missing stop, and the stop is already decided above. */
  if (!(Number(ev.entry_ref) > 0)) gates.add(Number(ev.stop) > 0 ? "no_entry_ref" : "no_stop");

  // (b) the live mark — validateEntryReference, exactly as poller.mjs called it
  let reference = null;
  try {
    reference = validateEntryReference(ev, { nowMs: now, maxMarkAgeMs: 15 * 60_000, maxDeviationPct: 10 });
  } catch (error) {
    const m = error.message;
    if (/no current monitored market mark|market mark is stale/.test(m)) gates.add("mark_stale");
    else if (/entry reference or stop is invalid/.test(m)) gates.add(Number(ev.stop) > 0 ? "no_entry_ref" : "no_stop");
    else if (/authored entry zone is invalid/.test(m)) gates.add("invalid_zone");
    else if (/is outside authored entry zone/.test(m)) gates.add("mark_outside_zone");
    else if (/has already breached stop/.test(m)) gates.add("mark_breached_stop");
    else if (/authored target is invalid/.test(m)) gates.add("invalid_target");
    else if (/has already reached authored target/.test(m)) gates.add("mark_at_target");
    else throw new Error(`unmapped reference refusal: ${m}`);
  }

  // (c) R_net at the price the money is paid — planEntry on the mark-normalised call,
  //     which is only computable once the mark has bound
  if (reference) {
    const normalized = planEntry({
      call: { entry_ref: 1, stop: reference.stopRatio, target: reference.targetRatio },
      cfg: DEFAULTS, state: { ...PLAN_STATE },
    });
    if (normalized.action === "skip" && normalized.reason.startsWith("costs eat the target"))
      gates.add("target_inside_cost");
  }

  // (d) the call's own clock — poller.mjs onEntry, inline
  if (Number(ev.ts) > 0 && now - Number(ev.ts) > referenceExpiryMs(ev.hold_min_ms))
    gates.add("window_expired");

  return gates;
}

/* A fixed seed so a mismatch is reproducible by anyone who runs this file. */
let seed = 20260908;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];

const BANDS = Object.entries(CAP_BANDS);
const NOW = 1_757_000_000_000;

function fixture(i) {
  const [band, b] = BANDS[i % BANDS.length];
  /* Every other number is derived from the base price, so an unusable entry_ref is a
     missing FIELD rather than a differently-shaped fixture. */
  const entryRef = 0.00001 * (1 + Math.floor(rnd() * 900));
  const refKind = pick(["stated", "stated", "stated", "stated", "stated", "stated",
    "stated", "stated", "stated", "missing", "zero"]);
  const statedRef = refKind === "missing" ? null : refKind === "zero" ? 0 : entryRef;

  // the stop: present and sane, absent, zero, or above its own entry reference
  const stopKind = pick(["sane", "sane", "sane", "sane", "sane", "sane", "sane", "sane",
    "absent", "zero", "above_entry", "tight"]);
  const stop = stopKind === "absent" ? null
    : stopKind === "zero" ? 0
      : stopKind === "above_entry" ? entryRef * (1 + rnd() * 0.1)
        : stopKind === "tight" ? entryRef * (1 - 0.01 - rnd() * 0.02)
          : entryRef * (1 - 0.08 - rnd() * 0.25);

  // the zone: authored, absent (the ±10% fallback), or inverted
  const zoneKind = pick(["authored", "authored", "absent", "absent", "inverted"]);
  const halfWidth = 0.05 + rnd() * 0.2;
  const entryLo = zoneKind === "authored" ? entryRef * (1 - halfWidth)
    : zoneKind === "inverted" ? entryRef * 1.2 : null;
  const entryHi = zoneKind === "authored" ? entryRef * (1 + halfWidth)
    : zoneKind === "inverted" ? entryRef * 0.8 : null;

  // the mark: inside the zone, under it, over it, missing, or at/under the stop
  const markKind = pick(["inside", "inside", "inside", "inside", "inside", "inside", "inside",
    "below_zone", "above_zone", "missing", "under_stop"]);
  const mark = markKind === "missing" ? null
    : markKind === "below_zone" ? entryRef * 0.7
      : markKind === "above_zone" ? entryRef * 1.4
        : markKind === "under_stop" ? (stop > 0 ? stop * (1 - rnd() * 0.05) : entryRef * 0.5)
          : entryRef * (1 - 0.09 + rnd() * 0.18);

  // the mark's age: 0-20 minutes, occasionally dated in the future
  const markAgeMs = pick([0, 0, 30_000, 30_000, 4 * 60_000, 4 * 60_000, 9 * 60_000, 9 * 60_000,
    14 * 60_000, 16 * 60_000, 20 * 60_000, -2 * 60_000, -7 * 60_000]);
  const markAt = markKind === "missing" && rnd() < 0.5 ? null : NOW - markAgeMs;

  // the target: 1.00x - 1.20x of the mark (where the cost term bites), absent, or bad
  const targetKind = pick(["multiple", "multiple", "multiple", "multiple", "absent", "under_mark", "zero"]);
  const targetBase = mark > 0 ? mark : entryRef;
  const target = targetKind === "absent" ? null
    : targetKind === "zero" ? 0
      : targetKind === "under_mark" ? targetBase * 0.95
        : targetBase * (1 + Math.floor(rnd() * 21) / 100);   // 1.00x .. 1.20x

  // the alert's age against its band's window
  const alertAgeMs = pick([0, 0, 30_000, 30_000, ENTRY_WINDOW_FLOOR_MS + 1_000,
    5 * 60_000, 21 * 60_000, 61 * 60_000, 3 * 3600_000]);

  return {
    symbol: `FIX${i}`, ts: NOW - alertAgeMs,
    entry_ref: statedRef, entry_lo: entryLo, entry_hi: entryHi,
    stop, target, current_mark: mark, current_mark_at: markAt,
    hold_band: band, hold_min_ms: b.holdMinMs,
    _kinds: { refKind, stopKind, zoneKind, markKind, targetKind, markAgeMs, alertAgeMs },
  };
}

console.log("\n500 FIXTURES: THE CONTRACT AND THE FUNCTIONS IT COMPOSES MUST AGREE");
{
  const counts = new Map();
  const mismatches = [];
  let refused = 0, allowed = 0;
  const samples = [];

  for (let i = 0; i < 500; i++) {
    const ev = fixture(i);
    const contract = entryContract({
      entryRef: ev.entry_ref, entryLo: ev.entry_lo, entryHi: ev.entry_hi,
      stop: ev.stop, target: ev.target, mark: ev.current_mark, markAt: ev.current_mark_at,
      now: NOW, holdBand: ev.hold_band, holdMinMs: ev.hold_min_ms, alertTs: ev.ts,
      costPct: DEFAULTS.costPct, maxMarkAgeMs: 15 * 60_000, maxDeviationPct: 10,
      windowFloorMs: MIN_CALL_EXPIRY_MS, windowFallbackMs: MAX_CALL_AGE_MS,
    });
    const gates = referenceGates(ev, NOW);
    const earliest = ENTRY_GATES.find((g) => gates.has(g)) ?? null;

    const key = contract.gate ?? "(open)";
    counts.set(key, (counts.get(key) || 0) + 1);
    contract.ok ? allowed++ : refused++;

    if (contract.ok !== (gates.size === 0) || contract.gate !== earliest) {
      mismatches.push({ i, kinds: ev._kinds,
        entry_ref: ev.entry_ref, entry_lo: ev.entry_lo, entry_hi: ev.entry_hi,
        stop: ev.stop, target: ev.target, mark: ev.current_mark,
        markAgeMs: ev.current_mark_at == null ? null : NOW - Number(ev.current_mark_at),
        alertAgeMs: NOW - Number(ev.ts),
        band: ev.hold_band,
        contract: { ok: contract.ok, gate: contract.gate, message: contract.detail.message },
        reference: { refuses: gates.size > 0, gates: [...gates], earliest } });
    }
    if (samples.length < 6 && !samples.some((s) => s.gate === key))
      samples.push({ gate: key, i, band: ev.hold_band, mark: ev.current_mark, stop: ev.stop,
        target: ev.target, ref: ev.entry_ref,
        markAgeMin: ev.current_mark_at == null ? null : (NOW - Number(ev.current_mark_at)) / 60_000,
        alertAgeMin: (NOW - Number(ev.ts)) / 60_000, rNet: contract.detail.rNet ?? null });
  }

  for (const m of mismatches) console.log(`  MISMATCH ${JSON.stringify(m)}`);

  console.log(`  verdicts: ${allowed} enterable, ${refused} refused, ${mismatches.length} mismatches`);
  console.log("  gate distribution:");
  for (const [gate, n] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(n).padStart(4)}  ${gate}`);
  console.log("  worked examples:");
  for (const s of samples) console.log(`    ${JSON.stringify(s)}`);

  ok("every fixture's verdict and named gate match the reference", mismatches.length === 0,
    `${500 - mismatches.length}/500 identical`);
  ok("the sweep exercised both outcomes", allowed > 0 && refused > 0, `${allowed} / ${refused}`);
  ok("the gate list is complete — reference_refused never fired",
    !counts.has("reference_refused"),
    "a pass the contract allows is a pass validateEntryReference also binds");
  const covered = [...counts.keys()].filter((k) => k !== "(open)");
  ok("the sweep reached most of the gate list", covered.length >= 11,
    `${covered.length} of ${ENTRY_GATES.length} gates seen: ${covered.join(", ")}`);
}

console.log("\nTHE WINDOW IS THE BAND'S OWN MINIMUM HOLD, WITH A FLOOR AND A FALLBACK");
{
  for (const [band, b] of BANDS) {
    const got = entryWindowMs({ holdMinMs: b.holdMinMs, floorMs: MIN_CALL_EXPIRY_MS, fallbackMs: MAX_CALL_AGE_MS });
    ok(`${band} stays enterable for ${got < 120_000 ? `${(got / 1_000).toFixed(0)}s` : `${(got / 60_000).toFixed(0)}m`}`,
      got === referenceExpiryMs(b.holdMinMs), `contract ${got}ms, poller rule ${referenceExpiryMs(b.holdMinMs)}ms`);
  }
  ok("a call with no band falls back to the flat window",
    entryWindowMs({ holdMinMs: null, fallbackMs: MAX_CALL_AGE_MS }) === MAX_CALL_AGE_MS,
    `${MAX_CALL_AGE_MS / 60_000}m`);
  ok("a one-second window still gives the bot four polls",
    entryWindowMs({ holdMinMs: 1_000, fallbackMs: MAX_CALL_AGE_MS }) === ENTRY_WINDOW_FLOOR_MS,
    `${ENTRY_WINDOW_FLOOR_MS / 1000}s floor`);
  ok("an absurd window is capped",
    entryWindowMs({ holdMinMs: 999 * 3_600_000, fallbackMs: MAX_CALL_AGE_MS }) === MAX_CALL_AGE_MS * 8);
  /* A call with no alert row has no clock yet — the desk runs the contract BEFORE it
     raises one — so the window must not refuse it by accident. */
  const noClock = entryContract({ entryRef: 1, stop: 0.9, target: 1.3, mark: 1, markAt: NOW - 1000,
    now: NOW, holdMinMs: 60_000, alertTs: null });
  ok("no alert timestamp means no window verdict, not an expired one",
    noClock.ok === true && noClock.detail.windowChecked === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
