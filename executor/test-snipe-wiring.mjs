/* THE LANE IS WIRED INTO THE POLLER, AND THE WIRING IS THE RISKY PART.
 *
 * A second lane inside the process that earns is a standing hazard, whatever the lane
 * does. Three things must be true of the wiring itself, independent of whether the lane's
 * own logic is any good:
 *
 *   OFF BY DEFAULT   — an installed bot that never sets SNIPE_LANE must behave exactly as
 *                      it did before the lane existed. No timer, no socket, no cost.
 *   CANNOT SIGN      — the lane refuses lane=execute at construction. There is no flag in
 *                      poller.mjs that can talk it into signing, because there is no
 *                      signing path in it and no keypair loaded on it.
 *   CANNOT KILL THE DESK — construction and every tick are wrapped. An observation lane
 *                      that can stop the bot that earns is worth less than no lane.
 *
 * This reads poller.mjs as TEXT for the wiring shape and drives the lane directly for the
 * behaviour, because the poller's own boot needs a wallet, a feed and a chain.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0;
const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const block = poller.slice(poller.indexOf("THE LAUNCH LANE, OBSERVE-ONLY"));
assert.ok(block.length > 500, "the launch-lane wiring block was not found in poller.mjs");

console.log("\nOFF BY DEFAULT");
ok("the whole block is behind a mode check that defaults to off", () => {
  assert.match(block, /String\(process\.env\.SNIPE_LANE \|\| "off"\)/,
    "SNIPE_LANE must default to off, so an install that never sets it is unchanged");
  assert.match(block, /if \(SNIPE_LANE_MODE !== "off"\)/);
});
ok("the lane's modules are imported INSIDE the branch, never at module scope", () => {
  /* A top-level import would run the lane's module side effects on every boot, including
     for installs that never asked for it. The dynamic import inside the branch is what
     makes "off" cost literally nothing. */
  assert.match(block, /await Promise\.all\(\[\s*import\("\.\/snipe-lane\.mjs"\)/,
    "the lane must be imported dynamically inside the branch");
  const beforeBlock = poller.slice(0, poller.indexOf("THE LAUNCH LANE, OBSERVE-ONLY"));
  assert.doesNotMatch(beforeBlock, /^import .*snipe-/m,
    "poller.mjs imports a snipe module at top level — that runs for every install");
});
ok("no timer is created unless the branch is entered", () => {
  const setIntervals = [...block.matchAll(/setInterval\(/g)];
  assert.equal(setIntervals.length, 1, `${setIntervals.length} timers in the lane block`);
  assert.ok(block.indexOf("setInterval(") > block.indexOf('if (SNIPE_LANE_MODE !== "off")'),
    "the lane timer is created outside the mode branch");
});

console.log("\nIT CANNOT SIGN, AND THE POLLER CANNOT MAKE IT");
const lane = await import("./snipe-lane.mjs");
const { PUMPFUN_VENUE } = await import("./snipe-venue-pumpfun.mjs");
const readers = ["primary", "secondary"].map((id) => ({
  id, async read() { return { slot: 1, accounts: [] }; },
}));
/* The lane refuses to construct without a control reader and takes no default — an
   unchecked sentinel is not the same fact as an absent one. In poller.mjs this is the
   DESK'S OWN hardStop/pauseEntries, so one file stops both lanes. */
const control = () => ({ hardStop: false, pauseEntries: false });

/* RE-ANCHORED 2026-09-12, when the signing path shipped. The lane no longer refuses
   lane=execute by name; it refuses it for want of the three things arming needs, in
   order, and each refusal is asserted below by its clause. The poller's block builds the
   port only under EXECUTE=1, so a flag on a paper install still constructs nothing. */
ok("createSnipeLane REFUSES lane=execute without a signing port", () => {
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control, cfg: { lane: "execute" } }),
    (err) => err.clause === "executor_missing" && /execute/i.test(err.message),
    "the lane accepted lane=execute with no port — arming must be an owner decision, not a flag");
});
const fakePort = { wallet: "D7ppNxdmcoVtEHsHjV47D8q2nGdoUjhdgPpKYmX9gwps",
  prepareBuy() { throw new Error("not in this test"); }, async buy() { throw new Error("no"); }, async sell() { throw new Error("no"); } };
ok("...and REFUSES it with a port but without the owner's typed sentence", () => {
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control, cfg: { lane: "execute" }, executor: fakePort }),
    (err) => err.clause === "arming_refused" && /SNIPE_LIVE_ACK/.test(err.message),
    "a port alone armed the lane — the sentence is the owner's part");
});
ok("...and REFUSES a ticket above the canary whose stop was never typed", () => {
  /* The 0.20x default stop was derived for a 0.005 SOL ticket. Carried unexamined onto a
     larger one it is an 80% drawdown before it speaks, so the checklist (not the parser)
     refuses to arm until SNIPE_STOP_FRAC is set — and it names the item. */
  const cfg = lane.snipeLaneConfig({ SNIPE_LANE: "execute", SNIPE_MAX_SOL_PER_TRADE: "0.05", SNIPE_DAILY_SOL_CAP: "0.2" });
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control, cfg, executor: fakePort }),
    (err) => err.clause === "not_armable" && err.detail.blocking.includes("stop_is_fundable"),
    "a 0.05 SOL ticket armed on the canary's stop");
});
ok("...and constructs only when the sentence names this wallet and these caps", () => {
  const cfg = lane.snipeLaneConfig({ SNIPE_LANE: "execute", SNIPE_MAX_SOL_PER_TRADE: "0.05", SNIPE_DAILY_SOL_CAP: "0.2", SNIPE_STOP_FRAC: "0.7" });
  const sentence = lane.snipeArmSentence(fakePort.wallet, 0.05, 0.2);
  const armed = lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control,
    cfg: { ...cfg, liveAck: sentence }, executor: fakePort });
  assert.equal(armed.mode, "execute");
  assert.equal(armed.adapter.observeOnly, false, "an armed lane must reach the real encoders");
  assert.equal(armed.effective.policy.stopFrac, 0.7, "the typed stop must be the stop the determiner runs under");
  /* And the determiner is handed the EFFECTIVE config, not the stated one. Read from the
     source: the one step() call in the lane's tick must pass `cfg: effective`. Until
     2026-09-12 it passed `cfg: conf`, and the take dial never reached the sell. */
  const laneSrc = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  const stepCalls = laneSrc.match(/determiner\.step\(\{[\s\S]*?\}\)/g) ?? [];
  assert.equal(stepCalls.length, 1, "expected exactly one determiner.step() call in the lane");
  assert.match(stepCalls[0], /cfg:\s*effective\b/, "the determiner is handed the stated config, so typed dials are inert");
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control,
      cfg: { ...cfg, liveAck: lane.snipeArmSentence(fakePort.wallet, 0.06, 0.2) }, executor: fakePort }),
    (err) => err.clause === "arming_refused",
    "a sentence for a different size armed a lane at this size");
  console.log(`        armed with: ${sentence}`);
});
ok("SNIPE_LANE=execute parses, and the legacy SNIPE_EXECUTE flag is still refused", () => {
  assert.equal(lane.snipeLaneConfig({ SNIPE_LANE: "execute" }).lane, "execute");
  assert.throws(() => lane.snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_EXECUTE: "1" }),
    (err) => err.clause === "execute_not_implemented",
    "a bare boolean armed the lane — the flag cannot carry the numbers the sentence makes you type");
});
/* RE-ANCHORED 2026-09-11. This asserted that the ADAPTER's buildBuy refuses because the
 * layout was unverified. The layout is verified now — 30 mainnet occurrences re-encoded
 * index-for-index — so the adapter builds bytes, and keeping the old assertion would have
 * meant either a dead test or a venue that cannot do the thing it was proved to do.
 *
 * The lane-level fence is UNCHANGED and is what this asserts instead, because it was
 * always the stronger of the two: observeOnlyVenue replaces buyIx, buildBuy and sellIx
 * with throwers before the lane ever sees the adapter, so an observing lane cannot reach
 * an encoder even when a working one exists two modules away. That is the property that
 * survives the layout being proved, and it is the one that matters here. */
ok("the LANE cannot reach an encoder, even now that a working one exists", () => {
  const l = lane.createSnipeLane({
    venue: PUMPFUN_VENUE, readers, control, cfg: lane.snipeLaneConfig({ SNIPE_LANE: "observe" }),
  });
  for (const method of ["buyIx", "buildBuy", "sellIx"]) {
    assert.equal(typeof l.adapter[method], "function", `the facade dropped ${method} entirely`);
    assert.throws(() => l.adapter[method]({}), (err) => err.clause === "signing_refused",
      `the lane's ${method} did not refuse`);
  }
  /* And the adapter it was built FROM does encode — otherwise the facade would be
     refusing something that was never there, which proves nothing. */
  assert.equal(PUMPFUN_VENUE.layoutVerified, true);
  assert.throws(() => PUMPFUN_VENUE.buildBuy({}), (err) => err.clause !== "signing_refused",
    "the underlying adapter still refuses like a facade — then this test is vacuous");
  console.log("        facade refuses buyIx/buildBuy/sellIx while the adapter beneath them encodes");
});
ok("the lane reports zero signed, zero sent, zero keypairs — as fields, not comments", () => {
  /* THIS ASSERTION SPENT ITS WHOLE LIFE ASSERTING NOTHING, and printed ok every time.
   *
   * It read `const s = l.scorecard ? l.scorecard() : l.summary?.() ?? null;` and then
   * guarded the three checks with `if (s)`. The lane exports NEITHER method — the real
   * one is stats() — so s was null on every run, all three asserts were skipped, and the
   * line reported ok. The single test whose job is to catch an executing lane signing
   * has never once looked at the numbers it names.
   *
   * Fixed 2026-09-11 while arming this lane, which is what made it matter. The reader is
   * now the real method and its ABSENCE is a failure, not a skip: an optional-chained
   * probe for a field that must exist cannot fail, and a test that cannot fail is not a
   * test. There is no `if` in this body on purpose. */
  const l = lane.createSnipeLane({
    venue: PUMPFUN_VENUE, readers, control, cfg: lane.snipeLaneConfig({ SNIPE_LANE: "observe" }),
  });
  assert.equal(typeof l.stats, "function",
    "the lane stopped exporting stats() — the counters this test reads have moved, and a " +
    "renamed reader is how this assertion went vacuous the first time");
  const s = l.stats();
  for (const field of ["signed", "sent", "keypairsLoaded"])
    assert.ok(Object.hasOwn(s, field),
      `stats() has no ${field} field — it must be a FIELD the test reads, not a claim in a comment`);
  assert.strictEqual(s.signed, 0, `signed=${s.signed}`);
  assert.strictEqual(s.sent, 0, `sent=${s.sent}`);
  assert.strictEqual(s.keypairsLoaded, 0, `keypairsLoaded=${s.keypairsLoaded}`);
  console.log(`        signed=${s.signed} sent=${s.sent} keypairs=${s.keypairsLoaded} (read from stats(), which exists)`);
});

console.log("\nIT CANNOT TAKE THE DESK DOWN");
ok("a lane that fails to construct is caught, logged, and not rethrown", () => {
  const m = block.match(/\}\s*catch \(err\) \{[\s\S]{0,400}?launch lane did not start/);
  assert.ok(m, "construction is not wrapped in a catch that survives");
  assert.doesNotMatch(m[0], /throw|process\.exit/,
    "the construction catch rethrows or exits — a lane that cannot start must not stop the desk");
});
ok("a tick that throws never propagates into the process, whatever else it does", () => {
  const m = block.match(/setInterval\(async \(\) => \{[\s\S]*?\}, snipeTickMs\)/);
  assert.ok(m, "the lane tick was not found");
  assert.doesNotMatch(m[0], /throw |process\.exit/,
    "the lane tick can propagate a throw into the process");
  assert.match(m[0], /the desk is unaffected/);
});
/* RE-ANCHORED 2026-09-11, from "a faulting tick disables the lane" to "a faulting tick
   disables the lane ONLY IF NOTHING IS OPEN".
   The old assertion pinned a latch that was correct for an observer and dangerous for
   anything that can hold: any throw set laneFaulted permanently, so one transient RPC
   error would leave a live position with nothing running to price it, stop it, take it,
   or answer the hard stop — the lane sitting quietly disabled while the bag it opened
   rode to zero. The desk-safety half of the old assertion is kept above, unchanged and
   unweakened; what changed is the disable, which is now conditional on the book. */
ok("...and it only disables the lane permanently when the book is EMPTY", () => {
  const m = block.match(/setInterval\(async \(\) => \{[\s\S]*?\}, snipeTickMs\)/);
  assert.match(m[0], /lane\.openPositions\(\)\.length/,
    "the fault path must consult the book before deciding to give up");
  const latch = m[0].slice(m[0].indexOf("catch"));
  const guard = latch.match(/if \(open === 0\) \{[\s\S]*?\}/);
  assert.ok(guard, "the permanent latch is not guarded by an empty book");
  assert.match(guard[0], /laneFaulted = true/,
    "with nothing open the lane should still give up permanently — that is cheap and correct");
  /* And with something open it must RETRY rather than latch. */
  const after = latch.slice(latch.indexOf("laneFaults += 1"));
  assert.ok(after.length > 0, "there is no retry path for a fault with a position open");
  assert.doesNotMatch(after, /laneFaulted = true/,
    "the open-position path latches the lane off — that strands the position");
  assert.match(after, /retrying in .*rather/,
    "the retry must say why it is retrying; a silent backoff reads as a hang");
});
ok("the desk's own tick is untouched by any of it", () => {
  assert.match(poller, /setInterval\(tick, POLL_MS\);/,
    "the desk tick changed shape");
  const deskTickAt = poller.indexOf("setInterval(tick, POLL_MS);");
  const laneAt = poller.indexOf("THE LAUNCH LANE, OBSERVE-ONLY");
  assert.ok(deskTickAt < laneAt, "the lane block was inserted before the desk's own tick starts");
});

console.log("\nTWO ENDPOINTS, ITS OWN");
ok("the lane opens its own pair rather than borrowing the desk's secondary", () => {
  /* secondaryConn is null whenever EXECUTE is off, which IS the observe configuration.
     A shadow book validating a two-endpoint rule on one endpoint measures nothing. */
  assert.match(block, /laneReader\("primary", RPC\)/);
  assert.match(block, /laneReader\("secondary", SECONDARY_RPC\)/);
  /* CODE only: the comment above the wiring explains WHY the desk's secondaryConn cannot
     be used, and a test that forbade naming it would push that explanation out of the
     file. What must not exist is a USE of it. */
  /* Slice from the first line of real CODE, not from the comment banner: `block` begins
     mid-comment, so there is no opening delimiter for a comment stripper to match and the
     prose survives every filter. */
  const blockCode = block.slice(block.indexOf("const SNIPE_LANE_MODE"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(blockCode, /secondaryConn/,
    "the lane borrows the desk's secondary connection, which is null in observe mode");
});
ok("a single-endpoint lane is refused by construction", () => {
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers: [readers[0]], control,
      cfg: lane.snipeLaneConfig({ SNIPE_LANE: "observe" }) }),
    /two distinct endpoints|single_endpoint/i);
});
ok("the reader port supplies a SLOT, which the witness rule needs", () => {
  assert.match(block, /getMultipleAccountsInfoAndContext/,
    "the reader must fetch slot alongside accounts — a read with no slot cannot witness");
  assert.match(block, /slot: res\?\.context\?\.slot/);
});


/* THE KILL SWITCH IS SHARED, WHICH IS THE ONLY VERSION ANYONE REMEMBERS UNDER PRESSURE. */
console.log("\nONE HARD STOP, BOTH LANES");
ok("poller.mjs hands the lane the DESK'S own sentinels, not a second pair", () => {
  assert.match(block, /control: \(\) => \(\{ hardStop: hardStop\(\) === true, pauseEntries: pauseEntries\(\) === true \}\)/,
    "the lane must read the desk's hardStop/pauseEntries, so one file stops both lanes");
});
ok("the lane refuses to construct with no control reader at all", () => {
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers,
      cfg: lane.snipeLaneConfig({ SNIPE_LANE: "observe" }) }),
    /control/i,
    "a lane with no sentinel reader was allowed — an unchecked sentinel is not an absent one");
});

console.log(`\n══ ${pass} passed, 0 failed ══`);
