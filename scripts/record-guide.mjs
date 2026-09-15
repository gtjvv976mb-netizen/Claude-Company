/* THE GUIDE, RECORDED FROM THE REAL SITE (owner, 2026-09-13; rebuilt 2026-09-14).
 *
 * Records the published pages as real clicks on the live site, speaks the narration, and
 * burns it into the file the GUIDE tab plays. Writes:
 *
 *     token/guide-walkthrough.mp4     the video, voice included (H.264/AAC)
 *     token/guide-walkthrough.webm    the same, VP9/Opus, for Chromium builds without H.264
 *     token/guide-chapters.json       chapters, their beats, and each one's start second
 *
 * All three are committed like the other finished media, so `npm run build` needs none of
 * the tooling below. Run this only to re-record after the site changes.
 *
 *   - playwright (npm) and a Chromium it can launch: PLAYWRIGHT_CHROMIUM=/path/to/chrome
 *   - piper-tts (pip) and a voice: PIPER_VOICE=/path/to/en_US-ryan-high.onnx
 *   - an ffmpeg binary: FFMPEG=/path/to/ffmpeg (npm's @ffmpeg-installer/ffmpeg is fine)
 *
 *     GUIDE_SITE=https://solana.claudedotcompany.com node scripts/record-guide.mjs
 *
 * WHY BEATS, AND NOT ONE NARRATION PER CHAPTER (rebuilt 2026-09-14, owner: "the video
 * exactly portray the topic"). The first cut spoke a whole paragraph over a single camera
 * move, so the viewer heard three things and saw one — the chapter that narrated "Big C's
 * board keeps the live book" only closed the rail and never looked at the board. A chapter
 * is now a list of BEATS, and a beat is one sentence with its own camera action and its own
 * spotlight. The sentence cannot be spoken while something else is on screen, because the
 * hold for the sentence IS the hold for its action.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.GUIDE_SITE || "https://solana.claudedotcompany.com").replace(/\/$/, "");
const API = process.env.GUIDE_API || "https://claude-company-api.onrender.com";
const WORK = process.env.GUIDE_WORK || path.join(ROOT, ".guide-work");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || undefined;
const VOICE = process.env.PIPER_VOICE;
const FFMPEG = process.env.FFMPEG || "ffmpeg";
/* Capture big, deliver smaller: the downscale supersamples and the text comes out
   sharper than capturing at the delivery size ever could. */
const CAP_W = 1920, CAP_H = 1080;
const OUT_W = 1280, OUT_H = 720;
/* Measured in this sandbox, 2026-09-14, with the 3D loop frozen: 66 ms a frame on the
   floor, 74 ms over a panel. 12 fps leaves headroom on both; 15 would sit exactly on the
   limit and fall behind whenever a panel does real work. */
const FPS = Number(process.env.GUIDE_FPS || 12);

/* THE SCRIPT. Each beat is one spoken sentence, the camera move it describes, and the thing
   on the page it is about. `spot` rings that element so the eye lands where the words do. */
export { CHAPTERS } from "./guide-script.mjs";
import { CHAPTERS } from "./guide-script.mjs";

/* EVERYTHING BELOW RUNS ONLY WHEN THIS FILE IS THE COMMAND.
 *
 * The narration above is data, and test-guide.mjs imports it to check the committed
 * recording still says what the script says. Until this guard existed that import
 * launched a browser, drove the live site and rewrote the committed media as a side
 * effect of `node test-guide.mjs` — a test that silently re-records the thing it is
 * meant to be checking is worse than no test. Import gets the script; running gets the
 * recording. */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await record();

async function record() {
if (!VOICE) throw new Error("PIPER_VOICE must name a Piper .onnx voice");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "voice"), { recursive: true });

/* 1 · THE VOICE FIRST, so every hold can be sized to its own line.
   ryan-high at 22 kHz, and the three prosody knobs left near their trained defaults:
   noise-scale and noise-w are what keep a line from landing on the same flat contour
   every time, and sentence-silence gives a beat of two sentences a real breath between
   them rather than a comma's worth. length-scale 1.0 is the voice's own pace; the first
   cut ran at 1.05 and read as a recorded announcement rather than someone talking. */
const wavSeconds = (file) => {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24), channels = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  return (b.length - 44) / (rate * channels * (bits / 8));
};
const BEATS = [];
CHAPTERS.forEach((c, ci) => c.beats.forEach((b, bi) => BEATS.push({ ...b, chapter: c.id, title: c.title, ci, bi,
  key: `${c.id}-${bi}`, first: bi === 0, page: bi === 0 ? c.page : undefined })));
for (const b of BEATS) {
  const wav = path.join(WORK, "voice", `${b.key}.wav`);
  execFileSync("python3", ["-m", "piper", "--model", VOICE, "--output_file", wav,
    "--length-scale", "1.0", "--noise-scale", "0.667", "--noise-w-scale", "0.8",
    "--sentence-silence", "0.32"], { input: b.say });
  b.spoken = wavSeconds(wav);
}
console.log(`voice: ${BEATS.length} beats, ${BEATS.reduce((s, b) => s + b.spoken, 0).toFixed(1)}s of speech`);

/* 2 · THE RECORDING: real pages, real clicks, a caption bar and a spotlight for the eye. */
const browser = await chromium.launch({ headless: true, executablePath: CHROME,
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--font-render-hinting=none"] });
/* 1920x1080 AND NO recordVideo. Playwright's built-in recorder encodes VP8 at about
   926 kb/s, which throws the detail away at capture time — no output encoder can put it
   back, and the first cut shipped soft text because of it. Frames are taken here instead,
   as JPEG at quality 92, roughly 370 KB each: two orders of magnitude more data per
   frame. Captured at 1080p and delivered at 720p, so the downscale supersamples and the
   text comes out sharper than capturing at 720p ever could. */
const ctx = await browser.newContext({ viewport: { width: CAP_W, height: CAP_H }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById("cc-guide-cap")) return;
    const bar = document.createElement("div"); bar.id = "cc-guide-cap";
    bar.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:940px;padding:13px 20px;" +
      "background:rgba(10,12,16,.88);color:#f4f1e8;font:600 20px/1.35 Archivo,Helvetica,Arial,sans-serif;border-radius:12px;" +
      "z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:center;pointer-events:none;opacity:0;transition:opacity .3s";
    document.body.appendChild(bar);
    const step = document.createElement("div"); step.id = "cc-guide-step";
    step.style.cssText = "position:fixed;left:18px;top:14px;padding:6px 10px;background:rgba(217,119,87,.92);color:#2a1a14;" +
      "font:700 12px/1 Archivo,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;border-radius:6px;z-index:2147483647;pointer-events:none;opacity:0";
    document.body.appendChild(step);
    /* THE SPOTLIGHT. A caption says what; this says where. Without it a sentence about the
       funnel counter plays over a whole floor and the viewer has to hunt for the subject. */
    const ring = document.createElement("div"); ring.id = "cc-guide-ring";
    ring.style.cssText = "position:fixed;border:2px solid #d97757;border-radius:10px;z-index:2147483646;pointer-events:none;" +
      "opacity:0;transition:opacity .25s,left .35s,top .35s,width .35s,height .35s;box-shadow:0 0 0 4000px rgba(6,8,12,.42),0 0 18px rgba(217,119,87,.75)";
    document.body.appendChild(ring);
  };
  if (document.body) install(); else document.addEventListener("DOMContentLoaded", install);
  window.__cap = (text, label) => {
    install();
    const bar = document.getElementById("cc-guide-cap"); bar.textContent = text; bar.style.opacity = text ? "1" : "0";
    const step = document.getElementById("cc-guide-step"); step.textContent = label || ""; step.style.opacity = label ? "1" : "0";
  };
  window.__spot = (selector) => {
    install();
    const ring = document.getElementById("cc-guide-ring");
    const el = selector && document.querySelector(selector);
    if (!el) { ring.style.opacity = "0"; return false; }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { ring.style.opacity = "0"; return false; }
    const pad = 8;
    ring.style.left = Math.max(2, r.left - pad) + "px";
    ring.style.top = Math.max(2, r.top - pad) + "px";
    ring.style.width = Math.min(innerWidth - 8, r.width + pad * 2) + "px";
    ring.style.height = Math.min(innerHeight - 8, r.height + pad * 2) + "px";
    ring.style.opacity = "1";
    return true;
  };
});
const page = await ctx.newPage();
page.on("pageerror", () => {});
/* Behind a proxy, the browser's own network stack may not carry the session's CA; relaying
   through Node's fetch does, and Node still verifies against it. Harmless where no proxy
   is in the way, and the only way to record from a sandbox that has one. */
if (process.env.GUIDE_RELAY_FETCH === "1") {
  await page.route("**/*", async (route) => {
    const req = route.request();
    try {
      const r = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined, redirect: "manual" });
      const body = Buffer.from(await r.arrayBuffer());
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = v; });
      await route.fulfill({ status: r.status, headers, body });
    } catch { await route.abort(); }
  });
}

/* A vacant floor, chosen from the live directory so the lease card really is a lease card:
   the tower's `floors` array is module-scoped and not reachable from evaluate. */
const VACANT = await (async () => {
  try {
    const r = await fetch(`${API}/api/tower/floors`);
    const rows = (await r.json()).floors || [];
    const vacant = rows.filter((f) => f.state === "vacant").map((f) => f.n).sort((a, b) => b - a);
    return vacant[0] || 14;
  } catch { return 14; }
})();

const helpers = {
  tab: (dest) => page.evaluate((d) => document.querySelector(`.dtab[data-destination="${d}"]`)?.click(), dest).catch(() => {}),
  sub: (group, view) => page.evaluate(([g, v]) => document.querySelector(`[data-${g}-view="${v}"]`)?.click(), [group, view]).catch(() => {}),
  scroll: (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start", behavior: "smooth" }), sel).catch(() => {}),
  closeRail: () => page.evaluate(() => { try { closeRail(); } catch {} }).catch(() => {}),
  selectVacant: () => page.evaluate((n) => { try { select(n, true); } catch {} }, VACANT).catch(() => {}),
};
const PAGES = {
  tower: `${SITE}/tower.html`,
  floor: `${SITE}/floor.html?floor=50`,
};

/* FREEZE THE 3D LOOP, and this is what makes a sharp recording possible at all.
 *
 * There is no GPU here, so WebGL runs through swiftshader. Measured: a screenshot of the
 * live floor costs 3206 ms — 0.3 frames a second — because each one forces the scene to
 * re-render in software. Stop the render loop and the same screenshot costs 66 ms, which
 * is 15 a second, a forty-eight-fold difference. The canvas keeps whatever it last drew,
 * so the floor stays a crisp still rather than a stuttering slideshow.
 *
 * Nothing worth watching is lost: a guide's motion is the interface — tabs opening,
 * panels filling, the spotlight moving, the caption changing, a list scrolling — and all
 * of that is DOM and CSS, which never needed the animation frame. Re-freezing after every
 * navigation is required because a new document brings its own window. */
const freeze3d = () => page.evaluate(() => {
  if (!window.__rafFrozen) { window.__rafFrozen = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; }
}).catch(() => {});

/* The frames, taken as fast as the page allows and stamped with the moment each was
   taken. Assembling from real timestamps is why the beat seconds below are exact rather
   than recovered: the first cut had to paint a colour marker into the corner of every
   shot and read it back out of the encoded file, because Playwright's recorder dropped
   and padded frames unpredictably. Here the clock is ours. */
const FRAMES = path.join(WORK, "frames");
fs.mkdirSync(FRAMES, { recursive: true });
const stamps = [];
let capturing = false, dropped = 0;
const captureLoop = async () => {
  const budget = 1000 / FPS;
  while (capturing) {
    const started = Date.now();
    try {
      await page.screenshot({ path: path.join(FRAMES, `f${String(stamps.length).padStart(6, "0")}.jpg`),
        type: "jpeg", quality: 92 });
      stamps.push(started);
    } catch { dropped++; }
    const spent = Date.now() - started;
    if (spent < budget) await new Promise((r) => setTimeout(r, budget - spent));
  }
};

const marks = [];
await page.goto(PAGES.floor, { waitUntil: "load", timeout: 120000 });
await page.waitForTimeout(9000);
await freeze3d();
await page.waitForTimeout(400);
capturing = true;
const capturer = captureLoop();
const t0 = Date.now();

for (const b of BEATS) {
  if (b.page) {
    await page.evaluate(() => window.__spot?.(null)).catch(() => {});
    await page.goto(PAGES[b.page], { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(b.page === "floor" ? 8000 : 3500);
    await freeze3d();                 // a new document brings its own window
  }
  if (b.act) { try { await b.act(page, helpers); } catch {} await page.waitForTimeout(900); }
  /* The spotlight is set BEFORE the caption, so the ring and the words appear together
     rather than the eye being sent somewhere a third of a second late. */
  await page.evaluate((s) => window.__spot?.(s || null), b.spot || null).catch(() => {});
  await page.evaluate(([text, lbl]) => window.__cap?.(text, lbl), [b.say, b.title]).catch(() => {});
  /* The beat's second, taken from the capture clock rather than guessed: the frame index
     at this instant IS the frame the line starts on. */
  marks.push({ key: b.key, chapter: b.chapter, title: b.title, say: b.say, first: b.first,
    frame: stamps.length, at: 0 });
  await page.waitForTimeout(Math.ceil(b.spoken * 1000) + 750);
}
await page.evaluate(() => { window.__cap?.("", ""); window.__spot?.(null); }).catch(() => {});
await page.waitForTimeout(900);
capturing = false;
await capturer;
await ctx.close();
await browser.close();
if (!stamps.length) throw new Error("no frames were captured");
console.log(`captured ${stamps.length} frames in ${((stamps.at(-1) - stamps[0]) / 1000).toFixed(1)}s ` +
  `= ${(stamps.length / ((stamps.at(-1) - stamps[0]) / 1000)).toFixed(1)} fps${dropped ? `, ${dropped} dropped` : ""}`);

/* 3 · TRIM THE LEAD-IN, then place every beat on its own frame.
 *
 * The first beat cannot speak until the floor has rendered, and none of that wait is
 * content — it is a silent, motionless page at exactly the point a viewer decides whether
 * to keep watching. Frames before the trim point are simply not written into the reel.
 *
 * Note what is NOT here any more: the colour marker painted into the corner of every shot
 * and read back out of the encoded file. That existed because Playwright's recorder
 * dropped and padded frames, so the only honest clock was the picture itself. Assembling
 * the reel ourselves means a beat's second is its frame index over the frame rate —
 * exact, and nothing to miss. */
/* EACH FRAME HOLDS FOR AS LONG AS IT ACTUALLY DID.
 *
 * FPS is a budget the capture loop aims at, not a rate it achieves: a screenshot that
 * overruns simply arrives late. The first cut of this stage assembled at the nominal 12
 * while capture had really run at 10.7, so the reel played eleven percent fast — and
 * because every beat's hold is sized to its own spoken line, an eleven percent shorter
 * hold means the next line starts before the last one has finished. Sync looked fine
 * (both sides indexed off the same nominal number) while the voice talked over itself.
 *
 * The timestamps are already here, so use them: a frame's duration is the gap to the next
 * one, and a beat's second is the real elapsed time to the frame it began on. Video time
 * and wall time are then the same thing, which is the only version that cannot drift. */
const FIRST = (() => {
  const want = stamps[marks[0].frame] - 1200;      // 1.2s of picture before the first line
  let i = marks[0].frame;
  while (i > 0 && stamps[i - 1] >= want) i--;
  return i;
})();
const base = stamps[FIRST];
marks.forEach((m) => { m.at = Math.round(((stamps[m.frame] - base) / 1000) * 10) / 10; });
let duration = Math.round(((stamps.at(-1) - base) / 1000) * 10) / 10;
const realFps = (stamps.length - FIRST) / Math.max(0.001, duration);
console.log(`trimmed ${(( base - stamps[0]) / 1000).toFixed(1)}s of lead-in; first line at ${marks[0].at}s; ` +
  `reel ${duration}s at a real ${realFps.toFixed(1)} fps`);

/* 4 · THE REEL. A concat list of the kept frames, each held for the gap that actually
   followed it. The last frame has no successor, so it takes the median gap. */
const reel = path.join(WORK, "reel.txt");
const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith(".jpg")).sort();
const gaps = stamps.slice(1).map((t, i) => (t - stamps[i]) / 1000);
const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 1 / FPS;
const q = (f) => path.join(FRAMES, f).replace(/'/g, "'\\''");
const lines = [];
for (let i = FIRST; i < files.length; i++) {
  const hold = i + 1 < stamps.length ? (stamps[i + 1] - stamps[i]) / 1000 : median;
  lines.push(`file '${q(files[i])}'`, `duration ${Math.max(0.005, hold).toFixed(5)}`);
}
lines.push(`file '${q(files.at(-1))}'`);           // concat needs the last file repeated
fs.writeFileSync(reel, lines.join("\n") + "\n");

/* 5 · THE MIX: each line laid at its own beat's second, then muxed with the picture. */
const inputs = [];
const filters = [];
marks.forEach((m, i) => {
  inputs.push("-i", path.join(WORK, "voice", `${m.key}.wav`));
  filters.push(`[${i + 1}:a]adelay=${Math.round(m.at * 1000)}|${Math.round(m.at * 1000)}[a${i}]`);
});
/* amix scales every input by 1/N and the lines never overlap, so volume=N restores them —
   on every ffmpeg, including ones without amix's normalize option. */
const mixed = marks.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${marks.length}:dropout_transition=0,volume=${marks.length}[voice]`;
/* The reel is 1080p stills; the delivery is 720p. Downscaling with lanczos supersamples
   the text, so it reads sharper than a 720p capture ever could — which is the whole point
   of capturing above the delivery size. crf 20 rather than 23 because screen text is
   exactly what a quantiser blurs first, and the content is mostly static so it costs
   little: the bytes go where the picture changes, and here it usually does not. */
const encode = (out, vcodec) => execFileSync(FFMPEG, ["-y",
  "-f", "concat", "-safe", "0", "-i", reel, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed +
    `;[0:v]scale=${OUT_W}:${OUT_H}:flags=lanczos,fps=${FPS},format=yuv420p[vid]`,
  "-map", "[vid]", "-map", "[voice]", ...vcodec, "-shortest", out], { stdio: "inherit" });
const mp4 = path.join(ROOT, "token", "guide-walkthrough.mp4");
encode(mp4, ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "112k"]);
/* And the same recording as VP9/Opus, for Chromium builds that ship without H.264. */
const webmOut = path.join(ROOT, "token", "guide-walkthrough.webm");
encode(webmOut, ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
  "-c:a", "libopus", "-b:a", "72k"]);

/* The GUIDE tab reads chapters for its rail and beats for the transcript that follows the
   voice, so both shapes are written: a chapter carries the second its first beat starts. */
const chapters = CHAPTERS.map((c) => {
  const own = marks.filter((m) => m.chapter === c.id);
  return { id: c.id, title: c.title, at: own[0]?.at ?? 0,
    say: own.map((m) => m.say).join(" "),
    beats: own.map((m) => ({ at: m.at, say: m.say })) };
});
fs.writeFileSync(path.join(ROOT, "token", "guide-chapters.json"),
  JSON.stringify({ site: SITE, recordedAt: new Date().toISOString(), duration, chapters }, null, 2) + "\n");
console.log(`guide: ${mp4} (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB, ~${duration}s, ${chapters.length} chapters, ${marks.length} beats)`);
console.log(chapters.map((c) => `${c.at}s ${c.id}`).join(" | "));
}
