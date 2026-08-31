/** Smoke-test the published WALL-ST-E installer and its complete module graph. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = process.argv[2] || "https://claudedotcompany.com";
const localRoot = fs.existsSync(target) ? path.resolve(target) : null;
const site = target.replace(/\/$/, "");
const need = ["poller.mjs", "journal.mjs", "jupiter.mjs", "strategy.mjs", "trade-policy.mjs",
  "package.json", "package-lock.json", "install.sh"];
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
check("live mode requires two explicit, distinct private HTTPS RPCs",
  /--live requires --rpc-file and --secondary-rpc-file/.test(installer) &&
    /--secondary-rpc must use an independent provider hostname from --rpc/.test(installer) &&
  /public Solana RPC is not accepted for either live endpoint/.test(installer) &&
    /write_env_line SOLANA_RPC_SECONDARY/.test(installer));
check("private RPC credentials can stay in owner-only files instead of argv",
  installer.includes("--rpc-file") && installer.includes("--secondary-rpc-file") &&
  /read_private_file "primary RPC"/.test(installer) &&
  /read_private_file "secondary RPC"/.test(installer));
check("live installer enforces the fixed canary deployment ceilings",
  /hard-capped at 0\.005 SOL per trade and 0\.01 SOL per rolling 24h/.test(installer) &&
  /m <= 0\.005 && d <= 0\.01/.test(installer));
check("Jupiter key is read privately, never accepted as an argv value",
  installer.includes("--jupiter-key-file") && !installer.includes("--jupiter-key)"));
check("feed secret stays out of argv and the systemd unit",
  installer.includes("--secret-file") && installer.includes("EnvironmentFile=") &&
  !installer.includes("Environment=CC_SECRET=") && !installer.includes("--secret)"));
check("key, environment and journal are owner-only",
  installer.includes("umask 077") && installer.includes('chmod 600 "$INSTALL_DIR/burner.json"') &&
    installer.includes('chmod 600 "$ENV_NEXT"') && installer.includes('chmod 600 "$STATE_DB"'));
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
check("activation uses an atomic current symlink and systemd never runs staged files",
  installer.includes('mv -Tf "$LINK_NEXT" "$CURRENT_LINK"') &&
  installer.includes('WorkingDirectory=$CURRENT_LINK') &&
  installer.includes('ExecStart=$NODE_BIN $CURRENT_LINK/poller.mjs'));
check("failed upgrades restore the prior unit, symlink, environment and journal",
  installer.includes("rollback_install()") && installer.includes('install -m 0644 "$UNIT_BACKUP"') &&
  installer.includes('mv -Tf "$LINK_RESTORE" "$CURRENT_LINK"') &&
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
check("Node 22.13+ and pinned execution dependencies are required",
  installer.includes("Node 22.13+") && installer.includes("package-lock.json") &&
    installer.includes("npm ci --ignore-scripts"));
check("installer never pipes a mutable bootstrap script into a privileged shell",
  !/nodesource[\s\S]*\|[\s\S]*sudo\s+-E\s+bash/.test(installer));
check("installer fetches both durable execution modules",
  /RUNTIME_FILES=\(poller\.mjs journal\.mjs jupiter\.mjs strategy\.mjs trade-policy\.mjs\)/.test(installer));
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
