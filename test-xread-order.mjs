/**
 * THE MOST EXPENSIVE OPINION IS BOUGHT LAST.
 *
 * Measured on the live desk over 24 hours: XRead $84.87 of a $190.39 bill — 44.6% of
 * everything spent, 573 calls at $0.148 — against $26.81 for the four analyst seats put
 * together. It was bought for every coin that cleared the free screen, ahead of the
 * cheap seats, and any one of those seats returning `kill` ends the workup outright.
 * So the desk was paying its largest single line item to research coins it was about to
 * reject on evidence it already had.
 *
 * The rule is not "spend less". It is that a coin already condemned buys nothing more.
 */
import fs from "node:fs";
import { firstKiller, shouldBuyReputationRead } from "./src/desk.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const seat = (score, kill = false, reason = null) => ({ score, confidence: 0.7, kill, kill_reason: reason });

console.log("\nA CONDEMNED COIN BUYS NOTHING MORE");
{
  const killed = { liquidity: seat(40), flow: seat(20, true, "three wallets round-tripping"), technical: seat(35) };
  ok("a kill from any cheap seat stops the reputation read", shouldBuyReputationRead(killed) === false);
  ok("...and the seat that refused is named", firstKiller(killed)[0] === "flow", firstKiller(killed)[0]);
  ok("a kill in the FIRST seat is caught too",
    shouldBuyReputationRead({ liquidity: seat(10, true, "no exit"), flow: seat(50) }) === false);
  ok("a kill in the LAST seat is caught too",
    shouldBuyReputationRead({ liquidity: seat(50), technical: seat(10, true, "dead tape") }) === false);
}

console.log("\nA COIN STILL STANDING GETS THE FULL WORKUP");
{
  const alive = { liquidity: seat(61), flow: seat(58), technical: seat(55) };
  ok("no kill means the read is bought", shouldBuyReputationRead(alive) === true);
  ok("...and nothing is reported as the killer", firstKiller(alive) === null);
  ok("a LOW score is not a kill — only a kill is a kill",
    shouldBuyReputationRead({ liquidity: seat(3), flow: seat(1), technical: seat(0) }) === true);
}

console.log("\nTHE RULE IS TOTAL, SO IT CANNOT SILENTLY PASS A REFUSAL");
{
  ok("no seats reported: nothing has refused, so the coin lives", shouldBuyReputationRead({}) === true);
  ok("a missing bundle does not throw", firstKiller(null) === null && firstKiller(undefined) === null);
  // A seat that failed to answer arrives as undefined, and must not read as a kill.
  ok("an absent seat is not a refusal", shouldBuyReputationRead({ flow: undefined, liquidity: seat(50) }) === true);
}

console.log("\nTHE PIPELINE ACTUALLY RUNS IN THAT ORDER");
{
  /* The rule above is only worth anything if the file calls it before the read. These
     assertions are on positions in the source because that ordering is the whole fix:
     a future edit that moves enrichWithXRead back above the cheap batch would restore
     the $84.87 line item while every behavioural test here still passed. */
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  const cheapBatch = src.indexOf("const cheap = await Promise.allSettled(cheapKeys.map");
  const gate = src.indexOf("const cheapKiller = firstKiller(analysts);");
  const buy = src.indexOf("const xRead = enrichWithXRead(ev, hook);");
  const screen = src.indexOf("const sc = screen(ev);");
  ok("the cheap seats run before the gate", cheapBatch > 0 && gate > cheapBatch);
  ok("the gate runs before the reputation read is bought", buy > gate, `gate@${gate} read@${buy}`);
  ok("the free safety screen still runs before all of it", screen > 0 && screen < cheapBatch);
  ok("the reputation read is bought exactly once",
    src.split("enrichWithXRead(ev, hook)").length - 1 === 1);
  ok("forensics and narrative still wait for it",
    src.includes('xRead.then(() => runAnalyst("forensics", ev))') &&
    src.includes("xRead.then(() => runNarrative(ev))"));
  ok("a cheap-seat kill is recorded as a kill, not as a new outcome",
    /cheapKiller\)[\s\S]{0,400}outcome: "killed"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
