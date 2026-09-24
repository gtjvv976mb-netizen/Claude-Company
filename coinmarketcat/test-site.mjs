/**
 * THE WEBSITE SAYS WHAT THE CODE DOES, AND THE CONSOLE STAYS A BRIDGE.
 *
 * site/ is published to GitHub Pages as three pages: the agency (site/index.html), the
 * cat's own page (site/coinmarketcat/index.html) and the console the extension's content
 * script attaches to (site/console/index.html). This file pins what those pages may and
 * may not be:
 *
 *   · THE NUMBERS ARE THE CODE'S. Every dial the pages quote — the ten-second crouch, the
 *     1.0x follow-through, the 1.5x take, the 90 s stall, the 180 s clock, the 20% stop,
 *     the 0.005 SOL ticket, the 0.01 SOL day, the 1 SOL ceiling, eight stocks, the 12-
 *     character passphrase, the eight-hour unlock, the Phantom windows — is read from the
 *     module that decides it and must appear on the page. Every figure from the desk's
 *     record is read from RECORD. A dial that moves in code and not on the site fails here.
 *   · THE CONSOLE IS STILL THE BRIDGE. Its channel and message types are protocol.mjs's,
 *     the sender it trusts is the one content.mjs stamps, it posts to its own origin only,
 *     every element its script draws into exists, and it asks the extension for nothing
 *     but "are you there?" and "connect".
 *   · NO PAGE CAN SIGN, COLLECT OR SEND. No signing call, no wallet provider, no key word,
 *     no form or input, no network call, no external script, and localStorage holds the
 *     theme and nothing else.
 *   · HONEST AND CLEAN. The risk notice and "unmeasured" are there; hype words, invented
 *     counts and returns are not; the agency says it is not a government agency and the
 *     cat says it is not CoinMarketCap, on every page; agents in training carry no
 *     invented features or dates.
 *   · IT HANGS TOGETHER. Each page has a title, a description, a viewport and og tags; the
 *     three link to each other and to the repository; every local link, asset and
 *     #fragment resolves.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DEFAULTS, RECORD, MAX_QUOTE_MINTS, STOCK_FOCUS_CHOICES, AUTOPILOT_UNLOCK_MINUTES,
  SNIPE_OPERATOR_MAX, snipeArmSentence, CONSOLE_URLS,
} from "./src/lib/config.mjs";
import { SNIPE_DEFAULTS as POLICY_DEFAULTS } from "./vendor/executor/snipe-policy.mjs";
import { CHANNEL, BRIDGE } from "./src/lib/protocol.mjs";
import { MIN_PASSPHRASE_LENGTH, DEFAULT_UNLOCK_TTL_MS } from "./src/lib/session-wallet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "site");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const section = (title) => console.log(`\n${title}\n${"─".repeat(title.length)}`);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const REPO = "https://github.com/gtjvv976mb-netizen/coinmarketcat";
const PAGES_ORIGIN = "https://gtjvv976mb-netizen.github.io/coinmarketcat/";
const PAGES = {
  agency: "index.html",
  cat: path.join("coinmarketcat", "index.html"),
  console: path.join("console", "index.html"),
};
const html = Object.fromEntries(Object.entries(PAGES).map(([k, rel]) => [k, fs.readFileSync(path.join(SITE, rel), "utf8")]));

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&#9790;": "☾" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp|#9790);/g, (m) => ENTITIES[m]);
/** The words a visitor reads: scripts, styles and tags removed, entities decoded, spaces folded. */
const textOf = (page) => decode(page
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
  .replace(/<[^>]+>/g, " "))
  .replace(/\s+/g, " ");
const text = Object.fromEntries(Object.entries(html).map(([k, v]) => [k, textOf(v)]));
const meta = (page, attr, name) => {
  const m = page.match(new RegExp(`<meta\\s+${attr}="${name.replace(/[:.]/g, "\\$&")}"\\s+content="([^"]*)"`, "i"));
  return m ? decode(m[1]) : null;
};
const has = (key, phrase) => text[key].includes(phrase);

section("EVERY PAGE IS A PAGE");
for (const [key, page] of Object.entries(html)) {
  const title = (page.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  ok(`${key}: a <title>`, title.trim().length >= 10, title);
  ok(`${key}: lang and doctype`, /^<!doctype html>/i.test(page) && /<html lang="en"/.test(page));
  ok(`${key}: a phone viewport`, /<meta name="viewport" content="width=device-width, initial-scale=1">/.test(page));
  const description = meta(page, "name", "description");
  ok(`${key}: a meta description`, description && description.length >= 80 && description.length <= 400, `${description?.length ?? 0} chars`);
  for (const og of ["og:title", "og:description", "og:type", "og:site_name"])
    ok(`${key}: ${og}`, Boolean(meta(page, "property", og)));
  ok(`${key}: og:image is the cat, absolute`, meta(page, "property", "og:image") === `${PAGES_ORIGIN}icons/coinmarketcat-512.png`);
  const ogUrl = meta(page, "property", "og:url");
  ok(`${key}: og:url is this page on the Pages origin`, ogUrl === PAGES_ORIGIN + PAGES[key].replace(/index\.html$/, "").split(path.sep).join("/"), ogUrl);
  ok(`${key}: the cat icon is the favicon`, /<link rel="icon" href="(\.\.\/)?icons\/coinmarketcat\.svg" type="image\/svg\+xml">/.test(page));
  ok(`${key}: the three typefaces`, /family=Instrument\+Serif/.test(page) && /family=Archivo/.test(page) && /family=JetBrains\+Mono/.test(page));
  ok(`${key}: night first, the day shift stored under cc_theme`,
    /localStorage\.getItem\("cc_theme"\)/.test(page) && /t === "light" \? "light" : "dark"/.test(page)
      && /localStorage\.setItem\("cc_theme", next\)/.test(page) && /id="shiftbtn"/.test(page));
  ok(`${key}: violet and mint`, /#9945ff/i.test(page) && /#14f195/i.test(page) || /agency\.css/.test(page));
}
const css = fs.readFileSync(path.join(SITE, "assets", "agency.css"), "utf8");
ok("the stylesheet carries violet #9945ff and mint #14f195, night first", /--violet:#9945ff/.test(css) && /--mint:#14f195/.test(css) && /:root\[data-theme="light"\]/.test(css));

section("THE PAGES LINK TO EACH OTHER, AND EVERY LOCAL LINK RESOLVES");
const hrefs = (page) => [...page.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => decode(m[1]));
ok("agency → the cat, the console, the repository", ["coinmarketcat/", "console/", REPO].every((h) => hrefs(html.agency).includes(h)));
ok("the cat → the agency, the console, the repository", ["../", "../console/", REPO].every((h) => hrefs(html.cat).includes(h)));
ok("the console → the agency, the cat, the repository", ["../", "../coinmarketcat/", REPO].every((h) => hrefs(html.console).includes(h)));
const idsIn = (page) => new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const missing = [];
for (const [key, rel] of Object.entries(PAGES)) {
  for (const href of hrefs(html[key])) {
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    const [p, frag] = href.split("#");
    let target = p ? path.normalize(path.join(SITE, path.dirname(rel), p)) : path.join(SITE, rel);
    if (p && (p.endsWith("/") || fs.existsSync(target) && fs.statSync(target).isDirectory())) target = path.join(target, "index.html");
    if (!target.startsWith(SITE + path.sep) || !fs.existsSync(target)) { missing.push(`${key}: ${href}`); continue; }
    if (frag && target.endsWith(".html") && !idsIn(fs.readFileSync(target, "utf8")).has(frag)) missing.push(`${key}: ${href} (no #${frag})`);
  }
}
ok("every local link, asset and #fragment resolves inside site/", missing.length === 0, missing.join(", ") || "all resolve");
const external = Object.values(html).flatMap(hrefs).filter((h) => /^https?:/.test(h));
const allowedHosts = new Set(["github.com", "fonts.googleapis.com", "fonts.gstatic.com", "gtjvv976mb-netizen.github.io"]);
ok("external links only to the repository, the Pages origin and Google Fonts",
  external.every((h) => allowedHosts.has(new URL(h).host)) && external.filter((h) => new URL(h).host === "github.com").every((h) => h.startsWith(REPO)),
  [...new Set(external.map((h) => new URL(h).host))].join(", "));
ok("the icons the pages use are the cat's", ["coinmarketcat.svg", "coinmarketcat-32.png", "coinmarketcat-128.png", "coinmarketcat-512.png"].every((f) => fs.existsSync(path.join(SITE, "icons", f))));

section("THE CONSOLE IS STILL THE BRIDGE");
const script = (html.console.match(/<script>\s*\/\* The console panel[\s\S]*?<\/script>/) || [""])[0];
ok("the console's panel script is there", script.length > 1000);
ok(`it speaks on protocol.mjs's channel (${CHANNEL})`, script.includes(`const CHANNEL = "${CHANNEL}";`));
ok("it says hello and connect with protocol.mjs's page types", script.includes(`type: "${BRIDGE.PAGE_HELLO}"`) && script.includes(`type: "${BRIDGE.PAGE_CONNECT}"`));
ok("it renders only the status type, from the sender content.mjs stamps",
  script.includes(`d.type !== "${BRIDGE.STATUS}"`) && script.includes('d.from !== "hawk-extension"')
    && fs.readFileSync(path.join(here, "src", "content.mjs"), "utf8").includes('from: "hawk-extension"'));
ok("it listens to its own window only, and posts to its own origin only",
  script.includes("if (event.source !== window) return;")
    && [...script.matchAll(/postMessage\(/g)].length === 2
    && [...script.matchAll(/postMessage\(\{[^}]*\},\s*([^)]*)\)/g)].map((m) => m[1].trim()).join() === "location.origin,location.origin");
const posted = [...script.matchAll(/type: "([^"]+)"/g)].map((m) => m[1]);
ok("it asks the extension for nothing but hello and connect", posted.every((t) => t === BRIDGE.PAGE_HELLO || t === BRIDGE.PAGE_CONNECT), posted.join(", "));
const drawn = [...new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
const consoleIds = idsIn(html.console);
ok("every element the panel draws into exists", drawn.length >= 12 && drawn.every((id) => consoleIds.has(id)), drawn.filter((id) => !consoleIds.has(id)).join(", ") || `${drawn.length} ids`);
ok("the console lives where the extension looks for it",
  CONFIG_DEFAULTS.consoleUrl === `${PAGES_ORIGIN}console/` && CONSOLE_URLS.includes(CONFIG_DEFAULTS.consoleUrl) && fs.existsSync(path.join(SITE, "console", "index.html")));

section("NO PAGE CAN SIGN, COLLECT OR SEND");
const siteFiles = walk(SITE).filter((f) => /\.(html|css|svg|js|mjs)$/.test(f));
const BANNED = [
  [/signAndSendTransaction|signAllTransactions|signMessage|signTransaction/, "a signing call"],
  [/window\.phantom|window\.solana|\.solana\.connect/, "the wallet provider"],
  [/secretKey|privateKey|Keypair|mnemonic|seed phrase/i, "a key word"],
  [/<form|<input|<textarea|<select/i, "a form field"],
  [/\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon|navigator\.clipboard/, "a network or clipboard call"],
  [/sessionStorage|indexedDB|document\.cookie/, "storage beyond the theme"],
  [/<script[^>]+src=/i, "an external script"],
  [/<iframe/i, "a frame"],
];
for (const [re, what] of BANNED) {
  const hits = siteFiles.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(here, f));
  ok(`no ${what} anywhere in site/`, hits.length === 0, hits.join(", "));
}
const storageKeys = siteFiles.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/localStorage\.(\w+)\(([^,)]*)/g)].map((m) => `${m[1]}(${m[2]})`));
ok("localStorage holds the theme and nothing else", storageKeys.length >= 6 && storageKeys.every((k) => /^(getItem|setItem)\("cc_theme"\)$/.test(k)), [...new Set(storageKeys)].join(", "));

section("THE NUMBERS ARE THE CODE'S");
const pinned = (name, codeOk, pagesOk, detail) => ok(name, codeOk && pagesOk, detail);
pinned("the crouch: ten seconds", CONFIG_DEFAULTS.entryWaitMs === 10_000, has("cat", "crouches ten seconds") && has("cat", "Crouch 10 s") && has("agency", "Crouches ten seconds"));
pinned("the pounce: still at or above its entry price", CONFIG_DEFAULTS.entryFollowThroughX === 1, has("cat", "at or above its entry price") && has("agency", "at or above its entry price"));
pinned("the take: 1.5x by default", CONFIG_DEFAULTS.takeAtEntryX === 1.5, has("cat", "1.5× by default") && has("cat", "Take 1.5×") && has("agency", "1.5× by default"));
pinned("the stall: under entry at 90 seconds", POLICY_DEFAULTS.stallMs === 90_000 && POLICY_DEFAULTS.stallAtX === 1, has("cat", "still under its entry price at ninety seconds") && has("agency", "after 90 s"));
pinned("the clock: 180 seconds", POLICY_DEFAULTS.timeStopMs === 180_000, has("cat", "after 180") && has("cat", "Out by 180 s") && has("agency", "after 180 s"));
pinned("the default stop: 20% of entry", POLICY_DEFAULTS.stopFrac === 0.2, has("cat", "20% of entry"));
pinned("the break-even at the canary: about 22%", Math.round((POLICY_DEFAULTS.fallbackFrictionX - 1) * 100) === 22, has("cat", "about 22% just to break even"));
pinned("the ticket: 0.005 SOL by default, never above 1 SOL",
  CONFIG_DEFAULTS.maxSolPerTrade === 0.005 && SNIPE_OPERATOR_MAX.maxSolPerTrade === 1, has("cat", "0.005 SOL default") && has("cat", "never above 1 SOL"));
pinned("the day: 0.01 SOL by default", CONFIG_DEFAULTS.dailySolCap === 0.01, has("cat", "0.01 SOL default"));
pinned("the arm sentence shown is the lane's own, for the default numbers",
  true, has("cat", snipeArmSentence("<your wallet>", CONFIG_DEFAULTS.maxSolPerTrade, CONFIG_DEFAULTS.dailySolCap)));
pinned("stocks: up to eight, and the five the setup page offers",
  MAX_QUOTE_MINTS === 8 && STOCK_FOCUS_CHOICES.map((c) => c.symbol).join() === "GLDx,TSLAx,SPYx,AAPLx,NVDAx",
  has("cat", "up to eight tokenised stocks") && has("cat", "GLDx, TSLAx, SPYx, AAPLx and NVDAx"));
pinned("stocks: with none listed, SOL only", CONFIG_DEFAULTS.quoteMints.length === 0, has("cat", "none SOL only") && has("cat", "With none listed, it refuses them all"));
pinned("the pool venue: off until you switch it on", CONFIG_DEFAULTS.xstockVenue === false, has("cat", "Off until you switch it on") && has("agency", "once you switch it on"));
pinned("who signs: Phantom by default", CONFIG_DEFAULTS.signerMode === "phantom", has("cat", "Approving in Phantom is the default") && has("agency", "(the default)"));
pinned("the setup page saves into Observe",
  fs.readFileSync(path.join(here, "src", "welcome", "welcome.mjs"), "utf8").includes('lane: "observe"') && CONFIG_DEFAULTS.lane !== "execute",
  has("cat", "Saving puts the cat in Observe"));
pinned("the passphrase: at least 12 characters", MIN_PASSPHRASE_LENGTH === 12, has("cat", "at least 12 characters"));
pinned("the unlock: eight hours by default", DEFAULT_UNLOCK_TTL_MS === 8 * 3_600_000 && AUTOPILOT_UNLOCK_MINUTES.default === 480, has("cat", "eight hours by default"));
pinned("Phantom windows: a buy abandoned at 25 s, a sell re-asked at 8 s, dropped at 32 s",
  CONFIG_DEFAULTS.approvalTimeoutMs === 25_000 && CONFIG_DEFAULTS.sellReaskMs === 8_000 && CONFIG_DEFAULTS.sellReaskMs * 4 === 32_000,
  has("cat", "past 25 seconds") && has("cat", "asked again 8 seconds later") && has("cat", "dropped after 32 seconds"));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
pinned("Chrome and Node versions", manifest.minimum_chrome_version === "116" && pkg.engines.node === ">=22.13 <25", has("cat", "Chrome 116 or later") && has("cat", "Node.js 22.13 to 24"));
pinned("the repository", pkg.repository.url === REPO, has("cat", `git clone ${REPO}`));

section("THE RECORD IS RECORD'S");
const under3 = RECORD.bySecondsLate.find((b) => b.bucket === "under 3s");
const late = RECORD.bySecondsLate.find((b) => b.bucket === "10s+");
const reached15 = RECORD.reached.find((r) => r.x === 1.5);
pinned("10 up, 48 down, −1.58 SOL over the first 58", RECORD.first58.won === 10 && RECORD.first58.lost === 48 && RECORD.first58.trades === 58 && RECORD.first58.netSol.toFixed(2) === "-1.58",
  has("cat", "10 up · 48 down") && has("cat", "first 58 round trips") && has("cat", "−1.58 SOL"));
pinned("entries under three seconds: 0 of 9", under3.n === 9 && under3.wonPct === 0, has("cat", "0 of 9"));
pinned("the ten-minute clock: 0 of 18", RECORD.tenMinuteClock.ran === 18 && RECORD.tenMinuteClock.won === 0, has("cat", "0 of 18"));
pinned("reached 1.5x: 28 of 64", reached15.of64 === 28 && RECORD.all64.trades === 64, has("cat", "28 of 64"));
pinned("ten seconds and later: 4 of 10, called not a sample", late.n === 10 && late.wonPct === 40, has("cat", "4 of 10 won") && has("cat", "ten trades is not a sample"));
pinned("read off mainnet on the record's date", RECORD.readAt === "2026-09-17", has("cat", RECORD.readAt) && has("console", RECORD.readAt));
const table = html.console.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
const fmt = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + "%";
ok("the console's seconds-late table is RECORD.bySecondsLate, row for row",
  RECORD.bySecondsLate.every((b) => table.includes(`<td class="n">${b.n}</td><td class="n">${b.wonPct}%</td><td class="n">${fmt(b.meanPct)}</td>`)));

section("HONEST, AND CLEAN");
for (const phrase of [
  "Launch sniping loses money more often than not.",
  "The lane this cat learned from has been unprofitable.",
  "This cat's own live record is unmeasured.",
  "Use observe mode first. Only fund what you can afford to lose.",
  "None of this is evidence of an edge.",
  "no Autopilot trade, fund or sweep has yet been made on mainnet",
  "Nothing has been measured yet about stock-paired launches or pools",
])
  ok(`the cat's page says: "${phrase.slice(0, 60)}"`, has("cat", phrase));
ok("the agency calls the track record unmeasured", has("agency", "Unmeasured in this lane"));
ok("the console keeps its fine print", has("console", "Not advice, not a signal service"));
const HYPE = [
  [/guarantee/i, "guarantee"], [/risk[- ]free/i, "risk-free"], [/passive income/i, "passive income"],
  [/\b(moon|lambo|100x|to the moon)\b/i, "moon talk"], [/\bAPY\b|\bAPR\b/, "a yield"],
  [/testimonial|\bfive stars?\b|as seen on|trusted by/i, "social proof"],
  [/\b\d[\d,.]*\s*\+?\s*(users|traders|downloads|installs|members|customers)\b/i, "a user count"],
  [/\b(earn|made|returns?|profit)\s+(of\s+|up to\s+)?[+]?\d+(\.\d+)?\s*%/i, "a quoted return"],
];
for (const [re, what] of HYPE) {
  const hits = Object.entries(text).filter(([, t]) => re.test(t)).map(([k]) => k);
  ok(`no ${what} on any page`, hits.length === 0, hits.join(", "));
}
for (const key of Object.keys(html)) {
  ok(`${key}: says the agency is not a government agency`, has(key, "Cat Intelligence Agency is a software project, not a government agency."));
  ok(`${key}: says the cat is not CoinMarketCap`, has(key, "CoinMarketCat is not affiliated with CoinMarketCap"));
}
const officialHits = siteFiles.filter((f) => /\.gov\b|\bCIA\b|\bseal\b|\beagle\b|\bbadge\b|coinmarketcap\.com/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(here, f));
ok("no .gov, no agency initials, no seal, eagle or badge, no CoinMarketCap domain", officialHits.length === 0, officialHits.join(", "));
const cmcMentions = Object.values(text).join(" ").match(/[^.]*CoinMarketCap[^.]*/g) ?? [];
ok("CoinMarketCap is named only to say there is no affiliation", cmcMentions.length >= 3 && cmcMentions.every((s) => /not affiliated|Is it CoinMarketCap\?/.test(s)), `${cmcMentions.length} mentions`);
const trainees = [...html.agency.matchAll(/<div class="trainee">([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/g)].map((m) => textOf(m[1]).trim());
ok("agents in training are silhouettes: a number, a withheld codename, and nothing else",
  trainees.length >= 1 && trainees.every((t) => /^Agent 00\d Codename withheld In training$/.test(t)), trainees.join(" | "));
ok("Agent 001 is CoinMarketCat, field status active", has("agency", "Field status: active") && has("agency", "CoinMarket Cat") && has("cat", "Agent 001 · field status: active"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
