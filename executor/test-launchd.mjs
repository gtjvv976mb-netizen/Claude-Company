/** Behavioral and static checks for the macOS WALL-ST-E LaunchAgent lifecycle. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const executorDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(executorDir, "launchd-runner.mjs");
const controller = path.join(executorDir, "macos-launchagent.sh");
const releaseController = path.join(executorDir, "macos-release.sh");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-launchd-test-"));
const runtimeDir = path.join(sandbox, "executor & stable");
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const poller = path.join(runtimeDir, "poller.mjs");
const envFile = path.join(runtimeDir, ".cc-executor.env");
const stateDb = path.join(runtimeDir, ".cc-executor.sqlite");
const lockFile = `${stateDb}.lock`;
const outputFile = path.join(runtimeDir, "literal-output.txt");
const marker = path.join(sandbox, "must-not-exist");
const runtimeFiles = [
  "journal.mjs", "jupiter.mjs", "balance-verification.mjs", "entry-quote-guard.mjs",
  "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs", "heartbeat-health.mjs",
  "sleep-assertion.mjs", "strategy.mjs",
  "trade-policy.mjs", "package.json", "package-lock.json",
];
let failures = 0;

function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}

function invoke(args, options = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: runtimeDir,
    encoding: "utf8",
    ...options,
  });
}

function quoteEnvironmentValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    .replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function writeEnvironment(lines, mode = 0o600) {
  fs.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode });
  fs.chmodSync(envFile, mode);
}

fs.writeFileSync(poller, `import fs from "node:fs";
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
  secret: process.env.CC_SECRET,
  inheritedExecute: process.env.EXECUTE ?? null,
  inheritedProxy: process.env.HTTPS_PROXY ?? null,
  supervisor: process.env["WALLSTE_SUPERVISOR"] ?? null,
  serviceLabel: process.env["WALLSTE_SERVICE_LABEL"] ?? null,
}), { mode: 0o600 });
`, { mode: 0o600 });
for (const file of runtimeFiles) {
  const source = file.endsWith(".json") ? "{}\n" : file === "sleep-assertion.mjs"
    ? `export async function startMacSleepAssertion() { return { assertionPid: 1 }; }
export function verifyMacSleepAssertion() { return { ok: true }; }
export function batteryPowerIsOperational() { return false; }
export function inspectOwnerControlFile() { return { present: false, valid: true }; }
export function sleepAssertionFaultPath(lockFile) { return lockFile + ".sleep-assertion-fault"; }
`
    : "export {};\n";
  fs.writeFileSync(path.join(runtimeDir, file), source, { mode: 0o600 });
}

try {
  const payload = `literal $(touch ${marker}); ampersand & backtick \`touch ${marker}\`; quote " and slash \\`;
  writeEnvironment([
    `CC_SECRET=${quoteEnvironmentValue(payload)}`,
    `STATE_FILE=${quoteEnvironmentValue(outputFile)}`,
    `STATE_DB=${quoteEnvironmentValue(stateDb)}`,
    `LOCK_FILE=${quoteEnvironmentValue(lockFile)}`,
  ]);

  const validated = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("owner-only environment and regular runtime validate", validated.status === 0,
    validated.stderr.trim());
  check("validation never prints a secret value",
    !`${validated.stdout}${validated.stderr}`.includes(payload));

  const executed = invoke(["run", "--env", envFile, "--poller", poller,
    "--label", "com.claudeco.wallste"], {
    env: { ...process.env, EXECUTE: "1", HTTPS_PROXY: "https://attacker.invalid",
      WALLSTE_SUPERVISOR: "untrusted", WALLSTE_SERVICE_LABEL: "untrusted" },
  });
  check("runner imports the poller without a shell", executed.status === 0, executed.stderr.trim());
  const observedEnvironment = fs.existsSync(outputFile)
    ? JSON.parse(fs.readFileSync(outputFile, "utf8")) : {};
  check("quoted environment syntax round-trips literally",
    observedEnvironment.secret === payload);
  check("inherited executor and proxy settings are cleared before poller import",
    observedEnvironment.inheritedExecute === null && observedEnvironment.inheritedProxy === null);
  check("reserved supervisor identity is injected by the runner, never inherited",
    observedEnvironment.supervisor === "launchd" &&
    observedEnvironment.serviceLabel === "com.claudeco.wallste");
  check("shell metacharacters in a secret are never evaluated", !fs.existsSync(marker));
  check("runtime output does not disclose the protected value",
    !`${executed.stdout}${executed.stderr}`.includes(payload));

  const rendered = invoke(["render-plist",
    "--label", "com.claudeco.wallste",
    "--node", process.execPath,
    "--runner", runner,
    "--poller", poller,
    "--env", envFile,
    "--workdir", runtimeDir,
    "--stdout", path.join(runtimeDir, "stdout.log"),
    "--stderr", path.join(runtimeDir, "stderr.log"),
    "--throttle", "15",
  ]);
  const plist = rendered.stdout;
  check("plist renderer succeeds for canonical absolute paths", rendered.status === 0,
    rendered.stderr.trim());
  check("plist XML escapes path metacharacters", plist.includes("executor &amp; stable") &&
    !plist.includes("executor & stable"));
  check("LaunchAgent uses a stable working directory and durable log paths",
    plist.includes("<key>WorkingDirectory</key>") &&
    plist.includes("<key>StandardOutPath</key>") &&
    plist.includes("<key>StandardErrorPath</key>"));
  check("LaunchAgent starts on load and restarts with bounded backoff",
    plist.includes("<key>RunAtLoad</key><true/>") &&
    plist.includes("<key>KeepAlive</key><true/>") &&
    plist.includes("<key>ThrottleInterval</key><integer>15</integer>"));
  check("plist contains only an environment-file path, never its values",
    !plist.includes(payload) && !plist.includes("CC_SECRET"));
  check("plist clears pre-start Node, TLS, proxy, and dynamic-loader injection",
    ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "HTTPS_PROXY",
      "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "OPENSSL_CONF"].every((name) =>
      plist.includes(`<key>${name}</key><string></string>`)));

  const writableSibling = path.join(runtimeDir, "journal.mjs");
  fs.chmodSync(writableSibling, 0o664);
  const writableGraph = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("a group-writable imported runtime sibling is rejected", writableGraph.status !== 0 &&
    writableGraph.stderr.includes("runtime file journal.mjs must not be writable"));
  fs.chmodSync(writableSibling, 0o600);

  const linkedSibling = path.join(runtimeDir, "entry-quote-guard.mjs");
  fs.unlinkSync(linkedSibling);
  fs.symlinkSync(path.join(runtimeDir, "exit-trigger.mjs"), linkedSibling);
  const linkedGraph = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("a symlinked imported runtime sibling is rejected", linkedGraph.status !== 0 &&
    linkedGraph.stderr.includes("runtime file entry-quote-guard.mjs must be a regular non-symlink"));
  fs.unlinkSync(linkedSibling);
  fs.writeFileSync(linkedSibling, "export {};\n", { mode: 0o600 });

  writeEnvironment(["CC_SECRET=too-open"], 0o644);
  const openMode = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("group-readable environment is rejected", openMode.status !== 0 &&
    openMode.stderr.includes("chmod 600"));

  const realEnv = path.join(runtimeDir, "real.env");
  fs.writeFileSync(realEnv, "CC_SECRET=literal\n", { mode: 0o600 });
  fs.rmSync(envFile, { force: true });
  fs.symlinkSync(realEnv, envFile);
  const symlinked = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("symlinked environment is rejected", symlinked.status !== 0 &&
    symlinked.stderr.includes("non-symlink"));
  fs.unlinkSync(envFile);

  writeEnvironment(["CC_SECRET=one", "CC_SECRET=two"]);
  const duplicate = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("duplicate environment names fail closed", duplicate.status !== 0 &&
    duplicate.stderr.includes("duplicates CC_SECRET"));

  writeEnvironment(["NODE_OPTIONS=--import=/tmp/not-allowed.mjs"]);
  const nodeInjection = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("Node preload variables are rejected", nodeInjection.status !== 0 &&
    nodeInjection.stderr.includes("NODE_OPTIONS is not allowed"));

  writeEnvironment(["HTTPS_PROXY=https://attacker.invalid"]);
  const proxyInjection = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("proxy injection variables are rejected", proxyInjection.status !== 0 &&
    proxyInjection.stderr.includes("HTTPS_PROXY is not allowed"));

  writeEnvironment(["NODE_TLS_REJECT_UNAUTHORIZED=0"]);
  const tlsInjection = invoke(["validate", "--env", envFile, "--poller", poller]);
  check("TLS bypass variables are rejected", tlsInjection.status !== 0 &&
    tlsInjection.stderr.includes("NODE_TLS_REJECT_UNAUTHORIZED is not allowed"));

  for (const reservedName of ["WALLSTE_SUPERVISOR", "WALLSTE_SERVICE_LABEL"]) {
    writeEnvironment([`${reservedName}=untrusted`]);
    const reservedInjection = invoke(["validate", "--env", envFile, "--poller", poller]);
    check(`${reservedName} cannot be persisted in the protected environment`,
      reservedInjection.status !== 0 &&
      reservedInjection.stderr.includes(`${reservedName} is not allowed`));
  }

  const alternateLock = path.join(runtimeDir, ".alternate.lock");
  writeEnvironment([`STATE_DB=${stateDb}`, `LOCK_FILE=${alternateLock}`, "CC_SECRET=redacted"]);
  const noncanonical = invoke(["preflight", "--env", envFile, "--poller", poller]);
  check("a noncanonical lock path cannot split one state database across two pollers",
    noncanonical.status !== 0 && noncanonical.stderr.includes("canonical STATE_DB lock"));

  writeEnvironment([`STATE_DB=${stateDb}`, `LOCK_FILE=${lockFile}`, "CC_SECRET=redacted"]);
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(lockFile, `${holder.pid}\n`, { mode: 0o600 });
  const blocked = invoke(["preflight", "--env", envFile, "--poller", poller]);
  let holderAlive = true;
  try { process.kill(holder.pid, 0); } catch { holderAlive = false; }
  check("an active unsupervised lock refuses LaunchAgent handover", blocked.status === 3 &&
    blocked.stderr.includes(`active executor (pid ${holder.pid})`));
  check("conflict detection leaves the existing poller process alive", holderAlive);
  const ready = invoke(["ready", "--env", envFile, "--poller", poller,
    "--pid", String(holder.pid)]);
  check("post-start readiness binds the service pid to the canonical lock",
    ready.status === 0, ready.stderr.trim());
  if (process.platform === "darwin") {
    fs.writeFileSync(path.join(runtimeDir, "sleep-assertion.mjs"), `import fs from "node:fs";
export async function startMacSleepAssertion() { return { assertionPid: 1 }; }
export function verifyMacSleepAssertion() { return { ok: false, commandBound: true,
  powerSource: "battery", idleSystemSleep: true, reason: "host is drawing battery power" }; }
export function batteryPowerIsOperational(value) { return value.commandBound === true &&
  value.powerSource === "battery" && value.idleSystemSleep === true; }
export function inspectOwnerControlFile(file) { return { present: fs.existsSync(file),
  valid: fs.existsSync(file) }; }
export function sleepAssertionFaultPath(lockFile) { return lockFile + ".sleep-assertion-fault"; }
`, { mode: 0o600 });
    const defaultPauseFile = `${stateDb}.pause-entries`;
    fs.writeFileSync(defaultPauseFile, "battery pause\n", { mode: 0o600 });
    const batteryReady = invoke(["ready", "--env", envFile, "--poller", poller,
      "--pid", String(holder.pid)]);
    check("battery startup is operational only with a durable entry pause",
      batteryReady.status === 0 && batteryReady.stdout.includes("operational on battery"),
      batteryReady.stderr.trim());
    const faultFile = `${lockFile}.sleep-assertion-fault`;
    fs.writeFileSync(faultFile, "synthetic automatic-pause failure\n", { mode: 0o600 });
    const faultLatched = invoke(["ready", "--env", envFile, "--poller", poller,
      "--pid", String(holder.pid)]);
    check("readiness refuses a durable sleep-assertion fault until explicit review",
      faultLatched.status === 6 && faultLatched.stderr.includes("fault is latched"),
      faultLatched.stderr.trim());
    fs.unlinkSync(faultFile);
    fs.unlinkSync(defaultPauseFile);
    const unpausedBattery = invoke(["ready", "--env", envFile, "--poller", poller,
      "--pid", String(holder.pid)]);
    check("battery startup without a validated pause cannot report readiness",
      unpausedBattery.status === 5 && unpausedBattery.stderr.includes("not ready"),
      unpausedBattery.stderr.trim());
  }
  const wrongReady = invoke(["ready", "--env", envFile, "--poller", poller,
    "--pid", String(process.pid)]);
  check("readiness rejects a registered pid that does not own the lock",
    wrongReady.status === 4 && wrongReady.stderr.includes("does not own"));
  holder.kill("SIGTERM");
  await new Promise((resolve) => holder.once("exit", resolve));

  fs.writeFileSync(lockFile, "999999999\n", { mode: 0o600 });
  const stale = invoke(["preflight", "--env", envFile, "--poller", poller]);
  check("a provably stale lock is left for poller recovery", stale.status === 0,
    stale.stderr.trim());
  check("preflight does not delete or rewrite the stale lock",
    fs.readFileSync(lockFile, "utf8") === "999999999\n");

  const releaseCommit = "a".repeat(40);
  const keypairFile = path.join(runtimeDir, "burner.json");
  const oldLockFile = path.join(runtimeDir, ".cc-executor.lock");
  const pauseFile = path.join(runtimeDir, "PAUSE_ENTRIES");
  const hardStopFile = path.join(runtimeDir, "HARD_STOP");
  const legacyStateFile = path.join(runtimeDir, ".cc-state.json");
  fs.writeFileSync(keypairFile, "[1]\n", { mode: 0o600 });
  fs.writeFileSync(stateDb, "sqlite-placeholder\n", { mode: 0o600 });
  fs.writeFileSync(hardStopFile, "keep-hard-stop\n", { mode: 0o600 });
  fs.writeFileSync(legacyStateFile, "{}\n", { mode: 0o600 });
  const liveEnvironmentLines = [
    `CC_SECRET=${quoteEnvironmentValue(payload)}`,
    "CC_FLOOR=50",
    "EXECUTE=1",
    "LIVE_TRADING_ACK=wallet-public-key",
    "JUPITER_API_KEY=private-jupiter-key",
    "SOLANA_RPC=https://primary.invalid/key",
    "SOLANA_RPC_SECONDARY=https://secondary.invalid/key",
    "MAX_SOL_PER_TRADE=0.05",
    "DAILY_SOL_CAP=0.5",
    "DAILY_LOSS_LIMIT_SOL=0.15",
    "KEYPAIR=burner.json",
    "STATE_DB=.cc-executor.sqlite",
    "LOCK_FILE=.cc-executor.lock",
    "PAUSE_ENTRIES_FILE=PAUSE_ENTRIES",
    "HARD_STOP_FILE=HARD_STOP",
    "STATE_FILE=.cc-state.json",
  ];
  writeEnvironment(liveEnvironmentLines);
  const originalEnvironment = fs.readFileSync(envFile, "utf8");
  const upgradeArgs = ["--env", envFile, "--legacy-workdir", runtimeDir,
    "--commit", releaseCommit];
  const upgradeCheck = invoke(["validate-upgrade-env", ...upgradeArgs]);
  check("versioned adoption validates relative paths against one explicit old working directory",
    upgradeCheck.status === 0 && fs.readFileSync(envFile, "utf8") === originalEnvironment,
    upgradeCheck.stderr.trim());
  check("upgrade preview distinguishes lowered caps from newly applied defaults",
    upgradeCheck.stdout.includes("will lower values above reviewed ceilings: " +
      "MAX_SOL_PER_TRADE,DAILY_SOL_CAP,DAILY_LOSS_LIMIT_SOL") &&
    upgradeCheck.stdout.includes("will apply reviewed defaults to missing values: MAX_RENT_LAMPORTS") &&
    !upgradeCheck.stdout.includes("lower canary caps"));
  check("upgrade validation prints control paths but never a secret",
    upgradeCheck.stdout.includes(pauseFile) &&
    !`${upgradeCheck.stdout}${upgradeCheck.stderr}`.includes(payload));

  const missingPauseBackup = `${envFile}.previous-missing-pause`;
  const missingPause = invoke(["update-upgrade-env", ...upgradeArgs,
    "--backup", missingPauseBackup]);
  check("release install cannot rewrite provenance until the existing entry pause is present",
    missingPause.status !== 0 && missingPause.stderr.includes("entry-pause sentinel") &&
    fs.readFileSync(envFile, "utf8") === originalEnvironment && !fs.existsSync(missingPauseBackup));

  fs.writeFileSync(pauseFile, "keep-entry-pause\n", { mode: 0o600 });
  const oldHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(oldLockFile, `${oldHolder.pid}\n`, { mode: 0o600 });
  const activeBackup = `${envFile}.previous-active-owner`;
  const activeUpgrade = invoke(["update-upgrade-env", ...upgradeArgs,
    "--backup", activeBackup]);
  let oldHolderAlive = true;
  try { process.kill(oldHolder.pid, 0); } catch { oldHolderAlive = false; }
  check("versioned adoption refuses an active legacy noncanonical lock without killing it",
    activeUpgrade.status === 3 && activeUpgrade.stderr.includes(`pid ${oldHolder.pid}`) &&
    oldHolderAlive && fs.readFileSync(envFile, "utf8") === originalEnvironment &&
    !fs.existsSync(activeBackup));
  oldHolder.kill("SIGTERM");
  await new Promise((resolve) => oldHolder.once("exit", resolve));

  const environmentBackup = `${envFile}.previous-${releaseCommit.slice(0, 12)}-test`;
  const upgraded = invoke(["update-upgrade-env", ...upgradeArgs,
    "--backup", environmentBackup]);
  const upgradedText = fs.readFileSync(envFile, "utf8");
  check("environment upgrade atomically binds exact source provenance and canonical data paths",
    upgraded.status === 0 &&
    upgradedText.includes(`EXECUTOR_SOURCE_COMMIT="${releaseCommit}"`) &&
    upgradedText.includes(`KEYPAIR=${quoteEnvironmentValue(keypairFile)}`) &&
    upgradedText.includes(`STATE_DB=${quoteEnvironmentValue(stateDb)}`) &&
    upgradedText.includes(`LOCK_FILE=${quoteEnvironmentValue(lockFile)}`) &&
    upgradedText.includes(`PAUSE_ENTRIES_FILE=${quoteEnvironmentValue(pauseFile)}`) &&
    upgradedText.includes(`HARD_STOP_FILE=${quoteEnvironmentValue(hardStopFile)}`),
    upgraded.stderr.trim());
  check("secret bytes survive while exposure caps lower and missing rent adopts its reviewed default",
    upgradedText.includes(`CC_SECRET=${quoteEnvironmentValue(payload)}`) &&
    upgradedText.includes('MAX_SOL_PER_TRADE="0.005"\n') &&
    upgradedText.includes('DAILY_SOL_CAP="0.01"\n') &&
    upgradedText.includes('DAILY_LOSS_LIMIT_SOL="0.01"\n') &&
    upgradedText.includes('MAX_RENT_LAMPORTS="4200000"\n') &&
    !`${upgraded.stdout}${upgraded.stderr}`.includes(payload));
  check("pause, hard stop, wallet, journal and owner-only recovery environment are preserved",
    fs.readFileSync(pauseFile, "utf8") === "keep-entry-pause\n" &&
    fs.readFileSync(hardStopFile, "utf8") === "keep-hard-stop\n" &&
    fs.readFileSync(keypairFile, "utf8") === "[1]\n" &&
    fs.readFileSync(stateDb, "utf8") === "sqlite-placeholder\n" &&
    fs.readFileSync(environmentBackup, "utf8") === originalEnvironment &&
    (fs.statSync(environmentBackup).mode & 0o077) === 0);

  const restored = invoke(["restore-upgrade-env", "--env", envFile,
    "--backup", environmentBackup, "--commit", releaseCommit]);
  check("failed plist adoption can atomically restore the exact prior environment",
    restored.status === 0 && fs.readFileSync(envFile, "utf8") === originalEnvironment &&
    !fs.existsSync(environmentBackup), restored.stderr.trim());

  writeEnvironment([...liveEnvironmentLines.map((line) =>
    line.startsWith("MAX_SOL_PER_TRADE=") ? "MAX_SOL_PER_TRADE=0.001"
      : line.startsWith("DAILY_SOL_CAP=") ? "DAILY_SOL_CAP=0.005"
        : line.startsWith("DAILY_LOSS_LIMIT_SOL=") ? "DAILY_LOSS_LIMIT_SOL=0.004" : line),
    "MAX_RENT_LAMPORTS=3000000"]);
  const lowerCapsText = fs.readFileSync(envFile, "utf8");
  const lowerBackup = `${envFile}.previous-lower-caps`;
  const lowerUpgrade = invoke(["update-upgrade-env", ...upgradeArgs, "--backup", lowerBackup]);
  const lowerUpgradedText = fs.readFileSync(envFile, "utf8");
  check("versioned adoption never raises an already lower operator cap",
    lowerUpgrade.status === 0 &&
    lowerUpgradedText.includes("MAX_SOL_PER_TRADE=0.001\n") &&
    lowerUpgradedText.includes("DAILY_SOL_CAP=0.005\n") &&
    lowerUpgradedText.includes("DAILY_LOSS_LIMIT_SOL=0.004\n") &&
    lowerUpgradedText.includes("MAX_RENT_LAMPORTS=3000000\n"));
  const lowerRestore = invoke(["restore-upgrade-env", "--env", envFile,
    "--backup", lowerBackup, "--commit", releaseCommit]);
  check("lower-cap migration retains an exact owner-only rollback copy",
    lowerRestore.status === 0 && fs.readFileSync(envFile, "utf8") === lowerCapsText);

  writeEnvironment([...liveEnvironmentLines, "MAX_RENT_LAMPORTS=5000000"]);
  const highRentText = fs.readFileSync(envFile, "utf8");
  const highRentBackup = `${envFile}.previous-high-rent`;
  const highRentUpgrade = invoke(["update-upgrade-env", ...upgradeArgs,
    "--backup", highRentBackup]);
  check("versioned adoption lowers gross rent above the reviewed compatibility ceiling",
    highRentUpgrade.status === 0 &&
    fs.readFileSync(envFile, "utf8").includes('MAX_RENT_LAMPORTS="4200000"\n'));
  const highRentRestore = invoke(["restore-upgrade-env", "--env", envFile,
    "--backup", highRentBackup, "--commit", releaseCommit]);
  check("gross-rent migration retains an exact owner-only rollback copy",
    highRentRestore.status === 0 && fs.readFileSync(envFile, "utf8") === highRentText);

  writeEnvironment(liveEnvironmentLines.map((line) =>
    line.startsWith("MAX_SOL_PER_TRADE=") ? "MAX_SOL_PER_TRADE=0"
      : line.startsWith("DAILY_SOL_CAP=") ? "DAILY_SOL_CAP=0"
        : line.startsWith("DAILY_LOSS_LIMIT_SOL=") ? "DAILY_LOSS_LIMIT_SOL=0" : line));
  const zeroBackup = `${envFile}.previous-zero-caps`;
  const zeroUpgrade = invoke(["update-upgrade-env", ...upgradeArgs, "--backup", zeroBackup]);
  const zeroUpgradedText = fs.readFileSync(envFile, "utf8");
  check("versioned adoption preserves explicit zero caps instead of raising them",
    zeroUpgrade.status === 0 && zeroUpgradedText.includes("MAX_SOL_PER_TRADE=0\n") &&
    zeroUpgradedText.includes("DAILY_SOL_CAP=0\n") &&
    zeroUpgradedText.includes("DAILY_LOSS_LIMIT_SOL=0\n"));
  invoke(["restore-upgrade-env", "--env", envFile,
    "--backup", zeroBackup, "--commit", releaseCommit]);

  writeEnvironment(liveEnvironmentLines.map((line) =>
    line.startsWith("KEYPAIR=") ? "KEYPAIR=../outside-burner.json" : line));
  const escapedRelative = invoke(["validate-upgrade-env", ...upgradeArgs]);
  check("versioned adoption refuses a relative wallet path that escapes the old working directory",
    escapedRelative.status !== 0 && escapedRelative.stderr.includes("KEYPAIR relative path escapes"));

  const shell = fs.readFileSync(controller, "utf8");
  const releaseShell = fs.readFileSync(releaseController, "utf8");
  const runnerSource = fs.readFileSync(runner, "utf8");
  const pollerSource = fs.readFileSync(path.join(executorDir, "poller.mjs"), "utf8");
  const jupiterSource = fs.readFileSync(path.join(executorDir, "jupiter.mjs"), "utf8");
  const sleepAssertionSource = fs.readFileSync(path.join(executorDir, "sleep-assertion.mjs"), "utf8");
  const buildSource = fs.readFileSync(path.join(executorDir, "..", "scripts", "build-viewer.mjs"), "utf8");
  const pagesWorkflow = fs.readFileSync(path.join(executorDir, "..", ".github", "workflows", "pages.yml"), "utf8");
  const viewerSource = fs.readFileSync(path.join(executorDir, "..", "viewer", "office3d.html"), "utf8");
  const productionRuntime = ["poller.mjs", ...runtimeFiles];
  const referencedEnvironment = new Set();
  for (const file of productionRuntime.filter((name) => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(executorDir, file), "utf8");
    for (const match of source.matchAll(
      /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[["']([A-Z_][A-Z0-9_]*)["']\])/g))
      referencedEnvironment.add(match[1] || match[2]);
  }
  const allowlistSource = runnerSource.slice(runnerSource.indexOf("const ALLOWED_ENV"),
    runnerSource.indexOf("const SAFE_INHERITED_ENV"));
  const internalEnvironment = new Set(["WALLSTE_SUPERVISOR", "WALLSTE_SERVICE_LABEL"]);
  check("the exact environment allowlist covers every current runtime setting",
    [...referencedEnvironment].every((name) => internalEnvironment.has(name) ||
      allowlistSource.includes(`"${name}"`)),
    [...referencedEnvironment].filter((name) => !internalEnvironment.has(name) &&
      !allowlistSource.includes(`"${name}"`)).join(", "));
  check("supervisor identity remains runner-owned and outside the file allowlist",
    !allowlistSource.includes('"WALLSTE_SUPERVISOR"') &&
    !allowlistSource.includes('"WALLSTE_SERVICE_LABEL"') &&
    runnerSource.includes('process.env.WALLSTE_SUPERVISOR = "launchd"') &&
    runnerSource.includes("process.env.WALLSTE_SERVICE_LABEL = options"));
  check("the validator names every imported signing/runtime artifact",
    productionRuntime.every((name) => runnerSource.includes(`"${name}"`)));
  check("published executor instructions pin the exact CI build commit, never a stale fallback",
    !buildSource.includes("04f728808713f7856290265bb00120f7aa88e8a4") &&
    buildSource.includes("EXECUTOR_COMMIT (or CI GITHUB_SHA)") &&
    buildSource.includes("LOCAL_PREVIEW_NOT_INSTALLABLE") &&
    pagesWorkflow.includes('EXECUTOR_COMMIT="${{ github.sha }}"') &&
    viewerSource.includes("gtjvv976mb-netizen/Claude-Company.git") &&
    !viewerSource.includes("claude-company-executor.git") &&
    viewerSource.includes("hasPinnedExecutorRelease"));
  check("launchctl policy parsing supports current macOS words and confirms enable",
    shell.includes('=> disabled') && shell.includes('=> enabled') &&
    shell.includes("is_enabled()") && shell.includes("if ! is_enabled"));
  const installCase = shell.slice(shell.indexOf("  install)"), shell.indexOf("  load)"));
  const loadCase = shell.slice(shell.indexOf("  load)"), shell.indexOf("  unload)"));
  const unloadCase = shell.slice(shell.indexOf("  unload)"), shell.indexOf("  status)"));
  const uninstallCase = shell.slice(shell.indexOf("  uninstall)"));
  const rollbackStart = shell.indexOf("rollback_load()");
  const rollbackLoad = shell.slice(rollbackStart, shell.indexOf('case "$COMMAND"', rollbackStart));
  const enableConfirmation = loadCase.slice(
    loadCase.indexOf("launchctl enable"), loadCase.indexOf("launchctl bootstrap"));
  check("install and load are separate explicit operations",
    !installCase.includes("launchctl bootstrap") && loadCase.includes("launchctl bootstrap"));
  check("install persistently disables before publishing the login-discovered plist",
    installCase.indexOf("launchctl disable") >= 0 &&
    installCase.indexOf("launchctl disable") < installCase.indexOf('mv -f "$PLIST_NEXT"') &&
    installCase.includes("if ! is_disabled"));
  check("load enables only after preflight and disables again on startup failure",
    loadCase.indexOf("preflight") < loadCase.indexOf("launchctl enable") &&
    loadCase.indexOf("launchctl enable") < loadCase.indexOf("launchctl bootstrap") &&
    enableConfirmation.includes("if ! is_enabled") &&
    enableConfirmation.includes("if rollback_load") &&
    loadCase.includes("wait_until_ready") && loadCase.includes("rollback_load") &&
    rollbackLoad.includes("launchctl disable") && rollbackLoad.includes("launchctl bootout") &&
    rollbackLoad.includes("disable_status") && rollbackLoad.includes("is_disabled") &&
    rollbackLoad.includes("! is_loaded"));
  check("bootout is limited to explicit unload or failed-load rollback",
    unloadCase.includes("launchctl bootout") && !installCase.includes("launchctl bootout") &&
    loadCase.includes("rollback_load") && rollbackLoad.includes("launchctl bootout"));
  check("unload persistently disables before stopping the current service",
    unloadCase.indexOf("launchctl disable") >= 0 &&
    unloadCase.indexOf("launchctl disable") < unloadCase.indexOf("launchctl bootout") &&
    unloadCase.includes("if ! is_disabled"));
  check("load checks the process lock before bootstrap",
    loadCase.indexOf("preflight") >= 0 &&
    loadCase.indexOf("preflight") < loadCase.indexOf("launchctl bootstrap"));
  check("uninstall refuses a loaded service and removes only the exact plist",
    uninstallCase.includes("if is_loaded") && uninstallCase.includes("if ! is_disabled") &&
    uninstallCase.includes('unlink "$PLIST_FILE"'));
  check("controller never sources or evaluates the environment",
    !/(^|\n)\s*(?:source|\.)\s+/m.test(shell) && !/(^|[;\s])eval(?:[;\s]|$)/m.test(shell));
  check("controller contains no wallet funding, cap mutation, signing, or sentinel deletion",
    !/requestAirdrop|solana\s+transfer|MAX_SOL_PER_TRADE=|DAILY_SOL_CAP=|EXECUTE=1/.test(shell) &&
    !/(?:rm|unlink)[^\n]*(?:PAUSE|HARD_STOP|pause-entries|hard-stop)/.test(shell));
  check("runner loads protected values in-process without child shell APIs",
    !/child_process|execSync|spawnSync|\beval\s*\(/.test(runnerSource));
  check("the lock-owning Node runner holds and monitors a direct AC sleep assertion",
    runnerSource.includes("startMacSleepAssertion") &&
    runnerSource.includes("verifyMacSleepAssertion") &&
    sleepAssertionSource.includes('["-i", "-s", "-w", String(ownerPid)]') &&
    sleepAssertionSource.includes('["-g", "assertions"]') &&
    sleepAssertionSource.includes('["-g", "batt"]') &&
    sleepAssertionSource.includes("setInterval") &&
    !sleepAssertionSource.includes('["sleep"') &&
    !sleepAssertionSource.includes('["displaysleep"') &&
    !sleepAssertionSource.includes('["hibernatemode"'));
  check("battery degradation pauses entries while preserving the exact idle-bound runner",
    runnerSource.includes("pauseEntriesFile: resolvePauseEntries") &&
    runnerSource.includes("batteryPowerIsOperational") &&
    sleepAssertionSource.includes("ensureEntryPauseFile(pauseEntriesFile") &&
    sleepAssertionSource.includes("batteryPowerIsOperational(current)") &&
    sleepAssertionSource.includes("entry pause remains until explicit readiness review") &&
    !/(?:unlinkSync|rmSync)\(pauseEntriesFile/.test(sleepAssertionSource));
  check("a failed automatic pause remains latched across launchd restarts",
    sleepAssertionSource.includes("sleepAssertionFaultPath") &&
    sleepAssertionSource.includes("ensureSleepAssertionFault") &&
    sleepAssertionSource.includes("explicit operator repair and review") &&
    pollerSource.includes("SLEEP_ASSERTION_FAULT_FILE") &&
    runnerSource.includes("sleep assertion fault is latched") &&
    !/(?:unlinkSync|rmSync)\([^\n]*sleepAssertionFault/.test(sleepAssertionSource));
  check("the launchd entry gate re-proves strict AC power before signing or disclosure",
    pollerSource.includes('process.env["WALLSTE_SUPERVISOR"] === "launchd"') &&
    pollerSource.includes("requireMacEntryPower({ ownerPid: process.pid") &&
    pollerSource.includes("assertEntriesUnpaused();") &&
    [...jupiterSource.matchAll(/this\.submissionGate\(intent\)/g)].length >= 3);
  check("versioned release stages a clean exact commit before one atomic publication",
    releaseShell.includes("verify_git_release") &&
    releaseShell.includes("git") && releaseShell.includes("cat-file") &&
    releaseShell.includes("hash-object --no-filters") &&
    ["test-install.mjs", "test-launchd.mjs", "test-sleep-assertion.mjs", "test-monitor.mjs",
      "test-heartbeat-health.mjs", "test-live-gates.mjs", "test-journal.mjs",
      "test-live-execution.mjs"].every((name) => releaseShell.includes(name)) &&
    releaseShell.includes('mv "$STAGED_REPO" "$FINAL_RELEASE"') &&
    releaseShell.indexOf("npm ci") < releaseShell.indexOf('mv "$STAGED_REPO" "$FINAL_RELEASE"'));
  check("versioned adoption requires an explicit environment and never controls the live process",
    releaseShell.includes('if [ -z "$ENV_FILE" ]') &&
    releaseShell.includes("--env-file is required") &&
    releaseShell.includes('launchctl print "$SERVICE_TARGET"') &&
    !/launchctl\s+(?:bootout|bootstrap|kickstart)|\bkill\b/.test(releaseShell));
  check("release tooling never sources secrets, changes caps, signs, funds, or removes controls",
    !/(^|\n)\s*(?:source|\.)\s+/m.test(releaseShell) &&
    !/(^|[;\s])eval(?:[;\s]|$)/m.test(releaseShell) &&
    !/requestAirdrop|solana\s+transfer|EXECUTE=1|MAX_SOL_PER_TRADE=|DAILY_SOL_CAP=/.test(releaseShell) &&
    !/(?:rm|unlink)[^\n]*(?:PAUSE|HARD_STOP|pause-entries|hard-stop)/.test(releaseShell));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} LaunchAgent checks failed.` :
  "\nmacOS LaunchAgent lifecycle is explicit, supervised, and fail-closed.");
process.exit(failures ? 1 : 0);
