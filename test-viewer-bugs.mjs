/* FIVE DEFECTS THE CONTENT MAP FOUND, EACH PINNED SO IT CANNOT COME BACK.
 * Source-level, the way test-dashboard-ui.mjs pins the same file. */
import assert from "node:assert/strict";
import fs from "node:fs";
const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
let pass = 0; const ok = (n, f) => { f(); console.log("  ok  ", n); pass++; };

ok("(a) no JS-style \\uXXXX escape sits in raw HTML text — users saw the six characters \\u2014", () => {
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const hit = /\\u[0-9a-fA-F]{4}/.exec(markup);
  assert.equal(hit, null, hit ? `found ${hit[0]} in markup near: ${markup.slice(Math.max(0, hit.index - 40), hit.index + 40)}` : "");
});
ok("(b) the Callouts lead sentence is whole again", () => {
  assert.doesNotMatch(html, /coin\.ucted purchase cost/);
  /* Re-anchored 2026-09-08 to the plain-language lead: still a whole sentence, ending
     in a period inside the string, never the corrupted fragment. */
  assert.match(html, /and the coins they are calling\.",/);
  assert.match(html, /That the caller bought the coin is not\."/);
});
ok("(c) the callouts boot reads body.coins, never a bare `coins`", () => {
  assert.doesNotMatch(html, /\.\.\.coins\.flatMap/);
  assert.match(html, /Array\.isArray\(body\.coins\) \? body\.coins : \[\]\)\.flatMap/);
});
ok("(c) #tape-dot is lit by JS when a row lands while Activity is hidden, and cleared when it opens", () => {
  assert.match(html, /getElementById\("tape-dot"\)\?\.classList\.add\("on"\)/);
  assert.match(html, /group === "activity"\) document\.getElementById\("tape-dot"\)\?\.classList\.remove\("on"\)/);
});
ok("(d) the Ledger reads the HTTP status and names a refusal instead of painting an empty book", () => {
  const ledger = html.slice(html.indexOf('getElementById("ledgerpanel")'));
  assert.match(ledger.slice(0, 2500), /const \{ status, body \} = await call_api\(FLOOR_N != null \? `\/api\/floor\/\$\{FLOOR_N\}\/ledger/);
  assert.match(ledger.slice(0, 2500), /status === 403[\s\S]{0,80}private to its tenant/);
});
ok("(e) loadCalls repaints the dashboard view the reader is on, not only the hidden legacy panel", () => {
  const fn = html.slice(html.indexOf("async function loadCalls("), html.indexOf("function renderCalls("));
  assert.match(fn, /else if \(window\.__dashboardCallsView !== "candidates"\) loadDashboardCalls\(window\.__dashboardCallsView, \{ force: true \}\)/);
});
console.log(`\n${pass} passed — the five viewer defects are closed\n`);
