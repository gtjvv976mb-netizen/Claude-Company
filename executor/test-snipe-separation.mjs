/* THE FENCE BETWEEN THE TWO LANES, AS TESTS RATHER THAN AS A CONVENTION.
 *
 * The desk-led executor holds unconditionally without a desk instruction. That is not a
 * default anyone picked for tidiness — it is an owner decision taken after a measured
 * incident, and desk-led-v4 is the name of it. The sniper lane needs the opposite: an
 * exit determined locally, from marks alone, because it has no desk.
 *
 * Two opposite rules in one process is a standing invitation for the sniper's to leak
 * into the desk's. A comment saying "keep these separate" does not survive a busy
 * afternoon; these six clauses do.
 *
 *   1. TWO BOOKS      — openList() is Object.values(S.positions) and feeds manageOpen,
 *                       mirrorTick, recordPositionFailure, book heat, positionEntryBlock
 *                       and reconcileHeldCalls. A second book means openList() cannot see
 *                       a snipe BY CONSTRUCTION; a lane FIELD would mean auditing all six.
 *   2. TWO ENGINES    — no shared call site in either direction.
 *   3. SOURCE BOUNDARY— the desk files may not import the lane, and the lane may not
 *                       reach the desk's exit policy. Read as TEXT, the technique
 *                       test-desk-led-exits.mjs already uses.
 *   4. DIGEST PINS    — the desk's exit body is pinned. If it moves, this fails loudly.
 *   5. BEHAVIOURAL    — sweep stepPosition with deskExit:null and prove it holds at every
 *                       point. The property, not the shape of the code.
 *   6. CONFIG DISJOINT— the two config namespaces share no key, so a sniper dial cannot
 *                       silently re-enable a bot-led exit on the desk path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
const read = (rel) => fs.readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
/* Comments are prose and may legitimately discuss the other lane; only CODE is fenced. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DESK_FILES = ["strategy.mjs", "trade-policy.mjs", "desk-mirror.mjs"];
const LANE_FILES = ["snipe-policy.mjs", "snipe-curve.mjs", "snipe-venue.mjs",
  "snipe-venue-pumpfun.mjs", "snipe-feed.mjs", "snipe-entry.mjs", "snipe-book.mjs",
  "snipe-lane.mjs", "snipe-shadow.mjs", "snipe-execute.mjs"];

/* ── 3. THE SOURCE BOUNDARY, BOTH DIRECTIONS ───────────────────────────────────────── */
console.log("\nTHE SOURCE BOUNDARY");
ok("no desk file imports anything from the sniper lane", () => {
  for (const f of DESK_FILES) {
    const code = codeOf(read(f));
    assert.doesNotMatch(code, /from\s+["']\.\/snipe-[a-z-]+\.mjs["']/,
      `${f} imports the sniper lane — the desk must not know the lane exists`);
  }
  console.log(`        ${DESK_FILES.join(", ")} — none import snipe-*`);
});

ok("no lane file reaches the desk's exit policy", () => {
  for (const f of LANE_FILES) {
    const code = codeOf(read(f));
    assert.doesNotMatch(code, /from\s+["']\.\/(trade-policy|desk-mirror)\.mjs["']/,
      `${f} imports the desk's exit policy`);
    assert.doesNotMatch(code, /\b(pricePolicy|stepPosition|evaluateMirror)\s*\(/,
      `${f} calls a desk exit function`);
  }
  console.log(`        ${LANE_FILES.length} lane files — none call pricePolicy/stepPosition/evaluateMirror`);
});

ok("the ONE sanctioned desk import is the fee floor, and only that", () => {
  const found = [];
  for (const f of LANE_FILES) {
    for (const m of codeOf(read(f)).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/strategy\.mjs["']/g)) {
      found.push({ file: f, names: m[1].split(",").map((x) => x.trim()).filter(Boolean) });
    }
  }
  for (const { file, names } of found) {
    assert.deepEqual(names, ["minViableSolPerTrade"],
      `${file} imports ${JSON.stringify(names)} from strategy.mjs; only minViableSolPerTrade is sanctioned`);
  }
  console.log(`        ${found.length} import(s) from strategy.mjs, all minViableSolPerTrade`);
});

/* ── 1 & 2. TWO BOOKS, TWO ENGINES ─────────────────────────────────────────────────── */
console.log("\nTWO BOOKS, TWO ENGINES");
ok("openList() still reads ONLY the desk book, so it cannot see a snipe", () => {
  const code = codeOf(read("poller.mjs"));
  assert.match(code, /const openList\s*=\s*\(\)\s*=>\s*Object\.values\(S\.positions\)/,
    "openList changed shape — every consumer of it must be re-audited against the lane");
  assert.doesNotMatch(code, /Object\.values\(S\.snipes\)[\s\S]{0,40}openList/,
    "openList now mixes the two books");
});
ok("the desk engine is never handed a snipe, and vice versa", () => {
  const poller = codeOf(read("poller.mjs"));
  assert.doesNotMatch(poller, /stepPosition\([^)]*snipe/i, "stepPosition called on a snipe");
  assert.doesNotMatch(poller, /snipeStep\([^)]*S\.positions/i, "the lane engine called on a desk position");
});

/* ── 4. THE DIGEST PIN ─────────────────────────────────────────────────────────────── */
console.log("\nTHE DESK'S EXIT BODY IS PINNED");
/* The BODY, not the whole file: unrelated edits to strategy.mjs stay possible, while the
   function that decides whether the bot may sell on its own cannot move unnoticed. */
function stepPositionBody() {
  const src = read("strategy.mjs");
  const start = src.indexOf("export function stepPosition");
  assert.ok(start > 0, "stepPosition not found in strategy.mjs");
  /* Skip the PARAMETER list before looking for the body. stepPosition destructures its
     argument, so the first "{" after the name opens the params, not the body — taking it
     pins the signature and lets the body move freely underneath, which is the opposite of
     what this guards. Walk the parens to their close first. */
  let pd = 0, j = src.indexOf("(", start);
  for (; j < src.length; j++) {
    if (src[j] === "(") pd++;
    else if (src[j] === ")" && --pd === 0) break;
  }
  let depth = 0, i = src.indexOf("{", j);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(from, i + 1).replace(/\s+/g, " ").trim();
}
/* Computed from the file, 2026-09-11, with the body extractor above. Not invented: an
   invented pin fails on first run and teaches whoever fixes it that the pin is noise. */
const DESK_EXIT_BODY_SHA = "d297377583b39053dd55da79b90cfcdf30ef5ebaeb874e3d2be0c71428d42ca3";
ok("stepPosition's body still holds unconditionally without a deskExit", () => {
  const body = stepPositionBody();
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  if (sha !== DESK_EXIT_BODY_SHA) {
    assert.fail(
      "THE DESK PATH MOVED. desk-led-v4 — the bot holds unless the desk determines — was " +
      "an owner decision taken after a measured incident, and the sniper lane is not a " +
      `reason to revisit it. If the change is deliberate, update the pin.\n  was ${DESK_EXIT_BODY_SHA}\n  now ${sha}\n  body: ${body.slice(0, 200)}`);
  }
  console.log(`        sha256(stepPosition body) = ${sha.slice(0, 16)}…`);
});

/* ── 5. THE BEHAVIOURAL PROOF ──────────────────────────────────────────────────────── */
console.log("\nTHE PROPERTY ITSELF, NOT THE SHAPE OF THE CODE");
ok("stepPosition holds at EVERY point of a mark x position x clock sweep", async () => {
  const { stepPosition, freshState } = await import("./strategy.mjs");
  let checked = 0, sells = 0;
  for (const entry of [0.001, 1, 1_000]) {
    for (const mark of [0, 0.0001, entry * 0.01, entry * 0.5, entry, entry * 2, entry * 100, NaN, null]) {
      for (const dt of [0, 1_000, 60_000, 86_400_000]) {
        const pos = { ...freshState(0), entry, mint: "m", qty: 1 };
        const d = stepPosition({ pos, mark, deskExit: null, nowMs: 1_700_000_000_000 + dt });
        checked++;
        if (d.action !== "hold") sells++;
      }
    }
  }
  assert.equal(sells, 0, `${sells} of ${checked} swept points produced a non-hold without a deskExit`);
  console.log(`        ${checked} points swept, ${sells} sells — the bot never exits on its own`);
});

/* ── 6. CONFIG DISJOINTNESS ────────────────────────────────────────────────────────── */
console.log("\nTHE TWO CONFIG NAMESPACES SHARE NOTHING");
ok("SNIPE_DEFAULTS and the desk DEFAULTS share no key", async () => {
  const { SNIPE_DEFAULTS } = await import("./snipe-policy.mjs");
  const strat = await import("./strategy.mjs");
  const deskDefaults = strat.DEFAULTS || strat.POLICY_DEFAULTS || {};
  const shared = Object.keys(SNIPE_DEFAULTS).filter((k) => Object.hasOwn(deskDefaults, k));
  assert.deepEqual(shared, [],
    `shared config keys ${JSON.stringify(shared)} — one dial would move both lanes`);
  console.log(`        ${Object.keys(SNIPE_DEFAULTS).length} lane keys vs ` +
    `${Object.keys(deskDefaults).length} desk keys, 0 shared`);
});

/* ── THE RECORD TELLS THE LANES APART ──────────────────────────────────────────────── */
console.log("\nA SNIPE EXIT IS STAMPED AS ITS OWN KIND");
ok("snipe_exit is a first-class exit kind in the journal", async () => {
  const { EXIT_INTENT_KINDS } = await import("./journal.mjs");
  assert.ok(EXIT_INTENT_KINDS.includes("snipe_exit"),
    `EXIT_INTENT_KINDS = ${JSON.stringify(EXIT_INTENT_KINDS)} — a snipe exit that is not ` +
    "an exit kind takes no conflict lock and never reaches the risk ledger");
  console.log(`        EXIT_INTENT_KINDS = ${EXIT_INTENT_KINDS.join(", ")}`);
});
ok("a snipe-exit intent id is NOT stamped risk_exit by the default branch", () => {
  /* The final branch of exitKindForIntentId is a DEFAULT, not a match: every unrecognised
     prefix becomes risk_exit. Without an explicit clause a snipe latch would carry the
     desk's kind and desk-mirror would reason about it as a risk_exit determination. */
  const code = codeOf(read("poller.mjs"));
  const m = code.match(/const exitKindForIntentId[\s\S]{0,400}?\};/);
  assert.ok(m, "exitKindForIntentId not found");
  assert.match(m[0], /startsWith\("snipe-exit:"\)\s*\?\s*"snipe_exit"/,
    "snipe-exit: is not named, so it falls through to the risk_exit default");
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
