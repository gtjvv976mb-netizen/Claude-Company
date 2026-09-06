import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/* Everything here uses a THROWAWAY keypair in a temp directory. The live
   burner.json is never read, never written, and never named. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-backup-"));
const tool = new URL("./burner-backup.mjs", import.meta.url).pathname;
const kp = Keypair.generate();
const keyfile = path.join(dir, "burner.json");
fs.writeFileSync(keyfile, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
fs.chmodSync(keyfile, 0o600);
const PUB = kp.publicKey.toBase58();
const SECRET = bs58.encode(Buffer.from(kp.secretKey));

/* THE ENVIRONMENT IS PART OF THE FIXTURE. Inheriting process.env made this suite
   pass on macOS and fail on every systemd host, CI included: a GitHub Actions
   runner is itself started by systemd, so JOURNAL_STREAM is already in the
   ambient environment and leaks into every child. The tool then correctly
   refused to emit key material, and the assertions that were not about that
   refusal read the wrong message. JOURNAL_STREAM is cleared here and set only by
   the case that tests it. */
const run = (args, env = {}) => {
  const base = { ...process.env, KEYPAIR: keyfile };
  delete base.JOURNAL_STREAM;
  return spawnSync(process.execPath, [tool, ...args],
    { encoding: "utf8", env: { ...base, ...env }, cwd: dir });
};

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

ok("the default output names the wallet and never the secret", () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(PUB));
  assert.doesNotMatch(r.stdout, new RegExp(SECRET), "the secret must not appear in the safe output");
  assert.match(r.stdout, /exists on this disk and nowhere else/);
});

ok("--show refuses without the second, explicit flag", () => {
  const r = run(["--show"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, new RegExp(SECRET));
  assert.match(r.stderr, /--i-understand/);
});

ok("--show prints the secret only when asked twice", () => {
  const r = run(["--show", "--i-understand"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), SECRET);
});

ok("a recovery file is written 0600 and actually restores the wallet", () => {
  const out = path.join(dir, "recovery.txt");
  const r = run(["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600, "a recovery file must not be readable by anyone else");
  const body = fs.readFileSync(out, "utf8");
  assert.match(body, new RegExp(PUB), "the file should say which wallet it restores");
  /* THE ASSERTION THAT MATTERS: restore it independently, the way a wallet would. */
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const restored = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(line)));
  assert.equal(restored.publicKey.toBase58(), PUB, "the recovery file must restore the same wallet");
});

ok("--verify accepts the file it wrote", () => {
  const r = run(["--verify", path.join(dir, "recovery.txt")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`restores ${PUB}`));
});

ok("--verify rejects a recovery file for a DIFFERENT wallet", () => {
  const other = path.join(dir, "wrong.txt");
  fs.writeFileSync(other, bs58.encode(Buffer.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const r = run(["--verify", other]);
  assert.notEqual(r.status, 0, "a backup of the wrong wallet must not verify");
  assert.match(r.stderr, /NOT this bot's wallet/);
});

ok("--verify rejects a truncated or corrupt file", () => {
  const bad = path.join(dir, "bad.txt");
  fs.writeFileSync(bad, "not-a-key", { mode: 0o600 });
  const r = run(["--verify", bad]);
  assert.notEqual(r.status, 0);
});

ok("a raw JSON-array export verifies too, so a wallet's own format works", () => {
  const j = path.join(dir, "array.txt");
  fs.writeFileSync(j, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  const r = run(["--verify", j]);
  assert.equal(r.status, 0, r.stderr);
});

ok("it refuses to overwrite an existing recovery file", () => {
  const r = run(["--out", path.join(dir, "recovery.txt")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
});

ok("a group-readable keypair is refused outright", () => {
  fs.chmodSync(keyfile, 0o640);
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be 0600/);
  fs.chmodSync(keyfile, 0o600);
});

ok("it will not emit key material from a systemd unit", () => {
  /* systemd sets JOURNAL_STREAM on every unit it starts, and a unit's stdout IS the
     journal — a log with a retention policy and a shipping pipeline. */
  for (const args of [["--show", "--i-understand"], ["--out", path.join(dir, "j.txt")]]) {
    const r = run(args, { JOURNAL_STREAM: "8:12345" });
    assert.notEqual(r.status, 0, `${args[0]} must refuse under systemd`);
    assert.match(r.stderr, /output is the journal/);
    assert.doesNotMatch(r.stdout, new RegExp(SECRET));
  }
  assert.ok(!fs.existsSync(path.join(dir, "j.txt")), "and it must not have written the file either");
});

ok("reading is still allowed under systemd — only key material is refused", () => {
  const r = run([], { JOURNAL_STREAM: "8:12345" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(PUB));
});

ok("the tool imports nothing that can open a socket", () => {
  const src = fs.readFileSync(tool, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["node:http", "node:https", "node:net", "node:dgram", "fetch(", "Connection("])
    assert.ok(!src.includes(bad), `an offline recovery tool must not reference ${bad}`);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} burner recovery checks passed`);
