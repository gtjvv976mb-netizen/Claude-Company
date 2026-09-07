/** Smoke-test the published WALL-ST-E installer and its complete module graph. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* DEFAULT TO THE REPO, NOT TO PRODUCTION — this ran the other way and deadlocked.
 *
 * The check below compares the installer's LIVE_OPERATOR_MAX_* against poller.mjs's
 * OPERATOR_MAX. That is the right invariant, but it was read from the DEPLOYED site,
 * and both .github/workflows/pages.yml and Render's buildCommand run `npm test` BEFORE
 * publishing. So raising a cap failed the suite (published installer still had the old
 * number), which failed the Pages build, which meant the site never got the new
 * installer, which meant the suite could never pass. A cap could not be changed at all.
 *
 * A pre-deploy gate must validate the artifact it is about to ship. Passing an explicit
 * URL still checks a live site — `node executor/test-install.mjs https://example.com` —
 * which is the right shape for auditing production after a deploy, not before one. */
const target = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRoot = fs.existsSync(target) ? path.resolve(target) : null;
const site = target.replace(/\/$/, "");
const need = ["poller.mjs", "journal.mjs", "jupiter.mjs", "token2022.mjs", "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs", "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "strategy.mjs", "trade-policy.mjs",
  // desk-led-v4: the desk's ruler and the mirror evaluator ship with the trading process.
  "dexscreener-consensus.mjs", "desk-mirror.mjs",
  "package.json", "package-lock.json", "install.sh", "macos-launchagent.sh", "macos-release.sh", "launchd-runner.mjs"];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-install-test-"));
const sources = new Map();
let fail = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) fail++;
};

for (const file of need) {
  let ok = false;
  let status = "missing";
  let body = "";
  if (localRoot) {
    const source = path.join(localRoot, "executor", file);
    ok = fs.existsSync(source) && fs.statSync(source).isFile();
    status = ok ? "local" : "missing";
    if (ok) body = fs.readFileSync(source, "utf8");
  } else {
    const response = await fetch(`${site}/executor/${file}`);
    ok = response.ok;
    status = String(response.status);
    if (ok) body = await response.text();
  }
  check(`${file} served (${status})`, ok);
  if (ok) {
    sources.set(file, body);
    fs.writeFileSync(path.join(temp, file), body);
  }
}

for (const [owner, source] of sources) {
  if (!owner.endsWith(".mjs")) continue;
  for (const match of source.matchAll(/from\s+"\.\/([^"]+)"/g)) {
    check(`${owner} imports ./${match[1]} and it is published`, need.includes(match[1]));
  }
}

const installer = sources.get("install.sh") || "";
check("dry run remains the default", /MODE="paper"/.test(installer) && /EXECUTE_VALUE="0"/.test(installer));
check("live mode is explicit", /--live\) MODE="live"/.test(installer) && /EXECUTE_VALUE="1"/.test(installer));
check("live acknowledgement must match the generated public key",
  /LIVE_ACK" != "\$PUBKEY/.test(installer) &&
  /write_env_line LIVE_TRADING_ACK "\$LIVE_ACK"/.test(installer));
check("raised-cap acknowledgement is freshly typed, wallet-bound, number-bound and versioned",
  installer.includes('CAPS_ACK_EXPECTED="I acknowledge WALL-ST-E caps v2 for $PUBKEY: $MAX_SOL SOL per trade, $DAILY_CAP SOL per day, $DAILY_LOSS_CAP SOL rolling realized-loss entry brake"') &&
  /IFS= read -r LIVE_CAPS_ACK < \/dev\/tty/.test(installer) &&
  /LIVE_CAPS_ACK" != "\$CAPS_ACK_EXPECTED/.test(installer) &&
  !installer.includes("I raise the live caps for") &&
  installer.indexOf('PUBKEY="$(cd "$RELEASE_DIR"') < installer.indexOf('CAPS_ACK_EXPECTED="I acknowledge WALL-ST-E caps v2'));
check("raised-cap acknowledgement is persisted only through the protected environment path",
  /write_env_line LIVE_CAPS_ACK "\$LIVE_CAPS_ACK"/.test(installer) &&
  /LIVE_CAPS_ACK="\$LIVE_CAPS_ACK" \\/.test(installer) &&
  !installer.includes("--live-caps-ack") && !installer.includes("--caps-ack"));
check("live mode requires two explicit, distinct private HTTPS RPCs",
  /--live requires --rpc-file and --secondary-rpc-file/.test(installer) &&
    /--secondary-rpc must use an independent provider hostname from --rpc/.test(installer) &&
  /public Solana RPC is not accepted for either live endpoint/.test(installer) &&
    /write_env_line SOLANA_RPC_SECONDARY/.test(installer));
check("private RPC credentials can stay in owner-only files instead of argv",
  installer.includes("--rpc-file") && installer.includes("--secondary-rpc-file") &&
  /read_private_file "primary RPC"/.test(installer) &&
  /read_private_file "secondary RPC"/.test(installer));
check("live canary defaults cover trade, deployment and realized loss",
  /LIVE_CANARY_MAX_SOL="0\.005"/.test(installer) &&
  /LIVE_CANARY_DAILY_CAP="0\.01"/.test(installer) &&
  /LIVE_CANARY_DAILY_LOSS_CAP="0\.01"/.test(installer) &&
  /write_env_line DAILY_LOSS_LIMIT_SOL "\$DAILY_LOSS_CAP"/.test(installer));
check("an optional live raise requires all three explicit numeric cap flags",
  /--daily-loss-cap\) need_value/.test(installer) &&
  /MAX_SOL_SET" -ne 1.*DAILY_CAP_SET" -ne 1.*DAILY_LOSS_CAP_SET" -ne 1/.test(installer) &&
  /raising any live cap requires --max-sol, --daily-cap, and --daily-loss-cap together/.test(installer));
/* DERIVED, NOT HARDCODED. The per-trade line pinned 0.05 and broke when the owner
   raised the ceiling to 0.1 — while the property it checks (installer agrees with the
   poller) was still true. The daily and loss lines had not been converted, and broke
   the same way on 2026-09-07 when the owner moved 0.05/0.5/0.15 to 0.4/1000/0.4 (the
   daily rail is parked far above the ~2 SOL wallet, i.e. removed, not deleted).
   ALL THREE are read from the poller now. test-operator-max-parity.mjs proves the four
   copies agree; this one only has to read the same numbers they do. */
const operatorMaxBlock = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8")
  .match(/OPERATOR_MAX = Object\.freeze\(\{([^}]*)\}\)/)[1];
const pollerMax = (field) =>
  operatorMaxBlock.match(new RegExp(`\\b${field}:\\s*([\\d.]+)`))[1];
const POLLER_MAX_SOL = pollerMax("maxSolPerTrade");
const POLLER_MAX_DAILY_CAP = pollerMax("dailySolCap");
const POLLER_MAX_DAILY_LOSS_CAP = pollerMax("dailyLossLimitSol");
const escapeDecimal = (v) => String(v).replace(".", "\\.");
/* Fixtures one step over a ceiling are built from the ceiling, in the installer's own
   declared unit (LIVE_MIN_MONEY_CAP = 0.000001 SOL), using exact integer arithmetic —
   never `Number(ceiling) + 1e-6`, whose shortest-round-trip printing is the sort of
   ruler that quietly hands the grammar check a different literal than intended. */
const microSol = (v) => {
  const [whole, frac = ""] = String(v).split(".");
  return BigInt(whole) * 1000000n + BigInt(`${frac}000000`.slice(0, 6));
};
const justOverCeiling = (ceiling) => {
  const units = microSol(ceiling) + 1n;
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, "0")}`;
};
/* Mathematically over the ceiling, but only in digits the installer must refuse to
   read: rounded to a double it lands exactly ON the boundary and would be accepted. */
const overPreciseCeiling = (ceiling) =>
  `${ceiling}${String(ceiling).includes(".") ? "" : "."}0000000000000000000000001`;
check("installer matches the poller's immutable operator maxima and daily/trade relation",
  new RegExp(`LIVE_OPERATOR_MAX_SOL="${escapeDecimal(POLLER_MAX_SOL)}"`).test(installer) &&
  new RegExp(`LIVE_OPERATOR_MAX_DAILY_CAP="${escapeDecimal(POLLER_MAX_DAILY_CAP)}"`).test(installer) &&
  new RegExp(`LIVE_OPERATOR_MAX_DAILY_LOSS_CAP="${escapeDecimal(POLLER_MAX_DAILY_LOSS_CAP)}"`).test(installer) &&
  /BEGIN \{ exit !\(m <= d\) \}/.test(installer));

const capsStart = installer.indexOf("# BEGIN LIVE_CAPS_VALIDATOR");
const capsEnd = installer.indexOf("# END LIVE_CAPS_VALIDATOR");
check("installer exposes one reviewed live-cap validator", capsStart >= 0 && capsEnd > capsStart);
if (capsStart >= 0 && capsEnd > capsStart) {
  const validator = installer.slice(capsStart, capsEnd);
  const runCaps = (overrides = {}) => spawnSync("bash", ["-c",
    `set -euo pipefail\n${validator}\nprintf '%s|%s|%s|%s\\n' "$MAX_SOL" "$DAILY_CAP" "$DAILY_LOSS_CAP" "$CAPS_RAISED"`], {
    env: {
      ...process.env,
      MODE: "live",
      MAX_SOL: "",
      DAILY_CAP: "",
      DAILY_LOSS_CAP: "",
      MAX_SOL_SET: "0",
      DAILY_CAP_SET: "0",
      DAILY_LOSS_CAP_SET: "0",
      ...overrides,
    },
    encoding: "utf8",
  });

  const defaults = runCaps();
  check("no live cap flags select the unchanged canary and no raised-cap ceremony",
    defaults.status === 0 && defaults.stdout.trim() === "0.005|0.01|0.01|0");

  /* Was the literal 0.05/0.5/0.15 — the reviewed maxima of the day. Reading them from
     the poller keeps this pinned to whatever the reviewed ceiling is (0.4/1000/0.4 as
     of 2026-09-07) and makes it prove one more thing for free: the exact operator
     maximum is installable, the mirror of the exact-minimum check below. */
  const raised = runCaps({
    MAX_SOL: POLLER_MAX_SOL, DAILY_CAP: POLLER_MAX_DAILY_CAP,
    DAILY_LOSS_CAP: POLLER_MAX_DAILY_LOSS_CAP,
    MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("all three explicit reviewed values select the raised-cap ceremony",
    raised.status === 0 &&
    raised.stdout.trim() === `${POLLER_MAX_SOL}|${POLLER_MAX_DAILY_CAP}|${POLLER_MAX_DAILY_LOSS_CAP}|1`);

  const exactMinimum = runCaps({
    MAX_SOL: "0.000001", DAILY_CAP: "0.000001", DAILY_LOSS_CAP: "0.000001",
    MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("the poller's exact minimum remains installable",
    exactMinimum.status === 0 &&
    exactMinimum.stdout.trim() === "0.000001|0.000001|0.000001|0");

  const belowMinimum = [
    { MAX_SOL: "0.0000009", DAILY_CAP: "0.01", DAILY_LOSS_CAP: "0.01" },
    { MAX_SOL: "0.005", DAILY_CAP: "0.0000009", DAILY_LOSS_CAP: "0.01" },
    { MAX_SOL: "0.005", DAILY_CAP: "0.01", DAILY_LOSS_CAP: "0.0000009" },
  ].map((values) => runCaps({
    ...values, MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("every money cap enforces the poller's 0.000001 lower bound before installation",
    belowMinimum.every((result) => result.status !== 0 &&
      /must be plain decimals at least 0\.000001/.test(result.stderr)));

  /* One over-precise literal per boundary. The lower bound is still the poller's
     0.000001; the three upper bounds are built from the current ceilings — the daily
     and loss rows used to spell out 0.5 and 0.15 and stopped touching any boundary at
     all once the reviewed maxima moved. The other two caps in each row sit exactly ON
     their ceilings so the only thing under test is the over-precise digit. */
  const roundedBoundaryLiterals = [
    { MAX_SOL: "0.00000099999999999999999999", DAILY_CAP: "0.01", DAILY_LOSS_CAP: "0.01" },
    { MAX_SOL: overPreciseCeiling(POLLER_MAX_SOL), DAILY_CAP: POLLER_MAX_DAILY_CAP, DAILY_LOSS_CAP: POLLER_MAX_DAILY_LOSS_CAP },
    { MAX_SOL: POLLER_MAX_SOL, DAILY_CAP: overPreciseCeiling(POLLER_MAX_DAILY_CAP), DAILY_LOSS_CAP: POLLER_MAX_DAILY_LOSS_CAP },
    { MAX_SOL: POLLER_MAX_SOL, DAILY_CAP: POLLER_MAX_DAILY_CAP, DAILY_LOSS_CAP: overPreciseCeiling(POLLER_MAX_DAILY_LOSS_CAP) },
  ].map((values) => runCaps({
    ...values, MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("over-precise cap literals cannot round onto a permitted boundary",
    roundedBoundaryLiterals.every((result) => result.status !== 0 &&
      /at most 9 fractional digits/.test(result.stderr)));

  const nonCanonicalLiterals = [".005", "00.005", "1."].map((MAX_SOL) => runCaps({
    MAX_SOL, DAILY_CAP: "0.01", DAILY_LOSS_CAP: "0.01",
    MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("installer cap grammar exactly matches the runtime's canonical decimal grammar",
    nonCanonicalLiterals.every((result) => result.status !== 0 &&
      /must be plain decimals/.test(result.stderr)));

  // A raise of the per-trade cap alone, at the reviewed ceiling: still refused without
  // the other two flags. (Was 0.05 — that number is now merely a legal value.)
  const partial = runCaps({ MAX_SOL: POLLER_MAX_SOL, MAX_SOL_SET: "1" });
  check("a partial live raise fails closed",
    partial.status !== 0 && /requires --max-sol, --daily-cap, and --daily-loss-cap together/.test(partial.stderr));

  /* One 0.000001-SOL step over whatever each ceiling currently is, not over a
     remembered 0.05/0.5/0.15 — the daily and loss rows were the two that stopped
     being an excess at all when the reviewed maxima moved to 0.4/1000/0.4. Every
     other cap in a row sits exactly on its ceiling, so each row isolates one
     dimension. */
  const excessive = [
    { MAX_SOL: justOverCeiling(POLLER_MAX_SOL), DAILY_CAP: POLLER_MAX_DAILY_CAP, DAILY_LOSS_CAP: POLLER_MAX_DAILY_LOSS_CAP },
    { MAX_SOL: POLLER_MAX_SOL, DAILY_CAP: justOverCeiling(POLLER_MAX_DAILY_CAP), DAILY_LOSS_CAP: POLLER_MAX_DAILY_LOSS_CAP },
    { MAX_SOL: POLLER_MAX_SOL, DAILY_CAP: POLLER_MAX_DAILY_CAP, DAILY_LOSS_CAP: justOverCeiling(POLLER_MAX_DAILY_LOSS_CAP) },
  ].map((values) => runCaps({
    ...values, MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("each reviewed operator maximum rejects even a minimal excess",
    excessive.every((result) => result.status !== 0 && /live caps cannot exceed/.test(result.stderr)));

  const inverted = runCaps({
    MAX_SOL: "0.02", DAILY_CAP: "0.01", DAILY_LOSS_CAP: "0.01",
    MAX_SOL_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("daily deployment below one trade fails closed",
    inverted.status !== 0 && /daily-cap must be greater than or equal to --max-sol/.test(inverted.stderr));

  const lower = runCaps({ MAX_SOL: "0.004", MAX_SOL_SET: "1" });
  check("a partial lowering remains safe and does not require a raise acknowledgement",
    lower.status === 0 && lower.stdout.trim() === "0.004|0.01|0.01|0");
}
check("Jupiter key is read privately, never accepted as an argv value",
  installer.includes("--jupiter-key-file") && !installer.includes("--jupiter-key)"));
check("feed secret stays out of argv and the systemd unit",
  installer.includes("--secret-file") && installer.includes("EnvironmentFile=") &&
  !installer.includes("Environment=CC_SECRET=") && !installer.includes("--secret)"));
check("key, environment and journal are owner-only",
  installer.includes("umask 077") && installer.includes('chmod 600 "$INSTALL_DIR/burner.json"') &&
    installer.includes('chmod 600 "$ENV_NEXT"') && installer.includes('chmod 600 "$STATE_DB"'));
check("one durable state database has exactly one canonical process lock",
  installer.includes('LOCK_FILE="${STATE_DB}.lock"') &&
  installer.includes('write_env_line LOCK_FILE "$LOCK_FILE"'));
check("durable state is initialized before the service starts",
  /LIVE_STATE_INIT_ACK="\$PUBKEY"/.test(installer) && /INIT_ONLY=1/.test(installer) &&
    installer.indexOf('node "$RELEASE_DIR/poller.mjs"') <
      installer.lastIndexOf("sudo systemctl restart cc-executor"));
check("live signing requires a locally pinned runtime source",
  /live mode requires --source-dir from a locally pinned Claude Company checkout/.test(installer) &&
  /if \[ "\$MODE" = "live" \] && \[ -z "\$SOURCE_DIR" \]/.test(installer) &&
  /live source must be detached at the published commit/.test(installer) &&
  /status --porcelain -- "executor\/\$source_file"/.test(installer) &&
  /live --expected-commit must exactly match the published commit/.test(installer));
check("live runtime bytes come from immutable Git blobs, not the worktree cache",
  /git -C "\$source_root" cat-file blob "\$SOURCE_COMMIT:executor\/\$file"/.test(installer) &&
  installer.indexOf("cat-file blob") < installer.indexOf("npm ci --ignore-scripts"));
check("a complete release is staged before the running service is stopped",
  installer.indexOf("npm ci --ignore-scripts") < installer.indexOf("systemctl is-active --quiet cc-executor") &&
  installer.includes('RELEASES_DIR="$INSTALL_DIR/releases"'));
/* The activation used to be `mv -Tf`. GNU's -T is what stops mv following the symlink
   it is replacing, and BSD/macOS mv has no such flag — measured on macOS 15, plain
   `mv -f` left `current` pointing at the OLD release and moved the new link inside it,
   silently. Now that install.sh also provisions macOS, activation goes through
   rename(2) via activate_symlink, which is atomic and never dereferences either
   operand on any Unix. What is pinned here is unchanged: activation is one atomic
   step, and the supervisor runs the symlink rather than a staging directory. */
check("activation uses an atomic current symlink and systemd never runs staged files",
  installer.includes('activate_symlink "$LINK_NEXT" "$CURRENT_LINK"') &&
  /renameSync\(process\.env\.LINK_FROM, process\.env\.LINK_TO\)/.test(installer) &&
  installer.includes('WorkingDirectory=$CURRENT_LINK') &&
  installer.includes('ExecStart=$NODE_BIN $CURRENT_LINK/poller.mjs'));
check("failed upgrades restore the prior unit, symlink, environment and journal",
  installer.includes("rollback_install()") && installer.includes('install -m 0644 "$UNIT_BACKUP"') &&
  installer.includes('activate_symlink "$LINK_RESTORE" "$CURRENT_LINK"') &&
  installer.includes('mv -f "$ENV_BACKUP" "$ENV_FILE"') &&
  installer.includes('cp -p "$STATE_BACKUP" "$STATE_DB"') &&
  installer.includes("systemctl disable cc-executor"));
check("the journal rollback boundary closes before the new service can run",
  installer.includes("ACTIVATION_COMMITTED=1") &&
  installer.indexOf("ACTIVATION_COMMITTED=1") <
    installer.lastIndexOf("sudo systemctl restart cc-executor") &&
  /if \[ "\$status" -ne 0 \] && \[ "\$ACTIVATION_COMMITTED" -eq 0 \]/.test(installer) &&
  /durable state was not rolled back/.test(installer));
check("generated EnvironmentFile is never sourced or evaluated",
  !/(^|\n)\s*(?:source|\.)\s+["']?\$ENV_FILE/m.test(installer) &&
  !/(^|[;\s])eval(?:[;\s]|$)/m.test(installer));

const writerStart = installer.indexOf("# BEGIN SYSTEMD_ENV_WRITER");
const writerEnd = installer.indexOf("# END SYSTEMD_ENV_WRITER");
check("installer exposes one reviewed systemd EnvironmentFile writer",
  writerStart >= 0 && writerEnd > writerStart);
if (writerStart >= 0 && writerEnd > writerStart) {
  const writer = installer.slice(writerStart, writerEnd);
  const marker = path.join(temp, "must-not-exist");
  const rendered = path.join(temp, "rendered.env");
  const payload = `https://rpc.invalid/query?a=1&space=two words;quote=\"'` +
    `&dollar=\$(touch ${marker})&tick=\`touch ${marker}\`&percent=%n&slash=\\tail`;
  const probe = spawnSync("bash", ["-c", `${writer}\nwrite_env_line ADVERSARIAL "$PAYLOAD" > "$OUTPUT"`], {
    env: { ...process.env, PAYLOAD: payload, OUTPUT: rendered }, encoding: "utf8",
  });
  check("adversarial environment value renders without executing shell syntax",
    probe.status === 0 && fs.existsSync(rendered) && !fs.existsSync(marker));
  if (probe.status === 0 && fs.existsSync(rendered)) {
    const line = fs.readFileSync(rendered, "utf8");
    const match = /^ADVERSARIAL="([\s\S]*)"\n$/.exec(line);
    let decoded = null;
    if (match) {
      decoded = match[1].replace(/\\([\\"$`])/g, "$1");
    }
    check("systemd quoting round-trips %, whitespace, quotes, $, backticks, semicolons, ampersands and query strings",
      decoded === payload);
  } else {
    check("systemd quoting round-trips %, whitespace, quotes, $, backticks, semicolons, ampersands and query strings", false);
  }
}
check("Node >=22.13 and <25 and pinned execution dependencies are required",
  installer.includes("Node >=22.13 and <25") &&
    /a<25&&\(a>22\|\|\(a===22&&b>=13\)\)/.test(installer) &&
    installer.includes("package-lock.json") &&
    installer.includes("npm ci --ignore-scripts"));
check("installer never pipes a mutable bootstrap script into a privileged shell",
  !/nodesource[\s\S]*\|[\s\S]*sudo\s+-E\s+bash/.test(installer));
/* The exact list is pinned in one place only — ../test-executor-publish.mjs derives
   it from poller.mjs's import graph and from the build's publish list, so a module
   that runs unpublished, or is published without running, fails there. What matters
   HERE is that the published installer stages the durable graph and the offline
   recovery tool, whatever order they appear in. */
{
  const staged = installer.match(/RUNTIME_FILES=\(([^)]*)\)/)?.[1]?.split(/\s+/) ?? [];
  const required = ["poller.mjs", "journal.mjs", "jupiter.mjs", "token2022.mjs",
    "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs",
    "sol-usd-oracle.mjs", "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs",
    "strategy.mjs", "trade-policy.mjs", "dexscreener-consensus.mjs", "desk-mirror.mjs",
    /* a key on exactly one disk is a stranded-funds bug waiting for its first dead host */
    "burner-backup.mjs"];
  check("installer stages the complete durable execution and monitoring module graph",
    required.every((f) => staged.includes(f)));

  /* launchd adopts a directory, not a command line: macos-launchagent.sh resolves
     launchd-runner.mjs and poller.mjs out of the --executor-dir it is handed, and the
     runner then validates every runtime file in it. A macOS release that omits those
     is a release launchd cannot supervise, and the failure would surface only on a
     Mac, at load time, after the environment had already been replaced. */
  const darwin = installer.match(/DARWIN_FILES=\(([^)]*)\)/)?.[1]?.split(/\s+/) ?? [];
  check("a macOS release also stages the launchd runner and lifecycle scripts",
    ["launchd-runner.mjs", "macos-launchagent.sh", "macos-release.sh"].every((f) => darwin.includes(f)) &&
    /SOURCE_FILES=\("\$\{SOURCE_FILES\[@\]\}" "\$\{DARWIN_FILES\[@\]\}"\)/.test(installer),
    `DARWIN_FILES: ${JSON.stringify(darwin)}`);
  check("macOS adoption is delegated to the reviewed scripts, not restated in the installer",
    /bash "\$source_dir\/macos-release\.sh" stage/.test(installer) &&
    /bash "\$source_dir\/macos-release\.sh" install/.test(installer) &&
    /bash "\$controller" install/.test(installer) && /bash "\$controller" load/.test(installer) &&
    !/launchctl (disable|enable|bootstrap|bootout)/.test(installer));
  check("no sudo is reachable on the macOS path",
    installer.split("\n").filter((l) => /^\s*sudo /.test(l)).length > 0 &&
    /if \[ "\$PLATFORM" = "linux" \]; then sudo systemctl daemon-reload/.test(installer) &&
    /if \[ "\$PLATFORM" = "linux" \] && sudo test -f "\$SERVICE_FILE"/.test(installer));
}
const manifest = sources.get("package.json") ? JSON.parse(sources.get("package.json")) : {};
const lock = sources.get("package-lock.json") ? JSON.parse(sources.get("package-lock.json")) : {};
check("published manifest pins the signer dependencies",
  manifest.dependencies?.["@solana/web3.js"] === "1.98.4" && manifest.dependencies?.bs58 === "4.0.1");
check("published lock agrees with the pinned manifest",
  lock.packages?.[""]?.dependencies?.["@solana/web3.js"] === "1.98.4" &&
  lock.packages?.[""]?.dependencies?.bs58 === "4.0.1");
check("systemd can write only the executor directory",
  installer.includes("ProtectSystem=strict") && installer.includes("ReadWritePaths=$INSTALL_DIR") &&
  installer.includes("NoNewPrivileges=true"));
check("installer never funds or imports a user wallet",
  installer.includes("No wallet was funded") && !/airdrop|requestAirdrop|solana transfer/.test(installer));

fs.rmSync(temp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed — the published installer is NOT safe to ship` :
  "\nPublished WALL-ST-E install graph and live gates are complete.");
process.exit(fail ? 1 : 0);
