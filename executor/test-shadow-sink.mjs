/**
 * THE BOOK HAS TO SURVIVE THE PROCESS, or the science was a rehearsal.
 *
 * snipe-shadow.mjs measured `creator_profile` and `launch_share` on every launch the lane
 * evaluated, from the day it shipped, and threw every one of them away: `createSnipeShadow`
 * defaults to `sink: null` and nothing ever passed one. The book lived in a bounded Map and
 * died with the process — every upgrade, every crash, every reboot.
 *
 * The bill came due when it mattered. The owner has 64 traded launches with known outcomes
 * and no retained measurements, so the one experiment that could give this bot an entry
 * edge — do either of these rulers separate the launches nobody followed from the ones
 * people did — could not be run against a single known answer. The README said the book
 * "has been recording both measurements the whole time", which was true and useless in the
 * same sentence.
 *
 * So this file pins the properties that make the book evidence:
 *
 *   · IT IS DURABLE. A row written is a row readable after the process is gone.
 *   · IT IS BOUNDED. Two files, a byte ceiling each. Research data does not get to fill
 *     the disk the trading process lives on.
 *   · IT LOSES AT MOST ONE ROW. A process killed mid-append leaves a torn final line; the
 *     reader skips and COUNTS it rather than refusing the other four hundred thousand.
 *   · IT NEVER COSTS A DECISION. A sink that throws is counted by createSnipeShadow as
 *     `sinkErrors` and never reaches the lane. A full disk is a gap in a report, not a
 *     missed sell.
 *   · THE RECENT WINDOW, NOT THE OLDEST. `--limit` keeps the newest rows, because the
 *     question a scorecard asks is whether the ruler works NOW.
 *
 *   node test-shadow-sink.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createShadowSink, readShadowRows, shadowBookPath, DEFAULT_MAX_BYTES,
} from "./shadow-sink.mjs";
import { createSnipeShadow, snipeScorecard } from "./snipe-shadow.mjs";
import { parseArgs, defaultBookPath, formatReport, main } from "./grade-entry-gates.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-sink-"));
const book = (n) => path.join(tmp, `${n}.jsonl`);

/** A row the scorecard can actually judge. `curve.reserveKnown` + a forward sample above
 *  or below the fill is the whole of `followedAfterFill`. */
const row = ({ mint, followed, creator = 12, share = 150, measured = true }) => ({
  mint,
  curve: { reserveKnown: true, realQuoteRaw: "1000" },
  forward: [{ realQuoteRaw: followed ? "2000" : "900" }],
  gate: { measured: measured ? { creator_profile: creator, launch_share: share } : {} },
});

console.log("\nthe sink writes a book that can be read back");
{
  const f = book("basic");
  const sink = createShadowSink({ file: f });
  sink({ mint: "A", n: 1 });
  sink({ mint: "B", n: 2 });
  const read = readShadowRows({ file: f });
  ok("one line per row, in order", read.rows.map((r) => r.mint).join(",") === "A,B", read.rows.map((r) => r.mint).join(","));
  ok("the payload survives the round trip", read.rows[1].n === 2);
  ok("nothing was malformed", read.malformed === 0);
  ok("stats count what was written", sink.stats().written === 2 && sink.stats().bytes > 0, JSON.stringify(sink.stats().written));
  const mode = fs.statSync(f).mode & 0o777;
  ok("the file is 0600 — it sits beside a wallet's state", mode === 0o600, "0" + mode.toString(8));
}

console.log("\na row that cannot be serialised costs one row, never the file");
{
  const f = book("bigint");
  const errors = [];
  const sink = createShadowSink({ file: f, onError: (e) => errors.push(e) });
  sink({ mint: "A" });
  const e = threw(() => sink({ mint: "B", raw: 10n }));   // BigInt: JSON.stringify throws
  ok("the throw does not escape as a write failure", e === null, e?.message);
  ok("it is counted as skipped, not written", sink.stats().skipped === 1 && sink.stats().written === 1,
    JSON.stringify({ skipped: sink.stats().skipped, written: sink.stats().written }));
  ok("...and reported", errors.length === 1);
  const read = readShadowRows({ file: f });
  ok("the good row is still there and the file still parses", read.rows.length === 1 && read.malformed === 0);
  ok("a non-object is skipped rather than written", (sink(null), sink(42), sink.stats().skipped === 3));
}

console.log("\nit is bounded: two files, a ceiling on each");
{
  const f = book("rotate");
  const sink = createShadowSink({ file: f, maxBytes: 200 });
  for (let i = 0; i < 40; i++) sink({ mint: `M${i}`, pad: "x".repeat(20) });
  ok("it rotated", sink.stats().rotations > 0, `${sink.stats().rotations} rotations`);
  ok("there are at most two files", fs.existsSync(f) && fs.existsSync(`${f}.1`) &&
    !fs.existsSync(`${f}.2`));
  const read = readShadowRows({ file: f });
  ok("the reader reads BOTH, so nothing is invisible mid-rotation", read.rows.length > 0, `${read.rows.length} rows`);
  ok("...oldest first, rotated file before the live one",
    Number(read.rows[0].mint.slice(1)) < Number(read.rows[read.rows.length - 1].mint.slice(1)),
    `${read.rows[0].mint} … ${read.rows[read.rows.length - 1].mint}`);
  /* The ceiling is the POINT: a month of a sniper at 29 launches a minute must not be able
     to fill the disk the trading process writes its journal to. */
  const bytes = fs.statSync(f).size + fs.statSync(`${f}.1`).size;
  ok("total bytes stay within two ceilings", bytes <= 200 * 2 + 400, `${bytes} bytes`);
  ok("the shipped default is a real ceiling, not a token one", DEFAULT_MAX_BYTES >= 1024 * 1024);
}

console.log("\na torn final line costs one row, not the book");
{
  const f = book("torn");
  const sink = createShadowSink({ file: f });
  for (let i = 0; i < 5; i++) sink({ mint: `M${i}` });
  fs.appendFileSync(f, '{"mint":"TORN","hal');        // killed mid-append
  const read = readShadowRows({ file: f });
  ok("the five good rows still read", read.rows.length === 5, `${read.rows.length}`);
  ok("the torn line is counted, not silently dropped", read.malformed === 1, `${read.malformed}`);
}

console.log("\nthe limit keeps the RECENT window — a stale ruler is not the question");
{
  const f = book("limit");
  const sink = createShadowSink({ file: f });
  for (let i = 0; i < 20; i++) sink({ mint: `M${i}` });
  const read = readShadowRows({ file: f, limit: 5 });
  ok("only the newest rows survive the limit",
    read.rows.map((r) => r.mint).join(",") === "M15,M16,M17,M18,M19", read.rows.map((r) => r.mint).join(","));
  ok("...and the total is still reported honestly", read.total === 20, `${read.total}`);
}

console.log("\nan absent book is a normal state, not a crash");
{
  const read = readShadowRows({ file: book("never-written") });
  ok("no files, no rows, no throw", read.files === 0 && read.rows.length === 0);
  ok("a missing path argument is refused", threw(() => readShadowRows({})) !== null);
  ok("a bad maxBytes is refused", threw(() => createShadowSink({ file: book("x"), maxBytes: 0 })) !== null);
  ok("the book's path is derived from the state db, beside it",
    shadowBookPath("/a/b/.cc-executor.sqlite") === "/a/b/.cc-executor.sqlite.shadow.jsonl");
}

console.log("\nA FULL DISK IS A GAP IN A REPORT, NEVER A MISSED SELL");
{
  /* The contract that matters most: createSnipeShadow catches and COUNTS a throwing sink.
     The sink rethrows on a write failure precisely so that counter is the one place the
     number lives — swallowing here would hide it from the lane's own reporting too. */
  const exploding = {
    statSync: () => { throw new Error("ENOENT"); },
    appendFileSync: () => { throw new Error("ENOSPC: no space left on device"); },
    renameSync: () => {}, rmSync: () => {}, readFileSync: () => { throw new Error("ENOENT"); },
  };
  const sink = createShadowSink({ file: book("full"), fsImpl: exploding });
  const direct = threw(() => sink({ mint: "A" }));
  ok("the sink rethrows a write failure", direct !== null && /ENOSPC/.test(direct.message), direct?.message);
  ok("...and counts it", sink.stats().errors === 1);

  const shadow = createSnipeShadow({ capacity: 10, sink });
  let laneSaw = null;
  try {
    shadow.record({ mint: "1111111111111111111111111111111111111111111", noticeAtMs: 1, venue: "pumpfun" });
  } catch (e) { laneSaw = e; }
  ok("a full disk never reaches the lane", laneSaw === null, laneSaw?.message);
  ok("...it is counted as sinkErrors, where the lane's reporting already looks",
    shadow.stats?.().sinkErrors >= 1 || shadow.counters?.sinkErrors >= 1,
    JSON.stringify(shadow.stats?.() ?? shadow.counters ?? null));
}

console.log("\nEND TO END: recorded rows come back as a scorecard");
{
  const f = book("graded");
  const sink = createShadowSink({ file: f });
  /* Twelve launches nobody followed, all flagged by both rulers; eight that were followed,
     none flagged. A ruler that separates perfectly should read precision 1.0. */
  for (let i = 0; i < 12; i++) sink(row({ mint: `BAD${i}`, followed: false, creator: 30, share: 200 }));
  for (let i = 0; i < 8; i++) sink(row({ mint: `OK${i}`, followed: true, creator: 1, share: 5 }));
  const read = readShadowRows({ file: f });
  const card = snipeScorecard(read.rows, { minRows: 5, minFlagged: 3 });
  ok("every row is judgeable", card.judged === 20, `${card.judged}`);
  ok("the positive class is the launch nobody followed", card.positives === 12, `${card.positives}`);
  ok("creator_profile separates them perfectly on this fixture",
    card.proxies.creator_profile.precision === 1 && card.proxies.creator_profile.recall === 1,
    JSON.stringify(card.proxies.creator_profile));
  ok("launch_share too", card.proxies.launch_share.precision === 1);
  ok("...and both read as promotable once the sample bar is met",
    card.proxies.creator_profile.promotable && card.proxies.launch_share.promotable);

  /* The realistic case, and the one the owner is most likely to get: a ruler that flags
     indiscriminately separates nothing, and must NOT read as promotable. */
  const g = book("noise");
  const gsink = createShadowSink({ file: g });
  for (let i = 0; i < 12; i++) gsink(row({ mint: `B${i}`, followed: i % 2 === 0, creator: 30, share: 200 }));
  const noise = snipeScorecard(readShadowRows({ file: g }).rows, { minRows: 5, minFlagged: 3 });
  ok("a ruler that flags everything scores ~0.5 precision and is refused",
    noise.proxies.creator_profile.precision === 0.5 && noise.proxies.creator_profile.promotable === false,
    JSON.stringify(noise.proxies.creator_profile.why));
  ok("a row whose ruler was never MEASURED is excluded, not counted as a pass",
    snipeScorecard([row({ mint: "X", followed: false, measured: false })], { minRows: 1, minFlagged: 1 })
      .proxies.creator_profile.n === 0);
}

console.log("\nthe report says the honest thing, including when the answer is 'no edge'");
{
  const empty = formatReport({
    scorecard: snipeScorecard([]), read: { total: 0, malformed: 0, files: 1 }, bookPath: "/x",
  });
  ok("an empty book says so plainly rather than printing a zero table",
    /NOTHING TO GRADE YET/.test(empty), empty.split("\n").find((l) => /NOTHING/.test(l)));

  const noiseRows = [];
  for (let i = 0; i < 300; i++) noiseRows.push(row({ mint: `N${i}`, followed: i % 2 === 0, creator: 30, share: 200 }));
  const text = formatReport({
    scorecard: snipeScorecard(noiseRows), read: { total: 300, malformed: 0, files: 1 }, bookPath: "/x",
  });
  ok("a full sample that separates nothing says NO ENTRY EDGE, in those terms",
    /no entry edge that these two measurements can find/.test(text));
  ok("...and names the honest options rather than implying another knob",
    /not a faster feed/.test(text) && /not another exit ladder/.test(text));
  ok("it never claims to have armed anything", /promotes: nothing/.test(text));
}

console.log("\nthe command itself");
{
  ok("--limit is validated", threw(() => parseArgs(["--limit", "0"])) !== null);
  ok("an unknown flag is refused rather than ignored", threw(() => parseArgs(["--wat"])) !== null);
  ok("flags parse", JSON.stringify(parseArgs(["--json", "--limit", "5"])) === JSON.stringify({ file: null, limit: 5, json: true }));
  ok("the default book is derived from STATE_DB",
    defaultBookPath({ STATE_DB: "/s/db.sqlite" }) === "/s/db.sqlite.shadow.jsonl");

  const lines = [];
  const code = await main([], { STATE_DB: path.join(tmp, "absent.sqlite") }, (m) => lines.push(String(m)));
  ok("a missing book exits non-zero and explains why", code === 1 && /no shadow book at/.test(lines.join("\n")));
  ok("...and tells the owner the build, not the data, is what is missing",
    /computed and discarded/.test(lines.join("\n")));

  const f2 = book("cli");
  const s2 = createShadowSink({ file: f2 });
  for (let i = 0; i < 4; i++) s2(row({ mint: `C${i}`, followed: i % 2 === 0 }));
  const out2 = [];
  const code2 = await main(["--file", f2, "--json"], {}, (m) => out2.push(String(m)));
  const parsed = JSON.parse(out2.join("\n"));
  ok("--json emits a machine-readable scorecard", code2 === 0 && parsed.scorecard.judged === 4,
    `judged ${parsed.scorecard?.judged}`);
  ok("...carrying the read's honesty fields", parsed.read.total === 4 && parsed.read.malformed === 0);
}

console.log("\nRUN THROUGH A SYMLINK — the way the owner is told to run it");
{
  /* THE BUG THIS PINS. Node resolves a module's own URL through symlinks, so
     `import.meta.url` is the realpath while `process.argv[1]` is whatever was typed. The
     documented command is `node ~/claudeco-executor/current/grade-entry-gates.mjs` and
     `current` is a symlink into the release tree — so comparing the two raw strings never
     matched, main() never ran, and the command printed NOTHING. Not an error, not an
     empty report: silence, which reads exactly like a tool with nothing to say.
     Measured on the owner's Mac at 04:37Z on 2026-09-19, the first time he ran it. A
     source grep cannot catch this; only actually spawning it through a link can. */
  const linkDir = path.join(tmp, "current");
  fs.symlinkSync(path.dirname(new URL(import.meta.url).pathname), linkDir);
  const fixture = book("symlinked");
  const s = createShadowSink({ file: fixture });
  for (let i = 0; i < 6; i++) s(row({ mint: `S${i}`, followed: i % 2 === 0 }));

  const viaLink = spawnSync(process.execPath,
    [path.join(linkDir, "grade-entry-gates.mjs"), "--file", fixture], { encoding: "utf8" });
  ok("running it through a symlink produces output at all",
    viaLink.stdout.trim().length > 0, JSON.stringify(viaLink.stdout.slice(0, 80)));
  ok("...and it is the real report, not a stub",
    /grading the two entry rulers/.test(viaLink.stdout) && /judged      6/.test(viaLink.stdout),
    viaLink.stdout.split("\n").find((l) => /judged/.test(l)));

  const viaReal = spawnSync(process.execPath,
    [fileURLToPath(new URL("./grade-entry-gates.mjs", import.meta.url)), "--file", fixture],
    { encoding: "utf8" });
  ok("the real path still works, unchanged", /grading the two entry rulers/.test(viaReal.stdout));

  /* And the other half of the guard: imported rather than executed, it must NOT run. */
  const asImport = spawnSync(process.execPath,
    ["--input-type=module", "-e",
      `import { runningAsScript } from ${JSON.stringify(fileURLToPath(new URL("./grade-entry-gates.mjs", import.meta.url)))};` +
      `process.stdout.write(String(runningAsScript()))`],
    { encoding: "utf8" });
  ok("imported, it does not run itself", asImport.stdout.trim() === "false", asImport.stdout.trim() || asImport.stderr.slice(0, 120));

  const monitor = fs.readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
  ok("monitor.mjs's CLI guard resolves the symlink too — a watchdog that silently does not run reads as a clean bill",
    /fs\.realpathSync\(process\.argv\[1\]\) === mine/.test(monitor));
}

console.log("\nit is wired, or it is a book nobody writes");
{
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller builds the shadow WITH a sink", /sink: sinkMod\.createShadowSink\(\{ file: sinkMod\.shadowBookPath\(STATE_DB\) \}\)/.test(poller));
  ok("...and hands it to the lane, or the lane makes its own sinkless one",
    /shadow: shadowBook,/.test(poller));
  ok("...imported dynamically inside the lane branch, like every other lane module",
    /import\("\.\/shadow-sink\.mjs"\)/.test(poller) && !/^import .*shadow-sink/m.test(poller));
  ok("the lane still accepts the port it has always had",
    /shadow \?\? createSnipeShadow\(/.test(fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8")));

  const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  ok("install.sh copies both files", /shadow-sink\.mjs/.test(install) && /grade-entry-gates\.mjs/.test(install));
  ok("...and lists them as runtime files",
    /RUNTIME_FILES=\([^)]*shadow-sink\.mjs/.test(install) && /RUNTIME_FILES=\([^)]*grade-entry-gates\.mjs/.test(install));
  const release = fs.readFileSync(new URL("./macos-release.sh", import.meta.url), "utf8");
  ok("the release ships them", /executor\/shadow-sink\.mjs/.test(release) && /executor\/grade-entry-gates\.mjs/.test(release));
  const viewer = fs.readFileSync(new URL("../scripts/build-viewer.mjs", import.meta.url), "utf8");
  ok("the viewer publishes them", /"shadow-sink\.mjs"/.test(viewer) && /"grade-entry-gates\.mjs"/.test(viewer));
  const health = fs.readFileSync(new URL("./heartbeat-health.mjs", import.meta.url), "utf8");
  ok("shadow-sink is fingerprinted — the trading process writes through it",
    /"shadow-sink\.mjs"/.test(health));
  const ti = fs.readFileSync(new URL("./test-install.mjs", import.meta.url), "utf8");
  ok("the install graph requires them", /shadow-sink\.mjs/.test(ti) && /grade-entry-gates\.mjs/.test(ti));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-shadow-sink  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
