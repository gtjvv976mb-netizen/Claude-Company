import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  DECISION_MANIFEST_FILES,
  buildDecisionManifest,
  buildTestManifest,
} from "./manifest.js";

export { canonicalJson, sha256 } from "./canonical.js";

/**
 * Files that define how the desk reasons, vetoes, sizes, and publishes. The list is
 * deliberately explicit: provenance code must never wander into .env files, SQLite,
 * reports, credentials, or tenant material while trying to be helpful.
 */
export function decisionManifest() {
  return buildDecisionManifest(ROOT);
}

/** The exact regression files discovered by scripts/test-all.mjs. */
export function testManifest() {
  return buildTestManifest(ROOT);
}

export { DECISION_MANIFEST_FILES } from "./manifest.js";

export function deployedCommit() {
  const provided = process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || process.env.SOURCE_COMMIT;
  if (/^[0-9a-f]{7,40}$/i.test(provided || "")) return provided.toLowerCase();
  try {
    const dotGit = path.join(ROOT, ".git");
    const stat = fs.statSync(dotGit);
    const gitDir = stat.isDirectory() ? dotGit : path.resolve(ROOT,
      fs.readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/i, ""));
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    const match = head.match(/^ref:\s+([\w./-]+)$/);
    if (!match || match[1].includes("..")) return "unknown";
    const loose = path.join(gitDir, match[1]);
    if (fs.existsSync(loose)) {
      const value = fs.readFileSync(loose, "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    }
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      .split("\n").find((line) => line.endsWith(` ${match[1]}`));
    const value = packed?.split(" ")[0];
    return /^[0-9a-f]{40}$/i.test(value || "") ? value.toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}
