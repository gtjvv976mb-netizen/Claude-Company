import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TRUSTED_GIT = "/usr/bin/git";

function gitEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function runGit(root, args, maxBuffer) {
  await fs.access(TRUSTED_GIT, fs.constants.X_OK);
  return execFileAsync(TRUSTED_GIT, args, {
    cwd: root,
    env: gitEnvironment(),
    maxBuffer,
  });
}

/** Resolve HEAD through Git itself using a deliberately minimal environment. Ambient
 * GIT_DIR/GIT_WORK_TREE variables must never redirect provenance checks elsewhere. */
export async function readGitHead(root) {
  const { stdout } = await runGit(root, ["rev-parse", "--verify", "HEAD"], 64 * 1024);
  const head = stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("checkout HEAD is not a full Git commit");
  return head;
}

export async function readGitStatus(root) {
  const { stdout } = await runGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    1024 * 1024,
  );
  return stdout;
}

export async function assertExactGitHead(root, expectedCommit) {
  const expected = String(expectedCommit || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error("expected checkout commit is invalid");
  if (await readGitHead(root) !== expected) {
    throw new Error("checkout HEAD does not match the GitHub workflow commit");
  }
}
