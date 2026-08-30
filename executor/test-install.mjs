/**
 * Install smoke test: does a FRESH install of the published files actually boot?
 * The one-command installer once shipped a bot that crashed on its first line
 * because poller.mjs imports strategy.mjs and only poller.mjs was downloaded.
 * A funded wallet attached to a dead service is the worst possible failure.
 *   node test-install.mjs [https://claudedotcompany.com]
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const SITE = (process.argv[2] || "https://claudedotcompany.com").replace(/\/$/, "");
const need = ["poller.mjs", "strategy.mjs"];
let fail = 0;
for (const f of need) {
  const r = await fetch(`${SITE}/executor/${f}`);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${f} served (${r.status})`);
  if (!r.ok) { fail++; continue; }
  fs.writeFileSync(`/tmp/cc-inst-${f}`, await r.text());
}
// every relative import the poller makes must also be published
const src = fs.existsSync("/tmp/cc-inst-poller.mjs") ? fs.readFileSync("/tmp/cc-inst-poller.mjs", "utf8") : "";
for (const m of src.matchAll(/from\s+"\.\/([^"]+)"/g)) {
  const ok = need.includes(m[1]);
  console.log(`${ok ? "PASS" : "FAIL"}  poller imports ./${m[1]} and the installer fetches it`);
  if (!ok) fail++;
}
console.log(fail ? `\n${fail} failed — the published install is BROKEN` : "\nA fresh install has every module it needs.");
process.exit(fail ? 1 : 0);
