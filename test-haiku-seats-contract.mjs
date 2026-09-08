/**
 * TWO SEATS ON HAIKU, ONE SEAT RETIRED — AND THE CONTRACT THEY STILL HAVE TO MEET.
 *
 * Live 24h before this change: Technical 31 calls, $0.67 (7d $8.45), 0 kills — and no KILL
 * clause anywhere in its brief, so it could never have ended a workup; Liquidity 31 calls,
 * $0.95 (7d $13.08), 0 kills — its two authorised kills are the free screen's own
 * thin_liquidity / unverified_exit, applied before it is paid; Execution 11 calls, $0.48
 * (7d $6.26) to author an entry zone and targets around a stop that compliance.js
 * `stop_mismatch` forces equal to Risk's. Haiku 4.5 lists at $1/$5 per MTok against
 * Sonnet 5's $2/$10. So: Technical leaves the cheap batch and the weight table (the
 * 0.03 re-normalised across the four that remain), Liquidity and Execution move to
 * claude-haiku-4-5, and Red Team stays Opus/high — its verdict feeds a SAFETY gate and
 * the seat scorecard is empty, so DESK_EFFORT_REDTEAM is an A/B handle, not a default.
 *
 * WHAT IS REAL: config, the ANALYSTS table, ask() and its Haiku branch (output_config
 * WITHOUT effort — Haiku 4.5 400s on it), askWithWeb, the Zod contracts, the cost meter
 * and the llm_spend ledger, composite(), railRisk, complianceCheck, and workup() end to
 * end: the free screen, the read, both analyst batches, the coverage floor, Red Team,
 * Risk, the PM and Execution. WHAT IS STUBBED: the network (a wire-capturing fetch that
 * answers as each provider would — the order of what left the process IS the evidence),
 * gather() (one canned bundle the REAL screen is shown to pass) and writeReport. The seat
 * answers are schema-shaped fixtures, not recorded wire bodies; their token usage is
 * shaped to the live per-seat medians (Liquidity $0.03 on Sonnet) so the dollars printed
 * are the real meter's arithmetic on a plausible shape, not a measurement of the live desk.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-haiku-seats-contract.mjs
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "haiku-seats-"));
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(TMP, "haiku.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";
/* The DEFAULTS are what this file measures. A shell carrying a seat override or the
   Red Team A/B would be measuring that instead, so those are dropped before config loads. */
for (const k of Object.keys(process.env)) if (/^DESK_(MODEL|EFFORT)_/.test(k)) delete process.env[k];

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const usd = (n) => `$${Number(n).toFixed(4)}`;

/* ── the stub layer: gather() and the scribe, the way test-xread-probe-order.mjs does it ── */
const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/data/evidence.js"), "evidence"],
  [F("src/report.js"), "report"],
]);
const SOURCE = {
  /* screen() and enrichWithXRead() stay REAL — only the network-bound gather() is canned. */
  evidence: `
    export * from "${F("src/data/evidence.js")}?hs=real";
    export async function gather(mint, hook) { return globalThis.__HS.gather(mint, hook); }
  `,
  report: `
    export * from "${F("src/report.js")}?hs=real";
    export function writeReport(cycle, r) {
      globalThis.__HS.reports.push({ cycle, symbol: r?.symbol, outcome: r?.outcome });
      return "reports/haiku-seats-test/" + String(cycle) + "__" + (r?.symbol || "x") + ".md";
    }
  `,
};
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (String(r.url).includes("hs=real")) return r;
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?hs=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("hs=stub")) {
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
const redteamOut = { headline: "the crowd is two accounts", bear_case: "attention is thin",
  attacks: [], unfalsifiable_claims: [], what_would_change_my_mind: "distinct voices",
  verdict: "wounded", confidence: 0.5 };
const riskOut = { risk_tier: "quarter", size_rationale: "wounded, not refuted", stop_price: 0.00015,
  stop_rationale: "below the launch base", liquidity_adjusted: false, portfolio_notes: "", confidence: 0.6 };
const pmOut = { decision: "WATCH", conviction: 55, thesis: "early to a true story", invalidation: "volume fades",
  time_horizon: "1h", how_red_team_was_answered: "two voices is the ordinary launch", key_disagreement: "none",
  watch_triggers: ["buys_h1 >= 40"],
  watch_rules: { price_above_usd: 0.00019, buys_h1_at_least: 40, liq_at_least_usd: null, hours: 2 } };
/* The ticket the Execution seat authors: zone and targets. The stop is Risk's, verbatim. */
const ticketOut = { action: "BUY", entry_zone_low: 0.00019, entry_zone_high: 0.00021, entry_style: "scale-in",
  slices: [{ pct_of_position: 50, trigger: "now" }, { pct_of_position: 50, trigger: "holds 0.0002" }],
  max_slippage_bps: 300, suggested_route: "raydium", stop_price: riskOut.stop_price,
  take_profit: [{ price: 0.0005, pct_to_sell: 100, rationale: "the re-rate the thesis argues for" }],
  execution_warnings: [] };

/* Token usage per seat, shaped to the live medians: 6k uncached + 8k cached (rules and
   an ~8k bundle) + 1.6k out is $0.0296 on Sonnet — the measured Liquidity median is
   $0.03 — and the same shape is $0.0148 on Haiku. The others are proportioned to their
   live medians (Red Team $0.336, PM $0.18, Risk $0.07, Execution $0.05). */
const USAGE = {
  analyst:   { input_tokens: 6_000, cache_read_input_tokens: 8_000, output_tokens: 1_600 },
  research:  { input_tokens: 3_000, cache_read_input_tokens: 8_000, output_tokens: 2_500, server_tool_use: { web_search_requests: 2 } },
  shape:     { input_tokens: 4_000, cache_read_input_tokens: 8_000, output_tokens: 800 },
  redteam:   { input_tokens: 5_000, cache_read_input_tokens: 8_000, output_tokens: 8_000 },
  risk:      { input_tokens: 5_000, cache_read_input_tokens: 8_000, output_tokens: 1_500 },
  pm:        { input_tokens: 7_000, cache_read_input_tokens: 8_000, output_tokens: 3_000 },
  execution: { input_tokens: 3_500, output_tokens: 1_200 },   // no bundle — the ticket's turn is small
};

/* ── the wire: every provider request, in order, answered as each provider would ─────── */
const WIRE = [];
let FAILING = new Set();           // seats scripted to 404 — non-retryable, $0, instant
const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });
const sse = (frames) => new Response(
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const stream = (model, usage, text) => sse([
  { type: "message_start", message: { id: "msg_hs", type: "message", role: "assistant", model, content: [],
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
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "HSEAT" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.org/origin", title: "The origin post" }] },
  ],
  stop_reason: "end_turn", stop_sequence: null, usage,
});
const notFound404 = () => json({ type: "error", error: { type: "not_found_error",
  message: "model: claude-sonnet-9 not found" } }, 404);
/* The /responses body grokXRead parses; 1.54e9 ticks is $0.154, the live per-read figure. */
const xaiRead = () => json({ id: "resp_hs", model: "grok-4.6",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
    mentions_level: "low", verdict: "mixed", velocity: "flat", serial_rugger: false,
    paid_or_botted_signs: false, dev_handle: null, summary: "stub read" }) }] }],
  citations: [], usage: { input_tokens: 4000, output_tokens: 350, cost_in_usd_ticks: 1_540_000_000 } });

/* Which seat a request is for is read off the request: since the cache-prefix fix the
   brief opens the LAST user block (seatTurn() in lib/llm.js), after the shared bundle. */
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
  const entry = { provider: "anthropic", seat: kind === "research" ? "NARRATIVE(research)" : seat,
    kind, model: body.model, body, usage: USAGE[kind], failed: false };
  WIRE.push(entry);
  if (FAILING.has(seat)) { entry.failed = true; entry.usage = null; return notFound404(); }
  if (kind === "research") return researchReply(body.model, USAGE.research);
  const out = kind === "analyst" || kind === "shape" ? analystOut(seat)
    : kind === "redteam" ? redteamOut : kind === "risk" ? riskOut : kind === "pm" ? pmOut : ticketOut;
  return stream(body.model, USAGE[kind], JSON.stringify(out));
};

/* ── the real modules, imported only now that the stubs are in place ─────────────────── */
const llm = await import("./src/lib/llm.js");
const { resetCreditBreakers } = llm;
const { xreadCacheReset } = await import("./src/lib/grok.js");
const { bus } = await import("./src/lib/bus.js");
const db = (await import("./src/lib/store.js")).default;
const { cfg } = await import("./src/config.js");
const { ANALYSTS, runAnalyst } = await import("./src/agents/analysts.js");
const { runExecution } = await import("./src/agents/decision.js");
const { AnalystOut, TicketOut } = await import("./src/agents/schemas.js");
const { composite } = await import("./src/agents/composite.js");
const { complianceCheck } = await import("./src/agents/compliance.js");
const { bandForMarketCap, holdWindowFor } = await import("./src/bands.js");
const { screen } = await import("./src/data/evidence.js");
const { workup, railRisk, CHEAP_SEATS } = await import("./src/desk.js");

/* One evidence bundle, sized to the MEDIUM band ($100k-$500k) with every safety read
   present, so the REAL screen lets it through — the same shape test-xread-probe-order uses. */
const cannedEvidence = (mint, hook) => {
  const mcap = 200_000;
  return { ok: true, mint, hook, symbol: "HSEAT", name: "Haiku Seat Coin",
    fetchedAt: new Date().toISOString(), band: bandForMarketCap(mcap), hold: holdWindowFor(mcap),
    promotion: null, callouts: [], deployer: { ok: false }, marketRegime: null,
    crosscheck: { verdicts: [{ check: "price", verdict: "VERIFIED", detail: "stub" }], killed: false },
    pair: { baseSymbol: "HSEAT", baseName: "Haiku Seat Coin", dexId: "raydium", marketCap: mcap, fdv: mcap,
      liquidityUsd: 40_000, priceUsd: PX, ageHours: 6, volume: { h24: 90_000 },
      txns: { h24: { buys: 400, sells: 300 } }, priceChange: { m5: 1, h1: 3, h6: 8, h24: 12 } },
    pairs: { count: 2, totalLiquidityUsd: 40_000, venues: ["raydium", "meteora"] },
    derived: { txns24h: 700, volToLiqRatio: 2.25, fdvToLiqRatio: 5 },
    mintAccount: { ok: true, flags: [] },
    holders: { ok: true, top1Pct: 4.2, top10Pct: 18 },
    exitProbe: { ok: true, targetSizeUsd: 75, sizeSource: "default", sizeFromBot: false, roundTripLossPct: 1.2 },
  };
};
globalThis.__HS = { gather: async (mint, hook) => cannedEvidence(mint, hook), reports: [] };
const EV = cannedEvidence("HSEATfixture111111111111111111111111111pump", "fixture");

const EVENTS = [];
bus.on("event", (e) => EVENTS.push(e));
const priced = (model, usage) => llm.anthropicUsageCost(model, { model, usage }).usd;
const lastLedgerId = () => db.prepare("SELECT COALESCE(MAX(id),0) id FROM llm_spend").get().id;
const ledgerAfter = (id) => db.prepare(
  "SELECT seat, model, in_tok, cached_tok, out_tok, usd FROM llm_spend WHERE id > ? ORDER BY id").all(id);

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n0. THE FIXTURE, HELD UP TO THE REAL SCREEN FIRST");
{
  const sc = screen(EV);
  ok("the canned evidence passes the real free screen", sc.pass === true,
    sc.pass ? "0 fails" : sc.fails.map((f) => f.code).join(", "));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n1. THE CONFIG — who sits where, and what Technical's retirement did to the table");
{
  ok("Liquidity is on claude-haiku-4-5", cfg.models.liquidity === "claude-haiku-4-5", cfg.models.liquidity);
  ok("Execution is on claude-haiku-4-5", cfg.models.execution === "claude-haiku-4-5", cfg.models.execution);
  ok("Red Team stays on claude-opus-5", cfg.models.redteam === "claude-opus-5", cfg.models.redteam);
  ok("the seat table no longer holds Technical", !("technical" in ANALYSTS),
    `ANALYSTS: ${Object.keys(ANALYSTS).join(", ")}`);
  ok("nor do the model, effort or weight tables",
    !("technical" in cfg.models) && !("technical" in cfg.effort) && !("technical" in cfg.weights),
    `models: ${Object.keys(cfg.models).join(", ")}`);
  ok("the cheap batch no longer contains technical, and still holds liquidity and flow",
    !CHEAP_SEATS.includes("technical") && CHEAP_SEATS.includes("liquidity") && CHEAP_SEATS.includes("flow"),
    `CHEAP_SEATS = [${CHEAP_SEATS.join(", ")}]`);

  const sum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  console.log(`     weights: ${Object.entries(cfg.weights).map(([k, v]) => `${k} ${v}`).join(" · ")} → sum ${sum.toFixed(4)}`);
  ok("the composite weights are re-normalised to 1.00 across the four seats",
    Math.abs(sum - 1) < 1e-9 && Object.keys(cfg.weights).length === 4, `sum ${sum}`);
  ok("the order of the seats is unchanged: narrative > forensics > flow > liquidity",
    cfg.weights.narrative > cfg.weights.forensics && cfg.weights.forensics > cfg.weights.flow &&
      cfg.weights.flow > cfg.weights.liquidity,
    Object.entries(cfg.weights).map(([k, v]) => `${k}=${v}`).join(" > "));
  /* The 0.03 is gone from the composite, not merely from the table: a technical verdict
     left on an old record (the ledger holds thousands) now carries zero weight. */
  const four = { narrative: { score: 80, confidence: 1 }, forensics: { score: 40, confidence: 1 },
    flow: { score: 60, confidence: 1 }, liquidity: { score: 20, confidence: 1 } };
  const expected = 80 * cfg.weights.narrative + 40 * cfg.weights.forensics + 60 * cfg.weights.flow + 20 * cfg.weights.liquidity;
  const withStale = composite({ ...four, technical: { score: 0, confidence: 1 } });
  console.log(`     composite(four seats) = ${composite(four).toFixed(4)} · with a stale technical=0 verdict = ${withStale.toFixed(4)} · weighted mean ${expected.toFixed(4)}`);
  ok("composite() of the four seats is their weighted mean at full confidence",
    Math.abs(composite(four) - expected) < 1e-9, composite(four).toFixed(4));
  ok("a stale technical verdict moves the composite by nothing — its weight is 0",
    Math.abs(withStale - composite(four)) < 1e-9, `${withStale.toFixed(4)} = ${composite(four).toFixed(4)}`);
}

console.log("\n   DESK_EFFORT_REDTEAM — an A/B handle, in a child process with a controlled env");
{
  const probe = (value) => {
    const env = { ...process.env, CLAUDE_CO_DB: path.join(TMP, "effort-probe.db") };
    delete env.DESK_EFFORT_REDTEAM;
    if (value != null) env.DESK_EFFORT_REDTEAM = value;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const { cfg } = await import(${JSON.stringify(F("src/config.js"))});` +
      `process.stdout.write(JSON.stringify({ effort: cfg.effort.redteam, model: cfg.models.redteam, pm: cfg.effort.pm }));`],
      { encoding: "utf8", env, cwd: REPO, timeout: 30_000 });
    try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || "no output").slice(0, 160) }; }
  };
  const unset = probe(null), medium = probe("medium"), bogus = probe("turbo");
  console.log(`     unset → ${JSON.stringify(unset)} · medium → ${JSON.stringify(medium)} · "turbo" → ${JSON.stringify(bogus)}`);
  ok("unset: Red Team defaults to claude-opus-5 at high, the same entry the PM keys",
    unset.effort === "high" && unset.model === "claude-opus-5" && unset.pm === "high", JSON.stringify(unset));
  ok("DESK_EFFORT_REDTEAM=medium is honoured — the A/B is reachable", medium.effort === "medium", medium.effort);
  ok("an effort the provider does not know falls back to high instead of shipping a 400",
    bogus.effort === "high", bogus.effort);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n2. THE HAIKU PATH — Liquidity and Execution answer in contract through ask()'s Haiku branch");
const railed = railRisk({ risk: riskOut, ev: EV, redteam: redteamOut, mint: EV.mint, symbol: EV.symbol });
{
  resetCreditBreakers();
  WIRE.length = 0;
  const id0 = lastLedgerId();
  const liq = await runAnalyst("liquidity", EV);
  const liqReq = WIRE.at(-1);
  const ticket = await runExecution(EV, pmOut, railed);
  const exReq = WIRE.at(-1);
  const rows = ledgerAfter(id0);
  console.log(`     Liquidity → ${liqReq.model} · output_config keys [${Object.keys(liqReq.body.output_config ?? {}).join(", ")}] · ` +
    `headline "${liq.headline}" score ${liq.score} conf ${liq.confidence} kill ${liq.kill}`);
  console.log(`     Execution → ${exReq.model} · output_config keys [${Object.keys(exReq.body.output_config ?? {}).join(", ")}] · ` +
    `zone ${ticket.entry_zone_low}-${ticket.entry_zone_high} stop ${ticket.stop_price} tp ${ticket.take_profit[0].price}`);

  for (const [label, req] of [["Liquidity", liqReq], ["Execution", exReq]]) {
    ok(`${label}: the request went to claude-haiku-4-5`, req.model === "claude-haiku-4-5", req.model);
    ok(`${label}: output_config carries the schema and NO effort — the Haiku branch in lib/llm.js`,
      req.body.output_config?.format != null && !("effort" in (req.body.output_config ?? {})),
      `keys [${Object.keys(req.body.output_config ?? {}).join(", ")}]`);
    ok(`${label}: no Opus-only server-side fallback fields ride along`,
      req.body.fallbacks === undefined && req.body.betas === undefined, "fallbacks/betas absent");
  }
  ok("Liquidity's answer validates against AnalystOut", AnalystOut.safeParse(liq).success,
    AnalystOut.safeParse(liq).success ? `${liq.findings.length} findings` : JSON.stringify(AnalystOut.safeParse(liq).error?.issues?.[0]));
  ok("Execution's answer validates against TicketOut", TicketOut.safeParse(ticket).success,
    TicketOut.safeParse(ticket).success ? `action ${ticket.action}, ${ticket.slices.length} slices` : JSON.stringify(TicketOut.safeParse(ticket).error?.issues?.[0]));

  /* The meter priced them at Haiku's rate: the same usage on Sonnet is exactly twice. */
  const liqRow = rows.find((r) => r.seat === "Liquidity"), exRow = rows.find((r) => r.seat === "Execution");
  const liqH = priced("claude-haiku-4-5", USAGE.analyst), liqS = priced("claude-sonnet-5", USAGE.analyst);
  const exH = priced("claude-haiku-4-5", USAGE.execution), exS = priced("claude-sonnet-5", USAGE.execution);
  console.log(`     metered: Liquidity ${usd(liqRow?.usd)} on ${liqRow?.model} (Sonnet would be ${usd(liqS)}) · ` +
    `Execution ${usd(exRow?.usd)} on ${exRow?.model} (Sonnet would be ${usd(exS)})`);
  ok("the ledger rows name claude-haiku-4-5 and carry Haiku's price",
    liqRow?.model === "claude-haiku-4-5" && exRow?.model === "claude-haiku-4-5" &&
      Math.abs(liqRow.usd - liqH) < 1e-9 && Math.abs(exRow.usd - exH) < 1e-9,
    `Liquidity ${usd(liqRow?.usd)} = ${usd(liqH)} · Execution ${usd(exRow?.usd)} = ${usd(exH)}`);
  ok("on identical usage Haiku is half of Sonnet on both seats ($1/$5 vs $2/$10)",
    Math.abs(liqS - 2 * liqH) < 1e-9 && Math.abs(exS - 2 * exH) < 1e-9,
    `${usd(liqS)} = 2 × ${usd(liqH)} · ${usd(exS)} = 2 × ${usd(exH)}`);

  /* Why Haiku is enough for the ticket: the stop is not this seat's to author. */
  const clean = complianceCheck({ pm: pmOut, risk: railed, redteam: redteamOut, ticket, ev: EV });
  const moved = complianceCheck({ pm: pmOut, risk: railed, redteam: redteamOut,
    ticket: { ...ticket, stop_price: ticket.stop_price * 0.9 }, ev: EV });
  console.log(`     compliance: stop = Risk's → ${clean.pass ? "clear" : clean.violations.map((v) => v.code).join(", ")} · ` +
    `stop moved 10% → ${moved.violations.map((v) => v.code).join(", ") || "clear"}`);
  ok("a ticket whose stop equals Risk's clears compliance", clean.pass === true,
    clean.violations.map((v) => `${v.code}: ${v.detail}`).join(" | ") || "clear");
  ok("a ticket that moves the stop is vetoed as stop_mismatch — the seat authors zone and targets only",
    moved.violations.some((v) => v.code === "stop_mismatch"), moved.violations.map((v) => v.code).join(", "));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
let caseNo = 0;
/** Drive the REAL workup once and report what left the process and what the meter charged. */
async function drive(label, { failing = [] } = {}) {
  caseNo += 1;
  resetCreditBreakers(); xreadCacheReset();
  WIRE.length = 0; EVENTS.length = 0; FAILING = new Set(failing);
  const id0 = lastLedgerId();
  const mint = `HSeat${String(caseNo).padStart(2, "0")}${"1".repeat(30)}pump`;
  let rec = null, err = null;
  try { rec = await workup(`haiku-${caseNo}`, mint, "haiku seats test", { alwaysTicket: true }); }
  catch (e) { err = e; }
  const rows = ledgerAfter(id0);
  const order = WIRE.map((w) => w.seat);
  const stages = EVENTS.filter((e) => e.type === "stage").map((e) => e.stage);
  const ends = EVENTS.filter((e) => e.type === "token:end").map((e) => e.outcome);
  /* ask() also emits seat:failed under the seat's label; the desk's own record, from
     collect() in desk.js, is the one that carries the mint and the seat KEY. */
  const failed = EVENTS.filter((e) => e.type === "seat:failed" && e.mint).map((e) => e.seat);
  const anth = rows.filter((r) => r.seat !== "XRead");
  const metered = { xai: rows.filter((r) => r.seat === "XRead").reduce((a, r) => a + r.usd, 0),
    anthropic: anth.reduce((a, r) => a + r.usd, 0) };
  console.log(`\n${label}`);
  console.log(`   order   : ${order.join(" -> ") || "(nothing left the process)"}`);
  console.log(`   metered : anthropic ${usd(metered.anthropic)} (${anth.length} rows) · xai ${usd(metered.xai)}`);
  console.log(`   stages  : ${stages.join(", ") || "-"} · token:end ${ends.join(", ") || "-"}${failed.length ? ` · seat:failed ${failed.join(", ")}` : ""}`);
  console.log(`   result  : ${err ? `threw ${err.constructor.name} — ${String(err.message).slice(0, 80)}` : `${rec?.outcome} / ${rec?.finalDecision}${rec?.ticket ? " with a ticket" : ""}`}`);
  return { rec, err, order, wire: [...WIRE], rows, stages, ends, failed, metered,
    analysts: Object.keys(rec?.analysts ?? {}) };
}

console.log("\n3. THE WORKUP — the seats that run, and the $ the meter charges per workup, before and after");
{
  const a = await drive("healthy; every seat answers; the PM watches and a contingency ticket is drafted");
  ok("the workup ran to a decision with a ticket", a.rec?.outcome === "decided" && a.rec?.ticket != null && !a.err,
    `${a.rec?.outcome} / ${a.rec?.finalDecision}`);
  ok("...and the ticket cleared compliance", a.rec?.compliance?.pass === true,
    a.rec?.compliance?.violations?.map((v) => v.code).join(", ") || "clear");
  ok("nothing but the two providers left the process", a.wire.every((w) => w.provider !== "other"),
    a.wire.filter((w) => w.provider === "other").map((w) => w.url).join(", ") || "anthropic + xai only");
  ok("Technical was never bought", !a.order.includes("TECHNICAL"), a.order.join(" -> "));
  const analystsOnWire = a.wire.filter((w) => w.kind === "analyst" || w.kind === "shape").map((w) => w.seat).sort();
  ok("the four analyst seats ran: the cheap pair, Forensics and Narrative",
    same(analystsOnWire, ["FLOW", "FORENSICS", "LIQUIDITY", "NARRATIVE"]) && a.analysts.length === 4,
    `${analystsOnWire.join(", ")} · rec.analysts = ${a.analysts.join(", ")}`);
  ok("the read still goes second, straight after the free screen — the healthy order is untouched",
    a.order[0] === "XRead" && a.order.filter((s) => s === "XRead").length === 1, `order[0] = ${a.order[0]}`);
  const onModel = (seat) => a.wire.filter((w) => w.seat === seat).map((w) => w.model);
  ok("Liquidity and Execution went to claude-haiku-4-5 on the wire",
    same(onModel("LIQUIDITY"), ["claude-haiku-4-5"]) && same(onModel("EXECUTION"), ["claude-haiku-4-5"]),
    `Liquidity ${onModel("LIQUIDITY")} · Execution ${onModel("EXECUTION")}`);
  ok("Red Team and the PM stayed on claude-opus-5; Flow, Forensics, Narrative and Risk on claude-sonnet-5",
    same(onModel("RED TEAM"), ["claude-opus-5"]) && same(onModel("PM"), ["claude-opus-5"]) &&
      ["FLOW", "FORENSICS", "NARRATIVE", "NARRATIVE(research)", "RISK"].every((s) => same(onModel(s), ["claude-sonnet-5"])),
    a.wire.filter((w) => w.provider === "anthropic").map((w) => `${w.seat}:${w.model.replace("claude-", "")}`).join(" "));
  const flowReq = a.wire.find((w) => w.seat === "FLOW"), liqReq = a.wire.find((w) => w.seat === "LIQUIDITY");
  ok("the Sonnet seats still carry output_config.effort; the Haiku seat does not",
    flowReq.body.output_config?.effort === cfg.effort.flow && !("effort" in liqReq.body.output_config),
    `Flow effort ${flowReq.body.output_config?.effort} · Liquidity keys [${Object.keys(liqReq.body.output_config).join(", ")}]`);

  /* BEFORE AND AFTER, on the same usage, through the real meter. "Before" is the retier
     this file records: Liquidity and Execution on Sonnet, plus one Technical call at
     the analyst shape. Every request on the wire is priced at the model it went to. */
  const BEFORE = { LIQUIDITY: "claude-sonnet-5", EXECUTION: "claude-sonnet-5" };
  const reqs = a.wire.filter((w) => w.provider === "anthropic" && !w.failed);
  const after = reqs.reduce((s, w) => s + priced(w.model, w.usage), 0);
  const technicalBefore = priced("claude-sonnet-5", USAGE.analyst);
  const before = reqs.reduce((s, w) => s + priced(BEFORE[w.seat] ?? w.model, w.usage), 0) + technicalBefore;
  console.log("     seat            model (after)        before      after");
  for (const w of reqs) {
    const b = priced(BEFORE[w.seat] ?? w.model, w.usage), c = priced(w.model, w.usage);
    console.log(`     ${w.seat.padEnd(20)}${w.model.padEnd(20)}${usd(b).padStart(8)}   ${usd(c).padStart(8)}${b !== c ? "   ↓" : ""}`);
  }
  console.log(`     ${"TECHNICAL".padEnd(20)}${"(retired)".padEnd(20)}${usd(technicalBefore).padStart(8)}   ${usd(0).padStart(8)}   ↓`);
  console.log(`     ${"per workup".padEnd(40)}${usd(before).padStart(8)}   ${usd(after).padStart(8)}   Δ ${usd(before - after)} (${((1 - after / before) * 100).toFixed(1)}%)` +
    ` · plus the read ${usd(a.metered.xai)} either way`);
  console.log(`     seats before: XRead -> LIQUIDITY, FLOW, TECHNICAL -> FORENSICS, NARRATIVE -> RED TEAM -> RISK -> PM -> EXECUTION`);
  console.log(`     seats after : ${a.order.join(" -> ")}`);
  const liqSave = priced("claude-sonnet-5", USAGE.analyst) - priced("claude-haiku-4-5", USAGE.analyst);
  const exSave = priced("claude-sonnet-5", USAGE.execution) - priced("claude-haiku-4-5", USAGE.execution);
  ok("the workup is cheaper after than before on identical usage", after < before, `${usd(after)} < ${usd(before)}`);
  ok("...by exactly the Technical call plus half of Liquidity plus half of Execution",
    Math.abs((before - after) - (technicalBefore + liqSave + exSave)) < 1e-9,
    `Δ ${usd(before - after)} = ${usd(technicalBefore)} + ${usd(liqSave)} + ${usd(exSave)}`);
  ok("the ledger agrees with the wire — every Anthropic row was metered at the model it went to",
    Math.abs(a.metered.anthropic - after) < 1e-9 && a.rows.filter((r) => r.seat !== "XRead").length === reqs.length,
    `ledger ${usd(a.metered.anthropic)} = wire ${usd(after)} over ${reqs.length} rows`);
  ok("the read is metered at the live figure", Math.abs(a.metered.xai - 0.154) < 1e-9, usd(a.metered.xai));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n4. THE COVERAGE FLOOR — <3 analysts is unchanged, so one failure among the four passes and two trip it");
{
  const one = await drive("one seat fails (Forensics 404s) — three of four report", { failing: ["FORENSICS"] });
  ok("Forensics failed and was recorded as a seat failure", same(one.failed, ["forensics"]), one.failed.join(", "));
  ok("three analysts stand, so the floor does not trip and the desk goes on to the Red Team",
    one.analysts.length === 3 && one.stages.includes("redteam") && !one.ends.includes("insufficient_coverage"),
    `analysts ${one.analysts.join(", ")} · stages ${one.stages.join(", ")}`);
  ok("...and the workup still reaches a decision", one.rec?.outcome === "decided" && !one.err,
    `${one.rec?.outcome} / ${one.rec?.finalDecision}`);

  const two = await drive("two seats fail (Forensics and Narrative 404) — two of four report", { failing: ["FORENSICS", "NARRATIVE"] });
  ok("both failures are recorded", same([...two.failed].sort(), ["forensics", "narrative"]), two.failed.join(", "));
  ok("two analysts is a thin book: insufficient_coverage, and nothing past the floor is bought",
    two.rec?.outcome === "insufficient_coverage" && two.analysts.length === 2 &&
      !two.order.includes("RED TEAM") && !two.order.includes("RISK") && !two.order.includes("PM") && !two.order.includes("EXECUTION"),
    `${two.rec?.outcome} · analysts ${two.analysts.join(", ")} · order ${two.order.join(" -> ")}`);

  const pair = await drive("two seats fail in the cheap batch (Liquidity and Flow 404)", { failing: ["LIQUIDITY", "FLOW"] });
  ok("the floor trips on two failures wherever they fall",
    pair.rec?.outcome === "insufficient_coverage" && pair.analysts.length === 2 && !pair.order.includes("RED TEAM"),
    `${pair.rec?.outcome} · analysts ${pair.analysts.join(", ")}`);
  ok("a failed seat costs nothing — only the seats that answered are on the ledger",
    two.rows.filter((r) => r.seat !== "XRead").length === 2 + 0 && pair.rows.filter((r) => r.seat !== "XRead").length === 3,
    `two-deep-failures: ${two.rows.filter((r) => r.seat !== "XRead").map((r) => r.seat).join(", ")} · ` +
      `two-cheap-failures: ${pair.rows.filter((r) => r.seat !== "XRead").map((r) => r.seat).join(", ")}`);
  ok("Technical was bought in none of the four workups", ![one, two, pair].some((d) => d.order.includes("TECHNICAL")));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n5. THE SOURCE — the batch is named, the floor line is the one that shipped");
{
  const desk = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  ok("cheapKeys derives from CHEAP_SEATS minus the probed seat",
    desk.includes("const cheapKeys = CHEAP_SEATS.filter((k) => k !== probedSeat);"));
  ok("the <3 coverage floor is unchanged", desk.includes("if (Object.keys(analysts).length < 3) {"));
  ok("no literal seat list is left in the batch", !/\["liquidity", "flow", "technical"\]/.test(desk));
  const llmSrc = fs.readFileSync(new URL("./src/lib/llm.js", import.meta.url), "utf8");
  ok("ask() still gates output_config.effort on the model — Haiku gets the schema alone",
    /const haiku = \/haiku\/\.test\(model\);/.test(llmSrc) && /output_config: haiku\s*\?\s*\{ format: betaZodOutputFormat\(schema\) \}/.test(llmSrc));
}

console.log(`\n${pass} passed, ${fail} failed — Liquidity and Execution on Haiku, Technical retired, the floor where it was\n`);
process.exit(fail ? 1 : 0);
