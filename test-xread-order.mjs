/**
 * GROK GOES SECOND, RIGHT BEHIND THE SAFETY SCREEN.
 *
 * The reputation read is the desk's only look outside the chain — who launched this,
 * what the story is, whether the account has rugged before. Bought LAST it was a
 * footnote on a decision already made; bought SECOND it is context every later seat
 * reasons with, and it can end a workup before any of them is paid for.
 *
 * The earlier version of this file argued the opposite, on cost: the read was 44.6% of
 * the desk's bill, and buying the most expensive opinion before the cheap ones is
 * backwards on price alone. That was right about money and wrong about the job. The
 * resolution is not to buy it late but to let it DECIDE early — a kill here saves the
 * $0.63 of analysis that follows, against $0.13 to ask.
 *
 * So the assertions have flipped, and what they protect has not: the free screen still
 * runs first, and the kill is deliberately narrow. An expensive seat killing on a hunch
 * is how a desk stops publishing anything at all.
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
  ok("a kill from any seat still ends the workup", shouldBuyReputationRead(killed) === false);
  ok("...and the seat that refused is named", firstKiller(killed)[0] === "flow", firstKiller(killed)[0]);
  const alive = { liquidity: seat(61), flow: seat(58), technical: seat(55) };
  ok("no kill means the workup continues", shouldBuyReputationRead(alive) === true);
  ok("a LOW score is not a kill — only a kill is a kill",
    shouldBuyReputationRead({ liquidity: seat(3), flow: seat(1), technical: seat(0) }) === true);
  ok("an absent seat is not a refusal", shouldBuyReputationRead({ flow: undefined, liquidity: seat(50) }) === true);
  ok("a missing bundle does not throw", firstKiller(null) === null && firstKiller(undefined) === null);
}

console.log("\nTHE PIPELINE RUNS IN THAT ORDER");
{
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  const screen = src.indexOf("const sc = screen(ev);");
  const read = src.indexOf("await enrichWithXRead(ev, hook)");
  const cheap = src.indexOf("const cheap = await Promise.allSettled(cheapKeys.map");
  const deep = src.indexOf("const deep = await Promise.allSettled([runAnalyst(\"forensics\"");
  ok("the FREE safety screen still runs first, before anything is bought",
    screen > 0 && read > screen, `screen@${screen} read@${read}`);
  ok("the reputation read runs SECOND, before any analyst seat",
    read > 0 && cheap > read, `read@${read} analysts@${cheap}`);
  ok("...and is awaited, so every later seat reasons with it", /await enrichWithXRead\(ev, hook\)/.test(src));
  ok("forensics and narrative no longer wait on it separately", deep > 0 && !/xRead\.then\(/.test(src));
  ok("it is still bought exactly once", (src.split("enrichWithXRead(ev, hook)").length - 1) === 1);
}

console.log("\nWHAT THE READ MAY END A WORKUP FOR, AND WHAT IT MAY NOT");
{
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  ok("a deployer whose own account has rugged before ends it",
    /read\?\.serial_rugger === true/.test(src));
  ok("a manufactured story with paid or botted attention ends it",
    /read\?\.verdict === "manufactured" && read\?\.paid_or_botted_signs === true/.test(src));
  /* The narrowness is the safety property. A seat this expensive killing on a tepid
     verdict is how a desk stops publishing anything at all. */
  ok("a merely mixed or unknown verdict does NOT end it",
    !/verdict === "mixed"/.test(src) && !/verdict === "no_signal"/.test(src));
  ok("a manufactured story ALONE does not end it — it needs the paid/botted fact too",
    /manufactured" && read\?\.paid_or_botted_signs/.test(src));
  ok("a failed or missing read never kills", /ev\.xRead && !ev\.xRead\.error \? ev\.xRead : null/.test(src));
  ok("the kill is recorded like any other, with its reason",
    /killedBy: "xread"/.test(src) && /kill_reason: grokKill/.test(src));
  ok("...and it is a KILL, not a silent skip", /outcome: "killed"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
