import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";

/** Explicit behavior surface. This module has no config/.env side effects so the
 * isolated reviewer can recompute membership from its trusted checkout. */
export const DECISION_MANIFEST_FILES = Object.freeze([
  "DESK.md",
  "package.json",
  "package-lock.json",
  "executor/trade-policy.mjs",
  "src/agents/analysts.js",
  "src/agents/ceo.js",
  "src/agents/compliance.js",
  "src/agents/composite.js",
  "src/agents/decision.js",
  "src/agents/redteam-policy.js",
  "src/agents/review.js",
  "src/agents/risk-rails.js",
  "src/agents/schemas.js",
  "src/alerts.js",
  "src/canonical.js",
  "src/calls.js",
  "src/categories.js",
  "src/config.js",
  "src/copy.js",
  "src/data/dexscreener.js",
  "src/data/evidence.js",
  "src/data/gmgn.js",
  "src/data/jupiter.js",
  "src/data/pumpfun.js",
  "src/data/regime.js",
  "src/data/snapshots.js",
  "src/data/solana.js",
  "src/desk.js",
  "src/devrep.js",
  "src/evaluation.js",
  "src/execution-gates.js",
  "src/funnel.js",
  "src/identity.js",
  "src/leasing.js",
  "src/lib/base58.js",
  "src/lib/bus.js",
  "src/lib/grok.js",
  "src/lib/http.js",
  "src/lib/llm.js",
  "src/lib/store.js",
  "src/mandate.js",
  "src/manifest.js",
  "src/market.js",
  "src/order.js",
  "src/penthouse.js",
  "src/provenance.js",
  "src/report.js",
  "src/scanner.js",
  "src/shadow.js",
  "src/trends.js",
  "src/tower.js",
  "src/watchlist.js",
  "src/whales.js",
]);

export function discoveredTestFiles(root) {
  const rootTests = fs.readdirSync(root).filter((name) => /^test-.*\.mjs$/.test(name));
  const executorTests = fs.readdirSync(path.join(root, "executor"))
    .filter((name) => /^test-.*\.mjs$/.test(name))
    .map((name) => path.posix.join("executor", name));
  return [...rootTests, ...executorTests];
}

export function digestManifestFiles(root, files) {
  const realRoot = fs.realpathSync(root);
  const entries = [...files].sort().map((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    const insideRoot = absolutePath.startsWith(`${root}${path.sep}`);
    const stat = insideRoot ? fs.lstatSync(absolutePath) : null;
    const realPath = insideRoot ? fs.realpathSync(absolutePath) : "";
    const realInsideRoot = realPath.startsWith(`${realRoot}${path.sep}`);
    if (!insideRoot || !realInsideRoot || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`unsafe or missing manifest file: ${relativePath}`);
    }
    return { path: relativePath, sha256: sha256(fs.readFileSync(absolutePath)) };
  });
  return { files: entries, hash: sha256(canonicalJson(entries)) };
}

export const buildDecisionManifest = (root) => ({
  schemaVersion: "decision-manifest.v1",
  ...digestManifestFiles(root, DECISION_MANIFEST_FILES),
});

export const buildTestManifest = (root) => ({
  schemaVersion: "test-manifest.v1",
  ...digestManifestFiles(root, ["scripts/test-all.mjs", ...discoveredTestFiles(root)]),
});
