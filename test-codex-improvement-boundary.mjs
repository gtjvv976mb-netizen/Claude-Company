import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const worker = fs.readFileSync("services/codex-improvement/run.mjs", "utf8");
const checkoutGuard = fs.readFileSync("services/codex-improvement/checkout.mjs", "utf8");
const office = fs.readFileSync("src/office.js", "utf8");
const render = fs.readFileSync("render.yaml", "utf8");
const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
const workflow = fs.readFileSync(".github/workflows/codex-improvement.yml", "utf8");
const pagesWorkflow = fs.readFileSync(".github/workflows/pages.yml", "utf8");
const charter = fs.readFileSync("DESK.md", "utf8");

console.log("\nCODEX IS OUTSIDE THE TRADING AND DEPLOYMENT PROCESS");
ok("production package does not ship the Codex SDK", !rootPackage.dependencies?.["@openai/codex-sdk"]);
ok("Render does not start or receive credentials for Codex",
  !/@openai\/codex|OPENAI_API_KEY|improvement:codex/.test(render));
ok("worker is read-only, never approves, and has no agent network",
  /sandboxMode:\s*"read-only"/.test(worker) && /approvalPolicy:\s*"never"/.test(worker) &&
  /networkAccessEnabled:\s*false/.test(worker) && /webSearchMode:\s*"disabled"/.test(worker));
ok("worker uses an isolated home, no inherited shell secrets, and a deny-root read profile",
  /mkdtemp/.test(worker) && /CODEX_HOME: isolation\.codexHome/.test(worker) &&
  /inherit:\s*"none"/.test(worker) && /ignore_default_excludes:\s*false/.test(worker) &&
  /":root"="deny"/.test(worker) && !/ANTHROPIC_API_KEY|XAI_API_KEY|SOLANA_RPC|CLAUDE_CO_DB/.test(worker));
ok("unsupported hosts are rejected before credentials or live bundle reads",
  worker.indexOf("assertCiEnvironment();") < worker.indexOf("const apiKey = process.env.OPENAI_API_KEY") &&
  worker.indexOf("assertCiEnvironment();") < worker.indexOf("const bundle = await readBundle(options)"));
ok("worker proves the repository HEAD equals the workflow commit before Codex starts",
  /await assertExactGitHead\(ROOT, githubSha\)/.test(worker) &&
  worker.indexOf("await assertExactGitHead(ROOT, githubSha)") < worker.indexOf("const codex = new Codex") &&
  /const TRUSTED_GIT = "\/usr\/bin\/git"/.test(checkoutGuard) &&
  /execFileAsync\(TRUSTED_GIT/.test(checkoutGuard));
ok("ambient apps, plugins, hooks, skills, and extra agent surfaces are disabled",
  /apps:\s*false/.test(worker) && /plugins:\s*false/.test(worker) &&
  /hooks:\s*false/.test(worker) && /skill_search:\s*false/.test(worker) &&
  /multi_agent:\s*false/.test(worker) && /browser_use:\s*false/.test(worker));
ok("Office exposes review reads but no run/apply/patch/deploy route",
  office.includes("/api/improvements/review-bundle") && office.includes("/api/improvements/status") &&
  !/\/api\/improvements\/(?:run|apply|patch|deploy)/.test(office));
ok("full bundle uses a dedicated constant-time bearer boundary",
  /CODEX_REVIEW_TOKEN/.test(office) && /cryptoTimingEqual\(supplied, expected\)/.test(office) &&
  /authorization: `Bearer \$\{token\}`/.test(worker));
ok("GitHub review has read-only repository permission and manual trigger only",
  /workflow_dispatch:/.test(workflow) && /permissions:\s*\n\s*contents:\s*read/.test(workflow) &&
  /persist-credentials:\s*false/.test(workflow) &&
  !/schedule:|pull-requests:\s*write|contents:\s*write/.test(workflow));
ok("third-party workflow code is pinned to immutable commit SHAs",
  [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].every(([, use]) =>
    /^actions\/(?:checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/.test(use)));
ok("the live Pages workflow isolates deploy authority and pins every action",
  /permissions:\s*\{\}/.test(pagesWorkflow) && /persist-credentials:\s*false/.test(pagesWorkflow) &&
  /build:[\s\S]*?permissions:\s*\n\s*contents:\s*read/.test(pagesWorkflow) &&
  /deploy:[\s\S]*?permissions:\s*\n\s*pages:\s*write\s*\n\s*id-token:\s*write/.test(pagesWorkflow) &&
  [...pagesWorkflow.matchAll(/uses:\s+([^\s#]+)/g)].every(([, use]) =>
    /^actions\/(?:checkout|setup-node|upload-pages-artifact|deploy-pages)@[0-9a-f]{40}$/.test(use)));
ok("public-repository output is encrypted and never committed or deployed",
  /codex-improvement-review\.tar\.gz\.gpg/.test(workflow) && /gpg --batch --yes --symmetric/.test(workflow) &&
  /CODEX_ARTIFACT_KEY/.test(workflow) && /Preflight review secrets/.test(workflow) &&
  /upload-artifact/.test(workflow) && !/git push|create-pull-request|deploy-pages/.test(workflow));
ok("Codex governance does not enter the trading-agent charter",
  !/Codex improvement|Codex Improvement Engineer/.test(charter));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
