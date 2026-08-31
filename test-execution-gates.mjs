import assert from "node:assert/strict";
import fs from "node:fs";
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
console.log("browser execution retirement gates: ok");
