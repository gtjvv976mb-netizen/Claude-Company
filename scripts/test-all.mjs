import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The installer smoke test intentionally talks to the deployed public site. It is a
// release check, not a hermetic unit test, and would make an ordinary build depend on
// network state. Every other test is discovered so newly-added regressions join CI
// without somebody remembering to update a second list.
const rootTests = fs.readdirSync(root)
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort();
const executorTests = fs.readdirSync(path.join(root, "executor"))
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== "test-install.mjs")
  .sort()
  .map((name) => path.join("executor", name));
const tests = [...rootTests, ...executorTests];

let failed = 0;
const started = Date.now();

for (const test of tests) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-test-"));
  const dbFile = path.join(sandbox, "journal.sqlite");
  process.stdout.write(`\n\u2501\u2501 ${test} \u2501\u2501\n`);
  const run = spawnSync(process.execPath, [test], {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLAUDE_CO_DB: dbFile,
      // A regression test must never spend model credit merely because the developer
      // running it happens to have a populated shell.
      ANTHROPIC_API_KEY: "",
      XAI_API_KEY: "",
      EXECUTE: "0",
    },
  });
  fs.rmSync(sandbox, { recursive: true, force: true });

  if (run.status !== 0) {
    failed++;
    const why = run.error?.message || run.signal || `exit ${run.status}`;
    console.error(`FAIL ${test} (${why})`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${tests.length - failed}/${tests.length} test files passed in ${elapsed}s.`);
if (failed) console.error(`${failed} test file${failed === 1 ? "" : "s"} failed.`);
process.exit(failed ? 1 : 0);
