/** The Red Team's hard verdict must resolve to retained, checkable evidence. */
import { applyRedTeamBar, verifiedFatalAttacks } from "./src/agents/redteam-policy.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

const evidence = {
  mintAccount: { mintAuthority: "MintAuth111", freezeAuthority: null, flags: ["mint_authority_live"] },
  holders: { top1Pct: 63.4, clusteredHolders: 6 },
  exitProbe: { roundTripLossPct: 2.1 },
  xRead: { citations: ["https://example.com/post"] },
};
const attack = (over = {}) => ({
  target: "forensics",
  attack: "the retained mint authority can inflate supply",
  severity: "fatal",
  evidence: "mintAccount.mintAuthority is MintAuth111",
  fact_code: "live_authority",
  evidence_path: "mintAccount.mintAuthority",
  observed_value: "MintAuth111",
  threshold_or_comparison: "authority is non-null",
  source_url: null,
  verification_status: "verified",
  ...over,
});

console.log("\nA VERIFIED FACT KEEPS THE REFUTATION");
const real = applyRedTeamBar({
  verdict: "refuted", headline: "supply remains controllable", bear_case: "the authority can print",
  attacks: [attack()],
}, evidence);
ok("verified fatal attack is found", real.verifiedFatal.length === 1);
ok("a real refutation remains refuted", real.redteam.verdict === "refuted");
ok("it is not marked downgraded", !real.redteam.downgraded_from);

console.log("\nPROSE CANNOT DRESS ITSELF AS A FACT");
for (const [name, a] of [
  ["generic keyword prose", attack({ fact_code: "other", attack: "liquidity might disappear" })],
  ["missing evidence path", attack({ evidence_path: "holders.doesNotExist" })],
  ["unverified assertion", attack({ verification_status: "unverified" })],
  ["missing observed value", attack({ observed_value: "" })],
  ["non-fatal severity", attack({ severity: "serious" })],
]) {
  const r = applyRedTeamBar({ verdict: "refuted", headline: name, attacks: [a] }, evidence);
  ok(`${name} is downgraded`, r.redteam.verdict === "wounded", r.redteam.downgrade_reason);
  ok(`${name} has no verified fatal`, r.verifiedFatal.length === 0);
}

console.log("\nEXTERNAL SOCIAL CLAIMS REQUIRE A RETAINED HTTPS SOURCE");
const social = attack({
  fact_code: "fake_social_proof",
  evidence_path: "",
  source_url: "https://example.com/post",
  observed_value: "account never published the claimed endorsement",
  threshold_or_comparison: "claimed post absent from the named account",
});
ok("HTTPS evidence can verify an external claim",
  verifiedFatalAttacks({ attacks: [social] }, evidence).length === 1);
ok("a non-retained HTTPS citation cannot",
  verifiedFatalAttacks({ attacks: [{ ...social, source_url: "https://invented.example/not-retained" }] }, evidence).length === 0);
ok("a non-HTTPS citation cannot",
  verifiedFatalAttacks({ attacks: [{ ...social, source_url: "javascript:alert(1)" }] }, evidence).length === 0);

console.log("\nNON-REFUTED VERDICTS AND FINDINGS ARE PRESERVED");
const wounded = applyRedTeamBar({ verdict: "wounded", headline: "keep me", attacks: [] }, evidence);
ok("wounded remains wounded", wounded.redteam.verdict === "wounded");
ok("the original findings remain", wounded.redteam.headline === "keep me");
const survives = applyRedTeamBar({ verdict: "survives", attacks: [] }, evidence);
ok("survives remains survives", survives.redteam.verdict === "survives");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
