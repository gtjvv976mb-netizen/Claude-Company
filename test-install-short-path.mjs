import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ── TWO URLS, ONE INSTALLER ──────────────────────────────────────────────────
 * /executor/install.sh has served 200 for weeks; nobody could be expected to find
 * it, so the build now publishes the same script at /install.sh and the site's copy
 * button hands over `curl -fsSL .../install.sh | bash -s -- --floor N`.
 *
 * The failure this file exists to prevent is TWO installers on one domain. If the
 * short path were written from a second copy step — a staging leftover, a partial
 * rebuild, a rename that only touched one of them — the domain would serve one
 * script people audited and one they did not, and a reader piping a URL into bash
 * has no way to tell which they got. So this asserts the published bytes are equal
 * AND prints both digests, because "identical" is a claim and a digest is evidence.
 *
 * It also checks the digest the page STATES equals the digest of the file the same
 * build PUBLISHED. A checksum a reader cannot rely on teaches them to skip checksums.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const built = spawnSync(process.execPath, ["scripts/build-viewer.mjs"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, EXECUTOR_COMMIT: "a".repeat(40), SOURCE_COMMIT: "a".repeat(40) },
});
assert.equal(built.status, 0, built.stderr || built.stdout);

const shortPath = path.join(root, "dist", "install.sh");
const longPath = path.join(root, "dist", "executor", "install.sh");
for (const p of [shortPath, longPath]) {
  assert.ok(fs.existsSync(p), `the build must publish ${path.relative(root, p)} — it does not`);
}
const shortBytes = fs.readFileSync(shortPath);
const longBytes = fs.readFileSync(longPath);
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const shortSha = sha(shortBytes);
const longSha = sha(longBytes);
console.log(`  dist/install.sh           ${shortBytes.length} bytes  sha256 ${shortSha}`);
console.log(`  dist/executor/install.sh  ${longBytes.length} bytes  sha256 ${longSha}`);
assert.equal(shortSha, longSha,
  `the two published installers differ: /install.sh is ${shortSha}, /executor/install.sh is ${longSha}`);

/* And both must equal the repo's own installer — a build that transformed the script
   on its way out (a placeholder substitution applied too broadly, say) would publish
   something no reviewer has read. */
const repoSha = sha(fs.readFileSync(path.join(root, "executor", "install.sh")));
assert.equal(shortSha, repoSha,
  `the published installer is not the repo's: published ${shortSha}, executor/install.sh ${repoSha}`);

/* `./install.sh` after a download must work, not just `bash install.sh`. */
for (const p of [shortPath, longPath]) {
  const mode = fs.statSync(p).mode & 0o777;
  assert.ok(mode & 0o111, `${path.relative(root, p)} must be executable, mode is ${mode.toString(8)}`);
}

/* ── THE DOUBLE-CLICK LAUNCHER ────────────────────────────────────────────────
 * Finder refuses to run a .command without the executable bit, so the bit IS the
 * artifact. The source file belongs to the installer side of this work; while it is
 * still landing this reports its absence loudly rather than failing the site build,
 * and asserts the mode the moment it exists. */
const LAUNCHER = "Install WALL-ST-E.command";
const launcherSrc = path.join(root, "executor", LAUNCHER);
const launcherOut = path.join(root, "dist", "executor", LAUNCHER);
if (fs.existsSync(launcherSrc)) {
  assert.ok(fs.existsSync(launcherOut), `executor/${LAUNCHER} exists but the build did not publish it`);
  const mode = fs.statSync(launcherOut).mode & 0o777;
  assert.ok(mode & 0o111, `the published launcher must be executable, mode is ${mode.toString(8)}`);
  assert.equal(sha(fs.readFileSync(launcherOut)), sha(fs.readFileSync(launcherSrc)),
    "the published launcher is not the repo's launcher");
  console.log(`  dist/executor/${LAUNCHER}  mode ${mode.toString(8)}`);
} else {
  console.log(`  NOTE: executor/${LAUNCHER} not present yet — launcher publication unverified`);
}

/* ── WHAT THE PAGE TELLS A READER TO RUN ──────────────────────────────────────
 * The built floor page, not the source: substitution is exactly where this can go
 * wrong, and an unsubstituted placeholder on the live site is a checksum of nothing. */
const floor = fs.readFileSync(path.join(root, "dist", "floor.html"), "utf8");
assert.ok(floor.includes("curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor "),
  "the built page must carry the one-command install pointed at the short path");
assert.doesNotMatch(floor, /__CLAUDE_COMPANY_INSTALLER_SHA256__/,
  "the installer digest placeholder must be substituted at build time");
assert.doesNotMatch(floor, /__CLAUDE_COMPANY_SOURCE_COMMIT__/,
  "the release commit placeholder must be substituted at build time");
const stated = [...floor.matchAll(/const installerSha256 = "([0-9a-f]{64})"/g)].map((m) => m[1]);
assert.equal(stated.length, 1, `expected exactly one stated digest in the page, found ${stated.length}`);
console.log(`  page states sha256        ${stated[0]}`);
assert.equal(stated[0], shortSha,
  `the page states ${stated[0]} but the build published ${shortSha} — a reader's checksum would fail`);

/* The build stamps whatever origin it is publishing to, so a staging build cannot
   send its readers at the production installer. */
const staged = spawnSync(process.execPath, ["scripts/build-viewer.mjs"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    EXECUTOR_COMMIT: "a".repeat(40),
    SOURCE_COMMIT: "a".repeat(40),
    SITE_URL: "https://staging.example",
  },
});
assert.equal(staged.status, 0, staged.stderr || staged.stdout);
const stagedFloor = fs.readFileSync(path.join(root, "dist", "floor.html"), "utf8");
assert.ok(stagedFloor.includes("curl -fsSL https://staging.example/install.sh | bash -s -- --floor "),
  "a build published to another origin must point its install line at that origin");
assert.ok(!stagedFloor.includes("https://claudedotcompany.com/install.sh"),
  "...and must not leave the production installer URL behind");

/* Leave dist pointed at the production origin. The staging build above rewrote every
   install line to staging.example, and a dist left in that state is a trap for the next
   person who opens it — or for a deploy step that ships whatever is already on disk.
   (The commit env stays: a bare build throws under CI by design.) */
const restored = spawnSync(process.execPath, ["scripts/build-viewer.mjs"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, EXECUTOR_COMMIT: "a".repeat(40), SOURCE_COMMIT: "a".repeat(40) },
});
assert.equal(restored.status, 0, restored.stderr || restored.stdout);

console.log(`short-path installer publishes identically at both URLs (sha256 ${shortSha})`);
