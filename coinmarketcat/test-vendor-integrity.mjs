/**
 * THE VENDORED EXECUTOR IS THE EXECUTOR: BYTE FOR BYTE, FROM A NAMED COMMIT.
 *
 * Every module under vendor/executor/ must hash to what PROVENANCE.json recorded when
 * scripts/sync-executor.mjs copied it, the provenance must name a real 40-character
 * commit of the upstream repository, and nothing under src/ may import the executor by
 * any path but vendor/. A local edit to a vendored file is the one change this
 * repository refuses on principle: what the bot refuses is decided upstream.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MODULES, UPSTREAM, STAND_INS, readProvenance } from "./scripts/sync-executor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(here, "vendor", "executor");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

console.log("\nPROVENANCE\n──────────");
const p = readProvenance();
ok("the provenance names the upstream repository", p.sourceRepo === UPSTREAM, p.sourceRepo);
ok("the provenance names a 40-character commit", /^[0-9a-f]{40}$/.test(p.sourceCommit ?? ""), p.sourceCommit);
ok("the provenance lists exactly the modules the sync copies", JSON.stringify(Object.keys(p.modules ?? {}).sort()) === JSON.stringify([...MODULES].sort()), `${Object.keys(p.modules ?? {}).length} of ${MODULES.length}`);

console.log("\nTHE BYTES\n─────────");
for (const name of MODULES) {
  const file = path.join(VENDOR, name);
  if (!fs.existsSync(file)) { ok(`${name} is present`, false); continue; }
  const h = sha256(file);
  ok(`${name} matches the manifest`, h === p.modules[name], h.slice(0, 12));
}
const stray = fs.readdirSync(VENDOR).filter((f) => f !== "PROVENANCE.json" && !MODULES.includes(f) && !(f in STAND_INS));
ok("nothing else lives under vendor/executor", stray.length === 0, stray.join(", ") || "clean");
for (const [name, from] of Object.entries(STAND_INS))
  ok(`${name} is the shim, byte for byte — a stand-in, named as one in the provenance`, sha256(path.join(VENDOR, name)) === sha256(from) && (p.standIns ?? []).includes(name), (p.standIns ?? []).join(", "));

console.log("\nTHE IMPORTS\n───────────");
const sources = walk(path.join(here, "src")).filter((f) => /\.(mjs|js)$/.test(f));
for (const file of sources) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(here, file);
  const outside = (text.match(/from\s+["'][^"']*executor\/[^"']+["']/g) ?? []).filter((s) => !/vendor\/executor\//.test(s));
  ok(`${rel} imports the executor only through vendor/`, outside.length === 0, outside.join(" ") || "ok");
}
const vendoredImports = new Set();
for (const name of MODULES) {
  const text = fs.readFileSync(path.join(VENDOR, name), "utf8");
  for (const m of text.matchAll(/from\s+["']\.\/([^"']+)["']/g)) vendoredImports.add(m[1]);
}
const missing = [...vendoredImports].filter((f) => !MODULES.includes(f) && !(f in STAND_INS));
ok("every relative import inside the vendored closure is itself vendored (jupiter.mjs is the stand-in)", missing.length === 0, missing.join(", ") || "closed");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
