// Produce self-contained pages: the published artifact CSP forbids any external fetch,
// so three.js is inlined rather than served from /vendor.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inlineThree } from "./inline-three.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const { hawkStatus, injectHawkStatus } = await import(path.join(ROOT, "executor", "hawk-status.mjs"));
const VIEWER = path.join(ROOT, "viewer");
const OUT = path.join(ROOT, "dist");

const IMPORT_LINE = /^import \* as THREE from "\/vendor\/three\/three\.module\.js";.*$/m;
const executorCommitInput = String(process.env.EXECUTOR_COMMIT || process.env.GITHUB_SHA || "").trim();
const releaseBuild = Boolean(executorCommitInput);
if (releaseBuild && !/^[0-9a-f]{40}$/i.test(executorCommitInput)) {
  throw new Error("EXECUTOR_COMMIT (or CI GITHUB_SHA) must identify the exact 40-character build commit");
}
if (!releaseBuild && (process.env.CI || process.env.GITHUB_ACTIONS)) {
  throw new Error("release builds require EXECUTOR_COMMIT or GITHUB_SHA");
}
// A local preview remains buildable without pretending its uncommitted executor
// graph belongs to HEAD. The viewer detects this non-SHA sentinel, disables both
// copy buttons, and displays a deliberately non-runnable instruction instead.
const EXECUTOR_COMMIT = releaseBuild
  ? executorCommitInput.toLowerCase()
  : "LOCAL_PREVIEW_NOT_INSTALLABLE";

// Source pages use the dev server's routes. The static build has no server, so every
// route becomes a plain relative link — which also keeps the site working when GitHub
// Pages hosts it under a /claude-tower/ subpath.
const PAGES = [
  { src: "index.html",    out: "index.html" },   // the gateway — two towers, one desk
  { src: "solana.html",   out: "solana.html" },  // Claude Tower on Solana, the original homepage
  { src: "tower.html",    out: "tower.html" },
  { src: "office3d.html", out: "floor.html" },
  { src: "buy.html",      out: "buy.html" },
  { src: "404.html",      out: "404.html" },
];
const ASSETS = [
  "claudeco-512.png", "claudeco-256.png", "claudeco-64.png",
  "claudeco-rh-256.png",          // the Robinhood edition's own mark, for the lease floor
  "banner-1500x500.png", "banner-1200x630.png",
  "codex-turntable-cover.png", "codex-turntable.gif", "codex-turntable.mp4",
  "grox-mulder-front.png",
];
const PUBLIC_FONTS = ["Archivo-Bold.ttf", "InstrumentSerif-Regular.ttf"];
// Publish only the finished article artifacts. README files, render templates,
// source-only hero imagery and generator scripts stay out of the static site.
const MARKETING_ARTICLES = [
  {
    source: "wall-st-e-article",
    slug: "wall-st-e",
    files: [
      "article.md",
      "wall-st-e-article-cover.png", "wall-st-e-article-cover-16x9.png",
      "01-custody-boundary.png", "02-two-ways-to-trade.png",
      "03-install-rehearse-arm-fund.png", "04-entry-gauntlet.png",
      "05-position-policy.png", "06-local-brakes.png",
    ],
  },
  {
    source: "claude-grok-codex-article",
    slug: "claude-grok-codex",
    files: [
      "article.md", "claude-grok-codex-header.png",
      "01-three-bounded-jobs.png", "02-integration-loop.png",
    ],
  },
  {
    source: "mission-vision-article",
    slug: "mission-vision",
    files: [
      "article.md", "mission-vision-header.png",
      "01-mission-in-practice.png", "02-vision-shift.png",
    ],
  },
];
const SITE_URL = (process.env.SITE_URL || "https://claudedotcompany.com").replace(/\/$/, "");
// Where the API lives. Empty means "same origin", which is right for local dev and wrong
// for a static host — Pages cannot run the scanner or the database.
const API_BASE = (process.env.API_BASE || "").replace(/\/$/, "");
// The Robinhood desk is a SEPARATE service on a separate host, so the gateway's
// "two chains" panel needs its own base. Empty means "do not ask": the homepage
// skips the fetch entirely rather than firing a cross-origin request at a host
// that does not exist yet and painting a CORS error on every load.
const RH_API_BASE = (process.env.RH_API_BASE || "").replace(/\/$/, "");
// WalletConnect's project id. PUBLIC by design — it identifies the app to the
// relay and authorises nothing — but injected rather than committed so a fork
// builds with its own. Empty means the homepage offers no WalletConnect option,
// which is the honest state when there is no relay account behind it.
const WC_PROJECT_ID = String(process.env.WC_PROJECT_ID || "").trim();
const SOURCE_COMMIT = /^[0-9a-f]{40}$/i.test(String(
  process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || process.env.RENDER_GIT_COMMIT || "",
)) ? String(process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || process.env.RENDER_GIT_COMMIT).toLowerCase()
  : "<PUBLISHED_COMMIT_SHA>";

const { source: THREE_SRC, exportCount } = inlineThree();
const THREE_REV = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")
).version;



fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const a of ASSETS) {
  const src = path.join(ROOT, "token", a);
  if (!fs.existsSync(src)) throw new Error(`missing public asset: ${a}`);
  fs.copyFileSync(src, path.join(OUT, "assets", a));
}
fs.copyFileSync(path.join(ROOT, "token", "claudeco-64.png"), path.join(OUT, "assets", "favicon.png"));

// The vendored WalletConnect graph. Copied verbatim, never rewritten: it is a
// pinned build, and the whole reason it lives in this repo is that the connect
// button should not depend on a CDN having a good day.
const vendorSrc = path.join(ROOT, "viewer", "vendor");
if (fs.existsSync(vendorSrc)) {
  fs.cpSync(vendorSrc, path.join(OUT, "vendor"), { recursive: true });
}

const publicFontsDir = path.join(OUT, "assets", "fonts");
fs.mkdirSync(publicFontsDir, { recursive: true });
for (const font of PUBLIC_FONTS) {
  const src = path.join(ROOT, "token", "fonts", font);
  if (!fs.existsSync(src)) throw new Error(`missing public font: ${font}`);
  fs.copyFileSync(src, path.join(publicFontsDir, font));
}

// Every article is available at both /articles/<slug>/ and the explicit
// /articles/<slug>/x-paste.html path used by the publishing checklist.
const articlesOut = path.join(OUT, "articles");
fs.rmSync(articlesOut, { recursive: true, force: true });
for (const article of MARKETING_ARTICLES) {
  const sourceDir = path.join(ROOT, "marketing", article.source);
  const articleOut = path.join(articlesOut, article.slug);
  const pasteSource = path.join(sourceDir, "x-paste.html");
  if (!fs.existsSync(pasteSource)) {
    throw new Error(`missing article page: ${article.source}/x-paste.html`);
  }
  fs.mkdirSync(articleOut, { recursive: true });
  const articleHtml = fs.readFileSync(pasteSource, "utf8")
    .replaceAll("../../token/fonts/", "../../assets/fonts/");
  fs.writeFileSync(path.join(articleOut, "index.html"), articleHtml);
  fs.writeFileSync(path.join(articleOut, "x-paste.html"), articleHtml);
  for (const file of article.files) {
    const src = path.join(sourceDir, file);
    if (!fs.existsSync(src)) throw new Error(`missing article artifact: ${article.source}/${file}`);
    fs.copyFileSync(src, path.join(articleOut, file));
  }
}

const marketingOut = path.join(OUT, "marketing");
const marketingIndex = path.join(ROOT, "marketing", "index.html");
if (!fs.existsSync(marketingIndex)) throw new Error("missing public marketing index");
fs.rmSync(marketingOut, { recursive: true, force: true });
fs.mkdirSync(marketingOut, { recursive: true });
fs.copyFileSync(marketingIndex, path.join(marketingOut, "index.html"));

// The self-hosted executor, served static so the one-command install resolves.
fs.mkdirSync(path.join(OUT, "executor"), { recursive: true });
const EXECUTOR_FILES = [
  "poller.mjs", "journal.mjs", "jupiter.mjs", "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs", "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "install.sh", "macos-launchagent.sh", "macos-release.sh", "launchd-runner.mjs", "executor.mjs",
  "README.md", "strategy.mjs", "trade-policy.mjs", "simulate.mjs",
  /* THE ENTRY CONTRACT. One definition of "tradeable" for the desk and the bot, and a
     runtime import of poller.mjs — so it ships with every install for the same reason
     token2022.mjs does, and with the same failure if it does not: a 404 that aborts the
     download before a single line of it is ever read. */
  "entry-contract.mjs",
  /* And the route-sizing ladder it imports — same 404-aborts-the-install failure mode. */
  "entry-sizing.mjs",
  /* The network-fee ceiling, lifted out of jupiter.mjs so the sniper lane and the swap
     envelope cannot drift apart on what a fee cap means. jupiter.mjs imports it at module
     scope, which makes it a RUNTIME import: an install that fetches this list without it
     dies at boot with a bare ReferenceError, exactly as entry-sizing.mjs would. */
  "network-fee-budget.mjs",
  /* THE LAUNCH LANE. poller.mjs imports these DYNAMICALLY, inside the SNIPE_LANE branch,
     so they are inert on an install that never sets the variable — but a dynamic import
     that 404s is a runtime failure the moment somebody does set it, which is the worst
     possible time to discover the file was never published. */
  "snipe-lane.mjs",
  "snipe-venue-pumpfun.mjs",
  "snipe-venue.mjs",
  "snipe-curve.mjs",
  "snipe-entry.mjs",
  "snipe-feed.mjs",
  "snipe-book.mjs",
  "snipe-shadow.mjs",
  "snipe-policy.mjs",
  /* The lane's signing path (2026-09-12): imported dynamically by poller.mjs only under
     SNIPE_LANE=execute, and a 404 there is a bot that armed and cannot buy. Published. */
  "snipe-execute.mjs",
  /* Desk-led exits (2026-09-05). The bot no longer carries an exit policy of its own —
     Shrek, call 55: it sold 03:01:42Z on its own normalised stop at -13.5% while the
     desk's determined stop_hit landed 03:10:24Z. When the desk is unreachable the bot
     MIRRORS the desk with the desk's own ruler, and the ruler ships with it: the
     DexScreener consensus port and the mirror evaluator are runtime imports of
     poller.mjs, so an install that fetches this list without them dies at boot. */
  "dexscreener-consensus.mjs", "desk-mirror.mjs",
  /* token2022.mjs is a runtime import of jupiter.mjs (line 37) and the installer has
     always fetched it — but it was never on this list, so the published site 404'd it
     and `curl -f ... || exit 1` aborted EVERY remote install. Exactly the failure the
     note above warns about, in the one file the note did not name. The test below now
     derives the installer's own list and refuses any drift, so this cannot recur. */
  "token2022.mjs",
  /* the offline recovery tool — see burner-backup.mjs. A key on one disk is a
     stranded-funds bug waiting for its first dead host. */
  "burner-backup.mjs",
  "package.json", "package-lock.json",
];
for (const f of EXECUTOR_FILES) {
  const src = path.join(ROOT, "executor", f);
  if (!fs.existsSync(src)) throw new Error(`missing executor artifact: ${f}`);
  fs.copyFileSync(src, path.join(OUT, "executor", f));
}

/* ── THE SHORT PATH ───────────────────────────────────────────────────────────
 * /executor/install.sh has served 200 for weeks. That is not the same as being
 * FINDABLE: a one-command install has to be a line a person can read off a page
 * and half-remember, and "curl .../executor/install.sh" is already past that.
 * So the installer is published at /install.sh too.
 *
 * TWO URLS, ONE FILE, ONE STATEMENT. Both destinations are written from the same
 * source path in the loop below, deliberately, because the failure mode of two
 * copy steps is two DIFFERENT installers on one domain — one of them audited, one
 * of them stale, and no way for a reader to tell which they piped into bash. The
 * test asserts the two published bytes are identical; this is why they can be. */
const INSTALLER_SRC = path.join(ROOT, "executor", "install.sh");
for (const dest of [path.join(OUT, "install.sh"), path.join(OUT, "executor", "install.sh")]) {
  fs.copyFileSync(INSTALLER_SRC, dest);
  fs.chmodSync(dest, 0o755);          // `bash install.sh` does not need it; `./install.sh` does
}
/* The digest the site states out loud, so "verify what you are about to run" is a
   thing a careful reader can actually do: shasum the download, compare to the page.
   Computed from the very bytes just published — never typed, never carried forward. */
const INSTALLER_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(INSTALLER_SRC)).digest("hex");

/* The macOS double-click launcher, for the users who will not open a terminal at all.
   The executable bit is the whole point of the artifact: Finder refuses to run a
   .command without it, and fs.copyFileSync's mode preservation is not something to
   bet a download on — so it is set explicitly.
   MISSING IS A WARNING, NOT A THROW: this file is owned by the installer side of the
   work and lands separately. A hard failure here would break every build of the site
   for a button that is allowed to be dark for an afternoon. */
const LAUNCHER = "Install WALL-ST-E.command";
const launcherSrc = path.join(ROOT, "executor", LAUNCHER);
if (fs.existsSync(launcherSrc)) {
  const launcherOut = path.join(OUT, "executor", LAUNCHER);
  fs.copyFileSync(launcherSrc, launcherOut);
  fs.chmodSync(launcherOut, 0o755);
  console.log(`launcher            ${(fs.statSync(launcherOut).size / 1024).toFixed(1).padStart(6)} KB  mode=${(fs.statSync(launcherOut).mode & 0o777).toString(8)}`);
} else {
  console.warn(`WARNING: executor/${LAUNCHER} not found — the site's double-click download will 404 until it lands`);
}
console.log(`install.sh sha256   ${INSTALLER_SHA256}`);

// GitHub Pages reads dist/CNAME to bind the custom domain.
const cnameSrc = path.join(VIEWER, "CNAME");
if (fs.existsSync(cnameSrc)) fs.copyFileSync(cnameSrc, path.join(OUT, "CNAME"));

const built = [];

/* HAWK-AI'S STATUS IS COMPUTED FROM THE EXECUTOR, NOT TYPED INTO THE PAGE — and it is
 * computed by executor/hawk-status.mjs rather than here, because src/office.js serves the
 * SAME page live and two copies of this would be two pages telling different stories. */
const hawkStatusValue = hawkStatus();
console.log(`hawk-ai status    armable=${hawkStatusValue.armable} blocking=[${hawkStatusValue.blocking.join(", ")}]`);

for (const { src: name, out } of PAGES) {
  const src = path.join(VIEWER, name);
  if (!fs.existsSync(src)) continue;
  let html = fs.readFileSync(src, "utf8");
  /* A release installer pin is the exact reviewed build commit. CI supplies github.sha;
     local release builds must supply EXECUTOR_COMMIT explicitly. Ordinary local builds
     get a non-installable preview sentinel, never a stale or inferred SHA. */
  html = html.replaceAll("__CLAUDE_COMPANY_SOURCE_COMMIT__", EXECUTOR_COMMIT);
  /* The page states the digest of the installer THIS BUILD published, so the value a
     reader compares against is the value the same build wrote to /install.sh. The
     source page carries a placeholder rather than a hash: a committed hash is a hash
     that is wrong the next time install.sh is touched, and a stale digest teaches
     people to ignore the check. The viewer tests the shape and hides it if unsubstituted. */
  html = html.replaceAll("__CLAUDE_COMPANY_INSTALLER_SHA256__", INSTALLER_SHA256);
  /* See the note above hawkStatus: computed from the executor at build time so the public
     panel cannot drift from the code it describes. JSON.stringify twice is deliberate —
     the inner value is embedded as a STRING LITERAL and parsed at runtime, so no quote,
     backslash or </script> in a refusal message can break out of the surrounding script. */
  html = injectHawkStatus(html, hawkStatusValue);
  /* The one-command line names an origin, and a build published elsewhere (a staging
     host, a fork) must not send its readers to the production installer. The canonical
     URL is what the source file carries — so the test can pin the literal a reader
     sees — and this rewrites it to whatever origin is actually being built. */
  html = html.replaceAll("https://claudedotcompany.com/install.sh", `${SITE_URL}/install.sh`);
  const srcClosers = (html.match(/<\/script/gi) || []).length;

  if (IMPORT_LINE.test(html)) {
    // A replacer FUNCTION, not a string: three's source contains `$'`-style sequences,
    // and String.replace would treat those as substitution patterns and splice the rest
    // of the document back in. That produced a 2x-duplicated, unparseable page.
    const block = `/* ── three.js ${THREE_REV}, inlined (MIT licence) ── */\n${THREE_SRC}\n/* ── end three.js ── */`;
    html = html.replace(IMPORT_LINE, () => block);
  }

  // Any `</script` inside the inlined module would close the element early. Assert the
  // output has no more terminators than the source did — the `$'`-in-replacement bug
  // spliced the whole document back in and doubled them, and this catches that class.
  const closers = (html.match(/<\/script/gi) || []).length;
  if (closers !== srcClosers) {
    throw new Error(`${name}: source had ${srcClosers} </script> but output has ${closers} — inlining corrupted the page`);
  }
  // A visible build stamp, so "am I seeing the new version?" is answerable by
  // anyone in two seconds: view-source or the console, no guessing about caches.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  html = html.replace(/<style>/, () =>
    `<meta name="cc-build" content="${stamp}">\n<script>console.log("Claude Company build ${stamp}")</script>\n<style>`);

  if (API_BASE) {
    html = html.replace(/<style>/, () =>
      `<script>window.__API_BASE__=${JSON.stringify(API_BASE)};</script>\n<style>`);
  }
  if (RH_API_BASE) {
    html = html.replace(/<style>/, () =>
      `<script>window.__RH_API_BASE__=${JSON.stringify(RH_API_BASE)};</script>\n<style>`);
  }
  if (WC_PROJECT_ID) {
    html = html.replace(/<style>/, () =>
      `<script>window.__WC_PROJECT_ID__=${JSON.stringify(WC_PROJECT_ID)};</script>\n<style>`);
  }

  // the dev server's routes become relative links
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="assets/favicon.png" type="image/png">');
  html = html.replace(/href="\/tower"/g, 'href="tower.html"');
  html = html.replace(/href="\/solana(#[\w-]*)?"/g, (_, hash) => `href="solana.html${hash || ""}"`);
  html = html.replace(/href="\/floor\/(\d+)"/g, (_, n) => `href="floor.html?floor=${n}"`);
  html = html.replace(/href="\/"(?=[ >])/g, 'href="index.html"');
  html = html.replace(/\/floor\/\$\{f\.n\}/g, "floor.html?floor=${f.n}");   // keep the floor number
  html = html.replace(/\/buy\?floor=\$\{f\.n\}/g, "buy.html?floor=${f.n}");
  // link previews need an absolute image URL; relative is a harmless fallback
  if (SITE_URL) html = html.replace(/content="assets\//g, `content="${SITE_URL}/assets/`);

  // The published-artifact origin has no assets/ directory and its CSP forbids fetching
  // one, so an artifact build carries its images inline.
  if (process.env.INLINE_ASSETS === "1") {
    html = html.replace(/src="assets\/([\w.-]+\.png)"/g, (_, file) => {
      const b64 = fs.readFileSync(path.join(ROOT, "token", file)).toString("base64");
      return `src="data:image/png;base64,${b64}"`;
    });
  }

  // Standalone pages have no server, so the app routes have to point somewhere real.
  // Supply published URLs via env; otherwise the links are left as-is.
  const TOWER = process.env.ARTIFACT_TOWER_URL;
  const FLOOR = process.env.ARTIFACT_FLOOR_URL;
  if (TOWER) html = html.replace(/href="\/tower"/g, () => `href="${TOWER}" target="_blank" rel="noopener"`);
  if (FLOOR) html = html.replace(/href="\/floor\/50"/g, () => `href="${FLOOR}" target="_blank" rel="noopener"`);

  const outPath = path.join(OUT, out);
  fs.writeFileSync(outPath, html);
  built.push({ name: out, bytes: html.length, inlined: !html.includes("/vendor/three/") });
}

console.log(`three namespace entries: ${exportCount}`);
for (const b of built) console.log(`${b.name.padEnd(16)} ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  inlined=${b.inlined}`);
