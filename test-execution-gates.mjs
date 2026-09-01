import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { retiredBrowserRpcResponse } from "./src/execution-gates.js";

const retired = retiredBrowserRpcResponse();
assert.equal(retired.status, 410);
assert.match(retired.body.error, /retired|disabled/i);

// Defense in depth: the published source must not carry a dormant browser signer.
const viewer = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
for (const forbidden of ["sendRawTransaction", "VersionedTransaction", "Go live — trade for real"]) {
  assert.equal(viewer.includes(forbidden), false, `${forbidden} must not ship in the browser`);
}
assert.equal(viewer.includes("executorUrl: exec_.value"), false,
  "saving unrelated settings must not clear a dormant executor URL");
const legacyLiveInstallerUrl = new URL("./executor/install-live.sh", import.meta.url);
const legacyLiveInstallerPath = fileURLToPath(legacyLiveInstallerUrl);
const legacyLiveInstaller = fs.readFileSync(legacyLiveInstallerUrl, "utf8");
assert.match(legacyLiveInstaller, /is retired and changed nothing/);
for (const forbidden of ["EXECUTE=1", "JUPITER_API_KEY=", "LIVE_TRADING_ACK=", "LIVE_CAPS_ACK="]) {
  assert.equal(legacyLiveInstaller.includes(forbidden), false,
    `retired install-live.sh must not retain the old ${forbidden} environment rewrite`);
}
assert.notEqual(fs.statSync(legacyLiveInstallerPath).mode & 0o111, 0,
  "the retired compatibility entrypoint must remain executable so old invocations receive its refusal");
const retiredInstaller = spawnSync(legacyLiveInstallerPath, [], { encoding: "utf8" });
assert.equal(retiredInstaller.status, 2);
assert.match(retiredInstaller.stderr, /REFUSES: executor\/install-live\.sh is retired and changed nothing/);
console.log("browser execution retirement gates: ok");
