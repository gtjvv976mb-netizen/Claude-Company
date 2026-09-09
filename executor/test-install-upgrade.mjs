/** Re-pinning an executor that is already installed: what it must stop asking, and
 *  what it must never stop asking.
 *
 *  The owner supplied his feed secret, two RPC endpoints and a Jupiter key at the
 *  first install. They have been sitting in his own 0600 environment ever since, and
 *  every re-pin asked him for all of them again — because install.sh only ever WROTE
 *  that file and never read one back. This file drives the path that fixes that, and
 *  it spends most of its assertions on the half that must NOT move: caps carry over
 *  and can never be widened here, two endpoints from one provider are still refused
 *  even when they were already installed, the wallet binding is re-derived from the
 *  key on disk rather than assumed, and --dry-run still disarms.
 *
 *  NOTHING HERE TOUCHES THE REAL EXECUTOR. Every run is driven against a fixture
 *  install directory built under a throwaway HOME, with INVENTED credentials. The
 *  installer's own protected environment is never read, and the invented values are
 *  grepped for across every transcript and every recorded argv to prove the installer
 *  names which keys it reused and prints none of their values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = fs.readFileSync(path.join(here, "install.sh"), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-upgrade-"));

let fail = 0;
const check = (name, condition, actual) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${actual === undefined ? "" : `\n        actual: ${actual}`}`);
  if (!condition) fail++;
};

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Pull one reviewed block out of install.sh so it can be executed on its own. */
function section(name) {
  const start = installer.indexOf(`# BEGIN ${name}`);
  const end = installer.indexOf(`# END ${name}`);
  if (start < 0 || end < start) throw new Error(`install.sh has no ${name} section`);
  return installer.slice(start, end);
}

/* Run a bash script attached to a real pty — the same helper shape
 * test-one-click-install.mjs uses, and for the same reason: the acknowledgement is
 * read from /dev/tty on purpose, and a pipe has no controlling terminal to read. */
function runOnPty(body, lines, { env = {} } = {}) {
  const tag = Math.random().toString(36).slice(2);
  const file = path.join(temp, `pty-${tag}.sh`);
  const done = path.join(temp, `pty-${tag}.done`);
  fs.writeFileSync(file, `${body}\ntouch ${shq(done)}\n`);
  const inner = `bash ${shq(file)}`;
  const scriptCmd = process.platform === "darwin"
    ? `script -q /dev/null ${inner}`
    : `script -q -e -c ${shq(inner)} /dev/null`;
  const feed = lines.length ? `printf '%s\\n' ${lines.map(shq).join(" ")};` : "";
  const hold = `i=0; while [ ! -f ${shq(done)} ] && [ $i -lt 900 ]; do sleep 0.05; i=$((i+1)); done; sleep 0.2`;
  const run = spawnSync("bash", ["-c",
    `(sleep 0.35; ${feed} ${hold}) | ${scriptCmd}`], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 180_000,
  });
  const out = `${run.stdout || ""}${run.stderr || ""}`.replace(/\r/g, "");
  return { ...run, out, finished: fs.existsSync(done) };
}

/* ── THE INVENTED CREDENTIALS ────────────────────────────────────────────────────
 * Long, unique and structurally real (the secret is hex and 64 characters, the
 * endpoints are https URLs on two DIFFERENT invalid hosts) so every rule they meet
 * is the rule the real values would meet. Nothing here exists anywhere. Every one of
 * them is grepped for over every transcript and every recorded argv below. */
const FIXTURE = Object.freeze({
  secret: "9f1e2d3c4b5a69788796a5b4c3d2e1f00badc0ffee1234567890abcdef123456",
  rpc: "https://primary-fixture.rpc-alpha.invalid/k-INVENTED-PRIMARY-7f3a9c",
  secondary: "https://secondary-fixture.rpc-beta.invalid/k-INVENTED-SECONDARY-91c2d4",
  jupiter: "jup-INVENTED-FIXTURE-KEY-4d5e6f7081",
  api: "https://api-fixture-invented.invalid",
});
const CREDENTIALS = [FIXTURE.secret, FIXTURE.rpc, FIXTURE.secondary, FIXTURE.jupiter];

/** Write a fixture environment in the installer's own systemd EnvironmentFile shape. */
function writeFixtureEnv(file, pairs, mode = 0o600) {
  const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
  const body = Object.entries(pairs).map(([k, v]) => `${k}=${quote(v)}\n`).join("");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const priorEnv = (over = {}) => ({
  CC_SECRET: FIXTURE.secret,
  CC_FLOOR: "14",
  CC_API: FIXTURE.api,
  MAX_SOL_PER_TRADE: "0.02",
  DAILY_SOL_CAP: "0.05",
  DAILY_LOSS_LIMIT_SOL: "0.02",
  EXECUTE: "1",
  JUPITER_API_KEY: FIXTURE.jupiter,
  SOLANA_RPC: FIXTURE.rpc,
  SOLANA_RPC_SECONDARY: FIXTURE.secondary,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Detection and carry-forward, driven — not grepped
// ─────────────────────────────────────────────────────────────────────────────
/* The carry block is executed on its own against a fixture environment. It reports
 * only whether each carried value equals the one that was planted (compared inside
 * the shell, against values handed to it in its own environment) — never the value.
 * That is the same discipline the installer itself is under. */
let carrySeq = 0;
function drive(envPairs, { mode = 0o600, symlink = false, flags = {}, fakeUid = null, reuseEnvAt = null } = {}) {
  const root = path.join(temp, `carry-${carrySeq++}`);
  const installDir = path.join(root, "claudeco-executor");
  fs.mkdirSync(installDir, { recursive: true });
  let envFile = path.join(installDir, ".cc-executor.env");
  /* reuseEnvAt writes the prior environment OUTSIDE the install directory and names it
     with --reuse-env, which is how a machine whose executor keeps its environment
     elsewhere upgrades. The default location is left deliberately empty, so a pass can
     only have come from the named file. */
  const namedEnv = reuseEnvAt ? path.join(root, reuseEnvAt) : "";
  if (envPairs && namedEnv) writeFixtureEnv(namedEnv, envPairs, mode);
  else if (envPairs) writeFixtureEnv(symlink ? path.join(root, "real.env") : envFile, envPairs, mode);
  if (envPairs && symlink) fs.symlinkSync(path.join(root, "real.env"), envFile);

  const bin = path.join(root, "bin");
  if (fakeUid !== null) {
    fs.mkdirSync(bin, { recursive: true });
    // `id -u` is how the installer asks "am I the owner?". A stand-in that answers
    // with somebody else's uid is the only way to drive the not-owned-by-you branch
    // without root, and it exercises the real comparison rather than a mocked one.
    fs.writeFileSync(path.join(bin, "id"),
      `#!/bin/sh\nif [ "$1" = "-u" ]; then echo ${fakeUid}; else exec /usr/bin/id "$@"; fi\n`,
      { mode: 0o755 });
  }

  const pre = [
    /* install.sh runs under `set -euo pipefail`, so a refusal spelled as a non-zero
       exit from a helper rather than an explicit `exit 1` — the two-provider hostname
       check is a `node -` heredoc — is what aborts the install. Driving these sections
       under `set -uo` instead silently downgrades that abort to a printed line and a
       clean exit 0: a ruler that reports "refused" and "installed" identically. It did
       exactly that here before this comment existed. */
    "set -euo pipefail",
    `PLATFORM=${process.platform === "darwin" ? "darwin" : "linux"}`,
    `INSTALL_DIR=${shq(installDir)}`,
    `ENV_FILE=${shq(envFile)}`,
    `REUSE_ENV=${shq(namedEnv)}`,
    'ENV_SOURCE=""',
    `SECRET=${shq(flags.SECRET || "")}`,
    `SECRET_FILE=${shq(flags.SECRET_FILE || "")}`,
    `RPC=${shq(flags.RPC || "")}`,
    `RPC_FILE=${shq(flags.RPC_FILE || "")}`,
    `SECONDARY_RPC=${shq(flags.SECONDARY_RPC || "")}`,
    `SECONDARY_RPC_FILE=${shq(flags.SECONDARY_RPC_FILE || "")}`,
    `JUPITER_KEY=${shq(flags.JUPITER_KEY || "")}`,
    `JUPITER_KEY_FILE=${shq(flags.JUPITER_KEY_FILE || "")}`,
    `API=${shq(flags.API || "https://api-default-not-carried.invalid")}`,
    `API_SET=${flags.API_SET || 0}`,
  ].join("\n");
  // Equality is decided inside the shell and only the verdict is printed. The
  // expected values reach it through its own environment, never through argv and
  // never through the transcript.
  const post = `
printf 'UPGRADE=%s\\n' "$UPGRADE"
printf 'REUSED=%s\\n' "$UPGRADE_REUSED"
printf 'SECRET_CARRIED=%s\\n' "$([ "$SECRET" = "$WANT_SECRET" ] && echo yes || echo no)"
printf 'SECRET_EMPTY=%s\\n' "$([ -z "$SECRET" ] && echo yes || echo no)"
printf 'RPC_CARRIED=%s\\n' "$([ "$RPC" = "$WANT_RPC" ] && echo yes || echo no)"
printf 'SECONDARY_CARRIED=%s\\n' "$([ "$SECONDARY_RPC" = "$WANT_SECONDARY" ] && echo yes || echo no)"
printf 'JUPITER_CARRIED=%s\\n' "$([ "$JUPITER_KEY" = "$WANT_JUPITER" ] && echo yes || echo no)"
printf 'API_CARRIED=%s\\n' "$([ "$API" = "$WANT_API" ] && echo yes || echo no)"
printf 'KEYPAIR_PATH=%s\\n' "$KEYPAIR_PATH"
printf 'PRIOR_CAPS=%s|%s|%s\\n' "$PRIOR_MAX_SOL" "$PRIOR_DAILY_CAP" "$PRIOR_DAILY_LOSS_CAP"
printf 'PRIOR_ACK=%s\\n' "$PRIOR_LIVE_ACK"
`;
  const run = spawnSync("bash", ["-c", `${pre}\n${section("FILE_FACTS")}\n${section("UPGRADE_CARRY")}\n${post}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: fakeUid !== null ? `${bin}:${process.env.PATH}` : process.env.PATH,
      WANT_SECRET: FIXTURE.secret,
      WANT_RPC: FIXTURE.rpc,
      WANT_SECONDARY: FIXTURE.secondary,
      WANT_JUPITER: FIXTURE.jupiter,
      WANT_API: FIXTURE.api,
    },
  });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  const field = (key) => (new RegExp(`^${key}=(.*)$`, "m").exec(out) || [, "<absent>"])[1];
  return { run, out, field, installDir, envFile, namedEnv };
}

{
  const good = drive(priorEnv({ LIVE_TRADING_ACK: "FiXtUrEPubKey1111111111111111111111111111" }));
  check("an existing 0600 environment owned by the invoking user is detected as an upgrade",
    good.field("UPGRADE") === "1", `UPGRADE=${good.field("UPGRADE")}`);
  check("the feed secret is carried forward byte for byte and never re-asked",
    good.field("SECRET_CARRIED") === "yes" && good.field("SECRET_EMPTY") === "no",
    `carried: ${good.field("SECRET_CARRIED")}, empty: ${good.field("SECRET_EMPTY")}`);
  check("both RPC endpoints and the Jupiter key are carried forward byte for byte",
    good.field("RPC_CARRIED") === "yes" && good.field("SECONDARY_CARRIED") === "yes" &&
    good.field("JUPITER_CARRIED") === "yes",
    `primary ${good.field("RPC_CARRIED")}, secondary ${good.field("SECONDARY_CARRIED")}, jupiter ${good.field("JUPITER_CARRIED")}`);
  check("the API base is carried forward when no --api was passed",
    good.field("API_CARRIED") === "yes", `carried: ${good.field("API_CARRIED")}`);
  check("the burner keypair path comes from the existing environment, not a fresh default",
    good.field("KEYPAIR_PATH") === path.join(good.installDir, "fixture-burner.json") ||
    good.field("KEYPAIR_PATH") === path.join(good.installDir, "burner.json"),
    `KEYPAIR_PATH=${good.field("KEYPAIR_PATH")}`);
  check("the installed caps are read for later use, exactly as written",
    good.field("PRIOR_CAPS") === "0.02|0.05|0.02", `PRIOR_CAPS=${good.field("PRIOR_CAPS")}`);
  check("the existing wallet acknowledgement is read for the binding re-check",
    good.field("PRIOR_ACK") === "FiXtUrEPubKey1111111111111111111111111111",
    `PRIOR_ACK=${good.field("PRIOR_ACK")}`);
  check("it says WHICH keys it reused",
    /CC_SECRET/.test(good.field("REUSED")) && /SOLANA_RPC\b/.test(good.field("REUSED")) &&
    /SOLANA_RPC_SECONDARY/.test(good.field("REUSED")) && /JUPITER_API_KEY/.test(good.field("REUSED")) &&
    /CC_API/.test(good.field("REUSED")),
    `REUSED=${good.field("REUSED")}`);
  const leaked = CREDENTIALS.filter((value) => good.out.includes(value));
  check("and prints NONE of their values",
    leaked.length === 0,
    `${good.out.length} bytes of transcript; credential substrings found: ${leaked.length}`);
}

{
  // Rule 6: a value on the line always beats a value on disk.
  const flagged = drive(priorEnv(), {
    flags: { RPC: "https://flag-wins.example-gamma.invalid/on-the-line" },
  });
  check("a value passed on the command line wins over the carried one",
    flagged.field("RPC_CARRIED") === "no" && flagged.field("SECONDARY_CARRIED") === "yes",
    `primary carried: ${flagged.field("RPC_CARRIED")} (flag kept), secondary carried: ${flagged.field("SECONDARY_CARRIED")}`);
  check("a reused key is not claimed for a value the flag supplied",
    !/ SOLANA_RPC\b/.test(flagged.field("REUSED")) && / SOLANA_RPC_SECONDARY/.test(flagged.field("REUSED")),
    `REUSED=${flagged.field("REUSED")}`);
}

{
  // A file this installer could not have written, or that somebody else can read, is
  // not evidence of anything. Each of these must fall through to the full path.
  const wrongMode = drive(priorEnv(), { mode: 0o644 });
  check("a group/world-readable environment is not trusted and is named as such",
    wrongMode.field("UPGRADE") === "0" && wrongMode.field("SECRET_EMPTY") === "yes" &&
    /is mode 644, not 600/.test(wrongMode.out),
    `UPGRADE=${wrongMode.field("UPGRADE")}; ${(wrongMode.out.split("\n").find((l) => /mode 644/.test(l)) || "<no reason printed>").trim()}`);

  const link = drive(priorEnv(), { symlink: true });
  check("a symlink in place of the protected environment is not trusted",
    link.field("UPGRADE") === "0" && link.field("SECRET_EMPTY") === "yes" &&
    /is a symlink/.test(link.out),
    `UPGRADE=${link.field("UPGRADE")}; ${(link.out.split("\n").find((l) => /symlink/.test(l)) || "<no reason printed>").trim()}`);

  const notMine = drive(priorEnv(), { fakeUid: 424242 });
  check("an environment owned by another user is not trusted",
    notMine.field("UPGRADE") === "0" && notMine.field("SECRET_EMPTY") === "yes" &&
    /not by you \(uid 424242\)/.test(notMine.out),
    `UPGRADE=${notMine.field("UPGRADE")}; ${(notMine.out.split("\n").find((l) => /owned by uid/.test(l)) || "<no reason printed>").trim()}`);

  const none = drive(null);
  check("no environment at all is simply a fresh install, silently",
    none.field("UPGRADE") === "0" && none.field("SECRET_EMPTY") === "yes" &&
    !/upgrade:/.test(none.out),
    `UPGRADE=${none.field("UPGRADE")}, transcript ${JSON.stringify(none.out.trim().split("\n").slice(0, 2).join(" | "))}`);

  for (const [label, result] of [["wrong mode", wrongMode], ["symlink", link],
    ["another owner", notMine], ["absent", none]]) {
    check(`${label}: nothing was carried, so the full path will ask for everything`,
      result.field("SECRET_CARRIED") === "no" && result.field("RPC_CARRIED") === "no" &&
      result.field("JUPITER_CARRIED") === "no" && result.field("API_CARRIED") === "no",
      `secret ${result.field("SECRET_CARRIED")}, rpc ${result.field("RPC_CARRIED")}, ` +
      `jupiter ${result.field("JUPITER_CARRIED")}, api ${result.field("API_CARRIED")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Caps carry over exactly, and this path can never widen one
// ─────────────────────────────────────────────────────────────────────────────
let capSeq = 0;
function driveCaps(flags = {}, envPairs = priorEnv()) {
  const root = path.join(temp, `caps-${capSeq++}`);
  const installDir = path.join(root, "claudeco-executor");
  fs.mkdirSync(installDir, { recursive: true });
  const envFile = path.join(installDir, ".cc-executor.env");
  if (envPairs) writeFixtureEnv(envFile, envPairs);
  const pre = [
    "set -euo pipefail",
    `PLATFORM=${process.platform === "darwin" ? "darwin" : "linux"}`,
    `INSTALL_DIR=${shq(installDir)}`,
    `ENV_FILE=${shq(envFile)}`,
    'MODE="live"',
    'SECRET=""; SECRET_FILE=""; RPC=""; RPC_FILE=""; SECONDARY_RPC=""; SECONDARY_RPC_FILE=""',
    'JUPITER_KEY=""; JUPITER_KEY_FILE=""; API="https://a.invalid"; API_SET=0',
    `MAX_SOL=${shq(flags.MAX_SOL || "")}`,
    `DAILY_CAP=${shq(flags.DAILY_CAP || "")}`,
    `DAILY_LOSS_CAP=${shq(flags.DAILY_LOSS_CAP || "")}`,
    `MAX_SOL_SET=${flags.MAX_SOL_SET || 0}`,
    `DAILY_CAP_SET=${flags.DAILY_CAP_SET || 0}`,
    `DAILY_LOSS_CAP_SET=${flags.DAILY_LOSS_CAP_SET || 0}`,
  ].join("\n");
  const post = `printf 'CAPS=%s|%s|%s\\n' "$MAX_SOL" "$DAILY_CAP" "$DAILY_LOSS_CAP"
printf 'RAISED=%s NOT_RAISED=%s\\n' "$CAPS_RAISED" "$UPGRADE_CAPS_NOT_RAISED"`;
  const run = spawnSync("bash", ["-c",
    `${pre}\n${section("FILE_FACTS")}\n${section("UPGRADE_CARRY")}\n${section("LIVE_CAPS_VALIDATOR")}\n${post}`],
    { encoding: "utf8" });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  return { run, out, caps: (/^CAPS=(.*)$/m.exec(out) || [, "<none>"])[1],
    flags: (/^RAISED=(.*)$/m.exec(out) || [, "<none>"])[1] };
}

{
  const carried = driveCaps();
  check("with no cap flags an upgrade installs the caps that are already installed",
    carried.run.status === 0 && carried.caps === "0.02|0.05|0.02",
    `exit ${carried.run.status}, caps ${carried.caps} (installed 0.02|0.05|0.02)`);
  check("carrying an already-raised tuple is not a NEW raise and demands no flag trio",
    carried.run.status === 0 && carried.flags === "1 NOT_RAISED=1" &&
    !/requires --max-sol, --daily-cap, and --daily-loss-cap together/.test(carried.out),
    `${carried.flags}; stderr ${JSON.stringify(carried.out.trim().split("\n").filter((l) => !/^(CAPS|RAISED)=/.test(l)).join(" | ")) || '""'}`);

  const raise = driveCaps({ MAX_SOL: "0.3", MAX_SOL_SET: 1 });
  check("a flag that would RAISE a cap is refused, and the refusal names arm-caps",
    raise.run.status !== 0 && /would RAISE MAX_SOL_PER_TRADE above the 0\.02/.test(raise.out) &&
    /arm-caps/.test(raise.out),
    `exit ${raise.run.status}; ${(raise.out.split("\n").find((l) => /REFUSED/.test(l)) || "<no refusal>").trim()}`);

  for (const [flag, values, key] of [
    ["--daily-cap", { DAILY_CAP: "0.9", DAILY_CAP_SET: 1 }, "DAILY_SOL_CAP"],
    ["--daily-loss-cap", { DAILY_LOSS_CAP: "0.35", DAILY_LOSS_CAP_SET: 1 }, "DAILY_LOSS_LIMIT_SOL"],
  ]) {
    const r = driveCaps(values);
    check(`${flag} cannot widen ${key} through the upgrade path either`,
      r.run.status !== 0 && new RegExp(`would RAISE ${key} above`).test(r.out) && /arm-caps/.test(r.out),
      `exit ${r.run.status}; ${(r.out.split("\n").find((l) => /REFUSED/.test(l)) || "<no refusal>").trim()}`);
  }

  const tiny = driveCaps({ MAX_SOL: "0.020000001", MAX_SOL_SET: 1 });
  check("even a one-lamport-scale widening is refused",
    tiny.run.status !== 0 && /would RAISE MAX_SOL_PER_TRADE above the 0\.02/.test(tiny.out),
    `exit ${tiny.run.status}; requested 0.020000001 against an installed 0.02`);

  const lower = driveCaps({ MAX_SOL: "0.01", MAX_SOL_SET: 1 });
  check("lowering a cap on an upgrade is still allowed, and the other two carry over",
    lower.run.status === 0 && lower.caps === "0.01|0.05|0.02",
    `exit ${lower.run.status}, caps ${lower.caps}`);

  const same = driveCaps({ MAX_SOL: "0.02", MAX_SOL_SET: 1 });
  check("re-passing the identical value is not a raise",
    same.run.status === 0 && same.caps === "0.02|0.05|0.02",
    `exit ${same.run.status}, caps ${same.caps}`);

  // The ceilings do not become negotiable just because a value was already on disk.
  const overCeiling = driveCaps({}, priorEnv({ MAX_SOL_PER_TRADE: "9", DAILY_SOL_CAP: "9", DAILY_LOSS_LIMIT_SOL: "9" }));
  check("a stored cap above the reviewed operator maximum is still refused, not grandfathered",
    overCeiling.run.status !== 0 && /live caps cannot exceed/.test(overCeiling.out),
    `exit ${overCeiling.run.status}; ${(overCeiling.out.split("\n").find((l) => /cannot exceed/.test(l)) || "<none>").trim()}`);

  // No prior install: the canary defaults and the existing ceremony, untouched.
  const fresh = driveCaps({}, null);
  check("with no prior install the canary defaults still apply unchanged",
    fresh.run.status === 0 && fresh.caps === "0.005|0.01|0.01" && fresh.flags === "0 NOT_RAISED=0",
    `exit ${fresh.run.status}, caps ${fresh.caps}, ${fresh.flags}`);
  const freshPartial = driveCaps({ MAX_SOL: "0.3", MAX_SOL_SET: 1 }, null);
  check("with no prior install a partial raise still fails closed on the flag trio",
    freshPartial.run.status !== 0 &&
    /requires --max-sol, --daily-cap, and --daily-loss-cap together/.test(freshPartial.out),
    `exit ${freshPartial.run.status}; ${(freshPartial.out.split("\n").find((l) => /requires --max-sol/.test(l)) || "<none>").trim()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. The two-provider rule applies to what was reused, not only to what was typed
// ─────────────────────────────────────────────────────────────────────────────
let rpcSeq = 0;
function driveRpcRule(envPairs) {
  const root = path.join(temp, `rpc-${rpcSeq++}`);
  const installDir = path.join(root, "claudeco-executor");
  fs.mkdirSync(installDir, { recursive: true });
  const envFile = path.join(installDir, ".cc-executor.env");
  writeFixtureEnv(envFile, envPairs);
  const pre = [
    "set -euo pipefail",
    `PLATFORM=${process.platform === "darwin" ? "darwin" : "linux"}`,
    `INSTALL_DIR=${shq(installDir)}`,
    `ENV_FILE=${shq(envFile)}`,
    'MODE="live"',
    'SECRET=""; SECRET_FILE=""; RPC=""; RPC_FILE=""; SECONDARY_RPC=""; SECONDARY_RPC_FILE=""',
    'JUPITER_KEY=""; JUPITER_KEY_FILE=""; API="https://a.invalid"; API_SET=0',
  ].join("\n");
  const run = spawnSync("bash", ["-c",
    `${pre}\n${section("FILE_FACTS")}\n${section("UPGRADE_CARRY")}\n${section("RPC_TWO_PROVIDER")}\necho RPC_RULE_PASSED`],
    { encoding: "utf8" });
  return { run, out: `${run.stdout || ""}${run.stderr || ""}` };
}

{
  const ok = driveRpcRule(priorEnv());
  check("two carried endpoints from different providers still pass the rule",
    ok.run.status === 0 && /RPC_RULE_PASSED/.test(ok.out),
    `exit ${ok.run.status}; hosts primary-fixture.rpc-alpha.invalid vs secondary-fixture.rpc-beta.invalid`);

  const sameHost = driveRpcRule(priorEnv({
    SOLANA_RPC_SECONDARY: "https://primary-fixture.rpc-alpha.invalid/k-INVENTED-SECOND-KEY-abc123",
  }));
  check("a reused pair that shares one provider is REFUSED, not grandfathered",
    sameHost.run.status !== 0 &&
    /--secondary-rpc must use an independent provider hostname from --rpc/.test(sameHost.out) &&
    !/RPC_RULE_PASSED/.test(sameHost.out),
    `exit ${sameHost.run.status}; ${(sameHost.out.split("\n").find((l) => /independent provider/.test(l)) || "<no refusal>").trim()}`);

  const publicRpc = driveRpcRule(priorEnv({ SOLANA_RPC: "https://api.mainnet-beta.solana.com" }));
  check("a reused public endpoint is still refused for live",
    publicRpc.run.status !== 0 && /public Solana RPC is not accepted/.test(publicRpc.out),
    `exit ${publicRpc.run.status}; ${(publicRpc.out.split("\n").find((l) => /public Solana RPC/.test(l)) || "<no refusal>").trim()}`);

  const leaked = CREDENTIALS.filter((v) => `${ok.out}${sameHost.out}${publicRpc.out}`.includes(v));
  check("no endpoint value reached any of those transcripts",
    leaked.length === 0, `credential substrings found across 3 transcripts: ${leaked.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// D. The wallet binding is RE-DERIVED from the key on disk, never assumed
// ─────────────────────────────────────────────────────────────────────────────
/* The acknowledgement block is run on its own with PUBKEY already derived — which is
 * exactly the state install.sh is in when it reaches this code, one line after
 * reading the burner. Three cases, all on a real pty because the branch that does
 * NOT reuse reads from /dev/tty. */
const PUBKEY = "9xQeWvG816bUx9EPa2rNMPMmpUKcHxRJEnCbz6b8swaP";
const OTHERKEY = "3Nq4pJ7yYbRxLwUvQeHkMzTdGa6cVnBs1FxPkR2mWuAe";

function driveAck(priorAck, feed, { capsRaised = 0, priorCapsAck = "", maxSol = "0.02" } = {}) {
  const body = [
    "set -euo pipefail",
    `PUBKEY=${shq(PUBKEY)}`,
    `KEYPAIR_PATH=${shq(path.join(temp, "fixture-burner.json"))}`,
    'MODE="live"',
    "UPGRADE=1",
    `PRIOR_LIVE_ACK=${shq(priorAck)}`,
    `PRIOR_LIVE_CAPS_ACK=${shq(priorCapsAck)}`,
    `CAPS_RAISED=${capsRaised}`,
    `MAX_SOL=${shq(maxSol)}`,
    'DAILY_CAP="0.05"',
    'DAILY_LOSS_CAP="0.02"',
    section("LIVE_ACK"),
    `printf 'ACK_MATCHES=%s\\n' "$([ "$LIVE_ACK" = "$PUBKEY" ] && echo yes || echo no)"`,
    `printf 'EXECUTE_VALUE=%s\\n' "$EXECUTE_VALUE"`,
    `printf 'CAPS_ACK_REUSED=%s\\n' "$([ -n "$LIVE_CAPS_ACK" ] && echo yes || echo no)"`,
  ].join("\n");
  const run = runOnPty(body, feed);
  const field = (key) => (new RegExp(`^${key}=(.*)$`, "m").exec(run.out) || [, "<absent>"])[1];
  return { ...run, field };
}

{
  const RETYPE = "Retype the public wallet above to arm this local service";
  const same = driveAck(PUBKEY, []);
  check("when the key on disk still derives the address the ack names, it is NOT retyped",
    same.finished && same.field("ACK_MATCHES") === "yes" && same.field("EXECUTE_VALUE") === "1" &&
    !same.out.includes(RETYPE),
    `ACK_MATCHES=${same.field("ACK_MATCHES")}, EXECUTE_VALUE=${same.field("EXECUTE_VALUE")}, ` +
    `retype prompt shown: ${same.out.includes(RETYPE)}`);
  check("and the branch it took is stated on screen, in words",
    /WALLET BINDING CARRIED FORWARD — you are not retyping it/.test(same.out) &&
    same.out.includes(PUBKEY),
    (same.out.split("\n").find((l) => /WALLET BINDING/.test(l)) || "<no branch statement>").trim());

  const different = driveAck(OTHERKEY, [PUBKEY]);
  check("a burner that derives a DIFFERENT address demands the acknowledgement again",
    different.finished && different.out.includes(RETYPE) &&
    different.field("ACK_MATCHES") === "yes" && different.field("EXECUTE_VALUE") === "1",
    `retype prompt shown: ${different.out.includes(RETYPE)}, armed after typing: ${different.field("EXECUTE_VALUE")}`);
  check("and it says WHY it is asking",
    /derives a DIFFERENT address from the one the existing acknowledgement names/.test(different.out),
    (different.out.split("\n").find((l) => /DIFFERENT address/.test(l)) || "<no reason>").trim());

  const wrongTyped = driveAck(OTHERKEY, ["not-the-wallet"]);
  check("typing the wrong address at that prompt still refuses to arm",
    /public-key acknowledgement did not match; live mode not armed/.test(wrongTyped.out) &&
    wrongTyped.field("EXECUTE_VALUE") === "<absent>",
    (wrongTyped.out.split("\n").find((l) => /did not match/.test(l)) || "<no refusal>").trim());

  const noAck = driveAck("", [PUBKEY]);
  check("an environment with no acknowledgement at all demands one",
    noAck.finished && noAck.out.includes(RETYPE) &&
    /carries no LIVE_TRADING_ACK/.test(noAck.out) && noAck.field("EXECUTE_VALUE") === "1",
    (noAck.out.split("\n").find((l) => /carries no LIVE_TRADING_ACK/.test(l)) || "<no reason>").trim());

  // The raised-cap sentence is wallet-bound AND number-bound, so it is its own test.
  const sentence = (max) => `I acknowledge WALL-ST-E caps v2 for ${PUBKEY}: ${max} SOL per trade, 0.05 SOL per day, 0.02 SOL rolling realized-loss entry brake`;
  const capsSame = driveAck(PUBKEY, [], { capsRaised: 1, priorCapsAck: sentence("0.02") });
  check("an unchanged raised-cap tuple does not re-demand the typed sentence",
    capsSame.finished && capsSame.field("CAPS_ACK_REUSED") === "yes" &&
    capsSame.field("EXECUTE_VALUE") === "1" && !/RAISED LIVE CAPS/.test(capsSame.out),
    `reused: ${capsSame.field("CAPS_ACK_REUSED")}, sentence prompt shown: ${/RAISED LIVE CAPS/.test(capsSame.out)}`);
  const capsMoved = driveAck(PUBKEY, [sentence("0.01")], { capsRaised: 1, maxSol: "0.01", priorCapsAck: sentence("0.02") });
  check("a stored sentence for DIFFERENT numbers is not accepted for these ones",
    capsMoved.finished && /RAISED LIVE CAPS/.test(capsMoved.out) &&
    capsMoved.field("EXECUTE_VALUE") === "1",
    `sentence prompt shown for the new numbers: ${/RAISED LIVE CAPS/.test(capsMoved.out)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// E. The whole installer, sealed, over a fixture install that is already there
// ─────────────────────────────────────────────────────────────────────────────
/* Same sealing as test-one-click-install.mjs section I, and for the same reason: this
 * machine runs the owner's live executor. A throwaway HOME, a fake $STATIC served by
 * a curl stand-in, recording stand-ins for the two lifecycle scripts, and tripwires
 * on sudo/systemctl. What is new is that the sandbox HOME is pre-seeded with a
 * complete prior install — a 0600 environment full of invented credentials, a real
 * burner keypair, and a prior release directory — so the run under test is an
 * UPGRADE and not a first install. */
const SEP = "\u001f";
const recorder = (extra = "") => `#!/bin/sh
{
  printf 'CALL${SEP}%s' "$(basename "$0")"
  for a in "$@"; do printf '${SEP}%s' "$a"; done
  printf '\\n'
} >> "$WALLSTE_REC"
${extra}
`;
const readCalls = (recFile) => (fs.existsSync(recFile) ? fs.readFileSync(recFile, "utf8") : "")
  .split("\n").filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    return { kind: parts[0], name: parts[1], args: parts.slice(2) };
  });

function stagedFileNames() {
  const list = (name) => (installer.match(new RegExp(`${name}=\\(([^)]*)\\)`))?.[1] || "")
    .split(/\s+/).filter(Boolean);
  return [...list("RUNTIME_FILES"), "package.json", "package-lock.json", ...list("DARWIN_FILES")];
}

function macSandbox(name) {
  const root = path.join(temp, name);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const mirror = path.join(root, "static", "executor");
  const rec = path.join(root, "calls.log");
  for (const dir of [home, bin, mirror]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rec, "");
  const installDir = path.join(home, "claudeco-executor");
  for (const file of stagedFileNames()) fs.copyFileSync(path.join(here, file), path.join(mirror, file));
  fs.writeFileSync(path.join(mirror, "macos-launchagent.sh"), recorder(`
echo "stand-in macos-launchagent.sh: $1 (nothing was installed, enabled or started)"
exit 0
`));
  fs.writeFileSync(path.join(mirror, "macos-release.sh"), recorder(`
echo "stand-in macos-release.sh: $1 (nothing was staged, bound or started)"
exit 0
`));
  const write = (file, body) => fs.writeFileSync(path.join(bin, file), body, { mode: 0o755 });
  write("uname", `#!/bin/sh\ncase "\${1:-}" in -m) echo arm64;; *) echo Darwin;; esac\n`);
  write("curl", `${recorder()}
url=""; out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
name="\${url##*/}"
[ -n "$out" ] && [ -f "$WALLSTE_MIRROR/$name" ] || exit 22
cp "$WALLSTE_MIRROR/$name" "$out"
`);
  write("npm", `${recorder()}\n[ -e node_modules ] || ln -s "$WALLSTE_NODE_MODULES" node_modules\nexit 0\n`);
  write("launchctl", `${recorder()}\nexit 1\n`);
  write("sudo", `${recorder()}\nexit 1\n`);
  write("systemctl", `${recorder()}\nexit 1\n`);
  return {
    root, home, bin, mirror, rec, installDir,
    env: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      WALLSTE_REC: rec,
      WALLSTE_MIRROR: mirror,
      WALLSTE_INSTALL_DIR: installDir,
      WALLSTE_NODE_MODULES: path.join(here, "node_modules"),
    },
    calls: () => readCalls(rec),
  };
}

const macCapable = process.platform === "darwin" &&
  fs.existsSync(path.join(here, "node_modules", "@solana", "web3.js"));

if (!macCapable) {
  console.log(`SKIP  the sealed end-to-end upgrade run (needs darwin + executor/node_modules; this is ${process.platform})`);
} else {
  const { Keypair } = await import(path.join(here, "node_modules", "@solana", "web3.js", "lib", "index.cjs.js"))
    .then((m) => m.default ?? m).catch(async () => (await import("@solana/web3.js")).default ?? await import("@solana/web3.js"));

  /** Seed a sandbox HOME with a complete, already-installed executor. */
  const seed = (box, mode = 0o600) => {
    fs.mkdirSync(path.join(box.installDir, "releases", "20260101T000000Z-prior-1"), { recursive: true });
    const keypair = Keypair.generate();
    const burner = path.join(box.installDir, "burner.json");
    fs.writeFileSync(burner, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    fs.chmodSync(burner, 0o600);
    writeFixtureEnv(path.join(box.installDir, ".cc-executor.env"), priorEnv({
      KEYPAIR: burner,
      STATE_DB: path.join(box.installDir, ".cc-executor.sqlite"),
      LIVE_TRADING_ACK: keypair.publicKey.toBase58(),
    }), mode);
    return { burner, pubkey: keypair.publicKey.toBase58(),
      burnerBytes: fs.readFileSync(burner, "utf8") };
  };

  // ── E1: a re-pin over a trusted prior install asks for nothing it already has ──
  {
    const box = macSandbox("upgrade-dryrun");
    const prior = seed(box);
    const installerCopy = path.join(box.root, "install.sh");
    fs.copyFileSync(path.join(here, "install.sh"), installerCopy);
    const run = runOnPty(
      `cd ${shq(box.root)} && bash ${shq(installerCopy)} --floor 14 --dry-run --static https://static.invalid`,
      [], { env: box.env });
    const out = run.out;
    const envPath = path.join(box.installDir, ".cc-executor.env");
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const envLine = (key) => (new RegExp(`^${key}="(.*)"$`, "m").exec(envText) || [, "<absent>"])[1];

    check("the sealed upgrade run finished without ever asking for the feed secret",
      run.finished && /WALL-ST-E installed for floor 14/.test(out) &&
      !/Claude Company executor feed secret:/.test(out),
      `finished ${run.finished}; secret prompt shown: ${/Claude Company executor feed secret:/.test(out)}; ` +
      `last line ${JSON.stringify((out.trim().split("\n").pop() || "").slice(0, 120))}`);
    check("it announced the existing install and named the keys it reused",
      /* RE-ANCHORED 2026-09-09 with --reuse-env: the announcement now names the file it
         carried FROM, which may sit outside the install directory, so the wording moved
         from "this machine already has an install at" to "carrying forward the install
         at". The property is unchanged and slightly stronger — it must still announce,
         and it must still name the source. */
      /▶ upgrade: carrying forward the install at \S/.test(out) &&
      /reusing what you already supplied \(keys named, values never shown\):/.test(out) &&
      /CC_SECRET/.test(out) && /SOLANA_RPC/.test(out) && /SOLANA_RPC_SECONDARY/.test(out) &&
      /JUPITER_API_KEY/.test(out) && /CC_API/.test(out) && /KEYPAIR/.test(out),
      (out.split("\n").find((l) => /reusing what you already supplied/.test(l)) || "<no reuse line>").trim());
    check("it said the secret and the Jupiter key were reused rather than typed",
      /floor feed secret reused from the existing install \(not shown, not retyped\)/.test(out),
      (out.split("\n").find((l) => /feed secret reused/.test(l)) || "<none>").trim());

    /* THE WHOLE POINT OF NAMING KEYS INSTEAD OF PRINTING THEM. One grep per invented
       credential over the entire transcript AND every argument every stand-in saw. */
    const everyArg = box.calls().flatMap((c) => c.args).join("\n");
    const hits = CREDENTIALS.map((value) => ({
      len: value.length,
      transcript: out.split(value).length - 1,
      argv: everyArg.split(value).length - 1,
    }));
    check("not one carried credential appears in the transcript or in any recorded argv",
      hits.every((h) => h.transcript === 0 && h.argv === 0),
      `${out.length} bytes of transcript, ${everyArg.length} bytes of arguments across ` +
      `${box.calls().length} calls; per-credential hits ${JSON.stringify(hits)}`);

    check("the caps that were installed are the caps that were written, byte for byte",
      envLine("MAX_SOL_PER_TRADE") === "0.02" && envLine("DAILY_SOL_CAP") === "0.05" &&
      envLine("DAILY_LOSS_LIMIT_SOL") === "0.02",
      `MAX_SOL_PER_TRADE=${envLine("MAX_SOL_PER_TRADE")}, DAILY_SOL_CAP=${envLine("DAILY_SOL_CAP")}, ` +
      `DAILY_LOSS_LIMIT_SOL=${envLine("DAILY_LOSS_LIMIT_SOL")} (installed 0.02/0.05/0.02)`);
    check("the carried credentials really did land in the new environment (compared, never printed)",
      envLine("CC_SECRET") === FIXTURE.secret && envLine("SOLANA_RPC") === FIXTURE.rpc &&
      envLine("SOLANA_RPC_SECONDARY") === FIXTURE.secondary && envLine("CC_API") === FIXTURE.api,
      `CC_SECRET matches: ${envLine("CC_SECRET") === FIXTURE.secret} (${envLine("CC_SECRET").length} chars), ` +
      `SOLANA_RPC matches: ${envLine("SOLANA_RPC") === FIXTURE.rpc}, ` +
      `SOLANA_RPC_SECONDARY matches: ${envLine("SOLANA_RPC_SECONDARY") === FIXTURE.secondary}, ` +
      `CC_API matches: ${envLine("CC_API") === FIXTURE.api}`);
    check("the burner it kept is the burner that was already there",
      envLine("KEYPAIR") === prior.burner &&
      fs.readFileSync(prior.burner, "utf8") === prior.burnerBytes &&
      out.includes(prior.pubkey),
      `KEYPAIR=${envLine("KEYPAIR")}; keypair bytes unchanged: ${fs.readFileSync(prior.burner, "utf8") === prior.burnerBytes}; ` +
      `address printed: ${prior.pubkey}`);
    /* --dry-run STILL DISARMS. This is the one place an upgrade could quietly do the
       opposite of what was asked: it carries a LIVE environment forward, and if the
       carry outran the mode it would re-arm an executor the operator just asked to
       stand down. EXECUTE must be 0 and no live-only key may survive the rewrite. */
    check("--dry-run still disarms: EXECUTE=0 and no live-only key survives the carry",
      /^EXECUTE="0"$/m.test(envText) && !/LIVE_TRADING_ACK/.test(envText) &&
      !/JUPITER_API_KEY/.test(envText) && /THIS INSTALL IS NOT ARMED/.test(out),
      `${(envText.match(/^EXECUTE=.*$/m) || ["<no EXECUTE line>"])[0]}; ` +
      `live-only keys present: ${JSON.stringify(["LIVE_TRADING_ACK", "JUPITER_API_KEY", "LIVE_CAPS_ACK"].filter((k) => envText.includes(k)))}`);
    check("the environment is still written 0600 and the atomic swap left no temp file",
      (fs.statSync(envPath).mode & 0o777) === 0o600 &&
      fs.readdirSync(box.installDir).filter((f) => /\.next\.|\.previous\./.test(f)).length === 0,
      `mode ${(fs.statSync(envPath).mode & 0o777).toString(8)}; leftovers ` +
      `${JSON.stringify(fs.readdirSync(box.installDir).filter((f) => /\.next\.|\.previous\./.test(f)))}`);
    check("the upgrade path never reached sudo or systemctl",
      !box.calls().some((c) => c.kind === "CALL" && (c.name === "sudo" || c.name === "systemctl")),
      JSON.stringify([...new Set(box.calls().filter((c) => c.kind === "CALL").map((c) => c.name))]));
    check("it still says on screen that the code-path guarantees did not move",
      /still required and still verified: the 40-character published commit/.test(out),
      (out.split("\n").find((l) => /still required and still verified/.test(l)) || "<none>").trim());
  }

  // ── E2: a wrong-mode environment falls through to the existing full path ──
  {
    const box = macSandbox("upgrade-wrongmode");
    seed(box, 0o644);
    const installerCopy = path.join(box.root, "install.sh");
    fs.copyFileSync(path.join(here, "install.sh"), installerCopy);
    const typed = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const run = runOnPty(
      `cd ${shq(box.root)} && bash ${shq(installerCopy)} --floor 14 --dry-run --static https://static.invalid`,
      [typed], { env: box.env });
    const out = run.out;
    const envPath = path.join(box.installDir, ".cc-executor.env");
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const envLine = (key) => (new RegExp(`^${key}="(.*)"$`, "m").exec(envText) || [, "<absent>"])[1];
    check("a mode-644 environment is refused as evidence and the run asks for the secret again",
      run.finished && /is mode 644, not 600/.test(out) &&
      /Claude Company executor feed secret:/.test(out) &&
      /WALL-ST-E installed for floor 14/.test(out),
      `${(out.split("\n").find((l) => /mode 644/.test(l)) || "<no reason printed>").trim()}; ` +
      `secret prompt shown: ${/Claude Company executor feed secret:/.test(out)}`);
    check("and nothing from that untrusted file was carried into the new environment",
      envLine("CC_SECRET") === typed && envLine("SOLANA_RPC") === "<absent>" &&
      envLine("CC_API") !== FIXTURE.api,
      `CC_SECRET is the freshly typed one: ${envLine("CC_SECRET") === typed}; ` +
      `SOLANA_RPC: ${envLine("SOLANA_RPC")}; CC_API carried: ${envLine("CC_API") === FIXTURE.api}`);
    check("the untrusted run leaked no fixture credential either",
      CREDENTIALS.every((value) => !out.includes(value)),
      `credential substrings in ${out.length} bytes of transcript: ` +
      `${CREDENTIALS.filter((v) => out.includes(v)).length}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. The upgrade path did not become a second way around anything
// ─────────────────────────────────────────────────────────────────────────────
{
  check("the published commit is still required and still verified on an upgrade",
    /the published commit must be exactly 40 hexadecimal characters/.test(installer) &&
    /live --expected-commit must exactly match the published commit/.test(installer) &&
    /status --porcelain -- "executor\/\$source_file"/.test(installer) &&
    !/UPGRADE[^\n]*EXPECTED_COMMIT/.test(installer),
    `commit checks referenced by the upgrade path: ${/UPGRADE[^\n]*EXPECTED_COMMIT/.test(installer)}`);
  check("no carried value is ever echoed, printed or logged",
    installer.split("\n").filter((line) => /^\s*(echo|printf|cat)\b/.test(line) &&
      /\$(UPGRADE_VALUE|SECRET|JUPITER_KEY|CRED_VALUE|RPC|SECONDARY_RPC)\b/.test(line)).length === 0,
    `offending lines: ${JSON.stringify(installer.split("\n").filter((line) =>
      /^\s*(echo|printf|cat)\b/.test(line) &&
      /\$(UPGRADE_VALUE|SECRET|JUPITER_KEY|CRED_VALUE|RPC|SECONDARY_RPC)\b/.test(line)))}`);
  check("no carried value is written anywhere but the protected environment",
    !/cred_store[^\n]*\$UPGRADE_VALUE/.test(installer) &&
    (installer.match(/UPGRADE_VALUE/g) || []).length > 0 &&
    !/> *"?\$\{?UPGRADE/.test(installer));
  check("the atomic environment swap and its rollback are still how an upgrade lands",
    /mv -f "\$ENV_NEXT" "\$ENV_FILE"/.test(installer) &&
    /cp -p "\$ENV_FILE" "\$ENV_BACKUP"/.test(installer) &&
    /mv -f "\$ENV_BACKUP" "\$ENV_FILE"/.test(installer));
  check("the carried credential variable is scrubbed at the end like every other one",
    /unset SECRET JUPITER_KEY LIVE_ACK LIVE_CAPS_ACK CAPS_ACK_EXPECTED REPLY CRED_VALUE UPGRADE_VALUE/.test(installer));
  check("--help tells the operator what a re-pin will and will not ask for",
    (() => {
      const help = spawnSync("bash", [path.join(here, "install.sh"), "--help"], { encoding: "utf8" });
      return help.status === 0 && /UPGRADING AN INSTALL THAT IS ALREADY HERE/.test(help.stdout) &&
        /never displayed/.test(help.stdout) && /arm-caps/.test(help.stdout) &&
        Math.max(...help.stdout.split("\n").map((l) => l.length)) <= 80;
    })(),
    (() => {
      const help = spawnSync("bash", [path.join(here, "install.sh"), "--help"], { encoding: "utf8" });
      return `widest line ${Math.max(...(help.stdout || "").split("\n").map((l) => l.length))}`;
    })());
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(fail === 0
  ? "\nThe upgrade path reuses what the operator already gave and widens nothing."
  : `\n${fail} failed — the upgrade path is NOT safe to ship`);



/* ── --reuse-env: THE PRIOR INSTALL IS NOT ALWAYS WHERE THE DEFAULT LOOKS ──────────
 * Added 2026-09-09 from the owner's own machine: his executor's LaunchAgent points at
 * an environment outside $HOME/claudeco-executor, so the carry found nothing and would
 * have asked him for credentials already on his disk — the exact complaint this whole
 * path answers. A named file is held to the identical standard as the default one. */
{
  const named = drive(priorEnv(), { reuseEnvAt: "elsewhere/prior.env" });
  check("--reuse-env carries from a file outside the install directory",
    named.field("UPGRADE") === "1" && named.field("SECRET_CARRIED") === "yes" &&
    named.field("RPC_CARRIED") === "yes" && named.field("JUPITER_CARRIED") === "yes",
    `UPGRADE=${named.field("UPGRADE")} secret=${named.field("SECRET_CARRIED")} rpc=${named.field("RPC_CARRIED")} jupiter=${named.field("JUPITER_CARRIED")}`);
  check("...and names the file it carried from", named.out.includes(named.namedEnv),
    named.out.split("\n").find((l) => /carrying forward/.test(l)) || "<no line>");
  for (const value of CREDENTIALS) {
    check(`...and prints none of the ${value.length}-char credential`, !named.out.includes(value),
      `${named.out.includes(value) ? "LEAKED" : "0 hits"} over ${named.out.length} bytes`);
  }

  const loose = drive(priorEnv(), { reuseEnvAt: "elsewhere/prior.env", mode: 0o644 });
  check("a named environment that is not mode 600 is refused, exactly like the default",
    loose.field("UPGRADE") !== "1" && /mode 644/.test(loose.out),
    `UPGRADE=${loose.field("UPGRADE")} :: ${loose.out.split("\n").find((l) => /mode 644/.test(l)) || "<no line>"}`);

  const gone = drive(null, { reuseEnvAt: "elsewhere/never-written.env" });
  check("a named environment that does not exist falls through and says so",
    gone.field("UPGRADE") !== "1" && /nothing to carry forward/.test(gone.out),
    `UPGRADE=${gone.field("UPGRADE")} :: ${gone.out.split("\n").find((l) => /carry forward/.test(l)) || "<no line>"}`);
}

process.exit(fail === 0 ? 0 : 1);
