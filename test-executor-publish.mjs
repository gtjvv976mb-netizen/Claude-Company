import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE INSTALLER AND THE PUBLISHER MUST AGREE ───────────────────────────────
 * install.sh downloads a fixed list of runtime files from the published site and
 * runs `curl -f ... || exit 1`, so ONE missing file aborts every remote install.
 * The publish list in scripts/build-viewer.mjs drifted from it: token2022.mjs is
 * a runtime import of jupiter.mjs, the installer fetched it, the build never
 * published it, and https://claudedotcompany.com/executor/token2022.mjs was a
 * 404 — so the documented one-command install was broken outright.
 *
 * A comment already warned about this exact class of bug ("an install that
 * fetches this list without them dies at boot"). A comment is not a test. This
 * derives BOTH lists from the source and refuses any file the installer wants
 * and the build does not ship. */
const install = fs.readFileSync(new URL("./executor/install.sh", import.meta.url), "utf8");
const build = fs.readFileSync(new URL("./scripts/build-viewer.mjs", import.meta.url), "utf8");

const runtime = install.match(/RUNTIME_FILES=\(([^)]*)\)/)?.[1]?.trim().split(/\s+/) ?? [];
assert.ok(runtime.length >= 10, `could not read RUNTIME_FILES from install.sh (got ${runtime.length})`);

/* the live-mode source-integrity loop fetches the same set plus the manifests */
const sourceLoop = install.match(/for source_file in ([^;]+); do/)?.[1]?.trim().split(/\s+/) ?? [];
assert.ok(sourceLoop.length >= 10, "could not read the live source-file loop from install.sh");

const publishBlock = build.match(/const EXECUTOR_FILES = \[([\s\S]*?)\n\];/)?.[1] ?? "";
assert.ok(publishBlock, "could not read EXECUTOR_FILES from build-viewer.mjs");
const published = new Set([...publishBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

for (const f of new Set([...runtime, ...sourceLoop])) {
  assert.ok(published.has(f),
    `install.sh fetches executor/${f} but the build never publishes it — every remote install would abort on it`);
}

/* Every published .mjs must also exist, or the build throws at a worse moment. */
for (const f of published) {
  assert.ok(fs.existsSync(new URL(`./executor/${f}`, import.meta.url)),
    `EXECUTOR_FILES lists ${f}, which is not in executor/`);
}

/* And the runtime's own import graph must be inside the published set: a file that
 * poller.mjs or jupiter.mjs imports but the installer never fetches dies at boot. */
for (const entry of ["poller.mjs", "jupiter.mjs", "strategy.mjs"]) {
  const src = fs.readFileSync(new URL(`./executor/${entry}`, import.meta.url), "utf8");
  for (const [, spec] of src.matchAll(/^import\s[\s\S]*?from\s+"\.\/([^"]+)"/gm)) {
    assert.ok(published.has(spec),
      `${entry} imports ./${spec}, which the build does not publish — the installed bot would die at boot`);
  }
}

console.log(`executor publish list covers all ${runtime.length} installer runtime files and their imports`);
