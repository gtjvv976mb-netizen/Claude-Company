import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCodeEvidence } from "./services/codex-improvement/code-evidence.mjs";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "codex-evidence-test-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codex-evidence-outside-"));
const proposal = (evidence) => ({ proposals: [{ evidence: [evidence] }] });
const code = (over = {}) => ({
  kind: "code", path: "source.js", lineStart: 1, lineEnd: 2,
  observation: "fixture", ...over,
});
const rejects = async (name, fn) => {
  await assert.rejects(fn);
  console.log(`  ✓ ${name}`);
};

console.log("\nCODEX CODE EVIDENCE IS GROUNDED IN THE CLEAN CHECKOUT");
try {
  await fs.writeFile(path.join(sandbox, "source.js"), "one\ntwo\nthree\n");
  await fs.writeFile(path.join(outside, "outside.js"), "outside\n");
  await validateCodeEvidence(proposal(code()), sandbox);
  console.log("  ✓ a real in-root line range is accepted");
  await rejects("a nonexistent citation is rejected", () =>
    validateCodeEvidence(proposal(code({ path: "invented.js" })), sandbox));
  await rejects("an invented line range is rejected", () =>
    validateCodeEvidence(proposal(code({ lineStart: 50, lineEnd: 50 })), sandbox));
  await rejects("a traversal citation is rejected", () =>
    validateCodeEvidence(proposal(code({ path: "../codex-evidence-outside-/outside.js" })), sandbox));
  await fs.symlink(path.join(outside, "outside.js"), path.join(sandbox, "linked.js"));
  await rejects("a symlink citation is rejected", () =>
    validateCodeEvidence(proposal(code({ path: "linked.js", lineEnd: 1 })), sandbox));
  console.log("\n5 passed, 0 failed\n");
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
