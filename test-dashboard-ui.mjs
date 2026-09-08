import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as copySettings from "./src/copy.js";

const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
/* The server half of the cohort surface, read as text: the page can only show a call's
   escalation level if office.js puts the stamp back on the feed row. Read here rather
   than imported so this stays a source test and starts no server. */
const officeSource = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");

const destinations = [...html.matchAll(
  /<button class="dtab"[^>]*data-destination="([^"]+)"[^>]*>([^<]+)/g,
)].map((match) => [match[1], match[2].trim()]);
assert.deepEqual(destinations, [
  ["overview", "Overview"],
  ["calls", "Calls"],
  ["wallste", "WALL-ST-E"],
  ["team", "Team"],
  ["callouts", "Big callers"],   // renamed 2026-09-08; the destination id, panel and dot are unchanged
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
/* THE RENDERER READS THE PAYLOAD THE SERVER SENDS.
 * The server moved to the owner's rule — pump.fun's gold check plus a wallet holding
 * $1,000 of SOL — and this kept filtering on evidence.inflows, a field that no longer
 * exists, so a tab carrying five coins of real data rendered as empty. These assertions
 * are shaped so that a contract change on either side breaks the test rather than the
 * tab. */
assert.match(calloutsDashboard, /callout\?\.verified === true/,
  "the gold check is required in the view as well as the server");
assert.match(calloutsDashboard, /Number\(callout\?\.walletSolUsd\)/,
  "the view reads the wallet balance the server actually sends");
assert.doesNotMatch(calloutsDashboard, /evidence\?\.inflows|row\.inflows|matchedCurrentValueUsd|recent_pool_token_inflow_current_value/,
  "no field from the retired inflow-matching contract is read");
assert.match(calloutsDashboard, /coverage\.succeeded/);
assert.match(calloutsDashboard, /purchase consideration proven/);
/* Re-anchored 2026-09-08 to the plain-language lead; the property — the tab says the
   balance is confirmed and the purchase is NOT — is the same sentence in fewer words. */
assert.match(calloutsDashboard, /The wallet balance is confirmed on chain\. That the caller bought the coin is not\./,
  "the tab says what the number is, and what it is not");
assert.match(calloutsDashboard, /coinsWithCallouts/,
  "an empty result distinguishes 'no callouts anywhere' from 'none cleared the bar'");
assert.doesNotMatch(calloutsDashboard, /recent_large_onchain_buy|buy receipt|matched buys/,
  "a wallet balance is never mislabeled as a purchase");

assert.match(html, /\/executor\/status/);
assert.match(html, /Owner-only local activation · five deliberate steps/);
assert.match(html, /__CLAUDE_COMPANY_SOURCE_COMMIT__/);
assert.match(html, /Fund the burner last/);

/* ── STEP 2 IS ONE LINE, AND IT STILL TRADES NOTHING ──────────────────────────
 * The installer has self-bootstrapped from $STATIC and read every prompt from
 * /dev/tty for weeks — piping it from curl was ALREADY supported — while this panel
 * went on demanding a clone, a cd and a detached checkout at a 40-character SHA.
 * Four exact steps before anything happens is the barrier that stopped ordinary
 * users, and it was a documentation barrier, not a technical one.
 *
 * These pins hold the shape of the fix: the short URL with the floor substituted,
 * a copy button on it, the clone form kept but folded away, and — the one that
 * matters most — the promise that a one-click INSTALL is not a one-click trade,
 * stated beside the command rather than three panels below it. */
{
  const setup = html.slice(html.indexOf('const installerSha256 = "'),
    html.indexOf('setupStep(3, "Run and review paper mode"'));
  assert.ok(setup.length > 400, "could not locate the WALL-ST-E install step");
  assert.match(setup,
    /const oneCommandInstall =\s*\n?\s*"curl -fsSL https:\/\/claudedotcompany\.com\/install\.sh \| bash -s -- --floor " \+ FLOOR_N;/,
    "the default install is one copyable line at the SHORT path, with this floor's number already in it");
  assert.match(setup, /dashNode\("pre", "commandbox", oneCommandInstall\)/,
    "...rendered as the step's own command box");
  assert.match(setup, /"Copy the one-command install"/, "...with a copy button of its own");
  assert.match(setup, /copyVisibleCommand\(copyOne, oneCommandInstall\)/,
    "...that copies that exact line");

  /* THE SAFETY SENTENCE SITS WITH THE COMMAND. A reader about to pipe a URL into
     bash decides at that moment, not at the panel four steps down. */
  assert.match(setup, /This installs a dry run: WALL-ST-E watches the feed[\s\S]{0,200}?trades nothing\./,
    "the page says plainly, next to the command, that the default install trades nothing");
  assert.match(setup, /It cannot buy or sell until you separately arm it on that machine/,
    "...and that arming is a separate, deliberate act on the host");
  assert.match(setup, /The burner key is generated on your host, is never sent anywhere/,
    "...and that the key never leaves the machine");

  /* VERIFY WHAT YOU ARE ABOUT TO RUN. The digest is a build-time substitution: a
     committed hash is a hash that is wrong the next time install.sh is touched. */
  assert.match(html, /const installerSha256 = "__CLAUDE_COMPANY_INSTALLER_SHA256__";/,
    "the digest is stamped by the build, never committed as a literal");
  assert.match(setup, /const installerShaKnown = \/\^\[0-9a-f\]\{64\}\$\/i\.test\(installerSha256\)/,
    "an unsubstituted placeholder is not shown as a checksum");
  assert.match(setup, /"The installer this site is serving has SHA-256:"/,
    "the page states the digest of the installer it serves");
  /* A 64-hex digest has no break opportunity: measured 394px of text in a 294px column,
     so a .dp-note paragraph painted its last 24 characters outside the panel. A checksum
     a reader cannot see all of is a checksum nobody compares. .commandbox breaks anywhere. */
  assert.match(setup, /dashNode\("pre", "commandbox", installerSha256\)/,
    "...in a box that wraps, not in a paragraph that overflows");
  assert.match(setup, /"curl -fsSL https:\/\/claudedotcompany\.com\/install\.sh \| shasum -a 256"/,
    "...and the line that prints it, so the comparison is a paste rather than a chore");

  /* THE CLONE PATH IS DEMOTED, NOT DELETED. Some readers will not pipe a URL into a
     shell on principle, and the pinned-commit form is a real property, not a ritual. */
  assert.match(setup, /foldSection\("Prefer to clone it yourself\?"\)/,
    "the git-clone form survives behind a disclosure");
  assert.match(setup, /cloneFold\.body\.appendChild\(dashNode\("pre", "commandbox", cloneInstallCommand\)\)/,
    "...inside the fold, not in the step's main flow");
  assert.match(setup, /git checkout --detach " \+ executorReleaseCommit/,
    "...still pinned to the exact reviewed commit");
  assert.ok(setup.indexOf("oneCommandInstall)") < setup.indexOf("cloneFold.wrap"),
    "the one-command line must be rendered before the clone disclosure — it is the default path");

  /* AND A PATH FOR PEOPLE WHO WILL NOT OPEN A TERMINAL AT ALL. */
  assert.match(setup, /"Download the double-click installer \(macOS\)"/,
    "the launcher is offered beside the copy button");
  assert.match(setup, /launcherLink\.href = "\/executor\/Install%20WALL-ST-E\.command"/,
    "...at the path the build publishes it to");
  assert.match(setup, /launcherLink\.setAttribute\("download", "Install WALL-ST-E\.command"\)/,
    "...as a download rather than a navigation");
  /* An <a> is display:inline, so .dp-btn's padding and border painted around a run of
     underlined text: it read as a sentence that had grown a stray box, not a button. */
  assert.match(html, /a\.dp-btn\{display:inline-block;text-decoration:none\}/,
    "an anchor styled as a button must lay out as one");
}

/* The older copy-settings panel offered the same clone incantation. One surface fixed
   and one surface stale is how a user ends up back at the git-clone anyway. */
{
  const legacyPanel = html.slice(html.indexOf('"Install WALL-ST-E · dry run by default"'),
    html.indexOf('"Optional · supervised live canary"'));
  assert.ok(legacyPanel.length > 400, "could not locate the copy-settings install panel");
  assert.match(legacyPanel,
    /`curl -fsSL https:\/\/claudedotcompany\.com\/install\.sh \| bash -s -- --floor \$\{FLOOR_N\}`/,
    "the settings panel leads with the same one-command install");
  assert.match(legacyPanel, /foldSection\("Prefer to clone it yourself\?"\)/,
    "...and keeps the clone form behind the same disclosure");
  assert.match(legacyPanel, /trades nothing until you separately arm it on that machine/,
    "...and says the default install trades nothing");
}

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
/* ── OWNER DECISION (2026-09-06): ALERTS DO NOT COVER THE ROOM ────────────────
 * Unacked exits stacked as full-width banners from the top of the stage down —
 * five of them measured 34.2% of a 1280x720 viewport and hid the back wall, the
 * run board and half the desks. They are a tab now, and these are the three
 * properties that make that true rather than the pixel values around them. */
{
  assert.match(html, /\.alertbar\.open\{display:flex\}/,
    "the stack draws only when the tab is open");
  assert.doesNotMatch(html, /\.alertbar\.on\{display:flex\}/,
    "...and never merely because alerts exist");
  assert.match(html, /\.alertbar\{[^}]*left:14px;right:auto/,
    "it hangs off the left edge instead of spanning the room");
  const navBlock = html.slice(html.indexOf('id="alert-nav"'), html.indexOf('id="primary-nav"'));
  assert.doesNotMatch(navBlock, /data-destination|role="tab"/,
    "the alert tab is a disclosure button and must never join the eight-destination tablist");
  assert.match(navBlock, /class="dtab"/, "...while being the same object visually");
  assert.match(html, /\.dtab\[aria-selected="true"\],\.dtab\[aria-expanded="true"\]\{/,
    "an opened alert tab is highlighted the way a selected destination is");
  assert.doesNotMatch(html, /\.dtab \.cnt\{/,
    "no count chip in the line box: it made this tab 3px taller than every tab beside it");

  /* ABOVE THE RAIL, AND NEVER BESIDE IT. Measured: the panel spans 14..534 and the
   * rail spans W-494..W-14, so under a ~1028px viewport they overlap — at z-index 6
   * the rail painted over the alerts and every row's "Got it" was unclickable. */
  const zBar = Number(html.match(/\.alertbar\{[^}]*z-index:(\d+)/)?.[1]);
  const zRail = Number(html.match(/\.rail\{[\s\S]*?z-index:(\d+)/)?.[1]);
  assert.ok(zBar > zRail, `the alert panel must sit above the rail, got ${zBar} vs ${zRail}`);
  assert.match(html, /if \(open\) window\.closeRail\?\.\(\);/,
    "opening the alerts closes the other panel on the dock line");
  assert.match(html, /window\.__closeAlerts\?\.\(\);\n\s*if \(!DASHBOARD_PANEL\[which\]\)/,
    "...and opening a destination closes the alerts");
  assert.match(html, /window\.closeRail = closeRail;/,
    "the alerts live in a later module, so the rail's closer is reachable");

  /* A LIVE REGION THAT IS NOT RENDERED ANNOUNCES NOTHING. The stack is display:none
   * until the tab is opened, so role="alert" on it told a screen-reader user about
   * a 3am exit exactly never. The announcement comes from a node that is always
   * rendered, and the hidden stack no longer claims to be a live region. */
  assert.doesNotMatch(html, /id="alertbar"[^>]*aria-live/,
    "the display:none stack must not pose as a live region");
  assert.match(html, /<div class="sr" id="alert-live" role="status" aria-live="polite">/);
  assert.match(html, /alertLive\.textContent = unread\.length === 1/,
    "and it is given the alert to announce");

  /* THE PANEL FOLLOWS ITS OWN TAB. It used to open the markup of #stage, which put
   * it before every tab on the page: a forward Tab from Alerts skipped its buttons. */
  assert.ok(html.indexOf('id="alert-nav"') < html.indexOf('id="alertbar"'),
    "the panel's markup must come after the tab that opens it");

  /* THE 20-SECOND POLL MUST NOT REBUILD AN OPEN PANEL under the reader's hands. */
  assert.match(html, /if \(sig === alertSig && alertBar\.childElementCount\) return;/,
    "an unchanged alert list is left alone, scroll position and focus intact");
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

/* ── GROX MULDER'S BOARD SHOWS WHAT THE FLOOR HOLDS ────────────────────────────
 * It used to draw every call OFFERED to the floor, which is the team's paper book — a
 * wall of positions nobody owns. A call reaches his board only once the bot took it, and
 * the two price columns are market caps, because a memecoin price is a string of zeros
 * that tells a reader nothing while the cap is the number people trade on
 * (owner, 2026-09-03). */
{
  const view = html;
  /* THE BOT'S OWN REPORT DECIDES (2026-09-05). Shrek, call 55: the bot filled 0.0175 SOL,
     the board printed the desk's 0.4, the bot sold 03:01:42Z and the wall held the
     position until the desk's stop_hit at 03:10:24Z. One predicate now reads bot_status
     first and falls back to live+taken(1|true) only when the bot never reported. The
     predicate itself is exercised in test-grok-board-wire-shape.mjs; this pins its shape. */
  assert.match(view, /const botOpen = \(c\) => c\.bot_status === "open" \|\| \(c\.bot_status == null && c\.status === "live" && \(c\.taken === true \|\| Number\(c\.taken\) === 1\)\);/,
    "only positions the bot is open in (or, unreported, live and taken on the wire) reach the board");
  assert.match(view, /const open = feed\.filter\(\(c\) => c\.verdict === "offered"\);/,
    "the offered set is not pre-filtered by the desk's status — a bot-open position on a desk-closed call is still held");
  assert.match(view, /const held = open\.filter\(botOpen\);/, "held is that one predicate over the offered set");
  assert.match(view, /grokBook\.positions = held\.map/,
    "...and the board is built from those, not from every offer");
  assert.match(view, /const real = c\.bot_size_sol != null;\n\s*const size = c\.bot_size_sol \?\? c\.size_sol;/,
    "SIZE is the bot's real SOL, falling back to the desk's sizing only when the bot never reported");
  assert.match(view, /const basis = c\.bot_entry_mark \?\? entry;/,
    "P&L is measured from the bot's own entry mark, falling back to the desk's entry_ref");
  assert.match(view, /x\.fillText\("\(paper\)", 280 \+ w \+ 6, y \+ 1\)/,
    "a desk-sized row is marked (paper) on the wall");
  assert.match(view, /\["REALIZED TODAY", st\.realizedTodaySol != null \? fmtSignedSol\(st\.realizedTodaySol\) : "\\u2014"\]/,
    "the flat-book rows carry REALIZED TODAY ±x SOL from the bot's sell reports");
  assert.match(view, /taken: held\.length,/, "the held count is the bot-open set");
  assert.match(view, /exposureSol: grokBook\.positions\.reduce\(\(a, p\) => a \+ \(p\.size \|\| 0\), 0\)/,
    "exposure sums the sizes actually on the board");
  assert.match(view, /if \(hudOnly\) \{[\s\S]{0,700}?window\.__grokBoardUpdate\?\.\(body\.feed \|\| \[\]\);[\s\S]{0,200}?return;/,
    "the hudOnly loadCalls path feeds the board before it returns, so the wall never freezes on another pane");
  /* Re-anchored 2026-09-08 with the plain-language card: the words are a person's
     ("Your bot bought … SOL of this"), the property is the same — the bot's own open
     report is read first and its size is the bot's real SOL, never the desk's. */
  assert.match(view, /if \(c\.bot_status === "open"\) \{\n\s*line\.textContent = `Your bot bought \$\{solStr\(c\.bot_size_sol\)\} SOL of this /,
    "the call card reads the bot's own open report first");
  assert.match(view, /\} else if \(c\.bot_status === "closed"\) \{[\s\S]{0,900}?`Your bot sold \\u00b7 \$\{Number\.isFinite\(realized\) \? signedSol\(realized\)[^`]*\$\{exitWords\}/,
    "...and its exit report with the realised SOL and the reason");
  assert.match(view, /x\.fillText\("ENTRY MC"/, "the entry column is a market cap");
  assert.match(view, /x\.fillText\("TARGET MC"/, "the second column is the target, not the mark");
  assert.ok(!/x\.fillText\("MARK", \d+, 100\)/.test(view), "the MARK column is gone");
  assert.match(view, /entryCap: capAtCall, targetCap: capOf\(target\)/,
    "both columns carry caps derived from the call's own cap at entry");
  assert.match(view, /capAtCall \* \(px \/ entry\)/,
    "a target cap is the entry cap scaled by the price ratio — supply is constant");
  assert.match(view, /const fmtCap = /, "caps are formatted as $9.3K / $412K / $5.1M");
  assert.ok(!/p\.mark != null \? fmtPx\(p\.mark\)/.test(view),
    "the board no longer prints a decimal mark");
  // P&L still needs the live mark, which is why it is still carried on the row.
  assert.match(view, /pnlPct: \(basis && mark\) \? \(\(mark - basis\) \/ basis\) \* 100 : null/,
    "P&L is still computed from the live mark, against the bot's basis");
}

/* ── THE BOT'S BALANCE IS ON HIS WALL ──────────────────────────────────────────
 * The board showed positions without ever showing the money behind them: the balance
 * was fetched by the funding panel and kept there. One owner now holds it, both surfaces
 * read it, and the states a person needs to tell apart stay apart — empty is not the
 * same as unreadable, and a stale read says so. */
{
  const view = html;
  assert.match(view, /async function refreshBotBalance/, "one owner for the live balance");
  assert.match(view, /method: "getBalance", params: \[wallet\]/,
    "read through the existing read-only relay, not a new signing path");
  assert.match(view, /setInterval\(\(\) => \{ refreshBotBalance\(\)/,
    "it refreshes on its own rather than only when a panel is open");
  assert.match(view, /Date\.now\(\) - botBalanceAt < 20_000/, "and is throttled");
  assert.match(view, /Number\.isFinite\(Number\(lamports\)\)\n?\s*\? \{ wallet, sol: Number\(lamports\) \/ 1e9/,
    "a readable balance is a number");
  assert.match(view, /: \{ wallet, sol: null, at: Date\.now\(\), ok: false \}/,
    "an unreadable one is null, never zero — those are different things to tell someone about their money");
  assert.match(view, /x\.fillText\(text, W - 26, 38\)/, "the header carries it beside his title");
  assert.match(view, /\["BOT WALLET"/, "and the flat-book panel carries it as a row");
  assert.match(view, /"WALLET UNREADABLE"/, "unreadable is said out loud");
  assert.match(view, /cannot trade/, "an empty wallet says what that means");
  assert.match(view, /Date\.now\(\) - bb\.at > 90_000/, "a stale read is labelled stale");
}

/* ── THE FORK: WHO RUNS YOUR BOT ───────────────────────────────────────────────
 * The panel used to open with install instructions, which answered the only question
 * that matters — who holds the key — without asking it. These assertions hold the
 * shape of the question and, more importantly, the honesty of the two answers:
 *
 *   1. NEITHER is preselected. A default here is a custody decision made by a website.
 *   2. The managed track says it does not exist, and says the operator would hold the
 *      key. It is a register-interest card; it must never read like a product.
 *   3. The self-hosted track is not padded. It is ONE COMMAND and it works today;
 *      overstating that friction would push a reader toward the option where somebody
 *      else can move their money, which is the worst direction to mislead in.
 *
 * The fork is rendered for real rather than grepped: it is evaluated against a small
 * node shim (this repo has no DOM library), so what is asserted is the tree a tenant
 * sees, not a string that happens to be in the file. The persistence callback is
 * stubbed — nothing here touches the network or the server owner's route. */
{
  const forkStart = html.indexOf('const RUNNER_SELF = "self";');
  const forkEnd = html.indexOf("/* ── THE WALL-ST-E EXECUTOR CARD");
  assert.ok(forkStart > 0 && forkEnd > forkStart,
    `could not locate the runner-fork block (start ${forkStart}, end ${forkEnd})`);
  const forkSource = html.slice(forkStart, forkEnd);

  /* A node is whatever dashNode returns: a tag, a class, its text, and its children.
     That is every property these assertions read, so the shim is the whole DOM. */
  const shimNode = (tag, cls, text) => {
    const node = {
      tag, className: cls || "", textContent: text == null ? "" : String(text),
      children: [], attrs: {}, type: "", disabled: false, onclick: null,
    };
    node.appendChild = (child) => { node.children.push(child); return child; };
    node.append = (...kids) => { for (const kid of kids) node.children.push(kid); };
    node.setAttribute = (key, value) => { node.attrs[key] = String(value); };
    node.getAttribute = (key) => (key in node.attrs ? node.attrs[key] : null);
    return node;
  };
  const built = new Function("dashNode", forkSource + `
    return { RUNNER_SELF, RUNNER_HQ, normalizeRunnerChoice, runnerTrackBadge, runnerTrackTone,
             renderRunnerFork, RUNNER_HQ_CONFIRMATION, saveRunnerChoice };`)(shimNode);
  const { RUNNER_SELF, RUNNER_HQ, normalizeRunnerChoice, runnerTrackBadge, renderRunnerFork } = built;

  /* The half of the contract that is agreed with the server owner: the two values. */
  assert.equal(RUNNER_SELF, "self", `self-hosted track value is ${JSON.stringify(RUNNER_SELF)}`);
  assert.equal(RUNNER_HQ, "hq_requested", `managed track value is ${JSON.stringify(RUNNER_HQ)}`);
  for (const [raw, want] of [[undefined, null], [null, null], ["", null], ["managed", null],
    ["self", "self"], ["hq_requested", "hq_requested"]]) {
    const got = normalizeRunnerChoice(raw);
    assert.equal(got, want,
      `normalizeRunnerChoice(${JSON.stringify(raw)}) is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }

  const walk = (node, out = []) => { out.push(node); for (const kid of node.children) walk(kid, out); return out; };
  const textOf = (node) => walk(node).map((n) => n.textContent).filter(Boolean).join(" ");
  const nodeWithAttr = (root, key, value) => walk(root).find((n) => n.attrs[key] === value);

  const unset = renderRunnerFork(null, async () => ({ ok: true }));
  const unsetText = textOf(unset);
  assert.match(unsetText, /Who runs your bot\?/, `the fork asks the question: ${unsetText.slice(0, 80)}`);

  /* 1 · NEITHER OPTION IS PRESELECTED. */
  const pressed = [RUNNER_SELF, RUNNER_HQ]
    .map((value) => nodeWithAttr(unset, "data-runner-pick", value).attrs["aria-pressed"]);
  assert.deepEqual(pressed, ["false", "false"],
    `an unset floor must preselect neither track; aria-pressed values are ${JSON.stringify(pressed)}`);
  const chosenClasses = [RUNNER_SELF, RUNNER_HQ]
    .map((value) => nodeWithAttr(unset, "data-runner-option", value).className);
  assert.ok(!chosenClasses.some((cls) => /(^|\s)runner-opt on(\s|$)/.test(cls)),
    `no card is styled as chosen while nothing is chosen; classes are ${JSON.stringify(chosenClasses)}`);

  /* 2 · CUSTODY IS THE MOST PROMINENT LINE IN EACH CARD — first paragraph in the card
     and, in the stylesheet, larger than the prose around it. */
  const custodyOf = (value) => walk(nodeWithAttr(unset, "data-runner-option", value))
    .find((n) => n.className === "runner-custody");
  for (const value of [RUNNER_SELF, RUNNER_HQ]) {
    const option = nodeWithAttr(unset, "data-runner-option", value);
    const index = option.children.findIndex((n) => n.className === "runner-custody");
    assert.equal(index, 1,
      `custody must be the first line under the ${value} card's heading; it is child ${index} of ` +
      JSON.stringify(option.children.map((n) => n.className || n.tag)));
  }
  const proseSize = Number(html.match(/\.runner-opt p\{[^}]*font-size:(\d+(?:\.\d+)?)px/)?.[1]);
  const custodySize = Number(html.match(/\.runner-custody\{font-size:(\d+(?:\.\d+)?)px!important/)?.[1]);
  assert.ok(custodySize > proseSize,
    `the custody line must outweigh the prose around it: custody ${custodySize}px vs prose ${proseSize}px`);

  const selfCustody = custodyOf(RUNNER_SELF).textContent;
  assert.match(selfCustody, /generated on your own machine, never leaves it/,
    `self-hosted custody line is: ${selfCustody}`);
  assert.match(selfCustody, /the desk never receives it/, `self-hosted custody line is: ${selfCustody}`);
  const hqCustody = custodyOf(RUNNER_HQ).textContent;
  assert.match(hqCustody, /operator would hold the key to the wallet your funds sit in, and could move them/,
    `managed custody line is: ${hqCustody}`);
  assert.match(hqCustody, /depend entirely on the operator/, `managed custody line is: ${hqCustody}`);

  /* 3 · THE MANAGED CARD IS LABELLED UNAVAILABLE, PLAINLY AND IN ITS BADGE. */
  const hqText = textOf(nodeWithAttr(unset, "data-runner-option", RUNNER_HQ));
  const hqBadge = walk(nodeWithAttr(unset, "data-runner-option", RUNNER_HQ))
    .find((n) => /dashbadge/.test(n.className)).textContent;
  assert.equal(hqBadge, "NOT AVAILABLE YET", `the managed badge reads ${JSON.stringify(hqBadge)}`);
  assert.match(hqText, /This does not exist yet/, `managed card text: ${hqText}`);
  assert.match(hqText, /no account to fund, no wallet address to send to/, `managed card text: ${hqText}`);
  assert.match(hqText, /records that you want it/, `managed card text: ${hqText}`);

  /* 4 · THE SELF-HOSTED CARD SAYS ONE COMMAND, AND SAYS IT IS AVAILABLE NOW. */
  const selfText = textOf(nodeWithAttr(unset, "data-runner-option", RUNNER_SELF));
  const selfBadge = walk(nodeWithAttr(unset, "data-runner-option", RUNNER_SELF))
    .find((n) => /dashbadge/.test(n.className)).textContent;
  assert.equal(selfBadge, "AVAILABLE NOW", `the self-hosted badge reads ${JSON.stringify(selfBadge)}`);
  assert.match(selfText, /One command, on macOS or Linux/, `self-hosted card text: ${selfText}`);
  assert.match(selfText, /a machine that stays awake, and two RPC accounts of your own/,
    `the self-hosted card states its real cost: ${selfText}`);
  assert.match(hqText, /custody, plus this operator's uptime/,
    `the managed card states its real cost: ${hqText}`);

  /* 5 · NOTHING THIS PANEL SAYS CALLS SELF-HOSTING HARD WORK. It is one command; padding
     that friction would be a lie told toward the riskier option. The scan covers the
     fork AND the install steps it reveals, and it reads the STRING LITERALS — what a
     tenant is shown — rather than the file, because a source comment explaining that
     the clone path is "no longer the default" is a note to the next engineer, not a
     claim about difficulty made to a user. */
  const shownStrings = (source) => (source.match(/"(?:[^"\\\n]|\\.)*"/g) || []).join(" \u2028 ");
  const panelBlocks = [["runner fork", forkSource],
    ["install steps", html.slice(html.indexOf('const installerSha256 = "'),
      html.indexOf("setupCard.appendChild(setupSteps);"))]];
  for (const [name, source] of panelBlocks) {
    assert.ok(source.length > 400, `could not locate the ${name} block (length ${source.length})`);
    const shown = shownStrings(source);
    assert.ok(shown.length > 200, `the ${name} block yielded only ${shown.length} characters of shown text`);
    for (const word of ["long", "complicated", "difficult", "arduous"]) {
      const found = shown.match(new RegExp("\\b" + word + "\\w*", "gi"));
      assert.equal(found, null,
        `the ${name} block must not describe self-hosting as "${word}"; found ${JSON.stringify(found)} ` +
        `in ${shown.length} characters of shown text`);
    }
  }

  /* 6 · CHOOSING IS RECORDED, AND NOTHING IS PROVISIONED. The callback is stubbed: this
     test never reaches the server owner's route. */
  const seen = [];
  const armed = renderRunnerFork(null, async (value) => { seen.push(value); return { ok: true, message: "recorded" }; });
  await nodeWithAttr(armed, "data-runner-pick", RUNNER_HQ).onclick();
  assert.deepEqual(seen, [RUNNER_HQ], `pressing the managed option reports ${JSON.stringify(seen)}`);
  const armedStatus = walk(armed).find((n) => /runner-status/.test(n.className));
  assert.equal(armedStatus.textContent, "recorded",
    `the fork shows what the caller reported, got ${JSON.stringify(armedStatus.textContent)}`);
  await nodeWithAttr(armed, "data-runner-pick", RUNNER_SELF).onclick();
  assert.deepEqual(seen, [RUNNER_HQ, RUNNER_SELF], `pressing both reports ${JSON.stringify(seen)}`);
  assert.match(forkSource, /JSON\.stringify\(\{ choice: value \}\)/,
    "the write carries the choice and nothing else — no key, no amount, no address");

  /* 7 · THE HQ CONFIRMATION SURVIVES A RELOAD, and says the three things that keep this
     from being mistaken for a funded, running service. */
  const requested = renderRunnerFork(RUNNER_HQ, async () => ({ ok: true }));
  const requestedText = textOf(requested);
  for (const promise of [/Nothing has been provisioned/, /No wallet has been created for you/,
    /there is no deposit address/, /no funds should be sent anywhere for this/,
    /You will be told if and when it exists/]) {
    assert.match(requestedText, promise,
      `a floor on the managed track is told: ${requestedText.slice(requestedText.indexOf("Recorded:"), requestedText.indexOf("Recorded:") + 260)}`);
  }
  const requestedPressed = [RUNNER_SELF, RUNNER_HQ]
    .map((value) => nodeWithAttr(requested, "data-runner-pick", value).attrs["aria-pressed"]);
  assert.deepEqual(requestedPressed, ["false", "true"],
    `only the chosen track is pressed, got ${JSON.stringify(requestedPressed)}`);

  /* 8 · THE INSTALL CARD IS DOWNSTREAM OF THE CHOICE, on both install surfaces. */
  /* Re-anchored 2026-09-08: the card now lands in the page's Set-up fold; it is still
     attached only on the self-hosted track, which is the property this guards. */
  assert.match(html, /if \(runnerChoice === RUNNER_SELF\) setupFold\.body\.appendChild\(setupCard\);/,
    "the five-step install card is attached only on the self-hosted track");
  assert.match(html, /else if \(runnerChoice === RUNNER_HQ\) \{[\s\S]{0,400}?"Nothing is running for you"/,
    "...and a floor that asked for HQ is told nothing is running rather than shown the other track's steps");
  assert.match(html, /\} else \{[\s\S]{0,300}?"Choose a track first"/,
    "...and an unset floor is asked the question instead of handed instructions");
  assert.match(html, /if \(settingsRunner === RUNNER_SELF\) box\.appendChild\(installBox\);/,
    "the second install surface in the settings pane is gated by the same choice");
  const forkAt = html.indexOf("el.appendChild(renderRunnerFork(runnerChoice");
  const setupAt = html.indexOf("const setupCard = dashNode(");
  const gridAt = html.indexOf('const statusGrid = dashNode("div", "dashgrid")');
  assert.ok(forkAt > 0 && forkAt < gridAt && forkAt < setupAt,
    `the fork is the first thing in the panel, ahead of every install instruction ` +
    `(fork ${forkAt}, status grid ${gridAt}, install card ${setupAt})`);

  /* 9 · THE HEADER SAYS WHICH TRACK THIS FLOOR IS ON. A tenant must never have to guess. */
  const badges = [null, RUNNER_SELF, RUNNER_HQ].map((choice) => runnerTrackBadge(choice));
  assert.deepEqual(badges,
    ["TRACK · NOT CHOSEN", "TRACK · YOU RUN IT", "TRACK · HQ REQUESTED · NOT RUNNING"],
    `the header badge for unset / self / hq reads ${JSON.stringify(badges)}`);
  assert.match(html,
    /lead\.appendChild\(dashNode\("span", "dashbadge " \+ runnerTrackTone\(runnerChoice\), runnerTrackBadge\(runnerChoice\)\)\);\n\s*el\.append\(lead\);/,
    "the WALL-ST-E panel header carries the active track beside the bot's mode");
  assert.match(html, /"Who runs your bot: " \+ runnerTrackBadge\(\n?\s*normalizeRunnerChoice\(settings\?\.runner_choice/,
    "the settings-pane bot card names the track too, so the two surfaces cannot disagree");
}


/* ══ THE TWO MODALS THE CUSTODY FORK OPENS ═══════════════════════════════════
 *
 * Both are executed, not grepped. The CCModals block is lifted out of the shipped
 * page and evaluated against a node shim, so every assertion below reads the tree a
 * tenant actually gets. A grep would pass on a string that is present in the file and
 * never rendered — which is exactly how a "read more" ends up hiding condition 1.
 *
 * The disclosure comes from src/copy.js, the same source the server serves and hashes.
 * Hard-coding eight conditions here would let a ninth ship with no checkbox and a
 * green suite.
 */
{
  const start = html.indexOf("window.CCModals = (function () {");
  const end = html.indexOf("</script>", start);
  assert.ok(start > 0 && end > start,
    `could not locate the CCModals block (start ${start}, end ${end})`);
  const modalSource = html.slice(start, end);

  /* The shim is the whole DOM these builders touch: a tag, a class, text, children,
     attributes, and the four handlers. textContent's setter clears children because
     the real one does, and both modals repaint by assigning "" to it. */
  const makeDom = () => {
    const mk = (tag) => {
      const node = { tag, className: "", _text: "", children: [], attrs: {}, style: {},
        id: "", type: "", href: "", disabled: false, hidden: false, checked: false,
        tabIndex: 0, onclick: null, onchange: null, parent: null, scrollTop: 0 };
      Object.defineProperty(node, "textContent", {
        get() { return node._text; },
        set(value) { node._text = value == null ? "" : String(value); node.children.length = 0; },
      });
      node.appendChild = (child) => { child.parent = node; node.children.push(child); return child; };
      node.append = (...kids) => { for (const kid of kids) if (kid) { kid.parent = node; node.children.push(kid); } };
      node.setAttribute = (key, value) => { node.attrs[key] = String(value); };
      node.getAttribute = (key) => (key in node.attrs ? node.attrs[key] : null);
      node.removeAttribute = (key) => { delete node.attrs[key]; };
      node.remove = () => {
        if (node.parent) {
          const at = node.parent.children.indexOf(node);
          if (at >= 0) node.parent.children.splice(at, 1);
        }
        node.parent = null;
      };
      node.contains = () => false;
      node.focus = () => {};
      return node;
    };
    const body = mk("body");
    const bound = [];
    const store = new Map();
    return {
      body, bound, store,
      document: { createElement: mk, body, activeElement: null,
        addEventListener: (type, fn) => bound.push([type, fn]),
        removeEventListener: (type, fn) => {
          const at = bound.findIndex(([t, f]) => t === type && f === fn);
          if (at >= 0) bound.splice(at, 1);
        } },
      window: { matchMedia: () => ({ matches: false }) },
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      navigator: { clipboard: { writeText: async () => {} } },
    };
  };
  const loadModals = (dom) => new Function("window", "document", "localStorage", "navigator",
    modalSource + "\nreturn window.CCModals;")(dom.window, dom.document, dom.localStorage, dom.navigator);

  const walk = (node, out = []) => { out.push(node); for (const kid of node.children) walk(kid, out); return out; };
  const textOf = (node) => walk(node).map((n) => n.textContent).filter(Boolean).join(" ");
  const withAttr = (root, key, value) => walk(root)
    .filter((n) => (value == null ? key in n.attrs : n.attrs[key] === String(value)));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const FLOOR = 12;

  /* ── 1 · NINE STEPS, AND IT OPENS ON THE FIRST ─────────────────────────────── */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    const steps = modals.installSteps({ floorNo: FLOOR, installerSha256: "a".repeat(64) });
    assert.equal(steps.length, 9, `the walkthrough has ${steps.length} steps, expected 9`);
    assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9],
      `steps are numbered ${JSON.stringify(steps.map((s) => s.n))}`);

    modals.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "a".repeat(64) });
    const scrim = dom.body.children[dom.body.children.length - 1];
    assert.ok(scrim, "opening the walkthrough attached nothing to the document");
    const dialogNode = walk(scrim).find((n) => n.attrs.role === "dialog");
    assert.ok(dialogNode, "the walkthrough is not marked up as a dialog");
    assert.equal(dialogNode.attrs["aria-modal"], "true",
      `aria-modal is ${JSON.stringify(dialogNode.attrs["aria-modal"])}`);
    const shown = textOf(scrim);
    assert.match(shown, /Step 1 of 9/, `the walkthrough opens reading: ${shown.slice(0, 160)}`);
    const stage = walk(scrim).find((n) => n.attrs["data-step-stage"] != null);
    assert.equal(stage.attrs["data-step-stage"], "1",
      `the first stage rendered is step ${stage.attrs["data-step-stage"]}`);
    /* BACK IS DEAD ON STEP 1 AND NEXT IS DEAD ON STEP 9: the progress indicator and
       the two controls must agree about where the reader is. */
    const back = withAttr(scrim, "data-walk", "back")[0];
    const next = withAttr(scrim, "data-walk", "next")[0];
    assert.equal(back.disabled, true, `Back on step 1 is disabled=${back.disabled}`);
    assert.equal(next.disabled, false, `Next on step 1 is disabled=${next.disabled}`);
    const pips = walk(scrim).filter((n) => n.tag === "i");
    assert.equal(pips.length, 9, `the progress indicator has ${pips.length} marks, expected 9`);
    assert.equal(pips.filter((p) => p.className === "now").length, 1,
      `exactly one mark is the current step; got ${JSON.stringify(pips.map((p) => p.className))}`);

    /* IT REMEMBERS WHERE THE READER STOPPED, per floor. */
    const key = modals.walkthroughKey(FLOOR);
    assert.equal(dom.store.get(key), "1", `step memory after opening is ${dom.store.get(key)}`);
    for (let step = 1; step < 9; step++) next.onclick();
    assert.match(textOf(scrim), /Step 9 of 9/, "nine Next presses reach the last step");
    assert.equal(dom.store.get(key), "9", `step memory after walking to the end is ${dom.store.get(key)}`);
    assert.equal(withAttr(scrim, "data-walk", "next")[0].disabled, true,
      "Next is disabled on the last step");

    const reopened = makeDom();
    reopened.store.set(modals.walkthroughKey(FLOOR), "6");
    const again = loadModals(reopened);
    again.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "a".repeat(64) });
    assert.match(textOf(reopened.body), /Step 6 of 9/,
      `reopening resumes where the reader stopped, not at 1: ${textOf(reopened.body).slice(0, 120)}`);
    /* Junk, a foreign floor's value, or a step that no longer exists is step 1 — a
       remembered position is a convenience, never a reason to open on nothing. */
    for (const junk of ["", "0", "10", "abc", "3.5"]) {
      const got = again.rememberedStep(999, 9);
      assert.equal(got, 1, `an unset floor resumes at ${got}`);
      reopened.store.set(again.walkthroughKey(998), junk);
      const fromJunk = again.rememberedStep(998, 9);
      assert.equal(fromJunk, 1, `a stored ${JSON.stringify(junk)} resumes at ${fromJunk}`);
    }
  }

  /* ── 2 · THE INSTALL LINE CARRIES THIS FLOOR'S REAL NUMBER ──────────────────
     No placeholder the reader has to fill in. The tone rules allow exactly one
     substitution and this page already knows it. */
  {
    for (const floorNo of [7, 12, 48]) {
      const dom = makeDom();
      const modals = loadModals(dom);
      modals.openInstallWalkthrough({ floorNo, installerSha256: "b".repeat(64) });
      const scrim = dom.body.children[dom.body.children.length - 1];
      const next = withAttr(scrim, "data-walk", "next")[0];
      next.onclick(); next.onclick();                      // step 3 is the install
      const stage = walk(scrim).find((n) => n.attrs["data-step-stage"] != null);
      assert.equal(stage.attrs["data-step-stage"], "3", "step 3 is the install step");
      const commands = withAttr(scrim, "data-copy").map((n) => n.attrs["data-copy"]);
      const wanted = `curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor ${floorNo}`;
      assert.ok(commands.includes(wanted),
        `floor ${floorNo}'s install line is missing; the copyable commands are ${JSON.stringify(commands)}`);
      assert.doesNotMatch(commands.join(" "), /<N>|<floor|YOUR_FLOOR|\{floor/i,
        `a placeholder survived into a copyable command: ${JSON.stringify(commands)}`);
      const shown = textOf(scrim);
      assert.match(shown, /installs a dry run/,
        `the install step says what it installs: ${shown.slice(0, 200)}`);
    }
  }

  /* ── 3 · STEP 5 EXISTS, IS THE BACKUP, AND IS VISUALLY ITS OWN THING ────────
     Skipping this is the one omission that costs a reader everything they later
     deposit, so it is not a bullet among bullets: it is the only step carrying the
     critical treatment, it has its own banner, and it names the file. */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    const steps = modals.installSteps({ floorNo: FLOOR, installerSha256: "c".repeat(64) });
    const critical = steps.filter((s) => s.critical === true);
    assert.equal(critical.length, 1,
      `exactly one step is the distinct one; ${critical.length} are marked critical`);
    assert.equal(critical[0].n, 5, `the critical step is step ${critical[0].n}`);
    assert.match(critical[0].title, /back up the key/i,
      `step 5 is titled ${JSON.stringify(critical[0].title)}`);

    modals.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "c".repeat(64) });
    const scrim = dom.body.children[dom.body.children.length - 1];
    const next = withAttr(scrim, "data-walk", "next")[0];
    for (let i = 0; i < 4; i++) next.onclick();
    const stage = walk(scrim).find((n) => n.attrs["data-step-stage"] != null);
    assert.equal(stage.attrs["data-step-stage"], "5", "four Next presses land on step 5");
    assert.match(stage.className, /ccm-critical/,
      `the backup step's own stage class is ${JSON.stringify(stage.className)}`);
    assert.equal(stage.attrs["data-critical"], "1",
      `the backup step is flagged data-critical=${JSON.stringify(stage.attrs["data-critical"])}`);
    const flag = walk(stage).find((n) => n.className === "ccm-critical-flag");
    assert.ok(flag, "the backup step has no banner of its own");
    assert.match(flag.textContent, /before you fund/i, `its banner reads ${JSON.stringify(flag.textContent)}`);
    /* No other step may wear the same treatment, or "distinct" means nothing. */
    for (const step of [1, 2, 3, 4, 6, 7, 8, 9]) {
      const other = makeDom();
      const build = loadModals(other);
      other.store.set(build.walkthroughKey(FLOOR), String(step));
      build.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "c".repeat(64) });
      const otherStage = walk(other.body).find((n) => n.attrs["data-step-stage"] != null);
      assert.doesNotMatch(otherStage.className, /ccm-critical/,
        `step ${step} also wears the critical treatment (${otherStage.className})`);
    }
    const shown = textOf(stage);
    assert.match(shown, /~\/claudeco-executor\/burner\.json/, `step 5 names the key file: ${shown.slice(0, 200)}`);
    assert.match(shown, /NOWHERE ELSE/, "step 5 says the key exists in exactly one place");
    const commands = withAttr(stage, "data-copy").map((n) => n.attrs["data-copy"]).join("\n");
    assert.match(commands, /burner-backup\.mjs --out ~\/wall-st-e-recovery\.txt/,
      `step 5's copyable commands are: ${JSON.stringify(commands)}`);
    assert.match(commands, /burner-backup\.mjs --verify ~\/wall-st-e-recovery\.txt/,
      "an unverified backup is a guess, so the verify line is offered too");
  }

  /* ── 4 · IT SAYS HOW TO STOP THE BOT ────────────────────────────────────────
     A user who cannot stop a trading bot will panic, so the last step reproduces the
     two sentinels the executor actually reads — including the mode, because a
     touch-created file is 644 and the runtime rejects it as not owner-only. */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    dom.store.set(modals.walkthroughKey(FLOOR), "9");
    modals.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "d".repeat(64) });
    const scrim = dom.body.children[dom.body.children.length - 1];
    const stage = walk(scrim).find((n) => n.attrs["data-step-stage"] != null);
    assert.equal(stage.attrs["data-step-stage"], "9", "the stop instructions are step 9");
    const shown = textOf(stage);
    const commands = withAttr(stage, "data-copy").map((n) => n.attrs["data-copy"]);
    const joined = commands.join("\n");
    assert.ok(commands.includes("install -m 600 /dev/null ~/claudeco-executor/PAUSE_ENTRIES"),
      `the pause sentinel is missing or wrong; copyable commands are ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("install -m 600 /dev/null ~/claudeco-executor/HARD_STOP"),
      `the hard-stop sentinel is missing or wrong; copyable commands are ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("rm ~/claudeco-executor/PAUSE_ENTRIES"),
      `resuming is missing; copyable commands are ${JSON.stringify(commands)}`);
    assert.doesNotMatch(joined, /touch ~\/claudeco-executor/,
      `a sentinel created with touch is mode 644 and reads as not owner-only; found ${JSON.stringify(joined)}`);
    assert.match(shown, /owner-only/, "step 9 says why the mode matters");
    assert.match(shown, /refuses new buys but keeps/,
      `step 9 states what a pause does: ${shown.slice(0, 260)}`);
    assert.match(shown, /no new submissions at all, including automated exits/,
      "step 9 states what the hard stop does, exits included");
    assert.match(shown, /Stopping the process does not close an on-chain position/,
      "step 9 does not let a reader believe stopping the service flattens a position");
    assert.ok(commands.includes("sudo systemctl stop cc-executor"),
      `the Linux stop command is missing; got ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("bash ~/claudeco-executor/current/macos-launchagent.sh unload"),
      `the macOS stop command is missing; got ${JSON.stringify(commands)}`);
    assert.match(shown, /uninstall/i, "step 9 also says how to uninstall");
  }

  /* ── 5 · THE CONSENT SHEET RENDERS EVERY CONDITION, EACH WITH ITS OWN BOX ───
     The condition list comes from the server module, so a ninth condition shipped
     without a checkbox fails here rather than collecting a signature nobody gave. */
  const disclosure = copySettings.hqDisclosure();
  const conditionCount = disclosure.conditions.length;
  const consentContext = (dom, overrides = {}) => ({
    floorNo: FLOOR,
    load: async () => ({ floorNo: FLOOR, disclosure,
      consent: { acknowledged: false, stale: false }, history: [] }),
    acknowledge: async (sent) => { dom.sent = sent; return { ok: true,
      view: { floorNo: FLOOR, disclosure,
        consent: { acknowledged: true, stale: false, version: disclosure.version,
          sha256: disclosure.sha256, at: 1_757_190_000_000 }, history: [] } }; },
    withdraw: async () => ({ ok: true, withdrawn: true }),
    registerInterest: async () => { dom.registered = (dom.registered || 0) + 1; return { ok: true }; },
    ...overrides,
  });
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    modals.openHqConsent(consentContext(dom));
    await settle();
    const scrim = dom.body.children[dom.body.children.length - 1];
    const conditions = withAttr(scrim, "data-condition");
    assert.equal(conditions.length, conditionCount,
      `the server serves ${conditionCount} conditions and the sheet renders ${conditions.length}`);
    assert.deepEqual(conditions.map((n) => Number(n.attrs["data-condition"])),
      disclosure.conditions.map((c) => c.n),
      `the numbering on screen is ${JSON.stringify(conditions.map((n) => n.attrs["data-condition"]))}`);
    const ticks = withAttr(scrim, "data-tick");
    assert.equal(ticks.length, conditionCount,
      `one checkbox per condition: ${conditionCount} conditions, ${ticks.length} boxes`);
    for (const condition of conditions) {
      const own = withAttr(condition, "data-tick");
      assert.equal(own.length, 1,
        `condition ${condition.attrs["data-condition"]} owns ${own.length} checkboxes, expected exactly 1`);
    }

    /* EVERY WORD THE HASH WAS TAKEN OVER IS ON SCREEN, and none of it is folded away.
       A collapsed section here would hide the custody sentence, which is the only
       sentence that decides anything. */
    const shown = textOf(scrim);
    for (const condition of disclosure.conditions) {
      assert.ok(shown.includes(condition.heading),
        `condition ${condition.n}'s heading "${condition.heading}" is not on screen`);
      for (const point of condition.points) {
        assert.ok(shown.includes(point),
          `condition ${condition.n} drops a line the hash covers: "${point.slice(0, 70)}…"`);
      }
    }
    for (const line of [...disclosure.intro, ...disclosure.closing]) {
      assert.ok(shown.includes(line), `the disclosure drops "${line.slice(0, 70)}…"`);
    }
    assert.equal(walk(scrim).filter((n) => n.tag === "details" || /(^|\s)fold(\s|$)/.test(n.className)).length, 0,
      "nothing in the consent sheet is behind a disclosure widget");
    assert.ok(shown.includes(disclosure.sha256),
      `the sheet shows the hash of the words it rendered; got ${shown.slice(-160)}`);
    assert.ok(shown.includes(disclosure.version),
      "the sheet shows which disclosure version it rendered");

    /* ── 6 · CONTINUE IS DEAD UNTIL EVERY BOX IS TICKED ─────────────────────── */
    const proceed = withAttr(scrim, "data-consent", "continue")[0];
    assert.equal(proceed.disabled, true,
      `Continue starts disabled=${proceed.disabled} with 0 of ${conditionCount} ticked`);
    for (let index = 0; index < ticks.length; index++) {
      ticks[index].checked = true;
      ticks[index].onchange();
      const want = index < ticks.length - 1;
      assert.equal(proceed.disabled, want,
        `with ${index + 1} of ${conditionCount} ticked Continue is disabled=${proceed.disabled}, ` +
        `expected ${want} (label "${proceed.textContent}")`);
    }
    /* Unticking one takes it back. A gate that only ever opens is not a gate. */
    ticks[3].checked = false; ticks[3].onchange();
    assert.equal(proceed.disabled, true,
      `unticking a box re-disables Continue; disabled=${proceed.disabled}`);
    ticks[3].checked = true; ticks[3].onchange();
    assert.equal(proceed.disabled, false, "and re-ticking it opens the gate again");

    /* ── 7 · THE CONFIRMATION IS HONEST ABOUT WHAT DID NOT HAPPEN ──────────── */
    await proceed.onclick();
    await settle();
    assert.deepEqual(dom.sent, { version: disclosure.version, sha256: disclosure.sha256,
      conditions: disclosure.conditions.map((c) => c.n) },
      `the acknowledgement echoes the served version and hash exactly; it sent ${JSON.stringify(dom.sent)}`);
    assert.equal(dom.registered, 1,
      `the interest is written once after the acknowledgement, not ${dom.registered} times`);
    const confirmation = withAttr(scrim, "data-consent", "confirmation")[0];
    assert.ok(confirmation, "the flow does not end on a confirmation");
    const said = textOf(confirmation);
    for (const promise of [
      /Nothing has been provisioned/,
      /No wallet has been created for you/,
      /There is no deposit address/,
      /No funds should be sent anywhere for this/,
      /if anyone asks you to send funds for it, it is not us/,
      /You will be told if and when this is offered/,
      /a real agreement written by a lawyer will exist for you to read before anything holds your money/,
      /this flow is not that agreement/,
    ]) {
      assert.match(said, promise, `the confirmation must say ${promise}; it says: ${said}`);
    }
    assert.doesNotMatch(said, /your bot is (now )?managed|is now running|funds are|deposit (to|at|address:)/i,
      `the confirmation must not imply anything is running or funded: ${said}`);
    /* NOTHING IN EITHER MODAL MAY LOOK LIKE SOMEWHERE TO SEND MONEY. A base58 run of
       32+ characters is what a Solana address looks like to a reader in a hurry. */
    const everything = textOf(scrim) + " " + withAttr(scrim, "data-copy")
      .map((n) => n.attrs["data-copy"]).join(" ");
    const addressish = everything.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g);
    assert.equal(addressish, null,
      `the consent flow shows something an address-shaped string: ${JSON.stringify(addressish)}`);

    /* WITHDRAWING IS THE SAME ONE CLICK. */
    const undo = withAttr(scrim, "data-consent", "withdraw")[0];
    assert.ok(undo, "withdrawing is not offered on the confirmation");
    assert.equal(undo.hidden, false, `the withdraw control is hidden=${undo.hidden} on the confirmation`);
    await undo.onclick();
    await settle();
    const cleared = withAttr(scrim, "data-consent", "withdrawn")[0];
    assert.ok(cleared, "withdrawing does not confirm itself");
    assert.match(textOf(cleared), /withdrawn/i, `withdrawal says: ${textOf(cleared)}`);
    assert.match(textOf(cleared), /Nothing was ever provisioned/,
      "withdrawal repeats that there was never anything to return");
  }

  /* ── 8 · A CHANGED DISCLOSURE MAKES THEM TICK AGAIN ─────────────────────────
     The hash is the entire audit trail. If the server says the words moved, the page
     re-renders from what came back and reopens the gate — an acknowledgement of
     superseded text certifies nothing. */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    const newer = { ...disclosure, version: disclosure.version + "-next",
      sha256: "f".repeat(64) };
    let attempts = 0;
    modals.openHqConsent(consentContext(dom, {
      acknowledge: async (sent) => {
        attempts++;
        dom.sent = sent;
        if (attempts === 1) return { ok: false, stale: true, error: "the wording changed",
          view: { floorNo: FLOOR, disclosure: newer,
            consent: { acknowledged: false, stale: true }, history: [] } };
        return { ok: true, view: { floorNo: FLOOR, disclosure: newer,
          consent: { acknowledged: true, stale: false, version: newer.version,
            sha256: newer.sha256, at: 1 }, history: [] } };
      },
    }));
    await settle();
    const scrim = dom.body.children[dom.body.children.length - 1];
    const tickAll = () => { for (const box of withAttr(scrim, "data-tick")) { box.checked = true; box.onchange(); } };
    tickAll();
    const proceed = withAttr(scrim, "data-consent", "continue")[0];
    await proceed.onclick();
    await settle();
    assert.equal(dom.registered, undefined,
      `a stale acknowledgement must not record interest; it recorded ${dom.registered}`);
    assert.equal(withAttr(scrim, "data-consent", "confirmation").length, 0,
      "a stale acknowledgement must not land on the confirmation");
    assert.equal(proceed.disabled, true,
      `after a stale answer the gate is shut again; disabled=${proceed.disabled}`);
    const shown = textOf(scrim);
    assert.match(shown, /wording changed/i, `the reader is told why they must tick again: ${shown.slice(0, 200)}`);
    assert.ok(shown.includes(newer.sha256),
      "the sheet now shows the hash of the words that came back, not the ones it had");
    tickAll();
    await proceed.onclick();
    await settle();
    assert.deepEqual(dom.sent, { version: newer.version, sha256: newer.sha256,
      conditions: disclosure.conditions.map((c) => c.n) },
      `the retry echoes the NEW version and hash; it sent ${JSON.stringify(dom.sent)}`);
    assert.equal(dom.registered, 1, `interest is recorded once the current words are accepted`);
  }

  /* ── 9 · A FAILED WRITE IS NEVER REPORTED AS A RECORD ───────────────────────
     For the managed track the record IS the product, so "recorded" must never be
     printed over a write that did not land. */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    modals.openHqConsent(consentContext(dom, {
      registerInterest: async () => ({ ok: false, error: "the desk answered 503" }),
    }));
    await settle();
    const scrim = dom.body.children[dom.body.children.length - 1];
    for (const box of withAttr(scrim, "data-tick")) { box.checked = true; box.onchange(); }
    await withAttr(scrim, "data-consent", "continue")[0].onclick();
    await settle();
    const said = textOf(scrim);
    assert.match(said, /the interest itself was not recorded/,
      `a refused write must say so: ${said.slice(-400)}`);
    assert.match(said, /Nothing was provisioned either way/,
      "and must still say nothing was provisioned");
    assert.equal(withAttr(scrim, "data-consent", "continue")[0].disabled, false,
      "and must leave Continue live so the reader can try again");
  }

  /* ── 10 · A FAILED LOAD LEAVES A READABLE WINDOW ────────────────────────────── */
  {
    const dom = makeDom();
    const modals = loadModals(dom);
    modals.openHqConsent(consentContext(dom, {
      load: async () => { throw new Error("the desk is down"); },
    }));
    await settle();
    const said = textOf(dom.body);
    assert.match(said, /could not be loaded/, `a failed load reads: ${said.slice(0, 300)}`);
    assert.match(said, /Nothing was recorded and nothing was provisioned/,
      "a failed load still states that nothing happened");
    assert.equal(withAttr(dom.body, "data-tick").length, 0,
      "a failed load must not render a tickable sheet");
  }

  /* ── 11 · NOTHING IN EITHER MODAL CALLS SELF-HOSTING HARD WORK ──────────────
     It is one command plus a series of decisions. Padding that friction would be a
     lie told in the direction of the track that hands somebody else the key — the
     worst direction to lie in. The scan reads the STRING LITERALS, which is what a
     tenant is shown, rather than the file, whose comments are notes to the next
     engineer. */
  {
    const shownStrings = (modalSource.match(/"(?:[^"\\\n]|\\.)*"/g) || []).join("   ");
    assert.ok(shownStrings.length > 4000,
      `the modal block yielded only ${shownStrings.length} characters of shown text`);
    for (const word of ["long", "complicated", "difficult", "arduous", "advanced"]) {
      const found = shownStrings.match(new RegExp("\\b" + word + "\\w*", "gi"));
      assert.equal(found, null,
        `neither modal may describe self-hosting as "${word}"; found ${JSON.stringify(found)} ` +
        `in ${shownStrings.length} characters of shown text`);
    }
    /* And the same scan over the text a reader is actually handed, assembled by
       rendering every screen — a word can reach the page through a server payload
       or a concatenation that no literal contains. */
    const dom = makeDom();
    const modals = loadModals(dom);
    let rendered = "";
    for (let step = 1; step <= 9; step++) {
      const fresh = makeDom();
      const build = loadModals(fresh);
      fresh.store.set(build.walkthroughKey(FLOOR), String(step));
      build.openInstallWalkthrough({ floorNo: FLOOR, installerSha256: "e".repeat(64) });
      rendered += " " + textOf(fresh.body);
    }
    modals.openHqConsent(consentContext(dom));
    await settle();
    const consentScrim = dom.body.children[dom.body.children.length - 1];
    rendered += " " + textOf(consentScrim);
    for (const box of withAttr(consentScrim, "data-tick")) { box.checked = true; box.onchange(); }
    await withAttr(consentScrim, "data-consent", "continue")[0].onclick();
    await settle();
    rendered += " " + textOf(consentScrim);
    for (const word of ["long", "complicated", "difficult", "arduous", "advanced"]) {
      const found = rendered.match(new RegExp("\\b" + word + "\\w*", "gi"));
      assert.equal(found, null,
        `the rendered modals must not describe self-hosting as "${word}"; found ${JSON.stringify(found)} ` +
        `in ${rendered.length} characters of rendered text`);
    }
    assert.ok(rendered.length > 8000,
      `the rendered sweep only collected ${rendered.length} characters, so it proved little`);
  }

  /* ── 12 · BOTH MODALS ARE REACHABLE FROM THE CHOICE THAT ALREADY RENDERS ────
     Rendered, not grepped: the fork is built again with the two openers stubbed, and
     pressing each card's second button must reach its own screen. A button that opens
     the wrong modal is exactly as useless as a button that opens nothing. */
  {
    const forkStart = html.indexOf('const RUNNER_SELF = "self";');
    const forkEnd = html.indexOf("/* ── THE WALL-ST-E EXECUTOR CARD");
    const forkSource = html.slice(forkStart, forkEnd);
    const dom = makeDom();
    const fork = new Function("dashNode", forkSource +
      "\nreturn { RUNNER_SELF, RUNNER_HQ, renderRunnerFork };")(dom.document.createElement
        ? (tag, cls, text) => { const n = dom.document.createElement(tag);
            if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
        : null);
    const opened = [];
    const card = fork.renderRunnerFork(null, async () => ({ ok: true }), {
      openWalkthrough: () => opened.push("walkthrough"),
      openConditions: () => opened.push("conditions"),
    });
    const buttons = withAttr(card, "data-runner-more");
    assert.equal(buttons.length, 2,
      `each card offers a way to read before choosing; found ${buttons.length} such buttons`);
    const byTrack = Object.fromEntries(buttons.map((b) => [b.attrs["data-runner-more"], b]));
    assert.ok(byTrack[fork.RUNNER_SELF] && byTrack[fork.RUNNER_HQ],
      `the two buttons belong to ${JSON.stringify(Object.keys(byTrack))}`);
    assert.match(byTrack[fork.RUNNER_SELF].textContent, /9 steps/,
      `the self-hosted card's button reads ${JSON.stringify(byTrack[fork.RUNNER_SELF].textContent)}`);
    assert.match(byTrack[fork.RUNNER_HQ].textContent, /conditions/i,
      `the managed card's button reads ${JSON.stringify(byTrack[fork.RUNNER_HQ].textContent)}`);
    byTrack[fork.RUNNER_SELF].onclick();
    byTrack[fork.RUNNER_HQ].onclick();
    assert.deepEqual(opened, ["walkthrough", "conditions"],
      `pressing the two buttons opened ${JSON.stringify(opened)}`);
    /* READING IS NOT CHOOSING. Neither button may write a track. */
    const wrote = [];
    const readOnly = fork.renderRunnerFork(null, async (value) => { wrote.push(value); return { ok: true }; }, {
      openWalkthrough: () => {}, openConditions: () => {},
    });
    for (const button of withAttr(readOnly, "data-runner-more")) button.onclick();
    assert.deepEqual(wrote, [],
      `opening a modal must record nothing; it wrote ${JSON.stringify(wrote)}`);
  }
  assert.match(html, /more: "Walk me through it · 9 steps",\n\s*moreHook: "openWalkthrough",/,
    "the self-hosted card opens the walkthrough");
  assert.match(html, /more: "Read the conditions first",\n\s*moreHook: "openConditions",/,
    "the managed card opens the conditions");
  assert.match(html, /openWalkthrough: openWallsteWalkthrough,\n\s*openConditions: \(\) => openHqConditions\(/,
    "the WALL-ST-E panel wires both openers into the fork");
  assert.match(html, /if \(saved\.needsAcknowledgement\) \{\n\s*openHqConditions\(/,
    "a 409 from the desk opens the conditions instead of printing a status code");
  assert.match(html, /call_api\("\/api\/floor\/" \+ FLOOR_N \+ "\/bot-operator"/,
    "the choice is written to the route the server actually exposes");
  assert.match(html, /JSON\.stringify\(\{ action: "acknowledge", version, sha256, conditions \}\)/,
    "the acknowledgement carries the served version and hash back unchanged");
  assert.match(html, /JSON\.stringify\(\{ action: "withdraw" \}\)/,
    "withdrawing is one call with no confirmation ceremony of its own");
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * THE COHORT CYCLE ON THE FLOOR PAGE
 *
 * The owner asked for at least three published calls per cycle "at any cost, by any
 * means". The engine pursues that by MORE EFFORT and RELAXED JUDGEMENT on the recorded
 * L0-L4 ladder and never by crossing the safety floor — ~60 of the last 100 kills are
 * safety mechanics, 18 of them cannot_exit where the round-trip probe PROVED the
 * position could not be sold, so a quota filled from that pool is bags, not trades.
 *
 * The page's obligation is the other half of that: SHOW WHAT IT COST. The spec's words
 * are "a reader must be able to see 'this was published at L3 because the cycle was
 * short', never a silent lowering", and "never state or imply that a quota-filled call
 * is as good as an L0 call".
 *
 * So this block RENDERS. The cohort-cycle builders are lifted out of the shipped page
 * and executed against a node shim, and every assertion reads the text a tenant would
 * actually see. A grep would pass on a warning string that is present in the file and
 * never painted — which is precisely the failure this feature exists to prevent.
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  const { MAX_ESCALATION_LEVEL } = await import("./src/config.js");

  const begin = html.indexOf("/* ═══ COHORT CYCLE SURFACE — BEGIN");
  const end = html.indexOf("/* ═══ COHORT CYCLE SURFACE — END");
  assert.ok(begin > 0 && end > begin,
    `could not locate the cohort cycle surface block (begin ${begin}, end ${end})`);
  const source = html.slice(begin, end);

  /* The whole DOM these builders touch. textContent's setter clears children because
     the real one does. */
  const mk = (tag) => {
    const node = { tag, className: "", _text: "", children: [], attrs: {}, style: {},
      title: "", parent: null };
    Object.defineProperty(node, "textContent", {
      get() { return node._text; },
      set(v) { node._text = v == null ? "" : String(v); node.children.length = 0; },
    });
    node.appendChild = (kid) => { kid.parent = node; node.children.push(kid); return kid; };
    node.append = (...kids) => { for (const kid of kids) if (kid) { kid.parent = node; node.children.push(kid); } };
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
    return node;
  };
  const dashNode = (tag, cls, text) => {
    const n = mk(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const cycle = new Function("dashNode", source +
    "\nreturn { CYCLE_LEVELS, cycleLevelInfo, cycleLevelChip, cycleLevelNote," +
    " stampCallWithLevel, cycleCountdown, renderCycleCard, renderCycleStrain," +
    " renderCycleHistory };")(dashNode);

  const walk = (node, out = []) => { out.push(node); for (const kid of node.children) walk(kid, out); return out; };
  const textOf = (node) => walk(node).map((n) => n.textContent).filter(Boolean).join(" ");
  const classesOf = (node) => walk(node).map((n) => n.className).filter(Boolean);

  /* ── 1 · THE LADDER THE PAGE PROMISES IS THE LADDER THE ENGINE HAS ──────────
     There is no L5: no level publishes a safety-failed coin. A sixth row here would
     promise the reader a rung the desk does not have, so it is checked against the
     engine's own constant rather than against a number typed twice. */
  assert.equal(cycle.CYCLE_LEVELS.length, MAX_ESCALATION_LEVEL + 1,
    `the page describes ${cycle.CYCLE_LEVELS.length} levels; config.MAX_ESCALATION_LEVEL is ${MAX_ESCALATION_LEVEL}`);
  assert.deepEqual(cycle.CYCLE_LEVELS.map((l) => l.level), [0, 1, 2, 3, 4],
    `page levels are ${JSON.stringify(cycle.CYCLE_LEVELS.map((l) => l.level))}`);
  assert.equal(cycle.cycleLevelInfo(5), null,
    `cycleLevelInfo(5) returned ${JSON.stringify(cycle.cycleLevelInfo(5))} — there is no L5`);
  /* NULL IS NOT ZERO. A call published outside a cohort had no quota pursuing it. */
  assert.equal(cycle.cycleLevelInfo(null), null, "a null level must not resolve to L0");
  assert.equal(cycle.cycleLevelChip(null).textContent, "no quota",
    `a call with no cycle renders as ${JSON.stringify(cycle.cycleLevelChip(null).textContent)}`);

  /* ── 2 · AN L0 CALL AND AN L3 CALL DO NOT LOOK THE SAME ─────────────────────
     Rendered, both of them, and every claim below prints the text it read. */
  const stamp = (level, cycleId = 7) => {
    const card = mk("div");
    card.className = "call offered";
    const header = mk("header");
    card.appendChild(header);
    const out = cycle.stampCallWithLevel(card, header, { escalation_level: level, cycle_id: cycleId });
    return { card, header, ...out };
  };
  const zero = stamp(0), three = stamp(3);

  assert.equal(zero.chip.textContent, "L0 · normal",
    `the L0 chip reads ${JSON.stringify(zero.chip.textContent)}`);
  assert.equal(three.chip.textContent, "L3 · manufactured story",
    `the L3 chip reads ${JSON.stringify(three.chip.textContent)}`);
  assert.notEqual(zero.chip.textContent, three.chip.textContent,
    "an L0 and an L3 chip must not read the same");
  assert.equal(zero.chip.className, "lvl lvl0",
    `the L0 chip's classes are ${JSON.stringify(zero.chip.className)}`);
  assert.equal(three.chip.className, "lvl lvl3",
    `the L3 chip's classes are ${JSON.stringify(three.chip.className)}`);
  /* The card itself is marked at L2+, on an edge the offered/skipped verdict does not
     own, so a reach cannot be hidden by whichever verdict the floor gave. */
  assert.equal(zero.card.className, "call offered",
    `an L0 card's classes are ${JSON.stringify(zero.card.className)}`);
  assert.match(three.card.className, /\breached\b/,
    `an L3 card's classes are ${JSON.stringify(three.card.className)}`);

  const zeroText = textOf(zero.card), threeText = textOf(three.card);
  assert.match(zeroText, /it cleared the desk's normal bar\. Nothing was relaxed for the quota\./,
    `the L0 card reads: ${JSON.stringify(zeroText)}`);
  assert.doesNotMatch(zeroText, /REACHED/,
    `an L0 card must not carry a reach warning; it reads: ${JSON.stringify(zeroText)}`);
  assert.match(threeText, /REACHED — published at L3 because the cycle was short of quota/,
    `the L3 card reads: ${JSON.stringify(threeText)}`);
  assert.match(threeText, /the X read called this coin's story manufactured/,
    `the L3 card does not say what was relaxed; it reads: ${JSON.stringify(threeText)}`);
  /* THE SAFETY FLOOR IS STATED ON THE CARD, because "we reached" and "we lowered the
     floor" are different claims and the reader must not have to guess which one. */
  assert.match(threeText, /Every safety gate still passed/,
    `the L3 card does not say the safety gates held: ${JSON.stringify(threeText)}`);
  assert.match(three.note.className, /reach/,
    `the L3 note's classes are ${JSON.stringify(three.note.className)}`);
  assert.equal(zero.note.className, "dp-note",
    `the L0 note's classes are ${JSON.stringify(zero.note.className)}`);

  /* L1 IS EFFORT, NOT A REACH. Marking it as one would cry wolf on the level that
     costs money and lowers nothing. */
  const one = stamp(1);
  assert.equal(one.card.className, "call offered",
    `an L1 card's classes are ${JSON.stringify(one.card.className)} — L1 relaxes no standard`);
  assert.match(textOf(one.card), /Effort only — no standard was lowered for this call\./,
    `the L1 card reads: ${JSON.stringify(textOf(one.card))}`);

  /* ── 3 · NOTHING CLAIMS A QUOTA CALL IS EQUIVALENT ──────────────────────────
     Every relaxed level must say so in the same words, and no level may carry the
     opposite claim. Driven over the whole table so a sixth level cannot ship silent. */
  for (const level of cycle.CYCLE_LEVELS.filter((l) => l.reach)) {
    assert.match(level.line, /not as good as a call that cleared at L0/,
      `L${level.level} does not disclaim equivalence; it reads: ${JSON.stringify(level.line)}`);
    assert.match(level.line, /short of quota/,
      `L${level.level} does not say WHY it was relaxed; it reads: ${JSON.stringify(level.line)}`);
  }
  for (const level of cycle.CYCLE_LEVELS) {
    assert.doesNotMatch(level.line, /just as good|as good as an? L0|equivalent|no different|same quality/i,
      `L${level.level} implies equivalence: ${JSON.stringify(level.line)}`);
  }

  /* ── 4 · THE CURRENT CYCLE, IN THE OWNER'S OWN SENTENCE ─────────────────────── */
  const pursuing = cycle.renderCycleCard({ maxLevel: MAX_ESCALATION_LEVEL, enabled: true,
    current: { id: 7, quota: 3, published: 2, short: 1, level: 2, label: "conviction",
      passes: 3, pursuitOver: false, waiting: false, holdingFor: [], overdue: false,
      relaxations: ["L2: conviction floor lowered to 35 (tier 1) — the cycle was short of quota"],
      ageMs: 60_000, forceCloseInMs: 21_540_000, maxAgeMs: 21_600_000,
      calls: [{ escalationLevel: 0 }, { escalationLevel: 2 }] } });
  const pursuingText = textOf(pursuing);
  assert.match(pursuingText, /Cycle 7 — 2 of 3 published, at level L2/,
    `the cycle card reads: ${JSON.stringify(pursuingText.slice(0, 200))}`);
  assert.match(pursuingText, /Still pursuing: 1 short of quota, on pass 3/,
    `the cycle card does not say it is still pursuing: ${JSON.stringify(pursuingText)}`);
  assert.match(pursuingText, /stops at L4/,
    `the cycle card does not name the top of the ladder: ${JSON.stringify(pursuingText)}`);
  assert.match(pursuingText, /a cycle that cannot find 3 publishes what it found and records the shortfall/,
    "the card must say a shortfall is recorded, never filled");
  /* The relaxation wording comes from config.js, which prefixes each string with its own
     level ("L2: conviction floor lowered…"). Rendered after a sentence that already names
     the level it read "escalated to L2. L2: conviction floor lowered…" — measured on the
     rendered page, not guessed — so the duplicate prefix is stripped. */
  assert.match(pursuingText, /This cycle has escalated to L2: conviction floor lowered to 35 \(tier 1\)/,
    `the escalation line rendered as: ${JSON.stringify(pursuingText)}`);
  assert.doesNotMatch(pursuingText, /L2: L2:|escalated to L2\. L2:/,
    `the level prefix is printed twice: ${JSON.stringify(pursuingText)}`);
  /* THE INSTRUMENT ITSELF REFUSES THE EQUIVALENCE, not only the cards on it. */
  assert.match(pursuingText, /a call published at a higher level is not as good as one that cleared at L0/,
    `the cycle card does not disclaim equivalence: ${JSON.stringify(pursuingText)}`);
  assert.match(pursuingText, /no escalation and no quota publishes a coin that failed a safety gate/,
    `the cycle card does not state the safety floor: ${JSON.stringify(pursuingText)}`);
  /* The quota bar paints one slot per call, coloured by what that call cost. */
  const bar = walk(pursuing).find((n) => n.className === "cyclebar");
  assert.ok(bar, "the cycle card has no quota progress bar");
  assert.deepEqual(bar.children.map((s) => s.className), ["done", "reach", ""],
    `the three quota slots painted as ${JSON.stringify(bar.children.map((s) => s.className))} for calls at L0, L2 and an empty slot`);

  /* ── 5 · HOLDING, AND THE AGE GUARD'S CLOCK ─────────────────────────────────
     The cohort waiting on its own calls is the state that looks like a stalled desk
     from outside and is in fact the model working, so it has to be named. */
  const holding = cycle.renderCycleCard({ maxLevel: MAX_ESCALATION_LEVEL,
    current: { id: 8, quota: 3, published: 3, short: 0, level: 1, label: "widen", passes: 2,
      pursuitOver: true, waiting: true, holdingFor: [41, 42], overdue: false,
      relaxations: [], ageMs: 1000, forceCloseInMs: 12_000_000, maxAgeMs: 21_600_000,
      calls: [{ escalationLevel: 0 }, { escalationLevel: 1 }, { escalationLevel: 0 }] } });
  const holdingText = textOf(holding);
  assert.match(holding.className, /waiting/,
    `a holding cycle's card classes are ${JSON.stringify(holding.className)}`);
  assert.match(holdingText, /waiting for 2 calls to close before the next cycle opens/,
    `the holding card reads: ${JSON.stringify(holdingText.slice(0, 260))}`);
  assert.match(holdingText, /3h 20m left before the age guard force-closes it/,
    `the countdown rendered as: ${JSON.stringify(holdingText)}`);
  /* A FORCE-CLOSE IS NOT A CANCELLATION. The still-open calls keep being monitored and
     exited; they only stop holding the gate. Saying otherwise would read as the desk
     abandoning live positions. */
  assert.match(holdingText, /They stay live and keep being monitored and exited/,
    `the holding card does not say what a force-close does: ${JSON.stringify(holdingText)}`);
  assert.equal(cycle.cycleCountdown(12_000_000), "3h 20m",
    `cycleCountdown(12000000) = ${JSON.stringify(cycle.cycleCountdown(12_000_000))}`);
  assert.equal(cycle.cycleCountdown(1_080_000), "18m",
    `cycleCountdown(1080000) = ${JSON.stringify(cycle.cycleCountdown(1_080_000))}`);

  /* Past the guard and not yet settled: the read never force-closes, so it says so. */
  const overdue = cycle.renderCycleCard({ maxLevel: MAX_ESCALATION_LEVEL,
    current: { id: 9, quota: 1, published: 1, short: 0, level: 4, label: "band", passes: 5,
      pursuitOver: true, waiting: true, holdingFor: [77], overdue: true, relaxations: [],
      ageMs: 22_000_000, forceCloseInMs: 0, maxAgeMs: 21_600_000,
      calls: [{ escalationLevel: 4 }] } });
  assert.match(textOf(overdue), /Past the age guard — it will be force-closed on the desk's next pursuit pass/,
    `the overdue card reads: ${JSON.stringify(textOf(overdue).slice(0, 260))}`);
  assert.match(textOf(overdue), /If this line persists, the pursuit loop has stopped/,
    "an overdue cycle that never clears is itself a signal, and the page says so");
  const overdueBar = walk(overdue).find((n) => n.className === "cyclebar");
  assert.deepEqual(overdueBar.children.map((s) => s.className), ["hard"],
    `an L4 quota slot paints as ${JSON.stringify(overdueBar.children.map((s) => s.className))}`);

  /* No cycle open is a normal state between cohorts, not an error. */
  const idle = cycle.renderCycleCard({ maxLevel: MAX_ESCALATION_LEVEL, enabled: true, current: null });
  assert.match(textOf(idle), /No cycle is open/,
    `with no open cycle the card reads: ${JSON.stringify(textOf(idle))}`);
  const off = cycle.renderCycleCard({ maxLevel: MAX_ESCALATION_LEVEL, enabled: false, current: null });
  assert.match(textOf(off), /cohort gate is switched off \(CYCLE_COHORT=0\)/,
    `with the gate disabled the card reads: ${JSON.stringify(textOf(off))}`);

  /* ── 6 · THE STRAIN SIGNAL ──────────────────────────────────────────────────
     Regularly reaching L3/L4, or regularly falling short, is the owner's evidence that
     the funnel is too tight or the market is bad. It is more useful than a green
     number, and it must appear on the page rather than only on the wire. */
  const strained = cycle.renderCycleStrain({ straining: true, cycles: 6, reaching: 4,
    reachingPct: 67, short: 2, shortPct: 33, forced: 1,
    headline: "The quota is straining: 4 of the last 6 closed cycles reached L3 or L4 (67%) " +
      "and 2 fell short of quota (33%), with 1 force-closed on the age guard. That is evidence the " +
      "funnel is too tight or the market is bad. It is not a reason to lower the safety floor." });
  const strainedText = textOf(strained);
  assert.match(strained.className, /\bon\b/,
    `a straining signal's classes are ${JSON.stringify(strained.className)}`);
  assert.match(strainedText, /The quota is straining/,
    `the strain box reads: ${JSON.stringify(strainedText)}`);
  assert.match(strainedText, /4 of the last 6 closed cycles reached L3 or L4 \(67%\)/,
    "the strain box shows its counts, not an adjective");
  assert.match(strainedText, /not a reason to lower the safety floor/,
    `the strain box does not name the remedy that is unavailable: ${JSON.stringify(strainedText)}`);

  const calm = cycle.renderCycleStrain({ straining: false, cycles: 6, reaching: 0,
    reachingPct: 0, short: 0, shortPct: 0, forced: 0,
    headline: "Not straining: over the last 6 closed cycles the desk reached L3 or L4 in 0 (0%) " +
      "and fell short of quota in 0 (0%), both under the 34% bar." });
  assert.equal(calm.className, "strain",
    `a calm signal's classes are ${JSON.stringify(calm.className)}`);
  assert.doesNotMatch(textOf(calm), /The quota is straining/,
    `a calm desk must not print the alarm; it reads: ${JSON.stringify(textOf(calm))}`);
  assert.match(textOf(calm), /reached L3 or L4 in 0 \(0%\)/,
    "even the quiet case shows the counts behind it");

  /* ── 7 · HISTORY: shortfall and force-close are visible, never smoothed ────── */
  const history = cycle.renderCycleHistory([
    { id: 12, quota: 3, published: 1, levelReached: 4, shortfall: true, forcedClose: true,
      forcedOpenIds: [88], realisedPnlPct: -22.4, stillLive: 1, open: false },
    { id: 11, quota: 3, published: 3, levelReached: 0, shortfall: false, forcedClose: false,
      forcedOpenIds: [], realisedPnlPct: 13.5, stillLive: 0, open: false },
  ]);
  const historyText = textOf(history);
  assert.match(historyText, /Cycle 12 1 of 3 published/,
    `the history row reads: ${JSON.stringify(historyText.slice(0, 300))}`);
  assert.match(historyText, /short 1\/3/,
    `a short cohort is not marked SHORT: ${JSON.stringify(historyText)}`);
  assert.match(historyText, /force-closed · 1 still live/,
    `a force-closed cohort does not name what was still open: ${JSON.stringify(historyText)}`);
  /* And says it ONCE. Measured on the rendered row: it read "FORCE-CLOSED · 1 STILL LIVE
     1 still live", the pill and the plain count both firing on the same fact. */
  assert.equal((historyText.match(/still live/g) || []).length, 1,
    `"still live" appears ${(historyText.match(/still live/g) || []).length} times in: ${JSON.stringify(historyText)}`);
  assert.match(historyText, /-22\.4% realised/, "each cohort shows its realised P&L");
  assert.match(historyText, /\+13\.5% realised/, "including the ones that worked");
  assert.match(historyText, /a cycle that publishes one honest call is worth more than three with two that cannot be sold/,
    `the history does not state the shortfall rule: ${JSON.stringify(historyText)}`);
  /* The level each cohort reached is on its row, so the reader can pair a P&L with the
     effort behind it rather than reading a bare percentage. */
  assert.ok(classesOf(history).includes("lvl lvl4") && classesOf(history).includes("lvl lvl0"),
    `history rows carry level chips: ${JSON.stringify(classesOf(history).filter((c) => c.startsWith("lvl")))}`);

  /* ── 8 · THE PAGE ACTUALLY WIRES IT UP ──────────────────────────────────────
     The builders above are useless if nothing calls them, and a call sheet with no
     cycle card is exactly the silent state this feature replaces. */
  assert.match(html, /call_api\("\/api\/cycle"\)/,
    "the page never fetches the cycle route");
  assert.equal((html.match(/paintCycleSurface\(/g) || []).length, 4,
    `paintCycleSurface is defined once and called from three panels; found ${(html.match(/paintCycleSurface\(/g) || []).length} occurrences`);
  assert.match(html, /paintCycleSurface\(callsCycleSlot, \{ history: true \}\)/,
    "the Calls → Published panel shows the cycle with its history");
  assert.match(html, /paintCycleSurface\(cycleSlot, \{ history: false \}\)/,
    "the Overview shows the current cycle");
  assert.match(html, /paintCycleSurface\(visitorCycleSlot, \{ history: false \}\)/,
    "a visitor with no floor open still sees what the house desk's quota is doing");
  /* EVERY LIST OF CALLS CARRIES THE LEVEL. Two places list calls: the call cards and
     the Overview's recent summary. A view where an L3 and an L0 are indistinguishable
     is a silent lowering wherever it is. */
  assert.match(html, /stampCallWithLevel\(el, h, c\)/,
    "the call cards are not stamped with the level they were published at");
  assert.match(html, /row\.appendChild\(cycleLevelChip\(call\.escalation_level\)\)/,
    "the Overview's recent-calls list drops the level");
  /* The server has to send it: copy.feedFor selects an explicit column list, so the
     stamp is put back in office.js. If that is removed, every card reads as no-quota. */
  assert.match(officeSource, /withEscalation\(copy\.feedFor\(floorNo/,
    "the floor feed no longer carries the cohort stamp, so no card can show a level");
}

console.log("dashboard HUD, candidate separation, WALL-ST-E boundary, runner fork, install walkthrough, HQ consent, Callouts contract, and the cohort cycle surface pass");
