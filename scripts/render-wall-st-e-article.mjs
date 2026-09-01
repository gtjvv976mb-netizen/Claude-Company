#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ARTICLE = path.join(ROOT, "marketing", "wall-st-e-article");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1600;
const HEIGHT = 900;

const CARDS = new Map([
  ["cover-wide", { filename: "wall-st-e-article-cover.png", width: 1500, height: 600 }],
  ["cover", { filename: "wall-st-e-article-cover-16x9.png", width: WIDTH, height: HEIGHT }],
  ["custody", { filename: "01-custody-boundary.png", width: WIDTH, height: HEIGHT }],
  ["two-paths", { filename: "02-two-ways-to-trade.png", width: WIDTH, height: HEIGHT }],
  ["runway", { filename: "03-install-rehearse-arm-fund.png", width: WIDTH, height: HEIGHT }],
  ["gauntlet", { filename: "04-entry-gauntlet.png", width: WIDTH, height: HEIGHT }],
  ["position", { filename: "05-position-policy.png", width: WIDTH, height: HEIGHT }],
  ["brakes", { filename: "06-local-brakes.png", width: WIDTH, height: HEIGHT }],
]);

if (!fs.existsSync(path.join(DIST, "floor.html"))) {
  throw new Error("dist/floor.html is missing; run npm run build first");
}
if (!fs.existsSync(path.join(ARTICLE, "visuals.html"))) {
  throw new Error("marketing/wall-st-e-article/visuals.html is missing");
}
if (!fs.existsSync(CHROME)) throw new Error(`Google Chrome is missing at ${CHROME}`);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-company-wallste-article-"));
const profileDir = path.join(temporary, "chrome-profile");
const heroPath = path.join(ARTICLE, "wall-st-e-hero.jpg");

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
]);

let heroResolve;
let heroReject;
const heroWritten = new Promise((resolve, reject) => {
  heroResolve = resolve;
  heroReject = reject;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "POST" && url.searchParams.get("seat") === "WALLSTE") {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("error", heroReject);
    request.on("end", () => {
      try {
        const dataUrl = Buffer.concat(chunks).toString("utf8");
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!match) throw new Error("WALL-ST-E capture was not a JPEG data URL");
        fs.writeFileSync(heroPath, Buffer.from(match[1], "base64"));
        response.writeHead(204).end();
        heroResolve(heroPath);
      } catch (error) {
        response.writeHead(400).end("bad capture");
        heroReject(error);
      }
    });
    return;
  }

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "marketing/wall-st-e-article/visuals.html";
  if (relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.setHeader("Content-Type", mime.get(path.extname(file).toLowerCase()) || "application/octet-stream");
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

  close() { this.socket.close(); }
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

async function waitFor(cdp, expression, label, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await evaluate(cdp, expression, 10_000)) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let chrome;
let cdp;
try {
  const staticPort = await listen(server);
  const debugPort = await reservePort();
  const floorUrl = `http://127.0.0.1:${staticPort}/dist/floor.html?floor=50&capture=1`;
  const chromeErrors = [];
  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
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
    floorUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", (chunk) => {
    chromeErrors.push(String(chunk));
    if (chromeErrors.length > 30) chromeErrors.shift();
  });

  let target;
  for (let attempt = 0; attempt < 140; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      target = targets.find((item) => item.type === "page" && item.url.includes("/dist/floor.html"));
      if (target) break;
    } catch {}
    if (chrome.exitCode != null) break;
    await sleep(100);
  }
  if (!target) throw new Error(`Chrome target did not start\n${chromeErrors.join("").slice(-3000)}`);

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(cdp, "Boolean(window.__turntableBot && window.__botGroup)", "WALL-ST-E capture rig");
  const studio = await evaluate(cdp, `(async () => {
    const lamp = window.__botGroup.children.find((object) => object.isMesh &&
      Math.abs(object.position.x - 0.18) < 0.01 && Math.abs(object.position.y - 1.31) < 0.01);
    if (!lamp?.material?.color || !lamp.material.emissive) throw new Error("WALL-ST-E lamp was not found");
    for (const colour of [lamp.material.color, lamp.material.emissive]) {
      const original = colour.set.bind(colour);
      colour.set = (value) => original(value === 0x4ec9a5 ? 0xe0ad3d : value);
    }
    return window.__turntableBot(1, ${staticPort});
  })()`, 120_000);
  await heroWritten;
  if (!fs.existsSync(heroPath) || fs.statSync(heroPath).size < 10_000) {
    throw new Error("WALL-ST-E hero capture is missing or unexpectedly small");
  }

  const outputs = [];
  for (const [card, { filename, width, height }] of CARDS) {
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const url = `http://127.0.0.1:${staticPort}/marketing/wall-st-e-article/visuals.html?card=${encodeURIComponent(card)}`;
    await cdp.call("Page.navigate", { url });
    await waitFor(cdp,
      `location.href === ${JSON.stringify(url)} && window.__ART_READY__ === true && document.body.dataset.card === ${JSON.stringify(card)}`,
      `${card} visual`);
    const screenshot = await cdp.call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const output = path.join(ARTICLE, filename);
    fs.writeFileSync(output, Buffer.from(screenshot.data, "base64"));
    outputs.push({ file: path.relative(ROOT, output), bytes: fs.statSync(output).size });
  }

  console.log(JSON.stringify({ studio, hero: path.relative(ROOT, heroPath), outputs }, null, 2));
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode == null) chrome.kill("SIGTERM");
  await close(server).catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
