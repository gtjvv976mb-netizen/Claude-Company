#!/usr/bin/env node
/**
 * THE VENDORED DECISION CODE, AND WHERE IT CAME FROM.
 *
 * This repository does not decide anything of its own. The entry contract, the exit
 * determiner, the curve arithmetic, the pump.fun encoders and the shadow book are the
 * Claude Company executor's (WALL-ST-E's), copied into vendor/executor/ from an exact
 * commit of that repository and hashed. A change to what this bot refuses is a change
 * upstream, synced here, and visible in PROVENANCE.json — never a local edit.
 *
 *   node scripts/sync-executor.mjs --from ../Claude-Company     # copy from a checkout, record its HEAD and branch
 *   node scripts/sync-executor.mjs --check                       # clone the recorded branch shallowly, report drift
 *   node scripts/sync-executor.mjs --check --ref main            # …against upstream main instead
 *   node scripts/sync-executor.mjs --check --strict              # …and exit 1 on drift (CI)
 *
 * `--check` with no `--ref` compares against the branch the vendored commit was synced
 * from (PROVENANCE.json's `sourceRef`), because that is the question "has upstream moved
 * since this was vendored?" asks. A branch not yet merged to main differs from main by
 * construction; `--ref main` says by how much, and says it as a difference, not a move.
 *
 * test-vendor-integrity.mjs refuses a vendored file whose bytes do not match the manifest,
 * so a hand edit under vendor/ fails the suite by name.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const VENDOR = path.join(ROOT, "vendor", "executor");
const PROVENANCE = path.join(VENDOR, "PROVENANCE.json");
export const UPSTREAM = "https://github.com/gtjvv976mb-netizen/Claude-Company";

/** The closure the bundle needs (from esbuild's metafile), plus what the tests read. A
 *  name may sit one folder down (fixtures/…): it is vendored, hashed and checked the same. */
export const MODULES = Object.freeze([
  "entry-sizing.mjs",
  "network-fee-budget.mjs",
  "snipe-book.mjs",
  "snipe-curve.mjs",
  "snipe-entry.mjs",
  "snipe-lane.mjs",
  "snipe-policy.mjs",
  "snipe-shadow.mjs",
  "snipe-socials.mjs",
  "snipe-venue-pumpfun.mjs",
  "snipe-venue.mjs",
  "sol-usd-oracle.mjs",
  "strategy.mjs",
  "token2022.mjs",
  "trade-policy.mjs",
  "shadow-sink.mjs",            // tests only: reads the exported JSONL back
  "grade-entry-gates.mjs",      // the grader, so `node vendor/executor/grade-entry-gates.mjs --file` works here
  "test-snipe-stall-default.mjs", // the regression that pins the stall-default fix
  "test-snipe-quote-mint.mjs",  // the regression that pins the stock-quote contract (pump.fun Custom Pairs)
  "fixtures/pumpfun-xstock-quote.json", // its live bytes (xStock mints, a GLDx-quoted curve); test-hawk-engine.mjs reads them too
]);

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

/**
 * THE ONE FILE UNDER vendor/executor/ THAT IS NOT THE EXECUTOR'S. snipe-venue.mjs and
 * snipe-venue-pumpfun.mjs import "./jupiter.mjs" for the wrapped-SOL mint; the real
 * jupiter.mjs is the executor's whole Jupiter path and drags the SQLite journal in, so
 * the browser bundle already swaps it for src/shims/jupiter.mjs. Node needs the same file
 * to exist beside the vendored modules for the tests to import them, so the sync writes
 * the shim there, byte for byte, and PROVENANCE names it as a stand-in.
 */
export const STAND_INS = Object.freeze({ "jupiter.mjs": path.join(ROOT, "src", "shims", "jupiter.mjs") });
export function writeStandIn() {
  for (const [name, from] of Object.entries(STAND_INS)) fs.copyFileSync(from, path.join(VENDOR, name));
}

export function readProvenance() {
  return JSON.parse(fs.readFileSync(PROVENANCE, "utf8"));
}

export function manifestOf(dir) {
  const out = {};
  for (const name of MODULES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`${name} is missing from ${dir}`);
    out[name] = sha256(file);
  }
  return out;
}

export function syncFrom(checkout) {
  const src = path.join(checkout, "executor");
  if (!fs.existsSync(path.join(src, "snipe-entry.mjs"))) throw new Error(`${checkout} is not a Claude-Company checkout (no executor/snipe-entry.mjs)`);
  const commit = git(["rev-parse", "HEAD"], checkout);
  const dirty = git(["status", "--porcelain", "--", "executor"], checkout);
  if (dirty) throw new Error(`the checkout at ${checkout} has uncommitted changes under executor/ — sync from a committed tree so the recorded commit is the truth:\n${dirty}`);
  const committedAt = git(["show", "-s", "--format=%cI", "HEAD"], checkout);
  let branch = null;
  try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"], checkout); } catch { branch = null; }
  if (branch === "HEAD" || !branch) branch = null;     // a detached checkout names no branch
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const name of MODULES) {
    fs.mkdirSync(path.dirname(path.join(VENDOR, name)), { recursive: true });   // fixtures/ is made, never assumed
    fs.copyFileSync(path.join(src, name), path.join(VENDOR, name));
  }
  writeStandIn();
  const provenance = {
    sourceRepo: UPSTREAM,
    sourceCommit: commit,
    sourceCommittedAt: committedAt,
    sourceRef: branch,
    modules: manifestOf(VENDOR),
    standIns: Object.keys(STAND_INS),
    note: "Copied verbatim from executor/ at sourceCommit by scripts/sync-executor.mjs. Never edit these files here; change them upstream and sync.",
  };
  fs.writeFileSync(PROVENANCE, JSON.stringify(provenance, null, 2) + "\n");
  return provenance;
}

export function checkAgainstUpstream({ ref = "main" } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-"));
  try {
    git(["clone", "--depth", "1", "--branch", ref, "--filter=blob:none", "--sparse", UPSTREAM, tmp], ROOT);
    git(["sparse-checkout", "set", "executor"], tmp);
    const upstreamCommit = git(["rev-parse", "HEAD"], tmp);
    /* A module upstream does not carry yet (a vendored commit ahead of main, as with a fix
       that is still in a pull request) is drift to REPORT, not a reason to crash before the
       report is printed. */
    const theirs = {};
    for (const name of MODULES) {
      const f = path.join(tmp, "executor", name);
      theirs[name] = fs.existsSync(f) ? sha256(f) : null;
    }
    const ours = readProvenance();
    const drift = MODULES.filter((name) => theirs[name] !== ours.modules[name]);
    const notUpstream = MODULES.filter((name) => theirs[name] === null);
    const local = MODULES.filter((name) => sha256(path.join(VENDOR, name)) !== ours.modules[name]);
    return { upstreamCommit, vendoredCommit: ours.sourceCommit, drift, notUpstream, localEdits: local };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;
  const check = args.includes("--check");
  const strict = args.includes("--strict");
  let recordedRef = null;
  try { recordedRef = readProvenance().sourceRef ?? null; } catch { recordedRef = null; }
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : (recordedRef ?? "main");
  if (from) {
    const p = syncFrom(path.resolve(from));
    console.log(`synced ${MODULES.length} modules from ${p.sourceCommit} (${p.sourceCommittedAt})`);
  } else if (check) {
    const r = checkAgainstUpstream({ ref });
    console.log(`vendored: ${r.vendoredCommit}${recordedRef ? ` (from ${recordedRef})` : ""}\nupstream ${ref}: ${r.upstreamCommit}`);
    if (r.localEdits.length) console.log(`LOCAL EDITS under vendor/ (never do this): ${r.localEdits.join(", ")}`);
    if (r.notUpstream.length) console.log(`not on upstream ${ref} yet (the vendored commit is ahead of it): ${r.notUpstream.join(", ")}`);
    const moved = r.drift.filter((name) => !r.notUpstream.includes(name));
    if (moved.length && r.notUpstream.length)
      console.log(`upstream ${ref} differs in: ${moved.join(", ")} — ${ref} lacks files the vendored commit carries, so it is likely BEHIND it, not ahead`);
    else if (moved.length) console.log(`upstream ${ref} has moved in: ${moved.join(", ")}\n→ node scripts/sync-executor.mjs --from <checkout at ${r.upstreamCommit}>`);
    if (!r.drift.length) console.log("no drift: the vendored modules match upstream byte for byte");
    if (strict && (r.drift.length || r.localEdits.length)) process.exit(1);
  } else {
    console.log("usage: sync-executor.mjs --from <Claude-Company checkout> | --check [--strict] [--ref <branch>]");
    process.exit(2);
  }
}
