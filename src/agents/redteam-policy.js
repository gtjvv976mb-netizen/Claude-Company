import { cfg, floorsFor } from "../config.js";

const FACT_CODES = new Set([
  "wash_trading", "deployer_misconduct", "live_authority", "holder_control",
  "exit_failure", "liquidity_collapse", "fake_social_proof", "false_identity", "unlock_risk",
]);

const atPath = (obj, path) => String(path || "").split(".").filter(Boolean)
  .reduce((v, key) => v == null ? undefined : v[key], obj);

const flagNames = (evidence) => (evidence?.mintAccount?.flags || [])
  .map((f) => String(f?.flag ?? f));

function retainedCitation(evidence, sourceUrl) {
  if (!sourceUrl) return false;
  let wanted;
  try { wanted = new URL(sourceUrl); if (wanted.protocol !== "https:") return false; }
  catch { return false; }
  return (evidence?.xRead?.citations || []).some((c) => {
    const raw = typeof c === "string" ? c : c?.url;
    try {
      const got = new URL(raw);
      return got.origin === wanted.origin && got.pathname.replace(/\/$/, "") === wanted.pathname.replace(/\/$/, "");
    } catch { return false; }
  });
}

function observedMatches(actual, claimed) {
  if (actual == null) return false;
  if (typeof actual === "number") {
    const parsed = Number(String(claimed).replace(/[$,%\s]/g, "").replace(/,/g, ""));
    return Number.isFinite(parsed) && Math.abs(parsed - actual) <= Math.max(1e-9, Math.abs(actual) * 0.01);
  }
  if (typeof actual === "boolean") return String(claimed).trim().toLowerCase() === String(actual);
  if (typeof actual === "string") return String(claimed).trim().toLowerCase() === actual.trim().toLowerCase();
  return true; // arrays/objects are checked by the fact-specific predicate below
}

function confirmedByBundle(code, evidence, path, actual) {
  const flags = flagNames(evidence);
  switch (code) {
    case "live_authority":
      return Boolean(evidence?.mintAccount?.mintAuthority || evidence?.mintAccount?.freezeAuthority ||
        flags.some((f) => /mint_authority_live|freeze_authority_live|permanentDelegate|transferHook/i.test(f)));
    case "exit_failure":
      return Boolean(evidence?.exitProbe?.error) ||
        Number(evidence?.exitProbe?.roundTripLossPct) > cfg.maxRoundTripSlippagePct;
    case "holder_control":
      return Number(evidence?.holders?.top1Pct) > 50 || evidence?.holders?.bundleSuspect === true;
    case "wash_trading":
      return Number(evidence?.derived?.volToLiqRatio) > cfg.screen.maxVolToLiqRatio ||
        (evidence?.crosscheck?.verdicts || []).some((v) =>
          v?.verdict === "KILLED" && /volume|wash|trade/i.test(`${v?.check} ${v?.detail}`));
    case "deployer_misconduct":
      return (Number(evidence?.deployer?.priorLaunches) >= 8 && Number(evidence?.deployer?.graduated) === 0) ||
        evidence?.xRead?.serial_rugger === true;
    case "liquidity_collapse": {
      const mcap = evidence?.pair?.marketCap ?? evidence?.pair?.fdv ?? null;
      const liq = evidence?.pairs?.totalLiquidityUsd ?? evidence?.pair?.liquidityUsd;
      return Number.isFinite(Number(liq)) && Number(liq) < floorsFor(mcap).liq;
    }
    case "unlock_risk":
      return flags.some((f) => /mint_authority_live|transferFee|permanentDelegate|transferHook/i.test(f)) ||
        (evidence?.mintAccount?.extensions || []).some((x) => /transferFee|permanentDelegate|transferHook/i.test(String(x)));
    default:
      return false;
  }
}

/** A fatal refutation must identify a retained, checkable fact—not merely a keyword. */
export function verifiedFatalAttacks(redteam, evidence) {
  return (redteam?.attacks || []).filter((a) => {
    if (a?.severity !== "fatal" || a?.verification_status !== "verified") return false;
    if (!FACT_CODES.has(a?.fact_code)) return false;
    if (!String(a?.observed_value || "").trim() || !String(a?.threshold_or_comparison || "").trim()) return false;
    const path = String(a?.evidence_path || "").trim();
    const actual = path ? atPath(evidence, path) : undefined;
    const bundleFact = path && actual !== undefined && observedMatches(actual, a.observed_value) &&
      confirmedByBundle(a.fact_code, evidence, path, actual);
    const externalFact = retainedCitation(evidence, a?.source_url);
    // Social/identity claims are external by nature and require a retained citation.
    if (["fake_social_proof", "false_identity"].includes(a.fact_code)) return externalFact;
    // A citation may corroborate deployer misconduct, but deterministic chain/market
    // claims must match the retained evidence value and the coded threshold.
    return Boolean(bundleFact || (a.fact_code === "deployer_misconduct" && externalFact));
  });
}

export function applyRedTeamBar(redteam, evidence) {
  const out = { ...(redteam || {}), attacks: [...(redteam?.attacks || [])] };
  const fatal = verifiedFatalAttacks(out, evidence);
  if (out.verdict === "refuted" && fatal.length === 0) {
    out.downgraded_from = "refuted";
    out.downgrade_reason =
      "refuted without a structured, verified fatal fact retained in the evidence record";
    out.verdict = "wounded";
  }
  return { redteam: out, verifiedFatal: fatal };
}
