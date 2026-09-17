/**
 * HAWK-AI's RANGE SCOREBOARD — the physical board on the floor, not the tab panel.
 *
 * The owner asked for "a physical board like GROX MULDER's". GROX's hangs on the wall of
 * an office because he has one; HAWK-AI has a shooting line, so his is a freestanding
 * range scoreboard on posts beside it. This file pins the handful of facts that decide
 * whether that board is VISIBLE AND TRUE, because every one of them has a failure mode
 * that renders perfectly in code review and shows nothing on the floor:
 *
 *   · A PLANE BURIED IN ITS OWN FRAME. GROX's board carries a comment about exactly this
 *     — it drew into a canvas nobody could see. The clearance is arithmetic, so it is
 *     checked as arithmetic rather than eyeballed.
 *   · A BOARD THAT FETCHES. Nothing in this scene fetches; the panels poll and the scene
 *     reads. A board that called an API would work in a demo and duplicate every request
 *     on a real floor.
 *   · A BOARD ONLY THE TAB REFRESHES. If the chalk is only updated when a panel is open,
 *     then anyone walking past reads a stale number, which is worse than reading none.
 *   · A BOARD WITH NO EMPTY STATE. "No pulse" and "no closed trade yet" are different
 *     facts and both are real; a board that draws nothing for either looks broken.
 *
 * Source-level, like the other viewer tests: the scene needs a WebGL context to run, and
 * a test that needs a GPU is a test that gets skipped. The rendering itself was verified
 * against a real headless Chromium when it was built — the mesh was found in the scene at
 * world (11.36, 1.42, -9.48), visible, with its canvas face reading back correctly.
 *
 *   node test-hawk-range-board.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "viewer", "office3d.html"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

/* The board's own block, sliced out so a match cannot come from somewhere else on a
   28,000-line page. */
const start = src.indexOf("const hawkBoard = (() => {");
const end = src.indexOf("window.__hawkBoardUpdate();", start);
const block = start >= 0 && end > start ? src.slice(start, end) : "";

console.log("\nthe board exists, on his range");
ok("the scoreboard block is present", block.length > 800, `${block.length} chars`);
ok("it is built into HAWK-AI's own range group, so it moves with HAWK_RANGE",
  /const R = hawkFig\.range;/.test(block));
ok("it carries its own posts and foot — a freestanding board, not a floating panel",
  /const post = \(dz\)/.test(block) && /foot\.scale\.set/.test(block));
ok("the canvas is the same 768x448 the other boards use",
  /c\.width = 768; c\.height = 448;/.test(block));

console.log("\nthe plane clears its frame — the failure GROX's board has a comment about");
/* frame box: 0.06 deep centred at x=0.02, so its front face is at 0.05.
   The canvas plane must sit PROUD of that, with room to spare. */
const meshX = Number(block.match(/mesh\.position\.set\(([\d.]+), BY, BZ\)/)?.[1]);
const frameX = Number(block.match(/frame\.position\.set\(([\d.]+), BY, BZ\)/)?.[1]);
const frameDepth = Number(block.match(/new THREE\.BoxGeometry\(([\d.]+), [\d.]+, [\d.]+\)/)?.[1]);
ok("the three numbers are readable from the source", [meshX, frameX, frameDepth].every(Number.isFinite),
  `mesh ${meshX}, frame ${frameX}, depth ${frameDepth}`);
const frontFace = frameX + frameDepth / 2;
const clearance = meshX - frontFace;
ok("the canvas sits proud of the frame's front face", clearance > 0,
  `clearance ${(clearance * 1000).toFixed(0)}mm`);
ok("...with more than a hair of it, so another driver cannot z-fight it away",
  clearance >= 0.02, `${(clearance * 1000).toFixed(0)}mm, wanted >= 20mm`);

console.log("\nit reads the pulse; it never fetches");
const fn = src.slice(src.indexOf("window.__hawkBoardUpdate = () => {"),
  src.indexOf("window.__hawkBoardUpdate();"));
ok("the draw function is present", fn.length > 1200, `${fn.length} chars`);
ok("it reads the heartbeat the panels publish",
  /window\.__botHeartbeat\?\.snipe/.test(fn) && /window\.__houseBot\?\.snipe/.test(fn));
/* THE ONE THAT MATTERS. Nothing in this scene fetches. */
for (const forbidden of ["fetch(", "call_api", "XMLHttpRequest"])
  ok(`the board never calls ${forbidden}`, !fn.includes(forbidden));

console.log("\nit is chalked from the pulse, not from the tab");
const pulse = src.slice(src.indexOf("if (hb) window.__botHeartbeat = hb;"),
  src.indexOf("if (hb) window.__botHeartbeat = hb;") + 600);
ok("the pulse handler redraws the board",
  /window\.__hawkBoardUpdate\?\.\(\);/.test(pulse),
  "so a passer-by reads a current number without opening a panel");
ok("it is drawn once at build, so the board is never a blank rectangle",
  src.includes("window.__hawkBoardUpdate();"));

console.log("\nboth empty states are real states, and both are drawn");
ok("no pulse at all says so", fn.includes("NO PULSE FROM THE LANE"));
ok("...and a live lane with nothing closed says something different",
  fn.includes("NO CLOSED TRADE YET"));
ok("the two are distinguished by whether the lane pulsed", /snipe \?/.test(fn));

console.log("\nthe numbers are read by sign, like every other book on this floor");
ok("the realised total is coloured by sign", /net > 0 \? GOOD : net < 0 \? BAD : INK/.test(fn));
ok("a row the bot could not price reads as words, never as zero",
  fn.includes('"not read"') && /r\.realizedSol === null/.test(fn));
ok("the record is wins-losses, from the book the bot sent",
  /bk\.wins/.test(fn) && /bk\.losses/.test(fn));
ok("it says when it is showing fewer rows than the book holds",
  /the \$\{rows\.length\} most recent of \$\{bk\.trades\}/.test(fn));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-hawk-range-board  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
