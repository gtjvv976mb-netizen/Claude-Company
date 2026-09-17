/**
 * HAWK-AI's BOARD — the physical board on the floor, not the tab panel.
 *
 * The owner asked for "a physical board like GROX MULDER's". It was first built as a small
 * freestanding scoreboard on posts beside his shooting line — honest to an archery range,
 * and he could not find it on the floor. It was then rebuilt big, on its own partition
 * inside his range group — findable, and still not what was asked for. The instruction that
 * settled it: "remove the windows and put it on the window like the other board."
 *
 * So it is on the building. The back-wall glazing bay behind his shooting line is built
 * UNGLAZED AND PANELLED, and the board hangs there at GROX's exact size, square to the room
 * — the same wall treatment GROX's office builds for his, in the building's own terms.
 *
 * This file pins the handful of facts that decide whether that board is VISIBLE AND TRUE,
 * because every one of them has a failure mode that renders perfectly in code review and
 * shows nothing on the floor:
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
 * against a real headless Chromium at every revision — the mesh is found in the scene on
 * the back wall, visible, with its canvas face read back and legible, and the board is
 * visible in the floor's DEFAULT view rather than only from two metres away.
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

console.log("\nthe board exists, and it is on the building");
ok("the board block is present", block.length > 800, `${block.length} chars`);
/* IT TOOK A WINDOW. The building's back glazing is four bays; the one behind his
   shooting line is built unglazed and panelled so the board has a wall, the way GROX's
   office builds him one. Both halves are checked: the bay is declared, and the shell
   actually branches on it. */
ok("the bay it hangs in is declared once, for the shell and the board to share",
  /const HAWK_BOARD_BAY = ([\d.]+);/.test(src));
ok("the board is positioned from that bay, not from a number typed twice",
  /const BX = HAWK_BOARD_BAY/.test(block));
const bay = Number(src.match(/const HAWK_BOARD_BAY = ([\d.]+);/)?.[1]);
const shell = src.slice(src.indexOf("(function buildShell() {"), src.indexOf("/* ═══ THE CITY BEYOND"));
ok("that bay is one of the four the back wall actually glazes",
  /for \(const x of \[-14\.4, -11\.2, 11\.2, 14\.4\]\)/.test(shell) && [11.2, 14.4, -11.2, -14.4].includes(bay),
  `bay ${bay}`);
ok("...and the shell leaves it unglazed, with a panel in place of the glass",
  /if \(x === HAWK_BOARD_BAY\) \{/.test(shell) && /continue;/.test(shell));
/* The window he gets is the one BEHIND HIM. A board on the far side of the room is a
   board about somebody else. The pane is 2.3 wide, so half of it is the tolerance. */
const rangeX = Number(src.match(/const HAWK_RANGE = \{ x: ([\d.]+),/)?.[1]);
ok("it is the window behind HIS line, not any window",
  Number.isFinite(rangeX) && Math.abs(bay - rangeX) <= 1.15,
  `bay ${bay}, line ${rangeX}`);
ok("there are no posts left — a wall board does not stand on legs",
  !/const post = \(dz\)/.test(block) && !/foot\.scale\.set/.test(block));
/* ON THE SCENE, NOT ON `room`. The static merger takes room's children and their
   materials, and a merged canvas texture is a board that stops updating. */
ok("it goes on the scene, where the static merger cannot eat its canvas",
  /scene\.add\(mesh, frame, sill\);/.test(block) && !/room\.add\(/.test(block));
ok("the canvas is big enough to read from the floor", /c\.width = 1024; c\.height = 597;/.test(block));

console.log("\nthe plane clears its frame — the failure GROX's board has a comment about");
/* The frame box's front face sits half its depth in front of its centre, and the canvas
   must sit PROUD of that with room to spare. Read from the source rather than restated
   here, so the check cannot drift out of step with the geometry. */
const planeW = Number(block.match(/new THREE\.PlaneGeometry\(([\d.]+), [\d.]+\)/)?.[1]);
ok("the board is GROX's size, to the centimetre — that is what made his readable",
  planeW === 3.0, `${planeW}m wide`);
const meshZ = Number(block.match(/mesh\.position\.set\(BX, BY, BZ \+ ([\d.]+)\)/)?.[1]);
const frameZ = Number(block.match(/frame\.position\.set\(BX, BY, BZ \+ ([\d.]+)\)/)?.[1]);
const frameDepth = Number(block.match(/new THREE\.BoxGeometry\([\d.]+, [\d.]+, ([\d.]+)\)/)?.[1]);
ok("the three numbers are readable from the source", [meshZ, frameZ, frameDepth].every(Number.isFinite),
  `mesh ${meshZ}, frame ${frameZ}, depth ${frameDepth}`);
const frontFace = frameZ + frameDepth / 2;
const clearance = meshZ - frontFace;
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
