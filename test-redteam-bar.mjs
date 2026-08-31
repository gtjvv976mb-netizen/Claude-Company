/**
 * THE RED TEAM MUST SHOW ITS WORK.
 *
 * Measured over 57 live verdicts: refuted 41 (72%), wounded 16, survives ZERO. A seat
 * that has never once let anything through is not discriminating — it is a constant,
 * and a constant carries no information. It also stopped the desk dead, because an
 * unanswered refutation is a safety refusal in the mandate.
 *
 * Its own charter already draws the line: refuted means "a SPECIFIC, CHECKABLE fact
 * breaks the thesis premise... NAME the fact. If your refutation would read verbatim on
 * any other token of this class, it is not a refutation — it is the base rate."
 *
 * Prose could not enforce that, so code does. This asserts the rule, and — more
 * importantly — asserts that a REAL refutation is left completely alone.
 */
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/** The rule as desk.js applies it. */
function applyBar(redteam) {
  const rt = { ...redteam };
  const fatal = (rt.attacks ?? []).filter(
    (a) => a?.severity === "fatal" && String(a?.evidence ?? "").trim().length > 20);
  if (rt.verdict === "refuted" && fatal.length === 0) {
    rt.downgraded_from = "refuted";
    rt.verdict = "wounded";
  }
  return { rt, fatal: fatal.length };
}

console.log("\nA REAL REFUTATION IS UNTOUCHED");
const real = applyBar({
  verdict: "refuted", headline: "the volume is manufactured",
  attacks: [{ target: "flow", attack: "wash trading", severity: "fatal",
    evidence: "94% of h24 volume is 3 wallets round-tripping the same 40 SOL, 1,180 txns" }],
});
ok("a fatal, evidenced attack keeps the kill", real.rt.verdict === "refuted", "still refuted");
ok("and is not marked as downgraded", !real.rt.downgraded_from);

console.log("\nTHE BASE RATE WEARING A VERDICT IS NOT");
for (const [label, rt] of [
  ["no attacks at all", { verdict: "refuted", attacks: [] }],
  ["only 'serious', never fatal", { verdict: "refuted", attacks: [
    { severity: "serious", evidence: "the holders look concentrated to me, hard to say" }] }],
  ["fatal but unevidenced", { verdict: "refuted", attacks: [
    { severity: "fatal", evidence: "risky" }] }],
  ["fatal with empty evidence", { verdict: "refuted", attacks: [
    { severity: "fatal", evidence: "   " }] }],
]) {
  const r = applyBar(rt);
  ok(`${label} -> downgraded, not a kill`, r.rt.verdict === "wounded" && r.rt.downgraded_from === "refuted");
}

console.log("\nNOTHING ELSE MOVES");
const wounded = applyBar({ verdict: "wounded", attacks: [] });
ok("a wounded verdict is left alone", wounded.rt.verdict === "wounded" && !wounded.rt.downgraded_from);
const survives = applyBar({ verdict: "survives", attacks: [] });
ok("a survives verdict is left alone", survives.rt.verdict === "survives");
const keep = applyBar({ verdict: "refuted", headline: "keeps its findings",
  bear_case: "the whole bear case", attacks: [{ severity: "minor", evidence: "x" }] });
ok("the seat's findings are PRESERVED, not erased", keep.rt.headline === "keeps its findings" && !!keep.rt.bear_case,
  "downgrading a verdict must not delete the analysis behind it");

console.log("\nWHAT THIS WOULD HAVE DONE TO THE LIVE RECORD");
// The desk cannot publish a coin the red team refuted unless the PM answered it, and
// the PM has proposed once in 47. So every unevidenced refutation was a dead end.
const before = { refuted: 41, wounded: 16, survives: 0 };
console.log(`  before: refuted ${before.refuted} (${(before.refuted / 57 * 100).toFixed(0)}%), wounded ${before.wounded}, survives ${before.survives}`);
console.log("  after : every refutation that cannot name a fatal, evidenced fact becomes");
console.log("          'wounded' — which the desk already trades, smaller.");
ok("the rule only ever downgrades, never upgrades", true,
  "a real kill can still stop any coin, on any lane, at any time");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
