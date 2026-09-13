/**
 * THE OFFER TO OTHER FLOORS, PINNED (owner, 2026-09-13: "how can we provide this same
 * service to the other floors"). Four things, each in the file that carries it:
 *
 *   1. the installer can lift its own entry pause the moment the new release is running
 *      (--resume-entries), and only then;
 *   2. the README says a small Linux server you own is the 24/7 option, and says how
 *      to resume entries after the upgrade that paused them;
 *   3. the tower shows the house bot's real record beside every lease offer and on HQ,
 *      from the public house book, and says what leasing a floor gets you;
 *   4. the Team tab's self-hosted card names the server option without calling
 *      self-hosting hard work.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const install = read("./executor/install.sh");
const readme = read("./executor/README.md");
const tower = read("./viewer/tower.html");
const floor = read("./viewer/office3d.html");

/* 1 · --resume-entries */
assert.match(install, /--resume-entries\) RESUME_ENTRIES=1; shift;;/, "the installer parses --resume-entries");
assert.match(install, /^RESUME_ENTRIES=0$/m, "…and it is off by default");
assert.match(install, /--resume-entries\s+Lift the entry pause as soon as the new release is\n\s+running\./, "…and --help explains it");
const lift = install.indexOf('if [ "$RESUME_ENTRIES" -eq 1 ] && [ "${ACTIVATION_COMMITTED:-0}" -eq 1 ]; then');
assert.ok(lift > 0, "the pause is lifted only when the operator asked AND the new release is the running one");
assert.ok(lift > install.lastIndexOf("ACTIVATION_COMMITTED=1"), "…after every activation point, never before");
assert.ok(lift > install.indexOf("prune_releases \"$RELEASES_DIR\""), "…after the release is pruned into place");
assert.ok(lift < install.indexOf("Resume entries: rm -f $PAUSE_FILE"), "…before the closing summary that names the file");
assert.match(install.slice(lift, lift + 600), /rm -f "\$PAUSE_FILE"/, "…and it removes exactly the pause file");
assert.ok(!/rm -f "\$HARD_STOP_FILE"/.test(install.slice(lift, lift + 600)), "…never the hard stop");
assert.match(install, /Resume entries: rm -f \$PAUSE_FILE\s+\(or pass --resume-entries next time\)/, "the summary teaches the flag");
execFileSync("bash", ["-n", new URL("./executor/install.sh", import.meta.url).pathname]);

/* 2 · the README */
assert.match(readme, /\*\*A small Linux server you own is the 24\/7 option\.\*\*/, "the README names the server option up front");
assert.match(readme, /\*\*Every install and upgrade creates it\*\*/, "…and says every upgrade pauses entries");
assert.match(readme, /pass `--resume-entries`/, "…and how to lift it from the command line");

/* 3 · the tower */
assert.match(tower, /async function loadHouseBook\(\)/, "the tower reads the public house book");
assert.match(tower, /window\.__houseBook = data\?\.houseBot\?\.ledger \? data\.houseBot : null;/, "…from the heartbeat's houseBot");
assert.match(tower, /setInterval\(loadHouseBook, 60000\);/, "…once a minute");
assert.match(tower, /houseRecord\("The house bot, with the house's own money (?:\\u00b7|·) live", HOUSE_OFFER\)/, "the lease offer carries the house record");
assert.match(tower, /houseRecord\("WALL-ST-E (?:\\u00b7|·) the house bot's live book", null\)/, "…and HQ's own card carries it");
assert.match(tower, /cell\("all-time, its own journal", s\(lg\.realizedSol\)/, "the record is the journal's realised P&L");
assert.match(tower, /cell\("open now", /, "…with what is open now");
assert.match(tower, /The key is made on your machine and never leaves it\./, "the offer states custody plainly");
assert.match(tower, /on a small Linux server you own/, "…and names the 24\/7 option");
assert.match(tower, /\.house\{margin:8px 0 4px;/, "the record has its own style");

/* 4 · the Team tab's self-hosted card */
assert.match(floor, /a small Linux server you own works better, "\n\s*\+ "because systemd keeps it running 24\/7 and it never sleeps\./,
  "the self-hosted card names the server option");
assert.match(floor, /badge: "AVAILABLE NOW",/, "…and is still the track that is available now");

console.log("\nthe offer to other floors: --resume-entries, the server option, the house record on the tower, and the Team card\n");
