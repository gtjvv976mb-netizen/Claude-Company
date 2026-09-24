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
ok("the description says what it never does", /never holds a key/i.test(manifest.description), manifest.description.slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
