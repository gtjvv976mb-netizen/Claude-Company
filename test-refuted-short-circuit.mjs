/**
 * A VERDICT THE GATE HAS ALREADY SETTLED MUST NOT BUY THREE MORE SEATS.
 *
 * Two endings of a workup were decided before the decision seats were paid for. A red-team
 * verdict that survives applyRedTeamBar as `refuted` — a fatal attack the seat marked
 * verified and the bundle confirms — is a SAFETY refusal in the mandate unless the PM
 * proposes over it, which happened 3 times in 260 all-time; 69 of 281 coins that reached
 * the red team (25%) left it refuted and every one then bought Risk ($0.063), the PM
 * ($0.173) and Execution ($0.045), ~$0.28 for a record mandate.eligibility declines. And a
 * mechanical zero from the rails is `zero_authorized_size`, SAFETY at every level, while
 * the PM's own brief forbids PROPOSE at zero size — so the $0.173 Opus call cannot change
 * a zeroed outcome. desk.js now returns at both points: finalDecision REFUTED with pm null,
 * or ZERO_SIZE with the railed size on the record, and nothing after the settled verdict is
 * bought. The gate itself does not move; this file proves it from both sides.
 *
 * WHAT IS REAL: workup() end to end — the free screen, the read, both analyst batches,
 * the coverage floor, runRedTeam, applyRedTeamBar, railRisk/enforceRiskRails, runPM,
 * runExecution, complianceCheck — plus ask() with its meter and the llm_spend ledger,
 * recordDecision/gateFor, mandate.eligibility, calls.js gateFailures and penthouse
 * cohortEligibility. WHAT IS STUBBED: the network (a counted fetch that answers as each
 * provider would — what left the process IS the evidence), gather() (one canned bundle the
 * REAL screen is shown to pass) and writeReport. Seat answers are schema-shaped fixtures
 * with usage shaped to the live per-seat medians, so the dollars printed are the meter's
 * arithmetic on a plausible shape, not a measurement of the live desk.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-refuted-short-circuit.mjs
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "refuted-sc-"));
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(TMP, "refuted.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";
for (const k of Object.keys(process.env)) if (/^DESK_(MODEL|EFFORT)_/.test(k)) delete process.env[k];

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const usd = (n) => `$${Number(n).toFixed(4)}`;

/* ── the stub layer: gather() and the scribe, the way test-haiku-seats-contract.mjs does it ── */
const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/data/evidence.js"), "evidence"],
  [F("src/report.js"), "report"],
]);
const SOURCE = {
  /* screen() and enrichWithXRead() stay REAL — only the network-bound gather() is canned. */
  evidence: `
    export * from "${F("src/data/evidence.js")}?rs=real";
    export async function gather(mint, hook) { return globalThis.__RS.gather(mint, hook); }
  `,
  report: `
    export * from "${F("src/report.js")}?rs=real";
    export function writeReport(cycle, r) {
      globalThis.__RS.reports.push({ cycle, symbol: r?.symbol, outcome: r?.outcome, finalDecision: r?.finalDecision });
      return "reports/refuted-sc-test/" + String(cycle) + "__" + (r?.symbol || "x") + ".md";
    }
  `,
};
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (String(r.url).includes("rs=real")) return r;
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?rs=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("rs=stub")) {
      const k = new URL(u).searchParams.get("k");
      return { format: "module", source: SOURCE[k], shortCircuit: true };
    }
    return next(url, ctx);
  },
});

/* ── the fixtures: one coin, and every seat's answer in contract ─────────────────────── */
const PX = 0.0002;
const analystOut = (seat) => ({
  headline: `${seat}: nothing disqualifying on this dimension`, score: 61, confidence: 0.7,
  findings: [{ claim: "there is a market on the other side of the coin", value: "40000", source: "pairs.totalLiquidityUsd" },
    { claim: "a route exists and was quoted", value: "1.2", source: "exitProbe.roundTripLossPct" }],
  risks: ["the book is one pool deep"], missing_data: [], kill: false, kill_reason: "",
});
/* THE FATAL ATTACK THE BAR ACCEPTS: a fact the bundle confirms. holders.bundleSuspect is
   what solana.js sets at four clustered accounts (src/data/solana.js:174) and what
   redteam-policy.js confirmedByBundle reads for holder_control — and the free screen
   does not kill on it (evidence.js screen() checks top1Pct > 50, not bundling), so the
   coin reaches the red team with the fact retained. `fact_code: "other"` is the same
   attack the bar refuses, which is how the downgraded case below is built. */
const fatalAttack = (over = {}) => ({
  target: "the flow seat's read that the float is distributed",
  attack: "four wallets funded from one source hold the float in lockstep — the tape is one hand",
  severity: "fatal", evidence: "holders.bundleSuspect is true at four clustered accounts",
  fact_code: "holder_control", evidence_path: "holders.bundleSuspect", observed_value: "true",
  threshold_or_comparison: "bundleSuspect true at four or more clustered accounts",
  source_url: null, verification_status: "verified", ...over });
const redteamOut = (verdict, attacks = []) => ({
  headline: verdict === "refuted" ? "the float is one bundled hand" : "the crowd is two accounts",
  bear_case: "attention is thin and the float is small enough that one seller ends this",
  attacks, unfalsifiable_claims: ["it could 10x"], what_would_change_my_mind: "distinct funding sources",
  verdict, confidence: 0.65 });
const riskOut = { risk_tier: "quarter", size_rationale: "wounded, not refuted", stop_price: 0.00015,
  stop_rationale: "below the launch base", liquidity_adjusted: false, portfolio_notes: "", confidence: 0.6 };
const pmOut = { decision: "WATCH", conviction: 55, thesis: "early to a true story", invalidation: "volume fades",
  time_horizon: "1h", how_red_team_was_answered: "two voices is the ordinary launch", key_disagreement: "none",
  watch_triggers: ["buys_h1 >= 40"],
  watch_rules: { price_above_usd: 0.00019, buys_h1_at_least: 40, liq_at_least_usd: null, hours: 2 } };
const ticketOut = { action: "BUY", entry_zone_low: 0.00019, entry_zone_high: 0.00021, entry_style: "scale-in",
  slices: [{ pct_of_position: 50, trigger: "now" }, { pct_of_position: 50, trigger: "holds 0.0002" }],
  max_slippage_bps: 300, suggested_route: "raydium", stop_price: riskOut.stop_price,
  take_profit: [{ price: 0.0005, pct_to_sell: 100, rationale: "the re-rate the thesis argues for" }],
  execution_warnings: [] };

/* Token usage per seat, shaped to the live medians (Red Team $0.37, PM $0.18, Risk $0.07,
   Execution $0.05, Liquidity $0.03), so the saving printed is the meter's arithmetic on
   the shapes that produce those figures. */
const USAGE = {
  analyst:   { input_tokens: 6_000, cache_read_input_tokens: 8_000, output_tokens: 1_600 },
  research:  { input_tokens: 3_000, cache_read_input_tokens: 8_000, output_tokens: 2_500, server_tool_use: { web_search_requests: 2 } },
  shape:     { input_tokens: 4_000, cache_read_input_tokens: 8_000, output_tokens: 800 },
  redteam:   { input_tokens: 5_000, cache_read_input_tokens: 8_000, output_tokens: 8_000 },
  risk:      { input_tokens: 5_000, cache_read_input_tokens: 8_000, output_tokens: 1_500 },
  pm:        { input_tokens: 7_000, cache_read_input_tokens: 8_000, output_tokens: 3_000 },
  execution: { input_tokens: 3_500, output_tokens: 1_200 },
};

/* ── the wire: every provider request, in order, answered as each provider would ─────── */
const WIRE = [];
let REDTEAM = redteamOut("wounded");     // per case
const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });
const sse = (frames) => new Response(
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const stream = (model, usage, text) => sse([
  { type: "message_start", message: { id: "msg_rs", type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
  { type: "message_stop" },
]);
const researchReply = (model, usage) => json({
  id: "msg_r", type: "message", role: "assistant", model,
  content: [
    { type: "text", text: "Notes: the story traces to one post; two accounts repeat it in their own words." },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "RSEAT" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.org/origin", title: "The origin post" }] },
  ],
  stop_reason: "end_turn", stop_sequence: null, usage,
});
/* The /responses body grokXRead parses; 1.54e9 ticks is $0.154, the live per-read figure. */
const xaiRead = () => json({ id: "resp_rs", model: "grok-4.6",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
    mentions_level: "low", verdict: "mixed", velocity: "flat", serial_rugger: false,
    paid_or_botted_signs: false, dev_handle: null, summary: "stub read" }) }] }],
  citations: [], usage: { input_tokens: 4000, output_tokens: 350, cost_in_usd_ticks: 1_540_000_000 } });

/* Which seat a request is for is read off the request: the brief opens the LAST user
   block (seatTurn() in lib/llm.js), after the shared bundle. */
const seatOf = (body) => {
  const blocks = body?.messages?.[0]?.content;
  const tail = Array.isArray(blocks) ? String(blocks.at(-1)?.text ?? "") : String(blocks ?? "");
  const m = /^You are the (RED TEAM|EXECUTION|RISK|LIQUIDITY|FLOW|FORENSICS|NARRATIVE|TECHNICAL) seat/.exec(tail);
  if (m) return m[1];
  if (/^You are the PORTFOLIO MANAGER/.test(tail)) return "PM";
  return "?";
};
const kindOf = (seat, body) => seat === "NARRATIVE" ? (body.stream ? "shape" : "research")
  : seat === "RED TEAM" ? "redteam" : seat === "RISK" ? "risk" : seat === "PM" ? "pm"
  : seat === "EXECUTION" ? "execution" : "analyst";
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (/xai/.test(target)) { WIRE.push({ provider: "xai", seat: "XRead", model: "grok-4.6" }); return xaiRead(); }
  if (!/anthropic-must-not-be-reached/.test(target)) {
    WIRE.push({ provider: "other", seat: "?", url: target });
    return json({ error: "unexpected request" }, 404);
  }
  const body = JSON.parse(init?.body ?? "{}");
  const seat = seatOf(body);
  const kind = kindOf(seat, body);
  WIRE.push({ provider: "anthropic", seat: kind === "research" ? "NARRATIVE(research)" : seat, kind, model: body.model });
  if (kind === "research") return researchReply(body.model, USAGE.research);
  const out = kind === "analyst" || kind === "shape" ? analystOut(seat)
    : kind === "redteam" ? REDTEAM : kind === "risk" ? riskOut : kind === "pm" ? pmOut : ticketOut;
  return stream(body.model, USAGE[kind], JSON.stringify(out));
};

/* ── the real modules, imported only now that the stubs are in place ─────────────────── */
const { resetCreditBreakers } = await import("./src/lib/llm.js");
const { xreadCacheReset } = await import("./src/lib/grok.js");
const { bus } = await import("./src/lib/bus.js");
const db = (await import("./src/lib/store.js")).default;
const { MAX_ESCALATION_LEVEL } = await import("./src/config.js");
const { bandForMarketCap, holdWindowFor } = await import("./src/bands.js");
const { screen } = await import("./src/data/evidence.js");
const { applyRedTeamBar } = await import("./src/agents/redteam-policy.js");
const { complianceCheck } = await import("./src/agents/compliance.js");
const { eligibility } = await import("./src/mandate.js");
const { gateFor } = await import("./src/evaluation.js");
const { gateFailures, safetyFailures, GATE_CLASS } = await import("./src/calls.js");
const { cohortEligibility } = await import("./src/penthouse.js");
const { workup } = await import("./src/desk.js");

/* One evidence bundle, sized to the MEDIUM band ($100k-$500k) with every safety read
   present, so the REAL screen lets it through — the shape test-haiku-seats-contract.mjs
   uses, plus the retained bundling fact the fatal attack points at. */
const cannedEvidence = (mint, hook, over = {}) => {
  const mcap = 200_000;
  return { ok: true, mint, hook, symbol: "RSEAT", name: "Refuted Seat Coin",
    fetchedAt: new Date().toISOString(), band: bandForMarketCap(mcap), hold: holdWindowFor(mcap),
    promotion: null, callouts: [], deployer: { ok: false }, marketRegime: null,
    crosscheck: { verdicts: [{ check: "price", verdict: "VERIFIED", detail: "stub" }], killed: false },
    pair: { baseSymbol: "RSEAT", baseName: "Refuted Seat Coin", dexId: "raydium", marketCap: mcap, fdv: mcap,
      liquidityUsd: 40_000, priceUsd: PX, ageHours: 6, volume: { h24: 90_000 },
      txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1, h1: 3, h6: 8, h24: 12 } },
    pairs: { count: 2, totalLiquidityUsd: 40_000, venues: ["raydium", "meteora"] },
    derived: { txns24h: 700, volToLiqRatio: 2.25, fdvToLiqRatio: 5 },
    mintAccount: { ok: true, flags: [] },
    holders: { ok: true, top1Pct: 4.2, top10Pct: 18, clusteredHolders: 5, bundleSuspect: true },
    exitProbe: { ok: true, targetSizeUsd: 75, sizeSource: "default", sizeFromBot: false, roundTripLossPct: 1.2 },
    ...over };
};
let EV_OVERRIDE = {};
globalThis.__RS = { gather: async (mint, hook) => cannedEvidence(mint, hook, EV_OVERRIDE), reports: [] };

const EVENTS = [];
bus.on("event", (e) => EVENTS.push(e));
const lastLedgerId = () => db.prepare("SELECT COALESCE(MAX(id),0) id FROM llm_spend").get().id;
const ledgerAfter = (id) => db.prepare(
  "SELECT seat, model, usd FROM llm_spend WHERE id > ? ORDER BY id").all(id);
const DECISION_SEATS = ["Risk", "PM", "Execution"];

let caseNo = 0;
/** Drive the REAL workup once; report the ask() calls by seat (wire and ledger) and the meter's bill. */
async function drive(label, { redteam = redteamOut("wounded"), ev = {} } = {}) {
  caseNo += 1;
  resetCreditBreakers(); xreadCacheReset();
  WIRE.length = 0; EVENTS.length = 0; REDTEAM = redteam; EV_OVERRIDE = ev;
  const id0 = lastLedgerId();
  const mint = `Refut${String(caseNo).padStart(2, "0")}${"1".repeat(30)}pump`;
  let rec = null, err = null;
  try { rec = await workup(`refuted-${caseNo}`, mint, "refuted short-circuit test", { alwaysTicket: true }); }
  catch (e) { err = e; }
  const rows = ledgerAfter(id0);
  /* ask() counts by seat, from the ledger — every metered call is one row — and the
     dollars beside them; the wire order is printed so what left the process is visible. */
  const calls = {}, dollars = {};
  for (const r of rows) { calls[r.seat] = (calls[r.seat] ?? 0) + 1; dollars[r.seat] = (dollars[r.seat] ?? 0) + Number(r.usd); }
  const bill = rows.reduce((a, r) => a + Number(r.usd), 0);
  const stages = EVENTS.filter((e) => e.type === "stage").map((e) => e.stage);
  const ends = EVENTS.filter((e) => e.type === "token:end").map((e) => e.outcome);
  const zeros = EVENTS.filter((e) => e.type === "risk:mechanical_zero");
  console.log(`\n${label}`);
  console.log(`   order   : ${WIRE.map((w) => w.seat).join(" -> ") || "(nothing left the process)"}`);
  console.log(`   ask() by seat: ${Object.entries(calls).map(([s, n]) => `${s}=${n} (${usd(dollars[s])})`).join(" · ") || "none"}`);
  console.log(`   bill    : ${usd(bill)} across ${rows.length} metered calls · risk:mechanical_zero x${zeros.length}`);
  console.log(`   stages  : ${stages.join(", ") || "-"} · token:end ${ends.join(", ") || "-"}`);
  console.log(`   result  : ${err ? `threw ${err.constructor.name} — ${String(err.message).slice(0, 80)}`
    : `${rec?.outcome} / ${rec?.finalDecision} · redteam ${rec?.redteam?.verdict ?? "-"} · pm ${rec?.pm ? rec.pm.decision : "null"} · size ${rec?.risk ? `$${rec.risk.position_size_usd}` : "null"}`}`);
  return { rec, err, mint, calls, dollars, bill, rows, stages, ends, zeros,
    decisionCalls: DECISION_SEATS.map((s) => calls[s] ?? 0) };
}
const gateRow = (rec) => db.prepare(
  "SELECT outcome, final_decision, binding_gate, redteam_binding, size_usd FROM decision_runs WHERE id=?").get(rec?.decisionRunId);

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n0. THE FIXTURES, HELD UP TO THE REAL SCREEN AND THE REAL BAR FIRST");
{
  const sc = screen(cannedEvidence("fixture", "check"));
  ok("the canned evidence passes the real free screen", sc.pass === true,
    sc.pass ? "0 fails" : sc.fails.map((f) => f.code).join(", "));
  const barred = applyRedTeamBar(redteamOut("refuted", [fatalAttack()]), cannedEvidence("fixture", "check"));
  ok("the fatal attack on holders.bundleSuspect survives applyRedTeamBar as refuted",
    barred.redteam.verdict === "refuted" && barred.verifiedFatal.length === 1 && !barred.redteam.downgraded_from,
    `verdict ${barred.redteam.verdict}, ${barred.verifiedFatal.length} verified fatal`);
  const loose = applyRedTeamBar(redteamOut("refuted", [fatalAttack({ fact_code: "other" })]), cannedEvidence("fixture", "check"));
  ok("the same attack coded `other` is downgraded to wounded by the bar",
    loose.redteam.verdict === "wounded" && loose.redteam.downgraded_from === "refuted",
    `verdict ${loose.redteam.verdict} (from ${loose.redteam.downgraded_from})`);
  ok("redteam_refuted_unanswered and zero_authorized_size are SAFETY gates — untouched by this change",
    GATE_CLASS.redteam_refuted_unanswered === "SAFETY" && GATE_CLASS.zero_authorized_size === "SAFETY",
    `redteam_refuted_unanswered=${GATE_CLASS.redteam_refuted_unanswered} zero_authorized_size=${GATE_CLASS.zero_authorized_size}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n1. A POST-BAR REFUTED VERDICT — Risk, the PM and Execution are never bought");
const refuted = await drive("refuted; one verified fatal attack stands", { redteam: redteamOut("refuted", [fatalAttack()]) });
{
  const r = refuted;
  ok("the workup ended decided / REFUTED with no PM on the record",
    !r.err && r.rec?.outcome === "decided" && r.rec?.finalDecision === "REFUTED" && r.rec?.pm === null,
    `${r.rec?.outcome} / ${r.rec?.finalDecision} · pm ${r.rec?.pm}`);
  ok("the red-team verdict is on the record, refuted and not downgraded",
    r.rec?.redteam?.verdict === "refuted" && !r.rec?.redteam?.downgraded_from,
    `verdict ${r.rec?.redteam?.verdict}`);
  ok("Risk, PM and Execution: 0, 0, 0 ask() calls",
    r.decisionCalls.every((n) => n === 0),
    DECISION_SEATS.map((s, i) => `${s}=${r.decisionCalls[i]}`).join(" "));
  ok("...and the Red Team was bought exactly once, after the read and every analyst",
    r.calls["Red Team"] === 1 && r.calls.XRead === 1 && ["Liquidity", "Flow", "Forensics", "Narrative"].every((s) => (r.calls[s] ?? 0) >= 1),
    Object.entries(r.calls).map(([s, n]) => `${s}=${n}`).join(" "));
  ok("no ticket, no compliance run, no risk on the record — nothing was bought after the verdict",
    r.rec?.ticket === null && r.rec?.compliance === null && r.rec?.risk === null,
    `ticket ${r.rec?.ticket} compliance ${r.rec?.compliance} risk ${r.rec?.risk}`);
  ok("the chronicle names what was skipped and ends the token as REFUTED",
    r.stages.includes("decision_skipped") && r.ends.at(-1) === "REFUTED" && !r.stages.includes("ceo"),
    `stages ${r.stages.join(", ")} · token:end ${r.ends.join(", ")}`);
  const e = eligibility(r.rec);
  ok("mandate.eligibility declines it with safety:true", e.eligible === false && e.safety === true, e.reason);
  ok("gateFor stamps `redteam`", gateFor(r.rec) === "redteam", gateFor(r.rec));
  const row = gateRow(r.rec);
  ok("decision_runs carries binding_gate redteam, final_decision REFUTED, redteam_binding 1",
    row?.binding_gate === "redteam" && row?.final_decision === "REFUTED" && row?.redteam_binding === 1 && row?.outcome === "decided",
    JSON.stringify(row));
  const codes = safetyFailures(r.rec).map((g) => g.code);
  ok("calls.js lists redteam_refuted_unanswered among the SAFETY failures",
    codes.includes("redteam_refuted_unanswered"), codes.join(", "));
  const l0 = cohortEligibility(r.rec, 0), top = cohortEligibility(r.rec, MAX_ESCALATION_LEVEL);
  ok(`cohortEligibility refuses on the SAFETY floor at L0 and at L${MAX_ESCALATION_LEVEL} alike`,
    !l0.publishable && l0.safety === true && !top.publishable && top.safety === true,
    `L0 gate ${l0.gate} · L${MAX_ESCALATION_LEVEL} gate ${top.gate}`);
  ok("no risk:mechanical_zero was emitted — the rails never ran", r.zeros.length === 0, `x${r.zeros.length}`);
  /* The plan's note "guard complianceCheck for pm null": the seat is code, and it already
     reads pm?. — proven by calling it with the record's own nulls rather than trusting it. */
  let comp = null, compErr = null;
  try { comp = complianceCheck({ pm: r.rec.pm, risk: r.rec.risk, redteam: r.rec.redteam, ticket: r.rec.ticket, ev: r.rec.ev }); }
  catch (x) { compErr = x; }
  ok("complianceCheck tolerates pm/risk/ticket null without throwing",
    !compErr && comp && Array.isArray(comp.violations), compErr ? String(compErr.message) : `pass=${comp?.pass} violations=${comp?.violations?.length}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n2. A WOUNDED VERDICT — all three decision seats still run (the control)");
const wounded = await drive("wounded; the PM watches; a contingency ticket is drafted", { redteam: redteamOut("wounded") });
{
  const r = wounded;
  ok("the workup ran to a WATCH with a ticket that cleared compliance",
    !r.err && r.rec?.outcome === "decided" && r.rec?.finalDecision === "WATCH" && r.rec?.ticket != null && r.rec?.compliance?.pass === true,
    `${r.rec?.outcome} / ${r.rec?.finalDecision}${r.rec?.ticket ? " with a ticket" : ""}`);
  ok("Risk, PM and Execution: 1, 1, 1 ask() calls",
    r.decisionCalls.every((n) => n === 1),
    DECISION_SEATS.map((s, i) => `${s}=${r.decisionCalls[i]}`).join(" "));
  ok("no decision_skipped or pm_skipped stage in the healthy path",
    !r.stages.includes("decision_skipped") && !r.stages.includes("pm_skipped"), r.stages.join(", "));
  ok("no risk:mechanical_zero — the rails sized it", r.zeros.length === 0 && r.rec?.risk?.position_size_usd > 0,
    `x${r.zeros.length} · size $${r.rec?.risk?.position_size_usd}`);
  const e = eligibility(r.rec);
  ok("mandate.eligibility ranks it (the PM wanted a trigger first)", e.eligible === true && e.tier === 1, `${e.reason} tier ${e.tier}`);
  /* THE SAVING, on the meter's own arithmetic: everything bought before the verdict is
     identical between the two runs, so the difference IS the three seats. */
  const trio = DECISION_SEATS.reduce((a, s) => a + (r.dollars[s] ?? 0), 0);
  const saved = r.bill - refuted.bill;
  console.log(`     bill: wounded ${usd(r.bill)} vs refuted ${usd(refuted.bill)} → ${usd(saved)} not bought; ` +
    `Risk ${usd(r.dollars.Risk ?? 0)} + PM ${usd(r.dollars.PM ?? 0)} + Execution ${usd(r.dollars.Execution ?? 0)} = ${usd(trio)} (plan: ~$0.28 on the live medians)`);
  ok("the refuted run's bill is the wounded run's minus exactly the three decision seats",
    saved > 0 && Math.abs(saved - trio) < 1e-9, `${usd(saved)} = ${usd(trio)}`);
}

console.log("\n   2b. REFUTED BUT UNVERIFIED — the bar downgrades it, and the downgraded coin still buys all three");
{
  const r = await drive("refuted by the seat, `other` fact code; downgraded to wounded",
    { redteam: redteamOut("refuted", [fatalAttack({ fact_code: "other" })]) });
  ok("applyRedTeamBar downgraded it on the record",
    r.rec?.redteam?.verdict === "wounded" && r.rec?.redteam?.downgraded_from === "refuted",
    `verdict ${r.rec?.redteam?.verdict} from ${r.rec?.redteam?.downgraded_from}`);
  ok("Risk, PM and Execution: 1, 1, 1 — the short-circuit acts only on a verdict that survived the bar",
    r.decisionCalls.every((n) => n === 1) && r.rec?.finalDecision === "WATCH",
    DECISION_SEATS.map((s, i) => `${s}=${r.decisionCalls[i]}`).join(" ") + ` · ${r.rec?.finalDecision}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n3. A MECHANICAL ZERO — the rails zero it, risk:mechanical_zero fires once, the PM is never bought");
{
  /* The probe returned a number AND an error: it passes the screen (which asks only
     whether roundTripLossPct is null, evidence.js) and is zeroed by the rails, whose test
     is `rt == null || exitProbe.error` (risk-rails.js). */
  const probe = { ok: false, targetSizeUsd: 75, sizeSource: "default", sizeFromBot: false,
    roundTripLossPct: 1.2, error: "reverse leg timed out" };
  const sc = screen(cannedEvidence("fixture", "check", { exitProbe: probe }));
  ok("an exitProbe with a measured round trip and an error passes the free screen", sc.pass === true,
    sc.pass ? "0 fails" : sc.fails.map((f) => f.code).join(", "));
  const r = await drive("wounded; exitProbe.error with a measured round trip", { redteam: redteamOut("wounded"), ev: { exitProbe: probe } });
  ok("the workup ended decided / ZERO_SIZE with the railed $0 on the record and no PM",
    !r.err && r.rec?.outcome === "decided" && r.rec?.finalDecision === "ZERO_SIZE" && r.rec?.risk?.position_size_usd === 0 && r.rec?.pm === null,
    `${r.rec?.outcome} / ${r.rec?.finalDecision} · size $${r.rec?.risk?.position_size_usd} · pm ${r.rec?.pm}`);
  ok("the rail note names the probe", (r.rec?.risk?.rail_notes ?? []).some((n) => /^mechanical zero: the exit probe never completed/.test(n)),
    JSON.stringify(r.rec?.risk?.rail_notes));
  ok("Risk 1, PM 0, Execution 0 ask() calls",
    r.decisionCalls[0] === 1 && r.decisionCalls[1] === 0 && r.decisionCalls[2] === 0,
    DECISION_SEATS.map((s, i) => `${s}=${r.decisionCalls[i]}`).join(" "));
  ok("risk:mechanical_zero was emitted exactly once, from railRisk, with the rail's reason",
    r.zeros.length === 1 && r.zeros[0].mint === r.mint && /^mechanical zero/.test(r.zeros[0].reason),
    `x${r.zeros.length} reason=${JSON.stringify(r.zeros[0]?.reason)}`);
  ok("the chronicle says pm_skipped and ends the token as ZERO_SIZE",
    r.stages.includes("pm_skipped") && r.ends.at(-1) === "ZERO_SIZE", `stages ${r.stages.join(", ")} · ends ${r.ends.join(", ")}`);
  const e = eligibility(r.rec);
  /* With no PM bought there is no invalidation either, and mandate.js reaches that line
     before its zero-size line — both SAFETY, so the property holds; the reason is printed
     rather than pinned to the zero-size string. */
  ok("mandate.eligibility declines it with safety:true", e.eligible === false && e.safety === true, e.reason);
  const codes = safetyFailures(r.rec).map((g) => g.code);
  ok("calls.js lists zero_authorized_size among the SAFETY failures", codes.includes("zero_authorized_size"), codes.join(", "));
  const l0 = cohortEligibility(r.rec, 0), top = cohortEligibility(r.rec, MAX_ESCALATION_LEVEL);
  ok(`cohortEligibility refuses on the SAFETY floor at L0 and at L${MAX_ESCALATION_LEVEL} alike`,
    !l0.publishable && l0.safety === true && !top.publishable && top.safety === true && top.gates.includes("zero_authorized_size"),
    `L0 gates ${l0.gates.join(",")} · L${MAX_ESCALATION_LEVEL} gates ${top.gates.join(",")}`);
  const row = gateRow(r.rec);
  ok("decision_runs carries final_decision ZERO_SIZE and size_usd 0",
    row?.final_decision === "ZERO_SIZE" && row?.size_usd === 0 && row?.outcome === "decided", JSON.stringify(row));
  console.log(`     bill: ${usd(r.bill)} vs wounded ${usd(wounded.bill)} → ${usd(wounded.bill - r.bill)} not bought (PM ${usd(wounded.dollars.PM ?? 0)} + Execution ${usd(wounded.dollars.Execution ?? 0)})`);
  ok("the bill is the wounded run's minus exactly the PM and Execution",
    Math.abs((wounded.bill - r.bill) - ((wounded.dollars.PM ?? 0) + (wounded.dollars.Execution ?? 0))) < 1e-9,
    usd(wounded.bill - r.bill));
}

console.log("\n   3b. A BARE exitProbe.error NEVER REACHES THE RAILS — the free screen refuses it for $0 first");
{
  const bare = { ok: false, targetSizeUsd: 75, roundTripLossPct: null, error: "no route at any size" };
  const sc = screen(cannedEvidence("fixture", "check", { exitProbe: bare }));
  ok("screen() fails it as unverified_exit", !sc.pass && sc.fails.some((f) => f.code === "unverified_exit"),
    sc.fails.map((f) => f.code).join(", "));
  const r = await drive("bare exitProbe.error, no round trip measured", { ev: { exitProbe: bare } });
  ok("the workup ends screened_out with 0 ask() calls and $0 metered",
    r.rec?.outcome === "screened_out" && r.rows.length === 0 && r.bill === 0,
    `${r.rec?.outcome} · ${r.rows.length} calls · ${usd(r.bill)}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n4. THE SOURCE — each return sits directly after the verdict it acts on and before the seat it saves");
{
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  const bar = src.indexOf("const barred = applyRedTeamBar(redteam, ev);");
  const refutedReturn = src.indexOf('if (redteam.verdict === "refuted") {');
  const risk = src.indexOf("await runRisk(ev, analysts, redteam)");
  const railed = src.indexOf("const risk = railRisk({");
  const zeroReturn = src.indexOf("if (!(risk.position_size_usd > 0)) {");
  const pm = src.indexOf("await runPM(ev, analysts, redteam, risk, weighted, opts)");
  ok("bar < refuted return < runRisk < railRisk < zero return < runPM",
    bar > 0 && refutedReturn > bar && risk > refutedReturn && railed > risk && zeroReturn > railed && pm > zeroReturn,
    `bar@${bar} refuted@${refutedReturn} runRisk@${risk} railRisk@${railed} zero@${zeroReturn} runPM@${pm}`);
  ok("the PM and Execution are each bought at exactly one site — there is no second path around the returns",
    src.split("await runPM(").length === 2 && src.split("await runExecution(").length === 2,
    `runPM x${src.split("await runPM(").length - 1} runExecution x${src.split("await runExecution(").length - 1}`);
  ok("risk:mechanical_zero is emitted at exactly one site — railRisk — not again by the return",
    src.split('emit("risk:mechanical_zero"').length === 2, `x${src.split('emit("risk:mechanical_zero"').length - 1}`);
}

console.log(`\n${pass} passed, ${fail} failed — a verdict the gate has settled buys no further seat\n`);
process.exit(fail ? 1 : 0);
