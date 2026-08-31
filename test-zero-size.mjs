/**
 * THE ZERO-SIZE CONTRADICTION — why this desk had never published a call.
 *
 * The Risk seat sized 10 of 11 workups at $0 and stated its reason verbatim:
 * "Per method rule 4, refuted means position_size_usd is 0 — not negotiable."
 * No such rule has ever existed. Rule 4 says a refuted verdict cuts size HARD and that
 * zero is reserved for a MECHANICAL failure: the exit fails at size, or a live authority
 * can rug it. One of those same verdicts recorded "the $500 probe was clean at 0.05%
 * round-trip" — that test passing, in its own notes.
 *
 * The zero is what actually killed every trade, through four gates that never mention
 * the red team. These tests hold the two halves of the repair: the condition is detected
 * exactly when both mechanical grounds are absent, and the desk NEVER manufactures a
 * size of its own — it asks the seat again and takes whatever answer comes back.
 */
import { cfg } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/* The predicate exactly as desk.js computes it. Kept in lockstep deliberately: this is
 * the whole decision, and it is four lines, so a copy that drifts would be obvious. */
const shouldChallenge = (risk, ev) => {
  const probe = ev.exitProbe?.roundTripLossPct;
  const exitFails = probe == null || probe > cfg.maxRoundTripSlippagePct;
  const authorityLive = !!(ev.mintAccount?.mintAuthority || ev.mintAccount?.freezeAuthority);
  return risk?.position_size_usd === 0 && !exitFails && !authorityLive;
};

const ev = (over = {}) => ({
  exitProbe: { roundTripLossPct: over.probe === undefined ? 4.53 : over.probe },
  mintAccount: { mintAuthority: over.mintAuth ?? null, freezeAuthority: over.freezeAuth ?? null },
});

console.log("\nTHE FABRICATED ZERO IS CAUGHT");
ok("zero on a coin that probes clean and has no live authority is challenged",
  shouldChallenge({ position_size_usd: 0 }, ev()) === true,
  "4.53% round trip, both authorities renounced — neither ground for zero exists");

console.log("\nA LEGITIMATE ZERO IS NEVER TOUCHED");
ok("zero stands when the exit measured WORSE than the ceiling",
  shouldChallenge({ position_size_usd: 0 }, ev({ probe: cfg.maxRoundTripSlippagePct + 1 })) === false,
  `${cfg.maxRoundTripSlippagePct + 1}% > ${cfg.maxRoundTripSlippagePct}% — rule 4 case (a) genuinely applies`);
ok("zero stands when the exit could not be measured at all",
  shouldChallenge({ position_size_usd: 0 }, ev({ probe: null })) === false,
  "an unmeasurable exit is not a clean one — unverified is not safe");
ok("zero stands when a MINT authority is live",
  shouldChallenge({ position_size_usd: 0 }, ev({ mintAuth: "So1111..." })) === false,
  "rule 4 case (b)");
ok("zero stands when a FREEZE authority is live",
  shouldChallenge({ position_size_usd: 0 }, ev({ freezeAuth: "So1111..." })) === false,
  "rule 4 case (b)");

console.log("\nA NON-ZERO SIZE IS NEVER SECOND-GUESSED");
for (const size of [1, 250, 10_000])
  ok(`a size of $${size} is left alone`, shouldChallenge({ position_size_usd: size }, ev()) === false,
    "the guard only ever looks at zeros");
ok("a missing risk verdict is not challenged into existence",
  shouldChallenge(null, ev()) === false, "no seat, no contradiction");

console.log("\nTHE DESK NEVER INVENTS A SIZE");
/* The most important property here. Detecting the contradiction is safe; SIZING it
 * would not be — that is trading on arithmetic no judgement stands behind. The repair
 * re-asks the seat and accepts whatever comes back, including another zero. */
const source = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8"));
const guard = source.slice(source.indexOf("THE ZERO-SIZE CONTRADICTION"), source.indexOf("const pm = await runPM"));
/* Two false starts on this assertion, both worth keeping in mind. Scanning for
 * `position_size_usd` near a number first matched the guard's own `=== 0` COMPARISON,
 * then matched the sentence "You returned position_size_usd = 0" inside the prompt —
 * the desk quoting the seat back to itself. Neither is the desk setting a size.
 *
 * The property that actually matters is about the VARIABLE the rest of the workup
 * reads: every assignment to `risk` must come from a seat, never from a literal. */
const assignments = [...guard.matchAll(/(?:^|\s)risk\s*=\s*([^\n;]+)/g)].map((m) => m[1].trim());
ok("every assignment to `risk` comes from the seat itself",
  assignments.length > 0 && assignments.every((rhs) => /^retry$|^await runRisk\(/.test(rhs)),
  assignments.length ? assignments.join(" | ") : "no assignments found — the slice bounds are wrong");
ok("...and that check can still SEE a fabricated one",
  !["retry", "{ position_size_usd: 250 }"].every((rhs) => /^retry$|^await runRisk\(/.test(rhs)),
  "a guard-clause test that cannot fail is not a test");
ok("it calls the seat again rather than patching the record",
  /runRisk\(ev, analysts, redteam, \{/.test(guard), "one retry, with the contradiction quoted");
ok("and it accepts a repeated zero",
  /held at zero on a second look/.test(guard),
  "if the seat still says zero after seeing the evidence, that is a judgement and it stands");

console.log("\nTHE CHARTER NO LONGER READS AS 'REFUTED MEANS ZERO'");
const charter = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("./src/agents/decision.js", import.meta.url), "utf8"));
ok("rule 4 states that small is not zero", /Small is not zero/.test(charter));
ok("...and names the only two grounds for zero", /ZERO IS A MECHANICAL VERDICT/.test(charter));
ok("...and records the misreading that cost the desk every trade",
  /refuted means position_size_usd is 0 — not negotiable/.test(charter),
  "the wrong sentence is quoted in the charter so it cannot be re-derived");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
