import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertExactGitHead, readGitHead, readGitStatus } from "./services/codex-improvement/checkout.mjs";

const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-checkout-test-"));
const shadow = await fs.mkdtemp(path.join(os.tmpdir(), "codex-git-shadow-test-"));
const git = (...args) => execFileSync("git", args, {
  cwd: repo,
  encoding: "utf8",
  env: {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: "/tmp",
  },
}).trim().toLowerCase();

console.log("\nCODEX CHECKOUT PROVENANCE IS RESOLVED FROM GIT");
try {
  git("init", "--quiet");
  git("config", "user.name", "Claude Company test");
  git("config", "user.email", "test@invalid.example");
  await fs.writeFile(path.join(repo, "fixture.txt"), "first\n");
  git("add", "fixture.txt");
  git("commit", "--quiet", "-m", "first");
  const first = git("rev-parse", "HEAD");

  assert.equal(await readGitHead(repo), first);
  await assertExactGitHead(repo, first);
  console.log("  ✓ the exact checked-out commit is accepted");

  await fs.writeFile(path.join(repo, "fixture.txt"), "second\n");
  git("add", "fixture.txt");
  git("commit", "--quiet", "-m", "second");
  const second = git("rev-parse", "HEAD");
  assert.notEqual(second, first);
  await assert.rejects(() => assertExactGitHead(repo, first), /does not match/);
  console.log("  ✓ a different clean commit is rejected");

  await fs.writeFile(path.join(shadow, "git"), "#!/bin/sh\nprintf '%s\\n' '0000000000000000000000000000000000000000'\n");
  await fs.chmod(path.join(shadow, "git"), 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shadow}:${originalPath || ""}`;
  try {
    assert.equal(await readGitHead(repo), second);
    assert.equal(await readGitStatus(repo), "");
  } finally {
    process.env.PATH = originalPath;
  }
  console.log("  ✓ a PATH-shadowed git binary cannot fake HEAD or status");

  await assert.rejects(() => assertExactGitHead(repo, "not-a-commit"), /invalid/);
  console.log("  ✓ an invalid workflow commit is rejected");
  console.log("\n4 passed, 0 failed\n");
} finally {
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(shadow, { recursive: true, force: true });
}
