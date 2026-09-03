/**
 * THE SWAP BUTTON IN THE JUPITER MODAL.
 *
 * Measured in the live modal on 2026-09-03: the header buttons are 28px, the token
 * selects 36px, and the main action button — Connect Wallet, then Swap once a wallet is
 * attached — rendered at 134px. Four times the height of everything around it, a slab
 * of solid green filling a third of the panel.
 *
 * The cause is inside the widget. The button's only child carries `h-full`, so
 * `height: 100%` against a button with no height of its own; the percentage resolves
 * against an ancestor sized to the modal rather than against the text. Setting that
 * child's height to auto took the button to 54px in the same live modal, which is the
 * widget's own 20px padding either side of a 14px line.
 *
 * The widget renders into a SHADOW ROOT, so the page's stylesheet cannot reach it and
 * the override has to be handed to that root directly. That is the part worth pinning:
 * a well-meaning edit that moves this rule into the page's own <style> block would
 * leave no trace in a diff review and no effect on the page.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE OVERRIDE REACHES THE SHADOW ROOT, NOT THE PAGE");
{
  const fn = html.slice(html.indexOf("function trimJupiterSwapButton()"),
    html.indexOf("async function openSwap("));
  ok("the trim exists at all", fn.length > 200, `${fn.length} chars`);
  ok("it reads a shadow root rather than the document's stylesheet",
    /el\.shadowRoot/.test(fn) && /adoptedStyleSheets/.test(fn));
  ok("it falls back to a <style> inside that root where constructable sheets are missing",
    /catch\s*{[\s\S]*createElement\("style"\)[\s\S]*root\.appendChild/.test(fn));
  ok("the rule targets the child that carries the height, not the button",
    /button > div\.h-full \{ height: auto !important; \}/.test(fn));
  /* The page's own <style> block cannot cross the shadow boundary. A rule for this
     button living there would be silently inert, so it must not appear there. */
  const pageStyle = html.slice(0, html.indexOf("function trimJupiterSwapButton()"));
  ok("no inert copy of the rule sits in the page stylesheet",
    !/button\s*>\s*div\.h-full/.test(pageStyle));
}

console.log("\nIT RUNS WHEN THE MODAL OPENS, AND STOPS");
{
  const swapStart = html.indexOf("async function openSwap(");
  const swap = html.slice(swapStart,
    html.indexOf("window.__renderWatchInto = ", swapStart));
  const init = swap.indexOf("window.Jupiter.init({");
  const trim = swap.indexOf("trimJupiterSwapButton();");
  ok("every modal open trims the button", trim > 0);
  ok("...after init, because the root does not exist before it", init > 0 && trim > init,
    `init@${init} trim@${trim}`);
  ok("the fallback path still opens GMGN when Jupiter cannot load",
    /if \(!ok\) \{[\s\S]{0,200}gmgn\.ai/.test(swap));

  const fn = html.slice(html.indexOf("function trimJupiterSwapButton()"),
    html.indexOf("async function openSwap("));
  /* The root is created a tick or two after init, so the helper polls. A poll with no
     ceiling is a page that spins forever on a modal that failed to mount. */
  ok("the wait for the root is bounded", /Date\.now\(\) - started < \d+/.test(fn),
    (fn.match(/Date\.now\(\) - started < (\d+)/) || [])[1] + "ms");
  ok("a root already trimmed is left alone, so reopening cannot stack sheets",
    /__deskButtonTrimmed/.test(fn) && (fn.match(/__deskButtonTrimmed/g) || []).length >= 2);
}

console.log("\nTHE DESK STILL NEVER TOUCHES THE TRANSACTION");
{
  const swapStart = html.indexOf("async function openSwap(");
  const swap = html.slice(swapStart,
    html.indexOf("window.__renderWatchInto = ", swapStart));
  ok("the page still only names the token and the amount",
    /initialInputMint/.test(swap) && /initialOutputMint/.test(swap));
  ok("...and nothing here signs, holds a key, or builds a transaction",
    !/(privateKey|secretKey|signTransaction|Keypair)/.test(swap));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
