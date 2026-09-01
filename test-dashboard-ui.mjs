import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");

const destinations = [...html.matchAll(
  /<button class="dtab"[^>]*data-destination="([^"]+)"[^>]*>([^<]+)/g,
)].map((match) => [match[1], match[2].trim()]);
assert.deepEqual(destinations, [
  ["overview", "Overview"],
  ["calls", "Calls"],
  ["wallste", "WALL-ST-E"],
  ["team", "Team"],
  ["callouts", "Callouts"],
  ["activity", "Activity"],
  ["performance", "Performance"],
  ["settings", "Settings"],
], "the redesigned HUD exposes eight purposeful destinations in order");
assert.match(html, /id="primary-nav" role="tablist"/);
assert.equal((html.match(/data-destination=/g) || []).length, 8);
assert.doesNotMatch(html.slice(html.indexOf('id="primary-nav"'), html.indexOf("</div>", html.indexOf('id="primary-nav"'))), />Whales</,
  "Whales is no longer a visible destination");

assert.match(html, /call_api\("\/api\/candidates\/board"\)/);
assert.match(html, /const CANDIDATE_BANDS = \[[\s\S]*?"very_high"/);
assert.match(html, /for \(let index = 0; index < 5; index\+\+\)/,
  "every canonical cap tier renders five explicit slots");
assert.match(html, /NOT REVIEWED · NOT APPROVED · NOT EXECUTABLE/);

assert.match(html, /call_api\("\/api\/callouts"\)/);
assert.match(html, /Array\.isArray\(coin\.callouts\)/);
const calloutsDashboard = html.slice(
  html.indexOf("async function loadCalloutsDashboard"), html.indexOf("async function loadSettingsDashboard"));
assert.doesNotMatch(
  calloutsDashboard,
  /coin\.chatter|body\.chatter/,
  "the Callouts destination never renders unmatched chatter",
);
assert.match(calloutsDashboard, /recent_pool_token_inflow_current_value/);
assert.match(calloutsDashboard, /coverage\.succeeded/);
assert.match(calloutsDashboard, /purchase consideration proven/);
assert.doesNotMatch(calloutsDashboard, /recent_large_onchain_buy|buy receipt|matched buys/,
  "current-mark token inflows are never mislabeled as original purchase consideration");

assert.match(html, /\/executor\/status/);
assert.match(html, /Owner-only local activation · five deliberate steps/);
assert.match(html, /__CLAUDE_COMPANY_SOURCE_COMMIT__/);
assert.match(html, /Fund the burner last/);
assert.match(html, /cannot start, stop, steer, sign for, or fund it/);
assert.match(html, /function legacyBurnerRecoveryCard\(\)/);
assert.match(html, /Copy the legacy burner's secret key/);
assert.match(html, /wallsteFiltersDirty/);
assert.match(html, /!wallstePanel\?\.hidden[\s\S]*?loadWallsteDashboard\(\{ background: true \}\)/,
  "an open WALL-ST-E destination refreshes without overwriting active filter edits");
assert.match(html, /background && \(wallsteFiltersDirty \|\| editingAfterFetch\)/,
  "an in-flight background status refresh yields if editing begins before its response arrives");
assert.match(html, /background && \(wallsteFiltersDirty \|\| editingAfterFetch\)[\s\S]*?dashReady\(el\);[\s\S]*?return;/,
  "a yielded background refresh clears aria-busy before returning");
assert.match(html, /callsOpen && dashboardSubview\.calls === "candidates"[\s\S]*?loadCandidateBoard\(\)/,
  "the open pre-decision candidate board refreshes across new desk cycles");
assert.match(html, /dashMetric\("Settled P&L", feedPrivate \? "PRIVATE"/,
  "private floor performance is not converted into a false zero");
assert.match(html, /width:min\(700px, calc\(100% - 28px\)\)/,
  "the desktop dashboard is a real working surface, not the former narrow rail");
assert.match(html, /@media \(max-width:760px\)[\s\S]*?\.dock\{left:8px; right:8px; top:auto; bottom:8px/,
  "mobile navigation becomes a reachable bottom dock");
assert.ok(
  html.lastIndexOf("@media (max-width:760px)") > html.indexOf(".dock{\n  position:absolute"),
  "the mobile dock override must follow the desktop dock rule so top:auto wins the cascade",
);
assert.match(html, /\.pulse\{display:flex; left:8px; right:8px; bottom:62px/,
  "the mobile live pulse sits above the bottom tab dock instead of underneath it");
assert.match(html, /\.dossier\{[\s\S]*?z-index:12/,
  "call dossiers opened from the dashboard remain above the rail and dock");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
assert.deepEqual(duplicates, [], "dashboard markup has no duplicate IDs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-company-dashboard-"));
try {
  const modules = [...html.matchAll(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(modules.length, 3, "the floor keeps its three deliberate module scopes");
  for (const [index, match] of modules.entries()) {
    const file = path.join(temporary, `module-${index + 1}.mjs`);
    fs.writeFileSync(file, match[1]);
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr || `dashboard module ${index + 1} did not parse`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("dashboard HUD, candidate separation, WALL-ST-E boundary, and Callouts contract pass");
