/**
 * THE DEVELOPER LEDGER — remembering ruggers by the one identity they cannot rotate.
 *
 * On-chain forensics loses a serial rugger every time, and structurally rather than
 * technically: a wallet costs nothing to abandon. Rug, rotate, relaunch, and the
 * screen's `serial_deployer` check meets a first-time deployer with a clean record.
 *
 * The X account is what they cannot rotate — it carries the followers, and the
 * followers are the entire product. So the handle is the durable identity, and this
 * ledger is what stops the desk paying to rediscover the same rugger on every coin
 * they launch.
 */
import db from "./src/lib/store.js";
import { recordDev, reputationFor, knownRuggers, ledgerSize } from "./src/devrep.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nA SOURCED RUGGER IS REMEMBERED");
recordDev({ handle: "@RugMaster", serialRugger: true,
  rugEvidence: "launched $FOO Mar 3 and $BAR Apr 11, both -99% within a day; replies full of 'dev sold'",
  symbol: "BAZ", mint: "mint1" });
let r = reputationFor("rugmaster");
ok("recorded as a serial rugger", r?.verdict === "serial_rugger", r?.verdict);
ok("the evidence is stored with the verdict", !!r.evidence && r.evidence.length > 12,
  (r.evidence || "").slice(0, 54) + "…");
ok("the handle is matched however it is written",
  reputationFor("@RUGMASTER")?.verdict === "serial_rugger", "@RUGMASTER / rugmaster / @rugmaster");

console.log("\nAN UNSOURCED ACCUSATION IS A SUSPICION, NOT A VERDICT");
recordDev({ handle: "maybe_bad", serialRugger: true, rugEvidence: "idk", symbol: "X", mint: "m2" });
ok("stored as suspect, not as a rugger", reputationFor("maybe_bad")?.verdict === "suspect",
  reputationFor("maybe_bad")?.verdict + " — gossip that kills trades is worse than no memory");

console.log("\nUNKNOWN IS NEVER NEGATIVE");
recordDev({ handle: "ghost", serialRugger: null, rugEvidence: null, symbol: "G", mint: "m3" });
ok("an account we could not read is not written off",
  ["unknown", "clean"].includes(reputationFor("ghost")?.verdict), reputationFor("ghost")?.verdict);

console.log("\nA CLEAN COIN DOES NOT LAUNDER A RECORD");
recordDev({ handle: "@RugMaster", serialRugger: false, rugEvidence: null, symbol: "NICE", mint: "mint2" });
r = reputationFor("rugmaster");
ok("still a serial rugger after a well-behaved launch", r.verdict === "serial_rugger", r.verdict);
ok("and the new coin is added to their record", r.tokens.length === 2,
  r.tokens.map((t) => t.symbol).join(", "));
ok("the evidence survived the clean read", !!r.evidence);

console.log("\nTHE SECOND COIN IS CAUGHT FOR FREE");
const prior = reputationFor("rugmaster");
ok("a prior record exists before any new research is paid for", !!prior);
ok("it says how many of their launches this desk has now seen", prior.tokens.length >= 2,
  `${prior.tokens.length} coins from one handle`);
ok("the rugger list surfaces them", knownRuggers().some((x) => x.handle === "rugmaster"),
  `${knownRuggers().length} on the list, ${ledgerSize()} accounts tracked`);

console.log("\nDELETED HISTORY IS EVIDENCE OF SOMETHING, NOT PROOF OF WHAT");
recordDev({ handle: "wiped", serialRugger: null, deletedHistory: true, symbol: "W", mint: "m4" });
ok("a wiped timeline reads as suspect", reputationFor("wiped")?.verdict === "suspect");
ok("but never as a rugger without evidence", reputationFor("wiped")?.verdict !== "serial_rugger");

console.log("\nA BLANK HANDLE IS NOT AN IDENTITY");
ok("null handle is ignored", recordDev({ handle: null, serialRugger: true }) === null);
ok("empty handle is ignored", recordDev({ handle: "  ", serialRugger: true }) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
