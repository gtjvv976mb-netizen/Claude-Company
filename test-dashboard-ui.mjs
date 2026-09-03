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
assert.match(html, /Active local cap policy · self-reported/);
assert.match(html, /rolling realized-loss entry brake/);
assert.match(html, /The realized-loss value is an entry brake, not a guaranteed loss ceiling/);
assert.match(html, /--daily-loss-cap 0\.01/);
assert.match(html, /--max-sol 0\.05 --daily-cap 0\.5 --daily-loss-cap 0\.15/);
assert.match(html, /fresh v2 wallet-and-values acknowledgement/);
assert.match(html, /const dashSol = \(value\) =>[\s\S]*?toFixed\(9\)/,
  "sub-millisol caps and readiness probes retain enough precision to never render as zero");
assert.doesNotMatch(html, /Active trade cap[\s\S]{0,160}toFixed\(3\)|amountLamports[\s\S]{0,180}toFixed\(3\)/,
  "active cap and readiness sizing do not use lossy three-decimal SOL formatting");
assert.doesNotMatch(html, /First live release · hard ceilings|status\.releaseCaps|24h loss[^\n]*hard stop/,
  "the dashboard must not present defaults or a realized-loss brake as guaranteed hard loss ceilings");
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
/* OWNER DECISION (2026-09-02): the rail must not cover half the screen. The 700px,
 * 85%-tall fixed frame measured 55% x 81% of a 1280x720 viewport and force-opened at
 * boot, mostly to show a headline and one sentence. The invariant is now bounded and
 * content-sized: no wider than 480px, height follows content under a viewport cap,
 * and nothing opens it by itself. A pixel value is not the property worth pinning;
 * these three are. */
{
  const railWidth = html.match(/\.rail\{[\s\S]*?width:min\((\d+)px, calc\(100% - 28px\)\)/);
  assert.ok(railWidth && Number(railWidth[1]) <= 480,
    `the desktop rail stays a compact side panel (<=480px), got ${railWidth?.[1] ?? "none"}`);
  assert.match(html, /\.rail\{[\s\S]*?height:auto;[\s\S]*?max-height:min\((\d+)vh, calc\(100% - 82px\)\)/,
    "the rail sizes to its content and caps below the viewport, scrolling inside");
  const railCap = Number(html.match(/\.rail\{[\s\S]*?max-height:min\((\d+)vh/)?.[1]);
  assert.ok(railCap <= 75, `the rail's height cap stays under 75vh, got ${railCap}`);
  assert.doesNotMatch(html, /queueMicrotask\(\(\) => window\.showDashboard\?\.\("overview", \{ force: true \}\)\)/,
    "nothing force-opens the rail at boot; the dock is the resting state");
}
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

/* ── WHAT A TENANT IS TOLD ABOUT THE DESK ───────────────────────────────────
 * The heartbeat's own vocabulary — RUNNING / PAUSED / BLOCKED / DEGRADED — and its
 * reasons name the house's API keys, its daily budget, its provider balance and its
 * build failures. None of that is a tenant's business, and none of it is something a
 * tenant could act on; it reads as instability. The desk says only whether it is
 * working, and the HQ floor gets the rest. The redaction is at the source: the reason
 * is not sent, not merely unrendered. */
{
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  assert.match(office, /const hqViewer = Boolean\(me && holdsFloor\(tower\.HQ_FLOOR\)\)/,
    "the heartbeat decides detail by HQ ownership");
  assert.match(office, /state: hqViewer \? state : publicState/, "a tenant is sent the collapsed state");
  assert.match(office, /reason: hqViewer \? reason : null/, "a tenant is sent no reason at all");
  for (const [field, re] of [
    ["houseDeliveries", /houseDeliveries: !hqViewer \? \[\]/],
    ["providerCredit", /providerCredit: hqViewer \? \{/],
    ["seatFailures6h", /seatFailures6h: !hqViewer \? \[\]/],
  ]) assert.match(office, re, `${field} is withheld from tenants`);

  const view = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
  assert.match(view, /body\.state === "RUNNING" \|\| body\.state === "ACTIVE"/,
    "the pulse pill treats ACTIVE as running");
  assert.ok(!/pulse\.state !== "RUNNING"\) \? String\(pulse\.reason\)/.test(view),
    "the Overview metric no longer manufactures an explanation");

  /* A pane's title is optional now: the tab that opened it is highlighted, so a heading
     repeating it is chrome. Titles that carry an error or a permission wall stay. */
  assert.match(view, /if \(title\) words\.appendChild\(dashNode\("h3", "", title\)\)/,
    "dashLead may render no title");
  for (const restated of ['dashLead("Published calls",', 'dashLead("Verified Pump.fun whales",',
    'dashLead("Settings", "Open a floor'])
    assert.ok(!view.includes(restated), `a pane no longer restates its tab: ${restated}`);
  for (const kept of ['"Settings are owner-only"', '"WALL-ST-E is owner-only"', '"Callouts unavailable"'])
    assert.ok(view.includes(kept), `a title that says something the tab does not is kept: ${kept}`);
}

console.log("dashboard HUD, candidate separation, WALL-ST-E boundary, and Callouts contract pass");
