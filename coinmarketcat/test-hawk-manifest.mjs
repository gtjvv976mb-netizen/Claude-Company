/**
 * THE MANIFEST IS THE EXTENSION'S CHARTER: WHAT IT MAY TOUCH, AND WHERE.
 *
 * A browser extension that can sign for a wallet is exactly the shape a drainer takes,
 * so the permissions are pinned here and a widening fails the suite by name. The content
 * script runs on the console pages only; the injected script is web-accessible to those
 * origins only; there is no `<all_urls>`, no `tabs`, no `scripting`, no `cookies`, no
 * `webRequest`. The host permission is broad because the RPC is whatever URL the user
 * pastes — that is a fetch permission, not a page permission.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSOLE_URLS, CONFIG_DEFAULTS } from "./src/lib/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

console.log("\nTHE MANIFEST\n────────────");
ok("manifest v3", manifest.manifest_version === 3, `v${manifest.manifest_version}`);
ok("a module service worker, so the engine's ESM imports load", manifest.background?.service_worker === "background.js" && manifest.background?.type === "module", JSON.stringify(manifest.background));
ok("Chrome 116+, where websocket activity keeps a worker alive", Number(manifest.minimum_chrome_version) >= 116, manifest.minimum_chrome_version);

const ALLOWED_PERMISSIONS = new Set(["storage", "alarms", "notifications", "unlimitedStorage"]);
const perms = manifest.permissions ?? [];
ok("permissions are storage, alarms and notifications only", perms.every((p) => ALLOWED_PERMISSIONS.has(p)) && perms.includes("storage"), perms.join(", "));
for (const banned of ["tabs", "scripting", "cookies", "webRequest", "webRequestBlocking", "declarativeNetRequest", "history", "clipboardRead", "debugger", "nativeMessaging", "management", "proxy"])
  ok(`never ${banned}`, !perms.includes(banned) && !(manifest.optional_permissions ?? []).includes(banned));
ok("no optional permissions", !manifest.optional_permissions || manifest.optional_permissions.length === 0);

const hosts = manifest.host_permissions ?? [];
ok("host permissions are https and wss only — the RPC the user pastes", hosts.length === 2 && hosts.includes("https://*/*") && hosts.includes("wss://*/*"), hosts.join(", "));
ok("no http host permission (an RPC key over plain http is a leak)", !hosts.some((h) => h.startsWith("http://")));

const cs = manifest.content_scripts ?? [];
ok("exactly one content script", cs.length === 1, `${cs.length}`);
const matches = cs[0]?.matches ?? [];
ok("it matches the console pages only", matches.length === CONSOLE_URLS.length && CONSOLE_URLS.every((u) => matches.includes(`${u}*`)), matches.join(", "));
ok("never <all_urls> or a wildcard host", !matches.some((m) => m === "<all_urls>" || /\*:\/\/\*/.test(m) || /^https?:\/\/\*/.test(m)));
ok("top frame only", cs[0]?.all_frames !== true);
ok("it loads content.js only", JSON.stringify(cs[0]?.js) === JSON.stringify(["content.js"]), JSON.stringify(cs[0]?.js));
const war = manifest.web_accessible_resources ?? [];
ok("the injected script is the only web-accessible resource", war.length === 1 && JSON.stringify(war[0].resources) === JSON.stringify(["injected.js"]), JSON.stringify(war));
ok("and only to the console origins", (war[0]?.matches ?? []).every((m) => CONSOLE_URLS.some((u) => m.startsWith(new URL(u).origin))), (war[0]?.matches ?? []).join(", "));
ok("the default console URL is one the content script matches", CONSOLE_URLS.includes(CONFIG_DEFAULTS.consoleUrl), CONFIG_DEFAULTS.consoleUrl);
ok("no externally_connectable — no other site or extension may message the worker", manifest.externally_connectable === undefined);
ok("the icons are the building's own marks, under the bot's name", ["32", "128", "512"].every((s) => manifest.icons?.[s]?.startsWith("icons/coinmarketcat-")), JSON.stringify(manifest.icons));
/* The description used to say "It never holds a key". With the autopilot wallet that is
   false in one mode, so the charter now says what is true in both, and may not say the
   old sentence again. */
ok("the description does not claim the extension never holds a key (on autopilot it holds one)", !/never holds a key|holds no key/i.test(manifest.description), manifest.description);
ok("the description names both signers: Phantom per trade, and an autopilot wallet you fund", /Phantom per trade/i.test(manifest.description) && /autopilot wallet you fund/i.test(manifest.description), manifest.description);
ok("the description fits Chrome's 132-character limit", manifest.description.length <= 132, `${manifest.description.length} characters`);

console.log("\nTHE FIRST-RUN SETUP PAGE\n────────────────────────");
{
  const { ENTRIES, STATIC } = await import("./build.mjs");
  ok("the build bundles the setup page's script", ENTRIES["welcome.js"] === "welcome/welcome.mjs", JSON.stringify(ENTRIES["welcome.js"]));
  const statics = STATIC.map(([from, to]) => `${from} → ${to}`);
  ok("the build copies welcome.html and welcome.css", STATIC.some(([f, t]) => f === "src/welcome/welcome.html" && t === "welcome.html") && STATIC.some(([f, t]) => f === "src/welcome/welcome.css" && t === "welcome.css"), statics.filter((x) => /welcome/.test(x)).join(", "));
  const html = fs.readFileSync(path.join(here, "src", "welcome", "welcome.html"), "utf8");
  ok("welcome.html loads welcome.js and welcome.css by their built names", /<script type="module" src="welcome\.js"><\/script>/.test(html) && /href="welcome\.css"/.test(html));
  ok("welcome.html shows the cat by the bot's own icon", /src="icons\/coinmarketcat-128\.png"/.test(html) && /Cat Intelligence Agency/.test(html) && /sniper cat/.test(html));
  ok("welcome.html loads nothing from the network (an extension page: its own files only)", !/(src|href)="(https?:)?\/\//.test(html));
  ok("the setup page is not web-accessible: no web page can frame or open it", !(manifest.web_accessible_resources ?? []).some((w) => (w.resources ?? []).some((r) => /welcome/.test(r))));
  ok("no permission was added for it (tabs.create of an extension page needs none)", perms.every((p) => ALLOWED_PERMISSIONS.has(p)));
  const bg = fs.readFileSync(path.join(here, "src", "background.mjs"), "utf8");
  const installed = bg.match(/onInstalled\.addListener\(\(details\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  ok("the worker opens the setup page from onInstalled, and only when the reason is \"install\"", /details\?\.reason === "install"/.test(installed) && /chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\(WELCOME_PAGE\) \}\)/.test(installed) && /WELCOME_PAGE = "welcome\.html"/.test(bg), installed.trim().split("\n").filter((l) => /reason|tabs\.create/.test(l)).map((l) => l.trim()).join(" | "));
  ok("…and never from onStartup", !/onStartup\.addListener\([^\n]*WELCOME/.test(bg));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
