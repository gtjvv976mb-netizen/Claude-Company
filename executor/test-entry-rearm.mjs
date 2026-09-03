/**
 * THE BOT DISARMED ITSELF ON THE WAY OUT AND COULD NOT ARM ITSELF AGAIN.
 *
 * stop() publishes an entry pause on EVERY process exit, and that is correct: an exit
 * is not proof that anything is safe, and a machine that sleeps holding a position must
 * not keep entering. What was missing is the other half. Nothing in the poller ever
 * removed that pause; the only remover was an `rm -f` inside an interactive shell
 * script. So one crash, one upgrade or one power flap left the bot running, healthy, on
 * AC power, holding both sleep assertions — and skipping every call it was offered
 * until a human intervened. Measured over two days: 74 automatic pauses published, and
 * a real call refused at 06:39:38 on 2026-09-03 with "SKIP Shrek: PAUSE ENTRIES file is
 * present", 31 minutes after the crash that wrote it.
 *
 * The danger in fixing it is obvious and is what this file is mostly about: a bot that
 * clears its own pause must never clear a pause a PERSON set, and must never clear one
 * while a fault is latched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liftAutomaticEntryPause, AUTOMATIC_PAUSE_PREFIX, sleepAssertionFaultPath }
  from "./sleep-assertion.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-rearm-"));
const lockFile = path.join(dir, "state.sqlite.lock");
const pauseFile = path.join(dir, "state.sqlite.pause-entries");
const faultFile = sleepAssertionFaultPath(lockFile);
const write = (file, text, mode = 0o600) => {
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
};
const clean = () => { for (const f of [pauseFile, faultFile]) { try { fs.unlinkSync(f); } catch {} } };

console.log("\nTHE PAUSE THIS SUPERVISOR WROTE IS LIFTED");
{
  clean();
  write(pauseFile, `${AUTOMATIC_PAUSE_PREFIX} runner process exited with code 1\n`);
  const r = liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile });
  ok("an automatic pause is cleared", r.lifted === true, r.reason);
  ok("...and the file is really gone", !fs.existsSync(pauseFile));
  ok("a second start with nothing to lift says so",
    liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile }).lifted === false);
}

console.log("\nA PAUSE A PERSON SET IS NEVER TOUCHED");
{
  for (const text of ["operator: stopped for the night",
                      "manual hold while I check the wallet",
                      "", "   ",
                      // The prefix must be at the START, not merely present.
                      `investigating an ${AUTOMATIC_PAUSE_PREFIX} that fired yesterday`]) {
    clean();
    write(pauseFile, text);
    const r = liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile });
    ok(`left alone: ${JSON.stringify(text.slice(0, 42))}`, r.lifted === false && fs.existsSync(pauseFile), r.reason);
  }
}

console.log("\nA LATCHED FAULT OUTRANKS EVERYTHING");
{
  clean();
  write(pauseFile, `${AUTOMATIC_PAUSE_PREFIX} runner process exited with code 1\n`);
  write(faultFile, "sleep assertion could not be held\n");
  const r = liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile });
  ok("even an automatic pause stays while a fault is latched", r.lifted === false && fs.existsSync(pauseFile), r.reason);
  fs.unlinkSync(faultFile);
  ok("...and is lifted once the fault is cleared",
    liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile }).lifted === true);
}

console.log("\nA PAUSE THAT CANNOT BE TRUSTED IS A PAUSE THAT STAYS");
{
  clean();
  // A world-readable control file is exactly the case the owner-only check exists for,
  // and it must fail CLOSED — the bot stays paused rather than trusting it.
  write(pauseFile, `${AUTOMATIC_PAUSE_PREFIX} exited\n`, 0o644);
  const r = liftAutomaticEntryPause({ lockFile, pauseEntriesFile: pauseFile });
  ok("a non-owner-only pause is not lifted", r.lifted === false && fs.existsSync(pauseFile), r.reason);
  fs.chmodSync(pauseFile, 0o600);

  clean();
  ok("a missing pause path lifts nothing",
    liftAutomaticEntryPause({ lockFile, pauseEntriesFile: null }).lifted === false);
  ok("no arguments at all does not throw", liftAutomaticEntryPause().lifted === false);
}

console.log("\nTHE RUNNER LIFTS ONLY AFTER THE ASSERTION HAS VERIFIED");
{
  const runner = fs.readFileSync(new URL("./launchd-runner.mjs", import.meta.url), "utf8");
  const start = runner.indexOf("await startMacSleepAssertion(");
  const lift = runner.indexOf("liftAutomaticEntryPause({ lockFile, pauseEntriesFile })");
  ok("the lift happens after the assertion starts", start > 0 && lift > start, `start@${start} lift@${lift}`);
  ok("...and before the poller is imported",
    lift < runner.indexOf("await import(pathToFileURL(poller).href)"));
  ok("a failure to re-arm never stops the bot running", /catch \(error\) \{[\s\S]{0,200}entry re-arm check failed/.test(runner));
  const sleepSrc = fs.readFileSync(new URL("./sleep-assertion.mjs", import.meta.url), "utf8");
  ok("publishing a pause on exit is unchanged",
    /process\.once\("exit", onProcessExit\)/.test(sleepSrc) &&
    /publishAutomaticPause\(\{ lockFile, pauseEntriesFile,/.test(sleepSrc));
  ok("the prefix the lift matches is the one stop() writes",
    new RegExp(`reason: \`${AUTOMATIC_PAUSE_PREFIX} `).test(sleepSrc), AUTOMATIC_PAUSE_PREFIX);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
