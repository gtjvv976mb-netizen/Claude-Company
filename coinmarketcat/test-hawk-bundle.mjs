/**
 * THE BUNDLE BUILDS, EVALUATES, AND CARRIES THE EXECUTOR'S OWN DECISION CODE.
 *
 * Runs esbuild through build.mjs into a temporary directory, then:
 *   · every entry exists and parses as an ES module;
 *   · no `node:` specifier survived (the shim plugin is the only thing standing between
 *     token2022.mjs's createHash and a bundle that throws at first use);
 *   · the shims agree with the modules they stand in for — WSOL and the ATA program from
 *     jupiter.mjs, SHA-256 from node:crypto — so a drift in either fails here, not in a
 *     wallet;
 *   · the engine bundle, evaluated in Node with a stubbed `chrome`, exposes the same
 *     entry contract: a launch refused by the executor's snipeContract is refused by the
 *     bundle's, at the same gate.
 *
 * esbuild is a devDependency of this repository, installed by `npm ci`; locally, a
 * checkout without it skips with a line that says so, and CI is where the claim is held.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

let esbuildPresent = true;
try { require.resolve("esbuild"); } catch { esbuildPresent = false; }
if (!esbuildPresent) {
  if (process.env.GITHUB_ACTIONS === "true" || process.env.CI) {
    console.log("  FAIL esbuild is not installed on CI — run `npm ci` in the workflow");
    process.exit(1);
  }
  console.log("  (esbuild is not installed here — `npm ci` at the repository root to run the bundle test; CI runs it)");
  process.exit(0);
}

console.log("\nTHE SHIMS AGREE WITH WHAT THEY REPLACE\n─────────────────────────────────────");
{
  const real = { WSOL: "So11111111111111111111111111111111111111112", ATA_PROGRAM: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", associatedTokenAddress: (w, m) => PublicKey.findProgramAddressSync([new PublicKey(w).toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(m).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58() };
  const shim = await import("./src/shims/jupiter.mjs");
  ok("WSOL matches the executor's literal", shim.WSOL === real.WSOL, shim.WSOL);
  ok("ATA_PROGRAM matches the executor's literal", shim.ATA_PROGRAM === real.ATA_PROGRAM, shim.ATA_PROGRAM);
  const w = "9AyUZ8ZNHE61S6gx4gDbUd9BoYaNhKVnWF7KLnFfpump", m = "FgJReZeYfmKZeWrCaGYL8gLnUixwBhjdHuRknC6ypump";
  ok("associatedTokenAddress derives the same address", shim.associatedTokenAddress(w, m) === real.associatedTokenAddress(w, m), shim.associatedTokenAddress(w, m));
  const cryptoShim = await import("./src/shims/node-crypto.mjs");
  const bytes = Buffer.from("the same bytes, hashed twice");
  ok("sha256 hex matches node:crypto", cryptoShim.createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(bytes).digest("hex"));
  ok("chained updates match too", cryptoShim.createHash("sha256").update("a").update(Buffer.from("b")).digest("hex") === createHash("sha256").update("a").update(Buffer.from("b")).digest("hex"));
  let threw = null; try { cryptoShim.createHash("md5"); } catch (e) { threw = e; }
  ok("an algorithm other than sha256 is refused by name", /md5/.test(threw?.message ?? ""), threw?.message);
}

console.log("\nTHE BUILD\n─────────");
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "hawk-dist-"));
const { buildOnce, ENTRIES } = await import("./build.mjs");
let built = null;
try { built = await buildOnce({ outdir }); } catch (error) { ok("the build succeeds", false, String(error?.message ?? error)); }
if (built) {
  ok("the build succeeds", built.errors.length === 0, `${built.errors.length} errors, ${built.warnings.length} warnings`);
  for (const [out] of Object.entries(ENTRIES)) {
    const file = path.join(outdir, out);
    const exists = fs.existsSync(file);
    ok(`${out} exists`, exists, exists ? `${(fs.statSync(file).size / 1024).toFixed(0)} KB` : "missing");
    if (!exists) continue;
    const text = fs.readFileSync(file, "utf8");
    ok(`${out}: no node: specifier survived`, !/["']node:[a-z_]+["']/.test(text));
    ok(`${out}: no require() of a package survived`, !/\brequire\(["'][^"']+["']\)/.test(text.replace(/\/\*[\s\S]*?\*\//g, "")));
  }
  for (const stat of ["manifest.json", "popup.html", "popup.css", "options.html", "welcome.html", "welcome.css", "icons/coinmarketcat-32.png", "icons/coinmarketcat-128.png", "icons/coinmarketcat-512.png"])
    ok(`${stat} was copied`, fs.existsSync(path.join(outdir, stat)));

  /* The manifest names files the build produced — a renamed entry would load as a blank
     popup, which is a bug a person notices only after installing. */
  const manifest = JSON.parse(fs.readFileSync(path.join(outdir, "manifest.json"), "utf8"));
  const named = [manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js), ...manifest.web_accessible_resources.flatMap((w) => w.resources), manifest.action.default_popup, manifest.options_page];
  for (const f of named) ok(`manifest names a built file: ${f}`, fs.existsSync(path.join(outdir, f)));
  const popupHtml = fs.readFileSync(path.join(outdir, "popup.html"), "utf8");
  ok("popup.html loads popup.js and popup.css by the built names", /src="popup\.js"/.test(popupHtml) && /href="popup\.css"/.test(popupHtml));
  const optionsHtml = fs.readFileSync(path.join(outdir, "options.html"), "utf8");
  ok("options.html loads options.js", /src="options\.js"/.test(optionsHtml));
  const welcomeHtml = fs.readFileSync(path.join(outdir, "welcome.html"), "utf8");
  ok("welcome.html, the first-run setup page, loads welcome.js and welcome.css by the built names", /src="welcome\.js"/.test(welcomeHtml) && /href="welcome\.css"/.test(welcomeHtml));
  ok("…and the icon it shows was copied beside it", /src="icons\/coinmarketcat-128\.png"/.test(welcomeHtml) && fs.existsSync(path.join(outdir, "icons", "coinmarketcat-128.png")));

  console.log("\nTHE BUNDLE EVALUATES, AND DECIDES LIKE THE EXECUTOR\n──────────────────────────────────────────────────");
  /* A library bundle from the engine entry, built with the same options, so the decision
     code the worker carries can be exercised here without chrome.* around it. */
  const { buildOptions } = await import("./build.mjs");
  const esbuild = require("esbuild");
  const lib = path.join(outdir, "lib-probe");
  const opts = buildOptions({ outdir: lib });
  opts.entryPoints = { engine: path.join(here, "src", "lib", "engine.mjs"), config: path.join(here, "src", "lib", "config.mjs") };
  opts.logLevel = "silent";
  const r = await esbuild.build(opts);
  ok("the engine library bundle builds", r.errors.length === 0, `${r.errors.length} errors`);
  fs.writeFileSync(path.join(lib, "package.json"), JSON.stringify({ type: "module" }));
  let bundled = null;
  try { bundled = await import(pathToFileURL(path.join(lib, "engine.js")).href); } catch (error) { ok("the engine bundle evaluates in Node", false, String(error?.message ?? error).slice(0, 200)); }
  if (bundled) {
    ok("the engine bundle evaluates in Node", typeof bundled.createHawkEngine === "function" && typeof bundled.memoryStore === "function");
    const bridge = { wallet: () => null, isReady: () => false, signTransaction: async () => { throw new Error("no"); } };
    const engine = bundled.createHawkEngine({ bridge, store: bundled.memoryStore(), config: { lane: "observe" } });
    await engine.load();
    const st = engine.status();
    ok("the bundled engine reports the record beside the switch", st.record?.first58?.trades === 58 && Array.isArray(st.armability?.warnings), `record ${st.record?.first58?.trades} trades; ${st.armability?.warnings?.length} warnings`);
    ok("the bundled policy carries the record's 1.5x take and the 90s stall", st.policy?.takeAtEntryX === 1.5 && st.policy?.stallMs === 90_000, JSON.stringify(st.policy));
    ok("the bundled engine carries the xStock venue, off by default, watching the built-in list", st.xstock?.venue === "jupiter-xstock" && st.xstock.enabled === false && st.xstock.focus?.length === 15 && Array.isArray(st.xstock.candidates), JSON.stringify({ venue: st.xstock?.venue, enabled: st.xstock?.enabled }));
    const xticked = await engine.xstockTick();
    ok("…and its tick is a no-op while it is off", Array.isArray(xticked) && xticked.length === 0);
    /* The same launch, refused at the same gate by both the source contract and the bundled one. */
    const stale = { mint: "FgJReZeYfmKZeWrCaGYL8gLnUixwBhjdHuRknC6ypump", creator: null, slot: 1, noticeAt: Date.now() - 600_000, source: "logsSubscribe", raw: {} };
    engine.setRpc({ url: "https://x", async getMultipleAccounts() { return { slot: 1, accounts: [null, null, null] }; } });
    const res = await engine.handleNotice(stale);
    ok("a stale notice is refused at notice_stale by the bundled contract", res?.verdict?.gate === "notice_stale", `${res?.verdict?.gate}: ${res?.verdict?.detail?.message?.slice(0, 80)}`);
    const { snipeContract } = await import("./vendor/executor/snipe-entry.mjs");
    const { laneConfigFor, normalizeConfig, CONFIG_DEFAULTS } = await import("./src/lib/config.mjs");
    const v = snipeContract({ notice: { mint: stale.mint, noticeAt: stale.noticeAt }, curve: null, adapter: (await import("./vendor/executor/snipe-venue-pumpfun.mjs")).PUMPFUN_VENUE, cfg: laneConfigFor(normalizeConfig({ ...CONFIG_DEFAULTS, lane: "observe" })), book: { snipes: {}, positions: {}, attempts: {}, deployedTodaySol: 0 }, nowMs: Date.now(), control: { hardStop: false, pauseEntries: false }, fees: { signatureFeeLamports: 5000, prioritizationFeeLamports: 0, rentFeeLamports: 0 } });
    ok("…and the executor's own contract agrees on the gate", v.gate === res?.verdict?.gate, `executor ${v.gate}, bundle ${res?.verdict?.gate}`);

    /* A STOCK QUOTE THROUGH THE BUNDLE: the bundled describeMint (token2022.mjs behind the
       node:crypto shim) must read the live GLDx mint bytes exactly as Node does, off the
       same read as a live GLDx-quoted curve. */
    const fixture = JSON.parse(fs.readFileSync(path.join(here, "vendor", "executor", "fixtures", "pumpfun-xstock-quote.json"), "utf8"));
    const acct = (address) => { const a = fixture.accounts.find((x) => x.address === address); return { owner: a.owner, lamports: a.lamports, data: a.data }; };
    const GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
    const stockEngine = bundled.createHawkEngine({ bridge, store: bundled.memoryStore(), config: { lane: "observe", quoteMints: [{ mint: GLDX, symbol: "GLDx", maxPerTrade: 0.05, minPerTrade: 0.01, dailyCap: 0.5 }] } });
    await stockEngine.load();
    const reads = [];
    stockEngine.setRpc({ url: "https://x", async getMultipleAccounts(addresses) { reads.push(addresses.map(String)); return { slot: 449_986_225, accounts: addresses.map((a, i) => (String(a) === GLDX ? acct(GLDX) : i === 0 ? acct("JXJC7sJa235q7GbFjsQ9oorm6wHForQ8MZJoF1MedDP") : null)) }; } });
    const stockRes = await stockEngine.handleNotice({ mint: "DRA4qXNRw5XBd5aVBjFdKJWMc1yiBpqrp8gTWYsmpump", creator: null, slot: 449_986_220, noticeAt: Date.now(), source: "logsSubscribe", raw: {} });
    const sq = stockEngine.status().quoteMints?.[0];
    ok("the bundled engine reads a listed stock's mint on the curve's own read", reads.length === 1 && reads[0].length === 4 && reads[0][3] === GLDX, JSON.stringify(reads.map((r) => r.length)));
    ok("…and the bundled describeMint reads the live GLDx bytes: Token-2022, 8 decimals, unpaused, symbol GLDx", sq?.decimals === 8 && sq.program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" && sq.paused === false && sq.metadataSymbol === "GLDx", JSON.stringify({ d: sq?.decimals, p: sq?.paused, s: sq?.metadataSymbol }));
    ok("…and the launch gets past quote_not_sol, sized in GLDx (refused later, for the base mint the probe did not serve)", stockRes?.verdict?.gate !== "quote_not_sol" && stockRes?.verdict?.detail?.quote?.isSol === false, `${stockRes?.verdict?.gate}: ${stockRes?.verdict?.detail?.message?.slice(0, 80)}`);
  }
}
fs.rmSync(outdir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
