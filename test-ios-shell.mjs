/* THE DESK ON A PHONE (owner, 2026-09-15: "I also want this to be an iOS app").
 *
 * Two layers, one test. The web layer is the site declaring itself installable — a
 * manifest the build writes and the Apple head tags on every page — so Safari's Add to
 * Home Screen puts the tower on an iPhone today. The native layer is ios/, a SwiftUI
 * shell around the same pages for TestFlight. Xcode does not run where this suite runs,
 * so the shell is checked here for shape: the files exist, they point at the desk and not
 * at a placeholder, the wallet handoff is there, the icon is what the store accepts, and
 * the two layers agree with each other and with the tower's own colour.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let passed = 0;
const ok = (name, cond, detail = "") => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok   ${name}`);
};
/* Width, height and colour type straight out of the PNG's IHDR chunk. */
const png = (p) => {
  const b = fs.readFileSync(path.join(root, p));
  assert.equal(b.toString("ascii", 1, 4), "PNG", `${p} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colour: b[25] };
};

/* ── 1 · the build writes the web-app layer ─────────────────────────────────────── */
const build = spawnSync(process.execPath, ["scripts/build-viewer.mjs"], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, EXECUTOR_COMMIT: "a".repeat(40), SOURCE_COMMIT: "a".repeat(40) },
});
assert.equal(build.status, 0, build.stderr || build.stdout);

const manifest = JSON.parse(read("dist/manifest.webmanifest"));
ok("the build writes a web-app manifest", manifest.name === "Claude Company" && manifest.display === "standalone");
ok("…that opens on the tower, because a tenant's first tap is 'which floor is mine'",
  manifest.start_url === "tower.html" && fs.existsSync(path.join(root, "dist", "tower.html")));
ok("…with icons that are actually published", manifest.icons.length >= 2 &&
  manifest.icons.every((i) => fs.existsSync(path.join(root, "dist", i.src))));
for (const i of manifest.icons) {
  const [w, h] = i.sizes.split("x").map(Number);
  const real = png(`dist/${i.src}`);
  ok(`…and ${i.src} is the size the manifest says (${i.sizes})`, real.w === w && real.h === h, `${real.w}x${real.h}`);
}
/* The tower's masthead bar is its top edge — the colour that meets the status bar — and
   solana.html's whole ground is the same value; either drifting from the other would
   show as a seam on the phone, so both are read and both must agree with the manifest. */
const towerBg = read("viewer/tower.html").match(/--bar:(#[0-9a-f]{6});/i)?.[1];
const solanaBg = read("viewer/solana.html").match(/--bg:(#[0-9a-f]{6});/i)?.[1];
ok("the launch colour is the tower's own masthead, so the app never flashes white",
  towerBg && manifest.background_color === towerBg && manifest.theme_color === towerBg, `tower --bar ${towerBg}`);
ok("…and the Solana homepage's ground is that same night", solanaBg === towerBg, `solana --bg ${solanaBg}`);

for (const page of ["tower.html", "floor.html", "solana.html", "index.html"]) {
  const html = read(`dist/${page}`);
  ok(`${page} links the manifest and the Apple head`,
    html.includes('<link rel="manifest" href="manifest.webmanifest">') &&
    html.includes('<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">') &&
    html.includes('<meta name="apple-mobile-web-app-capable" content="yes">') &&
    html.includes(`<meta name="theme-color" content="${towerBg}">`));
}
ok("the status bar is the opaque style, because the pages lay their own bars along the top edge",
  read("dist/floor.html").includes('<meta name="apple-mobile-web-app-status-bar-style" content="black">'));
const touch = png("dist/assets/apple-touch-icon.png");
ok("the home-screen icon is Apple's 180×180", touch.w === 180 && touch.h === 180, `${touch.w}x${touch.h}`);

/* ── 2 · the native shell is there, and points at the desk ──────────────────────── */
const files = [
  "ios/README.md", "ios/project.yml", "ios/make.sh",
  "ios/ClaudeCompany/ClaudeCompanyApp.swift", "ios/ClaudeCompany/Desk.swift",
  "ios/ClaudeCompany/DeskView.swift", "ios/ClaudeCompany/DeskWebView.swift",
  "ios/ClaudeCompany/Assets.xcassets/Contents.json",
  "ios/ClaudeCompany/Assets.xcassets/AppIcon.appiconset/Contents.json",
  "ios/ClaudeCompany/Assets.xcassets/AppIcon.appiconset/AppIcon.png",
];
ok("every file of the shell exists", files.every((f) => fs.existsSync(path.join(root, f))),
  files.filter((f) => !fs.existsSync(path.join(root, f))).join(", "));
ok("make.sh is executable", (fs.statSync(path.join(root, "ios/make.sh")).mode & 0o111) !== 0);

const desk = read("ios/ClaudeCompany/Desk.swift");
const home = desk.match(/static let home = URL\(string: "([^"]+)"\)!/)?.[1];
ok("the shell opens on the same tower the web app does",
  home === `https://solana.claudedotcompany.com/${manifest.start_url}`, home);
const hosts = [...desk.matchAll(/"((?:[a-z0-9-]+\.)*claudedotcompany\.com)"/g)].map((m) => m[1]);
ok("…and keeps its own hosts inside, both the Solana site and the apex",
  hosts.includes("solana.claudedotcompany.com") && hosts.includes("claudedotcompany.com"));
ok("the shell's ground is the tower's colour too",
  towerBg && desk.includes(`0x${towerBg.slice(1, 3)} / 255.0`) && desk.includes(`0x${towerBg.slice(3, 5)} / 255.0`) &&
  desk.includes(`0x${towerBg.slice(5, 7)} / 255.0`));
ok("claudeco://floor/N routes to that floor and refuses a floor the tower does not have",
  /case "claudeco"|== "claudeco"/.test(desk) && desk.includes("(1...50).contains(n)") && desk.includes("floor.html?floor=\\(n)"));

const web = read("ios/ClaudeCompany/DeskWebView.swift");
ok("a wallet link leaves the shell for the app that owns it",
  web.includes("func webView(_ webView: WKWebView,\n                     decidePolicyFor action: WKNavigationAction") &&
  web.includes("UIApplication.shared.open(url") && web.includes("decisionHandler(.cancel)"));
ok("…including a foreign https host in the main frame, which is how Phantom's universal link arrives",
  web.includes('case "http", "https":') && web.includes("if Desk.isOwn(url) || !mainFrame"));
ok("…while a sub-frame and about:/blob:/data: documents load as they are",
  web.includes('case "about", "blob", "data", "javascript":'));
ok("target=_blank is handled, not dropped", web.includes("createWebViewWith configuration"));
ok("confirm() is answered by a native sheet, not silently with false",
  web.includes("runJavaScriptConfirmPanelWithMessage") && web.includes("completionHandler(true)"));
ok("the Guide's video plays inline", web.includes("config.allowsInlineMediaPlayback = true"));
ok("the site can tell the shell from Safari", web.includes("applicationNameForUserAgent = Desk.userAgentSuffix") &&
  /userAgentSuffix = "ClaudeCompany-iOS\/[\d.]+"/.test(desk));
ok("a dead content process reloads rather than leaving a white view", web.includes("webViewWebContentProcessDidTerminate"));
ok("a cancelled navigation is not shown as a failure", web.includes("NSURLErrorCancelled"));

const view = read("ios/ClaudeCompany/DeskView.swift");
ok("an unreachable desk shows a card with a retry, not a blank view",
  view.includes("OutOfReachCard") && view.includes("state.reload?()") && view.includes('Text("Try again")'));
ok("the app opens claudeco:// links", view.includes(".onOpenURL") && view.includes("Desk.route(url)"));

const yml = read("ios/project.yml");
ok("the project declares the wallet schemes it may ask iOS about",
  /LSApplicationQueriesSchemes:\s*\n\s*- phantom\s*\n\s*- solflare/.test(yml));
ok("…and its own claudeco:// scheme", /CFBundleURLSchemes:\s*\n\s*- claudeco/.test(yml));
ok("…targets iOS 16, the floor of the APIs the shell uses", /deploymentTarget:\s*\n\s*iOS: "16\.0"/.test(yml));
ok("…and needs no export paperwork", yml.includes("ITSAppUsesNonExemptEncryption: false"));
ok("…with the bundle id spelled out where the owner will change it", yml.includes("PRODUCT_BUNDLE_IDENTIFIER: com.claudedotcompany.app"));

const iconSet = JSON.parse(read("ios/ClaudeCompany/Assets.xcassets/AppIcon.appiconset/Contents.json"));
const iconEntry = iconSet.images.find((i) => i.size === "1024x1024" && i.idiom === "universal");
ok("the icon set is Xcode's single 1024 form", iconEntry && iconEntry.filename === "AppIcon.png");
const icon = png("ios/ClaudeCompany/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
ok("the app icon is 1024×1024 with no alpha channel, which the store requires",
  icon.w === 1024 && icon.h === 1024 && icon.colour === 2, `${icon.w}x${icon.h} colour type ${icon.colour}`);
ok("…and is the same mark as the site's own", fs.readFileSync(path.join(root, "token/claudeco-1024.png"))
  .equals(fs.readFileSync(path.join(root, "ios/ClaudeCompany/Assets.xcassets/AppIcon.appiconset/AppIcon.png"))));

const readme = read("ios/README.md");
ok("the README says the shell was not compiled here, so the first Mac build is the proof",
  readme.includes("not compiled here"));
ok("…and says the bot does not run on the phone", readme.includes("The bot does not run on the phone"));
ok("…and names the App Store review risk before the owner spends the time",
  readme.includes("4.2") && readme.includes("3.1.5"));

const ignore = read(".gitignore");
ok("the generated Xcode project is never committed", ignore.includes("ios/ClaudeCompany.xcodeproj/"));

console.log(`\n${passed} passed — the desk installs on a phone, and the shell points at the same desk`);
