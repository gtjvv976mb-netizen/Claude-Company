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

/* THE SCRIPT. Each beat is one spoken sentence, the camera move it describes, and the thing
   on the page it is about. `spot` rings that element so the eye lands where the words do. */
export const CHAPTERS = [
  { id: "hook", title: "The desk", beats: [
    { say: "Sixteen analysts. One trading desk. Real money on Solana." },
    { say: "This is the fiftieth floor, and everything you're about to see is live.", spot: ".deskline, #deskline" },
  ] },
  { id: "tower", title: "The tower", page: "tower", beats: [
    { say: "Claude Tower. Fifty floors, one desk on each." },
    { say: "The house desk works upstairs on fifty. It studies new coins all day, and publishes the few it would actually trade." },
  ] },
  { id: "lease", title: "Lease a floor", beats: [
    { say: "Any vacant floor can be yours. One floor per wallet.", act: async (p, h) => h.selectVacant() },
    { say: "And right beside the price: the house bot's own record, with the house's own money." },
  ] },
  { id: "enter", title: "Step inside", page: "floor", beats: [
    { say: "Step inside. The house floor is open to everyone, no sign-in needed." },
    { say: "Every character here is an analyst, and every one of them has a job." },
  ] },
  { id: "funnel", title: "The funnel", beats: [
    { say: "Watch the counter along the bottom.", spot: ".deskline, #deskline" },
    { say: "Coins studied today, coins turned down, and the few still on watch. Most of them die right here, and that is the point.", spot: ".deskline, #deskline" },
  ] },
  { id: "callouts", title: "Big Callers", beats: [
    { say: "Big Callers is the raw feed — everything the desk has spotted.", act: async (p, h) => h.tab("callouts") },
    { say: "None of these is a call yet." },
  ] },
  { id: "candidates", title: "Candidates", beats: [
    { say: "Candidates are the shortlist, waiting to be studied.", act: async (p, h) => { await h.tab("calls"); await h.sub("calls", "candidates"); } },
  ] },
  { id: "published", title: "The calls", beats: [
    { say: "A published call carries three numbers.", act: async (p, h) => h.sub("calls", "published") },
    { say: "An entry, a stop, and a target. That is what your bot acts on — nothing vaguer than that." },
  ] },
  { id: "closed", title: "How it ended", beats: [
    { say: "Closed shows how each one ended, and the coins the desk turned down.", act: async (p, h) => h.sub("calls", "closed") },
  ] },
  { id: "overview", title: "The money", beats: [
    { say: "The Overview is the money view.", act: async (p, h) => h.tab("overview") },
    { say: "Profit and loss, straight out of the bot's own journal." },
    { say: "Open positions draw as a bar: where it got in, the stop below, the target above.", act: async (p, h) => h.scroll(".bot-book"), spot: ".bot-book" },
  ] },
  { id: "wallste", title: "WALL-ST-E", beats: [
    { say: "Wall Street E is the bot itself.", act: async (p, h) => h.tab("wallste") },
    { say: "Your wallet, your caps, running on your own machine. The key is made there and never leaves it." },
  ] },
  { id: "hawkai", title: "HAWK-AI", beats: [
    { say: "Hawk A I is the second lane — a sniper that watches brand new launches.", act: async (p, h) => h.tab("hawkai") },
  ] },
  { id: "activity", title: "The receipts", beats: [
    { say: "Activity is the receipt.", act: async (p, h) => h.tab("activity") },
    { say: "The tape, every decision the desk made, and the ledger underneath it." },
  ] },
  { id: "performance", title: "Who is right", beats: [
    { say: "Performance ranks the analysts on one thing: whether they were actually right.", act: async (p, h) => h.tab("performance") },
  ] },
  { id: "team", title: "Your track", beats: [
    { say: "Team is who works your floor.", act: async (p, h) => h.tab("team") },
    { say: "It is also where you choose who runs your bot — and you can run it yourself, with one command.", act: async (p, h) => h.scroll("[data-runner-option], #teamcontrolpanel") },
  ] },
  { id: "board", title: "Big C's board", beats: [
    { say: "And up on the wall, Big C keeps the live book.", act: async (p, h) => h.closeRail() },
    { say: "Every open trade, every close, redrawn every ten seconds." },
  ] },
  { id: "end", title: "Plug in", beats: [
    { say: "Lease a floor. Plug in your own bot. Let it work." },
  ] },
];

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  recordVideo: { dir: WORK, size: { width: 1280, height: 720 } } });
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
    /* A colour marker in the top-right corner, one per BEAT, cycling through a small
       palette: the recording's own clock. Wall-clock marks drift against a headless
       renderer that drops frames, so beat times are read back from the video itself. */
    const mark = document.createElement("div"); mark.id = "cc-guide-mark";
    mark.style.cssText = "position:fixed;right:0;top:0;width:14px;height:14px;z-index:2147483647;pointer-events:none;background:transparent";
    document.body.appendChild(mark);
  };
  if (document.body) install(); else document.addEventListener("DOMContentLoaded", install);
  window.__cap = (text, label, color) => {
    install();
    document.getElementById("cc-guide-mark").style.background = color || "transparent";
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

/* Eight colours far apart in RGB, cycled across the beats. Only ADJACENT beats ever need
   telling apart, because each search starts where the previous beat was found, so eight is
   plenty however long the script grows — and a 14-pixel patch sampled at its centre
   survives VP9 at crf 34, which a 6-pixel one did not. */
const PALETTE = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255],[255,128,0],[128,0,255]];
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

const t0 = Date.now();
const marks = [];
await page.goto(PAGES.floor, { waitUntil: "load", timeout: 120000 });
await page.waitForTimeout(9000);

for (const b of BEATS) {
  if (b.page) {
    await page.evaluate(() => window.__spot?.(null)).catch(() => {});
    await page.goto(PAGES[b.page], { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(b.page === "floor" ? 8000 : 3500);
  }
  if (b.act) { try { await b.act(page, helpers); } catch {} await page.waitForTimeout(900); }
  /* The spotlight is set BEFORE the caption, so the ring and the words appear together
     rather than the eye being sent somewhere a third of a second late. */
  await page.evaluate((s) => window.__spot?.(s || null), b.spot || null).catch(() => {});
  marks.push({ key: b.key, chapter: b.chapter, title: b.title, say: b.say, first: b.first,
    at: Math.round((Date.now() - t0) / 100) / 10 });
  const colour = PALETTE[(marks.length - 1) % PALETTE.length];
  await page.evaluate(([text, lbl, color]) => window.__cap?.(text, lbl, color),
    [b.say, b.title, `rgb(${colour.join(",")})`]).catch(() => {});
  await page.waitForTimeout(Math.ceil(b.spoken * 1000) + 750);
}
await page.evaluate(() => { window.__cap?.("", "", "transparent"); window.__spot?.(null); }).catch(() => {});
await page.waitForTimeout(900);
const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();
let duration = Math.round((Date.now() - t0) / 100) / 10;

/* 3 · THE CLOCK IS THE VIDEO'S OWN. A headless renderer drops frames, so the wall-clock
   second a beat began drifts against where it appears in the file — two seconds by the end
   of a ninety-second take, which is the difference between a line landing on its subject
   and landing on the next one. Each beat painted its colour into the top-right marker;
   read it back at ten samples a second, take the first three-sample hold, and search
   forward from the previous beat so a cycled palette is never ambiguous. */
const raw = execFileSync(FFMPEG, ["-loglevel", "error", "-i", webm, "-vf", "crop=8:8:1269:3,scale=1:1", "-r", "10",
  "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 28 });
const nearest = (r, g, b) => {
  let best = -1, d = Infinity;
  PALETTE.forEach((c, i) => { const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (dd < d) { d = dd; best = i; } });
  return d < 110 * 110 ? best : -1;
};
const seq = []; for (let i = 0; i + 2 < raw.length; i += 3) seq.push(nearest(raw[i], raw[i + 1], raw[i + 2]));
let cursor = 0, missed = 0;
marks.forEach((m, k) => {
  const want = k % PALETTE.length;
  for (let i = cursor; i + 2 < seq.length; i++) {
    if (seq[i] === want && seq[i + 1] === want && seq[i + 2] === want) { m.at = i / 10; cursor = i + 1; return; }
  }
  missed++;
  console.warn(`beat ${m.key}: marker not found after ${(cursor / 10).toFixed(1)}s; keeping the wall-clock second ${m.at}`);
});
if (missed) console.warn(`${missed} of ${marks.length} beats fell back to wall clock`);

/* 4 · TRIM THE LEAD-IN. The first beat cannot speak until the floor has rendered, which
   is nine seconds of WebGL on a headless renderer — nine seconds of a silent, motionless
   page at the top of the video, which is where a viewer decides whether to keep watching.
   None of it is content, so it is cut, and every beat moves earlier by what was cut. */
const LEAD = Math.max(0, Math.round((marks[0].at - 1.2) * 10) / 10);
if (LEAD > 0) {
  marks.forEach((m) => { m.at = Math.round((m.at - LEAD) * 10) / 10; });
  duration = Math.round((duration - LEAD) * 10) / 10;
  console.log(`trimmed ${LEAD}s of lead-in; the first line now lands at ${marks[0].at}s`);
}

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
/* -ss BEFORE -i seeks the input, so the picture starts at the trim point and the beat
   seconds above, already shifted by the same amount, still line up with it. */
const encode = (out, vcodec) => execFileSync(FFMPEG, ["-y",
  ...(LEAD > 0 ? ["-ss", String(LEAD)] : []), "-i", webm, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed,
  "-map", "0:v:0", "-map", "[voice]", ...vcodec, "-shortest", out], { stdio: "inherit" });
const mp4 = path.join(ROOT, "token", "guide-walkthrough.mp4");
encode(mp4, ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "112k"]);
/* And the same recording as VP9/Opus, for Chromium builds that ship without H.264. */
const webmOut = path.join(ROOT, "token", "guide-walkthrough.webm");
encode(webmOut, ["-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
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
