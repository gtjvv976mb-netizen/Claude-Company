/**
 * Install smoke test: does a fresh published install contain its full module graph
 * and preserve the dry-run secret boundary?
 * The one-command installer once shipped a bot that crashed on its first line
 * because poller.mjs imports strategy.mjs and only poller.mjs was downloaded.
 * Missing a relative import leaves the service dead on its first line.
 *   node test-install.mjs [https://claudedotcompany.com | ../dist]
 */
import fs from "node:fs";
import path from "node:path";
const target = process.argv[2] || "https://claudedotcompany.com";
const localRoot = fs.existsSync(target) ? path.resolve(target) : null;
const site = target.replace(/\/$/, "");
const need = ["poller.mjs", "strategy.mjs", "trade-policy.mjs", "install.sh"];
let fail = 0;
const sources = new Map();
for (const f of need) {
  let ok, status, body = "";
  if (localRoot) {
    const file = path.join(localRoot, "executor", f);
    ok = fs.existsSync(file) && fs.statSync(file).isFile();
    status = ok ? "local" : "missing";
    if (ok) body = fs.readFileSync(file, "utf8");
  } else {
    const r = await fetch(`${site}/executor/${f}`);
    ok = r.ok; status = r.status;
    if (ok) body = await r.text();
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${f} served (${status})`);
  if (!ok) { fail++; continue; }
  sources.set(f, body);
  fs.writeFileSync(`/tmp/cc-inst-${f}`, body);
}
// Every relative import in every shipped module must also be published.
for (const [owner, src] of sources) {
  if (!owner.endsWith(".mjs")) continue;
  for (const m of src.matchAll(/from\s+"\.\/([^"]+)"/g)) {
    const ok = need.includes(m[1]);
    console.log(`${ok ? "PASS" : "FAIL"}  ${owner} imports ./${m[1]} and it is published`);
    if (!ok) fail++;
  }
}
const installer = fs.existsSync("/tmp/cc-inst-install.sh") ? fs.readFileSync("/tmp/cc-inst-install.sh", "utf8") : "";
const secureSecret = installer.includes("--secret-file") && installer.includes("EnvironmentFile=") &&
  !installer.includes("Environment=CC_SECRET=") && !installer.includes("--secret <");
console.log(`${secureSecret ? "PASS" : "FAIL"}  installer keeps the secret out of argv and the systemd unit`);
if (!secureSecret) fail++;
const privateFiles = installer.includes('chmod 600 "$ENV_FILE"') &&
  installer.includes("chmod 600 burner.json") && installer.includes("umask 077");
console.log(`${privateFiles ? "PASS" : "FAIL"}  secret, key, and created state default to owner-only permissions`);
if (!privateFiles) fail++;
const dryOnly = /rejects EXECUTE=1|intentionally rejects EXECUTE=1/.test(installer) &&
  !/change EXECUTE=0 to EXECUTE=1/.test(installer);
console.log(`${dryOnly ? "PASS" : "FAIL"}  installer documents the fail-closed dry-run release`);
if (!dryOnly) fail++;
const fetchesPolicy = /for f in poller\.mjs strategy\.mjs trade-policy\.mjs/.test(installer);
console.log(`${fetchesPolicy ? "PASS" : "FAIL"}  installer fetches the shared trade policy`);
if (!fetchesPolicy) fail++;
console.log(fail ? `\n${fail} failed — the published install is BROKEN` : "\nA fresh install has every module it needs.");
process.exit(fail ? 1 : 0);
