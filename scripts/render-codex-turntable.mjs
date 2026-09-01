#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "token");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FRAMES = 72;
const SIZE = 720;
const FPS = 24;
const COVER_FRAME = 11;

if (!fs.existsSync(path.join(DIST, "floor.html"))) {
  throw new Error("dist/floor.html is missing; run npm run build first");
}
if (!fs.existsSync(CHROME)) throw new Error(`Google Chrome is missing at ${CHROME}`);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-company-codex-turntable-"));
const framesDir = path.join(temporary, "frames");
const profileDir = path.join(temporary, "chrome-profile");
fs.mkdirSync(framesDir, { recursive: true });

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".svg", "image/svg+xml"],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/__capture_frame") {
    const index = Number(url.searchParams.get("i"));
    if (!Number.isInteger(index) || index < 0 || index >= FRAMES) {
      response.writeHead(400).end("bad frame");
      return;
    }
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      fs.writeFileSync(path.join(framesDir, `frame-${String(index).padStart(3, "0")}.png`), Buffer.concat(chunks));
      response.writeHead(204).end();
    });
    return;
  }

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "floor.html";
  if (relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(DIST, relative);
  if (file !== DIST && !file.startsWith(`${DIST}${path.sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.setHeader("Content-Type", mime.get(path.extname(file)) || "application/octet-stream");
  fs.createReadStream(file).pipe(response);
});

const listen = (instance, host = "127.0.0.1") => new Promise((resolve, reject) => {
  instance.once("error", reject);
  instance.listen(0, host, () => resolve(instance.address().port));
});
const close = (instance) => new Promise((resolve) => instance.close(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

class Cdp {
  constructor(url) {
    this.pending = new Map();
    this.nextId = 1;
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  call(method, params = {}, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression, timeoutMs = 120_000) {
  const response = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error(detail || "browser evaluation failed");
  }
  return response.result?.value;
}

function runFfmpeg(binary, args) {
  const result = spawnSync(binary, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg exited with ${result.status ?? result.signal}`);
}

let chrome;
let cdp;
try {
  const staticPort = await listen(server);
  const debugPort = await reservePort();
  const pageUrl = `http://127.0.0.1:${staticPort}/floor.html?floor=50&capture=1`;
  const chromeErrors = [];
  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=900,900",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    pageUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", (chunk) => {
    chromeErrors.push(String(chunk));
    if (chromeErrors.length > 30) chromeErrors.shift();
  });

  let target;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      target = targets.find((item) => item.type === "page" && item.url.includes("/floor.html"));
      if (target) break;
    } catch {}
    if (chrome.exitCode != null) break;
    await sleep(100);
  }
  if (!target) throw new Error(`Chrome target did not start\n${chromeErrors.join("").slice(-3000)}`);

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.call("Runtime.enable");

  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    ready = await evaluate(cdp, "Boolean(window.__rig && window.__workers && window.__workers.Codex)", 10_000);
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error("the live Codex rig did not become ready");

  const capture = await evaluate(cdp, `(async () => {
    const FRAMES = ${FRAMES}, SIZE = ${SIZE};
    const { renderer, scene, camera } = window.__rig;
    const worker = window.__workers.Codex;
    worker.seated = 0;
    worker.wantSeated = false;
    worker.update(0.016, 0);
    worker.g.position.y = worker.baseY;
    worker.g.rotation.y = 0;
    worker.g.visible = true;

    scene.children.forEach((child) => {
      if (!child.isLight) child.visible = child === worker.g;
    });
    worker.g.visible = true;
    worker.g.traverse((object) => {
      if (object.isSprite) object.visible = false;
    });
    scene.fog = null;
    if (scene.background && scene.background.set) scene.background.set(0x1d2b30);

    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.toneMappingExposure = 1.6;
    renderer.setClearColor(0x1d2b30, 1);
    camera.left = -1.22;
    camera.right = 1.22;
    camera.top = 1.22;
    camera.bottom = -1.22;
    camera.near = 0.1;
    camera.far = 200;
    camera.updateProjectionMatrix();

    const p = worker.g.position;
    for (let frame = 0; frame < FRAMES; frame++) {
      const angle = (frame / FRAMES) * Math.PI * 2 + 0.6;
      camera.position.set(p.x + Math.sin(angle) * 2.4, p.y + 1.55, p.z + Math.cos(angle) * 2.4);
      camera.lookAt(p.x, p.y + 1.02, p.z);
      camera.updateProjectionMatrix();
      // Worker.update() runs in the page's ordinary animation loop and may restore
      // the floating nameplate between asynchronous PNG uploads. Suppress every
      // sprite in the same synchronous turn as the render so no label edge leaks in.
      worker.g.traverse((object) => {
        if (object.isSprite) object.visible = false;
      });
      renderer.render(scene, camera);
      const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("canvas capture returned no pixels");
      const response = await fetch("/__capture_frame?i=" + frame, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: blob,
      });
      if (!response.ok) throw new Error("frame upload failed: " + response.status);
    }
    return { frames: FRAMES, size: SIZE, renderer: renderer.info.render };
  })()`, 180_000);

  const frames = fs.readdirSync(framesDir).filter((name) => /^frame-\d{3}\.png$/.test(name)).sort();
  if (frames.length !== FRAMES) throw new Error(`captured ${frames.length}/${FRAMES} frames`);
  if (capture?.frames !== FRAMES || capture?.size !== SIZE) throw new Error("browser returned an invalid capture summary");

  const ffmpeg = execFileSync("python3", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
    encoding: "utf8",
  }).trim();
  if (!fs.existsSync(ffmpeg)) throw new Error("imageio-ffmpeg binary is unavailable");

  const input = path.join(framesDir, "frame-%03d.png");
  const mp4 = path.join(OUT, "codex-turntable.mp4");
  const gif = path.join(OUT, "codex-turntable.gif");
  const cover = path.join(OUT, "codex-turntable-cover.png");
  runFfmpeg(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-framerate", String(FPS), "-i", input,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", mp4,
  ]);
  runFfmpeg(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-framerate", String(FPS), "-i", input,
    "-filter_complex",
    "[0:v]fps=12,scale=480:480:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop", "0", gif,
  ]);
  fs.copyFileSync(path.join(framesDir, `frame-${String(COVER_FRAME).padStart(3, "0")}.png`), cover);

  const info = (file) => ({ file: path.relative(ROOT, file), bytes: fs.statSync(file).size });
  console.log(JSON.stringify({ capture, outputs: [info(mp4), info(gif), info(cover)] }, null, 2));
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode == null) chrome.kill("SIGTERM");
  await close(server).catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
