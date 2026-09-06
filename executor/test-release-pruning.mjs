import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/* ── RELEASES ACCUMULATED FOREVER ─────────────────────────────────────────────
 * Every install left a ~136 MB release behind and nothing ever removed one.
 * Measured on one host: 28 releases, 3.6 GB. A small VPS is 25 GB, and the
 * journal writes with synchronous=FULL — a full disk stops the position book at
 * the moment an exit needs recording, which is the worst possible moment.
 *
 * The function is extracted from install.sh and RUN, so this tests behaviour. It
 * deletes directories, so every case below is proved by what survives on disk. */
const installer = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const start = installer.indexOf("# BEGIN RELEASE_PRUNER");
const end = installer.indexOf("# END RELEASE_PRUNER");
assert.ok(start >= 0 && end > start, "could not extract the pruner from install.sh");
const pruner = installer.slice(start, end);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

/* Build a releases tree with distinct mtimes, oldest first. */
function tree(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-prune-"));
  const releases = path.join(dir, "releases");
  fs.mkdirSync(releases);
  let t = Date.now() / 1000 - names.length * 100;
  for (const nm of names) {
    const d = path.join(releases, nm);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "poller.mjs"), "//");
    fs.utimesSync(d, t, t);
    t += 100;
  }
  return { dir, releases };
}
const prune = (releases, current, fresh, keep) => spawnSync("bash", ["-c",
  `set -euo pipefail\n${pruner}\nprune_releases "$1" "$2" "$3" "$4"`,
  "_", releases, current, fresh, String(keep)], { encoding: "utf8" });
const listing = (releases) => fs.readdirSync(releases).sort();

ok("keeps the running release, the new one, and KEEP_RELEASES others", () => {
  const { releases } = tree(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  const r = prune(releases, path.join(releases, "r2"), path.join(releases, "r7"), 2);
  assert.equal(r.status, 0, r.stderr);
  /* r7 is new, r2 is current, then the two newest of the rest: r6 and r5. */
  assert.deepEqual(listing(releases), ["r2", "r5", "r6", "r7"]);
});

ok("the running release survives even when it is the oldest of all", () => {
  const { releases } = tree(["ancient", "r2", "r3", "r4", "r5"]);
  const r = prune(releases, path.join(releases, "ancient"), path.join(releases, "r5"), 1);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(listing(releases).includes("ancient"), "never delete what the service is running");
  assert.ok(listing(releases).includes("r5"), "never delete the release just installed");
});

ok("keeping zero still keeps the running and the new release", () => {
  const { releases } = tree(["r1", "r2", "r3"]);
  const r = prune(releases, path.join(releases, "r1"), path.join(releases, "r3"), 0);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listing(releases), ["r1", "r3"]);
});

ok("nothing is deleted when there is nothing to spare", () => {
  const { releases } = tree(["r1", "r2"]);
  const r = prune(releases, path.join(releases, "r1"), path.join(releases, "r2"), 3);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listing(releases), ["r1", "r2"]);
});

ok("a symlink in the releases directory is never followed or removed", () => {
  const { dir, releases } = tree(["r1", "r2", "r3", "r4"]);
  const outside = path.join(dir, "precious");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "burner.json"), "[1,2,3]");
  fs.symlinkSync(outside, path.join(releases, "aaa-link"));
  const r = prune(releases, path.join(releases, "r4"), path.join(releases, "r4"), 0);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(outside, "burner.json")),
    "a symlink must not be a path out of the releases directory");
  assert.ok(fs.existsSync(path.join(releases, "aaa-link")), "and the link itself is left alone");
});

ok("sibling directories outside releases/ are untouched", () => {
  const { dir, releases } = tree(["r1", "r2", "r3"]);
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "journal.sqlite"), "x");
  const r = prune(releases, path.join(releases, "r3"), path.join(releases, "r3"), 0);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(state, "journal.sqlite")));
  assert.deepEqual(listing(releases), ["r3"]);
});

ok("a missing releases directory is a no-op, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-prune-"));
  const r = prune(path.join(dir, "nope"), "", "", 3);
  assert.equal(r.status, 0, r.stderr);
});

ok("the installer prunes only after activation is committed", () => {
  /* Anchored on ACTIVATION_COMMITTED, which install.sh itself documents as the line
     from which durable chain state may exist and no rollback is permitted. NOT on
     the first `systemctl restart`: there are two, and the earlier one is inside the
     rollback path — anchoring there let a prune call inserted before real activation
     pass this check. And EVERY call site is tested, not the first, because one
     correct call does not make a second one safe. */
  const commit = installer.indexOf("ACTIVATION_COMMITTED=1");
  assert.ok(commit >= 0, "could not find the activation commit point");
  const calls = [...installer.matchAll(/prune_releases\s+"\$RELEASES_DIR"/g)].map((m) => m.index);
  assert.ok(calls.length >= 1, "install.sh never prunes");
  for (const at of calls)
    assert.ok(at > commit,
      "pruning before activation could delete the release a failed start rolls back to");
});

console.log(`\n${n} release-pruning checks passed`);
