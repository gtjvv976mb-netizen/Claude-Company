import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, ["scripts/build-viewer.mjs"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    EXECUTOR_COMMIT: "a".repeat(40),
    SOURCE_COMMIT: "a".repeat(40),
  },
});
assert.equal(result.status, 0, result.stderr || result.stdout);

const articles = {
  "wall-st-e": [
    "article.md", "wall-st-e-article-cover.png", "wall-st-e-article-cover-16x9.png",
    "01-custody-boundary.png", "02-two-ways-to-trade.png",
    "03-install-rehearse-arm-fund.png", "04-entry-gauntlet.png",
    "05-position-policy.png", "06-local-brakes.png",
  ],
  "claude-grok-codex": [
    "article.md", "claude-grok-codex-header.png",
    "01-three-bounded-jobs.png", "02-integration-loop.png",
  ],
  "mission-vision": [
    "article.md", "mission-vision-header.png",
    "01-mission-in-practice.png", "02-vision-shift.png",
  ],
};

for (const [slug, files] of Object.entries(articles)) {
  const outputDir = path.join(root, "dist", "articles", slug);
  const index = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
  const paste = fs.readFileSync(path.join(outputDir, "x-paste.html"), "utf8");
  assert.equal(index, paste, `${slug} friendly route and X publishing route diverged`);
  assert.doesNotMatch(index, /\.\.\/\.\.\/token\//, `${slug} retained a private source-tree URL`);
  assert.match(index, /\.\.\/\.\.\/assets\/fonts\//, `${slug} does not use published fonts`);
  for (const file of files) assert.ok(fs.statSync(path.join(outputDir, file)).size > 0, `${slug}/${file} is empty`);
  for (const sourceOnly of ["README.md", "visuals.html", "wall-st-e-hero.jpg"]) {
    assert.equal(fs.existsSync(path.join(outputDir, sourceOnly)), false, `${slug}/${sourceOnly} leaked into dist`);
  }
}

for (const media of [
  "codex-turntable-cover.png", "codex-turntable.gif", "codex-turntable.mp4", "grox-mulder-front.png",
]) {
  const source = fs.readFileSync(path.join(root, "token", media));
  const output = fs.readFileSync(path.join(root, "dist", "assets", media));
  assert.deepEqual(output, source, `${media} was not copied byte-for-byte`);
}

for (const font of ["Archivo-Bold.ttf", "InstrumentSerif-Regular.ttf"]) {
  assert.ok(fs.statSync(path.join(root, "dist", "assets", "fonts", font)).size > 0, `${font} is empty`);
}

const marketingIndex = fs.readFileSync(path.join(root, "dist", "marketing", "index.html"), "utf8");
for (const route of [
  "../articles/wall-st-e/", "../articles/claude-grok-codex/", "../articles/mission-vision/",
  "../assets/codex-turntable.gif", "../assets/codex-turntable.mp4",
  "../assets/codex-turntable-cover.png", "../assets/grox-mulder-front.png",
]) {
  assert.ok(marketingIndex.includes(`href="${route}"`), `marketing index does not link ${route}`);
}
assert.doesNotMatch(marketingIndex, /<script\b/i, "marketing index should not require runtime JavaScript");
assert.match(marketingIndex, /Content-Security-Policy/, "marketing index lacks its static content policy");

console.log("marketing index, article routes and Codex/Grok media build safely");
