/**
 * THE GUIDE TAB: the recording, its chapter map, and the player that reads it
 * (owner, 2026-09-14: "MAKE THE VIDEO EXACTLY PORTRAY THE TOPIC/LESSON").
 *
 * The failure this guards is drift between three files that must agree and have no
 * compiler between them: the narration in scripts/record-guide.mjs, the chapter map in
 * token/guide-chapters.json that the recording actually produced, and the player in
 * office3d.html that reads that map. Change the script without re-recording and the
 * voice describes one thing while the picture shows another — which is precisely the
 * defect the beat structure was introduced to fix, so it is worth a test rather than a
 * habit.
 *
 * It also pins the beat structure itself: every beat must carry its own second, the
 * seconds must run forward, and none may sit past the end of the recording. A beat whose
 * marker was missed falls back to wall clock, which lands the line on the wrong shot —
 * the monotonic check is what catches that in CI rather than on the wall.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
/* From guide-script.mjs, NOT record-guide.mjs. The recorder imports `playwright`, which
   this project does not depend on — it is installed by hand to re-record — so importing
   it here threw ERR_MODULE_NOT_FOUND under `npm ci` and took the whole suite down with
   it. The suite is the site's build step and Render's buildCommand, so that froze the
   deploy (pages.yml run 503). The narration is data and now lives in a module with no
   imports at all. */
import { CHAPTERS } from "./scripts/guide-script.mjs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const viewer = read("./viewer/office3d.html");
const map = JSON.parse(read("./token/guide-chapters.json"));
let pass = 0;
const ok = (name, cond, detail = "") => {
  assert.ok(cond, `${name}${detail ? " — " + detail : ""}`);
  console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`);
  pass++;
};

console.log("\n1. THE MEDIA SHIPS");
for (const f of ["guide-walkthrough.mp4", "guide-walkthrough.webm"]) {
  const size = fs.statSync(new URL("./token/" + f, import.meta.url)).size;
  ok(`${f} is present and not a stub`, size > 250_000, `${(size / 1048576).toFixed(1)} MB`);
}
ok("the build publishes all three as assets",
  ["guide-walkthrough.mp4", "guide-walkthrough.webm", "guide-chapters.json"]
    .every((f) => read("./scripts/build-viewer.mjs").includes(f)));

console.log("\n2. THE CHAPTER MAP");
ok("it names the site it was recorded from", /^https?:\/\//.test(String(map.site || "")), String(map.site));
ok("…and when", !Number.isNaN(Date.parse(map.recordedAt)), String(map.recordedAt));
ok("the recording has a real duration", Number(map.duration) > 30, `${map.duration}s`);
const chapters = map.chapters || [];
ok("every chapter in the script made it into the recording",
  chapters.length === CHAPTERS.length, `${chapters.length} recorded, ${CHAPTERS.length} in the script`);
chapters.forEach((c, i) => {
  assert.equal(c.id, CHAPTERS[i].id, `chapter ${i} is ${c.id}, the script says ${CHAPTERS[i].id}`);
});
ok("…in the script's own order, id for id", true, chapters.map((c) => c.id).join(" → "));

console.log("\n3. THE BEATS — one sentence, one shot");
const beats = chapters.flatMap((c) => (c.beats || []).map((b) => ({ ...b, chapter: c.id })));
ok("every chapter has at least one beat", chapters.every((c) => (c.beats || []).length > 0));
ok("the recording has as many beats as the script speaks",
  beats.length === CHAPTERS.reduce((n, c) => n + c.beats.length, 0), `${beats.length} beats`);
/* THE ONE THAT CATCHES A MISSED MARKER. A beat whose colour was not found in the video
   keeps its wall-clock second, which runs ahead of video time on a headless renderer that
   drops frames — so it lands late, on the next shot. Out-of-order or past-the-end seconds
   are how that shows up in a file. */
let last = -1;
for (const b of beats) {
  assert.ok(Number.isFinite(Number(b.at)), `beat in ${b.chapter} has no second`);
  assert.ok(Number(b.at) >= last, `beat seconds run backwards at ${b.chapter} (${b.at} after ${last})`);
  assert.ok(Number(b.at) <= Number(map.duration) + 1, `beat in ${b.chapter} sits past the end (${b.at} of ${map.duration})`);
  last = Number(b.at);
}
ok("every beat carries a second, in order, inside the recording", true, `0s → ${last}s over ${map.duration}s`);
/* The words in the file must be the words in the script, or the transcript under the
   player is quoting a take that no longer exists. */
const scripted = CHAPTERS.flatMap((c) => c.beats.map((b) => b.say));
ok("every spoken line matches the script, word for word",
  beats.length === scripted.length && beats.every((b, i) => b.say === scripted[i]));
ok("no beat is silent", beats.every((b) => String(b.say || "").trim().length > 8));
ok("a chapter's own text is its beats joined",
  chapters.every((c) => c.say === (c.beats || []).map((b) => b.say).join(" ")));

console.log("\n4. THE RECORDER KEEPS PICTURE AND SENTENCE TOGETHER");
const recorder = read("./scripts/record-guide.mjs");
ok("the hold for a beat is the length of ITS OWN line",
  /await page\.waitForTimeout\(Math\.ceil\(b\.spoken \* 1000\) \+ \d+\)/.test(recorder));
const capAt = recorder.indexOf("window.__cap?.(text, lbl)");
ok("…and the line is only spoken after its camera move has run",
  capAt > 0 && recorder.indexOf("if (b.act)") < capAt);
ok("the spotlight is set before the caption, so ring and words arrive together",
  capAt > 0 && recorder.indexOf("window.__spot?.(s || null), b.spot") < capAt);
/* CAPTURE, NOT RECORD. Playwright's own recorder encoded VP8 at ~926 kb/s and padded a
   0.3 fps software-GL render up to a nominal 25 fps, which is both halves of "laggy and
   not HD" (owner, 2026-09-14). Frames are taken at 1080p and the reel is assembled here,
   so the beat seconds are frame indices — exact, with no marker to paint and miss. */
/* The option, not the word — the comment above it in the recorder explains why it is gone
   and would match a bare /recordVideo/ forever. */
ok("the recorder captures frames rather than using Playwright's video recorder",
  !/recordVideo\s*:/.test(recorder) && /page\.screenshot\(\{ path: path\.join\(FRAMES/.test(recorder));
ok("…at a capture size above the delivery size, so the downscale supersamples",
  /const CAP_W = 1920, CAP_H = 1080;/.test(recorder) && /const OUT_W = 1280, OUT_H = 720;/.test(recorder) &&
  /flags=lanczos/.test(recorder));
ok("…and the 3D loop is frozen, which is what makes that rate possible at all",
  /window\.requestAnimationFrame = \(\) => 0;/.test(recorder) && /await freeze3d\(\);/.test(recorder));
ok("…re-frozen after every navigation, because a new document brings its own window",
  (recorder.match(/await freeze3d\(\);/g) || []).length >= 2);
/* A BEAT'S SECOND IS REAL ELAPSED TIME, and each frame holds for the gap that actually
   followed it. FPS is a budget the capture loop aims at, not one it hits: assembling at
   the nominal 12 while capture ran at 10.7 played the reel eleven percent fast, which
   shortened every hold by eleven percent and had the voice talking over itself — with
   video and audio still in perfect apparent sync, because both indexed the same wrong
   number. Only the timestamps make video time and wall time the same thing. */
ok("beat seconds come from the capture timestamps, not a nominal frame rate",
  /m\.at = Math\.round\(\(\(stamps\[m\.frame\] - base\) \/ 1000\) \* 10\) \/ 10;/.test(recorder));
ok("…and each frame holds for the gap that actually followed it",
  /const hold = i \+ 1 < stamps\.length \? \(stamps\[i \+ 1\] - stamps\[i\]\) \/ 1000 : median;/.test(recorder));
ok("…so the colour-marker readback is gone entirely",
  !/marker not found/.test(recorder) && !/PALETTE/.test(recorder));
ok("the voice is the high-quality model's own pace, with prosody noise left on",
  /"--length-scale", "1\.0"/.test(recorder) && /"--noise-scale", "0\.667"/.test(recorder) &&
  /"--noise-w-scale", "0\.8"/.test(recorder) && /"--sentence-silence", "0\.32"/.test(recorder));
/* THIS FILE IMPORTS THAT ONE. Without the guard the import drives a browser over the live
   site and rewrites the committed media, so running the test would re-record the take it
   is checking — and the check would always pass, on a recording nobody reviewed. The
   import at the top of this file having got here at all is most of the proof; the pin
   keeps the guard from being deleted as dead code. */
ok("importing the recorder does not record",
  /const isMain = process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/.test(recorder) &&
  /if \(isMain\) await record\(\);/.test(recorder));
ok("…and the raw take is not committed", /^\.guide-work\/$/m.test(read("./.gitignore")));

/* THE ONE THAT FROZE THE DEPLOY (pages.yml run 503, 2026-09-14), and the reason the
   narration lives in a module of its own. `playwright` is not in package.json — it is
   installed by hand to re-record — so nothing the SUITE imports may reach it. This suite
   is the site's build step AND Render's buildCommand, so a single unresolvable import
   here stops the site shipping, which is a far larger blast radius than one red test.
   Assert the narration module imports nothing at all, rather than trusting that nobody
   adds an import to it later. */
const scriptModule = read("./scripts/guide-script.mjs");
const self = read("./test-guide.mjs");
ok("the narration module imports nothing", !/^\s*import\s/m.test(scriptModule));
/* The word itself is in this module's header, explaining why — so match an IMPORT of it,
   not a mention of it. */
ok("…so the suite never reaches playwright through it",
  !/(?:from|require\()\s*["']playwright["']/.test(scriptModule));
ok("…and this test reads the narration module, not the recorder",
  /from "\.\/scripts\/guide-script\.mjs"/.test(self) &&
  !/^import \{[^}]*\} from "\.\/scripts\/record-guide\.mjs"/m.test(self));

console.log("\n5. THE PLAYER READS ALL OF IT");
ok("the transcript follows BEATS, not whole chapters", /const beats = chapters\.flatMap\(/.test(viewer));
ok("…and an older recording without beats still plays",
  /Array\.isArray\(c\.beats\) && c\.beats\.length \? c\.beats : \[\{ at: c\.at, say: c\.say \}\]/.test(viewer));
ok("the scrub bar is drawn from the chapter ticks", /guide-scrub/.test(viewer) && /drawTicks/.test(viewer));
ok("the rail lights the chapter playing and dims the ones done",
  /classList\.toggle\("on", i === n\)/.test(viewer) && /classList\.toggle\("done", i < n\)/.test(viewer));
ok("prev, next and play are wired", /prevBtn\.onclick/.test(viewer) && /nextBtn\.onclick/.test(viewer) && /playBtn\.onclick/.test(viewer));
ok("the clock shows position and length", /mmss\(video\.currentTime\)/.test(viewer));
/* Native controls are off (they would draw over the burned-in captions), so the keys they
   would have provided must exist here or the guide is mouse-only. */
ok("the player is reachable from the keyboard without native controls",
  !/video\.controls\s*=\s*true/.test(viewer) && /stage\.tabIndex = 0/.test(viewer) &&
  /e\.key === "ArrowLeft"/.test(viewer) && /e\.key === "ArrowRight"/.test(viewer) &&
  /e\.key === " "/.test(viewer));
ok("the ticks are drawn even when metadata landed before the listener was wired",
  /if \(video\.readyState >= 1\) drawTicks\(\);/.test(viewer));
ok("it still falls back when the media is not published on this host",
  /The recording is not published on this host yet/.test(viewer));
/* ONE COLUMN BY DEFAULT, TWO ONLY WHEN THE PANEL ITSELF IS WIDE. A viewport media query
   was wrong here and shipped a player crushed to a thumbnail: this panel sits in the dock
   rail at roughly 400px however wide the screen is, so `max-width:700px` never fired on a
   desktop. The container query asks the panel, which is the box that actually varies. */
ok("the split is single-column until the PANEL is wide, not the viewport",
  /\.guide\{container-type:inline-size\}/.test(viewer) &&
  /\.guide-split\{display:grid;grid-template-columns:minmax\(0,1fr\);/.test(viewer) &&
  /@container \(min-width:620px\)\{\.guide-split\{grid-template-columns:minmax\(0,1fr\) minmax\(0,240px\)\}\}/.test(viewer) &&
  !/@media \(max-width:700px\)\{\.guide-split/.test(viewer));

console.log(`\n${pass} passed — the guide's script, its recording and its player agree\n`);
