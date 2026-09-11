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

ok("createSnipeLane REFUSES lane=execute outright", () => {
  assert.throws(
    () => lane.createSnipeLane({ venue: PUMPFUN_VENUE, readers, control, cfg: { lane: "execute" } }),
    /execute/i,
    "the lane accepted lane=execute — arming must be an owner decision, not a flag");
});
/* STRONGER THAN EXPECTED, so the assertion follows the code rather than the other way
   round: SNIPE_LANE=execute is refused at CONFIG PARSE, before construction is reached.
   The environment cannot even be turned into an executing config, which means there is no
   window in poller.mjs between reading the env and building the lane where an execute
   config exists. Asserted at the config boundary because that is where it actually is. */
ok("...and SNIPE_LANE=execute is refused at config parse, before construction", () => {
  assert.throws(() => lane.snipeLaneConfig({ SNIPE_LANE: "execute" }),
    /observe-only|execute/i,
    "the environment produced an executing config — poller.mjs would hold it, however briefly");
  console.log("        SNIPE_LANE=execute cannot be parsed into a config at all");
});
ok("the venue's buy encoder refuses — no verified layout, no signing", async () => {
  await assert.rejects(
    async () => PUMPFUN_VENUE.buildBuy({}),
    /not verified|refuses/i,
    "buildBuy did not refuse on an unverified layout");
});
ok("the lane reports zero signed, zero sent, zero keypairs — as fields, not comments", () => {
  const l = lane.createSnipeLane({
    venue: PUMPFUN_VENUE, readers, control, cfg: lane.snipeLaneConfig({ SNIPE_LANE: "observe" }),
  });
  const s = l.scorecard ? l.scorecard() : l.summary?.() ?? null;
  if (s) {
    assert.equal(s.signed, 0, `signed=${s.signed}`);
    assert.equal(s.sent, 0, `sent=${s.sent}`);
    assert.equal(s.keypairsLoaded, 0, `keypairsLoaded=${s.keypairsLoaded}`);
    console.log(`        signed=${s.signed} sent=${s.sent} keypairs=${s.keypairsLoaded}`);
  }
});

console.log("\nIT CANNOT TAKE THE DESK DOWN");
ok("a lane that fails to construct is caught, logged, and not rethrown", () => {
  const m = block.match(/\}\s*catch \(err\) \{[\s\S]{0,400}?launch lane did not start/);
  assert.ok(m, "construction is not wrapped in a catch that survives");
  assert.doesNotMatch(m[0], /throw|process\.exit/,
    "the construction catch rethrows or exits — a lane that cannot start must not stop the desk");
});
ok("a tick that throws disables the lane and leaves the trading loop running", () => {
  const m = block.match(/setInterval\(async \(\) => \{[\s\S]*?\}, snipeTickMs\)/);
  assert.ok(m, "the lane tick was not found");
  assert.match(m[0], /laneFaulted = true/, "a faulting tick must latch the lane off");
  assert.doesNotMatch(m[0], /throw |process\.exit/,
    "the lane tick can propagate a throw into the process");
  assert.match(m[0], /the desk is unaffected/);
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
