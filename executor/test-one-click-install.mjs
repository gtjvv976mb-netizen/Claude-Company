/** The one-command install path: what a stranger meets, and what it must never do.
 *
 * test-install.mjs already pins the published module graph and the live gates. This
 * file covers the barriers removed for non-technical owners — --help, the private
 * Node bootstrap, the credential wizard, the double-click launcher and the Windows
 * message — and it does it by RUNNING them, not by reading them. Shell that is only
 * grepped is shell nobody has executed.
 *
 * Nothing here touches this machine's executor. Most sections are extracted from
 * install.sh and driven on their own inside a throwaway directory, against a file://
 * mirror or a curl stand-in. Section I goes further and runs the WHOLE installer on
 * macOS — the platform this machine also runs the owner's live agent on — so it is
 * sealed on every side that could reach it: a throwaway HOME, a fake $STATIC whose
 * mirror serves recording stand-ins in place of the two lifecycle scripts, and
 * stand-ins on PATH for launchctl, sudo and systemctl. What is asserted is which
 * script would be invoked, with which absolute arguments, in which order.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = fs.readFileSync(path.join(here, "install.sh"), "utf8");
const LAUNCHER = "Install WALL-ST-E.command";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-oneclick-"));

let fail = 0;
const check = (name, condition, actual) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${actual === undefined ? "" : `\n        actual: ${actual}`}`);
  if (!condition) fail++;
};

/** Pull one reviewed block out of install.sh so it can be executed on its own. */
function section(name) {
  const start = installer.indexOf(`# BEGIN ${name}`);
  const end = installer.indexOf(`# END ${name}`);
  if (start < 0 || end < start) throw new Error(`install.sh has no ${name} section`);
  return installer.slice(start, end);
}

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Run a bash script attached to a real pty.
 *
 * The wizard reads from /dev/tty on purpose — that is the property under test, and a
 * pipe has no controlling terminal to read. `script` allocates one. Input is fed
 * after a short delay and stdin is then held open: feeding at t=0 lets the pty reach
 * EOF before the first prompt is even printed, and every read comes back empty.
 * BSD and util-linux `script` take their command in different positions.
 */
function runOnPty(body, lines, { env = {} } = {}) {
  const tag = Math.random().toString(36).slice(2);
  const file = path.join(temp, `pty-${tag}.sh`);
  const done = path.join(temp, `pty-${tag}.done`);
  // `script` exits the moment its own stdin reaches EOF, taking the child with it. A
  // fixed sleep therefore either truncates a slow run or taxes every fast one. The
  // feeder instead holds the pty open until the body says it is finished.
  fs.writeFileSync(file, `${body}\ntouch ${shq(done)}\n`);
  const inner = `bash ${shq(file)}`;
  const scriptCmd = process.platform === "darwin"
    ? `script -q /dev/null ${inner}`
    : `script -q -e -c ${shq(inner)} /dev/null`;
  const feed = lines.length ? `printf '%s\\n' ${lines.map(shq).join(" ")};` : "";
  const hold = `i=0; while [ ! -f ${shq(done)} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done; sleep 0.2`;
  const run = spawnSync("bash", ["-c",
    `(sleep 0.35; ${feed} ${hold}) | ${scriptCmd}`], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 90_000,
  });
  // The pty turns every \n into \r\n; strip so assertions read normally.
  const out = `${run.stdout || ""}${run.stderr || ""}`.replace(/\r/g, "");
  return { ...run, out, finished: fs.existsSync(done) };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. --help
// ─────────────────────────────────────────────────────────────────────────────
{
  const help = spawnSync("bash", [path.join(here, "install.sh"), "--help"], { encoding: "utf8" });
  const text = help.stdout || "";
  check("--help exits 0", help.status === 0, `exit ${help.status}`);
  /* RE-ANCHORED 2026-09-09. This asked --help to say the default was a dry run.
     The owner deleted that stage, so the same paragraph now has to carry the
     opposite warning AND the fact that makes it survivable — the wallet is empty
     and only the operator can fund it. Both are asserted; a --help that announced
     arming without saying funding is separate would be worse than the old one. */
  check("--help says installing arms, that funding is the separate switch, and names the opt-out",
    /INSTALLING ARMS REAL TRADING/.test(text) &&
    /no rehearsal install to do first/i.test(text) &&
    /funding is the switch, not this command/.test(text) &&
    /--dry-run\s+Install without arming/.test(text),
    text.split("\n").find((l) => /INSTALLING ARMS/.test(l)) || "<no arming line>");
  check("--help says where the burner key is written",
    /claudeco-executor\/burner\.json/.test(text) && /0600/.test(text),
    text.split("\n").find((l) => /burner\.json/.test(l)) || "<no burner.json line>");
  /* RE-ANCHORED with the line above: "separate, deliberate act" described the second
     install, which is gone. The acknowledgement it was really guarding did not move,
     so that is what is checked now — inside the one install, on this terminal. */
  check("--help still says the burner's own public key must be retyped before it arms",
    /retype the burner wallet's own public key before it arms/.test(text) &&
    /raising any cap\s+makes you type a second sentence/.test(text),
    text.split("\n").find((l) => /retype the burner wallet/.test(l)) || "<no retype line>");
  const widest = Math.max(...text.split("\n").map((l) => l.length));
  check("--help fits in 80 columns", widest <= 80, `widest line is ${widest} chars`);
  const flags = [...installer.matchAll(/^\s{4}(--[a-z-]+)[|)]/gm)].map((m) => m[1]);
  const undocumented = flags.filter((f) => !text.includes(f));
  check("--help documents every flag the parser accepts",
    undocumented.length === 0, `parser has ${flags.length} flags; missing from --help: ${undocumented.join(", ") || "none"}`);
  check("--help exits before any platform or floor validation",
    help.stderr === "" && !/floor/i.test(help.stderr || ""), `stderr: ${JSON.stringify(help.stderr)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The secret never comes from argv
// ─────────────────────────────────────────────────────────────────────────────
{
  // Behavioural, not textual: hand the installer a --secret flag and watch it refuse
  // the flag itself. A grep for the string proves only that today's spelling is gone.
  for (const flag of ["--secret", "--jupiter-key", "--live-caps-ack", "--caps-ack"]) {
    const run = spawnSync("bash", [path.join(here, "install.sh"), "--floor", "1", flag, "x"], { encoding: "utf8" });
    check(`${flag} is not an accepted flag`,
      run.status !== 0 && /unknown flag: /.test(run.stderr || ""),
      `exit ${run.status}, stderr: ${(run.stderr || "").trim().split("\n")[0]}`);
  }
  const parser = installer.slice(installer.indexOf('while [ "$#" -gt 0 ]; do'),
    installer.indexOf("if [ \"$#\" -gt 0 ]") + 1 || undefined);
  const argvAssigns = [...parser.matchAll(/^\s{4}--[a-z-]+\)[^\n]*?\b(SECRET|JUPITER_KEY|CRED_VALUE)="\$2"/gm)];
  check("no argv case assigns a secret value directly",
    argvAssigns.length === 0, `argv assignments to a secret variable: ${argvAssigns.length}`);
  check("the feed secret is read hidden from the controlling terminal",
    /IFS= read -r -s SECRET < \/dev\/tty/.test(installer));
  check("the wizard's own prompt reads hidden from the controlling terminal",
    /IFS= read -r -s CRED_VALUE < \/dev\/tty/.test(installer));
  // A credential must never reach curl's argv: /proc/PID/cmdline is world-readable.
  check("credential requests travel through curl's stdin config, never its arguments",
    /\| curl --config -/.test(installer) && !/curl[^\n]*"\$CRED_VALUE"/.test(installer));
  const echoed = installer.split("\n").filter((line) =>
    /^\s*(echo|printf)\b/.test(line) && /\$(SECRET|JUPITER_KEY|CRED_VALUE)\b/.test(line));
  check("no echo/printf ever prints a secret variable",
    echoed.length === 0, `offending lines: ${echoed.length ? echoed.join(" | ") : "none"}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Node bootstrap: the checksum is the whole guarantee
// ─────────────────────────────────────────────────────────────────────────────
{
  const fetchSection = section("NODE_FETCH");
  const version = "99.9.9";
  const nodeOs = process.platform === "darwin" ? "darwin" : "linux";
  const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
  const dirName = `node-v${version}-${nodeOs}-${nodeArch}`;
  const hasXz = spawnSync("bash", ["-c", "command -v xz >/dev/null 2>&1"]).status === 0;
  const ext = hasXz ? "tar.xz" : "tar.gz";
  const tarball = `${dirName}.${ext}`;

  // Build a stand-in "official" archive, laid out exactly like nodejs.org's.
  const build = path.join(temp, "build");
  fs.mkdirSync(path.join(build, dirName, "bin"), { recursive: true });
  fs.writeFileSync(path.join(build, dirName, "bin", "node"), "#!/bin/sh\necho v22.23.2\n", { mode: 0o755 });
  const tarFlag = hasXz ? "-cJf" : "-czf";
  spawnSync("tar", [tarFlag, path.join(build, tarball), "-C", build, dirName]);
  const trueSha = spawnSync("bash", ["-c",
    `shasum -a 256 ${shq(path.join(build, tarball))} | awk '{print $1}'`], { encoding: "utf8" }).stdout.trim();

  const mirror = (name, sha) => {
    const root = path.join(temp, name, `v${version}`);
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(build, tarball), path.join(root, tarball));
    // Two spaces between digest and filename, plus a decoy row whose name merely
    // starts with the same text — the awk field match must not take that one.
    fs.writeFileSync(path.join(root, "SHASUMS256.txt"),
      `${"0".repeat(64)}  ${tarball}.asc\n${sha}  ${tarball}\n`);
    return `file://${path.join(temp, name)}`;
  };

  const drive = (base, root) => {
    fs.mkdirSync(root, { recursive: true });
    return spawnSync("bash", ["-c",
      `set -uo pipefail\n${fetchSection}\ninstall_private_node ${shq(version)} ${shq(root)}`],
      { encoding: "utf8", env: { ...process.env, NODE_DIST_BASE: base }, timeout: 60_000 });
  };

  const goodRoot = path.join(temp, "node-good");
  const good = drive(mirror("mirror-good", trueSha), goodRoot);
  const producedPath = (good.stdout || "").trim();
  check("a matching checksum installs the private Node and returns its path",
    good.status === 0 && producedPath === path.join(goodRoot, dirName, "bin", "node") &&
    fs.existsSync(producedPath),
    `exit ${good.status}, path ${producedPath || "<none>"}`);
  check("the verified archive is unpacked and the node binary is executable",
    fs.existsSync(producedPath) && (fs.statSync(producedPath).mode & 0o111) !== 0,
    fs.existsSync(producedPath) ? `mode ${(fs.statSync(producedPath).mode & 0o777).toString(8)}` : "<absent>");
  check("the digest actually verified is the one nodejs.org published for that file",
    good.stderr.includes(trueSha) && /published sha256: [0-9a-f]{64}/.test(good.stderr),
    (good.stderr.split("\n").find((l) => l.includes("published sha256")) || "<none>").trim());

  // Now the same archive against a SHASUMS256.txt that disagrees by one nibble. If
  // the run above had not succeeded, this failure would prove nothing: a function
  // that always aborts also "aborts on mismatch".
  const badRoot = path.join(temp, "node-bad");
  const wrongSha = `${trueSha.slice(0, 63)}${trueSha.endsWith("f") ? "e" : "f"}`;
  const bad = drive(mirror("mirror-bad", wrongSha), badRoot);
  check("a checksum mismatch aborts",
    bad.status !== 0, `exit ${bad.status}`);
  check("the mismatch says so loudly and prints both digests",
    /CHECKSUM MISMATCH/.test(bad.stderr) && bad.stderr.includes(wrongSha) && bad.stderr.includes(trueSha),
    (bad.stderr.split("\n").find((l) => /CHECKSUM MISMATCH/.test(l)) || "<no mismatch banner>").trim());
  check("a mismatch unpacks nothing and leaves no download behind",
    fs.readdirSync(badRoot).length === 0,
    `${badRoot} contains: ${JSON.stringify(fs.readdirSync(badRoot))}`);

  // A SHASUMS file with no row for our exact filename must be treated as a mismatch,
  // not as "nothing to compare against".
  const absentRoot = path.join(temp, "node-absent");
  const absentBase = mirror("mirror-absent", trueSha);
  fs.writeFileSync(path.join(temp, "mirror-absent", `v${version}`, "SHASUMS256.txt"),
    `${trueSha}  some-other-file.tar.gz\n`);
  const absent = drive(absentBase, absentRoot);
  check("a SHASUMS file that does not list this exact filename aborts",
    absent.status !== 0 && /CHECKSUM MISMATCH/.test(absent.stderr) &&
    /no such filename in SHASUMS256\.txt/.test(absent.stderr),
    `exit ${absent.status}`);

  // The private copy must stay private: nothing outside the directory it was handed.
  check("the bootstrap writes only inside the directory it was given",
    !fs.existsSync(path.join(temp, dirName)) && fs.readdirSync(goodRoot).join() === dirName,
    `${goodRoot} contains: ${JSON.stringify(fs.readdirSync(goodRoot))}`);
  const profileWrites = installer.split("\n").filter((l) =>
    /(\.bashrc|\.bash_profile|\.zshrc|\.profile|profile\.d|\/usr\/local\/bin|\/etc\/environment)/.test(l) &&
    />>?\s|install |ln -s|cp /.test(l));
  check("no system Node, PATH file or login profile is ever written",
    profileWrites.length === 0, `lines touching a profile/system path: ${profileWrites.length ? profileWrites.join(" | ") : "none"}`);
  check("the PATH change is process-local and announced on screen",
    /^\s*PATH="\$\(cd "\$\(dirname "\$NODE_BIN"\)" && pwd -P\):\$PATH"$/m.test(installer) &&
    /login PATH and any system Node are untouched/.test(installer),
    (installer.split("\n").find((l) => /^\s*PATH="/.test(l)) || "<no PATH assignment>").trim());
  check("the Node version is pinned in the script, not resolved from a moving alias",
    /^NODE_PINNED_VERSION="\d+\.\d+\.\d+"$/m.test(installer) && !/dist\/latest/.test(installer),
    (installer.split("\n").find((l) => l.startsWith("NODE_PINNED_VERSION=")) || "<none>"));
  // Scoped to the fetch itself: the only "curl … | bash" strings in this file are
  // inside guidance text telling a user to run OUR published installer, which is a
  // different claim from the bootstrap piping somebody else's script into a shell.
  const pipedInFetch = fetchSection.split("\n").filter((l) => /curl[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/.test(l));
  check("the Node bootstrap never pipes anything into a shell",
    pipedInFetch.length === 0 && !/nodesource|nvm\.sh|fnm|volta/.test(installer),
    `piping lines in NODE_FETCH: ${pipedInFetch.length ? pipedInFetch.join(" | ") : "none"}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// D. The credential wizard
// ─────────────────────────────────────────────────────────────────────────────
{
  const wizard = section("CREDENTIAL_WIZARD");

  // A curl stand-in that records exactly what it was called with. It answers 200 for
  // a URL containing "goodkey" and 401 otherwise, so the accept and reject branches
  // are both reachable without a TLS server.
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const curlLog = path.join(temp, "curl-calls.log");
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
{ printf 'ARGV:'; for a in "$@"; do printf ' <%s>' "$a"; done; printf '\\n'; } >> "$CURL_LOG"
config="$(cat)"
printf 'CONFIG:%s\\nEND\\n' "$config" >> "$CURL_LOG"
url="$(printf '%s' "$config" | sed -n 's/^url = "\\(.*\\)"$/\\1/p')"
case "$url" in
  *goodkey*) printf '{"jsonrpc":"2.0","result":{"value":{"blockhash":"1111111111111111"}}}\\n200\\n';;
  *jupgood*) printf '{"inputMint":"So1","outAmount":"9182736"}\\n200\\n';;
  *) printf '{"error":{"code":-32401,"message":"Unauthorized: invalid api key"}}\\n401\\n';;
esac
`, { mode: 0o755 });

  const installDir = path.join(temp, "install-dir");
  const wizardEnv = { PATH: `${bin}:${process.env.PATH}`, CURL_LOG: curlLog };
  const preamble = `set -uo pipefail\nINSTALL_DIR=${shq(installDir)}\n${wizard}\n`;

  // 1. A bad endpoint is rejected and the wizard asks again — three distinct kinds of
  //    wrong, each answered in its own terms, then a clean fail-closed.
  const SECRET_URLS = [
    "http://insecure.example/rpc",
    "https://api.mainnet-beta.solana.com/",
    "https://rpc.example.com/?api-key=SUPERSECRETPRIMARY",
  ];
  const reject = runOnPty(
    `${preamble}if cred_collect "Primary RPC URL (hidden)" cred_check_rpc; then echo "ACCEPTED"; else echo "GAVE_UP=$?"; fi`,
    SECRET_URLS, { env: wizardEnv });
  const prompts = (reject.out.match(/Primary RPC URL \(hidden\): /g) || []).length;
  check("a bad RPC is rejected and the wizard re-prompts, three times, then fails closed",
    prompts === 3 && /GAVE_UP=1/.test(reject.out), `prompts shown: ${prompts}; verdict: ${(reject.out.match(/GAVE_UP=\d|ACCEPTED/) || ["<none>"])[0]}`);
  check("a plain-http endpoint is refused before any network call",
    /must be a full https:\/\/ URL/.test(reject.out));
  check("the free public Solana endpoint is refused with the reason",
    /free public Solana endpoint/.test(reject.out));
  check("a rejecting provider's own words are shown back",
    /rejected — HTTP 401: .*Unauthorized: invalid api key/.test(reject.out),
    (reject.out.split("\n").find((l) => /rejected — HTTP/.test(l)) || "<none>").trim());
  const leaked = SECRET_URLS.filter((u) => reject.out.includes(u));
  check("nothing the user typed is echoed back to the terminal",
    leaked.length === 0, `typed values appearing in the transcript: ${leaked.length ? leaked.join(", ") : "none"}`);

  // 2. The accept branch, plus the file it leaves behind.
  const accept = runOnPty(
    `${preamble}if cred_collect "Primary RPC URL (hidden)" cred_check_rpc; then\n` +
    `  cred_store "$INSTALL_DIR/.rpc-primary" "$CRED_VALUE"\n  echo "ACCEPTED_ON_RETRY"\nfi`,
    ["https://rpc.example.com/?api-key=WRONGONE", "https://rpc.example.com/goodkey/abc"],
    { env: wizardEnv });
  const stored = path.join(installDir, ".rpc-primary");
  const mode = fs.existsSync(stored) ? (fs.statSync(stored).mode & 0o777).toString(8) : "<absent>";
  check("a working RPC is accepted on the retry",
    /ACCEPTED_ON_RETRY/.test(accept.out), (accept.out.match(/ACCEPTED_ON_RETRY/) || ["<not accepted>"])[0]);
  check("the accepted value is written to a 0600 file under the install dir",
    mode === "600", `mode of ${stored}: ${mode}`);
  check("the stored file holds exactly the accepted endpoint",
    fs.existsSync(stored) && fs.readFileSync(stored, "utf8") === "https://rpc.example.com/goodkey/abc\n",
    fs.existsSync(stored) ? `${fs.readFileSync(stored, "utf8").length} bytes, ends with newline: ${fs.readFileSync(stored, "utf8").endsWith("\n")}` : "<absent>");
  check("the accepted endpoint is not echoed either",
    !accept.out.includes("goodkey"), `transcript mentions the key: ${accept.out.includes("goodkey")}`);

  // 3. The probe is a real Solana call, and the credential never reaches argv.
  const log = fs.readFileSync(curlLog, "utf8");
  const argvLines = log.split("\n").filter((l) => l.startsWith("ARGV:"));
  const argvLeaks = argvLines.filter((l) => /rpc\.example\.com|goodkey|SUPERSECRET/.test(l));
  check("every curl invocation passes only --config -",
    argvLines.length > 0 && argvLines.every((l) => l === "ARGV: <--config> <->"),
    `${argvLines.length} calls; distinct argv: ${JSON.stringify([...new Set(argvLines)])}`);
  check("no credential ever appears in curl's argv",
    argvLeaks.length === 0, `argv lines containing an endpoint: ${argvLeaks.length}`);
  check("the RPC probe is a real getLatestBlockhash, not a bare health ping",
    /getLatestBlockhash/.test(log), `probe method seen in the config: ${(log.match(/"method\\?":\\?"(\w+)/) || [])[1] || "<none>"}`);

  // 4. Jupiter: a cheap authenticated quote, keyed by header, naming no wallet.
  const jup = runOnPty(
    `${preamble}CRED_JUPITER_BASE="https://jup.test/jupgood"\n` +
    `if cred_check_jupiter "sk-test-key"; then echo "JUP_OK"; else echo "JUP_FAIL"; fi\n` +
    `CRED_JUPITER_BASE="https://jup.test/bad"\n` +
    `if cred_check_jupiter "sk-test-key"; then echo "BAD_OK"; else echo "BAD_REJECTED"; fi`,
    [], { env: wizardEnv });
  check("a working Jupiter key is accepted and a rejected one is not",
    /JUP_OK/.test(jup.out) && /BAD_REJECTED/.test(jup.out),
    `${(jup.out.match(/JUP_OK|JUP_FAIL/) || ["<none>"])[0]} / ${(jup.out.match(/BAD_OK|BAD_REJECTED/) || ["<none>"])[0]}`);
  const log2 = fs.readFileSync(curlLog, "utf8");
  check("the Jupiter key is sent as a header inside the stdin config, never in argv",
    /header = "x-api-key: sk-test-key"/.test(log2) &&
    !log2.split("\n").filter((l) => l.startsWith("ARGV:")).some((l) => l.includes("sk-test-key")));
  check("the Jupiter probe names no wallet and so cannot be signed",
    /jupgood\/order\?/.test(log2) && !/taker=/.test(log2),
    `probe URL carries a taker: ${/taker=/.test(log2)}`);
  check("the wizard hits the same Jupiter host the executor trades through",
    installer.includes('CRED_JUPITER_BASE="${CRED_JUPITER_BASE:-https://api.jup.ag/swap/v2}"') &&
    fs.readFileSync(path.join(here, "jupiter.mjs"), "utf8").includes('baseUrl = "https://api.jup.ag/swap/v2"'));

  // 5. The scripted route is untouched: the three --*-file flags still short-circuit
  //    the wizard entirely, and no terminal is required for them.
  check("the credential flags still work unchanged for scripted installs",
    /if \[ -z "\$RPC" \]; then/.test(installer) &&
    /if \[ -z "\$SECONDARY_RPC" \]; then/.test(installer) &&
    /if \[ -n "\$JUPITER_KEY_FILE" \]; then\n    read_private_file "Jupiter API key"/.test(installer));
  check("with no terminal, a live install still demands the credential files",
    /--live requires --rpc-file and --secondary-rpc-file so credentials stay out of argv\/history, and there is no terminal here/.test(installer) &&
    /live mode needs --jupiter-key-file when no terminal is available/.test(installer));
  check("the second RPC is explained as a cross-check, not as a spare",
    /compares the answers/.test(installer) &&
    /refuses to\n  trade rather than act on one provider's word/.test(installer) &&
    /This is not a spare/.test(installer),
    (installer.split("\n").find((l) => /This is not a spare/.test(l)) || "<no cross-check explanation>").trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// E. A dry run needs no credentials at all
// ─────────────────────────────────────────────────────────────────────────────
{
  const live = section("LIVE_CREDENTIALS");
  const installDir = path.join(temp, "paper-install-dir");
  const body = `set -uo pipefail\nINSTALL_DIR=${shq(installDir)}\nMODE="paper"\n` +
    `RPC=""; SECONDARY_RPC=""; RPC_FILE=""; SECONDARY_RPC_FILE=""; JUPITER_KEY=""; JUPITER_KEY_FILE=""\n` +
    `${section("CREDENTIAL_WIZARD")}\n${live}\necho "PAPER_REACHED_END"`;
  const paper = runOnPty(body, []);
  check("in paper mode the entire credential block asks for nothing and passes",
    /PAPER_REACHED_END/.test(paper.out) &&
    !/RPC URL|Jupiter API key|LIVE CREDENTIALS/.test(paper.out),
    `transcript: ${JSON.stringify(paper.out.trim().slice(0, 160))}`);
  check("a paper run creates no credential files",
    !fs.existsSync(installDir), `${installDir} exists: ${fs.existsSync(installDir)}`);
  check("every credential prompt lives inside the live guard",
    live.replace(/^# BEGIN LIVE_CREDENTIALS\n/, "").startsWith('if [ "$MODE" = "live" ]; then') &&
    !installer.slice(0, installer.indexOf("# BEGIN LIVE_CREDENTIALS")).includes("cred_collect "),
    `cred_collect calls before the live guard: ${(installer.slice(0, installer.indexOf("# BEGIN LIVE_CREDENTIALS")).match(/cred_collect /g) || []).length}`);
  /* RE-ANCHORED 2026-09-09: the default flipped. What this line is really for is
     that the two modes stay TWO — that a dry run is still reachable, still writes
     EXECUTE=0, and is still the only thing that does. */
  check("the dry run survives as an explicit opt-out and is the only thing that clears EXECUTE",
    /^MODE="live"$/m.test(installer) && /--dry-run\) MODE="paper"/.test(installer) &&
    /EXECUTE_VALUE="0"/.test(installer) && !/^MODE="paper"$/m.test(installer),
    `default ${(installer.match(/^MODE="[a-z]+"$/m) || ["<none>"])[0]}, ` +
    `opt-out ${(installer.match(/--dry-run\)[^\n]*/) || ["<none>"])[0]}`);
  check("going live still costs a typed public key and, for raised caps, a typed sentence",
    /LIVE_ACK" != "\$PUBKEY/.test(installer) && /LIVE_CAPS_ACK" != "\$CAPS_ACK_EXPECTED/.test(installer));
  check("the burner key is still generated locally and never transmitted",
    /generating a dedicated, unfunded burner wallet locally/.test(installer) &&
    !/curl[^\n]*burner\.json/.test(installer) &&
    /chmod 600 "\$INSTALL_DIR\/burner\.json"/.test(installer));
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Windows lands on WSL2, not on an obscure failure
// ─────────────────────────────────────────────────────────────────────────────
{
  const guidance = section("PLATFORM_GUIDANCE");
  const bin = path.join(temp, "winbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "$FAKE_UNAME";; *) echo x86_64;; esac\n`, { mode: 0o755 });
  for (const fake of ["MINGW64_NT-10.0-22631", "MSYS_NT-10.0-19045", "CYGWIN_NT-10.0"]) {
    const run = spawnSync("bash", ["-c", guidance], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_UNAME: fake },
    });
    check(`${fake.split("_")[0]} gets the WSL2 route, not "Linux hosts using systemd only"`,
      run.status === 1 && /wsl --install -d Ubuntu/.test(run.stderr) &&
      /curl -fsSL https:\/\/claudedotcompany\.com\/install\.sh \| bash -s -- --floor/.test(run.stderr) &&
      !/provisions Linux hosts using systemd only/.test(run.stderr),
      `exit ${run.status}, first line: ${(run.stderr || "").trim().split("\n")[0]}`);
  }
  /* RE-ANCHORED: the WSL2 route no longer installs a dry run, so it can no longer
     say it does. What a Windows reader must still be told is where the money risk
     actually starts, and that is the transfer they make afterwards. */
  check("the WSL2 guidance says the install arms and that the wallet stays empty until funded",
    /That install arms the bot/.test(guidance) &&
    /empty until you fund it yourself/.test(guidance),
    (guidance.split("\n").find((l) => /arms the bot/.test(l)) || "<none>").trim());
  // A Mac used to be told to go and find a Linux box. Section I drives what it gets
  // now; all this needs to say is that the gate itself no longer turns one away.
  check("the gate names Windows as the only unsupported desktop, not macOS",
    /Windows has no systemd/.test(guidance) && !/On a Mac/.test(guidance));
}

// ─────────────────────────────────────────────────────────────────────────────
// G. The double-click launcher
// ─────────────────────────────────────────────────────────────────────────────
{
  const launcher = path.join(here, LAUNCHER);
  const exists = fs.existsSync(launcher);
  check(`${LAUNCHER} exists`, exists, launcher);
  if (exists) {
    const mode = fs.statSync(launcher).mode & 0o777;
    check("the launcher is executable in the repo, so a download can be double-clicked",
      (mode & 0o111) === 0o111, `mode ${mode.toString(8)}`);
    const syntax = spawnSync("bash", ["-n", launcher], { encoding: "utf8" });
    check("the launcher parses", syntax.status === 0, `bash -n exit ${syntax.status} ${syntax.stderr || ""}`.trim());
    const body = fs.readFileSync(launcher, "utf8");
    /* RE-ANCHORED 2026-09-09. This used to require the launcher to promise that
       nothing is traded. install.sh arms by default now, so that promise would be a
       lie — and a double-clickable file that arms a trading bot has to say so in the
       plainest words it has. The protection the old line stood for is unchanged and
       is asserted right below it: the launcher still passes nothing but a floor. */
    check("the launcher says plainly that this trades real money and that funding is the switch",
      /trades REAL MONEY/.test(body) && /It does not fund anything/.test(body) &&
      /That transfer is the on switch/.test(body),
      (body.split("\n").find((l) => /REAL MONEY/.test(l)) || "<no real-money line>").trim());
    /* Read the INVOCATION, not the file. A grep over the whole script for "api key"
       now matches the launcher's own explanation of what install.sh will ask for —
       the words a reader needs are not the words a shell runs. What must be true is
       narrower and stronger: there is exactly one line that executes the installer,
       and its arguments are a floor number and nothing else. */
    const invocations = body.split("\n").filter((l) => !/^\s*#/.test(l) && /install\.sh"? --/.test(l));
    const args = invocations.join(" ").match(/--[a-z-]+/g) || [];
    check("exactly one line runs the installer, and it passes a floor and nothing else",
      invocations.length === 1 && args.join(",") === "--floor" &&
      !/secret|jupiter|rpc|max-sol|daily/i.test(invocations[0] || ""),
      `invocations: ${JSON.stringify(invocations.map((l) => l.trim()))}; flags: ${JSON.stringify(args)}`);
    check("the launcher runs the same published one-liner, not a second installer",
      /\$STATIC\/install\.sh/.test(body) && /bash "\$TMP\/install\.sh" --floor "\$FLOOR"/.test(body));
    check("the launcher shows a checksum the user can compare with the site",
      /shasum -a 256/.test(body) && /Compare that with the value shown/.test(body));

    // Drive it end to end against a file:// copy of the REAL installer, so the
    // checksum assertion below means something. This used to be safe on a Mac only
    // because install.sh refused Darwin outright; now that it does not, the run is
    // sealed instead — a throwaway HOME, a launchctl stand-in, and no feed secret
    // fed to it, so install.sh reaches its hidden prompt and stops there, before it
    // creates a directory, a wallet or an environment.
    const site = path.join(temp, "site");
    const launcherHome = path.join(temp, "launcher-home");
    const launcherBin = path.join(temp, "launcher-bin");
    for (const dir of [site, launcherHome, launcherBin]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(here, "install.sh"), path.join(site, "install.sh"));
    fs.writeFileSync(path.join(launcherBin, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    // Six lines, because the launcher is no longer the last thing that asks: Return,
    // a bad floor, a good floor, Return to run — and then install.sh's own hidden
    // secret prompt, which an empty answer ends, and finally Return to close. Feeding
    // only the first four deadlocks the pty against that prompt.
    /* Six fed lines, same as before: Return, a bad floor, a good floor, Return to
       run — and then install.sh's own first question, which is now the published
       commit rather than the feed secret, and finally Return to close. An empty
       answer to that question is what stops this run before it creates anything. */
    const run = runOnPty(`STATIC=${shq(`file://${site}`)} bash ${shq(launcher)}`,
      ["", "notanumber", "14", "", "", ""],
      { env: { HOME: launcherHome, PATH: `${launcherBin}:${process.env.PATH}` } });
    check("the launcher explains itself, insists on a numeric floor, and reaches a LIVE install.sh",
      /trades REAL MONEY/.test(run.out) && /That is not a number/.test(run.out) &&
      /SHA-256 of the downloaded installer:\n    [0-9a-f]{64}/.test(run.out) &&
      /installing WALL-ST-E \(live mode\)/.test(run.out) &&
      !/provisions Linux hosts using systemd only/.test(run.out),
      `transcript ${run.out.length} chars; mode line: ` +
      `${(run.out.split("\n").find((l) => /installing WALL-ST-E/.test(l)) || "<none>").trim()}`);
    check("with no commit typed, that live install refuses instead of installing anything",
      /must be exactly 40 hexadecimal characters/.test(run.out) &&
      !fs.existsSync(path.join(launcherHome, "claudeco-executor", "burner.json")),
      `refusal: ${JSON.stringify((run.out.split("\n").find((l) => /40 hexadecimal/.test(l)) || "<none>").trim())}`);
    check("on a Mac the launcher no longer warns that the installer targets Linux",
      !/provisions Linux hosts|systemd service|Linux VPS/.test(body) &&
      /per-user LaunchAgent called/.test(body),
      (body.split("\n").find((l) => /LaunchAgent/.test(l)) || "<no LaunchAgent line>").trim());
    const realSha = spawnSync("bash", ["-c", `shasum -a 256 ${shq(path.join(here, "install.sh"))} | awk '{print $1}'`],
      { encoding: "utf8" }).stdout.trim();
    check("the checksum it shows is the checksum of the bytes it is about to run",
      run.out.includes(realSha), `installer sha256 ${realSha}; shown: ${run.out.includes(realSha)}`);
    /* The installer it reached must have stopped at its FIRST question, having
       created nothing — in the sandbox home it was given, and above all in the real
       one. That first question used to be the feed secret; a live install asks for
       the published commit before it asks for anything else, so the refusal that
       proves this run went no further is that one. */
    check("the launcher's run ended on its own rather than being cut off",
      run.finished, `finished ${run.finished}`);
    check("nothing was installed, in the sandbox home or this machine's own",
      !fs.existsSync(path.join(os.homedir(), "claudeco-executor")) &&
      !fs.existsSync(path.join(launcherHome, "claudeco-executor")) &&
      /must be exactly 40 hexadecimal characters/.test(run.out),
      `real home: ${fs.existsSync(path.join(os.homedir(), "claudeco-executor"))}, ` +
      `sandbox home: ${JSON.stringify(fs.readdirSync(launcherHome))}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I. macOS is a supported host, and the proof is a sealed end-to-end run
// ─────────────────────────────────────────────────────────────────────────────
/* This machine runs the repo owner's LIVE executor as LaunchAgent
 * com.claudeco.wallste, with real money in a real wallet. Nothing in this file may
 * come near it, so the whole macOS path is driven inside a redirected world:
 *
 *   HOME            a throwaway directory, so $HOME/claudeco-executor is a sandbox
 *   $STATIC         a fake origin; a curl stand-in serves a local mirror
 *   launchctl       a stand-in on PATH that records the call and reports "not loaded"
 *   macos-*.sh      recording stand-ins IN THE MIRROR, so the installer downloads and
 *                   invokes them exactly as it would in production while nothing is
 *                   installed, enabled, bootstrapped or started
 *   sudo, systemctl tripwires: if the macOS path ever reaches one, the test fails
 *
 * That gives what actually needs proving — WHICH script is invoked, with WHICH
 * absolute arguments, in WHICH order — without executing any of it.
 */
const SEP = "\u001f";  // a unit separator: it cannot occur in a path or a flag

/** Every stand-in appends its own argv, one line per call, plus what it observed. */
const recorder = (extra = "") => `#!/bin/sh
{
  printf 'CALL${SEP}%s' "$(basename "$0")"
  for a in "$@"; do printf '${SEP}%s' "$a"; done
  printf '\\n'
} >> "$WALLSTE_REC"
${extra}
`;

function readCalls(recFile) {
  if (!fs.existsSync(recFile)) return [];
  return fs.readFileSync(recFile, "utf8").split("\n").filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    return { kind: parts[0], name: parts[1], args: parts.slice(2) };
  });
}

/** The files install.sh itself says it stages, read out of install.sh so this mirror
 *  can never drift from the list the installer actually asks the site for. */
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
  for (const file of stagedFileNames()) {
    fs.copyFileSync(path.join(here, file), path.join(mirror, file));
  }

  // The two lifecycle scripts are replaced IN THE MIRROR rather than intercepted
  // later, so install.sh resolves and invokes them by exactly the path it would use
  // on a real Mac. The macos-release.sh stand-in also materializes the versioned
  // release its real counterpart would produce, so the load that follows is driven
  // against a real directory layout.
  fs.writeFileSync(path.join(mirror, "macos-launchagent.sh"), recorder(`
# Record the world as it stands AT THE MOMENT OF THE CALL, not afterwards: whether
# the burner already exists here is the ordering claim under test.
if [ -f "$WALLSTE_INSTALL_DIR/burner.json" ]; then seen=present; else seen=absent; fi
printf 'STATE${SEP}launchagent-%s${SEP}burner=%s\\n' "$1" "$seen" >> "$WALLSTE_REC"
echo "stand-in macos-launchagent.sh: $1 (nothing was installed, enabled or started)"
exit 0
`));
  fs.writeFileSync(path.join(mirror, "macos-release.sh"), recorder(`
command="$1"; shift
commit=""; releases=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-commit) commit="$2"; shift 2;;
    --releases-dir) releases="$2"; shift 2;;
    *) shift 2 || shift;;
  esac
done
if [ "$command" = "stage" ] && [ -n "$releases" ] && [ -n "$commit" ]; then
  mkdir -p "$releases/$commit/executor"
  cp "$WALLSTE_MIRROR/macos-launchagent.sh" "$releases/$commit/executor/macos-launchagent.sh"
fi
echo "stand-in macos-release.sh: $command (nothing was staged, bound or started)"
exit 0
`));

  const write = (file, body) => fs.writeFileSync(path.join(bin, file), body, { mode: 0o755 });
  write("uname", `#!/bin/sh\ncase "\${1:-}" in -m) echo arm64;; *) echo Darwin;; esac\n`);
  // The installer fetches only "$STATIC/executor/<name> -o <path>". Serve the mirror
  // and refuse anything else, so an unexpected network call fails loudly.
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
  // No network here. Link the lock-pinned tree that is already installed beside this
  // test so the burner generator and the journal initializer can load @solana/web3.js.
  write("npm", `${recorder()}
[ -e node_modules ] || ln -s "$WALLSTE_NODE_MODULES" node_modules
exit 0
`);
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

{
  // The platform gate on its own: what a Mac is told before anything else happens.
  const guidance = section("PLATFORM_GUIDANCE");
  const bin = path.join(temp, "macbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo Darwin;; *) echo arm64;; esac\n`, { mode: 0o755 });
  const run = spawnSync("bash", ["-c", `${guidance}\necho "PLATFORM=$PLATFORM"`], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  check("Darwin is no longer refused by the platform gate",
    run.status === 0 && /PLATFORM=darwin/.test(run.stdout) &&
    !/provisions Linux hosts using systemd only/.test(run.stderr) &&
    !/no one-command fresh install/.test(run.stderr),
    `exit ${run.status}, stdout ${JSON.stringify(run.stdout.trim())}, stderr ${JSON.stringify(run.stderr.trim())}`);
  check("the refusal that used to send Mac owners to a Linux VPS is gone from install.sh",
    !/provisions Linux hosts using systemd only/.test(installer) &&
    !/there is no one-command fresh install/.test(installer) &&
    !/it is not a fresh-wallet installer/.test(installer));
  check("a host that is neither Linux nor macOS is still named and refused",
    /supports Linux \(systemd\) and macOS \(launchd\)/.test(guidance));
}

if (!macCapable) {
  console.log(`SKIP  the sealed macOS end-to-end run (needs darwin + executor/node_modules; this is ${process.platform})`);
} else {
  const box = macSandbox("mac-dryrun");
  const secret = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  // A COPY with no sibling runtime, which is exactly what `curl | bash` leaves: given
  // poller.mjs beside it, install.sh adopts that directory as a pinned local checkout
  // and would stage — and then RUN — the repo's real lifecycle scripts, which on this
  // machine talk to the owner's live agent. Nothing here may reach them.
  const installerCopy = path.join(box.root, "install.sh");
  fs.copyFileSync(path.join(here, "install.sh"), installerCopy);
  check("the sandbox is sealed: the lifecycle scripts it will serve are stand-ins",
    !fs.existsSync(path.join(box.root, "poller.mjs")) &&
    ["macos-launchagent.sh", "macos-release.sh"].every((f) =>
      fs.readFileSync(path.join(box.mirror, f), "utf8").includes("WALLSTE_REC") &&
      fs.readFileSync(path.join(box.mirror, f), "utf8") !== fs.readFileSync(path.join(here, f), "utf8")),
    `mirror: ${JSON.stringify(fs.readdirSync(box.mirror).filter((f) => f.endsWith(".sh")))}`);
  /* --dry-run IS NOW EXPLICIT HERE, AND THAT IS THE ONLY CHANGE TO THIS SECTION.
     What it measures has never been the default mode: it is the macOS orchestration —
     which script is invoked, with which absolute arguments, in which order, and that
     no sudo or systemctl is ever reached. A default install arms, and an armed install
     is exactly what must not run inside a sandbox on the machine that hosts the
     owner's live agent: it would clone a pinned commit, walk the credential wizard
     against real providers, and demand an acknowledgement no feeder can know. The
     flip of the default is pinned in section E and driven against a Git fixture in
     test-install.mjs; this run stays the adoption test it was written to be. */
  const run = runOnPty(
    `cd ${shq(box.root)} && bash ${shq(installerCopy)} --floor 14 --dry-run --static https://static.invalid`,
    [secret], { env: box.env });
  const out = run.out;
  const calls = box.calls();
  const named = (script, command) => calls.find((c) =>
    c.kind === "CALL" && c.name === script && c.args[0] === command);
  const flag = (call, name) => {
    const at = call ? call.args.indexOf(name) : -1;
    return at >= 0 ? call.args[at + 1] : undefined;
  };

  check("a Darwin install runs to completion instead of exiting at a platform gate",
    run.finished && /WALL-ST-E installed for floor 14 in PAPER mode/.test(out) &&
    !/provisions Linux hosts using systemd only/.test(out),
    `finished ${run.finished}; last line: ${JSON.stringify((out.trim().split("\n").pop() || "").slice(0, 160))}`);
  check("it says on screen that launchd, not systemd, is supervising",
    /supervisor: launchd \(per-user LaunchAgent com\.claudeco\.wallste\)/.test(out),
    (out.split("\n").find((l) => /supervisor:/.test(l)) || "<none>").trim());

  const installCall = named("macos-launchagent.sh", "install");
  const loadCall = named("macos-launchagent.sh", "load");
  check("the LaunchAgent is installed and then loaded by macos-launchagent.sh itself",
    Boolean(installCall) && Boolean(loadCall) &&
    calls.indexOf(installCall) < calls.indexOf(loadCall),
    `calls: ${JSON.stringify(calls.filter((c) => c.kind === "CALL" && /^macos-/.test(c.name)).map((c) => `${c.name} ${c.args[0]}`))}`);
  for (const [label, call] of [["install", installCall], ["load", loadCall]]) {
    const envFile = flag(call, "--env-file");
    const dir = flag(call, "--executor-dir");
    check(`macos-launchagent.sh ${label} is handed absolute --env-file and --executor-dir`,
      typeof envFile === "string" && envFile.startsWith("/") &&
      typeof dir === "string" && dir.startsWith("/") &&
      envFile === path.join(box.installDir, ".cc-executor.env"),
      `--env-file ${envFile} · --executor-dir ${dir}`);
  }
  const loadedDir = flag(loadCall, "--executor-dir");
  check("the runtime directory handed to launchd really holds the runtime it will start",
    Boolean(loadedDir) &&
    ["poller.mjs", "launchd-runner.mjs", "macos-launchagent.sh"].every((f) =>
      fs.existsSync(path.join(loadedDir, f))),
    `${loadedDir} contains: ${JSON.stringify(loadedDir && fs.existsSync(loadedDir) ? fs.readdirSync(loadedDir).slice(0, 14) : [])}`);

  // Ordering, observed by the stand-in at the moment it was called rather than
  // inferred from the transcript afterwards.
  const states = calls.filter((c) => c.kind === "STATE");
  check("the burner wallet exists before the agent is ever installed or loaded",
    states.length === 2 && states.every((s) => s.args[0] === "burner=present"),
    `observed: ${JSON.stringify(states.map((s) => `${s.name} ${s.args[0]}`))}`);
  const burner = path.join(box.installDir, "burner.json");
  check("the burner is a local 0600 file and its address is printed for funding",
    fs.existsSync(burner) && (fs.statSync(burner).mode & 0o777) === 0o600 &&
    /DEDICATED WALLET \(PUBLIC ADDRESS\):\n\s+[1-9A-HJ-NP-Za-km-z]{32,44}/.test(out),
    fs.existsSync(burner) ? `mode ${(fs.statSync(burner).mode & 0o777).toString(8)}` : "<no burner.json>");

  const envPath = path.join(box.installDir, ".cc-executor.env");
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  check("the environment file is written 0600 and an unarmed install writes EXECUTE=0",
    fs.existsSync(envPath) && (fs.statSync(envPath).mode & 0o777) === 0o600 &&
    /^EXECUTE="0"$/m.test(envText) && !/LIVE_TRADING_ACK/.test(envText) &&
    !/JUPITER_API_KEY/.test(envText),
    fs.existsSync(envPath)
      ? `mode ${(fs.statSync(envPath).mode & 0o777).toString(8)}, ${(envText.match(/^EXECUTE=.*$/m) || ["<no EXECUTE line>"])[0]}`
      : "<no environment file>");
  /* RE-ANCHORED: arming is no longer "later", and it is no longer another install.
     The closing text has to say so — the same command minus --dry-run — and it must
     still name the acknowledgement and the fact that nothing was funded. */
  check("the unarmed install says it is unarmed and that arming is the same command again",
    /THIS INSTALL IS NOT ARMED, because you asked for --dry-run\. EXECUTE=0/.test(out) &&
    /Arming it is the SAME command without --dry-run/.test(out) &&
    /--expected-commit <PUBLISHED_COMMIT_SHA>/.test(out) &&
    /retype/.test(out) && /No wallet was funded/.test(out) &&
    !/git clone https:\/\/github\.com/.test(out),
    (out.split("\n").find((l) => /NOT ARMED/.test(l)) || "<no unarmed line>").trim());

  // The whole reason the secret is read from /dev/tty. One grep over every argument
  // every stand-in saw, plus the transcript the user would be looking at.
  const everyArg = calls.flatMap((c) => c.args).join("\n");
  check("the feed secret never appears in any recorded argv",
    !everyArg.includes(secret),
    `in argv: ${everyArg.includes(secret)}; ${calls.length} recorded calls, ` +
    `${everyArg.length} bytes of arguments`);
  /* And it is never echoed back. Measured from the prompt onward, deliberately: the
     feeder types ahead of a prompt that only appears seconds later, and until then the
     tty's own line discipline is still echoing, so a plain out.includes(secret) is a
     coin flip on this harness — it passed one run and failed the next with no change
     to install.sh. What install.sh is actually responsible for is everything from the
     moment it takes the terminal: the read must not echo, and no later line may print
     the value back. */
  const promptAt = out.indexOf("Claude Company executor feed secret:");
  check("from the prompt onward the secret is never echoed or printed back",
    promptAt >= 0 && !out.slice(promptAt).includes(secret),
    `prompt at ${promptAt}; secret after it: ${promptAt >= 0 && out.slice(promptAt).includes(secret)}`);
  check("the macOS path never reaches sudo or systemctl",
    !calls.some((c) => c.kind === "CALL" && (c.name === "sudo" || c.name === "systemctl")),
    JSON.stringify([...new Set(calls.filter((c) => c.kind === "CALL").map((c) => c.name))]));
  check("the installer's only launchd contact is a read-only check for an agent already loaded",
    calls.filter((c) => c.kind === "CALL" && c.name === "launchctl")
      .every((c) => c.args[0] === "print"),
    JSON.stringify(calls.filter((c) => c.kind === "CALL" && c.name === "launchctl").map((c) => c.args.join(" "))));
}

// ─────────────────────────────────────────────────────────────────────────────
// J. Adoption is delegated, and it is delegated with absolute paths
// ─────────────────────────────────────────────────────────────────────────────
/* macos-release.sh refuses a relative --env-file or --legacy-workdir, and the reason
 * it refuses is an incident: relative arguments resolved against whatever directory
 * the caller happened to be in. Drive the reviewed activation block from a directory
 * that is deliberately NOT the workdir and read back what the two scripts were sent.
 */
{
  const activation = section("DARWIN_ACTIVATION");
  const root = path.join(temp, "mac-activation");
  const work = path.join(root, "install");
  const release = path.join(root, "release");
  const source = path.join(root, "checkout", "executor");
  const versioned = path.join(root, "versioned");
  const rec = path.join(root, "calls.log");
  for (const dir of [work, release, source, versioned]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rec, "");
  const commit = "a".repeat(40);
  const envFile = path.join(work, ".cc-executor.env");
  fs.writeFileSync(envFile, 'EXECUTE="0"\n', { mode: 0o600 });
  const stub = recorder(`
if [ "$1" = "stage" ]; then
  mkdir -p ${shq(path.join(versioned, commit, "executor"))}
  cp "$0" ${shq(path.join(versioned, commit, "executor", "macos-launchagent.sh"))}
fi
exit 0
`);
  fs.writeFileSync(path.join(release, "macos-launchagent.sh"), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(source, "macos-release.sh"), stub, { mode: 0o755 });

  const drive = (args) => {
    fs.writeFileSync(rec, "");
    const run = spawnSync("bash", ["-c",
      `set -uo pipefail\ncd /\nPAUSE_FILE=${shq(path.join(work, "PAUSE_ENTRIES"))}\n` +
      `ACTIVATION_COMMITTED=0\n${activation}\n` +
      `darwin_activate ${args.map(shq).join(" ")} || exit 9\n` +
      `echo "ACTIVATION_COMMITTED=$ACTIVATION_COMMITTED"`],
      { encoding: "utf8", env: { ...process.env, WALLSTE_REC: rec }, timeout: 60_000 });
    return { run, calls: readCalls(rec) };
  };

  const live = drive([release, envFile, work, commit, "live", versioned, source]);
  const releaseCalls = live.calls.filter((c) => c.kind === "CALL" && c.name === "macos-release.sh");
  const absoluteFlag = (call, name) => {
    const at = call.args.indexOf(name);
    return at >= 0 && typeof call.args[at + 1] === "string" && call.args[at + 1].startsWith("/");
  };
  check("a live macOS adoption goes through macos-release.sh stage and then install",
    live.run.status === 0 &&
    releaseCalls.map((c) => c.args[0]).join(",") === "stage,install",
    `exit ${live.run.status}, macos-release.sh commands: ${JSON.stringify(releaseCalls.map((c) => c.args[0]))}, stderr ${JSON.stringify((live.run.stderr || "").trim().slice(0, 200))}`);
  check("macos-release.sh is handed absolute --env-file and --legacy-workdir every time",
    releaseCalls.length === 2 &&
    releaseCalls.every((c) => absoluteFlag(c, "--env-file") && absoluteFlag(c, "--legacy-workdir")),
    JSON.stringify(releaseCalls.map((c) => c.args.join(" "))));
  check("it is also handed an absolute release location and the exact 40-character commit",
    releaseCalls.length === 2 &&
    releaseCalls.every((c) => absoluteFlag(c, "--releases-dir") || absoluteFlag(c, "--release-dir")) &&
    releaseCalls.every((c) => c.args.includes(commit)),
    JSON.stringify(releaseCalls.map((c) => c.args.join(" "))));
  check("the versioned install first creates the entry-pause sentinel it gates on",
    fs.existsSync(path.join(work, "PAUSE_ENTRIES")),
    `${path.join(work, "PAUSE_ENTRIES")} exists: ${fs.existsSync(path.join(work, "PAUSE_ENTRIES"))}`);
  const loaded = live.calls.find((c) =>
    c.kind === "CALL" && c.name === "macos-launchagent.sh" && c.args[0] === "load");
  check("the agent that is finally loaded is the versioned release macos-release.sh bound",
    Boolean(loaded) && (loaded.args[loaded.args.indexOf("--executor-dir") + 1] || "")
      .startsWith(path.join(versioned, commit)),
    loaded ? loaded.args.join(" ") : "<no load call>");
  check("the journal rollback boundary closes before the agent starts, not before it is installed",
    /ACTIVATION_COMMITTED=1/.test(live.run.stdout) &&
    activation.indexOf("ACTIVATION_COMMITTED=1") > activation.indexOf('bash "$controller" install'),
    (live.run.stdout.split("\n").find((l) => l.startsWith("ACTIVATION_COMMITTED=")) || "<none>"));

  const paper = drive([release, envFile, work, "remote-paper", "paper", versioned, source]);
  check("a dry run adopts through the LaunchAgent controller and never calls macos-release.sh",
    paper.run.status === 0 &&
    !paper.calls.some((c) => c.kind === "CALL" && c.name === "macos-release.sh") &&
    paper.calls.filter((c) => c.kind === "CALL").map((c) => c.args[0]).join(",") === "install,load",
    `exit ${paper.run.status}, calls: ${JSON.stringify(paper.calls.filter((c) => c.kind === "CALL").map((c) => `${c.name} ${c.args[0]}`))}`);
  check("macos-release.sh's own EXECUTE=1 gate is recorded verbatim where install.sh skips it",
    /versioned live adoption requires EXECUTE=1/.test(activation) &&
    /Measured 2026-09-06 by running its validator/.test(activation),
    (activation.split("\n").find((l) => /EXECUTE=1/.test(l)) || "<no recorded gate>").trim());

  const relative = drive([release, ".cc-executor.env", work, commit, "live", versioned, source]);
  check("a relative --env-file is refused before either script is invoked",
    relative.run.status !== 0 &&
    /--env-file must be an absolute path/.test(relative.run.stderr) &&
    relative.calls.length === 0,
    `exit ${relative.run.status}, ${relative.calls.length} scripts invoked, stderr ${JSON.stringify(relative.run.stderr.trim())}`);
  const relWork = drive([release, envFile, "install", commit, "live", versioned, source]);
  check("a relative --legacy-workdir is refused before either script is invoked",
    relWork.run.status !== 0 &&
    /--legacy-workdir must be an absolute path/.test(relWork.run.stderr) &&
    relWork.calls.length === 0,
    `exit ${relWork.run.status}, ${relWork.calls.length} scripts invoked`);
}

// ─────────────────────────────────────────────────────────────────────────────
// K. A Mac bootstraps the Mac build of Node, verified the same way
// ─────────────────────────────────────────────────────────────────────────────
{
  const fetchSection = section("NODE_FETCH");
  const version = "98.7.6";
  const root = path.join(temp, "mac-node");
  const bin = path.join(root, "bin");
  const target = path.join(root, "runtime");
  const build = path.join(root, "build");
  const dirName = `node-v${version}-darwin-arm64`;
  for (const dir of [bin, target, build]) fs.mkdirSync(dir, { recursive: true });
  // Force the platform AND hide xz, so the archive name is fully determined here.
  fs.writeFileSync(path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -m) echo arm64;; *) echo Darwin;; esac\n`, { mode: 0o755 });
  const hasXz = spawnSync("bash", ["-c", "command -v xz >/dev/null 2>&1"]).status === 0;
  const ext = hasXz ? "tar.xz" : "tar.gz";
  const tarball = `${dirName}.${ext}`;
  fs.mkdirSync(path.join(build, dirName, "bin"), { recursive: true });
  fs.writeFileSync(path.join(build, dirName, "bin", "node"), "#!/bin/sh\necho v22.23.2\n", { mode: 0o755 });
  spawnSync("tar", [hasXz ? "-cJf" : "-czf", path.join(build, tarball), "-C", build, dirName]);
  const sha = spawnSync("bash", ["-c",
    `shasum -a 256 ${shq(path.join(build, tarball))} | awk '{print $1}'`], { encoding: "utf8" }).stdout.trim();
  const mirrorRoot = path.join(root, "dist");
  fs.mkdirSync(path.join(mirrorRoot, `v${version}`), { recursive: true });
  fs.copyFileSync(path.join(build, tarball), path.join(mirrorRoot, `v${version}`, tarball));
  // A decoy row for the Linux build whose digest would not verify: picking the wrong
  // platform must fail loudly rather than quietly install the wrong bytes.
  fs.writeFileSync(path.join(mirrorRoot, `v${version}`, "SHASUMS256.txt"),
    `${"0".repeat(64)}  node-v${version}-linux-x64.${ext}\n${sha}  ${tarball}\n`);

  const run = spawnSync("bash", ["-c",
    `set -uo pipefail\n${fetchSection}\ninstall_private_node ${shq(version)} ${shq(target)}`], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_DIST_BASE: `file://${mirrorRoot}` },
  });
  const produced = (run.stdout || "").trim();
  check("a Darwin host selects, verifies and unpacks the darwin build of Node",
    run.status === 0 && produced === path.join(target, dirName, "bin", "node") &&
    fs.existsSync(produced) && /darwin-arm64/.test(run.stderr) && !/linux/.test(produced),
    `exit ${run.status}, produced ${produced || "<none>"}, stderr ${JSON.stringify((run.stderr || "").trim().slice(-200))}`);
  check("the digest it checked is the published row for the darwin archive, not the linux one",
    run.stderr.includes(sha) && !run.stderr.includes("0".repeat(64)),
    (run.stderr.split("\n").find((l) => /published sha256/.test(l)) || "<none>").trim());
  check("the private Node lands under the install directory and nowhere else",
    fs.readdirSync(target).join() === dirName,
    `${target} contains ${JSON.stringify(fs.readdirSync(target))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// L. macOS shell reality: /bin/bash is 3.2 and BSD mv has no -T
// ─────────────────────────────────────────────────────────────────────────────
/* Both of these were live defects on the new macOS path. ${MODE^^} is a bash-4
 * expansion and stock macOS ships bash 3.2, where it is a runtime "bad substitution"
 * — the installer would have died at its own final banner. And BSD mv has no -T:
 * measured on this machine, `mv -f next current` where current is a symlink to a
 * directory left current pointing at the OLD release and moved the new link inside
 * it, silently. `bash -n` cannot see either one, so both are executed here.
 */
{
  const bashFour = installer.split("\n")
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => !/^\s*#/.test(line) &&
      (/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/.test(line) || /\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/.test(line)));
  check("install.sh uses no bash-4-only expansion that stock macOS bash 3.2 cannot run",
    bashFour.length === 0,
    bashFour.length ? bashFour.map(([n, l]) => `line ${n}: ${l.trim()}`).join(" | ") : "none");
  const codeLines = installer.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check("the current-release symlink is never swapped with a flag BSD mv does not have",
    !/\bmv\s+-[a-zA-Z]*T/.test(codeLines) &&
    installer.includes('activate_symlink "$LINK_NEXT" "$CURRENT_LINK"') &&
    installer.includes('activate_symlink "$LINK_RESTORE" "$CURRENT_LINK"'),
    (codeLines.split("\n").filter((l) => /\bmv\s+-/.test(l)).map((l) => l.trim()).join(" | ") || "no mv flags at all"));

  // Drive the swap for real, on this machine's own rename/mv semantics.
  const swapRoot = path.join(temp, "symlink-swap");
  fs.mkdirSync(path.join(swapRoot, "old"), { recursive: true });
  fs.mkdirSync(path.join(swapRoot, "new"), { recursive: true });
  fs.symlinkSync(path.join(swapRoot, "old"), path.join(swapRoot, "current"));
  fs.symlinkSync(path.join(swapRoot, "new"), path.join(swapRoot, "next"));
  const swap = spawnSync("bash", ["-c",
    `set -euo pipefail\nNODE_BIN=${shq(process.execPath)}\n${section("SYMLINK_ACTIVATION")}\n` +
    `activate_symlink ${shq(path.join(swapRoot, "next"))} ${shq(path.join(swapRoot, "current"))}`],
    { encoding: "utf8" });
  const landed = fs.existsSync(path.join(swapRoot, "current"))
    ? fs.readlinkSync(path.join(swapRoot, "current")) : "<gone>";
  check("activating a release repoints current at the new release and moves nothing into the old one",
    swap.status === 0 && landed === path.join(swapRoot, "new") &&
    fs.readdirSync(path.join(swapRoot, "old")).length === 0 &&
    !fs.existsSync(path.join(swapRoot, "next")),
    `current -> ${landed}; old/ contains ${JSON.stringify(fs.readdirSync(path.join(swapRoot, "old")))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// H. The whole file still parses, and the README leads with the one-liner
// ─────────────────────────────────────────────────────────────────────────────
{
  const syntax = spawnSync("bash", ["-n", path.join(here, "install.sh")], { encoding: "utf8" });
  check("install.sh parses", syntax.status === 0, `bash -n exit ${syntax.status} ${syntax.stderr || ""}`.trim());
  const readme = fs.readFileSync(path.join(here, "README.md"), "utf8");
  const oneLiner = readme.indexOf("curl -fsSL https://claudedotcompany.com/install.sh");
  const clone = readme.indexOf("git clone https://github.com/");
  check("the README leads with the one-command install, before the clone route",
    oneLiner > 0 && clone > oneLiner,
    `one-liner at char ${oneLiner}, git clone at char ${clone}`);
  check("the README keeps the clone route under its own heading",
    /prefer to clone it yourself/i.test(readme),
    (readme.split("\n").find((l) => /prefer to clone it yourself/i.test(l)) || "<none>"));
  check("the README documents Windows via WSL2",
    /## Windows/.test(readme) && /wsl --install -d Ubuntu/.test(readme));
  check("the README documents the double-click launcher by its exact filename",
    readme.includes(LAUNCHER), `README mentions "${LAUNCHER}": ${readme.includes(LAUNCHER)}`);
  /* RE-ANCHORED: the README used to have to say the default install trades nothing.
     It does not any more, so what it must say instead — near the one-liner, where a
     reader actually is — is that installing arms and that the empty wallet is what
     keeps it harmless until they fund it themselves. */
  check("the README says up front that the one command arms, and that funding is the switch",
    /arms it/i.test(readme.slice(0, oneLiner > 0 ? oneLiner + 1600 : 2400)) &&
    /fund/i.test(readme.slice(0, oneLiner > 0 ? oneLiner + 1600 : 2400)),
    JSON.stringify(readme.slice(Math.max(0, oneLiner - 400), oneLiner + 400).trim().slice(0, 200)));
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed — the one-click install path is NOT safe to advertise` :
  "\nOne-click install: guided, checksum-verified, and armed in one command.");
process.exit(fail ? 1 : 0);
